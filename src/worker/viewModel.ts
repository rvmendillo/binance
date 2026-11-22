/**
 * Turns a full simulation result into a compact, serialisable view model for the UI
 * (downsampled curves, recent trades, chart markers, projections per strategy).
 */
import type { Fill, Trade } from '../engine/backtest.ts';
import type { ComponentKey } from '../engine/features.ts';
import type { Currency } from '../engine/fx.ts';
import type { Metrics } from '../engine/metrics.ts';
import { CUSTOM_TF_IDS, type ModeId } from '../engine/presets.ts';
import { bootstrapProjection, compound, yearsToMultiple, type ProjectionBand } from '../engine/projection.ts';
import type { Decision, ModeResult, PlanState, StrategyId } from '../engine/simulate.ts';
import type { SignalEval } from '../engine/strategies/trader.ts';

export type MetricsView = Omit<Metrics, 'daily' | 'dailyTimes'>;

export interface TradeView {
  entryTime: number;
  exitTime: number;
  /** Average fill prices (before fees); P&L figures are after fees. */
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  r: number | null;
  entryReason: string;
  exitReason: string;
  live: boolean;
}

export interface MarkerView {
  time: number;
  side: 'buy' | 'sell';
  price: number;
  text: string;
}

export interface RunView {
  id: StrategyId;
  name: string;
  about: string;
  metrics: MetricsView;
  equity: { t: number[]; v: number[] };
  trades: TradeView[];
  open: { entryTime: number; avgPrice: number; qty: number; value: number; pnl: number; pnlPct: number; stop: number | null } | null;
  finalCash: number;
  finalQty: number;
  liveFills: number;
  projection: {
    cagr: number;
    yearsToDouble: number;
    compound: { years: number; value: number }[];
    bands: ProjectionBand[];
  };
}

export interface TfRowView {
  tf: string;
  custom: boolean;
  weight: number;
  barTime: number | null;
  trend: number;
  mom: number;
  rev: number;
  dir: number;
  rsi: number;
  components: Record<ComponentKey, number>;
}

export interface ModeView {
  symbol: string;
  mode: ModeId;
  isEth: boolean;
  /** Money amounts in this view are in `currency`; prices are USDT. */
  currency: Currency;
  /** Account currency per 1 USDT on the last candle's day. */
  fxNow: number;
  price: number;
  lastClosedTime: number;
  computeMs: number;
  bars: number;
  simStart: number;
  decision: Decision;
  snapshot: { D: number; A: number; B: number; H: number; coverage: number; votes: { bull: number; bear: number; neutral: number }; perTf: TfRowView[] };
  chart: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; markers: MarkerView[] };
  runs: RunView[];
  primary: StrategyId;
  plan?: PlanState;
  signal?: SignalEval;
  trader?: { candidates: number; taken: number; skippedNoEdge: number; skippedDailyLimit: number; trackN: number; trackMean: number };
  allocator?: { target: number; score: number; valuation: number } | null;
}

/** Keep at most `max` points, always including the first and last. */
export function downsample(t: number[], v: number[], max: number): { t: number[]; v: number[] } {
  if (t.length <= max) return { t: [...t], v: [...v] };
  const step = (t.length - 1) / (max - 1);
  const ot: number[] = [];
  const ov: number[] = [];
  for (let k = 0; k < max; k++) {
    const i = Math.round(k * step);
    ot.push(t[i]);
    ov.push(v[i]);
  }
  return { t: ot, v: ov };
}

const tradeView = (t: Trade, liveSince: number): TradeView => ({
  entryTime: t.entryTime,
  exitTime: t.exitTime,
  entryPrice: t.avgBuyFill,
  exitPrice: t.avgSellFill,
  pnl: t.pnl,
  pnlPct: t.pnlPct,
  r: t.r,
  entryReason: t.entryReason,
  exitReason: t.exitReason,
  live: t.exitTime >= liveSince,
});

export function buildView(res: ModeResult, opts: { computeMs: number; liveSince: number; chartBars?: number; stopOf?: (id: StrategyId) => number | null }): ModeView {
  const { series } = res;
  const n = series.t.length;
  const chartBars = opts.chartBars ?? 300;
  const from = Math.max(0, n - chartBars);
  const primaryRun = res.runs.find((r) => r.id === res.primary) ?? res.runs[0];
  const chartStart = series.t[from];
  const markers: MarkerView[] = primaryRun.result.fills
    .filter((f: Fill) => f.time >= chartStart)
    .map((f: Fill) => ({ time: f.time, side: f.side, price: f.price, text: f.side === 'buy' ? 'B' : 'S' }));

  const runs: RunView[] = res.runs.map((r) => {
    const { daily, dailyTimes, ...metrics } = r.metrics;
    void dailyTimes;
    const eq = downsample(r.result.times, r.result.equity, 400);
    const ot = r.result.openTrade;
    // the coin's value per unit in the account currency at the last close
    const value = r.result.final.qty * r.result.final.price;
    const years = [1, 2, 3, 5];
    return {
      id: r.id,
      name: r.name,
      about: r.about,
      metrics,
      equity: eq,
      trades: r.result.trades.slice(-60).reverse().map((t) => tradeView(t, opts.liveSince)),
      open: ot
        ? {
            entryTime: ot.entryTime,
            avgPrice: ot.buyNotional / Math.max(ot.qtyBought, 1e-12),
            qty: r.result.final.qty,
            value,
            pnl: value + ot.proceeds - ot.cost,
            pnlPct: (value + ot.proceeds - ot.cost) / ot.cost,
            stop: opts.stopOf?.(r.id) ?? null,
          }
        : null,
      finalCash: r.result.final.cash,
      finalQty: r.result.final.qty,
      liveFills: r.result.fills.filter((f) => f.time >= opts.liveSince).length,
      projection: {
        cagr: metrics.cagr,
        yearsToDouble: yearsToMultiple(metrics.cagr, 2),
        compound: years.map((y) => ({ years: y, value: compound(metrics.finalEquity, metrics.cagr, y) })),
        bands: daily.length >= 90 ? bootstrapProjection(daily, metrics.finalEquity, [365, 730, 1095], { paths: 1000, block: 20, seed: 17 }) : [],
      },
    };
  });

  return {
    symbol: res.symbol,
    mode: res.mode,
    isEth: res.isEth,
    currency: res.currency,
    fxNow: res.fxNow,
    price: res.price,
    lastClosedTime: res.lastClosedTime,
    computeMs: opts.computeMs,
    bars: n,
    simStart: series.t[res.startIndex],
    decision: res.decision,
    snapshot: {
      D: res.snapshot.D,
      A: res.snapshot.A,
      B: res.snapshot.B,
      H: res.snapshot.H,
      coverage: res.snapshot.coverage,
      votes: res.snapshot.votes,
      perTf: res.snapshot.perTf.map((p) => ({ ...p, custom: CUSTOM_TF_IDS.has(p.tf) || !['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'].includes(p.tf) })),
    },
    chart: {
      t: series.t.slice(from),
      o: series.o.slice(from),
      h: series.h.slice(from),
      l: series.l.slice(from),
      c: series.c.slice(from),
      markers,
    },
    runs,
    primary: res.primary,
    plan: res.plan,
    signal: res.signal,
    trader: res.traderDiag
      ? {
          candidates: res.traderDiag.candidates,
          taken: res.traderDiag.taken,
          skippedNoEdge: res.traderDiag.skippedNoEdge,
          skippedDailyLimit: res.traderDiag.skippedDailyLimit,
          trackN: res.traderDiag.trackN,
          trackMean: res.traderDiag.trackMean,
        }
      : undefined,
    allocator: res.allocatorState ?? null,
  };
}
