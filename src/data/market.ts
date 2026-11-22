/**
 * Market data for the app: history (cache + REST), the still-forming candle, and a
 * live feed over Binance's public WebSocket with automatic reconnect, gap repair and
 * a REST polling fallback when WebSockets are unavailable.
 */
import { DAY, parseTf } from '../engine/timeframe.ts';
import type { KlineRow } from '../engine/types.ts';
import { BinanceClient, klineToRow, parseKline, splitClosed, WS_HOSTS, type Kline, type Ticker24h } from './binance.ts';
import { readCandles, writeCandles } from './cache.ts';

export interface CandleSet {
  symbol: string;
  interval: string;
  /** Closed candles, oldest first. */
  rows: KlineRow[];
  /** The candle still forming right now, if known. */
  forming: Kline | null;
  /** Maximum closed candles kept (the requested window plus a small margin). */
  cap: number;
}

export type FeedStatus = 'connecting' | 'live' | 'polling' | 'offline';

const maxRows = (interval: string, days: number) => Math.ceil((days * DAY) / parseTf(interval).ms) + 10;

export class Market {
  readonly client: BinanceClient;
  private sets = new Map<string, CandleSet>();
  private loading = new Map<string, Promise<CandleSet>>();

  constructor(client = new BinanceClient()) {
    this.client = client;
  }

  key(symbol: string, interval: string) {
    return `${symbol}:${interval}`;
  }

  get(symbol: string, interval: string): CandleSet | undefined {
    return this.sets.get(this.key(symbol, interval));
  }

  /** Load `days` of closed candles, using the cache and downloading only what is missing. */
  load(symbol: string, interval: string, days: number, onProgress?: (frac: number) => void): Promise<CandleSet> {
    const key = this.key(symbol, interval);
    const inflight = this.loading.get(key);
    if (inflight) return inflight;
    const p = this.doLoad(symbol, interval, days, onProgress).finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }

  private async doLoad(symbol: string, interval: string, days: number, onProgress?: (frac: number) => void): Promise<CandleSet> {
    const key = this.key(symbol, interval);
    const tf = parseTf(interval);
    const now = Date.now();
    const wantFrom = Math.floor((now - days * DAY) / tf.ms) * tf.ms;
    let rows = this.sets.get(key)?.rows ?? (await readCandles(key)) ?? [];
    if (rows.length && rows[0][0] > wantFrom + tf.ms) rows = []; // cache does not reach back far enough
    if (rows.length && rows[rows.length - 1][0] < wantFrom) rows = []; // cache is older than the whole window
    const from = rows.length ? rows[rows.length - 1][0] + 1 : wantFrom;
    const total = Math.max(1, (now - from) / tf.ms);
    const fetched = await this.client.klinesRange(symbol, interval, from, now, (n) => onProgress?.(Math.min(1, n / total)));
    const { closed, forming } = splitClosed(fetched, Date.now());
    for (const k of closed) {
      if (!rows.length || k.t > rows[rows.length - 1][0]) rows.push(klineToRow(k));
    }
    const cap = maxRows(interval, days);
    if (rows.length > cap) rows = rows.slice(rows.length - cap);
    const set: CandleSet = { symbol, interval, rows, forming, cap };
    this.sets.set(key, set);
    void writeCandles(key, rows);
    return set;
  }

  /** Apply a live kline. Returns true when a new closed candle was appended. */
  applyKline(symbol: string, interval: string, k: Kline, closed: boolean): boolean {
    const set = this.sets.get(this.key(symbol, interval));
    if (!set) return false;
    const last = set.rows[set.rows.length - 1];
    if (closed) {
      set.forming = null;
      if (!last || k.t > last[0]) {
        // a gap means we missed candles while disconnected: the caller repairs it
        set.rows.push(klineToRow(k));
        if (set.rows.length > set.cap) set.rows.splice(0, set.rows.length - set.cap);
        void writeCandles(this.key(symbol, interval), set.rows);
        return true;
      }
      return false;
    }
    if (!last || k.t > last[0]) set.forming = k;
    return false;
  }

  /** Fetch candles missed since the last stored one (after a reconnect or wake-up). */
  async repair(symbol: string, interval: string): Promise<boolean> {
    const set = this.sets.get(this.key(symbol, interval));
    if (!set || !set.rows.length) return false;
    const before = set.rows.length;
    const fetched = await this.client.klinesRange(symbol, interval, set.rows[set.rows.length - 1][0] + 1, Date.now());
    const { closed, forming } = splitClosed(fetched, Date.now());
    for (const k of closed) if (k.t > set.rows[set.rows.length - 1][0]) set.rows.push(klineToRow(k));
    if (set.rows.length > set.cap) set.rows.splice(0, set.rows.length - set.cap);
    set.forming = forming ?? set.forming;
    if (set.rows.length !== before) void writeCandles(this.key(symbol, interval), set.rows);
    return set.rows.length !== before;
  }

  tickers(symbols: string[]): Promise<Ticker24h[]> {
    return this.client.ticker24h(symbols);
  }
}

type StreamHandler = (data: Record<string, unknown>) => void;

/**
 * One WebSocket for all live streams (combined-stream endpoint). Subscriptions are
 * re-sent after every reconnect. If no connection can be made, `onStatus('polling')`
 * tells the app to fall back to REST polling.
 */
export class LiveFeed {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<StreamHandler>>();
  private hostIndex = 0;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private msgId = 1;
  private closedByUser = false;
  private toSub = new Set<string>();
  private toUnsub = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Binance closes connections that send more than 5 messages a second, so control
   * messages are batched: at most one SUBSCRIBE and one UNSUBSCRIBE per 500 ms. */
  private queue(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', stream: string) {
    if (method === 'SUBSCRIBE') {
      this.toUnsub.delete(stream);
      this.toSub.add(stream);
    } else {
      this.toSub.delete(stream);
      this.toUnsub.add(stream);
    }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 500);
  }
  private flush() {
    this.flushTimer = null;
    if (!this.ws || this.ws.readyState !== 1) return; // onopen subscribes everything anyway
    if (this.toSub.size) this.send('SUBSCRIBE', [...this.toSub]);
    if (this.toUnsub.size) this.send('UNSUBSCRIBE', [...this.toUnsub]);
    this.toSub.clear();
    this.toUnsub.clear();
  }
  status: FeedStatus = 'connecting';
  onStatus: (s: FeedStatus) => void = () => {};
  onReconnect: () => void = () => {};
  private hosts: string[];
  private WS: typeof WebSocket | null;

  /** `WS` = null means WebSockets are unavailable (the feed reports 'polling'). */
  constructor(hosts = WS_HOSTS, WS: typeof WebSocket | null = typeof WebSocket !== 'undefined' ? WebSocket : null) {
    this.hosts = hosts;
    this.WS = WS;
  }

  private setStatus(s: FeedStatus) {
    if (this.status !== s) {
      this.status = s;
      this.onStatus(s);
    }
  }

  subscribe(stream: string, fn: StreamHandler): () => void {
    let set = this.handlers.get(stream);
    const isNew = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(stream, set);
    }
    set.add(fn);
    if (isNew) this.queue('SUBSCRIBE', stream);
    if (!this.ws && !this.timer) this.connect();
    return () => {
      const s = this.handlers.get(stream);
      if (!s) return;
      s.delete(fn);
      if (!s.size) {
        this.handlers.delete(stream);
        this.queue('UNSUBSCRIBE', stream);
      }
    };
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]) {
    if (this.ws && this.ws.readyState === 1 && params.length) {
      try {
        this.ws.send(JSON.stringify({ method, params, id: this.msgId++ }));
      } catch {
        /* reconnect logic handles it */
      }
    }
  }

  private connect() {
    this.timer = null;
    if (!this.WS) {
      this.setStatus('polling');
      return;
    }
    this.closedByUser = false;
    const host = this.hosts[this.hostIndex % this.hosts.length];
    this.setStatus(this.retry > 2 ? 'polling' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new this.WS(`${host}/stream`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      const wasRetry = this.retry > 0;
      this.retry = 0;
      this.setStatus('live');
      this.toSub.clear();
      this.toUnsub.clear();
      this.send('SUBSCRIBE', [...this.handlers.keys()]);
      if (wasRetry) this.onReconnect();
    };
    ws.onmessage = (ev) => {
      let msg: { stream?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!msg.stream || !msg.data) return;
      const hs = this.handlers.get(msg.stream);
      if (hs) for (const h of hs) h(msg.data);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUser) return;
      if (!opened) this.hostIndex++;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect() {
    this.retry++;
    this.setStatus(this.retry > 2 ? 'polling' : 'connecting');
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry, 5));
    this.timer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setStatus('offline');
  }
}

/** Parse a WebSocket kline event into a Kline plus its closed flag. */
export function parseWsKline(data: Record<string, unknown>): { k: Kline; closed: boolean; symbol: string; interval: string } | null {
  const k = data.k as Record<string, unknown> | undefined;
  if (!k) return null;
  try {
    const kline = parseKline([k.t, k.o, k.h, k.l, k.c, k.v, k.T]);
    return { k: kline, closed: Boolean(k.x), symbol: String(k.s), interval: String(k.i) };
  } catch {
    return null;
  }
}
