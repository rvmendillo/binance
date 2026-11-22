import { describe, expect, it } from 'vitest';
import {
  atr, bollinger, dmi, ema, linreg, macd, mfi, obv, rollingMax, rollingMin, rollingVwap, rsi, sma, stdev,
  stochRsi, supertrend, trueRange, zscore,
} from '../src/engine/indicators.ts';
import { fixtureSeries, loadFixture, seriesFromCloses } from './helpers.ts';

const s = fixtureSeries('eth-1h-2025H1.json');
const ref = loadFixture<{ series: Record<string, (number | null)[]> }>('talib-eth-1h.json').series;

/**
 * Compare against TA-Lib. `from` skips the warm-up window where seeding
 * conventions legitimately differ (EMA-family values converge exponentially).
 * NaN positions must match TA-Lib's null positions from `nanCheckFrom` on.
 */
function expectClose(name: string, ours: number[], opts: { from?: number; rel?: number; abs?: number } = {}) {
  const theirs = ref[name];
  expect(theirs, `reference ${name}`).toBeDefined();
  expect(ours.length).toBe(theirs.length);
  const from = opts.from ?? 0;
  const rel = opts.rel ?? 1e-9;
  const abs = opts.abs ?? 1e-9;
  let compared = 0;
  for (let i = from; i < ours.length; i++) {
    const t = theirs[i];
    if (t === null) {
      expect(Number.isNaN(ours[i]), `${name}[${i}] should be NaN`).toBe(true);
      continue;
    }
    const diff = Math.abs(ours[i] - t);
    if (!(diff <= abs + rel * Math.abs(t))) {
      throw new Error(`${name}[${i}]: ours=${ours[i]} talib=${t} diff=${diff}`);
    }
    compared++;
  }
  expect(compared).toBeGreaterThan(ours.length * 0.8);
}

describe('indicators match TA-Lib on real ETH 1h data', () => {
  it('SMA / EMA', () => {
    expectClose('sma20', sma(s.c, 20));
    expectClose('ema20', ema(s.c, 20));
    expectClose('ema50', ema(s.c, 50));
    expectClose('ema200', ema(s.c, 200));
  });
  it('RSI (Wilder)', () => expectClose('rsi14', rsi(s.c, 14)));
  it('true range and ATR (Wilder)', () => {
    expectClose('trange', trueRange(s.h, s.l, s.c), { from: 1 });
    expectClose('atr14', atr(s.h, s.l, s.c, 14));
  });
  it('MACD (converges after warm-up)', () => {
    const m = macd(s.c);
    expectClose('macd', m.macd, { from: 300, rel: 1e-7, abs: 1e-7 });
    expectClose('macdSignal', m.signal, { from: 300, rel: 1e-7, abs: 1e-7 });
    expectClose('macdHist', m.hist, { from: 300, rel: 1e-6, abs: 1e-6 });
  });
  it('Bollinger bands and population stdev', () => {
    const b = bollinger(s.c, 20, 2);
    expectClose('bbUpper', b.upper, { rel: 1e-8 });
    expectClose('bbMid', b.mid);
    expectClose('bbLower', b.lower, { rel: 1e-8 });
    expectClose('stddev20', stdev(s.c, 20), { rel: 1e-6, abs: 1e-6 });
  });
  it('Stochastic RSI K equals TA-Lib STOCHRSI fastD(3)', () => {
    expectClose('stochRsiFastD', stochRsi(s.c, 14, 14, 3, 3).k, { rel: 1e-7, abs: 1e-7 });
  });
  it('DMI / ADX (Wilder, TA-Lib seeding)', () => {
    const d = dmi(s.h, s.l, s.c, 14);
    expectClose('plusDi14', d.plusDi, { rel: 1e-8 });
    expectClose('minusDi14', d.minusDi, { rel: 1e-8 });
    expectClose('adx14', d.adx, { rel: 1e-8 });
  });
  it('OBV and MFI', () => {
    expectClose('obv', obv(s.c, s.v), { rel: 1e-9, abs: 1e-6 });
    expectClose('mfi14', mfi(s.h, s.l, s.c, s.v, 14), { rel: 1e-8 });
  });
  it('linear regression slope and rolling extremes', () => {
    expectClose('linregSlope20', linreg(s.c, 20).slope, { rel: 1e-7, abs: 1e-9 });
    expectClose('max20', rollingMax(s.h, 20));
    expectClose('min20', rollingMin(s.l, 20));
  });
});

describe('indicator behaviour on hand-made series', () => {
  const H = 3_600_000;
  it('RSI is 100 for a strictly rising series and 0 for a falling one', () => {
    const up = seriesFromCloses(Array.from({ length: 40 }, (_, i) => 100 + i), H);
    const down = seriesFromCloses(Array.from({ length: 40 }, (_, i) => 200 - i), H);
    expect(rsi(up.c, 14)[39]).toBe(100);
    expect(rsi(down.c, 14)[39]).toBe(0);
    expect(rsi(up.c, 14)[13]).toBeNaN();
  });
  it('EMA of a constant is that constant; SMA warm-up is NaN', () => {
    const x = new Array(30).fill(7);
    expect(ema(x, 10)[29]).toBeCloseTo(7, 12);
    expect(sma(x, 10)[8]).toBeNaN();
    expect(sma(x, 10)[9]).toBe(7);
  });
  it('SMA restarts after missing values', () => {
    const out = sma([1, 2, Number.NaN, 3, 4, 5], 2);
    expect(out.map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, 1.5, null, null, 3.5, 4.5]);
  });
  it('linreg recovers a perfect line with R^2 = 1', () => {
    const x = Array.from({ length: 50 }, (_, i) => 3 + 0.5 * i);
    const { slope, r2 } = linreg(x, 20);
    expect(slope[49]).toBeCloseTo(0.5, 12);
    expect(r2[49]).toBeCloseTo(1, 12);
  });
  it('supertrend flips up in a rally and down in a sell-off', () => {
    const closes = [
      ...Array.from({ length: 60 }, (_, i) => 100 + i * 1.5),
      ...Array.from({ length: 60 }, (_, i) => 190 - i * 2),
    ];
    const ser = seriesFromCloses(closes, H);
    const st = supertrend(ser.h, ser.l, ser.c, 10, 3);
    expect(st.dir[55]).toBe(1);
    expect(st.dir[119]).toBe(-1);
    // the line sits below price in an uptrend and above it in a downtrend
    expect(st.line[55]).toBeLessThan(ser.c[55]);
    expect(st.line[119]).toBeGreaterThan(ser.c[119]);
  });
  it('rolling VWAP equals the price for constant prices and weights by volume', () => {
    const h = [10, 10, 20, 20];
    const l = [10, 10, 20, 20];
    const c = [10, 10, 20, 20];
    const v = [1, 1, 3, 1];
    const out = rollingVwap(h, l, c, v, 2);
    expect(out[1]).toBe(10);
    expect(out[2]).toBeCloseTo((10 * 1 + 20 * 3) / 4, 12);
    expect(out[3]).toBe(20);
  });
  it('z-score is 0 on constants and positive above the mean', () => {
    expect(zscore(new Array(25).fill(5), 20)[24]).toBe(0);
    const z = zscore([...new Array(20).fill(5), 10], 20);
    expect(z[20]).toBeGreaterThan(0);
  });
  it('DMI: a steady uptrend has +DI > -DI and a high ADX', () => {
    const ser = seriesFromCloses(Array.from({ length: 120 }, (_, i) => 100 * Math.exp(0.01 * i)), H);
    const d = dmi(ser.h, ser.l, ser.c, 14);
    expect(d.plusDi[119]).toBeGreaterThan(d.minusDi[119]);
    expect(d.adx[119]).toBeGreaterThan(40);
  });
  it('indicators are causal: appending future bars never changes past values', () => {
    const full = s;
    const k = 2500;
    const cut = { h: full.h.slice(0, k), l: full.l.slice(0, k), c: full.c.slice(0, k), v: full.v.slice(0, k) };
    const pairs: [number[], number[]][] = [
      [ema(full.c, 50).slice(0, k), ema(cut.c, 50)],
      [rsi(full.c).slice(0, k), rsi(cut.c)],
      [atr(full.h, full.l, full.c).slice(0, k), atr(cut.h, cut.l, cut.c)],
      [dmi(full.h, full.l, full.c).adx.slice(0, k), dmi(cut.h, cut.l, cut.c).adx],
      [supertrend(full.h, full.l, full.c).dir.slice(0, k), supertrend(cut.h, cut.l, cut.c).dir],
      [stochRsi(full.c).k.slice(0, k), stochRsi(cut.c).k],
      [mfi(full.h, full.l, full.c, full.v).slice(0, k), mfi(cut.h, cut.l, cut.c, cut.v)],
      [macd(full.c).hist.slice(0, k), macd(cut.c).hist],
    ];
    for (const [a, b] of pairs) expect(a).toEqual(b);
  });
});
