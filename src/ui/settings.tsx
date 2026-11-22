import { useState } from 'preact/hooks';
import { clearCandles } from '../data/cache.ts';
import { MODE_ORDER, MODES, type ModeId, type Settings } from '../engine/presets.ts';
import { validateDcaPlan, type TakeProfitLevel } from '../engine/strategies/dcaPlan.ts';
import { isCompatible, parseTf } from '../engine/timeframe.ts';
import type { Controller } from './controller.ts';

/** Text fields hold strings while editing; they are parsed and checked on Apply. */
interface Draft {
  initialCash: string;
  feeRate: string;
  slippage: string;
  ethStakingApr: string;
  otherStakingApr: string;
  zoneLow: string;
  zoneHigh: string;
  buyAmount: string;
  buyEveryDays: string;
  buyBelowZone: boolean;
  repeat: boolean;
  targets: { price: string; fraction: string }[];
  depositAmount: string;
  depositEvery: string;
  longStart: string;
  riskPerTrade: string;
  shadowWindow: string;
  shadowZ: string;
  evMin: string;
  useEdgeFilter: boolean;
  tfs: Record<ModeId, string>;
  coins: string;
}

const pctStr = (x: number) => String(+(x * 100).toFixed(4));

function toDraft(s: Settings): Draft {
  return {
    initialCash: String(s.initialCash),
    feeRate: pctStr(s.feeRate),
    slippage: pctStr(s.slippage),
    ethStakingApr: pctStr(s.ethStakingApr),
    otherStakingApr: pctStr(s.otherStakingApr),
    zoneLow: String(s.plan.zoneLow),
    zoneHigh: String(s.plan.zoneHigh),
    buyAmount: String(s.plan.buyAmount),
    buyEveryDays: String(s.plan.buyEveryDays),
    buyBelowZone: s.plan.buyBelowZone,
    repeat: s.plan.repeat,
    targets: s.plan.takeProfit.map((l) => ({ price: String(l.price), fraction: pctStr(l.fraction) })),
    depositAmount: String(s.plan.contribution?.amount ?? 0),
    depositEvery: String(s.plan.contribution?.everyDays ?? 30),
    longStart: s.longStart,
    riskPerTrade: pctStr(s.trader.riskPerTrade),
    shadowWindow: String(s.trader.shadowWindow),
    shadowZ: String(s.trader.shadowZ),
    evMin: String(s.trader.evMin),
    useEdgeFilter: s.trader.useEdgeFilter,
    tfs: Object.fromEntries(MODE_ORDER.map((m) => [m, (s.customTfs[m]?.length ? s.customTfs[m]! : MODES[m].tfs).join(', ')])) as Record<ModeId, string>,
    coins: s.coins.join(', '),
  };
}

/** Parse and validate a draft. Returns settings or a list of problems to show. */
export function fromDraft(d: Draft, base: Settings): { settings?: Settings; errors: string[] } {
  const errors: string[] = [];
  const num = (v: string, label: string, lo: number, hi: number): number => {
    const x = Number(v.replace(/[, $%]/g, ''));
    if (!Number.isFinite(x) || x < lo || x > hi) {
      errors.push(`${label} must be a number from ${lo} to ${hi}.`);
      return Number.NaN;
    }
    return x;
  };
  const targets: TakeProfitLevel[] = d.targets
    .filter((t) => t.price.trim() !== '')
    .map((t, k) => ({ price: num(t.price, `Target ${k + 1} price`, 0.0001, 1e9), fraction: num(t.fraction, `Target ${k + 1} share`, 1, 100) / 100 }));
  const plan = {
    zoneLow: num(d.zoneLow, 'Buy zone low', 0.0001, 1e9),
    zoneHigh: num(d.zoneHigh, 'Buy zone high', 0.0001, 1e9),
    buyAmount: num(d.buyAmount, 'Buy amount', 1, 1e9),
    buyEveryDays: num(d.buyEveryDays, 'Buy interval', 1, 365),
    buyBelowZone: d.buyBelowZone,
    repeat: d.repeat,
    takeProfit: targets,
    contribution: { amount: num(d.depositAmount, 'Deposit amount', 0, 1e9), everyDays: num(d.depositEvery, 'Deposit interval', 1, 365) },
  };
  if (!errors.length) errors.push(...validateDcaPlan(plan));
  const customTfs: Partial<Record<ModeId, string[]>> = {};
  for (const m of MODE_ORDER) {
    const ids = d.tfs[m].split(/[\s,]+/).filter(Boolean);
    const base = parseTf(MODES[m].baseTf);
    const ok: string[] = [];
    for (const id of ids) {
      try {
        const tf = parseTf(id);
        if (!isCompatible(base, tf)) errors.push(`${MODES[m].label}: ${tf.id} cannot be built from ${base.id} candles.`);
        else ok.push(tf.id);
      } catch {
        errors.push(`${MODES[m].label}: "${id}" is not a timeframe (use forms like 7m, 2h, 3d, 2w).`);
      }
    }
    if (ok.length < 2) errors.push(`${MODES[m].label}: give at least two timeframes.`);
    if (ok.join(',') !== MODES[m].tfs.join(',')) customTfs[m] = ok;
  }
  const coins = d.coins
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((c) => (/(USDT|USDC|FDUSD)$/.test(c) ? c : `${c}USDT`));
  if (coins.some((c) => !/^[A-Z0-9]{2,20}$/.test(c))) errors.push('Coins: use symbols like BTC, SOL or BTCUSDT.');
  if (!coins.length) errors.push('Coins: add at least one coin.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.longStart) || Number.isNaN(Date.parse(d.longStart))) errors.push('Long-term start must be a date.');
  const settings: Settings = {
    ...base,
    initialCash: num(d.initialCash, 'Starting capital', 100, 1e9),
    feeRate: num(d.feeRate, 'Fee', 0, 1) / 100,
    slippage: num(d.slippage, 'Slippage', 0, 1) / 100,
    ethStakingApr: num(d.ethStakingApr, 'ETH staking yield', 0, 50) / 100,
    otherStakingApr: num(d.otherStakingApr, 'Other coins yield', 0, 50) / 100,
    plan: { ...plan, contribution: plan.contribution.amount > 0 ? plan.contribution : undefined },
    longStart: d.longStart,
    trader: {
      ...base.trader,
      riskPerTrade: num(d.riskPerTrade, 'Risk per trade', 0.05, 10) / 100,
      shadowWindow: Math.round(num(d.shadowWindow, 'Track record length', 5, 500)),
      shadowZ: num(d.shadowZ, 'Confidence', 0, 4),
      evMin: num(d.evMin, 'Minimum expected value', -1, 3),
      useEdgeFilter: d.useEdgeFilter,
    },
    customTfs,
    coins: [...new Set(coins)].filter((c) => c !== 'ETHUSDT'),
  };
  return errors.length ? { errors } : { settings, errors };
}

function Field(props: { id: string; label: string; value: string; onInput: (v: string) => void; hint?: string; type?: string; suffix?: string }) {
  return (
    <div class="field">
      <label for={props.id}>
        <span>
          {props.label}
          {props.suffix ? <span class="muted"> ({props.suffix})</span> : null}
        </span>
      </label>
      <input id={props.id} type={props.type ?? 'text'} inputMode={props.type === 'date' ? undefined : 'decimal'} value={props.value} onInput={(e) => props.onInput((e.target as HTMLInputElement).value)} />
      {props.hint && <div class="hint">{props.hint}</div>}
    </div>
  );
}

function Switch(props: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div class="field">
      <div class="switch">
        <label for={props.id}>{props.label}</label>
        <input id={props.id} type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
      </div>
      {props.hint && <div class="hint">{props.hint}</div>}
    </div>
  );
}

export function SettingsScreen(props: { c: Controller }) {
  const { c } = props;
  const [d, setD] = useState<Draft>(() => toDraft(c.settings));
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD({ ...d, [k]: v });
    setSaved('');
  };
  const apply = () => {
    const r = fromDraft(d, c.settings);
    setErrors(r.errors);
    if (r.settings) {
      c.setSettings(r.settings);
      setSaved('Saved. Simulations are re-running with the new settings.');
    }
  };
  const setTarget = (k: number, key: 'price' | 'fraction', v: string) => {
    const targets = d.targets.map((t, j) => (j === k ? { ...t, [key]: v } : t));
    set('targets', targets);
  };
  return (
    <div class="stack">
      <div class="pricehead">
        <div>
          <div class="sym">SETTINGS</div>
          <div style={{ fontSize: '22px', fontWeight: 700 }}>Rules and assumptions</div>
        </div>
      </div>
      <section class="card">
        <h2>Account</h2>
        <div class="form">
          <Field id="cash" label="Starting capital" suffix="USDT" value={d.initialCash} onInput={(v) => set('initialCash', v)} />
          <div class="pair">
            <Field id="fee" label="Fee per fill" suffix="%" value={d.feeRate} onInput={(v) => set('feeRate', v)} hint="Binance spot 0.1, or 0.075 paying with BNB" />
            <Field id="slip" label="Slippage" suffix="%" value={d.slippage} onInput={(v) => set('slippage', v)} />
          </div>
          <div class="pair">
            <Field id="stake" label="ETH staking yield" suffix="% / yr" value={d.ethStakingApr} onInput={(v) => set('ethStakingApr', v)} />
            <Field id="stake2" label="Other coins yield" suffix="% / yr" value={d.otherStakingApr} onInput={(v) => set('otherStakingApr', v)} />
          </div>
        </div>
      </section>
      <section class="card">
        <h2>My ETH plan</h2>
        <div class="form">
          <div class="pair">
            <Field id="zl" label="Buy zone low" value={d.zoneLow} onInput={(v) => set('zoneLow', v)} />
            <Field id="zh" label="Buy zone high" value={d.zoneHigh} onInput={(v) => set('zoneHigh', v)} />
          </div>
          <div class="pair">
            <Field id="ba" label="Buy amount" suffix="USDT" value={d.buyAmount} onInput={(v) => set('buyAmount', v)} />
            <Field id="be" label="Buy every" suffix="days" value={d.buyEveryDays} onInput={(v) => set('buyEveryDays', v)} />
          </div>
          <Switch id="below" label="Also buy below the zone" checked={d.buyBelowZone} onChange={(v) => set('buyBelowZone', v)} />
          {d.targets.map((t, k) => (
            <div class="pair">
              <Field id={`tp${k}`} label={`Sell target ${k + 1}`} value={t.price} onInput={(v) => setTarget(k, 'price', v)} />
              <Field id={`tf${k}`} label="Share to sell" suffix="%" value={t.fraction} onInput={(v) => setTarget(k, 'fraction', v)} hint={k === d.targets.length - 1 ? 'The last target sells everything left.' : 'Of the ETH still held.'} />
            </div>
          ))}
          <div class="row">
            {d.targets.length < 4 && (
              <button class="btn" type="button" onClick={() => set('targets', [...d.targets, { price: '', fraction: '100' }])}>
                Add target
              </button>
            )}
            {d.targets.length > 1 && (
              <button class="btn ghost" type="button" onClick={() => set('targets', d.targets.slice(0, -1))}>
                Remove last
              </button>
            )}
          </div>
          <Switch id="rep" label="Start again after selling" checked={d.repeat} onChange={(v) => set('repeat', v)} />
          <div class="pair">
            <Field id="dep" label="Recurring deposit" suffix="USDT" value={d.depositAmount} onInput={(v) => set('depositAmount', v)} hint="0 = none" />
            <Field id="depe" label="Deposit every" suffix="days" value={d.depositEvery} onInput={(v) => set('depositEvery', v)} />
          </div>
          <Field id="ls" label="Long-term simulation start" type="date" value={d.longStart} onInput={(v) => set('longStart', v)} />
        </div>
      </section>
      <section class="card">
        <h2>Day trading and scalping</h2>
        <div class="form">
          <Field id="risk" label="Risk per trade" suffix="% of equity" value={d.riskPerTrade} onInput={(v) => set('riskPerTrade', v)} />
          <Switch id="edge" label="Edge filter" checked={d.useEdgeFilter} onChange={(v) => set('useEdgeFilter', v)} hint="Only trade when expected value after fees is positive and recent setups made money. Turn off to see raw signal results." />
          <div class="pair">
            <Field id="sw" label="Track record length" suffix="setups" value={d.shadowWindow} onInput={(v) => set('shadowWindow', v)} />
            <Field id="sz" label="Confidence" suffix="z" value={d.shadowZ} onInput={(v) => set('shadowZ', v)} hint="1.5 ≈ 93% one-sided" />
          </div>
          <Field id="ev" label="Minimum expected value" suffix="R" value={d.evMin} onInput={(v) => set('evMin', v)} />
        </div>
      </section>
      <section class="card">
        <h2>Timeframes per style</h2>
        <div class="form">
          {MODE_ORDER.map((m) => (
            <Field id={`tfs-${m}`} label={`${MODES[m].label} (built from ${MODES[m].baseTf})`} value={d.tfs[m]} onInput={(v) => set('tfs', { ...d.tfs, [m]: v })} hint="Any timeframe that fits whole base candles, for example 7m, 45m, 90m, 2d, 5d, 2w" />
          ))}
        </div>
      </section>
      <section class="card">
        <h2>Coins tab</h2>
        <div class="form">
          <Field id="coins" label="Coins to scan" value={d.coins} onInput={(v) => set('coins', v)} hint="USDT pairs on Binance, comma separated" />
        </div>
      </section>
      {errors.length > 0 && (
        <ul class="errors card" role="alert">
          {errors.map((e) => (
            <li>{e}</li>
          ))}
        </ul>
      )}
      {saved && <div class="banner info">{saved}</div>}
      <div class="row wrap">
        <button class="btn primary" type="button" onClick={apply}>
          Apply settings
        </button>
        <button
          class="btn"
          type="button"
          onClick={() => {
            c.resetSettings();
            setD(toDraft(c.settings));
            setErrors([]);
            setSaved('Defaults restored.');
          }}
        >
          Restore defaults
        </button>
        <button
          class="btn ghost"
          type="button"
          onClick={async () => {
            await clearCandles();
            setSaved('Downloaded candles cleared. They download again when needed.');
          }}
        >
          Clear downloaded candles
        </button>
      </div>
      <section class="card">
        <h2>About</h2>
        <div class="note">
          A simulator only: it never places orders and needs no API key. Market data comes from Binance's public market-data API. Never put Binance API keys into apps or
          chats; if you have shared yours, delete them in Binance under API Management and create new read-only keys.
        </div>
      </section>
    </div>
  );
}
