/**
 * Plan+ : the user's zone plan, with every buy and sell checked against the
 * multi-timeframe confluence first.
 *  - Buys stay inside the user's zone. Size goes up when the timeframes turn up
 *    (momentum returning) and buys pause while every timeframe is still falling hard.
 *  - At the target, if the confluence is strongly bullish, only part is sold and the
 *    rest rides the trend with a trailing exit; otherwise everything is sold as planned.
 */
import type { Ctx, Fill, Strategy } from '../backtest.ts';
import type { Confluence } from '../confluence.ts';
import { DAY } from '../timeframe.ts';
import type { DcaPlanParams } from './dcaPlan.ts';

export interface PlanPlusParams {
  /** Buy-size multiplier when the base timeframe is turning up and D > upD. */
  upMult: number;
  upD: number;
  /** Skip a scheduled buy while H < knifeH and D < knifeD (crash still under way). */
  knifeH: number;
  knifeD: number;
  /** At the target, if D >= runD and A >= runA, sell only `runSellFrac` and trail the rest. */
  runD: number;
  runA: number;
  runSellFrac: number;
  /** Trailing exit for the remainder: close below (1 - trailPct) x highest close since the target. */
  trailPct: number;
  /** ...or when the confluence turns bearish. */
  exitD: number;
}

export const DEFAULT_PLAN_PLUS: PlanPlusParams = {
  upMult: 1.5,
  upD: -0.1,
  knifeH: -0.45,
  knifeD: -0.4,
  runD: 0.35,
  runA: 0.7,
  runSellFrac: 0.5,
  trailPct: 0.2,
  exitD: -0.15,
};

export function planPlus(cf: Confluence, plan: DcaPlanParams, pp: PlanPlusParams = DEFAULT_PLAN_PLUS, name = 'Plan+ (confluence timing)'): Strategy {
  const target = Math.min(...plan.takeProfit.map((l) => l.price));
  const base = cf.feats[0];
  let t0 = Number.NaN;
  let riding = false;
  let peak = 0;
  let done = false;
  let strong = false;
  const PARTIAL = 'Target reached with all timeframes bullish (partial)';

  /** Standing sell order for the next candle: all at the target, or only part of it
   * when the confluence is strongly bullish (the rest then rides the trend). */
  const armTarget = (c: Ctx) => {
    c.cancelLimits('sell');
    if (c.p.qty <= 0 || riding) return;
    if (strong) c.limitSell(c.p.qty * pp.runSellFrac, target, PARTIAL);
    else c.limitSell(c.p.qty, target, `Target ${target}`);
  };

  return {
    name,
    onStart: (c) => {
      t0 = c.s.t[c.i];
    },
    onFill: (c: Ctx, f: Fill) => {
      if (f.side === 'buy') armTarget(c);
      if (f.side === 'sell' && f.reason === PARTIAL && c.p.qty > 0) {
        riding = true;
        peak = f.price;
      }
      if (f.side === 'sell' && c.p.qty === 0) {
        riding = false;
        peak = 0;
        if (!plan.repeat) done = true;
      }
    },
    onBar: (c: Ctx) => {
      const i = c.i;
      const px = c.s.c[i];
      const D = cf.D[i];
      const A = cf.A[i];
      const H = cf.H[i];
      const day = Math.floor((c.s.t[i] - t0) / DAY);
      if (plan.contribution && plan.contribution.amount > 0 && day % plan.contribution.everyDays === 0) c.addCash(plan.contribution.amount);
      strong = Number.isFinite(D) && D >= pp.runD && A >= pp.runA;

      // Riding the trend with the remainder after a partial sell at the target
      if (riding && c.p.qty > 0) {
        peak = Math.max(peak, px);
        const trail = px < peak * (1 - pp.trailPct);
        if (trail || (Number.isFinite(D) && D <= pp.exitD)) {
          c.sell(c.p.qty, trail ? 'Trailing exit after target' : 'Confluence turned bearish after target');
        }
        return;
      }

      const inZone = px >= plan.zoneLow && px <= plan.zoneHigh;
      const below = px < plan.zoneLow;
      if (!done && day % plan.buyEveryDays === 0 && (inZone || (below && plan.buyBelowZone)) && c.p.cash > 0) {
        const falling = Number.isFinite(H) && H < pp.knifeH && D < pp.knifeD;
        if (falling) {
          c.note('Buy paused: every timeframe still falling');
        } else {
          const turningUp = Number.isFinite(D) && D > pp.upD && base.dir[i] > base.dir[i - 1];
          const amt = plan.buyAmount * (turningUp ? pp.upMult : 1);
          c.buy(Math.min(amt, c.p.cash), turningUp ? 'DCA in zone, timeframes turning up' : 'DCA in zone');
        }
      }
      armTarget(c);
    },
  };
}
