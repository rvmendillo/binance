/**
 * Timeframes, including custom ones Binance does not serve (7m, 45m, 2d, 2w...).
 *
 * Bucket alignment matches Binance for every native interval, verified against
 * live klines:
 *  - minutes / hours / 1d: aligned to the Unix epoch (so to UTC midnight)
 *  - 3d: epoch + 1 day (Binance 3d candles open at t % 3d == 1d)
 *  - weeks: Monday 00:00 UTC (epoch + 4 days)
 *  - months: calendar months in UTC
 * Custom multi-day buckets other than 3d are epoch aligned.
 */

export type TfUnit = 'm' | 'h' | 'd' | 'w' | 'M';

export interface Timeframe {
  /** Canonical id such as "15m", "2h", "3d", "1w", "1M". */
  id: string;
  n: number;
  unit: TfUnit;
  /** Nominal length in ms (months use 30 days; only for sorting and scaling). */
  ms: number;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

const UNIT_MS: Record<TfUnit, number> = { m: MINUTE, h: HOUR, d: DAY, w: WEEK, M: 30 * DAY };

/** Intervals Binance's /api/v3/klines accepts directly. */
export const BINANCE_INTERVALS = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M',
] as const;
export type BinanceInterval = (typeof BINANCE_INTERVALS)[number];

const WEEK_OFFSET = 4 * DAY; // 1970-01-05 was a Monday
const THREE_DAY_OFFSET = DAY;

export function parseTf(id: string): Timeframe {
  const m = /^\s*(\d+)\s*(m|h|d|w|M)\s*$/.exec(id);
  if (!m) throw new Error(`Invalid timeframe "${id}". Use forms like 5m, 2h, 3d, 1w, 1M.`);
  const n = Number(m[1]);
  const unit = m[2] as TfUnit;
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error(`Invalid timeframe "${id}": count must be 1-1000`);
  return { id: `${n}${unit}`, n, unit, ms: n * UNIT_MS[unit] };
}

export function isNativeInterval(id: string): id is BinanceInterval {
  return (BINANCE_INTERVALS as readonly string[]).includes(id);
}

/** Start (ms) of the bucket containing time t. */
export function bucketStart(t: number, tf: Timeframe): number {
  switch (tf.unit) {
    case 'm':
    case 'h':
      return Math.floor(t / tf.ms) * tf.ms;
    case 'd': {
      const off = tf.n === 3 ? THREE_DAY_OFFSET : 0;
      return Math.floor((t - off) / tf.ms) * tf.ms + off;
    }
    case 'w':
      return Math.floor((t - WEEK_OFFSET) / tf.ms) * tf.ms + WEEK_OFFSET;
    case 'M': {
      const d = new Date(t);
      const monthIndex = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const b = Math.floor(monthIndex / tf.n) * tf.n;
      return Date.UTC(Math.floor(b / 12), b % 12, 1);
    }
  }
}

/** Exclusive end (ms) of the bucket that starts at `start`. */
export function bucketEnd(start: number, tf: Timeframe): number {
  if (tf.unit === 'M') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + tf.n, 1);
  }
  return start + tf.ms;
}

/** Sort timeframes from shortest to longest and drop duplicates. */
export function sortTfs(ids: string[]): Timeframe[] {
  const seen = new Map<string, Timeframe>();
  for (const id of ids) {
    const tf = parseTf(id);
    seen.set(tf.id, tf);
  }
  return [...seen.values()].sort((a, b) => a.ms - b.ms);
}

/**
 * True when every bar of `base` falls entirely inside a single bucket of `tf`,
 * which is what makes aggregation exact (e.g. 15m -> 45m is fine, 1h -> 90m is not).
 * Checked by walking real bucket boundaries from several reference dates; the
 * aggregator re-checks every bar anyway.
 */
export function isCompatible(base: Timeframe, tf: Timeframe): boolean {
  if (tf.ms < base.ms) return false;
  const refs = [Date.UTC(2020, 0, 1), Date.UTC(2021, 1, 27, 13), Date.UTC(2024, 1, 29), Date.UTC(2025, 11, 31, 22)];
  for (const ref of refs) {
    let start = bucketStart(ref, base);
    for (let k = 0; k < 4000; k++) {
      const end = bucketEnd(start, base);
      if (bucketStart(start, tf) !== bucketStart(end - 1, tf)) return false;
      start = end;
    }
  }
  return true;
}

export function formatTf(tf: Timeframe): string {
  const names: Record<TfUnit, string> = { m: 'min', h: 'hour', d: 'day', w: 'week', M: 'month' };
  return `${tf.n} ${names[tf.unit]}${tf.n > 1 ? 's' : ''}`;
}
