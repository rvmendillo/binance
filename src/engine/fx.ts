/**
 * Account currency. Binance prices are in USDT; money can be shown and entered in
 * another currency (default: Philippine peso). Conversion uses the exchange rate of
 * each day (USDT is treated as 1 USD), so peso results include the currency's own
 * moves over time, as a peso-based investor would experience them.
 */
import type { BacktestResult, Fill, Trade } from './backtest.ts';

export type Currency = 'PHP' | 'USD';

export const CURRENCY_INFO: Record<Currency, { name: string; symbol: string; locale: string }> = {
  PHP: { name: 'Philippine peso', symbol: '₱', locale: 'en-PH' },
  USD: { name: 'US dollar', symbol: '$', locale: 'en-US' },
};

/** Daily rates: units of the account currency per 1 USD, oldest first. */
export interface FxSeries {
  currency: Currency;
  t: number[];
  r: number[];
}

/** A rate function: account currency per 1 USDT at time t. */
export type RateFn = (t: number) => number;

export const ONE: RateFn = () => 1;

/** Last known rate at or before t (weekends and holidays carry the previous rate);
 * before the first date, the first rate. */
export function rateAt(fx: FxSeries, t: number): number {
  const { t: ts, r } = fx;
  if (!ts.length) throw new Error('Empty exchange-rate series');
  if (t < ts[0]) return r[0];
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return r[lo];
}

export function rateFn(fx: FxSeries | null | undefined): RateFn {
  if (!fx || fx.currency === 'USD') return ONE;
  return (t) => rateAt(fx, t);
}

export function validateFx(fx: FxSeries): void {
  if (fx.t.length !== fx.r.length || !fx.t.length) throw new Error('Malformed exchange-rate series');
  for (let i = 0; i < fx.t.length; i++) {
    if (!(fx.r[i] > 0) || !Number.isFinite(fx.r[i])) throw new Error(`Bad exchange rate at ${new Date(fx.t[i]).toISOString().slice(0, 10)}`);
    if (i && fx.t[i] <= fx.t[i - 1]) throw new Error('Exchange-rate dates out of order');
  }
}

/** Parse a Frankfurter time-series response ({rates: {"YYYY-MM-DD": {PHP: 56.1}}}). */
export function parseFrankfurter(json: unknown, currency: Currency): FxSeries {
  const rates = (json as { rates?: Record<string, Record<string, number>> }).rates;
  if (!rates || typeof rates !== 'object') throw new Error('No rates in exchange-rate response');
  const days = Object.keys(rates).sort();
  const t: number[] = [];
  const r: number[] = [];
  for (const d of days) {
    const v = Number(rates[d]?.[currency]);
    const ms = Date.parse(`${d}T00:00:00Z`);
    if (Number.isFinite(v) && v > 0 && Number.isFinite(ms)) {
      t.push(ms);
      r.push(v);
    }
  }
  const fx = { currency, t, r };
  validateFx(fx);
  return fx;
}

/**
 * Re-express a USDT backtest in the account currency. Every cash amount is converted
 * at the rate of its own day: deposits and buys when they happened, the portfolio at
 * each close. Market prices (fill prices, stops, average fill prices) stay in USDT.
 * `final.price` becomes the coin's value in the account currency at the end.
 */
export function convertResult(res: BacktestResult, rate: RateFn): BacktestResult {
  if (rate === ONE) return res;
  const conv = (f: Fill): Fill => {
    const k = rate(f.time);
    return { ...f, quote: f.quote * k, fee: f.fee * k };
  };
  const fills = res.fills.map(conv);
  const byTrade = new Map<number, Fill[]>();
  for (const f of fills) {
    if (!byTrade.has(f.trade)) byTrade.set(f.trade, []);
    byTrade.get(f.trade)!.push(f);
  }
  const sums = (no: number) => {
    const fs = byTrade.get(no) ?? [];
    let cost = 0;
    let proceeds = 0;
    let fees = 0;
    for (const f of fs) {
      if (f.side === 'buy') cost += f.quote;
      else proceeds += f.quote;
      fees += f.fee;
    }
    return { cost, proceeds, fees };
  };
  const trades: Trade[] = res.trades.map((tr, no) => {
    const s = sums(no);
    const pnl = s.proceeds - s.cost;
    return {
      ...tr,
      cost: s.cost,
      proceeds: s.proceeds,
      fees: s.fees,
      pnl,
      pnlPct: s.cost > 0 ? pnl / s.cost : 0,
      // R multiples are about the trade's own risk and stay currency neutral
      r: tr.r,
      // cost per coin bought and proceeds per coin sold, in the account currency
      entryPrice: tr.qtyBought > 0 ? s.cost / tr.qtyBought : 0,
      exitPrice: tr.exitPrice > 0 && tr.proceeds > 0 ? s.proceeds / (tr.proceeds / tr.exitPrice) : 0,
    };
  });
  const lastT = res.times.length ? res.times[res.times.length - 1] : 0;
  const kEnd = rate(lastT);
  const openTrade = res.openTrade
    ? (() => {
        const s = sums(res.trades.length);
        return { ...res.openTrade, cost: s.cost, proceeds: s.proceeds, fees: s.fees, initialRisk: res.openTrade.initialRisk ? res.openTrade.initialRisk * kEnd : null };
      })()
    : null;
  const flows = res.flows.map((f, k) => f * rate(res.times[k]));
  const kStart = res.times.length ? rate(res.times[0]) : 1;
  return {
    ...res,
    equity: res.equity.map((e, k) => e * rate(res.times[k])),
    flows,
    fills,
    trades,
    openTrade,
    initialCash: res.initialCash * kStart,
    final: {
      ...res.final,
      cash: res.final.cash * kEnd,
      equity: res.final.equity * kEnd,
      price: res.final.price * kEnd,
      feesPaid: fills.reduce((a, f) => a + f.fee, 0),
      contributed: flows.reduce((a, f) => a + f, 0),
      stakingValueEarned: res.final.stakingValueEarned * kEnd,
    },
  };
}
