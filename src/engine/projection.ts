/**
 * Projections from realised performance.
 *  - compound(): straight-line projection at the realised growth rate (CAGR)
 *  - bootstrapProjection(): Monte Carlo with block-bootstrapped daily returns, which
 *    keeps volatility clustering; gives percentile bands instead of one number
 *  - bootstrapPricePaths(): synthetic future OHLC paths built from blocks of real
 *    daily candles, used to run a strategy forward ("past + simulated future")
 */
import { Rng } from './rng.ts';
import { DAY } from './timeframe.ts';
import type { Series } from './types.ts';

export function compound(start: number, cagr: number, years: number): number {
  return start * (1 + cagr) ** years;
}

/** Years needed to multiply capital by `mult` at a constant growth rate (Infinity if never). */
export function yearsToMultiple(cagr: number, mult = 2): number {
  if (!(cagr > 0)) return Infinity;
  return Math.log(mult) / Math.log(1 + cagr);
}

export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface ProjectionBand {
  days: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
  probLoss: number;
  probDouble: number;
}

export interface BootstrapOptions {
  paths?: number;
  block?: number;
  seed?: number;
  /** Remove the historical average return (zero-drift scenario). */
  demean?: boolean;
}

export function bootstrapProjection(daily: number[], start: number, horizonsIn: number[], opts: BootstrapOptions = {}): ProjectionBand[] {
  const horizons = [...new Set(horizonsIn.map((h) => Math.max(1, Math.round(h))))].sort((a, b) => a - b);
  const paths = opts.paths ?? 2000;
  const block = Math.max(1, Math.min(opts.block ?? 20, daily.length));
  const rng = new Rng(opts.seed ?? 7);
  const maxH = Math.max(...horizons);
  const logs = daily.map((r) => Math.log(Math.max(1e-9, 1 + r)));
  const mu = opts.demean ? logs.reduce((a, b) => a + b, 0) / Math.max(1, logs.length) : 0;
  const at: number[][] = horizons.map(() => []);
  if (!daily.length) return horizons.map((days) => ({ days, p5: start, p25: start, p50: start, p75: start, p95: start, mean: start, probLoss: 0, probDouble: 0 }));
  for (let p = 0; p < paths; p++) {
    let lv = 0;
    let d = 0;
    let h = 0;
    while (d < maxH) {
      const s0 = rng.int(daily.length - block + 1);
      for (let k = 0; k < block && d < maxH; k++, d++) {
        lv += logs[s0 + k] - mu;
        while (h < horizons.length && horizons[h] === d + 1) {
          at[h].push(start * Math.exp(lv));
          h++;
        }
      }
    }
  }
  return horizons.map((days, k) => {
    const v = at[k].sort((a, b) => a - b);
    return {
      days,
      p5: percentile(v, 0.05),
      p25: percentile(v, 0.25),
      p50: percentile(v, 0.5),
      p75: percentile(v, 0.75),
      p95: percentile(v, 0.95),
      mean: v.reduce((a, b) => a + b, 0) / v.length,
      probLoss: v.filter((x) => x < start).length / v.length,
      probDouble: v.filter((x) => x >= 2 * start).length / v.length,
    };
  });
}

/**
 * Synthetic daily candles continuing from the last close of `daily`, assembled from
 * random blocks of real days (each day's OHLC relative to the previous close).
 */
export function bootstrapPricePaths(
  daily: Series,
  opts: { paths: number; days: number; block?: number; seed?: number; demean?: boolean; fromIndex?: number },
): Series[] {
  const from = Math.max(1, opts.fromIndex ?? 1);
  const rel: [number, number, number, number, number][] = [];
  for (let k = from; k < daily.c.length; k++) {
    const pc = daily.c[k - 1];
    rel.push([daily.o[k] / pc, daily.h[k] / pc, daily.l[k] / pc, daily.c[k] / pc, daily.v[k]]);
  }
  if (!rel.length) throw new Error('Not enough history to build price paths');
  const mu = opts.demean ? rel.reduce((a, r) => a + Math.log(r[3]), 0) / rel.length : 0;
  const adj = Math.exp(-mu);
  const block = Math.max(1, Math.min(opts.block ?? 30, rel.length));
  const rng = new Rng(opts.seed ?? 11);
  const lastT = daily.t[daily.t.length - 1];
  const lastC = daily.c[daily.c.length - 1];
  const out: Series[] = [];
  for (let p = 0; p < opts.paths; p++) {
    const s: Series = { t: [], o: [], h: [], l: [], c: [], v: [], end: [] };
    let price = lastC;
    let d = 0;
    while (d < opts.days) {
      const s0 = rng.int(rel.length - block + 1);
      for (let k = 0; k < block && d < opts.days; k++, d++) {
        const [ro, rh, rl, rc, vol] = rel[s0 + k];
        const t = lastT + (d + 1) * DAY;
        s.t.push(t);
        s.o.push(price * ro * adj);
        s.h.push(price * rh * adj);
        s.l.push(price * rl * adj);
        s.c.push(price * rc * adj);
        s.v.push(vol);
        s.end.push(t + DAY);
        price = price * rc * adj;
      }
    }
    out.push(s);
  }
  return out;
}

/** Concatenate a real history with a synthetic continuation (times must follow on). */
export function concatSeries(a: Series, b: Series): Series {
  return {
    t: a.t.concat(b.t),
    o: a.o.concat(b.o),
    h: a.h.concat(b.h),
    l: a.l.concat(b.l),
    c: a.c.concat(b.c),
    v: a.v.concat(b.v),
    end: a.end.concat(b.end),
  };
}

/** First day on which the high reaches `price`, or -1. */
export function firstTouch(s: Series, price: number, from = 0): number {
  for (let k = from; k < s.h.length; k++) if (s.h[k] >= price) return k;
  return -1;
}
