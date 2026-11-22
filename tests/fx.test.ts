import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadFx } from '../src/data/fx.ts';
import { runBacktest, type Strategy } from '../src/engine/backtest.ts';
import { convertResult, parseFrankfurter, rateAt, rateFn, type FxSeries } from '../src/engine/fx.ts';
import { computeMetrics } from '../src/engine/metrics.ts';
import { projectPlan } from '../src/engine/planProjection.ts';
import { DEFAULT_SETTINGS, USD_SETTINGS, type Settings } from '../src/engine/presets.ts';
import { simulate } from '../src/engine/simulate.ts';
import { dcaPlan, DEFAULT_DCA_PLAN } from '../src/engine/strategies/dcaPlan.ts';
import { DAY } from '../src/engine/timeframe.ts';
import { fixtureSeries, loadFixture, seriesFromCloses } from './helpers.ts';

const php = parseFrankfurter(loadFixture('usdphp.json'), 'PHP');
const D = (s: string) => Date.parse(`${s}T00:00:00Z`);
const costs = { feeRate: 0.001, slippage: 0.0005 };
const flat = (k: number): FxSeries => ({ currency: 'PHP', t: [D('2010-01-01')], r: [k] });

describe('exchange rates', () => {
  it('parses the real USD/PHP history (ECB via Frankfurter)', () => {
    expect(php.t.length).toBe(2383);
    expect(php.r.every((v) => v > 40 && v < 70)).toBe(true);
    expect(rateAt(php, D('2018-01-02'))).toBeCloseTo(49.84, 6);
    expect(rateAt(php, D('2026-11-20'))).toBeCloseTo(63.777, 6);
  });

  it('carries the last rate over weekends and holidays, and the first rate before the series', () => {
    const fri = D('2024-03-08');
    expect(php.t).toContain(fri);
    expect(rateAt(php, D('2024-03-09'))).toBe(rateAt(php, fri)); // Saturday
    expect(rateAt(php, D('2024-03-10') + 23 * 3600e3)).toBe(rateAt(php, fri)); // Sunday night
    expect(rateAt(php, D('2001-01-01'))).toBe(php.r[0]);
    expect(rateAt(php, D('2030-01-01'))).toBe(php.r[php.r.length - 1]);
  });

  it('binary search agrees with a linear scan (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: D('2017-01-01'), max: D('2027-06-01') }), (t) => {
        let k = 0;
        for (let i = 0; i < php.t.length; i++) if (php.t[i] <= t) k = i;
        expect(rateAt(php, t)).toBe(t < php.t[0] ? php.r[0] : php.r[k]);
      }),
      { numRuns: 500 },
    );
  });

  it('rejects malformed responses', () => {
    expect(() => parseFrankfurter({}, 'PHP')).toThrow();
    expect(() => parseFrankfurter({ rates: {} }, 'PHP')).toThrow();
  });
});

describe('converting results to pesos', () => {
  const d = fixtureSeries('eth-1d-history.json');
  const start = d.t.findIndex((t) => t >= D('2018-05-01'));

  it('a constant rate scales every amount and leaves returns unchanged', () => {
    const k = 50;
    const raw = runBacktest(d, dcaPlan(DEFAULT_DCA_PLAN), { initialCash: 10_000, costs, startIndex: start, stakingApr: 0.03 });
    const conv = convertResult(raw, rateFn(flat(k)));
    raw.equity.forEach((e, i) => expect(conv.equity[i]).toBeCloseTo(e * k, 6));
    expect(conv.initialCash).toBeCloseTo(10_000 * k, 6);
    expect(conv.final.equity).toBeCloseTo(raw.final.equity * k, 6);
    expect(conv.final.feesPaid).toBeCloseTo(raw.final.feesPaid * k, 6);
    raw.trades.forEach((t, i) => {
      expect(conv.trades[i].pnl).toBeCloseTo(t.pnl * k, 5);
      expect(conv.trades[i].pnlPct).toBeCloseTo(t.pnlPct, 12);
      expect(conv.trades[i].avgSellFill).toBe(t.avgSellFill); // market prices stay in USDT
    });
    const mu = computeMetrics(raw);
    const mp = computeMetrics(conv);
    expect(mp.totalReturn).toBeCloseTo(mu.totalReturn, 10);
    expect(mp.cagr).toBeCloseTo(mu.cagr, 10);
    expect(mp.maxDrawdown).toBeCloseTo(mu.maxDrawdown, 10);
  });

  it('idle dollars gain or lose exactly the exchange-rate move in pesos', () => {
    const s = seriesFromCloses(new Array(30).fill(100), DAY, D('2024-01-01'));
    const idle: Strategy = { name: 'idle', onBar: () => {} };
    const fx: FxSeries = { currency: 'PHP', t: [D('2024-01-01'), D('2024-01-16')], r: [50, 60] };
    const conv = convertResult(runBacktest(s, idle, { initialCash: 1000, costs }), rateFn(fx));
    expect(conv.initialCash).toBe(50_000);
    expect(conv.final.equity).toBe(60_000);
    expect(computeMetrics(conv).totalReturn).toBeCloseTo(0.2, 12);
  });

  it('each fill is valued at the rate of its own day', () => {
    const closes = [...new Array(10).fill(1600), ...new Array(10).fill(4100)];
    const s = seriesFromCloses(closes, DAY, D('2024-01-01'), 0.001);
    const fx: FxSeries = { currency: 'PHP', t: [D('2024-01-01'), D('2024-01-11')], r: [50, 55] };
    const raw = runBacktest(s, dcaPlan({ ...DEFAULT_DCA_PLAN, buyEveryDays: 1 }), { initialCash: 2000, costs });
    const conv = convertResult(raw, rateFn(fx));
    const t = conv.trades[0];
    const buys = raw.fills.filter((f) => f.side === 'buy');
    const sells = raw.fills.filter((f) => f.side === 'sell');
    expect(t.cost).toBeCloseTo(buys.reduce((a, f) => a + f.quote * (f.time < D('2024-01-11') ? 50 : 55), 0), 6);
    expect(t.proceeds).toBeCloseTo(sells.reduce((a, f) => a + f.quote * 55, 0), 6);
    expect(t.pnl).toBeCloseTo(t.proceeds - t.cost, 6);
  });
});

describe('the plan with peso amounts', () => {
  it('converts each peso buy at that day\'s rate', () => {
    const s = seriesFromCloses(new Array(40).fill(1600), DAY, D('2024-01-01'));
    const fx: FxSeries = { currency: 'PHP', t: [D('2024-01-01'), D('2024-01-20')], r: [50, 62.5] };
    const r = runBacktest(s, dcaPlan({ ...DEFAULT_DCA_PLAN, buyAmount: 25_000 }, undefined, rateFn(fx)), { initialCash: 100_000, costs });
    const buys = r.fills.filter((f) => f.side === 'buy');
    expect(buys.length).toBeGreaterThan(3);
    for (const b of buys) expect(b.quote).toBeCloseTo(b.time - DAY < D('2024-01-20') ? 500 : 400, 9);
  });

  it('pesos at a constant rate give exactly the dollar results, scaled', () => {
    const d = fixtureSeries('eth-1d-history.json');
    const k = 50;
    const pesos: Settings = { ...DEFAULT_SETTINGS, initialCash: USD_SETTINGS.initialCash * k, plan: { ...USD_SETTINGS.plan, buyAmount: USD_SETTINGS.plan.buyAmount * k } };
    const a = simulate('ETHUSDT', 'long', d, USD_SETTINGS);
    const b = simulate('ETHUSDT', 'long', d, pesos, { fx: flat(k) });
    expect(b.currency).toBe('PHP');
    expect(b.fxNow).toBe(k);
    expect(b.runs.map((r) => r.id)).toEqual(a.runs.map((r) => r.id));
    a.runs.forEach((ra, i) => {
      const rb = b.runs[i];
      expect(rb.raw.fills.length).toBe(ra.raw.fills.length);
      expect(rb.metrics.totalReturn).toBeCloseTo(ra.metrics.totalReturn, 9);
      expect(rb.metrics.finalEquity).toBeCloseTo(ra.metrics.finalEquity * k, 4);
    });
    expect(b.decision).toEqual(a.decision);
    expect(b.plan!.cash).toBeCloseTo(a.plan!.cash * k, 4);
    expect(b.plan!.avgCostLocal).toBeCloseTo(a.plan!.avgCost! * k, 4);
  });

  it('with real rates, peso results include the peso\'s fall since 2018', () => {
    const d = fixtureSeries('eth-1d-history.json');
    const usd = simulate('ETHUSDT', 'long', d, USD_SETTINGS);
    const pesos = simulate('ETHUSDT', 'long', d, DEFAULT_SETTINGS, { fx: php });
    const hodlUsd = usd.runs.find((r) => r.id === 'hodl')!.metrics;
    const hodlPhp = pesos.runs.find((r) => r.id === 'hodl')!.metrics;
    // buy & hold has no money amounts besides the start: the peso return is the dollar
    // return times the exchange-rate move over the same dates
    const fxMove = rateAt(php, hodlPhp.endTime) / rateAt(php, hodlPhp.startTime);
    expect(1 + hodlPhp.totalReturn).toBeCloseTo((1 + hodlUsd.totalReturn) * fxMove, 6);
    expect(pesos.plan!.cash).toBeGreaterThan(0);
    expect(Number.isFinite(pesos.runs[0].metrics.cagr)).toBe(true);
  });

  it('refuses to show pesos without exchange rates', () => {
    const d = fixtureSeries('eth-1d-history.json');
    expect(() => simulate('ETHUSDT', 'long', d, DEFAULT_SETTINGS)).toThrow(/Exchange rates/);
  });

  it('projects in pesos at today\'s rate', () => {
    const d = fixtureSeries('eth-1d-history.json');
    const k = 50;
    const pesos: Settings = { ...DEFAULT_SETTINGS, initialCash: 500_000, plan: { ...USD_SETTINGS.plan, buyAmount: 25_000 } };
    const a = projectPlan(d, USD_SETTINGS, { startIndex: 250, days: 180, paths: 20, seed: 3 });
    const b = projectPlan(d, pesos, { startIndex: 250, days: 180, paths: 20, seed: 3, fx: flat(k) });
    expect(b.planNow).toBeCloseTo(a.planNow * k, 4);
    expect(b.planValue.p50).toBeCloseTo(a.planValue.p50 * k, 3);
    expect(b.hitBy).toEqual(a.hitBy);
    expect(b.currency).toBe('PHP');
  });
});

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('loading exchange rates in the app', () => {
  const series = loadFixture<{ rates: Record<string, { PHP: number }> }>('usdphp.json');
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const bad = { ok: false, status: 503, json: async () => ({}) } as unknown as Response;

  it('downloads the history once a day and caches it', async () => {
    const storage = new MemStorage() as unknown as Storage;
    const calls: string[] = [];
    const fetch = async (u: string) => {
      calls.push(u);
      return ok(series);
    };
    const a = await loadFx('PHP', { fetch, storage, now: D('2026-11-21') });
    expect(a.source).toBe('history');
    expect(a.fx.t.length).toBe(2383);
    expect(calls[0]).toContain('api.frankfurter.dev/v1/2017-08-01..?base=USD&symbols=PHP');
    const b = await loadFx('PHP', { fetch, storage, now: D('2026-11-21') + 5 * 3600e3 });
    expect(b.source).toBe('cache');
    expect(calls).toHaveLength(1);
    // next day: only the new days are requested, then merged
    const c = await loadFx('PHP', { fetch: async (u: string) => (calls.push(u), ok({ rates: { '2026-11-20': { PHP: 63.777 }, '2026-11-23': { PHP: 64.1 } } })), storage, now: D('2026-11-23') + 3600e3 });
    expect(calls[1]).toContain('/v1/2026-11-20..');
    expect(c.fx.t.length).toBe(2384);
    expect(c.fx.r[c.fx.r.length - 1]).toBe(64.1);
  });

  it('falls back to the cache, then to today\'s rate only, then fails clearly', async () => {
    const storage = new MemStorage() as unknown as Storage;
    await loadFx('PHP', { fetch: async () => ok(series), storage, now: D('2026-11-21') });
    const cached = await loadFx('PHP', { fetch: async () => bad, storage, now: D('2026-11-22') });
    expect(cached.source).toBe('cache');
    const latest = await loadFx('PHP', {
      fetch: async (u) => (u.includes('frankfurter') ? bad : ok({ rates: { PHP: 63.5 } })),
      storage: new MemStorage() as unknown as Storage,
      now: D('2026-11-22'),
    });
    expect(latest.source).toBe('latest-only');
    expect(latest.approximate).toBe(true);
    expect(latest.fx.r).toEqual([63.5]);
    await expect(loadFx('PHP', { fetch: async () => bad, storage: new MemStorage() as unknown as Storage })).rejects.toThrow(/exchange rate/);
  });

  it('needs nothing for US dollars', async () => {
    const r = await loadFx('USD', { fetch: async () => bad });
    expect(r.source).toBe('identity');
    expect(rateFn(r.fx)(Date.now())).toBe(1);
  });
});
