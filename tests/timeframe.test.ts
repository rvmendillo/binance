import { describe, expect, it } from 'vitest';
import { bucketEnd, bucketStart, DAY, HOUR, isCompatible, MINUTE, parseTf, sortTfs, WEEK } from '../src/engine/timeframe.ts';

describe('parseTf', () => {
  it('parses native and custom timeframes', () => {
    expect(parseTf('1m')).toMatchObject({ id: '1m', n: 1, unit: 'm', ms: MINUTE });
    expect(parseTf('7m').ms).toBe(7 * MINUTE);
    expect(parseTf('90m').ms).toBe(90 * MINUTE);
    expect(parseTf('4h').ms).toBe(4 * HOUR);
    expect(parseTf('2d').ms).toBe(2 * DAY);
    expect(parseTf('2w').ms).toBe(2 * WEEK);
    expect(parseTf('1M').unit).toBe('M');
    expect(parseTf(' 15m ').id).toBe('15m');
  });
  it('rejects malformed input', () => {
    for (const bad of ['', 'm', '0m', '1x', '1.5h', '-1d', '5 minutes', '1001m']) {
      expect(() => parseTf(bad)).toThrow();
    }
  });
  it('sorts and de-duplicates', () => {
    expect(sortTfs(['1d', '5m', '1h', '5m', '1w']).map((t) => t.id)).toEqual(['5m', '1h', '1d', '1w']);
  });
});

describe('bucket alignment matches Binance candles', () => {
  // Open times taken from live Binance klines (ETHUSDT).
  it('3d candles open at epoch + 1 day multiples', () => {
    const open = Date.UTC(2026, 10, 22); // Sun 2026-11-22, a Binance 3d open
    const tf = parseTf('3d');
    expect(bucketStart(open, tf)).toBe(open);
    expect(bucketStart(open + 3 * DAY - 1, tf)).toBe(open);
    expect(bucketStart(open - 1, tf)).toBe(Date.UTC(2026, 10, 19));
  });
  it('weekly candles open on Monday 00:00 UTC', () => {
    const tf = parseTf('1w');
    const s = bucketStart(Date.UTC(2026, 10, 22, 15), tf); // Sunday afternoon
    expect(new Date(s).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(new Date(s).getUTCDay()).toBe(1);
    expect(bucketEnd(s, tf)).toBe(s + WEEK);
  });
  it('2-week buckets start on Mondays and contain two weekly buckets', () => {
    const tf = parseTf('2w');
    const w = parseTf('1w');
    const s = bucketStart(Date.UTC(2025, 5, 11), tf);
    expect(new Date(s).getUTCDay()).toBe(1);
    expect(bucketStart(s, w)).toBe(s);
    expect(bucketStart(s + WEEK, tf)).toBe(s);
    expect(bucketStart(s + 2 * WEEK, tf)).toBe(s + 2 * WEEK);
  });
  it('monthly buckets follow calendar months, including leap February', () => {
    const tf = parseTf('1M');
    const s = bucketStart(Date.UTC(2024, 1, 29, 23, 59), tf);
    expect(new Date(s).toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(new Date(bucketEnd(s, tf)).toISOString()).toBe('2024-03-01T00:00:00.000Z');
    const q = parseTf('3M');
    expect(new Date(bucketStart(Date.UTC(2025, 7, 15), q)).toISOString()).toBe('2025-07-01T00:00:00.000Z');
    expect(new Date(bucketEnd(Date.UTC(2025, 9, 1), q)).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
  it('intraday buckets align to UTC midnight', () => {
    expect(bucketStart(Date.UTC(2026, 0, 1, 13, 7), parseTf('4h'))).toBe(Date.UTC(2026, 0, 1, 12));
    expect(bucketStart(Date.UTC(2026, 0, 1, 13, 7), parseTf('15m'))).toBe(Date.UTC(2026, 0, 1, 13, 0));
    expect(bucketStart(Date.UTC(2026, 0, 1, 0, 0), parseTf('1d'))).toBe(Date.UTC(2026, 0, 1));
  });
});

describe('isCompatible', () => {
  const ok: [string, string][] = [
    ['1m', '7m'], ['1m', '1M'], ['15m', '45m'], ['15m', '1d'], ['1h', '3d'], ['4h', '1w'], ['1d', '2d'],
    ['1d', '3d'], ['1d', '1w'], ['1d', '2w'], ['1d', '1M'], ['1w', '2w'], ['5m', '1w'], ['1M', '3M'],
  ];
  const bad: [string, string][] = [['1h', '90m'], ['15m', '50m'], ['3d', '1w'], ['1w', '1M'], ['1h', '30m'], ['2d', '3d']];
  it.each(ok)('%s -> %s is compatible', (a, b) => expect(isCompatible(parseTf(a), parseTf(b))).toBe(true));
  it.each(bad)('%s -> %s is not compatible', (a, b) => expect(isCompatible(parseTf(a), parseTf(b))).toBe(false));
});
