import { readFileSync } from 'node:fs';
import { Rng } from '../src/engine/rng.ts';
import type { KlineRow, Series } from '../src/engine/types.ts';
import { seriesFromRows } from '../src/engine/types.ts';

/** Random-walk OHLCV bars (geometric), reproducible from a seed. */
export function randomSeries(opts: {
  n: number;
  barMs: number;
  start?: number;
  price?: number;
  vol?: number;
  drift?: number;
  seed?: number;
}): Series {
  const rng = new Rng(opts.seed ?? 42);
  const rows: KlineRow[] = [];
  let p = opts.price ?? 2000;
  const vol = opts.vol ?? 0.004;
  const start = opts.start ?? Date.UTC(2024, 0, 1);
  for (let i = 0; i < opts.n; i++) {
    const o = p;
    const r = (opts.drift ?? 0) + vol * rng.normal();
    const c = o * Math.exp(r);
    const hi = Math.max(o, c) * (1 + Math.abs(rng.normal()) * vol * 0.5);
    const lo = Math.min(o, c) * (1 - Math.abs(rng.normal()) * vol * 0.5);
    rows.push([start + i * opts.barMs, o, hi, lo, c, 10 + rng.next() * 100]);
    p = c;
  }
  return seriesFromRows(rows, opts.barMs);
}

/** Series following an exact list of closes (open = previous close). */
export function seriesFromCloses(closes: number[], barMs: number, start = Date.UTC(2024, 0, 1), spread = 0.002): Series {
  const rows: KlineRow[] = closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return [start + i * barMs, o, Math.max(o, c) * (1 + spread), Math.min(o, c) * (1 - spread), c, 100];
  });
  return seriesFromRows(rows, barMs);
}

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

export function fixtureSeries(name: string): Series {
  const f = loadFixture<{ barMs: number; rows: KlineRow[] }>(name);
  return seriesFromRows(f.rows, f.barMs);
}
