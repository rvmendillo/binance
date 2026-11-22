/**
 * The user's own plan: dollar-cost average into ETH only while price is inside a
 * buy zone (default 1500-1700 USDT), keep the coins staked, and sell when price
 * reaches the target (default 4000+). Optionally repeat the cycle.
 * Designed for daily bars; decisions use the daily close and execute at the next open.
 */
import type { Ctx, Fill, Strategy } from '../backtest.ts';
import { DAY } from '../timeframe.ts';

export interface TakeProfitLevel {
  price: number;
  /** Fraction of the coins still held when this level is reached (last level should be 1). */
  fraction: number;
}

export interface DcaPlanParams {
  zoneLow: number;
  zoneHigh: number;
  /** Also buy when price is below the zone (cheaper than planned). */
  buyBelowZone: boolean;
  /** Days between scheduled buys (1 = daily, 7 = weekly). */
  buyEveryDays: number;
  /** Quote amount per scheduled buy. */
  buyAmount: number;
  takeProfit: TakeProfitLevel[];
  /** Start buying again after selling everything. */
  repeat: boolean;
  /** Optional recurring deposit. */
  contribution?: { amount: number; everyDays: number };
}

export const DEFAULT_DCA_PLAN: DcaPlanParams = {
  zoneLow: 1500,
  zoneHigh: 1700,
  buyBelowZone: false,
  buyEveryDays: 7,
  buyAmount: 500,
  takeProfit: [{ price: 4000, fraction: 1 }],
  repeat: true,
};

export function validateDcaPlan(p: DcaPlanParams): string[] {
  const errs: string[] = [];
  if (!(p.zoneLow > 0) || !(p.zoneHigh > p.zoneLow)) errs.push('Buy zone must have a low price below the high price.');
  if (!(p.buyAmount > 0)) errs.push('Buy amount must be positive.');
  if (!Number.isInteger(p.buyEveryDays) || p.buyEveryDays < 1) errs.push('Buy interval must be a whole number of days (1 or more).');
  if (!p.takeProfit.length) errs.push('Add at least one sell target.');
  const sorted = [...p.takeProfit].sort((a, b) => a.price - b.price);
  if (sorted.some((l) => !(l.price > p.zoneHigh))) errs.push('Sell targets must be above the buy zone.');
  if (sorted.some((l) => !(l.fraction > 0 && l.fraction <= 1))) errs.push('Sell fractions must be between 0 and 1.');
  return errs;
}

export function dcaPlan(params: DcaPlanParams, name = 'My plan (zone DCA)'): Strategy {
  const levels = [...params.takeProfit].sort((a, b) => a.price - b.price);
  let hit = new Array<boolean>(levels.length).fill(false);
  let done = false;
  let t0 = Number.NaN;

  /** Re-place the sell targets for the coins currently held. The last level not yet
   * reached sells everything that is left. */
  const refreshTargets = (c: Ctx) => {
    c.cancelLimits('sell');
    if (c.p.qty <= 0) return;
    const remaining = levels.map((lvl, k) => ({ lvl, k })).filter((x) => !hit[x.k]);
    let rem = c.p.qty;
    remaining.forEach(({ lvl, k }, idx) => {
      const amt = idx === remaining.length - 1 ? rem : lvl.fraction * rem;
      if (amt > 0) c.limitSell(amt, lvl.price, `Target ${lvl.price} (level ${k + 1})`);
      rem -= amt;
    });
  };

  return {
    name,
    onStart: (c) => {
      t0 = c.s.t[c.i];
    },
    onFill: (c: Ctx, f: Fill) => {
      const m = f.side === 'sell' ? /\(level (\d+)\)$/.exec(f.reason) : null;
      if (m) {
        hit[Number(m[1]) - 1] = true;
        if (c.p.qty === 0) {
          // cycle complete: everything sold at the targets
          hit = new Array<boolean>(levels.length).fill(false);
          if (!params.repeat) done = true;
          c.note(`Cycle complete at ${f.price.toFixed(2)}`);
        }
      }
      if (f.side === 'buy') refreshTargets(c);
    },
    onBar: (c: Ctx) => {
      const i = c.i;
      const day = Math.floor((c.s.t[i] - t0) / DAY);
      if (params.contribution && params.contribution.amount > 0 && day % params.contribution.everyDays === 0) {
        c.addCash(params.contribution.amount);
      }
      const px = c.s.c[i];
      const inZone = px >= params.zoneLow && px <= params.zoneHigh;
      const below = px < params.zoneLow;
      if (!done && day % params.buyEveryDays === 0 && (inZone || (below && params.buyBelowZone)) && c.p.cash > 0) {
        c.buy(Math.min(params.buyAmount, c.p.cash), inZone ? 'DCA in zone' : 'DCA below zone');
      }
      refreshTargets(c);
    },
  };
}
