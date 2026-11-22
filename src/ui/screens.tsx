import { useEffect, useMemo, useState } from 'preact/hooks';
import type { PlanProjection } from '../engine/planProjection.ts';
import { MODES, type ModeId } from '../engine/presets.ts';
import { DAY, parseTf } from '../engine/timeframe.ts';
import type { ModeView } from '../worker/viewModel.ts';
import { LinesChart, PriceChart, resolveColor, SERIES_COLORS, type PriceLine } from './charts.tsx';
import { ChangeChip, ConfluenceCard, DecisionCard, Icon, ModePicker, PerformanceCard, PlanCard, Progress, Segmented, SetupCard, TradesCard } from './components.tsx';
import type { Controller } from './controller.ts';
import { baseSymbol, fmtAgo, fmtDate, fmtDays, fmtPct, fmtPrice, fmtUsd, fmtYears } from './format.ts';

export function useController(c: Controller) {
  const [, setV] = useState(0);
  useEffect(() => c.subscribe(() => setV(c.version)), [c]);
  return c;
}

function ModeBody(props: { c: Controller; symbol: string; mode: ModeId }) {
  const { c, symbol, mode } = props;
  useEffect(() => {
    void c.ensure(symbol, mode);
    return c.watch(symbol, mode);
  }, [symbol, mode]);
  const st = c.state(symbol, mode);
  const view = c.view(symbol, mode);
  const preset = MODES[mode];
  if (!view) {
    if (st.phase === 'error') {
      return (
        <div class="card stack">
          <div class="banner error">{st.error}</div>
          <button class="btn primary" type="button" onClick={() => c.retry(symbol, mode)}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div class="card stack">
        <Progress
          value={st.phase === 'compute' ? 1 : st.progress}
          label={st.phase === 'compute' ? 'Simulating every strategy across all timeframes…' : `Downloading ${preset.baseTf} candles from Binance… ${Math.round(st.progress * 100)}%`}
        />
        <div class="skeleton" style={{ width: '70%' }} />
        <div class="skeleton" style={{ width: '45%' }} />
      </div>
    );
  }
  return <ModeContent c={c} view={view} computing={st.phase === 'compute'} error={st.phase === 'error' ? st.error : undefined} />;
}

function ModeContent(props: { c: Controller; view: ModeView; computing: boolean; error?: string }) {
  const { c, view } = props;
  const forming = c.forming(view.symbol, view.mode);
  const primaryRun = view.runs.find((r) => r.id === view.primary);
  const lines: PriceLine[] = useMemo(() => {
    const out: PriceLine[] = [];
    if (view.mode === 'long' && view.isEth && view.plan) {
      out.push({ price: view.plan.zoneLow, title: 'zone', kind: 'zone' }, { price: view.plan.zoneHigh, title: 'zone', kind: 'zone' }, { price: view.plan.target, title: 'target', kind: 'target' });
    }
    const open = primaryRun?.open;
    if (open?.stop) out.push({ price: open.stop, title: 'stop', kind: 'stop' });
    return out;
  }, [view]);
  return (
    <div class="stack">
      {props.error && <div class="banner error">{props.error}</div>}
      <DecisionCard view={view} />
      {view.plan && <PlanCard plan={view.plan} run={primaryRun} price={view.price} staking={c.settings.ethStakingApr} buyAmount={c.settings.plan.buyAmount} buyEveryDays={c.settings.plan.buyEveryDays} />}
      {view.mode !== 'long' && <SetupCard view={view} />}
      <section class="card">
        <div class="row between" style={{ marginBottom: '8px' }}>
          <h2 style={{ margin: 0 }}>
            {baseSymbol(view.symbol)} · {MODES[view.mode].baseTf} candles
          </h2>
          <span class="tiny faint">{props.computing ? 'updating…' : `last candle closed ${fmtAgo(view.lastClosedTime + parseTf(MODES[view.mode].baseTf).ms)}`}</span>
        </div>
        <PriceChart t={view.chart.t} o={view.chart.o} h={view.chart.h} l={view.chart.l} c={view.chart.c} markers={view.chart.markers} forming={forming} lines={lines} label={`${view.symbol} price chart with ${primaryRun?.name ?? ''} trades`} />
        <div class="legend">
          <span>▲ buy · ▼ sell ({primaryRun?.name})</span>
          {lines.some((l) => l.kind === 'zone') && <span>dashed: your buy zone · solid: your target</span>}
        </div>
      </section>
      <ConfluenceCard view={view} />
      <PerformanceCard view={view} />
      <TradesCard run={primaryRun} symbol={view.symbol} />
      <div class="footer-note">
        Simulation only, no real orders. Market data: Binance public API. Fees {fmtPct(c.settings.feeRate, 3, false)} per fill, slippage {fmtPct(c.settings.slippage, 2, false)}. Computed in {view.computeMs} ms.
      </div>
    </div>
  );
}

export function AssetScreen(props: { c: Controller; symbol: string; mode: ModeId; onMode: (m: ModeId) => void; onBack?: () => void }) {
  const { c, symbol, mode } = props;
  useEffect(() => c.watchTickers([symbol]), [symbol]);
  const t = c.tickers.get(symbol);
  const view = c.view(symbol, mode);
  const price = t?.price ?? c.forming(symbol, mode)?.c ?? view?.price;
  return (
    <div class="stack">
      {props.onBack && (
        <button class="back" type="button" onClick={props.onBack}>
          {Icon.back} Coins
        </button>
      )}
      <div class="pricehead">
        <div>
          <div class="sym">{baseSymbol(symbol)} / USDT</div>
          <div class="px" aria-live="polite">{price !== undefined ? fmtPrice(price) : '–'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <ChangeChip pct={t?.changePct} />
          <div class="tiny faint" style={{ marginTop: '4px' }}>24h</div>
        </div>
      </div>
      <ModePicker value={mode} onChange={props.onMode} />
      <div class="note">{MODES[mode].blurb}</div>
      <ModeBody c={c} symbol={symbol} mode={mode} />
    </div>
  );
}

export function CoinsScreen(props: { c: Controller }) {
  const { c } = props;
  const coins = c.settings.coins;
  const mode = c.ui.coinsMode;
  useEffect(() => c.watchTickers(coins), [coins.join(',')]);
  // work through the list one coin at a time so the phone stays responsive
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const sym of coins) {
        if (cancelled) return;
        await c.ensure(sym, mode).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, coins.join(',')]);
  if (c.ui.coin) {
    return <AssetScreen c={c} symbol={c.ui.coin} mode={mode} onMode={(m) => c.setUi({ coinsMode: m })} onBack={() => c.setUi({ coin: null })} />;
  }
  return (
    <div class="stack">
      <div class="pricehead">
        <div>
          <div class="sym">OTHER COINS</div>
          <div style={{ fontSize: '22px', fontWeight: 700 }}>Market scan</div>
        </div>
      </div>
      <ModePicker value={mode} onChange={(m) => c.setUi({ coinsMode: m })} />
      <section class="card" style={{ paddingBlock: '4px' }}>
        <div class="list">
          {coins.map((sym) => {
            const t = c.tickers.get(sym);
            const v = c.view(sym, mode);
            const st = c.state(sym, mode);
            const run = v?.runs.find((r) => r.id === v.primary);
            return (
              <button class="item coin" type="button" onClick={() => c.setUi({ coin: sym })}>
                <div class="main">
                  <div class="title">{baseSymbol(sym)}</div>
                  <div class="sub">
                    {v
                      ? `${run?.name}: ${fmtPct(run?.metrics.totalReturn ?? NaN, 0)} since ${fmtDate(v.simStart)}`
                      : st.phase === 'error'
                        ? st.error
                        : st.phase === 'download'
                          ? `Downloading… ${Math.round(st.progress * 100)}%`
                          : st.phase === 'compute'
                            ? 'Simulating…'
                            : 'Queued'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div class="num" style={{ fontWeight: 650 }}>{t ? fmtPrice(t.price) : '–'}</div>
                  <ChangeChip pct={t?.changePct} />
                </div>
                <span class={`pill ${v?.decision.action ?? 'WAIT'}`} style={{ minWidth: '56px', fontSize: '12px', padding: '6px 6px' }}>
                  {v?.decision.action ?? '…'}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <div class="footer-note">Tap a coin for its full confluence, backtest and live signals. Edit the list in Settings.</div>
    </div>
  );
}

function BandBar(props: { lo: number; q1: number; med: number; q3: number; hi: number; now: number; min: number; max: number; color: string }) {
  const x = (v: number) => `${Math.min(100, Math.max(0, ((v - props.min) / (props.max - props.min || 1)) * 100))}%`;
  return (
    <div class="band" role="img" aria-label={`Range ${fmtUsd(props.lo)} to ${fmtUsd(props.hi)}, middle ${fmtUsd(props.med)}`}>
      <div class="wide" style={{ left: x(props.lo), width: `calc(${x(props.hi)} - ${x(props.lo)})`, background: props.color }} />
      <div class="iqr" style={{ left: x(props.q1), width: `calc(${x(props.q3)} - ${x(props.q1)})`, background: props.color }} />
      <div class="med" style={{ left: x(props.med) }} />
      <div class="now" style={{ left: x(props.now) }} />
    </div>
  );
}

export function ProjectionScreen(props: { c: Controller }) {
  const { c } = props;
  const [years, setYears] = useState<'1' | '2' | '3'>('3');
  const [drift, setDrift] = useState<'hist' | 'zero'>('hist');
  const [windowSel, setWindowSel] = useState<'2021' | 'all'>('2021');
  const [pj, setPj] = useState<PlanProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const longView = c.view('ETHUSDT', 'long');
  const modeView = c.view('ETHUSDT', c.ui.ethMode);
  useEffect(() => {
    void c.ensure('ETHUSDT', 'long');
  }, []);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr(null);
    c.projectPlan({ days: Number(years) * 365, demean: drift === 'zero', bootstrapFrom: windowSel === '2021' ? Date.UTC(2021, 0, 1) : 0 })
      .then((r) => alive && setPj(r))
      .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [years, drift, windowSel, c.settings]);

  const fan = useMemo(() => {
    if (!pj) return null;
    const t0 = longView?.lastClosedTime ?? Date.now();
    const t = pj.pricePaths.p50.map((_, k) => t0 + (k + 1) * DAY);
    return {
      lines: [
        { name: 'Median', color: resolveColor('var(--accent)'), t, v: pj.pricePaths.p50, width: 2 },
        { name: 'Target', color: resolveColor('var(--hold)'), t: [t[0], t[t.length - 1]], v: [pj.target, pj.target], width: 1, dashed: true },
      ],
      area: { t, lo: pj.pricePaths.p10, hi: pj.pricePaths.p90, color: 'rgba(120,130,220,0.22)' },
    };
  }, [pj]);

  const all = pj ? [pj.planValue.p10, pj.hodlValue.p10, pj.planValue.p90, pj.hodlValue.p90, pj.planNow] : [0, 1];
  const min = Math.min(...all);
  const max = Math.max(...all);
  return (
    <div class="stack">
      <div class="pricehead">
        <div>
          <div class="sym">PROJECTIONS</div>
          <div style={{ fontSize: '22px', fontWeight: 700 }}>Where the plan could go</div>
        </div>
      </div>
      <section class="card">
        <h2>Your ETH plan, simulated forward</h2>
        <div class="stack">
          <Segmented label="Horizon" value={years} onChange={setYears} options={[{ id: '1', label: '1 year' }, { id: '2', label: '2 years' }, { id: '3', label: '3 years' }]} />
          <Segmented label="Drift" value={drift} onChange={setDrift} options={[{ id: 'hist', label: 'Historical trend' }, { id: 'zero', label: 'No trend' }]} />
          <Segmented label="History used" value={windowSel} onChange={setWindowSel} options={[{ id: '2021', label: 'Since 2021' }, { id: 'all', label: 'Since 2017' }]} />
          {err && <div class="banner error">{err}</div>}
          {!pj && busy && <Progress value={0.6} label="Simulating 300 possible futures…" />}
          {pj && (
            <>
              <div class="note">
                {pj.paths} futures built from random 30-day blocks of real ETH history, each continuing your plan from today's state ({fmtUsd(pj.planNow)}).{' '}
                {drift === 'zero' ? 'The average trend is removed, so only the volatility is kept.' : 'The historical average trend is kept.'}
                {busy ? ' Updating…' : ''}
              </div>
              <div>
                <div class="small" style={{ fontWeight: 650, marginBottom: '8px' }}>
                  Chance ETH reaches your {fmtPrice(pj.target)} target
                </div>
                <div class="probs">
                  {pj.hitBy.map((h) => (
                    <div class="prob">
                      <span class="muted">{h.days >= 365 ? `${h.days / 365} yr` : `${Math.round(h.days / 30)} mo`}</span>
                      <div class="bar">
                        <div style={{ width: `${h.prob * 100}%` }} />
                      </div>
                      <strong>{fmtPct(h.prob, 0, false)}</strong>
                    </div>
                  ))}
                </div>
                <div class="note" style={{ marginTop: '8px' }}>
                  {pj.medianDaysToTarget ? `Half of the futures reach it within ${fmtDays(pj.medianDaysToTarget)}.` : `Fewer than half of the futures reach it within ${years} year${years === '1' ? '' : 's'}.`}
                </div>
              </div>
              <div class="divider" />
              <div class="stack" style={{ gap: '10px' }}>
                <div class="small" style={{ fontWeight: 650 }}>Portfolio value in {years} year{years === '1' ? '' : 's'}</div>
                <div class="bandrow">
                  <div class="row between small">
                    <span>Your plan</span>
                    <span class="num">
                      {fmtUsd(pj.planValue.p10)} – <strong>{fmtUsd(pj.planValue.p50)}</strong> – {fmtUsd(pj.planValue.p90)}
                    </span>
                  </div>
                  <BandBar lo={pj.planValue.p10} q1={pj.planValue.p25} med={pj.planValue.p50} q3={pj.planValue.p75} hi={pj.planValue.p90} now={pj.planNow} min={min} max={max} color="var(--accent)" />
                </div>
                <div class="bandrow">
                  <div class="row between small">
                    <span>All in ETH today, staked</span>
                    <span class="num">
                      {fmtUsd(pj.hodlValue.p10)} – <strong>{fmtUsd(pj.hodlValue.p50)}</strong> – {fmtUsd(pj.hodlValue.p90)}
                    </span>
                  </div>
                  <BandBar lo={pj.hodlValue.p10} q1={pj.hodlValue.p25} med={pj.hodlValue.p50} q3={pj.hodlValue.p75} hi={pj.hodlValue.p90} now={pj.planNow} min={min} max={max} color="var(--hold)" />
                </div>
                <div class="note">
                  Bars: 10th to 90th percentile, thicker part 25th to 75th, black tick the median, dashed line today's value. Plan ends higher than today in {fmtPct(pj.planProbGain, 0, false)} of futures
                  and doubles in {fmtPct(pj.planProbDouble, 0, false)}.
                </div>
              </div>
              <div class="divider" />
              <div class="small" style={{ fontWeight: 650 }}>ETH price paths (10th, 50th, 90th percentile)</div>
              {fan && <LinesChart lines={fan.lines} area={fan.area} label="Projected ETH price range" small />}
            </>
          )}
        </div>
      </section>
      {modeView && <GrowthCard view={modeView} />}
    </div>
  );
}

function GrowthCard(props: { view: ModeView }) {
  const v = props.view;
  const days = v.runs[0]?.metrics.days ?? 0;
  if (days < 90) {
    return (
      <section class="card">
        <h2>Projection from earnings rate ({MODES[v.mode].label})</h2>
        <div class="note">
          The {MODES[v.mode].label.toLowerCase()} window covers {Math.round(days)} days. That is too short to turn into a yearly rate without misleading you, so no
          projection is shown. Switch the ETH tab to Long-term or Swing to project from a longer record.
        </div>
      </section>
    );
  }
  return (
    <section class="card">
      <h2>Projection from each strategy's earnings rate ({MODES[v.mode].label})</h2>
      <div class="scroll-x">
        <table class="table">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Rate / yr</th>
              <th>Doubles in</th>
              <th>1 yr</th>
              <th>3 yr</th>
              <th>3 yr range (5-95%)</th>
            </tr>
          </thead>
          <tbody>
            {v.runs.map((r, k) => {
              const b3 = r.projection.bands.find((b) => b.days === 1095);
              return (
                <tr class={r.id === v.primary ? 'primary' : ''}>
                  <td>
                    <span class="dot" style={{ background: SERIES_COLORS[k % SERIES_COLORS.length] }} />
                    {r.name}
                  </td>
                  <td>{fmtPct(r.projection.cagr, 1)}</td>
                  <td>{fmtYears(r.projection.yearsToDouble)}</td>
                  <td>{fmtUsd(r.projection.compound[0].value, true)}</td>
                  <td>{fmtUsd(r.projection.compound[2].value, true)}</td>
                  <td>{b3 ? `${fmtUsd(b3.p5, true)} – ${fmtUsd(b3.p95, true)}` : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div class="note">
        "1 yr" and "3 yr" compound today's value at the realised yearly rate. The range comes from 1,000 Monte Carlo runs that re-sample the strategy's own daily results in 20-day
        blocks. Past rates are not a promise: short windows (day trading, scalping) give especially unreliable rates.
      </div>
    </section>
  );
}
