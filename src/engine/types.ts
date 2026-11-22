/**
 * Core data types shared by the engine, the data layer and the UI.
 * Everything in src/engine is pure TypeScript with no DOM or network access,
 * so the exact same code runs in the app, in tests and in research scripts.
 */

/** OHLCV bars stored as parallel arrays (struct of arrays) for speed. */
export interface Series {
  /** Bar open time, ms since epoch (UTC). Strictly increasing. */
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  /** Exclusive bar end time in ms (open time of the next slot). */
  end: number[];
}

/** Compact kline row: [openTime, open, high, low, close, volume]. */
export type KlineRow = [number, number, number, number, number, number];

export function emptySeries(): Series {
  return { t: [], o: [], h: [], l: [], c: [], v: [], end: [] };
}

export function seriesLength(s: Series): number {
  return s.t.length;
}

/** Build a series from compact rows, given the nominal bar length in ms. */
export function seriesFromRows(rows: KlineRow[], barMs: number): Series {
  const s = emptySeries();
  for (const r of rows) {
    s.t.push(r[0]);
    s.o.push(r[1]);
    s.h.push(r[2]);
    s.l.push(r[3]);
    s.c.push(r[4]);
    s.v.push(r[5]);
    s.end.push(r[0] + barMs);
  }
  return s;
}

/** Copy of the first `n` bars. Used by look-ahead tests and by live replays. */
export function sliceSeries(s: Series, from: number, to: number): Series {
  return {
    t: s.t.slice(from, to),
    o: s.o.slice(from, to),
    h: s.h.slice(from, to),
    l: s.l.slice(from, to),
    c: s.c.slice(from, to),
    v: s.v.slice(from, to),
    end: s.end.slice(from, to),
  };
}

/** Throws if the series is malformed (unsorted, non-finite, inverted bars). */
export function validateSeries(s: Series, label = 'series'): void {
  const n = s.t.length;
  for (const k of ['o', 'h', 'l', 'c', 'v', 'end'] as const) {
    if (s[k].length !== n) throw new Error(`${label}: column ${k} has length ${s[k].length}, expected ${n}`);
  }
  for (let i = 0; i < n; i++) {
    const { o, h, l, c, v } = { o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], v: s.v[i] };
    if (![o, h, l, c, v, s.t[i], s.end[i]].every(Number.isFinite)) throw new Error(`${label}: non-finite value at bar ${i}`);
    if (h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9 || h < l) throw new Error(`${label}: inconsistent OHLC at bar ${i}`);
    if (v < 0) throw new Error(`${label}: negative volume at bar ${i}`);
    if (s.end[i] <= s.t[i]) throw new Error(`${label}: bar ${i} ends before it starts`);
    if (i > 0 && s.t[i] < s.end[i - 1]) throw new Error(`${label}: bar ${i} overlaps or is out of order`);
  }
}
