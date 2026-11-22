/**
 * Multi-timeframe confluence ("convergence on all timeframes").
 *
 * The base series is resampled into every requested timeframe (native or custom),
 * each timeframe is scored independently, and at every base bar the scores of the
 * latest *finished* candle of each timeframe are combined:
 *   D  weighted directional score (higher timeframes weigh more)
 *   A  share of weight that is bullish, B share that is bearish
 *   H  directional score of the upper half of timeframes (the big picture)
 */
import { aggregate, alignToBase } from './aggregate.ts';
import { ALL_KEYS, computeFeatures, type ComponentKey, type TfFeatures } from './features.ts';
import { isCompatible, parseTf, sortTfs, type Timeframe } from './timeframe.ts';
import type { Series } from './types.ts';

export interface ConfluenceSpec {
  /** Interval of the base series, e.g. "15m". */
  baseTf: string;
  /** Timeframes to combine (custom ones allowed). The base timeframe is always included. */
  tfs: string[];
}

export interface Confluence {
  base: Series;
  baseTf: Timeframe;
  tfs: Timeframe[];
  feats: TfFeatures[];
  /** aligned[k][i] = index of the latest finished bar of timeframe k at base bar i (-1 if none). */
  aligned: Int32Array[];
  /** Open times of each timeframe's candles. */
  tfOpen: number[][];
  weights: number[];
  D: Float64Array;
  A: Float64Array;
  B: Float64Array;
  H: Float64Array;
  /** Share of total weight with usable data at bar i. */
  coverage: Float64Array;
}

export const AGREE_EPS = 0.1;

export function tfWeight(tf: Timeframe, base: Timeframe): number {
  return 1 + 0.5 * Math.log2(Math.max(1, tf.ms / base.ms));
}

export function buildConfluence(base: Series, spec: ConfluenceSpec): Confluence {
  const baseTf = parseTf(spec.baseTf);
  const tfs = sortTfs([spec.baseTf, ...spec.tfs]).filter((tf) => tf.ms >= baseTf.ms);
  for (const tf of tfs) {
    if (!isCompatible(baseTf, tf)) throw new Error(`Timeframe ${tf.id} cannot be built from ${baseTf.id} candles`);
  }
  const n = base.t.length;
  const feats: TfFeatures[] = [];
  const aligned: Int32Array[] = [];
  const tfOpen: number[][] = [];
  for (const tf of tfs) {
    if (tf.id === baseTf.id) {
      feats.push(computeFeatures(base, tf));
      aligned.push(Int32Array.from({ length: n }, (_, i) => i));
      tfOpen.push(base.t);
    } else {
      const agg = aggregate(base, tf);
      feats.push(computeFeatures(agg, tf));
      aligned.push(alignToBase(agg, n));
      tfOpen.push(agg.t);
    }
  }
  const weights = tfs.map((tf) => tfWeight(tf, baseTf));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const medianMs = tfs[Math.floor(tfs.length / 2)].ms;

  const D = new Float64Array(n).fill(Number.NaN);
  const A = new Float64Array(n).fill(Number.NaN);
  const B = new Float64Array(n).fill(Number.NaN);
  const H = new Float64Array(n).fill(Number.NaN);
  const coverage = new Float64Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    let wSum = 0;
    let dSum = 0;
    let bull = 0;
    let bear = 0;
    let hw = 0;
    let hd = 0;
    for (let k = 0; k < tfs.length; k++) {
      const j = aligned[k][i];
      if (j < 0) continue;
      const dk = feats[k].dir[j];
      if (!Number.isFinite(dk)) continue;
      const w = weights[k];
      wSum += w;
      dSum += w * dk;
      if (dk > AGREE_EPS) bull += w;
      else if (dk < -AGREE_EPS) bear += w;
      if (tfs[k].ms >= medianMs) {
        hw += w;
        hd += w * dk;
      }
    }
    coverage[i] = wSum / totalW;
    if (wSum > 0) {
      D[i] = dSum / wSum;
      A[i] = bull / wSum;
      B[i] = bear / wSum;
    }
    if (hw > 0) H[i] = hd / hw;
  }
  return { base, baseTf, tfs, feats, aligned, tfOpen, weights, D, A, B, H, coverage };
}

export interface TfSnapshot {
  tf: string;
  weight: number;
  /** Open time of the finished candle used, or null if none yet. */
  barTime: number | null;
  trend: number;
  mom: number;
  rev: number;
  dir: number;
  rsi: number;
  components: Record<ComponentKey, number>;
}

export interface ConfluenceSnapshot {
  index: number;
  time: number;
  close: number;
  D: number;
  A: number;
  B: number;
  H: number;
  coverage: number;
  perTf: TfSnapshot[];
  /** Count of individual algorithm votes across all timeframes. */
  votes: { bull: number; bear: number; neutral: number };
}

/** Per-timeframe breakdown at base bar i, for display and explanations. */
export function snapshotAt(cf: Confluence, i: number): ConfluenceSnapshot {
  const perTf: TfSnapshot[] = [];
  const votes = { bull: 0, bear: 0, neutral: 0 };
  cf.tfs.forEach((tf, k) => {
    const j = cf.aligned[k][i];
    const f = cf.feats[k];
    const components = Object.fromEntries(ALL_KEYS.map((key) => [key, j >= 0 ? f.comp[key][j] : Number.NaN])) as Record<
      ComponentKey,
      number
    >;
    for (const key of ALL_KEYS) {
      const val = components[key];
      if (!Number.isFinite(val)) continue;
      if (val > 0.2) votes.bull++;
      else if (val < -0.2) votes.bear++;
      else votes.neutral++;
    }
    perTf.push({
      tf: tf.id,
      weight: cf.weights[k],
      barTime: j >= 0 ? cf.tfOpen[k][j] : null,
      trend: j >= 0 ? f.trend[j] : Number.NaN,
      mom: j >= 0 ? f.mom[j] : Number.NaN,
      rev: j >= 0 ? f.rev[j] : Number.NaN,
      dir: j >= 0 ? f.dir[j] : Number.NaN,
      rsi: j >= 0 ? f.rsiRaw[j] : Number.NaN,
      components,
    });
  });
  return {
    index: i,
    time: cf.base.t[i],
    close: cf.base.c[i],
    D: cf.D[i],
    A: cf.A[i],
    B: cf.B[i],
    H: cf.H[i],
    coverage: cf.coverage[i],
    perTf,
    votes,
  };
}
