import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinanceClient, BinanceHttpError, parseKline, splitClosed } from '../src/data/binance.ts';
import { LiveFeed, Market, parseWsKline } from '../src/data/market.ts';

const MIN = 60_000;
type Handler = (url: string) => { status: number; body: unknown; headers?: Record<string, string> };

function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const r = handler(url);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  };
  return { fn, calls };
}

const kl = (t: number, c = 100, ms = MIN) => [t, String(c), String(c + 1), String(c - 1), String(c), '5', t + ms - 1, '0', 1, '0', '0', '0'];
const noSleep = async () => {};

/** Serves 1m klines for [0, end) from a synthetic market, honouring startTime/limit. */
function klineServer(end: number): Handler {
  return (url) => {
    const q = new URL(url).searchParams;
    const start = Number(q.get('startTime') ?? 0);
    const stop = Math.min(Number(q.get('endTime') ?? end), end);
    const limit = Number(q.get('limit') ?? 500);
    const rows = [];
    for (let t = Math.ceil(start / MIN) * MIN; t <= stop && rows.length < limit; t += MIN) if (t < end) rows.push(kl(t, 100 + t / MIN));
    return { status: 200, body: rows };
  };
}

describe('BinanceClient', () => {
  it('paginates without duplicates or gaps', async () => {
    const end = 2500 * MIN;
    const { fn, calls } = fakeFetch(klineServer(end));
    const c = new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep });
    const ks = await c.klinesRange('ETHUSDT', '1m', 0, end);
    expect(ks).toHaveLength(2500);
    ks.forEach((k, i) => expect(k.t).toBe(i * MIN));
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('data-api.binance.vision');
  });

  it('falls back to the next host on a regional block (451)', async () => {
    const { fn, calls } = fakeFetch((url) => (url.includes('data-api') ? { status: 451, body: { msg: 'restricted location' } } : { status: 200, body: [kl(0)] }));
    const c = new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep });
    const ks = await c.klines('ETHUSDT', '1m');
    expect(ks).toHaveLength(1);
    expect(calls[1]).toContain('api.binance.com');
    expect(c.activeHost).toBe('https://api.binance.com');
  });

  it('waits on rate limits (429) and retries', async () => {
    let n = 0;
    const waits: number[] = [];
    const { fn } = fakeFetch(() => (n++ === 0 ? { status: 429, body: {}, headers: { 'retry-after': '7' } } : { status: 200, body: [kl(0)] }));
    const c = new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: async (ms) => void waits.push(ms) });
    await c.klines('ETHUSDT', '1m');
    expect(waits).toContain(7000);
  });

  it('does not retry a bad request (400) and reports it', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 400, body: { code: -1121, msg: 'Invalid symbol.' } }));
    const c = new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep });
    await expect(c.klines('NOPEUSDT', '1m')).rejects.toBeInstanceOf(BinanceHttpError);
    expect(calls).toHaveLength(1);
  });

  it('gives up after all hosts fail', async () => {
    const { fn } = fakeFetch(() => ({ status: 451, body: { msg: 'restricted location' } }));
    const c = new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep, maxRetries: 3 });
    await expect(c.klines('ETHUSDT', '1m')).rejects.toThrow(/451/);
  });

  it('parses klines and separates the forming candle', () => {
    expect(() => parseKline([1, 'x', '1', '1', '1', '1', 2])).toThrow();
    const ks = [kl(0), kl(MIN), kl(2 * MIN)].map(parseKline);
    const { closed, forming } = splitClosed(ks, 2 * MIN + 30_000);
    expect(closed.map((k) => k.t)).toEqual([0, MIN]);
    expect(forming?.t).toBe(2 * MIN);
    expect(splitClosed(ks, 10 * MIN).forming).toBeNull();
  });
});

describe('Market (candle store)', () => {
  afterEach(() => vi.useRealTimers());

  it('loads closed candles, keeps the forming one aside, applies live updates and repairs gaps', async () => {
    vi.useFakeTimers();
    const now = 3000 * MIN + 30_000;
    vi.setSystemTime(now);
    let end = 3001 * MIN; // candle 3000 is forming
    const { fn } = fakeFetch((url) => klineServer(end)(url));
    const m = new Market(new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep }));
    const set = await m.load('ETHUSDT', '1m', 1); // 1 day = 1440 candles (+margin)
    expect(set.rows[set.rows.length - 1][0]).toBe(2999 * MIN);
    expect(set.forming?.t).toBe(3000 * MIN);
    expect(set.rows.length).toBeLessThanOrEqual(set.cap);
    // a live tick of the forming candle does not add a row
    const tick = parseKline(kl(3000 * MIN, 50));
    expect(m.applyKline('ETHUSDT', '1m', tick, false)).toBe(false);
    expect(m.get('ETHUSDT', '1m')!.forming?.c).toBe(50);
    // its close does, exactly once
    expect(m.applyKline('ETHUSDT', '1m', tick, true)).toBe(true);
    expect(m.applyKline('ETHUSDT', '1m', tick, true)).toBe(false);
    expect(set.forming).toBeNull();
    // the connection drops for 5 minutes: repair fetches the missed candles
    vi.setSystemTime(now + 5 * MIN);
    end = 3006 * MIN;
    expect(await m.repair('ETHUSDT', '1m')).toBe(true);
    const rows = m.get('ETHUSDT', '1m')!.rows;
    expect(rows[rows.length - 1][0]).toBe(3004 * MIN);
    for (let i = 1; i < rows.length; i++) expect(rows[i][0] - rows[i - 1][0]).toBe(MIN);
    expect(rows.length).toBeLessThanOrEqual(set.cap);
  });

  it('a wrong device clock cannot turn the forming candle into a closed one', async () => {
    vi.useFakeTimers();
    const serverNow = 3000 * MIN + 10_000; // candle 3000 has been open for 10 s
    vi.setSystemTime(serverNow + 2 * MIN); // the phone runs 2 minutes fast
    const { fn } = fakeFetch((url) => (url.includes('/time') ? { status: 200, body: { serverTime: serverNow + (Date.now() - (serverNow + 2 * MIN)) } } : klineServer(3001 * MIN)(url)));
    const m = new Market(new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep }));
    const set = await m.load('ETHUSDT', '1m', 1);
    expect(set.rows[set.rows.length - 1][0]).toBe(2999 * MIN);
    expect(set.forming?.t).toBe(3000 * MIN);
  });

  it('the final values of a closed candle replace whatever was stored for it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100 * MIN + 1);
    const { fn } = fakeFetch(klineServer(100 * MIN));
    const m = new Market(new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep }));
    const set = await m.load('ETHUSDT', '1m', 1);
    const last = set.rows[set.rows.length - 1];
    const fixed = parseKline(kl(last[0], 777));
    expect(m.applyKline('ETHUSDT', '1m', fixed, true)).toBe(true);
    expect(set.rows[set.rows.length - 1][4]).toBe(777);
    expect(m.applyKline('ETHUSDT', '1m', fixed, true)).toBe(false); // unchanged: no recompute
  });

  it('ignores an invalid server-time answer instead of corrupting every timestamp', async () => {
    const { fn } = fakeFetch((url) => (url.includes('/time') ? { status: 200, body: { nope: true } } : { status: 200, body: [] }));
    const m = new Market(new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep }));
    await m.syncClock();
    expect(Math.abs(m.now() - Date.now())).toBeLessThan(1000);
  });

  it('one unknown symbol does not hide the prices of the others', async () => {
    const { fn } = fakeFetch((url) => {
      const syms = JSON.parse(new URL(url).searchParams.get('symbols') ?? '[]') as string[];
      if (syms.includes('FAKEUSDT')) return { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } };
      return { status: 200, body: syms.map((sy) => ({ symbol: sy, lastPrice: '1', priceChangePercent: '2', highPrice: '1', lowPrice: '1', quoteVolume: '1' })) };
    });
    const m = new Market(new BinanceClient({ fetch: fn, minIntervalMs: 0, sleep: noSleep }));
    const ts = await m.tickers(['BTCUSDT', 'FAKEUSDT', 'SOLUSDT']);
    expect(ts.map((t) => t.symbol)).toEqual(['BTCUSDT', 'SOLUSDT']);
  });

  it('parses WebSocket kline events', () => {
    const ev = { e: 'kline', k: { t: 0, T: MIN - 1, s: 'ETHUSDT', i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '3', x: true } };
    expect(parseWsKline(ev)).toMatchObject({ closed: true, symbol: 'ETHUSDT', interval: '1m', k: { c: 1.5 } });
    expect(parseWsKline({ e: 'other' })).toBeNull();
  });
});

class FakeWS {
  static instances: FakeWS[] = [];
  static failNext = 0;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
    setTimeout(() => {
      if (FakeWS.failNext > 0) {
        FakeWS.failNext--;
        this.readyState = 3;
        this.onclose?.();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 10);
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(stream: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ stream, data }) });
  }
}

describe('LiveFeed', () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeWS.instances = [];
    FakeWS.failNext = 0;
  });

  it('batches subscriptions, routes messages and resubscribes after a reconnect', async () => {
    vi.useFakeTimers();
    const feed = new LiveFeed(['wss://a', 'wss://b'], FakeWS as unknown as typeof WebSocket);
    const statuses: string[] = [];
    feed.onStatus = (s) => statuses.push(s);
    const got: unknown[] = [];
    feed.subscribe('ethusdt@kline_1m', (d) => got.push(d));
    await vi.advanceTimersByTimeAsync(20);
    expect(statuses).toContain('live');
    const ws = FakeWS.instances[0];
    expect(JSON.parse(ws.sent[0]).params).toEqual(['ethusdt@kline_1m']);
    // ten more streams at once: one SUBSCRIBE message, not ten
    const offs = ['btc', 'sol', 'bnb', 'xrp', 'doge', 'ada', 'link', 'avax', 'trx', 'sui'].map((s) => feed.subscribe(`${s}usdt@miniTicker`, () => {}));
    await vi.advanceTimersByTimeAsync(600);
    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[1]).params).toHaveLength(10);
    // unsubscribing everything is also one message
    offs.forEach((o) => o());
    await vi.advanceTimersByTimeAsync(600);
    expect(ws.sent).toHaveLength(3);
    expect(JSON.parse(ws.sent[2]).method).toBe('UNSUBSCRIBE');
    ws.emit('ethusdt@kline_1m', { x: 1 });
    ws.emit('other@stream', { x: 2 });
    expect(got).toEqual([{ x: 1 }]);
    // drop: reconnects and subscribes the remaining stream in one message
    let reconnected = false;
    feed.onReconnect = () => (reconnected = true);
    ws.close();
    await vi.advanceTimersByTimeAsync(2100);
    const ws2 = FakeWS.instances[1];
    expect(ws2).toBeDefined();
    expect(JSON.parse(ws2.sent[0]).params).toEqual(['ethusdt@kline_1m']);
    expect(reconnected).toBe(true);
    feed.close();
  });

  it('reports polling when it cannot connect, and has no WebSocket at all', async () => {
    vi.useFakeTimers();
    FakeWS.failNext = 10;
    const feed = new LiveFeed(['wss://a'], FakeWS as unknown as typeof WebSocket);
    const statuses: string[] = [];
    feed.onStatus = (s) => statuses.push(s);
    feed.subscribe('ethusdt@kline_1m', () => {});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(statuses).toContain('polling');
    feed.close();
    const none = new LiveFeed(['wss://a'], null);
    const st2: string[] = [];
    none.onStatus = (s) => st2.push(s);
    none.subscribe('x', () => {});
    expect(st2).toEqual(['polling']);
  });
});
