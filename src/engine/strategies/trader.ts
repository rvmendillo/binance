/**
 * Day-trading / scalping strategy driven by multi-timeframe confluence.
 *
 * Entry (decided at a base candle's close, filled at the next open) needs ALL of:
 *  1. Regime: the big-picture timeframes are bullish (H), most of the weight agrees
 *     (A) and the overall score is positive (D).
 *  2. Trigger on the base timeframe: a pullback that is turning up, or a breakout of
 *     the last 20 candles on above-average volume.
 *  3. Edge, two independent checks that both must pass:
 *     a) the walk-forward model's P(target before stop) gives an expected value above
 *        `evMin` R after fees and slippage (edge.ts), and
 *     b) the strategy's own track record: the last N setups whose outcome is known
 *        (traded or not) averaged a positive R after costs, with statistical confidence.
 *     The model alone proved over-optimistic out of sample, so (b) is required.
 * Risk: a fixed share of equity is risked per trade (ATR stop), position size is capped,
 * a daily loss limit pauses new entries. Exits by default match how setups are scored:
 * stop, target or time limit. Break-even, trailing and confluence exits are optional.
 */
import type { Ctx, Fill, Strategy } from '../backtest.ts';
import type { Confluence } from '../confluence.ts';
import { EdgeEstimator, expectedR, tripleBarrier, type EdgeOptions } from '../edge.ts';
import { DAY } from '../timeframe.ts';

export interface TraderParams {
  hMin: number;
  aMin: number;
  dMin: number;
  minCoverage: number;
  /** Base-timeframe mean-reversion score needed for a pullback entry. */
  revMin: number;
  /** Volume ratio needed for a breakout entry. */
  breakoutVol: number;
  useBreakout: boolean;
  usePullback: boolean;
  slAtr: number;
  tpAtr: number;
  /** Move the stop to break-even after this many R in favour (0 = off). */
  breakEvenR: number;
  /** Start trailing after this many R in favour (0 = off). */
  trailStartR: number;
  trailAtr: number;
  /** Exit early when D falls below -exitD or bearish agreement reaches exitB. */
  exitOnBearish: boolean;
  exitD: number;
  exitB: number;
  maxBars: number;
  riskPerTrade: number;
  maxPositionFrac: number;
  dailyLossLimit: number;
  /** Minimum expected value in R after costs. Set useEdgeFilter=false to see unfiltered results. */
  evMin: number;
  useEdgeFilter: boolean;
  /** Track record gate: the last `shadowWindow` resolved setups (traded or not) must
   * show a positive average after costs, with confidence (mean - z * stderr > 0). */
  shadowWindow: number;
  shadowZ: number;
  edge?: Partial<EdgeOptions>;
}

export const DEFAULT_TRADER: TraderParams = {
  hMin: 0.15,
  aMin: 0.6,
  dMin: 0.1,
  minCoverage: 0.75,
  revMin: 0.15,
  breakoutVol: 1.3,
  useBreakout: true,
  usePullback: true,
  slAtr: 2,
  tpAtr: 4,
  breakEvenR: 0,
  trailStartR: 0,
  trailAtr: 2.5,
  exitOnBearish: false,
  exitD: 0.15,
  exitB: 0.6,
  maxBars: 96,
  riskPerTrade: 0.01,
  maxPositionFrac: 1,
  dailyLossLimit: 0.03,
  evMin: 0.05,
  useEdgeFilter: true,
  shadowWindow: 40,
  shadowZ: 1,
};

export interface TraderDiagnostics {
  candidates: number;
  taken: number;
  skippedNoEdge: number;
  skippedDailyLimit: number;
  lastSignal: SignalEval | null;
  /** Resolved setups in the track record and their average net R after costs. */
  trackN: number;
  trackMean: number;
}

export interface SignalEval {
  i: number;
  time: number;
  regime: boolean;
  pullback: boolean;
  breakout: boolean;
  candidate: boolean;
  p: number;
  pModel: number | null;
  samples: number;
  costR: number;
  evR: number;
  /** Track record of recent setups: count, mean net R and lower confidence bound. */
  trackN: number;
  trackMean: number;
  trackLcb: number;
  take: boolean;
  reason: string;
}

/** Model features for bar i (all known at the close of bar i). */
export function edgeFeatures(cf: Confluence, i: number): number[] {
  const b = cf.feats[0];
  const x = [
    cf.D[i], cf.A[i], cf.B[i], cf.H[i], cf.coverage[i],
    b.trend[i], b.mom[i], b.rev[i], b.dir[i], b.rsiRaw[i] / 100 - 0.5,
    Math.log(Math.max(b.atrPct[i], 1e-6)), Math.log(Math.max(b.volRatio[i], 1e-3)),
    Math.sin((2 * Math.PI * (cf.base.t[i] % DAY)) / DAY), Math.cos((2 * Math.PI * (cf.base.t[i] % DAY)) / DAY),
  ];
  for (let k = 1; k < cf.tfs.length; k++) {
    const j = cf.aligned[k][i];
    x.push(j >= 0 ? cf.feats[k].dir[j] : 0);
  }
  return x.map((v) => (Number.isFinite(v) ? v : 0));
}

export function trader(cf: Confluence, params: TraderParams = DEFAULT_TRADER, name = 'Confluence trader'): Strategy & { diag: TraderDiagnostics; evaluate: (i: number, c: Ctx) => SignalEval } {
  const s = cf.base;
  const b = cf.feats[0];
  const edge = new EdgeEstimator(params.edge);
  const diag: TraderDiagnostics = { candidates: 0, taken: 0, skippedNoEdge: 0, skippedDailyLimit: 0, lastSignal: null, trackN: 0, trackMean: 0 };
  // shadow book: every setup's outcome after costs, revealed only once it is known
  let shadowPending: { net: number; res: number }[] = [];
  const shadowDone: number[] = [];
  const advanceShadow = (t: number) => {
    if (!shadowPending.length) return;
    const keep: typeof shadowPending = [];
    for (const x of shadowPending) {
      if (x.res <= t) shadowDone.push(x.net);
      else keep.push(x);
    }
    shadowPending = keep;
    if (shadowDone.length > params.shadowWindow) shadowDone.splice(0, shadowDone.length - params.shadowWindow);
  };
  const trackStats = () => {
    const n = shadowDone.length;
    if (!n) return { n, mean: 0, lcb: -Infinity };
    const mean = shadowDone.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(shadowDone.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    return { n, mean, lcb: mean - (params.shadowZ * sd) / Math.sqrt(n) };
  };
  let pendingEntry: { atr: number; i: number } | null = null;
  let day = -1;
  let dayStartEq = 0;
  let blockedDay = -1;

  const evaluate = (i: number, c: Ctx): SignalEval => {
    const atr = b.atr[i];
    const ok = Number.isFinite(cf.D[i]) && Number.isFinite(cf.H[i]) && cf.coverage[i] >= params.minCoverage && atr > 0 && i > 0;
    const regime = ok && cf.H[i] >= params.hMin && cf.A[i] >= params.aMin && cf.D[i] >= params.dMin;
    const pullback = params.usePullback && ok && b.rev[i] >= params.revMin && b.dir[i] > b.dir[i - 1];
    const breakout = params.useBreakout && ok && s.c[i] > b.prevHigh20[i] && b.volRatio[i] >= params.breakoutVol;
    const candidate = regime && (pullback || breakout);
    const costR = (2 * c.costs.feeRate + 2 * c.costs.slippage) / (params.slAtr * (atr / s.c[i]));
    const est = edge.estimate(edgeFeatures(cf, i));
    const evR = expectedR(est.p, params.tpAtr / params.slAtr, costR);
    const tr = trackStats();
    const trackOk = tr.n >= params.shadowWindow && tr.lcb > 0;
    const edgeOk = evR >= params.evMin && trackOk;
    const take = candidate && (!params.useEdgeFilter || edgeOk);
    const reason = !ok
      ? 'Not enough data on all timeframes yet'
      : !regime
        ? 'Timeframes do not agree on an uptrend'
        : !candidate
          ? 'Uptrend, waiting for a pullback or breakout'
          : take
            ? params.useEdgeFilter
              ? `Setup with proven edge: EV ${evR.toFixed(2)}R, recent setups averaged ${tr.mean.toFixed(2)}R after costs`
              : 'Setup taken (edge filter off)'
            : evR < params.evMin
              ? `Setup skipped: expected ${evR.toFixed(2)}R after costs is below ${params.evMin.toFixed(2)}R`
              : tr.n < params.shadowWindow
                ? `Setup skipped: building a track record (${tr.n}/${params.shadowWindow} setups resolved)`
                : `Setup skipped: recent setups averaged ${tr.mean.toFixed(2)}R after costs, not reliably positive`;
    return { i, time: s.t[i], regime, pullback, breakout, candidate, p: est.p, pModel: est.pModel, samples: est.n, costR, evR, trackN: tr.n, trackMean: tr.mean, trackLcb: tr.lcb, take, reason };
  };

  return {
    name,
    diag,
    evaluate,
    onFill: (c: Ctx, f: Fill) => {
      if (f.side === 'buy' && pendingEntry) {
        const stopDist = params.slAtr * pendingEntry.atr;
        const stop = f.price - stopDist;
        c.setStop(stop);
        c.limitSell(c.p.qty, f.price + params.tpAtr * pendingEntry.atr, 'target');
        c.setInitialRisk(c.p.qty * stopDist + f.fee);
        pendingEntry = null;
      }
    },
    onBar: (c: Ctx) => {
      const i = c.i;
      // an entry order placed last bar has either filled at this open or was rejected
      pendingEntry = null;
      edge.advance(i);
      advanceShadow(i);
      const eq = c.equity();
      const d = Math.floor(s.t[i] / DAY);
      if (d !== day) {
        day = d;
        dayStartEq = eq;
      }
      if (eq < dayStartEq * (1 - params.dailyLossLimit)) blockedDay = d;

      // Every candidate is labelled for the edge model, whether or not it is traded,
      // so the model learns from the full set of setups (no selection bias).
      const sig = evaluate(i, c);
      diag.lastSignal = sig;
      if (sig.candidate) {
        diag.candidates++;
        const atr = b.atr[i];
        const label = tripleBarrier(s, i, params.slAtr * atr, params.tpAtr * atr, params.maxBars);
        edge.add(edgeFeatures(cf, i), label);
        if (Number.isFinite(label.resolveIdx)) shadowPending.push({ net: label.r - sig.costR, res: label.resolveIdx });
      }
      const ts = trackStats();
      diag.trackN = ts.n;
      diag.trackMean = ts.mean;

      const tr = c.trade();
      if (tr) {
        // manage the open position with information up to this close
        const atr = b.atr[i];
        const entry = tr.cost / Math.max(tr.qtyBought, 1e-12);
        const risk = tr.initialRisk ? tr.initialRisk / Math.max(tr.qtyBought, 1e-12) : params.slAtr * atr;
        let stop = c.stop() ?? entry - risk;
        if (params.breakEvenR > 0 && tr.highSinceEntry >= entry + params.breakEvenR * risk) {
          stop = Math.max(stop, entry * (1 + 2 * c.costs.feeRate + c.costs.slippage));
        }
        if (params.trailStartR > 0 && tr.highSinceEntry >= entry + params.trailStartR * risk && atr > 0) {
          stop = Math.max(stop, s.c[i] - params.trailAtr * atr);
        }
        c.setStop(stop);
        const bearish = params.exitOnBearish && ((Number.isFinite(cf.D[i]) && cf.D[i] <= -params.exitD) || cf.B[i] >= params.exitB);
        if (bearish) c.sell(c.p.qty, 'confluence turned bearish');
        else if (i - tr.entryIndex >= params.maxBars - 1) c.sell(c.p.qty, 'time limit'); // matches the label horizon
        return;
      }

      if (!sig.candidate) return;
      if (!sig.take) {
        diag.skippedNoEdge++;
        return;
      }
      if (blockedDay === d) {
        diag.skippedDailyLimit++;
        return;
      }
      const atr = b.atr[i];
      const stopDist = params.slAtr * atr;
      const qty = (eq * params.riskPerTrade) / stopDist;
      const quote = Math.min(qty * s.c[i], eq * params.maxPositionFrac, c.p.cash);
      if (quote <= 0) return;
      pendingEntry = { atr, i };
      diag.taken++;
      c.buy(quote, sig.breakout ? 'breakout with confluence' : 'pullback with confluence');
    },
  };
}
