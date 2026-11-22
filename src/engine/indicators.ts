/**
 * Causal technical indicators. Every output value at index i depends only on
 * inputs at indices <= i. Warm-up values are NaN. Seeding conventions follow
 * TA-Lib (cross-checked in tests/talib.test.ts) so values match common charting tools.
 */

const NaNArray = (n: number): number[] => new Array<number>(n).fill(Number.NaN);

export function sma(x: number[], n: number): number[] {
  const out = NaNArray(x.length);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (!Number.isFinite(xi)) {
      sum = 0;
      valid = 0;
      continue;
    }
    sum += xi;
    valid++;
    if (valid > n) sum -= x[i - n];
    if (valid >= n) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average seeded with the SMA of the first n valid values. */
export function ema(x: number[], n: number, alpha = 2 / (n + 1)): number[] {
  const out = NaNArray(x.length);
  let prev = Number.NaN;
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (!Number.isFinite(xi)) {
      if (Number.isFinite(prev)) out[i] = prev; // hold through isolated gaps
      continue;
    }
    if (valid < n) {
      sum += xi;
      valid++;
      if (valid === n) {
        prev = sum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * xi + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's moving average (RMA), alpha = 1/n. */
export function rma(x: number[], n: number): number[] {
  return ema(x, n, 1 / n);
}

export function stdev(x: number[], n: number): number[] {
  // Population standard deviation over a rolling window (TA-Lib / TradingView convention).
  const out = NaNArray(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    let s2 = 0;
    for (let k = i - n + 1; k <= i; k++) {
      s += x[k];
      s2 += x[k] * x[k];
    }
    const mean = s / n;
    const varc = Math.max(0, s2 / n - mean * mean);
    out[i] = Math.sqrt(varc);
  }
  return out;
}

export function rollingMax(x: number[], n: number): number[] {
  const out = NaNArray(x.length);
  const dq: number[] = [];
  for (let i = 0; i < x.length; i++) {
    while (dq.length && x[dq[dq.length - 1]] <= x[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = x[dq[0]];
  }
  return out;
}

export function rollingMin(x: number[], n: number): number[] {
  const out = NaNArray(x.length);
  const dq: number[] = [];
  for (let i = 0; i < x.length; i++) {
    while (dq.length && x[dq[dq.length - 1]] >= x[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = x[dq[0]];
  }
  return out;
}

/** Wilder RSI. First value at index n (TA-Lib lookback = n). */
export function rsi(c: number[], n = 14): number[] {
  const out = NaNArray(c.length);
  if (c.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);
  }
  return out;
}

export function trueRange(h: number[], l: number[], c: number[]): number[] {
  const out = new Array<number>(h.length);
  for (let i = 0; i < h.length; i++) {
    if (i === 0) out[i] = h[i] - l[i];
    else out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return out;
}

/** Wilder ATR. First value at index n = mean(TR[1..n]) (TA-Lib convention). */
export function atr(h: number[], l: number[], c: number[], n = 14): number[] {
  const out = NaNArray(h.length);
  if (h.length <= n) return out;
  const tr = trueRange(h, l, c);
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr[i];
  a /= n;
  out[n] = a;
  for (let i = n + 1; i < h.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

export interface Macd {
  macd: number[];
  signal: number[];
  hist: number[];
}

export function macd(c: number[], fast = 12, slow = 26, sig = 9): Macd {
  const ef = ema(c, fast);
  const es = ema(c, slow);
  const line = c.map((_, i) => (Number.isFinite(ef[i]) && Number.isFinite(es[i]) ? ef[i] - es[i] : Number.NaN));
  const signal = ema(line, sig);
  const hist = line.map((m, i) => (Number.isFinite(m) && Number.isFinite(signal[i]) ? m - signal[i] : Number.NaN));
  return { macd: line, signal, hist };
}

export interface Bands {
  mid: number[];
  upper: number[];
  lower: number[];
}

export function bollinger(c: number[], n = 20, k = 2): Bands {
  const mid = sma(c, n);
  const sd = stdev(c, n);
  return {
    mid,
    upper: mid.map((m, i) => m + k * sd[i]),
    lower: mid.map((m, i) => m - k * sd[i]),
  };
}

/** Stochastic RSI (TradingView style): K = SMA(stoch(RSI), kSmooth), D = SMA(K, dSmooth). */
export function stochRsi(c: number[], rsiLen = 14, stochLen = 14, kSmooth = 3, dSmooth = 3): { k: number[]; d: number[] } {
  const r = rsi(c, rsiLen);
  const raw = NaNArray(c.length);
  for (let i = 0; i < c.length; i++) {
    if (i < rsiLen + stochLen - 1) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - stochLen + 1; j <= i; j++) {
      if (r[j] > hi) hi = r[j];
      if (r[j] < lo) lo = r[j];
    }
    raw[i] = hi - lo === 0 ? 50 : (100 * (r[i] - lo)) / (hi - lo);
  }
  const k = sma(raw, kSmooth);
  const d = sma(k, dSmooth);
  return { k, d };
}

export interface Dmi {
  plusDi: number[];
  minusDi: number[];
  adx: number[];
}

/** Wilder DMI/ADX with TA-Lib seeding (+DI from index n, ADX from index 2n-1). */
export function dmi(h: number[], l: number[], c: number[], n = 14): Dmi {
  const len = h.length;
  const plusDi = NaNArray(len);
  const minusDi = NaNArray(len);
  const adx = NaNArray(len);
  if (len <= n) return { plusDi, minusDi, adx };
  const tr = trueRange(h, l, c);
  let sTr = 0;
  let sP = 0;
  let sM = 0;
  const dm = (i: number): [number, number] => {
    const up = h[i] - h[i - 1];
    const down = l[i - 1] - l[i];
    return [up > down && up > 0 ? up : 0, down > up && down > 0 ? down : 0];
  };
  // Seed with the sum of the first n-1 values, then Wilder-smooth from bar n on
  // (exactly TA-Lib's PLUS_DI / MINUS_DI / ADX procedure).
  for (let i = 1; i <= n - 1; i++) {
    const [p, m] = dm(i);
    sP += p;
    sM += m;
    sTr += tr[i];
  }
  const dx = NaNArray(len);
  for (let i = n; i < len; i++) {
    const [p, m] = dm(i);
    sP = sP - sP / n + p;
    sM = sM - sM / n + m;
    sTr = sTr - sTr / n + tr[i];
    const pdi = sTr === 0 ? 0 : (100 * sP) / sTr;
    const mdi = sTr === 0 ? 0 : (100 * sM) / sTr;
    plusDi[i] = pdi;
    minusDi[i] = mdi;
    dx[i] = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  }
  const first = 2 * n - 1;
  if (len > first) {
    let a = 0;
    for (let i = n; i <= first; i++) a += dx[i];
    a /= n;
    adx[first] = a;
    for (let i = first + 1; i < len; i++) {
      a = (a * (n - 1) + dx[i]) / n;
      adx[i] = a;
    }
  }
  return { plusDi, minusDi, adx };
}

/** On-balance volume, seeded with the first bar's volume (TA-Lib convention). */
export function obv(c: number[], v: number[]): number[] {
  const out = new Array<number>(c.length);
  for (let i = 0; i < c.length; i++) {
    if (i === 0) out[i] = v[0];
    else out[i] = out[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0);
  }
  return out;
}

/** Money Flow Index. First value at index n. */
export function mfi(h: number[], l: number[], c: number[], v: number[], n = 14): number[] {
  const len = c.length;
  const out = NaNArray(len);
  const tp = c.map((ci, i) => (h[i] + l[i] + ci) / 3);
  const pos = new Array<number>(len).fill(0);
  const neg = new Array<number>(len).fill(0);
  for (let i = 1; i < len; i++) {
    const mf = tp[i] * v[i];
    if (tp[i] > tp[i - 1]) pos[i] = mf;
    else if (tp[i] < tp[i - 1]) neg[i] = mf;
  }
  let sp = 0;
  let sn = 0;
  for (let i = 1; i < len; i++) {
    sp += pos[i];
    sn += neg[i];
    if (i > n) {
      sp -= pos[i - n];
      sn -= neg[i - n];
    }
    if (i >= n) out[i] = sp + sn <= 0 ? 50 : (100 * sp) / (sp + sn);
  }
  return out;
}

/** Supertrend direction (+1 up, -1 down) and line, ATR via Wilder RMA of TR. */
export function supertrend(h: number[], l: number[], c: number[], n = 10, mult = 3): { dir: number[]; line: number[] } {
  const len = c.length;
  const dir = NaNArray(len);
  const line = NaNArray(len);
  const tr = trueRange(h, l, c);
  const a = rma(tr, n);
  let fu = Number.NaN;
  let fl = Number.NaN;
  let d = 1;
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(a[i])) continue;
    const hl2 = (h[i] + l[i]) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    if (!Number.isFinite(fu)) {
      fu = bu;
      fl = bl;
      d = c[i] >= hl2 ? 1 : -1;
    } else {
      const pc = c[i - 1];
      const nfu = bu < fu || pc > fu ? bu : fu;
      const nfl = bl > fl || pc < fl ? bl : fl;
      if (d === -1 && c[i] > nfu) d = 1;
      else if (d === 1 && c[i] < nfl) d = -1;
      fu = nfu;
      fl = nfl;
    }
    dir[i] = d;
    line[i] = d === 1 ? fl : fu;
  }
  return { dir, line };
}

/** Least-squares slope (per bar) and R^2 over a rolling window. */
export function linreg(x: number[], n: number): { slope: number[]; r2: number[] } {
  const len = x.length;
  const slope = NaNArray(len);
  const r2 = NaNArray(len);
  const mx = (n - 1) / 2;
  let sxx = 0;
  for (let k = 0; k < n; k++) sxx += (k - mx) * (k - mx);
  for (let i = n - 1; i < len; i++) {
    let my = 0;
    for (let k = 0; k < n; k++) my += x[i - n + 1 + k];
    my /= n;
    let sxy = 0;
    let syy = 0;
    for (let k = 0; k < n; k++) {
      const dy = x[i - n + 1 + k] - my;
      sxy += (k - mx) * dy;
      syy += dy * dy;
    }
    const b = sxy / sxx;
    slope[i] = b;
    r2[i] = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  }
  return { slope, r2 };
}

/** Rolling volume-weighted average price over n bars (typical price). */
export function rollingVwap(h: number[], l: number[], c: number[], v: number[], n: number): number[] {
  const out = NaNArray(c.length);
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < c.length; i++) {
    const tp = (h[i] + l[i] + c[i]) / 3;
    pv += tp * v[i];
    vv += v[i];
    if (i >= n) {
      const tpo = (h[i - n] + l[i - n] + c[i - n]) / 3;
      pv -= tpo * v[i - n];
      vv -= v[i - n];
    }
    if (i >= n - 1) out[i] = vv > 0 ? pv / vv : c[i];
  }
  return out;
}

export function zscore(x: number[], n: number): number[] {
  const m = sma(x, n);
  const sd = stdev(x, n);
  return x.map((xi, i) => (sd[i] > 0 ? (xi - m[i]) / sd[i] : 0 * m[i]));
}

/** Clamp helper used by feature scoring. */
export function clamp(x: number, lo = -1, hi = 1): number {
  return x < lo ? lo : x > hi ? hi : x;
}
