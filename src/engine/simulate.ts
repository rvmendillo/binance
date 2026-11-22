/**
 * One call that runs a mode for a symbol: builds the multi-timeframe confluence,
 * simulates every strategy over the same window, and turns the latest candle into a
 * decision with plain-language reasons. Used by the app (history + live candles) and
 * by the research scripts, so what is tested is what ships.
 */
import { runBacktest, type BacktestResult, type Strategy } from './backtest.ts';
import { buildConfluence, snapshotAt, type Confluence, type ConfluenceSnapshot } from './confluence.ts';
import { computeMetrics, type Metrics } from './metrics.ts';
import { MODES, tfsFor, type ModeId, type Settings } from './presets.ts';
import { allocator, allocatorTarget, type AllocatorState } from './strategies/allocator.ts';
import { dcaPlan } from './strategies/dcaPlan.ts';
import { hodl } from './strategies/hodl.ts';
import { planPlus } from './strategies/planPlus.ts';
import { trader, type SignalEval, type TraderDiagnostics } from './strategies/trader.ts';
import { sma } from './indicators.ts';
import { DAY } from './timeframe.ts';
import type { Series } from './types.ts';

export type StrategyId = 'plan' | 'planPlus' | 'allocator' | 'hodl' | 'trader' | 'traderRaw';

export const STRATEGY_INFO: Record<StrategyId, { name: string; about: string }> = {
  plan: { name: 'My plan', about: 'DCA only inside your buy zone, staked, sell at your target. Exactly the rules you set.' },
  planPlus: { name: 'Plan + confluence', about: 'Your zone and target, with buy size and the sell decision checked against all timeframes first.' },
  allocator: { name: 'Confluence allocator', about: 'Holds 0-100% in the coin depending on the trend score across 1d to 1M timeframes (incl. custom 2d, 5d, 2w).' },
  hodl: { name: 'Buy & hold', about: 'Benchmark: buy everything on day one and hold.' },
  trader: { name: 'Confluence trader', about: 'Trades only when all timeframes agree, the setup triggers, and the edge after fees is proven.' },
  traderRaw: { name: 'Same signals, no edge filter', about: 'What happens if every signal is traded regardless of fees and track record.' },
};

export interface StrategyRun {
  id: StrategyId;
  name: string;
  about: string;
  result: BacktestResult;
  metrics: Metrics;
}

export type Action = 'BUY' | 'SELL' | 'HOLD' | 'WAIT';

export interface Decision {
  action: Action;
  headline: string;
  reasons: string[];
}

export interface PlanState {
  inZone: boolean;
  belowZone: boolean;
  aboveTarget: boolean;
  zoneLow: number;
  zoneHigh: number;
  target: number;
  toTargetPct: number;
  nextBuyInDays: number;
  qty: number;
  cash: number;
  avgCost: number | null;
}

export interface ModeResult {
  symbol: string;
  mode: ModeId;
  isEth: boolean;
  series: Series;
  startIndex: number;
  confluence: Confluence;
  snapshot: ConfluenceSnapshot;
  runs: StrategyRun[];
  /** The strategy the decision is based on. */
  primary: StrategyId;
  decision: Decision;
  signal?: SignalEval;
  traderDiag?: TraderDiagnostics;
  plan?: PlanState;
  allocatorState?: AllocatorState | null;
  lastClosedTime: number;
  price: number;
}

export function isEthSymbol(symbol: string): boolean {
  return /^ETH(USDT|USDC|FDUSD|BUSD)$/.test(symbol);
}

export function simStartIndex(s: Series, simDays: number, minWarmup = 60): number {
  if (!s.t.length) return 0;
  const lastT = s.t[s.t.length - 1];
  const from = lastT - simDays * DAY;
  let k = s.t.findIndex((t) => t >= from);
  if (k < 0) k = 0;
  return Math.min(Math.max(k, minWarmup), Math.max(0, s.t.length - 1));
}

function describeConfluence(snap: ConfluenceSnapshot): string {
  const bull = snap.perTf.filter((p) => p.dir > 0.1).map((p) => p.tf);
  const bear = snap.perTf.filter((p) => p.dir < -0.1).map((p) => p.tf);
  const tone = snap.D > 0.3 ? 'strongly bullish' : snap.D > 0.1 ? 'bullish' : snap.D < -0.3 ? 'strongly bearish' : snap.D < -0.1 ? 'bearish' : 'mixed';
  const parts = [`Confluence ${tone} (score ${snap.D.toFixed(2)})`];
  if (bull.length) parts.push(`up on ${bull.join(', ')}`);
  if (bear.length) parts.push(`down on ${bear.join(', ')}`);
  return parts.join('; ');
}

export function simulate(symbol: string, mode: ModeId, series: Series, settings: Settings, opts: { startIndex?: number } = {}): ModeResult {
  const preset = MODES[mode];
  const isEth = isEthSymbol(symbol);
  const cf = buildConfluence(series, { baseTf: preset.baseTf, tfs: tfsFor(mode, settings) });
  const n = series.t.length;
  const last = n - 1;
  const startIndex = opts.startIndex ?? simStartIndex(series, preset.simDays, mode === 'long' ? 250 : 120);
  const costs = { feeRate: settings.feeRate, slippage: settings.slippage };
  const stakeApr = isEth ? settings.ethStakingApr : settings.otherStakingApr;
  const base = { initialCash: settings.initialCash, costs, startIndex };
  const runs: StrategyRun[] = [];
  const add = (id: StrategyId, strat: Strategy, stake: number) => {
    const result = runBacktest(series, strat, { ...base, stakingApr: stake });
    runs.push({ id, ...STRATEGY_INFO[id], result, metrics: computeMetrics(result) });
  };
  const snapshot = snapshotAt(cf, last);
  const price = series.c[last];
  let decision: Decision;
  let primary: StrategyId;
  let signal: SignalEval | undefined;
  let traderDiag: TraderDiagnostics | undefined;
  let plan: PlanState | undefined;
  let allocatorState: AllocatorState | null | undefined;

  if (mode === 'long') {
    if (isEth) {
      add('plan', dcaPlan(settings.plan), stakeApr);
      add('planPlus', planPlus(cf, settings.plan, settings.planPlus), stakeApr);
    }
    add('allocator', allocator(cf, settings.allocator), stakeApr);
    add('hodl', hodl(), stakeApr);
    allocatorState = allocatorTarget(cf, sma(series.c, settings.allocator.valSma), last, settings.allocator);
    if (isEth) {
      primary = 'plan';
      const pr = runs[0].result;
      const p = settings.plan;
      const target = Math.min(...p.takeProfit.map((l) => l.price));
      const inZone = price >= p.zoneLow && price <= p.zoneHigh;
      const belowZone = price < p.zoneLow;
      const t0 = series.t[startIndex];
      const dayNow = Math.floor((series.t[last] - t0) / DAY);
      // a buy decided at the last close fills at the next open (0); otherwise the next
      // decision is at the close of the next scheduled day
      const nextBuyInDays = dayNow % p.buyEveryDays === 0 ? 0 : p.buyEveryDays - (dayNow % p.buyEveryDays);
      const open = pr.openTrade;
      plan = {
        inZone, belowZone, aboveTarget: price >= target, zoneLow: p.zoneLow, zoneHigh: p.zoneHigh, target,
        toTargetPct: target / price - 1, nextBuyInDays, qty: pr.final.qty, cash: pr.final.cash,
        avgCost: open && open.qtyBought > 0 ? open.cost / open.qtyBought : null,
      };
      const reasons: string[] = [];
      let action: Action;
      let headline: string;
      if (plan.qty > 0 && price >= target) {
        action = 'SELL';
        headline = `Price is at your ${target.toLocaleString('en-US')} target: your plan sells.`;
      } else if ((inZone || (belowZone && p.buyBelowZone)) && plan.cash > 0) {
        action = 'BUY';
        headline = `Price is inside your buy zone (${p.zoneLow.toLocaleString('en-US')}-${p.zoneHigh.toLocaleString('en-US')}): your plan keeps buying.`;
        reasons.push(nextBuyInDays === 0 ? 'A scheduled buy fills at the next daily open (00:00 UTC).' : `Next scheduled buy check in ${nextBuyInDays} day${nextBuyInDays > 1 ? 's' : ''} (if price is still in the zone).`);
      } else if (plan.qty > 0) {
        action = 'HOLD';
        headline = `Holding and staking. ${(plan.toTargetPct * 100).toFixed(0)}% to go to your ${target.toLocaleString('en-US')} target.`;
      } else {
        action = 'WAIT';
        headline = belowZone ? 'Price is below your buy zone. Your plan waits (buying below the zone is off).' : 'Price is above your buy zone. Your plan waits in cash.';
      }
      reasons.push(describeConfluence(snapshot));
      if (Number.isFinite(snapshot.H) && snapshot.H < settings.planPlus.knifeH && snapshot.D < settings.planPlus.knifeD && action === 'BUY') {
        reasons.push('Every timeframe is still falling. Plan+ would pause this buy (in backtests, pausing did not beat your plain plan).');
      }
      if (allocatorState) reasons.push(`Confluence allocator would hold ${(allocatorState.target * 100).toFixed(0)}% in ETH now.`);
      decision = { action, headline, reasons };
    } else {
      primary = 'allocator';
      const ar = runs[0].result;
      const curAlloc = ar.final.equity > 0 ? (ar.final.qty * price) / ar.final.equity : 0;
      const tgt = allocatorState?.target ?? curAlloc;
      const action: Action = tgt > curAlloc + 0.05 ? 'BUY' : tgt < curAlloc - 0.05 ? 'SELL' : curAlloc > 0.05 ? 'HOLD' : 'WAIT';
      decision = {
        action,
        headline: allocatorState
          ? `Target allocation ${(tgt * 100).toFixed(0)}% (now ${(curAlloc * 100).toFixed(0)}%).`
          : 'Not enough history on all timeframes yet.',
        reasons: [describeConfluence(snapshot)],
      };
    }
  } else {
    const tp = { ...settings.trader, ...preset.trader };
    const tr = trader(cf, tp);
    add('trader', tr, 0);
    add('traderRaw', trader(cf, { ...tp, useEdgeFilter: false }), 0);
    add('hodl', hodl(), 0);
    primary = 'trader';
    signal = tr.diag.lastSignal ?? undefined;
    traderDiag = tr.diag;
    const r = runs[0].result;
    const reasons = [describeConfluence(snapshot)];
    let action: Action;
    let headline: string;
    if (r.openTrade) {
      action = 'HOLD';
      const entry = r.openTrade.cost / r.openTrade.qtyBought;
      headline = `In a trade since ${new Date(r.openTrade.entryTime).toISOString().slice(0, 16).replace('T', ' ')} UTC at ${entry.toFixed(2)}.`;
    } else if (signal?.take) {
      action = 'BUY';
      headline = signal.reason;
    } else {
      action = 'WAIT';
      headline = signal?.reason ?? 'Waiting for data.';
    }
    if (signal) {
      reasons.push(`Round-trip costs: ${signal.costR.toFixed(2)}R. Estimated win chance ${(signal.p * 100).toFixed(0)}% (${signal.samples} past setups).`);
      if (signal.trackN > 0) reasons.push(`Last ${signal.trackN} setups averaged ${signal.trackMean.toFixed(2)}R after costs.`);
    }
    decision = { action, headline, reasons };
  }

  return {
    symbol, mode, isEth, series, startIndex, confluence: cf, snapshot, runs, primary, decision, signal, traderDiag, plan, allocatorState,
    lastClosedTime: series.t[last], price,
  };
}
