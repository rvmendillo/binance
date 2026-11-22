/**
 * Edge estimation: "only trade when the expected earnings outweigh the losses".
 *
 * Every candidate setup is labelled with a triple-barrier outcome (did the target
 * get hit before the stop within the holding window?). A ridge-regularised
 * logistic regression learns P(win | features) walk-forward: a label is only used
 * for training after the bar where its outcome became known, so the model never
 * sees the future. Until enough outcomes exist, a Beta prior on the win rate is used.
 */
import type { Series } from './types.ts';

export interface BarrierLabel {
  win: 0 | 1;
  /** Gross outcome in multiples of the stop distance (fees not included). */
  r: number;
  /** Bar at whose close the outcome is known (Infinity if unresolved). */
  resolveIdx: number;
}

/** Long entry at the open of bar i+1 with stop and target at fixed distances. */
export function tripleBarrier(s: Series, i: number, stopDist: number, targetDist: number, maxBars: number): BarrierLabel {
  const n = s.t.length;
  if (i + 1 >= n || !(stopDist > 0) || !(targetDist > 0)) return { win: 0, r: 0, resolveIdx: Infinity };
  const entry = s.o[i + 1];
  const sl = entry - stopDist;
  const tp = entry + targetDist;
  const lastJ = i + maxBars;
  for (let j = i + 1; j <= Math.min(lastJ, n - 1); j++) {
    if (s.o[j] <= sl) return { win: 0, r: (s.o[j] - entry) / stopDist, resolveIdx: j };
    if (s.o[j] >= tp) return { win: 1, r: (s.o[j] - entry) / stopDist, resolveIdx: j };
    if (s.l[j] <= sl) return { win: 0, r: -1, resolveIdx: j };
    if (s.h[j] >= tp) return { win: 1, r: targetDist / stopDist, resolveIdx: j };
  }
  if (lastJ > n - 1) return { win: 0, r: 0, resolveIdx: Infinity };
  return { win: 0, r: (s.c[lastJ] - entry) / stopDist, resolveIdx: lastJ };
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Solve A x = b for symmetric positive definite A (row-major m x m) via Cholesky. */
export function choleskySolve(A: Float64Array, b: Float64Array, m: number): Float64Array {
  const L = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * m + j];
      for (let k = 0; k < j; k++) sum -= L[i * m + k] * L[j * m + k];
      if (i === j) {
        if (sum <= 0) sum = 1e-12;
        L[i * m + i] = Math.sqrt(sum);
      } else L[i * m + j] = sum / L[j * m + j];
    }
  }
  const y = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * m + k] * y[k];
    y[i] = sum / L[i * m + i];
  }
  const x = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < m; k++) sum -= L[k * m + i] * x[k];
    x[i] = sum / L[i * m + i];
  }
  return x;
}

export class LogisticModel {
  d = 0;
  w = new Float64Array(0);
  mu = new Float64Array(0);
  sd = new Float64Array(0);

  /** Newton-IRLS with an L2 penalty on standardised weights (the intercept is not penalised). */
  fit(X: number[][], y: number[], lambda = 1, maxIter = 30): this {
    const n = X.length;
    const d = X[0]?.length ?? 0;
    const m = d + 1;
    this.d = d;
    this.mu = new Float64Array(d);
    this.sd = new Float64Array(d);
    for (let k = 0; k < d; k++) {
      let s = 0;
      let s2 = 0;
      for (let i = 0; i < n; i++) {
        s += X[i][k];
        s2 += X[i][k] * X[i][k];
      }
      const mean = s / n;
      this.mu[k] = mean;
      this.sd[k] = Math.sqrt(Math.max(0, s2 / n - mean * mean)) || 1;
      if (this.sd[k] < 1e-12) this.sd[k] = 1;
    }
    const Z = X.map((row) => this.standardise(row));
    const w = this.w.length === m ? Float64Array.from(this.w) : new Float64Array(m);
    for (let it = 0; it < maxIter; it++) {
      const g = new Float64Array(m);
      const H = new Float64Array(m * m);
      for (let i = 0; i < n; i++) {
        const z = Z[i];
        let eta = w[d];
        for (let k = 0; k < d; k++) eta += w[k] * z[k];
        const p = sigmoid(eta);
        const r = p - y[i];
        const s = Math.max(p * (1 - p), 1e-9);
        for (let a = 0; a < m; a++) {
          const za = a < d ? z[a] : 1;
          g[a] += r * za;
          const sa = s * za;
          for (let b = 0; b <= a; b++) H[a * m + b] += sa * (b < d ? z[b] : 1);
        }
      }
      for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) H[b * m + a] = H[a * m + b];
      for (let k = 0; k < d; k++) {
        g[k] += lambda * w[k];
        H[k * m + k] += lambda;
      }
      H[d * m + d] += 1e-9;
      const step = choleskySolve(H, g, m);
      let maxStep = 0;
      for (let a = 0; a < m; a++) {
        w[a] -= step[a];
        maxStep = Math.max(maxStep, Math.abs(step[a]));
      }
      if (maxStep < 1e-8) break;
    }
    this.w = w;
    return this;
  }

  standardise(x: number[]): number[] {
    const z = new Array<number>(this.d);
    for (let k = 0; k < this.d; k++) {
      const v = (x[k] - this.mu[k]) / this.sd[k];
      z[k] = Number.isFinite(v) ? Math.max(-6, Math.min(6, v)) : 0;
    }
    return z;
  }

  predict(x: number[]): number {
    const z = this.standardise(x);
    let eta = this.w[this.d];
    for (let k = 0; k < this.d; k++) eta += this.w[k] * z[k];
    return sigmoid(eta);
  }
}

export interface EdgeOptions {
  minSamples: number;
  retrainEvery: number;
  lambda: number;
  /** Rolling window of most recent outcomes used for training. */
  maxSamples: number;
  priorWins: number;
  priorLosses: number;
  /** Model weight = n / (n + blendK); the rest is the base-rate estimate. */
  blendK: number;
}

export const DEFAULT_EDGE: EdgeOptions = {
  minSamples: 120,
  retrainEvery: 40,
  lambda: 4,
  maxSamples: 3000,
  priorWins: 2,
  priorLosses: 3,
  blendK: 150,
};

export interface EdgeEstimate {
  p: number;
  pBase: number;
  pModel: number | null;
  n: number;
}

export class EdgeEstimator {
  private pending: { x: number[]; label: BarrierLabel }[] = [];
  private X: number[][] = [];
  private y: number[] = [];
  private sinceTrain = 0;
  private model: LogisticModel | null = null;
  wins = 0;
  n = 0;
  trainings = 0;
  opts: EdgeOptions;

  constructor(opts: Partial<EdgeOptions> = {}) {
    this.opts = { ...DEFAULT_EDGE, ...opts };
  }

  add(x: number[], label: BarrierLabel): void {
    if (Number.isFinite(label.resolveIdx)) this.pending.push({ x, label });
  }

  /** Reveal every outcome known by the close of bar t, retraining when due. */
  advance(t: number): void {
    if (!this.pending.length) return;
    const keep: typeof this.pending = [];
    for (const s of this.pending) {
      if (s.label.resolveIdx <= t) {
        this.X.push(s.x);
        this.y.push(s.label.win);
        this.wins += s.label.win;
        this.n++;
        this.sinceTrain++;
      } else keep.push(s);
    }
    this.pending = keep;
    if (this.X.length > this.opts.maxSamples) {
      const drop = this.X.length - this.opts.maxSamples;
      this.X.splice(0, drop);
      this.y.splice(0, drop);
    }
    if (this.n >= this.opts.minSamples && (this.sinceTrain >= this.opts.retrainEvery || !this.model)) {
      const hasBoth = this.y.some((v) => v === 1) && this.y.some((v) => v === 0);
      if (hasBoth) {
        this.model = (this.model ?? new LogisticModel()).fit(this.X, this.y, this.opts.lambda);
        this.trainings++;
      }
      this.sinceTrain = 0;
    }
  }

  estimate(x: number[]): EdgeEstimate {
    const pBase = (this.wins + this.opts.priorWins) / (this.n + this.opts.priorWins + this.opts.priorLosses);
    if (!this.model) return { p: pBase, pBase, pModel: null, n: this.n };
    const pModel = this.model.predict(x);
    const wM = this.n / (this.n + this.opts.blendK);
    const p = Math.min(0.95, Math.max(0.02, wM * pModel + (1 - wM) * pBase));
    return { p, pBase, pModel, n: this.n };
  }
}

/** Expected value in R (stop-distance units) of a long trade after round-trip costs. */
export function expectedR(p: number, rewardR: number, costR: number): number {
  return p * rewardR - (1 - p) * 1 - costR;
}
