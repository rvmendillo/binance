/**
 * Projection of the user's plan: the real daily history is continued with many
 * synthetic futures built from blocks of real ETH days, and the exact same plan is
 * simulated through history and on into each future. This answers "how likely is my
 * target, and when?" with the plan's real current state (coins, cash, staking).
 */
import { runBacktest } from './backtest.ts';
import { convertResult, rateFn, type FxSeries } from './fx.ts';
import { bootstrapPricePaths, concatSeries, percentile } from './projection.ts';
import type { Settings } from './presets.ts';
import { dcaPlan } from './strategies/dcaPlan.ts';
import { hodl } from './strategies/hodl.ts';
import type { Series } from './types.ts';

export interface ValueBand {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface PlanProjection {
  days: number;
  paths: number;
  demean: boolean;
  startPrice: number;
  target: number;
  /** Probability that the target is touched within each horizon (days). */
  hitBy: { days: number; prob: number }[];
  medianDaysToTarget: number | null;
  planValue: ValueBand;
  hodlValue: ValueBand;
  /** Share of paths where the plan ends with more money than it has today. */
  planProbGain: number;
  /** Share of paths where the plan at least doubles today's value. */
  planProbDouble: number;
  /** Values are in this currency; future amounts use the last known exchange rate. */
  currency: string;
  fxNow: number;
  planNow: number;
  pricePaths: { p10: number[]; p50: number[]; p90: number[] };
}

const band = (v: number[]): ValueBand => {
  const s = [...v].sort((a, b) => a - b);
  return { p10: percentile(s, 0.1), p25: percentile(s, 0.25), p50: percentile(s, 0.5), p75: percentile(s, 0.75), p90: percentile(s, 0.9) };
};

export function projectPlan(
  daily: Series,
  settings: Settings,
  opts: { startIndex: number; days?: number; paths?: number; demean?: boolean; seed?: number; bootstrapFrom?: number; fx?: FxSeries | null },
): PlanProjection {
  if (settings.currency !== 'USD' && (!opts.fx || opts.fx.currency !== settings.currency)) throw new Error(`Exchange rates for ${settings.currency} are not loaded`);
  // money in the account currency; days after the last known rate keep that rate
  const rate = rateFn(settings.currency === 'USD' ? null : opts.fx);
  const days = opts.days ?? 1095;
  const paths = opts.paths ?? 300;
  const costs = { feeRate: settings.feeRate, slippage: settings.slippage };
  const btOpts = { initialCash: settings.initialCash / rate(daily.t[opts.startIndex]), costs, startIndex: opts.startIndex, stakingApr: settings.ethStakingApr };
  const plan = () => dcaPlan(settings.plan, undefined, rate);
  const now = convertResult(runBacktest(daily, plan(), btOpts), rate);
  const planNow = now.final.equity;
  const fxNow = rate(daily.t[daily.t.length - 1]);
  const target = Math.min(...settings.plan.takeProfit.map((l) => l.price));
  const futures = bootstrapPricePaths(daily, { paths, days, block: 30, seed: opts.seed ?? 2026, demean: opts.demean ?? false, fromIndex: opts.bootstrapFrom ?? 1 });
  const horizons = [90, 180, 365, 730, 1095].filter((h) => h <= days);
  const firstHit: number[] = [];
  const planVals: number[] = [];
  const hodlVals: number[] = [];
  const priceAt: number[][] = Array.from({ length: days }, () => []);
  for (const f of futures) {
    let hit = -1;
    for (let k = 0; k < f.h.length; k++) {
      priceAt[k].push(f.c[k]);
      if (hit < 0 && f.h[k] >= target) hit = k + 1;
    }
    firstHit.push(hit);
    const full = concatSeries(daily, f);
    const end = full.t[full.t.length - 1];
    const r = runBacktest(full, plan(), btOpts);
    planVals.push(r.final.equity * rate(end));
    const h = runBacktest(full, hodl(), { ...btOpts, startIndex: daily.t.length, initialCash: planNow / rate(full.t[daily.t.length]) });
    hodlVals.push(h.final.equity * rate(end));
  }
  const hits = firstHit.filter((d) => d > 0).sort((a, b) => a - b);
  // paths that never hit count as 'later than the horizon', so the median exists only if half hit
  const medianIdx = Math.floor((paths - 1) / 2);
  const pick = (q: number) => priceAt.map((arr) => percentile([...arr].sort((a, b) => a - b), q));
  return {
    days,
    paths,
    demean: opts.demean ?? false,
    startPrice: daily.c[daily.c.length - 1],
    target,
    hitBy: horizons.map((d) => ({ days: d, prob: firstHit.filter((x) => x > 0 && x <= d).length / paths })),
    medianDaysToTarget: medianIdx < hits.length ? hits[medianIdx] : null,
    planValue: band(planVals),
    hodlValue: band(hodlVals),
    planProbGain: planVals.filter((v) => v > planNow).length / paths,
    planProbDouble: planVals.filter((v) => v >= 2 * planNow).length / paths,
    currency: settings.currency,
    fxNow,
    planNow,
    pricePaths: { p10: pick(0.1), p50: pick(0.5), p90: pick(0.9) },
  };
}

