import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { ALL_KEYS, COMPONENT_LABELS } from '../engine/features.ts';
import { MODE_ORDER, MODES, type ModeId } from '../engine/presets.ts';
import type { PlanState, StrategyId } from '../engine/simulate.ts';
import type { ModeView, RunView, TfRowView, TradeView } from '../worker/viewModel.ts';
import { LinesChart, resolveColor, SERIES_COLORS } from './charts.tsx';
import { fmtDate, fmtNum, fmtPct, fmtPrice, fmtQty, fmtUsd, scoreStyle } from './format.ts';

export const Icon = {
  eth: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 2.5 5.5 12.2 12 16l6.5-3.8L12 2.5Z" />
      <path d="M5.5 13.6 12 21.5l6.5-7.9L12 17.4l-6.5-3.8Z" />
    </svg>
  ),
  coins: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <ellipse cx="9" cy="7" rx="6" ry="3" />
      <path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" />
      <path d="M9 18c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.6-2.4-2.9-5.5-3" />
    </svg>
  ),
  projection: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <path d="M3 20h18" />
      <path d="M4 16l5-5 4 3 7-8" />
      <path d="M15 6h5v5" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
};

export function Card(props: { title?: string; children: ComponentChildren; id?: string }) {
  return (
    <section class="card" id={props.id}>
      {props.title && <h2>{props.title}</h2>}
      {props.children}
    </section>
  );
}

export function Segmented<T extends string>(props: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" aria-pressed={o.id === props.value} onClick={() => props.onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ModePicker(props: { value: ModeId; onChange: (m: ModeId) => void }) {
  return <Segmented label="Trading style" value={props.value} onChange={props.onChange} options={MODE_ORDER.map((id) => ({ id, label: MODES[id].label }))} />;
}

export function ChangeChip(props: { pct: number | undefined }) {
  const p = props.pct;
  if (p === undefined || !Number.isFinite(p)) return <span class="chip flat">–</span>;
  return <span class={`chip ${p > 0.0005 ? 'up' : p < -0.0005 ? 'down' : 'flat'}`}>{fmtPct(p, 2)}</span>;
}

export function Progress(props: { value: number; label: string }) {
  return (
    <div class="stack" style={{ gap: '6px' }}>
      <div class="small muted">{props.label}</div>
      <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(props.value * 100)}>
        <div style={{ width: `${Math.max(4, props.value * 100)}%` }} />
      </div>
    </div>
  );
}

export function DecisionCard(props: { view: ModeView }) {
  const d = props.view.decision;
  return (
    <section class="card" aria-live="polite">
      <h2>Decision now</h2>
      <div class="decision">
        <span class={`pill ${d.action}`}>{d.action}</span>
        <div>
          <div class="headline">{d.headline}</div>
          {d.reasons.length > 0 && (
            <ul class="reasons">
              {d.reasons.map((r) => (
                <li>{r}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Gauge(props: { value: number; label: string }) {
  const v = Number.isFinite(props.value) ? props.value : 0;
  return (
    <div class="stack" style={{ gap: '6px' }}>
      <div class="row between small">
        <span class="muted">{props.label}</span>
        <span class="num" style={{ fontWeight: 700 }}>{Number.isFinite(props.value) ? fmtNum(props.value, 2) : '–'}</span>
      </div>
      <div class="gauge" role="meter" aria-valuemin={-1} aria-valuemax={1} aria-valuenow={v} aria-label={props.label}>
        <span class="tick" style={{ left: `${((v + 1) / 2) * 100}%` }} />
      </div>
      <div class="row between tiny faint">
        <span>Sell</span>
        <span>Neutral</span>
        <span>Buy</span>
      </div>
    </div>
  );
}

function TfRow(props: { r: TfRowView }) {
  const [open, setOpen] = useState(false);
  const r = props.r;
  const cell = (v: number) => (
    <td style={scoreStyle(v)}>{Number.isFinite(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(0) : '·'}</td>
  );
  return (
    <>
      <tr>
        <td class="tf">
          <button class="tfbtn" type="button" aria-expanded={open} onClick={() => setOpen(!open)} title="Show every algorithm on this timeframe">
            {r.tf}
            {r.custom && <sup title="Custom timeframe built from smaller candles">✱</sup>}
          </button>
        </td>
        {cell(r.trend)}
        {cell(r.mom)}
        {cell(r.rev)}
        {cell(r.dir)}
        <td class="num" style={{ color: 'var(--muted)', fontWeight: 500 }}>{Number.isFinite(r.rsi) ? r.rsi.toFixed(0) : '·'}</td>
      </tr>
      {open && (
        <tr class="expand">
          <td colSpan={6}>
            <div class="comp small">
              {ALL_KEYS.map((k) => (
                <>
                  <span class="muted">{COMPONENT_LABELS[k]}</span>
                  <span class="num" style={{ color: Number.isFinite(r.components[k]) ? (r.components[k] > 0.2 ? 'var(--buy)' : r.components[k] < -0.2 ? 'var(--sell)' : 'var(--muted)') : 'var(--faint)' }}>
                    {Number.isFinite(r.components[k]) ? fmtNum(r.components[k], 2) : 'warming up'}
                  </span>
                </>
              ))}
              <span class="muted">Candle used</span>
              <span class="num">{r.barTime ? fmtDate(r.barTime, true) : '–'}</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function ConfluenceCard(props: { view: ModeView }) {
  const s = props.view.snapshot;
  const total = s.votes.bull + s.votes.bear + s.votes.neutral;
  return (
    <section class="card">
      <h2>Confluence across timeframes</h2>
      <div class="stack" style={{ gap: '14px' }}>
        <Gauge value={s.D} label="Overall score (higher timeframes weigh more)" />
        <div class="stack" style={{ gap: '6px' }}>
          <div class="row between small">
            <span class="muted">Agreement by weight</span>
            <span class="num">
              <span class="buy">{fmtPct(s.A, 0, false)} up</span> · <span class="sell">{fmtPct(s.B, 0, false)} down</span>
            </span>
          </div>
          <div class="agree" aria-hidden="true">
            <div class="b" style={{ width: `${(s.A || 0) * 100}%` }} />
            <div style={{ flex: 1 }} />
            <div class="s" style={{ width: `${(s.B || 0) * 100}%` }} />
          </div>
          <div class="tiny faint">
            {total} algorithm readings: {s.votes.bull} bullish, {s.votes.bear} bearish, {s.votes.neutral} neutral
          </div>
        </div>
        <div class="scroll-x">
          <table class="matrix">
            <thead>
              <tr>
                <th>TF</th>
                <th title="EMA 20/50, EMA 200, MACD, ADX/DMI, Supertrend, Donchian, regression slope">Trend</th>
                <th title="RSI, MFI, OBV flow, rate of change, MACD histogram">Momentum</th>
                <th title="Bollinger %B, Stochastic RSI, z-score: positive = stretched down">Stretch</th>
                <th>Score</th>
                <th>RSI</th>
              </tr>
            </thead>
            <tbody>
              {s.perTf.map((r) => (
                <TfRow r={r} />
              ))}
            </tbody>
          </table>
        </div>
        <div class="tiny faint">Tap a timeframe to see all 15 algorithms. ✱ marks custom timeframes built from smaller candles. Scores use only finished candles.</div>
      </div>
    </section>
  );
}

export function PlanCard(props: { plan: PlanState; run: RunView | undefined; price: number; staking: number; buyAmount: number; buyEveryDays: number }) {
  const p = props.plan;
  const run = props.run;
  const zonePos = Math.min(1, Math.max(0, (props.price - p.zoneLow * 0.8) / (p.target * 1.05 - p.zoneLow * 0.8)));
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - p.zoneLow * 0.8) / (p.target * 1.05 - p.zoneLow * 0.8)) * 100))}%`;
  return (
    <section class="card">
      <h2>My plan</h2>
      <div class="stack">
        <div style={{ position: 'relative', height: '34px' }} aria-label="Price relative to your buy zone and target" role="img">
          <div style={{ position: 'absolute', top: '14px', left: 0, right: 0, height: '6px', borderRadius: '3px', background: 'var(--wait-soft)' }} />
          <div style={{ position: 'absolute', top: '10px', height: '14px', borderRadius: '4px', background: 'var(--buy-soft)', border: '1px solid var(--buy)', left: at(p.zoneLow), width: `calc(${at(p.zoneHigh)} - ${at(p.zoneLow)})` }} />
          <div style={{ position: 'absolute', top: '6px', height: '22px', width: '3px', borderRadius: '2px', background: 'var(--accent)', left: at(p.target) }} />
          <div style={{ position: 'absolute', top: '4px', height: '26px', width: '3px', borderRadius: '2px', background: 'var(--ink)', left: `${zonePos * 100}%`, transform: 'translateX(-50%)' }} />
        </div>
        <div class="row between tiny muted">
          <span>Zone {fmtPrice(p.zoneLow)}-{fmtPrice(p.zoneHigh)}</span>
          <span>Now {fmtPrice(props.price)}</span>
          <span>Target {fmtPrice(p.target)}</span>
        </div>
        <div class="kv">
          <div>
            <div class="k">ETH held (staked)</div>
            <div class="v">{fmtQty(p.qty)}</div>
          </div>
          <div>
            <div class="k">Average cost</div>
            <div class="v">{p.avgCost ? fmtPrice(p.avgCost) : '–'}</div>
          </div>
          <div>
            <div class="k">Cash waiting</div>
            <div class="v">{fmtUsd(p.cash)}</div>
          </div>
          <div>
            <div class="k">To target</div>
            <div class="v">{fmtPct(p.toTargetPct, 0)}</div>
          </div>
          {run && (
            <>
              <div>
                <div class="k">Plan value</div>
                <div class="v">{fmtUsd(run.metrics.finalEquity)}</div>
              </div>
              <div>
                <div class="k">Staking earned</div>
                <div class="v">{fmtQty(run.metrics.stakingQty)} ETH</div>
              </div>
            </>
          )}
        </div>
        <div class="note">
          Simulated with your rules from {run ? fmtDate(run.metrics.startTime) : '–'}: buy {fmtUsd(props.buyAmount)} every {props.buyEveryDays === 1 ? 'day' : `${props.buyEveryDays} days`} while the daily close is inside the zone,
          stake at {fmtPct(props.staking, 1, false)} a year, sell at the target. Change the rules in Settings.
        </div>
      </div>
    </section>
  );
}

export function SetupCard(props: { view: ModeView }) {
  const v = props.view;
  const sig = v.signal;
  const tr = v.trader;
  const run = v.runs.find((r) => r.id === 'trader');
  if (!sig || !tr || !run) return null;
  return (
    <section class="card">
      <h2>Trade setup and edge check</h2>
      <div class="stack">
        {run.open && (
          <div class="banner info">
            <strong>Open paper trade:</strong> {fmtQty(run.open.qty)} {v.symbol.replace('USDT', '')} at {fmtPrice(run.open.avgPrice)}, now{' '}
            <span class={run.open.pnl >= 0 ? 'buy' : 'sell'}>{fmtPct(run.open.pnlPct, 2)}</span>
            {run.open.stop ? `, stop ${fmtPrice(run.open.stop)}` : ''}
          </div>
        )}
        <div class="kv">
          <div>
            <div class="k">Timeframes agree</div>
            <div class="v">{sig.regime ? 'Yes, uptrend' : 'No'}</div>
          </div>
          <div>
            <div class="k">Entry trigger</div>
            <div class="v">{sig.pullback ? 'Pullback' : sig.breakout ? 'Breakout' : 'None'}</div>
          </div>
          <div>
            <div class="k">Win chance (model)</div>
            <div class="v">{sig.candidate ? fmtPct(sig.p, 0, false) : 'no setup'}</div>
          </div>
          <div>
            <div class="k">Costs per trade</div>
            <div class="v">{fmtNum(sig.costR, 2)}R</div>
          </div>
          <div>
            <div class="k">Expected value</div>
            <div class={`v ${sig.candidate ? (sig.evR > 0 ? 'buy' : 'sell') : ''}`}>{sig.candidate ? `${fmtNum(sig.evR, 2)}R` : '–'}</div>
          </div>
          <div>
            <div class="k">Recent setups</div>
            <div class={`v ${tr.trackMean > 0 ? 'buy' : 'sell'}`}>{tr.trackN ? `${fmtNum(tr.trackMean, 2)}R` : '–'}</div>
          </div>
        </div>
        <div class="note">
          In this window: {tr.candidates} setups, {tr.taken} traded, {tr.skippedNoEdge} skipped because the edge after fees was not proven. A trade is only taken when the
          expected value after fees is positive <em>and</em> the last setups actually made money after fees. 1R = the amount risked to the stop.
        </div>
      </div>
    </section>
  );
}

const pct = (x: number) => fmtPct(x, 1);

export function StrategyTable(props: { runs: RunView[]; primary: StrategyId; onPick?: (id: StrategyId) => void }) {
  return (
    <div class="scroll-x">
      <table class="table">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Return</th>
            <th>Per year</th>
            <th>Worst drop</th>
            <th>Trades</th>
            <th>Win rate</th>
            <th>Profit factor</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((r, k) => (
            <tr class={r.id === props.primary ? 'primary' : ''} onClick={() => props.onPick?.(r.id)}>
              <td>
                <span class="dot" style={{ background: SERIES_COLORS[k % SERIES_COLORS.length] }} />
                {r.name}
              </td>
              <td class={r.metrics.totalReturn >= 0 ? 'buy' : 'sell'}>{pct(r.metrics.totalReturn)}</td>
              <td title={r.metrics.days < 90 ? 'Window too short to annualise' : undefined}>{r.metrics.days >= 90 ? pct(r.metrics.cagr) : '–'}</td>
              <td class="sell">{fmtPct(r.metrics.maxDrawdown, 0)}</td>
              <td>{r.metrics.trades}</td>
              <td>{r.metrics.trades ? fmtPct(r.metrics.winRate, 0, false) : '–'}</td>
              <td>{r.metrics.trades ? (Number.isFinite(r.metrics.profitFactor) ? fmtNum(r.metrics.profitFactor, 2) : 'no losses') : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PerformanceCard(props: { view: ModeView }) {
  const v = props.view;
  const lines = v.runs.map((r, k) => ({ name: r.name, color: resolveColor(SERIES_COLORS[k % SERIES_COLORS.length]), t: r.equity.t, v: r.equity.v, width: r.id === v.primary ? 3 : 2 }));
  return (
    <section class="card">
      <h2>Backtest: history plus live</h2>
      <div class="stack">
        <StrategyTable runs={v.runs} primary={v.primary} />
        <LinesChart lines={lines} label="Portfolio value of each strategy over time" small />
        <div class="note">
          Same start capital and fees for every strategy, {fmtDate(v.simStart)} to now ({v.bars.toLocaleString('en-US')} candles). Returns are after fees
          {v.mode === 'long' ? ' and include staking' : ''}. Worst drop = largest fall from a peak.{v.runs[0] && v.runs[0].metrics.days < 90 ? ' Yearly rates are hidden: the window is too short to annualise.' : ''}
        </div>
      </div>
    </section>
  );
}

export function TradesCard(props: { run: RunView | undefined; symbol: string }) {
  const [all, setAll] = useState(false);
  const run = props.run;
  if (!run) return null;
  const trades = all ? run.trades : run.trades.slice(0, 8);
  return (
    <section class="card">
      <h2>{run.name}: trades</h2>
      {run.trades.length === 0 ? (
        <div class="note">No completed trades in this window{run.open ? ' (one position is still open)' : ''}.</div>
      ) : (
        <div class="list">
          {trades.map((t: TradeView) => (
            <div class="item">
              <div class="main">
                <div class="title num">
                  {fmtPrice(t.entryPrice)} → {fmtPrice(t.exitPrice)}
                  {t.live && <span class="live-tag">LIVE</span>}
                </div>
                <div class="sub">
                  {fmtDate(t.entryTime, run.id === 'trader' || run.id === 'traderRaw')} · {t.entryReason} · out: {t.exitReason}
                </div>
              </div>
              <div class={`num ${t.pnl >= 0 ? 'buy' : 'sell'}`} style={{ fontWeight: 700, textAlign: 'right' }}>
                {fmtPct(t.pnlPct, 2)}
                <div class="tiny muted">{t.r !== null ? `${fmtNum(t.r, 2)}R` : fmtUsd(t.pnl)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {run.trades.length > 8 && (
        <button class="link small" type="button" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${run.trades.length} recent trades`}
        </button>
      )}
    </section>
  );
}
