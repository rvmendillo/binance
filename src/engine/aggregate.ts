import { bucketEnd, bucketStart, type Timeframe } from './timeframe.ts';
import type { Series } from './types.ts';

/** A higher-timeframe series built from base bars, with the bookkeeping needed
 * to use it without look-ahead. */
export interface Aggregated extends Series {
  tf: Timeframe;
  /** Index of the first and last base bar inside each bucket. */
  firstBase: number[];
  lastBase: number[];
  /**
   * Index of the base bar at whose close this bucket is final. A bucket is final
   * once a base bar ending at or after the bucket end has closed. Infinity while
   * the bucket is still forming.
   */
  availAt: number[];
}

/**
 * Resample `base` into `tf` buckets (open = first open, high = max, low = min,
 * close = last close, volume = sum). Gaps in the base data are tolerated.
 * Throws if a base bar straddles a bucket boundary (incompatible timeframes).
 */
export function aggregate(base: Series, tf: Timeframe): Aggregated {
  const out: Aggregated = {
    tf, t: [], o: [], h: [], l: [], c: [], v: [], end: [], firstBase: [], lastBase: [], availAt: [],
  };
  const n = base.t.length;
  let cur = -1;
  let curStart = Number.NaN;
  for (let i = 0; i < n; i++) {
    const b = bucketStart(base.t[i], tf);
    if (bucketStart(base.end[i] - 1, tf) !== b) {
      throw new Error(`Base bar at ${new Date(base.t[i]).toISOString()} straddles a ${tf.id} bucket; choose a compatible timeframe`);
    }
    if (b !== curStart) {
      cur++;
      curStart = b;
      out.t.push(b);
      out.o.push(base.o[i]);
      out.h.push(base.h[i]);
      out.l.push(base.l[i]);
      out.c.push(base.c[i]);
      out.v.push(base.v[i]);
      out.end.push(bucketEnd(b, tf));
      out.firstBase.push(i);
      out.lastBase.push(i);
      out.availAt.push(Infinity);
    } else {
      if (base.h[i] > out.h[cur]) out.h[cur] = base.h[i];
      if (base.l[i] < out.l[cur]) out.l[cur] = base.l[i];
      out.c[cur] = base.c[i];
      out.v[cur] += base.v[i];
      out.lastBase[cur] = i;
    }
  }
  for (let j = 0; j < out.t.length; j++) {
    const last = out.lastBase[j];
    if (base.end[last] >= out.end[j]) out.availAt[j] = last;
    else if (last + 1 < n) out.availAt[j] = last + 1; // gap at the bucket end: final once the next bar closes
    else out.availAt[j] = Infinity;
  }
  return out;
}

/**
 * For every base bar i, the index of the most recent bucket that is final at the
 * close of bar i (or -1). Using only these buckets guarantees no look-ahead.
 */
export function alignToBase(agg: Aggregated, baseLength: number): Int32Array {
  const idx = new Int32Array(baseLength).fill(-1);
  let j = -1;
  for (let i = 0; i < baseLength; i++) {
    while (j + 1 < agg.availAt.length && agg.availAt[j + 1] <= i) j++;
    idx[i] = j;
  }
  return idx;
}

/** Merge rows that arrive out of order or duplicated into a clean series. */
export function mergeBars(a: Series, b: Series): Series {
  const map = new Map<number, number[]>();
  const put = (s: Series) => {
    for (let i = 0; i < s.t.length; i++) map.set(s.t[i], [s.o[i], s.h[i], s.l[i], s.c[i], s.v[i], s.end[i]]);
  };
  put(a);
  put(b);
  const keys = [...map.keys()].sort((x, y) => x - y);
  const out: Series = { t: [], o: [], h: [], l: [], c: [], v: [], end: [] };
  for (const k of keys) {
    const r = map.get(k)!;
    out.t.push(k);
    out.o.push(r[0]);
    out.h.push(r[1]);
    out.l.push(r[2]);
    out.c.push(r[3]);
    out.v.push(r[4]);
    out.end.push(r[5]);
  }
  return out;
}
