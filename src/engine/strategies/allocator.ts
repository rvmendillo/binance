/**
 * Long-term confluence allocator ("my strategy" for the long run).
 *
 * Every day it scores the market across all long timeframes (1d .. 1M, plus custom
 * ones such as 2d, 5d, 2w) and blends that with a valuation signal (how far price is
 * above or below its 200-day average). The blend maps to a target share of the
 * portfolio held in the coin (0-100%). It only trades when the target moves by more
 * than a band, which keeps fees low. Held coins earn staking yield.
 */
import type { Ctx, Strategy } from '../backtest.ts';
import type { Confluence } from '../confluence.ts';
import { clamp, sma } from '../indicators.ts';

export interface AllocatorParams {
  /** Weight of the multi-timeframe trend score; the rest goes to valuation. */
  wTrend: number;
  valSma: number;
  /** ln(price / SMA) that counts as "fully" over/undervalued. */
  valScale: number;
  /** Blended score at or below which the target allocation is 0%. */
  sLow: number;
  /** Blended score at or above which the target allocation is 100%. */
  sHigh: number;
  /** Minimum change in target allocation before trading. */
  band: number;
  minCoverage: number;
}

export const DEFAULT_ALLOCATOR: AllocatorParams = {
  wTrend: 0.75,
  valSma: 200,
  valScale: 0.6,
  sLow: -0.15,
  sHigh: 0.2,
  band: 0.25,
  minCoverage: 0.6,
};

export interface AllocatorState {
  target: number;
  score: number;
  valuation: number;
}

/** Target allocation and its inputs at bar i (exported for the UI and tests). */
export function allocatorTarget(cf: Confluence, valSma: number[], i: number, p: AllocatorParams): AllocatorState | null {
  if (!(cf.coverage[i] >= p.minCoverage) || !Number.isFinite(cf.D[i])) return null;
  const c = cf.base.c[i];
  const val = Number.isFinite(valSma[i]) ? -Math.tanh(Math.log(c / valSma[i]) / p.valScale) : 0;
  const score = p.wTrend * cf.D[i] + (1 - p.wTrend) * val;
  const target = clamp((score - p.sLow) / (p.sHigh - p.sLow), 0, 1);
  return { target, score, valuation: val };
}

export function allocator(cf: Confluence, params: AllocatorParams = DEFAULT_ALLOCATOR, name = 'Confluence allocator'): Strategy {
  const valSma = sma(cf.base.c, params.valSma);
  return {
    name,
    onBar: (c: Ctx) => {
      const st = allocatorTarget(cf, valSma, c.i, params);
      if (!st) return;
      const price = c.s.c[c.i];
      const eq = c.equity();
      if (!(eq > 0)) return;
      const cur = (c.p.qty * price) / eq;
      const delta = st.target - cur;
      const toZero = st.target === 0 && cur > 0.001;
      const toFull = st.target === 1 && cur < 0.995 && delta > 0.02;
      if (Math.abs(delta) < params.band && !toZero && !toFull) return;
      if (delta > 0) c.buy(st.target === 1 ? c.p.cash : delta * eq, `target ${(st.target * 100).toFixed(0)}% (score ${st.score.toFixed(2)})`);
      else c.sell(st.target === 0 ? c.p.qty : (-delta * eq) / price, `target ${(st.target * 100).toFixed(0)}% (score ${st.score.toFixed(2)})`);
    },
  };
}
