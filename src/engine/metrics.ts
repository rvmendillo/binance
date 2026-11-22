/**
 * Performance statistics. Returns are time-weighted (deposits do not count as gains).
 */
import type { BacktestResult, Trade } from './backtest.ts';
import { DAY } from './timeframe.ts';

export interface Metrics {
  startTime: number;
  endTime: number;
  days: number;
  initialCash: number;
  contributed: number;
  finalEquity: number;
  /** Profit in quote currency after fees (final equity - money put in). */
  profit: number;
  /** Profit / money put in. */
  totalReturn: number;
  /** Time-weighted compound annual growth rate. */
  cagr: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  calmar: number;
  trades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  /** Average trade return in % of cost. */
  expectancy: number;
  /** Average R multiple when stops were declared. */
  avgR: number | null;
  bestTrade: number;
  worstTrade: number;
  avgBars: number;
  exposure: number;
  fees: number;
  stakingQty: number;
  stakingValue: number;
  /** Daily time-weighted returns, for projections. */
  daily: number[];
  dailyTimes: number[];
}

/** Daily equity (last value of each UTC day) and the deposits during that day. */
export function dailyEquity(r: BacktestResult): { times: number[]; equity: number[]; flows: number[] } {
  const times: number[] = [];
  const equity: number[] = [];
  const flows: number[] = [];
  let curDay = Number.NaN;
  for (let k = 0; k < r.times.length; k++) {
    const d = Math.floor(r.times[k] / DAY);
    if (d !== curDay) {
      curDay = d;
      times.push(d * DAY);
      equity.push(r.equity[k]);
      flows.push(r.flows[k]);
    } else {
      equity[equity.length - 1] = r.equity[k];
      flows[flows.length - 1] += r.flows[k];
    }
  }
  return { times, equity, flows };
}

export function tradeStats(trades: Trade[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const rs = trades.map((t) => t.r).filter((r): r is number => r !== null);
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: trades.length ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length : 0,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.pnlPct)) : 0,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : 0,
    avgBars: trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : 0,
  };
}

export function computeMetrics(r: BacktestResult): Metrics {
  const de = dailyEquity(r);
  const daily: number[] = [];
  const dailyTimes: number[] = [];
  let prev = r.initialCash;
  for (let k = 0; k < de.equity.length; k++) {
    const e = de.equity[k];
    const f = de.flows[k];
    if (prev > 1e-9) {
      daily.push((e - f) / prev - 1);
      dailyTimes.push(de.times[k]);
    }
    prev = e;
  }
  const n = daily.length;
  const mean = n ? daily.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const downside = n > 1 ? Math.sqrt(daily.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / (n - 1)) : 0;
  let idx = 1;
  let peak = 1;
  let mdd = 0;
  for (const d of daily) {
    idx *= 1 + d;
    peak = Math.max(peak, idx);
    mdd = Math.min(mdd, idx / peak - 1);
  }
  const startTime = r.times[0] ?? 0;
  const endTime = r.times[r.times.length - 1] ?? 0;
  const days = Math.max(1, (endTime - startTime) / DAY + 1);
  const cagr = idx > 0 ? idx ** (365 / Math.max(n, 1)) - 1 : -1;
  const contributed = r.final.contributed;
  const invested = r.initialCash + contributed;
  const ts = tradeStats(r.trades);
  const held = r.qty.filter((q) => q > 0).length;
  return {
    startTime,
    endTime,
    days,
    initialCash: r.initialCash,
    contributed,
    finalEquity: r.final.equity,
    profit: r.final.equity - invested,
    totalReturn: invested > 0 ? r.final.equity / invested - 1 : 0,
    cagr,
    volatility: sd * Math.sqrt(365),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    sortino: downside > 0 ? (mean / downside) * Math.sqrt(365) : 0,
    maxDrawdown: mdd,
    calmar: mdd < 0 ? cagr / -mdd : 0,
    ...ts,
    exposure: r.qty.length ? held / r.qty.length : 0,
    fees: r.final.feesPaid,
    stakingQty: r.final.stakedQtyEarned,
    stakingValue: r.final.stakedQtyEarned * r.final.price,
    daily,
    dailyTimes,
  };
}
