// Research only: tested and rejected (results unstable across parameters). Not used by the app.
/**
 * Smart DCA: the user's "buy low, sell high, stake in between" idea with zones that
 * adapt to the market instead of fixed prices.
 *
 * Value is measured by the Mayer multiple (price / 200-day average). On each
 * scheduled buy day the amount bought scales with how cheap the coin is, and buys are
 * delayed while every timeframe is still falling hard ("don't catch a falling knife").
 * When price is far above its long-term average, coins are sold in steps, faster when
 * the multi-timeframe momentum starts to roll over. Held coins are staked.
 */
import type { Ctx, Strategy } from '../src/engine/backtest.ts';
import type { Confluence } from '../src/engine/confluence.ts';
import { sma } from '../src/engine/indicators.ts';
import { DAY } from '../src/engine/timeframe.ts';

export interface SmartDcaParams {
  buyEveryDays: number;
  /** Base buy as a fraction of the starting capital (multiplied by the value tier). */
  baseBuyFrac: number;
  /** Mayer-multiple tiers: [upper bound, buy multiplier], checked in order. */
  buyTiers: [number, number][];
  /** Skip buys while the big-picture score H is below this, unless value is extreme. */
  knifeH: number;
  /** Mayer multiple below which buys continue even in a crash. */
  extremeValue: number;
  /** Mayer multiple at which selling starts, and the share sold per sell day. */
  sellStart: number;
  sellFrac: number;
  /** Mayer multiple at which the faster sell share applies. */
  sellHot: number;
  sellHotFrac: number;
  /** Sell only when momentum is fading (D below this), so strong rallies are not cut early. */
  sellWhenDBelow: number;
  sellEveryDays: number;
  smaDays: number;
  minCoverage: number;
}

export const DEFAULT_SMART_DCA: SmartDcaParams = {
  buyEveryDays: 7,
  baseBuyFrac: 0.025,
  buyTiers: [
    [0.7, 3],
    [0.85, 2],
    [1.0, 1.5],
    [1.15, 1],
    [1.3, 0.5],
  ],
  knifeH: -0.35,
  extremeValue: 0.6,
  sellStart: 1.6,
  sellFrac: 0.1,
  sellHot: 2.1,
  sellHotFrac: 0.25,
  sellWhenDBelow: 0.35,
  sellEveryDays: 7,
  smaDays: 200,
  minCoverage: 0.5,
};

export function mayerMultiple(c: number[], smaDays = 200): number[] {
  const m = sma(c, smaDays);
  return c.map((x, i) => (Number.isFinite(m[i]) && m[i] > 0 ? x / m[i] : Number.NaN));
}

export function buyMultiplier(mm: number, p: SmartDcaParams): number {
  for (const [ub, mult] of p.buyTiers) if (mm < ub) return mult;
  return 0;
}

export function smartDca(cf: Confluence, params: SmartDcaParams = DEFAULT_SMART_DCA, name = 'Smart DCA'): Strategy {
  const mm = mayerMultiple(cf.base.c, params.smaDays);
  let t0 = Number.NaN;
  let unit = 0;
  return {
    name,
    onStart: (c) => {
      t0 = c.s.t[c.i];
      unit = c.p.cash * params.baseBuyFrac;
    },
    onBar: (c: Ctx) => {
      const i = c.i;
      const day = Math.floor((c.s.t[i] - t0) / DAY);
      const m = mm[i];
      if (!Number.isFinite(m) || !(cf.coverage[i] >= params.minCoverage)) return;
      const H = cf.H[i];
      const D = cf.D[i];
      if (day % params.sellEveryDays === 0 && c.p.qty > 0 && m >= params.sellStart && D < params.sellWhenDBelow) {
        const frac = m >= params.sellHot ? params.sellHotFrac : params.sellFrac;
        c.sell(c.p.qty * frac, `take profit: price ${m.toFixed(2)}x its ${params.smaDays}-day average`);
        return;
      }
      if (day % params.buyEveryDays !== 0 || c.p.cash <= 0) return;
      const mult = buyMultiplier(m, params);
      if (mult <= 0) return;
      if (Number.isFinite(H) && H < params.knifeH && m >= params.extremeValue) return; // falling knife: wait
      c.buy(Math.min(c.p.cash, unit * mult), `value buy x${mult} (price ${m.toFixed(2)}x average)`);
    },
  };
}
