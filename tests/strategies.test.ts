import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/engine/backtest.ts';
import { buildConfluence } from '../src/engine/confluence.ts';
import { computeMetrics } from '../src/engine/metrics.ts';
import { allocator, DEFAULT_ALLOCATOR } from '../src/engine/strategies/allocator.ts';
import { dcaPlan, DEFAULT_DCA_PLAN, validateDcaPlan, type DcaPlanParams } from '../src/engine/strategies/dcaPlan.ts';
import { hodl } from '../src/engine/strategies/hodl.ts';
import { planPlus, DEFAULT_PLAN_PLUS } from '../src/engine/strategies/planPlus.ts';
import { DEFAULT_TRADER, trader } from '../src/engine/strategies/trader.ts';
import { DAY, HOUR } from '../src/engine/timeframe.ts';
import { sliceSeries } from '../src/engine/types.ts';
import { fixtureSeries, randomSeries, seriesFromCloses } from './helpers.ts';

const costs = { feeRate: 0.001, slippage: 0.0005 };
const linspace = (a: number, b: number, n: number) => Array.from({ length: n }, (_, k) => a + ((b - a) * k) / Math.max(1, n - 1));

/** 2000 -> dip into the 1500-1700 zone for 35 days -> rally through 4000. */
function zoneCycle(): number[] {
  return [...linspace(2000, 1680, 20), ...new Array(35).fill(0).map((_, k) => 1600 + 60 * Math.sin(k / 3)), ...linspace(1650, 4300, 60)];
}

describe('My plan (zone DCA)', () => {
  it('buys only on scheduled days inside the zone and sells everything at the target', () => {
    const s = seriesFromCloses(zoneCycle(), DAY, Date.UTC(2023, 0, 2), 0.004);
    const r = runBacktest(s, dcaPlan(DEFAULT_DCA_PLAN), { initialCash: 10_000, costs, stakingApr: 0.03 });
    const buys = r.fills.filter((f) => f.side === 'buy');
    const sells = r.fills.filter((f) => f.side === 'sell');
    expect(buys.length).toBeGreaterThanOrEqual(5);
    for (const b of buys) {
      // decided at the previous close, which must have been inside the zone, on a weekly schedule
      const decide = b.i - 1;
      expect(s.c[decide]).toBeGreaterThanOrEqual(1500);
      expect(s.c[decide]).toBeLessThanOrEqual(1700);
      expect(decide % 7).toBe(0);
      expect(b.quote).toBeCloseTo(500, 6);
    }
    expect(sells).toHaveLength(1);
    expect(sells[0].price).toBeGreaterThanOrEqual(4000);
    expect(r.final.qty).toBe(0);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].pnl).toBeGreaterThan(0);
    // profit = sold coins (bought + staked) * price - cost
    const t = r.trades[0];
    expect(t.proceeds).toBeCloseTo(sells[0].quote, 6);
    expect(r.final.stakedQtyEarned).toBeGreaterThan(0);
  });

  it('does not buy below the zone unless allowed', () => {
    const closes = [...linspace(2000, 1200, 30), ...new Array(30).fill(1200)];
    const s = seriesFromCloses(closes, DAY, Date.UTC(2023, 0, 2));
    const strict = runBacktest(s, dcaPlan(DEFAULT_DCA_PLAN), { initialCash: 10_000, costs });
    expect(strict.fills.filter((f) => s.c[f.i - 1] < 1500)).toHaveLength(0);
    const loose = runBacktest(s, dcaPlan({ ...DEFAULT_DCA_PLAN, buyBelowZone: true }), { initialCash: 10_000, costs });
    expect(loose.fills.some((f) => f.side === 'buy' && s.c[f.i - 1] < 1500)).toBe(true);
  });

  it('repeats cycles only when repeat is on', () => {
    const closes = [...zoneCycle(), ...linspace(4300, 1600, 60), ...new Array(30).fill(1620), ...linspace(1620, 4200, 40)];
    const s = seriesFromCloses(closes, DAY, Date.UTC(2023, 0, 2));
    const rep = runBacktest(s, dcaPlan(DEFAULT_DCA_PLAN), { initialCash: 10_000, costs });
    const once = runBacktest(s, dcaPlan({ ...DEFAULT_DCA_PLAN, repeat: false }), { initialCash: 10_000, costs });
    expect(rep.trades).toHaveLength(2);
    expect(once.trades).toHaveLength(1);
    expect(once.fills.filter((f) => f.side === 'buy' && f.i > once.trades[0].exitIndex)).toHaveLength(0);
  });

  it('ladders: sells half at the first target and the rest at the second', () => {
    const plan: DcaPlanParams = { ...DEFAULT_DCA_PLAN, takeProfit: [{ price: 4000, fraction: 0.5 }, { price: 4200, fraction: 1 }] };
    const s = seriesFromCloses(zoneCycle(), DAY, Date.UTC(2023, 0, 2), 0.002);
    const r = runBacktest(s, dcaPlan(plan), { initialCash: 10_000, costs: { feeRate: 0, slippage: 0 } });
    const sells = r.fills.filter((f) => f.side === 'sell');
    expect(sells).toHaveLength(2);
    expect(sells[0].qty).toBeCloseTo(sells[1].qty, 9);
    expect(sells[0].price).toBeGreaterThanOrEqual(4000);
    expect(sells[1].price).toBeGreaterThanOrEqual(4200);
    expect(r.final.qty).toBe(0);
  });

  it('adds recurring deposits and counts them as money put in, not profit', () => {
    const s = seriesFromCloses(new Array(70).fill(2500), DAY, Date.UTC(2023, 0, 2));
    const r = runBacktest(s, dcaPlan({ ...DEFAULT_DCA_PLAN, contribution: { amount: 100, everyDays: 7 } }), { initialCash: 1000, costs });
    expect(r.final.contributed).toBe(1000);
    const m = computeMetrics(r);
    expect(m.profit).toBeCloseTo(0, 9);
    expect(m.totalReturn).toBeCloseTo(0, 12);
  });

  it('validates its parameters', () => {
    expect(validateDcaPlan(DEFAULT_DCA_PLAN)).toEqual([]);
    expect(validateDcaPlan({ ...DEFAULT_DCA_PLAN, zoneLow: 1800 })).not.toEqual([]);
    expect(validateDcaPlan({ ...DEFAULT_DCA_PLAN, takeProfit: [{ price: 1600, fraction: 1 }] })).not.toEqual([]);
    expect(validateDcaPlan({ ...DEFAULT_DCA_PLAN, buyEveryDays: 0 })).not.toEqual([]);
  });

  it('reproduces the three historical ETH cycles (sold at 4000 in 2021, 2024, 2025)', () => {
    const d = fixtureSeries('eth-1d-history.json');
    const start = d.t.findIndex((t) => t >= Date.UTC(2018, 2, 1));
    const r = runBacktest(d, dcaPlan(DEFAULT_DCA_PLAN), { initialCash: 10_000, costs, startIndex: start, stakingApr: 0.03 });
    const sells = r.fills.filter((f) => f.side === 'sell').map((f) => new Date(f.time).toISOString().slice(0, 7));
    expect(sells).toEqual(['2021-05', '2024-03', '2025-08']);
    expect(r.trades.every((t) => t.pnl > 0)).toBe(true);
  });
});

describe('Plan+ (confluence timing)', () => {
  it('never buys outside the zone and never sells below cost at the target', () => {
    const d = fixtureSeries('eth-1d-history.json');
    const cf = buildConfluence(d, { baseTf: '1d', tfs: ['2d', '3d', '5d', '1w', '2w', '1M'] });
    const start = d.t.findIndex((t) => t >= Date.UTC(2018, 2, 1));
    const r = runBacktest(d, planPlus(cf, DEFAULT_DCA_PLAN, DEFAULT_PLAN_PLUS), { initialCash: 10_000, costs, startIndex: start });
    for (const f of r.fills.filter((x) => x.side === 'buy')) {
      expect(d.c[f.i - 1]).toBeGreaterThanOrEqual(1500);
      expect(d.c[f.i - 1]).toBeLessThanOrEqual(1700);
    }
    expect(r.fills.filter((x) => x.side === 'sell' && x.reason.startsWith('Target')).every((f) => f.price >= 4000)).toBe(true);
  });
});

describe('Confluence allocator', () => {
  it('ends invested in a persistent uptrend and in cash in a persistent downtrend', () => {
    const up = seriesFromCloses(linspace(0, 1, 700).map((x) => 100 * Math.exp(2.5 * x) * (1 + 0.02 * Math.sin(x * 60))), DAY);
    const down = seriesFromCloses(linspace(0, 1, 700).map((x) => 1000 * Math.exp(-2.5 * x) * (1 + 0.02 * Math.sin(x * 60))), DAY);
    const tfs = { baseTf: '1d', tfs: ['3d', '1w'] };
    const p = { ...DEFAULT_ALLOCATOR, wTrend: 1, sLow: 0, sHigh: 0.2 };
    const ru = runBacktest(up, allocator(buildConfluence(up, tfs), p), { initialCash: 10_000, costs, startIndex: 250 });
    const rd = runBacktest(down, allocator(buildConfluence(down, tfs), p), { initialCash: 10_000, costs, startIndex: 250 });
    expect((ru.final.qty * up.c[699]) / ru.final.equity).toBeGreaterThan(0.9);
    expect(rd.final.qty).toBe(0);
    expect(computeMetrics(ru).totalReturn).toBeGreaterThan(1);
  });
});

describe('Confluence trader', () => {
  it('profits when a real edge exists, and its edge gate opens', () => {
    // Engineered edge: a steady uptrend whose pullbacks always resolve upward.
    const closes: number[] = [];
    let p = 1000;
    for (let k = 0; k < 6000; k++) {
      const phase = k % 40;
      p *= phase < 30 ? 1.004 : 0.993; // 30 bars up, 10 bars pullback
      closes.push(p);
    }
    const s = seriesFromCloses(closes, HOUR, Date.UTC(2024, 0, 1), 0.001);
    const cf = buildConfluence(s, { baseTf: '1h', tfs: ['2h', '4h', '12h'] });
    const st = trader(cf, { ...DEFAULT_TRADER, shadowWindow: 30, shadowZ: 1 });
    const r = runBacktest(s, st, { initialCash: 10_000, costs, startIndex: 300 });
    const m = computeMetrics(r);
    expect(st.diag.taken).toBeGreaterThan(10);
    expect(m.totalReturn).toBeGreaterThan(0.2);
    expect(m.profitFactor).toBeGreaterThan(1.5);
  });

  it('stays mostly in cash on a random walk with fees, unlike the unfiltered version', () => {
    const s = randomSeries({ n: 8000, barMs: 15 * 60_000, seed: 99, vol: 0.004 });
    const cf = buildConfluence(s, { baseTf: '15m', tfs: ['30m', '1h', '4h'] });
    const gated = trader(cf, { ...DEFAULT_TRADER, shadowWindow: 60, shadowZ: 1.5 });
    const raw = trader(cf, { ...DEFAULT_TRADER, useEdgeFilter: false });
    const rg = runBacktest(s, gated, { initialCash: 10_000, costs, startIndex: 300 });
    const rr = runBacktest(s, raw, { initialCash: 10_000, costs, startIndex: 300 });
    expect(rg.trades.length).toBeLessThan(rr.trades.length / 3);
    expect(rg.final.equity).toBeGreaterThan(rr.final.equity);
  });

  it('respects risk limits: one position, stop below entry, risk per trade capped', () => {
    const s = fixtureSeries('eth-1h-2025H1.json');
    const cf = buildConfluence(s, { baseTf: '1h', tfs: ['2h', '4h', '12h', '1d'] });
    const r = runBacktest(s, trader(cf, { ...DEFAULT_TRADER, useEdgeFilter: false }), { initialCash: 10_000, costs, startIndex: 600 });
    expect(r.trades.length).toBeGreaterThan(5);
    let qty = 0;
    for (const f of r.fills) {
      if (f.side === 'buy') {
        expect(qty).toBe(0); // never adds to an open position
        qty += f.qty;
      } else {
        qty = Math.max(0, qty - f.qty);
      }
    }
    for (const t of r.trades) {
      expect(t.r).not.toBeNull();
      // a stop-out loses about 1R (+ slippage/fees), never much more unless the market gaps
      expect(t.r!).toBeGreaterThan(-1.6);
      expect(Math.abs(t.pnl)).toBeLessThan(0.05 * 10_000 * 4);
    }
  });
});

describe('no look-ahead: truncating the data never changes earlier decisions', () => {
  const sameFills = (a: ReturnType<typeof runBacktest>, b: ReturnType<typeof runBacktest>, upTo: number) => {
    const fa = a.fills.filter((f) => f.i <= upTo);
    const fb = b.fills.filter((f) => f.i <= upTo);
    expect(fb.length).toBe(fa.length);
    fa.forEach((f, k) => {
      expect(fb[k].i).toBe(f.i);
      expect(fb[k].side).toBe(f.side);
      expect(fb[k].price).toBeCloseTo(f.price, 9);
      expect(fb[k].qty).toBeCloseTo(f.qty, 9);
    });
    return fa.length;
  };

  it('confluence trader on real ETH 1h data', () => {
    const s = fixtureSeries('eth-1h-2025H1.json');
    const spec = { baseTf: '1h', tfs: ['2h', '4h', '12h', '1d'] };
    const run = (ser: typeof s, filt: boolean) => runBacktest(ser, trader(buildConfluence(ser, spec), { ...DEFAULT_TRADER, useEdgeFilter: filt, shadowWindow: 20, shadowZ: 0 }), { initialCash: 10_000, costs, startIndex: 600 });
    for (const filt of [false, true]) {
      const full = run(s, filt);
      let compared = 0;
      for (const k of [1500, 2600, 3500]) {
        const cut = run(sliceSeries(s, 0, k), filt);
        compared += sameFills(full, cut, k - 1);
        expect(cut.equity).toEqual(full.equity.slice(0, cut.equity.length));
      }
      // Jan-Mar 2025 was a crash (no long setups), so fills only appear in the later cuts
      if (!filt) expect(compared).toBeGreaterThan(0);
    }
  });

  it('allocator, plan and Plan+ on real ETH daily data', () => {
    const d = fixtureSeries('eth-1d-history.json');
    const spec = { baseTf: '1d', tfs: ['2d', '3d', '5d', '1w', '2w', '1M'] };
    const start = 250;
    const mk = {
      alloc: (ser: typeof d) => allocator(buildConfluence(ser, spec), DEFAULT_ALLOCATOR),
      plan: () => dcaPlan(DEFAULT_DCA_PLAN),
      planPlus: (ser: typeof d) => planPlus(buildConfluence(ser, spec), DEFAULT_DCA_PLAN, DEFAULT_PLAN_PLUS),
      hodl: () => hodl(),
    };
    for (const [name, make] of Object.entries(mk)) {
      const full = runBacktest(d, make(d), { initialCash: 10_000, costs, startIndex: start, stakingApr: 0.03 });
      for (const k of [1300, 2200, 3000]) {
        const cut = sliceSeries(d, 0, k);
        const part = runBacktest(cut, make(cut), { initialCash: 10_000, costs, startIndex: start, stakingApr: 0.03 });
        sameFills(full, part, k - 1);
        expect(part.equity.map((x) => +x.toFixed(6)), name).toEqual(full.equity.slice(0, part.equity.length).map((x) => +x.toFixed(6)));
      }
    }
  });
});
