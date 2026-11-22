import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { aggregate, alignToBase, mergeBars } from '../src/engine/aggregate.ts';
import { bucketStart, DAY, MINUTE, parseTf } from '../src/engine/timeframe.ts';
import type { KlineRow, Series } from '../src/engine/types.ts';
import { seriesFromRows, sliceSeries, validateSeries } from '../src/engine/types.ts';
import { loadFixture, randomSeries } from './helpers.ts';

interface NativeFixture {
  from: number;
  to: number;
  native: Record<string, KlineRow[]>;
  monthly2024: KlineRow[];
  daily2024: KlineRow[];
}
const fx = loadFixture<NativeFixture>('eth-native-candles.json');
const barMs: Record<string, number> = { '15m': 15 * MINUTE, '1h': 60 * MINUTE, '4h': 240 * MINUTE, '1d': DAY };

function expectSameCandles(ours: Series, theirs: KlineRow[], from: number, to: number) {
  const ourRows = ours.t
    .map((t, j) => [t, ours.o[j], ours.h[j], ours.l[j], ours.c[j], ours.v[j], ours.end[j]] as const)
    .filter((r) => r[0] >= from && r[6] <= to);
  expect(ourRows.length).toBe(theirs.length);
  ourRows.forEach((r, j) => {
    const n = theirs[j];
    expect(r[0]).toBe(n[0]);
    for (let k = 1; k <= 4; k++) expect(r[k]).toBeCloseTo(n[k], 8);
    expect(r[5]).toBeCloseTo(n[5], 3); // volume: sums of 8-decimal values
  });
}

describe('aggregation reproduces Binance native candles exactly', () => {
  const base15 = seriesFromRows(fx.native['15m'], barMs['15m']);
  it.each(['1h', '4h', '1d', '3d', '1w'])('15m -> %s', (iv) => {
    const agg = aggregate(base15, parseTf(iv));
    expectSameCandles(agg, fx.native[iv], fx.from, fx.to);
  });
  it('1h -> 4h and 1d', () => {
    const base = seriesFromRows(fx.native['1h'], barMs['1h']);
    expectSameCandles(aggregate(base, parseTf('4h')), fx.native['4h'], fx.from, fx.to);
    expectSameCandles(aggregate(base, parseTf('1d')), fx.native['1d'], fx.from, fx.to);
  });
  it('1d -> 1M over 2024 (calendar months, leap year)', () => {
    const base = seriesFromRows(fx.daily2024, DAY);
    const agg = aggregate(base, parseTf('1M'));
    expect(agg.t.length).toBe(12);
    expectSameCandles(agg, fx.monthly2024, Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1));
  });
});

describe('aggregation bookkeeping', () => {
  const base = randomSeries({ n: 3000, barMs: MINUTE, start: Date.UTC(2025, 0, 1, 0, 3), seed: 7 });

  it('matches a naive group-by for custom timeframes', () => {
    for (const id of ['7m', '45m', '2h', '1d']) {
      const tf = parseTf(id);
      const agg = aggregate(base, tf);
      validateSeries(agg, id);
      const groups = new Map<number, number[]>();
      base.t.forEach((t, i) => {
        const b = bucketStart(t, tf);
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b)!.push(i);
      });
      expect(agg.t).toEqual([...groups.keys()]);
      [...groups.values()].forEach((idx, j) => {
        expect(agg.o[j]).toBe(base.o[idx[0]]);
        expect(agg.c[j]).toBe(base.c[idx[idx.length - 1]]);
        expect(agg.h[j]).toBe(Math.max(...idx.map((i) => base.h[i])));
        expect(agg.l[j]).toBe(Math.min(...idx.map((i) => base.l[i])));
        expect(agg.v[j]).toBeCloseTo(idx.reduce((a, i) => a + base.v[i], 0), 9);
        expect(agg.firstBase[j]).toBe(idx[0]);
        expect(agg.lastBase[j]).toBe(idx[idx.length - 1]);
      });
    }
  });

  it('a bucket only becomes available once its last base bar has closed', () => {
    const agg = aggregate(base, parseTf('15m'));
    // base starts at :03, so the first bucket (:00-:15) is partial but still final at :14
    expect(agg.availAt[0]).toBe(11);
    expect(agg.availAt[1]).toBe(26);
    // the last bucket is still forming unless the data ends exactly on a boundary
    const lastEnd = base.end[base.t.length - 1];
    const finalLast = lastEnd >= agg.end[agg.end.length - 1];
    expect(Number.isFinite(agg.availAt[agg.availAt.length - 1])).toBe(finalLast);
  });

  it('gaps: a bucket missing its last bars is final when the next bar closes', () => {
    const rows: KlineRow[] = [];
    const t0 = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 60; i++) {
      if (i >= 10 && i <= 14) continue; // missing 00:10-00:14
      rows.push([t0 + i * MINUTE, 1, 2, 0.5, 1.5, 1]);
    }
    const s = seriesFromRows(rows, MINUTE);
    const agg = aggregate(s, parseTf('15m'));
    expect(agg.lastBase[0]).toBe(9);
    expect(agg.availAt[0]).toBe(10); // index 10 is the 00:15 bar
    expect(agg.availAt[1]).toBe(24); // 00:15-00:29 complete at its own last bar
  });

  it('throws on incompatible timeframes', () => {
    const h = randomSeries({ n: 50, barMs: 60 * MINUTE, seed: 3 });
    expect(() => aggregate(h, parseTf('90m'))).toThrow(/straddles/);
  });

  it('alignment never exposes an unfinished bucket (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2999 }), fc.constantFrom('3m', '7m', '15m', '1h', '4h'), (k, id) => {
        const tf = parseTf(id);
        const full = aggregate(base, tf);
        const idx = alignToBase(full, base.t.length);
        const j = idx[k];
        if (j >= 0) {
          // bucket j is final at bar k: its end is not after bar k's end
          expect(full.end[j]).toBeLessThanOrEqual(base.end[k]);
          // and it equals the same bucket aggregated from data truncated at k
          const cut = aggregate(sliceSeries(base, 0, k + 1), tf);
          expect(cut.c[j]).toBe(full.c[j]);
          expect(cut.h[j]).toBe(full.h[j]);
          expect(cut.l[j]).toBe(full.l[j]);
          expect(cut.v[j]).toBe(full.v[j]);
        }
        // the next bucket is not final yet at bar k
        if (j + 1 < full.t.length) expect(full.availAt[j + 1]).toBeGreaterThan(k);
      }),
      { numRuns: 300 },
    );
  });

  it('mergeBars de-duplicates and sorts', () => {
    const a = sliceSeries(base, 0, 100);
    const b = sliceSeries(base, 50, 150);
    const m = mergeBars(b, a);
    expect(m.t).toEqual(base.t.slice(0, 150));
    validateSeries(m);
  });
});
