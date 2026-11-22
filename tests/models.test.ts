import { describe, expect, it } from 'vitest';
import type { BacktestResult } from '../src/engine/backtest.ts';
import { choleskySolve, EdgeEstimator, expectedR, LogisticModel, tripleBarrier } from '../src/engine/edge.ts';
import { computeMetrics } from '../src/engine/metrics.ts';
import { projectPlan } from '../src/engine/planProjection.ts';
import { MODE_ORDER, USD_SETTINGS } from '../src/engine/presets.ts';
import { bootstrapPricePaths, bootstrapProjection, compound, yearsToMultiple } from '../src/engine/projection.ts';
import { Rng } from '../src/engine/rng.ts';
import { simulate } from '../src/engine/simulate.ts';
import { DAY, HOUR } from '../src/engine/timeframe.ts';
import type { KlineRow } from '../src/engine/types.ts';
import { seriesFromRows, validateSeries } from '../src/engine/types.ts';
import { fixtureSeries } from './helpers.ts';

describe('triple-barrier labels', () => {
  const mk = (rows: [number, number, number, number][]) =>
    seriesFromRows(rows.map((r, i) => [i * HOUR, r[0], r[1], r[2], r[3], 1] as KlineRow), HOUR);
  it('target first, stop first, both in one bar (stop wins), timeout', () => {
    const base: [number, number, number, number] = [100, 100, 100, 100];
    expect(tripleBarrier(mk([base, [100, 101, 99, 100], [100, 105, 99.5, 104]]), 0, 2, 4, 5)).toEqual({ win: 1, r: 2, resolveIdx: 2 });
    expect(tripleBarrier(mk([base, [100, 101, 97, 98]]), 0, 2, 4, 5)).toEqual({ win: 0, r: -1, resolveIdx: 1 });
    expect(tripleBarrier(mk([base, [100, 105, 97, 100]]), 0, 2, 4, 5).win).toBe(0);
    const t = tripleBarrier(mk([base, [100, 101, 99, 100], [100, 101, 99, 101]]), 0, 2, 4, 2);
    expect(t).toEqual({ win: 0, r: 0.5, resolveIdx: 2 });
    // not enough future data: unresolved
    expect(tripleBarrier(mk([base, [100, 101, 99, 100]]), 0, 2, 4, 5).resolveIdx).toBe(Infinity);
  });
  it('gap through the stop is scored at the open', () => {
    const s = mk([[100, 100, 100, 100], [100, 101, 99, 100], [95, 96, 94, 95]]);
    const lab = tripleBarrier(s, 0, 2, 4, 5);
    expect(lab.win).toBe(0);
    expect(lab.r).toBeCloseTo(-2.5, 12);
  });
});

describe('logistic model and edge estimator', () => {
  it('cholesky solves a known system', () => {
    const A = Float64Array.from([4, 2, 2, 3]);
    const x = choleskySolve(A, Float64Array.from([2, 1]), 2);
    expect(4 * x[0] + 2 * x[1]).toBeCloseTo(2, 12);
    expect(2 * x[0] + 3 * x[1]).toBeCloseTo(1, 12);
  });
  it('recovers the direction of a known relationship and is calibrated', () => {
    const rng = new Rng(5);
    const X: number[][] = [];
    const y: number[] = [];
    for (let k = 0; k < 4000; k++) {
      const a = rng.normal();
      const b = rng.normal();
      const p = 1 / (1 + Math.exp(-(0.5 + 1.5 * a - 1.0 * b)));
      X.push([a, b, rng.normal()]);
      y.push(rng.next() < p ? 1 : 0);
    }
    const m = new LogisticModel().fit(X, y, 1);
    expect(m.w[0]).toBeGreaterThan(1.2);
    expect(m.w[1]).toBeLessThan(-0.7);
    expect(Math.abs(m.w[2])).toBeLessThan(0.15);
    const mean = X.reduce((acc, x) => acc + m.predict(x), 0) / X.length;
    expect(mean).toBeCloseTo(y.reduce((a, b) => a + b, 0) / y.length, 2);
  });
  it('never learns from an outcome before it is known', () => {
    const e = new EdgeEstimator({ minSamples: 1, retrainEvery: 1 });
    e.add([1], { win: 1, r: 2, resolveIdx: 50 });
    e.advance(49);
    expect(e.n).toBe(0);
    expect(e.estimate([1]).p).toBeCloseTo(2 / 5, 12); // prior only
    e.advance(50);
    expect(e.n).toBe(1);
    e.add([0], { win: 0, r: -1, resolveIdx: Infinity });
    e.advance(1e9);
    expect(e.n).toBe(1); // unresolved labels are never used
  });
  it('expected value accounts for costs', () => {
    expect(expectedR(0.5, 2, 0)).toBeCloseTo(0.5, 12);
    expect(expectedR(1 / 3, 2, 0)).toBeCloseTo(0, 12);
    expect(expectedR(0.4, 2, 0.3)).toBeCloseTo(-0.1, 12);
  });
});

function fakeResult(equity: number[], flows?: number[]): BacktestResult {
  const times = equity.map((_, k) => Date.UTC(2024, 0, 1) + k * DAY);
  return {
    strategy: 'x', startIndex: 0, endIndex: equity.length, times, equity, flows: flows ?? equity.map(() => 0), qty: equity.map(() => 1),
    fills: [], trades: [], openTrade: null, notes: [], initialCash: equity[0], pending: { stop: null, limits: [], market: [] },
    final: { cash: 0, qty: 1, feesPaid: 0, stakedQtyEarned: 0, stakingValueEarned: 0, contributed: (flows ?? []).reduce((a, b) => a + b, 0), equity: equity[equity.length - 1], price: equity[equity.length - 1] },
  };
}

describe('metrics', () => {
  it('CAGR, drawdown and Sharpe on known curves', () => {
    const grow = Array.from({ length: 366 }, (_, k) => 100 * 1.001 ** k);
    const m = computeMetrics({ ...fakeResult(grow), initialCash: 100 });
    // 366 bars = 366 days of returns (day 0 runs from its open to its close, flat here)
    expect(m.daily).toHaveLength(366);
    expect(m.cagr).toBeCloseTo((1.001 ** 365) ** (365 / 366) - 1, 9);
    expect(m.sharpe).toBeGreaterThan(10); // almost no variance
    expect(m.maxDrawdown).toBe(0);
    const dd = computeMetrics({ ...fakeResult([100, 120, 60, 90, 130]), initialCash: 100 });
    expect(dd.maxDrawdown).toBeCloseTo(-0.5, 12);
    expect(dd.totalReturn).toBeCloseTo(0.3, 12);
  });
  it('deposits are not counted as returns', () => {
    const m = computeMetrics({ ...fakeResult([100, 200, 200], [0, 100, 0]), initialCash: 100 });
    expect(m.daily[1]).toBeCloseTo(0, 12);
    expect(m.totalReturn).toBeCloseTo(0, 12);
    expect(m.profit).toBeCloseTo(0, 12);
  });
});

describe('projections', () => {
  it('compound growth and doubling time', () => {
    expect(compound(1000, 0.1, 2)).toBeCloseTo(1210, 9);
    expect(yearsToMultiple(0.1, 2)).toBeCloseTo(Math.log(2) / Math.log(1.1), 12);
    expect(yearsToMultiple(-0.1)).toBe(Infinity);
  });
  it('bootstrap of a constant return is deterministic', () => {
    const bands = bootstrapProjection(new Array(500).fill(0.001), 1000, [365, 30], { paths: 200, seed: 3 });
    expect(bands[0].days).toBe(30);
    expect(bands[1].p50).toBeCloseTo(1000 * 1.001 ** 365, 6);
    expect(bands[1].p5).toBeCloseTo(bands[1].p95, 6);
    expect(bands[1].probLoss).toBe(0);
  });
  it('zero-drift bootstrap is centred on the start value (in log terms)', () => {
    const rng = new Rng(9);
    const daily = Array.from({ length: 2000 }, () => 0.002 + 0.03 * rng.normal());
    const [b] = bootstrapProjection(daily, 1000, [365], { paths: 3000, seed: 4, demean: true });
    expect(b.p50).toBeGreaterThan(850);
    expect(b.p50).toBeLessThan(1150);
    const [h] = bootstrapProjection(daily, 1000, [365], { paths: 3000, seed: 4 });
    expect(h.p50).toBeGreaterThan(b.p50);
  });
  it('synthetic price paths are valid candles that continue the history', () => {
    const d = fixtureSeries('eth-1d-history.json');
    const paths = bootstrapPricePaths(d, { paths: 5, days: 400, seed: 1 });
    for (const p of paths) {
      validateSeries(p);
      expect(p.t[0]).toBe(d.t[d.t.length - 1] + DAY);
      expect(p.o[0] / d.c[d.c.length - 1]).toBeGreaterThan(0.7);
      expect(p.o[0] / d.c[d.c.length - 1]).toBeLessThan(1.3);
    }
    const again = bootstrapPricePaths(d, { paths: 5, days: 400, seed: 1 });
    expect(again[3].c).toEqual(paths[3].c);
  });
  it('plan projection runs the plan forward from its real current state', () => {
    const d = fixtureSeries('eth-1d-history.json');
    const pj = projectPlan(d, USD_SETTINGS, { startIndex: 250, days: 365, paths: 60, seed: 8 });
    expect(pj.hitBy.map((h) => h.days)).toEqual([90, 180, 365]);
    for (let k = 1; k < pj.hitBy.length; k++) expect(pj.hitBy[k].prob).toBeGreaterThanOrEqual(pj.hitBy[k - 1].prob);
    expect(pj.planValue.p10).toBeLessThanOrEqual(pj.planValue.p50);
    expect(pj.planValue.p50).toBeLessThanOrEqual(pj.planValue.p90);
    expect(pj.pricePaths.p50).toHaveLength(365);
    expect(pj.planNow).toBeGreaterThan(0);
  });
});

describe('simulate() on real data for every mode', () => {
  it.each(MODE_ORDER)('%s mode returns finite metrics and a decision', (mode) => {
    const s = mode === 'long' ? fixtureSeries('eth-1d-history.json') : fixtureSeries('eth-1h-2025H1.json');
    // the 1h fixture stands in for every intraday mode, with timeframes it can build
    const settings = mode === 'long' ? USD_SETTINGS : { ...USD_SETTINGS, customTfs: { [mode]: ['2h', '4h', '12h', '1d'] } };
    const base = mode === 'long' ? s : s;
    const res = simulate('ETHUSDT', mode, base, mode === 'long' ? settings : settings, mode === 'long' ? {} : { startIndex: 700 });
    expect(['BUY', 'SELL', 'HOLD', 'WAIT']).toContain(res.decision.action);
    expect(res.decision.headline.length).toBeGreaterThan(5);
    for (const run of res.runs) {
      for (const [k, v] of Object.entries(run.metrics)) {
        if (typeof v === 'number') expect(Number.isNaN(v), `${run.id}.${k}`).toBe(false);
      }
      expect(run.result.equity.every(Number.isFinite)).toBe(true);
    }
    expect(res.snapshot.perTf.length).toBeGreaterThan(1);
  });
});
