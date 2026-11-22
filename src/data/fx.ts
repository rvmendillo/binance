/**
 * USD -> account-currency exchange rates for the app.
 * 1. Daily history from Frankfurter (European Central Bank reference rates, free,
 *    no key, allows any origin), cached on the device and refreshed once a day.
 * 2. If that fails: the cached history.
 * 3. If there is no cache: today's rate from a second provider, applied to every day
 *    (flagged as approximate so the UI can say so).
 * 4. Otherwise an error: wrong money amounts are worse than none.
 */
import { parseFrankfurter, validateFx, type Currency, type FxSeries } from '../engine/fx.ts';

export const FX_HISTORY_URL = (currency: Currency, from: string) => `https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=${currency}`;
export const FX_LATEST_URLS = (currency: Currency) => [
  { url: 'https://open.er-api.com/v6/latest/USD', pick: (j: unknown) => (j as { rates?: Record<string, number> }).rates?.[currency] },
  {
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json',
    pick: (j: unknown) => (j as { usd?: Record<string, number> }).usd?.[currency.toLowerCase()],
  },
];

export interface FxLoad {
  fx: FxSeries;
  source: 'history' | 'cache' | 'latest-only' | 'identity';
  /** True when only today's rate is known and is used for every day. */
  approximate: boolean;
  /** Date of the latest rate (ms, UTC midnight). */
  asOf: number;
}

type FetchFn = (url: string) => Promise<Response>;
const storeKey = (c: Currency) => `confluence.fx.${c}.v1`;
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Cached {
  fetchedDay: string;
  t: number[];
  r: number[];
}

function readCache(c: Currency, storage: Storage | null): Cached | null {
  try {
    const raw = storage?.getItem(storeKey(c));
    if (!raw) return null;
    const v = JSON.parse(raw) as Cached;
    validateFx({ currency: c, t: v.t, r: v.r });
    return v;
  } catch {
    return null;
  }
}

function writeCache(c: Currency, fx: FxSeries, fetchedDay: string, storage: Storage | null) {
  try {
    storage?.setItem(storeKey(c), JSON.stringify({ fetchedDay, t: fx.t, r: fx.r }));
  } catch {
    /* storage full or blocked: the app still works, it just re-downloads */
  }
}

export const FX_HISTORY_START = '2017-08-01';

export async function loadFx(
  currency: Currency,
  opts: { fetch?: FetchFn; now?: number; storage?: Storage | null } = {},
): Promise<FxLoad> {
  if (currency === 'USD') return { fx: { currency, t: [0], r: [1] }, source: 'identity', approximate: false, asOf: 0 };
  const fetchFn: FetchFn = opts.fetch ?? ((u) => fetch(u));
  const storage = opts.storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : opts.storage;
  const today = dayStr(opts.now ?? Date.now());
  const cached = readCache(currency, storage);
  if (cached && cached.fetchedDay === today) {
    return { fx: { currency, t: cached.t, r: cached.r }, source: 'cache', approximate: false, asOf: cached.t[cached.t.length - 1] };
  }
  try {
    // only ask for days after the cache, but re-ask the last cached day (it may have been revised)
    const from = cached ? dayStr(cached.t[cached.t.length - 1]) : FX_HISTORY_START;
    const res = await fetchFn(FX_HISTORY_URL(currency, from));
    if (!res.ok) throw new Error(`Exchange rates: HTTP ${res.status}`);
    const fresh = parseFrankfurter(await res.json(), currency);
    const map = new Map<number, number>();
    if (cached) cached.t.forEach((t, k) => map.set(t, cached.r[k]));
    fresh.t.forEach((t, k) => map.set(t, fresh.r[k]));
    const t = [...map.keys()].sort((a, b) => a - b);
    const fx: FxSeries = { currency, t, r: t.map((x) => map.get(x)!) };
    validateFx(fx);
    if (fx.t[0] > Date.parse(`${FX_HISTORY_START}T00:00:00Z`) + 10 * 86_400_000) throw new Error('Exchange-rate history is incomplete');
    writeCache(currency, fx, today, storage);
    return { fx, source: 'history', approximate: false, asOf: fx.t[fx.t.length - 1] };
  } catch (e) {
    if (cached) return { fx: { currency, t: cached.t, r: cached.r }, source: 'cache', approximate: false, asOf: cached.t[cached.t.length - 1] };
    for (const src of FX_LATEST_URLS(currency)) {
      try {
        const res = await fetchFn(src.url);
        if (!res.ok) continue;
        const v = Number(src.pick(await res.json()));
        if (Number.isFinite(v) && v > 0) {
          const asOf = Date.parse(`${today}T00:00:00Z`);
          return { fx: { currency, t: [Date.parse(`${FX_HISTORY_START}T00:00:00Z`)], r: [v] }, source: 'latest-only', approximate: true, asOf };
        }
      } catch {
        /* try the next provider */
      }
    }
    throw new Error(`Could not load the USD to ${currency} exchange rate. Check your connection and try again. (${e instanceof Error ? e.message : String(e)})`);
  }
}
