/**
 * Reproduces every number in docs/RESEARCH.md from the downloaded Binance data.
 *   node research/download.ts      # fetch data/ (about 170 MB)
 *   node research/run-research.ts  # writes docs/RESEARCH.md
 * In-sample / out-of-sample splits are fixed in advance; nothing here is tuned on
 * the out-of-sample period.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runBacktest, type Strategy } from '../src/engine/backtest.ts';
import { buildConfluence, type Confluence } from '../src/engine/confluence.ts';
import { LogisticModel, tripleBarrier } from '../src/engine/edge.ts';
import { computeMetrics, type Metrics } from '../src/engine/metrics.ts';
import { projectPlan } from '../src/engine/planProjection.ts';
import { convertResult, parseFrankfurter, rateAt, rateFn } from '../src/engine/fx.ts';
import { DEFAULT_SETTINGS, MODES, USD_SETTINGS } from '../src/engine/presets.ts';
import { defaultStartIndex } from '../src/engine/simulate.ts';
import { allocator } from '../src/engine/strategies/allocator.ts';
import { dcaPlan } from '../src/engine/strategies/dcaPlan.ts';
import { hodl } from '../src/engine/strategies/hodl.ts';
import { planPlus } from '../src/engine/strategies/planPlus.ts';
import { edgeFeatures, trader } from '../src/engine/strategies/trader.ts';
import { parseTf } from '../src/engine/timeframe.ts';
import type { KlineRow, Series } from '../src/engine/types.ts';
import { seriesFromRows } from '../src/engine/types.ts';

// market currency for the main tables; the peso view is in its own section
const S = USD_SETTINGS;
const costs = { feeRate: S.feeRate, slippage: S.slippage };
const dataPath = (f: string) => new URL(`../data/${f}`, import.meta.url);
function load(symbol: string, interval: string): Series {
  const p = dataPath(`${symbol}-${interval}.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p.pathname}. Run: node research/download.ts`);
  return seriesFromRows((JSON.parse(readFileSync(p, 'utf8')) as { rows: KlineRow[] }).rows, parseTf(interval).ms);
}
const idx = (s: Series, iso: string) => {
  const t = Date.parse(iso);
  const k = s.t.findIndex((x) => x >= t);
  return k < 0 ? s.t.length : k;
};
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '–');
const pf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '∞');
const share = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '–');
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const md: string[] = [];
const out = (line = '') => {
  md.push(line);
  console.log(line);
};

function run(s: Series, strat: Strategy, from: number, to: number, stake: number): Metrics {
  return computeMetrics(runBacktest(s, strat, { initialCash: S.initialCash, costs, startIndex: Math.max(from, 0), endIndex: to, stakingApr: stake }));
}
function row(name: string, m: Metrics) {
  return `| ${name} | ${pct(m.totalReturn)} | ${pct(m.cagr)} | ${pct(m.maxDrawdown, 0)} | ${m.sharpe.toFixed(2)} | ${m.trades} | ${m.trades ? share(m.winRate) : '–'} | ${m.trades ? pf(m.profitFactor) : '–'} | $${m.fees.toFixed(0)} |`;
}
const HEAD = '| Strategy | Return | Per year | Worst drop | Sharpe | Trades | Win rate | Profit factor | Fees |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|';

const LONG_TFS = { baseTf: '1d', tfs: MODES.long.tfs };

function longTerm() {
  const d = load('ETHUSDT', '1d');
  const cf = buildConfluence(d, LONG_TFS);
  const first = defaultStartIndex(d, 'long', S);
  out('## 1. Long-term on ETH (daily candles, 3% staking on held ETH)');
  out();
  out(`Data: ${d.t.length} daily ETHUSDT candles, ${day(d.t[0])} to ${day(d.t[d.t.length - 1])}. Start capital $${S.initialCash.toLocaleString('en-US')}, buys of $${S.plan.buyAmount} a week, fee ${(S.feeRate * 100).toFixed(2)}% per fill, slippage ${(S.slippage * 100).toFixed(2)}%. Sections 1-4 are in US dollars (the market's currency); section 5 shows the same plan in pesos.`);
  out('In-sample = 2018-2022 (used when choosing defaults), out-of-sample = 2023 to now (never used for choices).');
  out();
  const periods: [string, number, number][] = [
    [`In-sample ${day(d.t[first])} to 2022-12-31`, first, idx(d, '2023-01-01')],
    ['Out-of-sample 2023-01-01 to now', idx(d, '2023-01-01'), d.t.length],
    [`Full ${day(d.t[first])} to now`, first, d.t.length],
  ];
  for (const [label, a, b] of periods) {
    out(`### ${label}`);
    out();
    out(HEAD);
    out(row('Buy & hold + staking', run(d, hodl(), a, b, S.ethStakingApr)));
    out(row('**My plan** (DCA 1500-1700, sell 4000)', run(d, dcaPlan(S.plan), a, b, S.ethStakingApr)));
    out(row('Plan + confluence timing', run(d, planPlus(cf, S.plan, S.planPlus), a, b, S.ethStakingApr)));
    out(row('Confluence allocator', run(d, allocator(cf, S.allocator), a, b, S.ethStakingApr)));
    out();
  }
  const r = runBacktest(d, dcaPlan(S.plan), { initialCash: S.initialCash, costs, startIndex: first, stakingApr: S.ethStakingApr });
  out('Cycles of your plan (buy in zone, sell at target):');
  out();
  out('| Bought from | Sold | Avg buy | Sell | Profit |');
  out('|---|---|---:|---:|---:|');
  for (const t of r.trades) out(`| ${day(t.entryTime)} | ${day(t.exitTime)} | ${t.avgBuyFill.toFixed(0)} | ${t.avgSellFill.toFixed(0)} | ${pct(t.pnlPct)} |`);
  if (r.openTrade) out(`| ${day(r.openTrade.entryTime)} | open | ${(r.openTrade.buyNotional / r.openTrade.qtyBought).toFixed(0)} | – | – |`);
  out();
}

function otherCoins() {
  out('## 2. Long-term on other coins: confluence allocator vs buy & hold (no staking)');
  out();
  out('| Coin | Period | Allocator return | Allocator worst drop | Hold return | Hold worst drop |');
  out('|---|---|---:|---:|---:|---:|');
  for (const sym of ['BTCUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT']) {
    const d = load(sym, '1d');
    const cf: Confluence = buildConfluence(d, LONG_TFS);
    const first = defaultStartIndex(d, 'long', S);
    for (const [label, a, b] of [['2023 to now (out-of-sample)', Math.max(first, idx(d, '2023-01-01')), d.t.length], [`${day(d.t[first])} to now`, first, d.t.length]] as [string, number, number][]) {
      const al = run(d, allocator(cf, S.allocator), a, b, 0);
      const h = run(d, hodl(), a, b, 0);
      out(`| ${sym.replace('USDT', '')} | ${label} | ${pct(al.totalReturn, 0)} | ${pct(al.maxDrawdown, 0)} | ${pct(h.totalReturn, 0)} | ${pct(h.maxDrawdown, 0)} |`);
    }
  }
  out();
}

function edgeStudy(s: Series, spec: { baseTf: string; tfs: string[] }, from: string, sl: number, tp: number, maxBars: number, stride: number) {
  const cf = buildConfluence(s, spec);
  const b = cf.feats[0];
  const cost = 2 * costs.feeRate + 2 * costs.slippage;
  type Smp = { i: number; x: number[]; y: number; r: number; res: number; costR: number };
  const samples: Smp[] = [];
  for (let i = idx(s, from); i < s.t.length - 1; i += stride) {
    if (!(cf.coverage[i] >= 0.75) || !(b.atr[i] > 0)) continue;
    const lab = tripleBarrier(s, i, sl * b.atr[i], tp * b.atr[i], maxBars);
    if (!Number.isFinite(lab.resolveIdx)) continue;
    samples.push({ i, x: edgeFeatures(cf, i), y: lab.win, r: lab.r, res: lab.resolveIdx, costR: cost / ((sl * b.atr[i]) / s.c[i]) });
  }
  // walk-forward: 8 folds, each trained only on outcomes known before the fold starts
  const n = samples.length;
  const fold = Math.floor(n / 10);
  const oos: { p: number; y: number; net: number }[] = [];
  for (let f = 2; f < 10; f++) {
    const a = f * fold;
    const z = f === 9 ? n : (f + 1) * fold;
    const train = samples.slice(0, a).filter((x) => x.res <= samples[a].i).slice(-20000);
    const m = new LogisticModel().fit(train.map((x) => x.x), train.map((x) => x.y), 4);
    for (let k = a; k < z; k++) oos.push({ p: m.predict(samples[k].x), y: samples[k].y, net: samples[k].r - samples[k].costR });
  }
  const sorted = [...oos].sort((p, q) => p.p - q.p);
  let rank = 0;
  let pos = 0;
  sorted.forEach((o, k) => {
    if (o.y) {
      rank += k + 1;
      pos++;
    }
  });
  const auc = (rank - (pos * (pos + 1)) / 2) / (pos * (oos.length - pos));
  const top = sorted.slice(Math.floor(sorted.length * 0.9));
  const mean = (a: number[]) => a.reduce((p, q) => p + q, 0) / Math.max(1, a.length);
  return {
    n,
    baseWin: mean(samples.map((x) => x.y)),
    grossR: mean(samples.map((x) => x.r)),
    costR: mean(samples.map((x) => x.costR)),
    auc,
    topDecileNetR: mean(top.map((x) => x.net)),
  };
}

function shortTerm() {
  out('## 3. Day trading, swing and scalping on ETH');
  out();
  out('### Is there a predictable edge after costs? (walk-forward, all bars)');
  out();
  out('Each sampled bar is a hypothetical long with an ATR stop and a 2x target. A logistic model over all confluence features predicts the outcome, trained only on outcomes known before each test fold. AUC 0.5 = coin flip. "Top 10%" = the 10% of bars the model liked most, after costs.');
  out();
  out('| Style | Samples | Target hit before stop | Avg outcome before costs | Costs per trade | Model AUC (out-of-sample) | Top 10% after costs |');
  out('|---|---:|---:|---:|---:|---:|---:|');
  const cases: [string, Series, { baseTf: string; tfs: string[] }, string, number, number, number, number][] = [
    ['Day trade, 15m (2021+)', load('ETHUSDT', '15m'), { baseTf: '15m', tfs: MODES.day.tfs }, '2021-01-01', 2, 4, 96, 4],
    ['Swing, 1h (2019+)', load('ETHUSDT', '1h'), { baseTf: '1h', tfs: MODES.swing.tfs }, '2019-01-01', 3, 6, 120, 1],
  ];
  for (const [label, s, spec, from, sl, tp, mb, stride] of cases) {
    const e = edgeStudy(s, spec, from, sl, tp, mb, stride);
    out(`| ${label} | ${e.n.toLocaleString('en-US')} | ${share(e.baseWin)} | ${e.grossR.toFixed(3)}R | ${e.costR.toFixed(2)}R | ${e.auc.toFixed(3)} | ${e.topDecileNetR.toFixed(2)}R |`);
  }
  out();
  out('### Backtests of the confluence trader (long only, 1% risk per trade)');
  out();
  const configs: [string, string, string, string][] = [
    ['Scalp', 'scalp', '1m', '2025-11-15'],
    ['Day trade', 'day', '15m', '2021-01-01'],
    ['Swing', 'swing', '1h', '2019-01-01'],
  ];
  for (const [label, mode, iv, from] of configs) {
    const s = load('ETHUSDT', iv);
    const preset = MODES[mode as 'scalp'];
    const cf = buildConfluence(s, { baseTf: preset.baseTf, tfs: preset.tfs });
    const a = idx(s, from);
    const tp = { ...S.trader, ...preset.trader };
    const gated = trader(cf, tp);
    const g = run(s, gated, a, s.t.length, 0);
    out(`#### ${label} (${iv} candles, ${day(s.t[a])} to ${day(s.t[s.t.length - 1])})`);
    out();
    out(HEAD);
    out(row('Buy & hold', run(s, hodl(), a, s.t.length, 0)));
    out(row('Every signal, no edge filter', run(s, trader(cf, { ...tp, useEdgeFilter: false }), a, s.t.length, 0)));
    out(row('**With edge filter** (default)', g));
    out();
    out(`Setups found: ${gated.diag.candidates.toLocaleString('en-US')}, traded: ${gated.diag.taken}, skipped for lack of proven edge: ${gated.diag.skippedNoEdge.toLocaleString('en-US')}.`);
    out();
  }
}

function projection() {
  const d = load('ETHUSDT', '1d');
  const start = defaultStartIndex(d, 'long', S);
  out('## 4. Projection of your plan from today');
  out();
  out(`ETH last daily close: ${d.c[d.c.length - 1].toFixed(2)} (${day(d.t[d.t.length - 1])}). 1,000 synthetic 3-year futures, each built from random 30-day blocks of real ETH days since 2021, with your plan continuing from its simulated state today.`);
  out();
  out('| Scenario | Target within 6 months | 1 year | 2 years | 3 years | Plan value in 3y (10th / 50th / 90th pct) | Today |');
  out('|---|---:|---:|---:|---:|---|---:|');
  for (const demean of [false, true]) {
    const pj = projectPlan(d, S, { startIndex: start, days: 1095, paths: 1000, demean, bootstrapFrom: idx(d, '2021-01-01'), seed: 2026 });
    const h = (days: number) => share(pj.hitBy.find((x) => x.days === days)?.prob ?? NaN);
    out(`| ${demean ? 'No trend (volatility only)' : 'Historical trend kept'} | ${h(180)} | ${h(365)} | ${h(730)} | ${h(1095)} | $${pj.planValue.p10.toFixed(0)} / $${pj.planValue.p50.toFixed(0)} / $${pj.planValue.p90.toFixed(0)} | $${pj.planNow.toFixed(0)} |`);
  }
  out();
}

function pesos() {
  const p = dataPath('USDPHP.json');
  if (!existsSync(p)) {
    out('## 5. Your plan in Philippine pesos');
    out();
    out('Skipped: data/USDPHP.json is missing (run research/download.ts).');
    return;
  }
  const fx = parseFrankfurter(JSON.parse(readFileSync(p, 'utf8')), 'PHP');
  const rate = rateFn(fx);
  const P = DEFAULT_SETTINGS; // pesos: P500,000 start, P25,000 weekly buys
  const d = load('ETHUSDT', '1d');
  const cf = buildConfluence(d, LONG_TFS);
  const first = defaultStartIndex(d, 'long', P);
  const runP = (strat: Strategy, a: number, b: number) =>
    computeMetrics(convertResult(runBacktest(d, strat, { initialCash: P.initialCash / rate(d.t[a]), costs, startIndex: a, endIndex: b, stakingApr: P.ethStakingApr }), rate));
  out('## 5. Your plan in Philippine pesos');
  out();
  out(`Start ₱${P.initialCash.toLocaleString('en-US')}, buys of ₱${P.plan.buyAmount.toLocaleString('en-US')} converted at each day's USD/PHP reference rate (European Central Bank via Frankfurter). The peso went from ₱${rateAt(fx, d.t[first]).toFixed(2)} per $1 on ${day(d.t[first])} to ₱${rateAt(fx, d.t[d.t.length - 1]).toFixed(2)} on ${day(d.t[d.t.length - 1])}, so peso returns are higher than dollar returns.`);
  out();
  for (const [label, a, b] of [['Out-of-sample 2023-01-01 to now', idx(d, '2023-01-01'), d.t.length], [`Full ${day(d.t[first])} to now`, first, d.t.length]] as [string, number, number][]) {
    out(`### ${label} (in pesos)`);
    out();
    out('| Strategy | Return | Per year | Worst drop | Final value |');
    out('|---|---:|---:|---:|---:|');
    const rows: [string, Strategy][] = [
      ['Buy & hold + staking', hodl()],
      ['**My plan** (DCA $1500-1700, sell $4000)', dcaPlan(P.plan, undefined, rate)],
      ['Plan + confluence timing', planPlus(cf, P.plan, P.planPlus, undefined, rate)],
      ['Confluence allocator', allocator(cf, P.allocator)],
    ];
    for (const [name, strat] of rows) {
      const m = runP(strat, a, b);
      out(`| ${name} | ${pct(m.totalReturn)} | ${pct(m.cagr)} | ${pct(m.maxDrawdown, 0)} | ₱${Math.round(m.finalEquity).toLocaleString('en-US')} |`);
    }
    out();
  }
}

const t0 = Date.now();
out('# Research results');
out();
out(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`research/run-research.ts\` from Binance spot data. All results are simulations after fees and slippage; past results do not guarantee future results.`);
out();
longTerm();
otherCoins();
shortTerm();
projection();
pesos();
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../docs/RESEARCH.md', import.meta.url), md.join('\n') + '\n');
