/**
 * Binance public market-data client (no API key needed, nothing is signed).
 * Works in browsers (CORS: Access-Control-Allow-Origin: *), in the iOS web view
 * and in Node. Only simple GET requests without custom headers are used, so no
 * CORS preflight happens.
 *
 * Host order: data-api.binance.vision serves market data only and is reachable
 * from more regions; api.binance.com and its mirrors are fallbacks.
 */
import type { KlineRow } from '../engine/types.ts';

export const REST_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api-gcp.binance.com',
];

export const WS_HOSTS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];

export interface Kline {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Inclusive close time in ms as reported by Binance (t + interval - 1). */
  closeTime: number;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  fetch?: FetchFn;
  hosts?: string[];
  /** Minimum gap between requests, to stay far below Binance rate limits. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class BinanceHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function parseKline(row: unknown[]): Kline {
  const k: Kline = {
    t: Number(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    v: Number(row[5]),
    closeTime: Number(row[6]),
  };
  if (![k.t, k.o, k.h, k.l, k.c, k.v, k.closeTime].every(Number.isFinite)) {
    throw new Error(`Malformed kline row: ${JSON.stringify(row).slice(0, 200)}`);
  }
  return k;
}

export const klineToRow = (k: Kline): KlineRow => [k.t, k.o, k.h, k.l, k.c, k.v];

export class BinanceClient {
  private fetchFn: FetchFn;
  private hosts: string[];
  private hostIndex = 0;
  private minIntervalMs: number;
  private maxRetries: number;
  private sleep: (ms: number) => Promise<void>;
  private lastRequest = 0;
  private queue: Promise<void> = Promise.resolve();
  /** Last used weight reported by Binance (x-mbx-used-weight-1m). */
  usedWeight = 0;
  /** Host that served the last successful request. */
  activeHost: string;

  constructor(opts: ClientOptions = {}) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.hosts = opts.hosts ?? REST_HOSTS;
    this.minIntervalMs = opts.minIntervalMs ?? 80;
    this.maxRetries = opts.maxRetries ?? 5;
    this.sleep = opts.sleep ?? defaultSleep;
    this.activeHost = this.hosts[0];
  }

  /** Serialised, rate-limited GET with host fallback and retries. */
  async getJson<T>(path: string): Promise<T> {
    const run = async (): Promise<T> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const wait = this.lastRequest + this.minIntervalMs - Date.now();
        if (wait > 0) await this.sleep(wait);
        if (this.usedWeight > 4800) await this.sleep(15_000);
        const host = this.hosts[this.hostIndex % this.hosts.length];
        this.lastRequest = Date.now();
        try {
          const res = await this.fetchFn(host + path);
          const w = res.headers?.get?.('x-mbx-used-weight-1m');
          if (w) this.usedWeight = Number(w) || 0;
          if (res.ok) {
            this.activeHost = host;
            return (await res.json()) as T;
          }
          const body = await res.text().catch(() => '');
          if (res.status === 451 || res.status === 403) {
            // Region restricted on this host: try the next one.
            this.hostIndex++;
            lastErr = new BinanceHttpError(res.status, `HTTP ${res.status} from ${host}: ${body.slice(0, 160)}`);
            continue;
          }
          if (res.status === 429 || res.status === 418) {
            const retryAfter = Number(res.headers?.get?.('retry-after')) || 30;
            lastErr = new BinanceHttpError(res.status, `Rate limited (HTTP ${res.status})`);
            await this.sleep(Math.min(retryAfter, 120) * 1000);
            continue;
          }
          if (res.status >= 500) {
            lastErr = new BinanceHttpError(res.status, `HTTP ${res.status} from ${host}`);
            await this.sleep(500 * 2 ** attempt);
            continue;
          }
          throw new BinanceHttpError(res.status, `HTTP ${res.status}: ${body.slice(0, 200)}`);
        } catch (e) {
          if (e instanceof BinanceHttpError && e.status >= 400 && e.status < 500 && ![403, 418, 429, 451].includes(e.status)) throw e;
          lastErr = e;
          if (!(e instanceof BinanceHttpError)) {
            // Network failure: rotate host and back off.
            this.hostIndex++;
            await this.sleep(300 * 2 ** attempt);
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async serverTime(): Promise<number> {
    const r = await this.getJson<{ serverTime: number }>('/api/v3/time');
    return r.serverTime;
  }

  async klines(symbol: string, interval: string, opts: { startTime?: number; endTime?: number; limit?: number } = {}): Promise<Kline[]> {
    const q = new URLSearchParams({ symbol, interval, limit: String(opts.limit ?? 1000) });
    if (opts.startTime !== undefined) q.set('startTime', String(Math.floor(opts.startTime)));
    if (opts.endTime !== undefined) q.set('endTime', String(Math.floor(opts.endTime)));
    const rows = await this.getJson<unknown[][]>(`/api/v3/klines?${q.toString()}`);
    return rows.map(parseKline);
  }

  /**
   * All klines with open time in [startTime, endTime], paginating 1000 at a time.
   * The last element may be the still-forming candle (closeTime in the future).
   */
  async klinesRange(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number = Date.now(),
    onProgress?: (fetched: number, lastTime: number) => void,
  ): Promise<Kline[]> {
    const out: Kline[] = [];
    let from = startTime;
    for (let guard = 0; guard < 100_000; guard++) {
      const batch = await this.klines(symbol, interval, { startTime: from, endTime, limit: 1000 });
      for (const k of batch) {
        if (out.length && k.t <= out[out.length - 1].t) continue; // never duplicate
        out.push(k);
      }
      if (onProgress && out.length) onProgress(out.length, out[out.length - 1].t);
      if (batch.length < 1000) break;
      const last = batch[batch.length - 1].t;
      if (last >= endTime) break;
      from = last + 1;
    }
    return out;
  }

  async ticker24h(symbols: string[]): Promise<Ticker24h[]> {
    const q = encodeURIComponent(JSON.stringify(symbols));
    const rows = await this.getJson<Record<string, string>[]>(`/api/v3/ticker/24hr?symbols=${q}`);
    return rows.map((r) => ({
      symbol: r.symbol,
      lastPrice: Number(r.lastPrice),
      priceChangePercent: Number(r.priceChangePercent),
      highPrice: Number(r.highPrice),
      lowPrice: Number(r.lowPrice),
      quoteVolume: Number(r.quoteVolume),
    }));
  }
}

/** Split klines into closed bars and the still-forming bar (if any). */
export function splitClosed(klines: Kline[], nowMs: number): { closed: Kline[]; forming: Kline | null } {
  if (!klines.length) return { closed: [], forming: null };
  const last = klines[klines.length - 1];
  if (last.closeTime >= nowMs) return { closed: klines.slice(0, -1), forming: last };
  return { closed: klines, forming: null };
}
