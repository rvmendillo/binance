/**
 * Per-timeframe analysis. Each algorithm is turned into a score in [-1, 1]
 * (+1 = strongly bullish / oversold-bounce potential, -1 = strongly bearish),
 * then grouped into trend, momentum and mean-reversion families.
 * All values at bar i use data up to and including bar i only.
 */
import {
  atr as atrFn, bollinger, clamp, dmi, ema, linreg, macd as macdFn, mfi as mfiFn, rollingMax, rollingMin, rsi as rsiFn,
  sma, stochRsi, supertrend, zscore,
} from './indicators.ts';
import type { Timeframe } from './timeframe.ts';
import type { Series } from './types.ts';

export const TREND_KEYS = ['emaCross', 'emaLong', 'macdLine', 'adx', 'supertrend', 'donchian', 'linreg'] as const;
export const MOM_KEYS = ['rsi', 'mfi', 'flow', 'roc', 'macdHist'] as const;
export const REV_KEYS = ['bollinger', 'stochRsi', 'zscore'] as const;
export type ComponentKey = (typeof TREND_KEYS)[number] | (typeof MOM_KEYS)[number] | (typeof REV_KEYS)[number];
export const ALL_KEYS: ComponentKey[] = [...TREND_KEYS, ...MOM_KEYS, ...REV_KEYS];

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  emaCross: 'EMA 20/50 trend',
  emaLong: 'Price vs EMA 200',
  macdLine: 'MACD line',
  adx: 'ADX / DMI',
  supertrend: 'Supertrend',
  donchian: 'Donchian position',
  linreg: 'Regression slope',
  rsi: 'RSI 14',
  mfi: 'Money flow (MFI)',
  flow: 'Volume flow (OBV)',
  roc: 'Rate of change',
  macdHist: 'MACD histogram',
  bollinger: 'Bollinger %B',
  stochRsi: 'Stochastic RSI',
  zscore: 'Z-score (20)',
};

export interface TfFeatures {
  tf: Timeframe;
  length: number;
  comp: Record<ComponentKey, Float64Array>;
  trend: Float64Array;
  mom: Float64Array;
  rev: Float64Array;
  /** Directional score = 0.6 trend + 0.4 momentum. */
  dir: Float64Array;
  atr: Float64Array;
  atrPct: Float64Array;
  ema20: Float64Array;
  ema50: Float64Array;
  ema200: Float64Array;
  rsiRaw: Float64Array;
  /** Highest high / lowest low of the previous 20 bars (excluding the current bar). */
  prevHigh20: Float64Array;
  prevLow20: Float64Array;
  /** Volume relative to its 20-bar average. */
  volRatio: Float64Array;
}

const f64 = (x: number[]) => Float64Array.from(x);

function meanFinite(vals: number[], minCount: number): number {
  let s = 0;
  let k = 0;
  for (const v of vals) {
    if (Number.isFinite(v)) {
      s += v;
      k++;
    }
  }
  return k >= minCount ? s / k : Number.NaN;
}

export function computeFeatures(s: Series, tf: Timeframe): TfFeatures {
  const n = s.c.length;
  const { h, l, c, v } = s;
  const atr14 = atrFn(h, l, c, 14);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const e200 = ema(c, 200);
  const m = macdFn(c, 12, 26, 9);
  const d = dmi(h, l, c, 14);
  const st = supertrend(h, l, c, 10, 3);
  const hh20 = rollingMax(h, 20);
  const ll20 = rollingMin(l, 20);
  const logc = c.map(Math.log);
  const lr = linreg(logc, 20);
  const r14 = rsiFn(c, 14);
  const mf = mfiFn(h, l, c, v, 14);
  const bb = bollinger(c, 20, 2);
  const srsi = stochRsi(c, 14, 14, 3, 3);
  const z = zscore(c, 20);
  const volAvg = sma(v, 20);

  const comp = Object.fromEntries(ALL_KEYS.map((k) => [k, new Float64Array(n).fill(Number.NaN)])) as Record<
    ComponentKey,
    Float64Array
  >;
  const trend = new Float64Array(n).fill(Number.NaN);
  const mom = new Float64Array(n).fill(Number.NaN);
  const rev = new Float64Array(n).fill(Number.NaN);
  const dir = new Float64Array(n).fill(Number.NaN);
  const atrPct = new Float64Array(n).fill(Number.NaN);
  const prevHigh20 = new Float64Array(n).fill(Number.NaN);
  const prevLow20 = new Float64Array(n).fill(Number.NaN);
  const volRatio = new Float64Array(n).fill(Number.NaN);

  // signed-volume flow over 20 bars (OBV slope normalised by traded volume)
  const signedV = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) signedV[i] = c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0;
  let sv = 0;
  let tv = 0;

  for (let i = 0; i < n; i++) {
    sv += signedV[i];
    tv += i > 0 ? v[i] : 0;
    if (i > 20) {
      sv -= signedV[i - 20];
      tv -= v[i - 20];
    }
    const a = atr14[i];
    if (!(a > 0)) continue;
    const ci = c[i];
    const ap = a / ci;
    atrPct[i] = ap;
    if (i >= 20) {
      prevHigh20[i] = hh20[i - 1];
      prevLow20[i] = ll20[i - 1];
    }
    if (volAvg[i] > 0) volRatio[i] = v[i] / volAvg[i];

    // --- trend family
    comp.emaCross[i] = Number.isFinite(e50[i]) ? Math.tanh((e20[i] - e50[i]) / (1.5 * a)) : Number.NaN;
    comp.emaLong[i] = Number.isFinite(e200[i]) ? Math.tanh((ci - e200[i]) / (4 * a)) : Number.NaN;
    comp.macdLine[i] = Number.isFinite(m.macd[i]) ? Math.tanh(m.macd[i] / (0.7 * a)) : Number.NaN;
    if (Number.isFinite(d.adx[i])) {
      const sum = d.plusDi[i] + d.minusDi[i];
      comp.adx[i] = sum > 0 ? ((d.plusDi[i] - d.minusDi[i]) / sum) * Math.min(d.adx[i] / 25, 1) : 0;
    }
    comp.supertrend[i] = st.dir[i];
    if (Number.isFinite(hh20[i]) && hh20[i] > ll20[i]) comp.donchian[i] = (2 * (ci - ll20[i])) / (hh20[i] - ll20[i]) - 1;
    if (Number.isFinite(lr.slope[i])) comp.linreg[i] = Math.tanh((lr.slope[i] * 19) / (ap * Math.sqrt(20))) * lr.r2[i];

    // --- momentum family
    if (Number.isFinite(r14[i])) comp.rsi[i] = clamp((r14[i] - 50) / 20);
    if (Number.isFinite(mf[i])) comp.mfi[i] = clamp((mf[i] - 50) / 25);
    if (i >= 20 && tv > 0) comp.flow[i] = clamp(sv / tv);
    if (i >= 10) comp.roc[i] = Math.tanh(Math.log(ci / c[i - 10]) / (1.5 * ap * Math.sqrt(10)));
    if (Number.isFinite(m.hist[i])) comp.macdHist[i] = Math.tanh(m.hist[i] / (0.25 * a));

    // --- mean-reversion family (positive = stretched down, bounce potential)
    const width = bb.upper[i] - bb.lower[i];
    if (Number.isFinite(width) && width > 0) comp.bollinger[i] = clamp(1 - (2 * (ci - bb.lower[i])) / width);
    if (Number.isFinite(srsi.k[i])) comp.stochRsi[i] = (50 - srsi.k[i]) / 50;
    if (Number.isFinite(z[i])) comp.zscore[i] = -Math.tanh(z[i] / 2);

    trend[i] = meanFinite(TREND_KEYS.map((k) => comp[k][i]), 4);
    mom[i] = meanFinite(MOM_KEYS.map((k) => comp[k][i]), 3);
    rev[i] = meanFinite(REV_KEYS.map((k) => comp[k][i]), 2);
    if (Number.isFinite(trend[i]) && Number.isFinite(mom[i])) dir[i] = 0.6 * trend[i] + 0.4 * mom[i];
  }

  return {
    tf,
    length: n,
    comp,
    trend,
    mom,
    rev,
    dir,
    atr: f64(atr14),
    atrPct,
    ema20: f64(e20),
    ema50: f64(e50),
    ema200: f64(e200),
    rsiRaw: f64(r14),
    prevHigh20,
    prevLow20,
    volRatio,
  };
}
