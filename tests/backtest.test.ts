import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runBacktest, type Ctx, type Strategy } from '../src/engine/backtest.ts';
import { Rng } from '../src/engine/rng.ts';
import { DAY } from '../src/engine/timeframe.ts';
import type { KlineRow } from '../src/engine/types.ts';
import { seriesFromRows } from '../src/engine/types.ts';
import { randomSeries } from './helpers.ts';

const noCost = { feeRate: 0, slippage: 0 };
const binance = { feeRate: 0.001, slippage: 0 };

function bars(rows: [number, number, number, number][], barMs = DAY) {
  const k: KlineRow[] = rows.map((r, i) => [Date.UTC(2024, 0, 1) + i * barMs, r[0], r[1], r[2], r[3], 1]);
  return seriesFromRows(k, barMs);
}

const strat = (name: string, hooks: Partial<Strategy>): Strategy => ({ name, onBar: () => {}, ...hooks });

describe('fills and fees', () => {
  it('buy and hold: qty and final equity are exact', () => {
    const s = bars([[100, 110, 90, 105], [105, 120, 100, 118], [118, 125, 110, 120]]);
    const r = runBacktest(s, strat('hodl', { onStart: (c) => c.buy(c.p.cash, 'start') }), { initialCash: 10_000, costs: binance });
    const qty = (10_000 * 0.999) / 100;
    expect(r.final.qty).toBeCloseTo(qty, 12);
    expect(r.final.cash).toBe(0);
    expect(r.final.equity).toBeCloseTo(qty * 120, 9);
    expect(r.final.feesPaid).toBeCloseTo(10, 12);
    expect(r.equity).toHaveLength(3);
    expect(r.equity[0]).toBeCloseTo(qty * 105, 9);
  });

  it('market orders placed at a close fill at the next open with slippage', () => {
    const s = bars([[100, 101, 99, 100], [200, 210, 190, 205], [300, 310, 290, 305]]);
    let placed = false;
    const r = runBacktest(
      s,
      strat('next-open', {
        onBar: (c) => {
          if (!placed) {
            c.buy(1000, 'signal');
            placed = true;
          } else if (c.i === 1) c.sell(c.p.qty, 'exit');
        },
      }),
      { initialCash: 1000, costs: { feeRate: 0.001, slippage: 0.002 } },
    );
    expect(r.fills[0].i).toBe(1);
    expect(r.fills[0].price).toBeCloseTo(200 * 1.002, 12);
    expect(r.fills[1].i).toBe(2);
    expect(r.fills[1].price).toBeCloseTo(300 * 0.998, 12);
    const qty = (1000 * 0.999) / (200 * 1.002);
    const proceeds = qty * 300 * 0.998 * 0.999;
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].pnl).toBeCloseTo(proceeds - 1000, 9);
    expect(r.final.cash).toBeCloseTo(proceeds, 9);
  });

  it('stop fills at the stop price, or at the open on a gap down', () => {
    const run = (row: [number, number, number, number]) =>
      runBacktest(
        bars([[100, 100, 100, 100], row]),
        strat('stop', {
          onStart: (c) => c.buy(1000, 'in'),
          onFill: (c, f) => {
            if (f.side === 'buy') c.setStop(95);
          },
        }),
        { initialCash: 1000, costs: noCost },
      );
    const touched = run([100, 101, 94, 99]);
    expect(touched.fills[1].price).toBe(95);
    expect(touched.trades[0].exitReason).toBe('stop');
    const gap = run([90, 92, 85, 91]);
    expect(gap.fills[1].price).toBe(90);
  });

  it('if a bar touches both stop and target, the stop is assumed first', () => {
    const r = runBacktest(
      bars([[100, 100, 100, 100], [100, 120, 80, 100]]),
      strat('both', {
        onStart: (c) => c.buy(1000, 'in'),
        onFill: (c, f) => {
          if (f.side === 'buy') {
            c.setStop(90);
            c.limitSell(c.p.qty, 110, 'target');
          }
        },
      }),
      { initialCash: 1000, costs: noCost },
    );
    expect(r.fills).toHaveLength(2);
    expect(r.fills[1].reason).toBe('stop');
    expect(r.fills[1].price).toBe(90);
    expect(r.final.qty).toBe(0);
  });

  it('limit sells fill at the limit, or at the open when the bar gaps above it', () => {
    const run = (row: [number, number, number, number]) =>
      runBacktest(
        bars([[100, 100, 100, 100], row]),
        strat('tp', {
          onStart: (c) => c.buy(1000, 'in'),
          onFill: (c, f) => {
            if (f.side === 'buy') c.limitSell(c.p.qty, 110, 'target');
          },
        }),
        { initialCash: 1000, costs: noCost },
      );
    expect(run([100, 111, 99, 105]).fills[1].price).toBe(110);
    expect(run([115, 120, 112, 118]).fills[1].price).toBe(115);
    expect(run([100, 109, 99, 105]).fills).toHaveLength(1);
  });

  it('staking compounds per bar at the configured APR', () => {
    const rows = Array.from({ length: 366 }, () => [100, 100, 100, 100] as [number, number, number, number]);
    const r = runBacktest(bars(rows), strat('stake', { onStart: (c) => c.buy(1000, 'in') }), {
      initialCash: 1000,
      costs: noCost,
      stakingApr: 0.03,
    });
    // bar 0 accrues too: 366 daily accruals
    expect(r.final.qty).toBeCloseTo(10 * (1 + 0.03 / 365) ** 366, 10);
    expect(r.final.stakedQtyEarned).toBeCloseTo(r.final.qty - 10, 12);
  });

  it('orders below the minimum notional are ignored; full exits of dust are allowed', () => {
    const s = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]);
    const r = runBacktest(
      s,
      strat('tiny', {
        onStart: (c) => c.buy(3, 'too small'),
        onBar: (c) => {
          if (c.i === 0) c.buy(50, 'ok');
          if (c.i === 1) c.sell(c.p.qty, 'all');
        },
      }),
      { initialCash: 100, costs: noCost, minNotional: 5 },
    );
    expect(r.fills.map((f) => f.reason)).toEqual(['ok', 'all']);
  });
});

describe('accounting invariants (property based)', () => {
  /** A strategy that does random things, seeded. */
  function chaos(seed: number): Strategy {
    const rng = new Rng(seed);
    return {
      name: 'chaos',
      onBar: (c: Ctx) => {
        const u = rng.next();
        if (u < 0.15) c.buy(c.p.cash * rng.next(), 'rand-buy');
        else if (u < 0.25) c.sell(c.p.qty * rng.next(), 'rand-sell');
        else if (u < 0.3) c.sell(c.p.qty, 'rand-exit');
        else if (u < 0.35 && c.p.qty > 0) c.setStop(c.s.c[c.i] * (0.95 + 0.04 * rng.next()));
        else if (u < 0.4 && c.p.qty > 0) c.limitSell(c.p.qty * rng.next(), c.s.c[c.i] * (1.01 + 0.04 * rng.next()), 'rand-tp');
        else if (u < 0.43) c.limitBuy(c.p.cash * rng.next(), c.s.c[c.i] * (0.96 + 0.03 * rng.next()), 'rand-dip');
        else if (u < 0.45) c.addCash(100 * rng.next());
        else if (u < 0.47) c.cancelLimits();
      },
    };
  }

  it('cash, coins, fees and P&L always reconcile', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.boolean(), (seed, stake) => {
        const s = randomSeries({ n: 300, barMs: DAY, seed, vol: 0.03 });
        const costs = { feeRate: 0.001, slippage: 0.0005 };
        const r = runBacktest(s, chaos(seed), { initialCash: 10_000, costs, stakingApr: stake ? 0.05 : 0 });
        const buys = r.fills.filter((f) => f.side === 'buy');
        const sells = r.fills.filter((f) => f.side === 'sell');
        const cash = 10_000 + r.final.contributed - buys.reduce((a, f) => a + f.quote, 0) + sells.reduce((a, f) => a + f.quote, 0);
        expect(r.final.cash).toBeCloseTo(cash, 6);
        expect(r.final.cash).toBeGreaterThanOrEqual(0);
        expect(r.final.qty).toBeGreaterThanOrEqual(0);
        const qty = buys.reduce((a, f) => a + f.qty, 0) - sells.reduce((a, f) => a + f.qty, 0) + r.final.stakedQtyEarned;
        expect(r.final.qty).toBeCloseTo(qty, 9);
        expect(r.final.feesPaid).toBeCloseTo(r.fills.reduce((a, f) => a + f.fee, 0), 9);
        // every recorded equity point is cash + coins at that close
        expect(r.equity[r.equity.length - 1]).toBeCloseTo(r.final.cash + r.final.qty * s.c[s.c.length - 1], 6);
        for (const f of r.fills) {
          expect(f.price).toBeLessThanOrEqual(s.h[f.i] * (1 + costs.slippage) + 1e-9);
          expect(f.price).toBeGreaterThanOrEqual(s.l[f.i] * (1 - costs.slippage) - 1e-9);
          expect(f.fee).toBeCloseTo(f.side === 'buy' ? (f.quote * costs.feeRate) : (f.qty * f.price * costs.feeRate), 9);
        }
        // closed-trade P&L + open position value = total gain (no staking case)
        if (!stake) {
          const closed = r.trades.reduce((a, t) => a + t.pnl, 0);
          const openVal = r.openTrade ? r.final.qty * s.c[s.c.length - 1] + r.openTrade.proceeds - r.openTrade.cost : 0;
          expect(closed + openVal).toBeCloseTo(r.final.equity - 10_000 - r.final.contributed, 5);
        }
      }),
      { numRuns: 200 },
    );
  });
});
