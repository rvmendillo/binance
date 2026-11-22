/**
 * App controller: owns settings, market data, the live feed and simulation results,
 * and notifies the UI when anything changes. The same simulation that produced the
 * historical backtest is re-run as each live candle closes, so past and live
 * results form one continuous paper-trading record.
 */
import type { Kline } from '../data/binance.ts';
import { LiveFeed, Market, parseWsKline, type FeedStatus } from '../data/market.ts';
import type { PlanProjection } from '../engine/planProjection.ts';
import { DEFAULT_SETTINGS, MODES, type ModeId, type Settings } from '../engine/presets.ts';
import { validateDcaPlan } from '../engine/strategies/dcaPlan.ts';
import { EngineClient } from '../worker/client.ts';
import type { ModeView } from '../worker/viewModel.ts';

export interface LoadState {
  phase: 'idle' | 'download' | 'compute' | 'ready' | 'error';
  progress: number;
  error?: string;
}

export interface Ticker {
  price: number;
  changePct: number;
  updated: number;
}

const SETTINGS_KEY = 'confluence.settings.v1';
const UI_KEY = 'confluence.ui.v1';

function safeGet(key: string): unknown {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function safeSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}

/** Merge stored settings over defaults, dropping anything malformed. */
export function loadSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    initialCash: num(s.initialCash, DEFAULT_SETTINGS.initialCash, 100, 1e9),
    feeRate: num(s.feeRate, DEFAULT_SETTINGS.feeRate, 0, 0.01),
    slippage: num(s.slippage, DEFAULT_SETTINGS.slippage, 0, 0.01),
    ethStakingApr: num(s.ethStakingApr, DEFAULT_SETTINGS.ethStakingApr, 0, 0.5),
    otherStakingApr: num(s.otherStakingApr, DEFAULT_SETTINGS.otherStakingApr, 0, 0.5),
    plan: { ...DEFAULT_SETTINGS.plan, ...(s.plan ?? {}) },
    planPlus: { ...DEFAULT_SETTINGS.planPlus, ...(s.planPlus ?? {}) },
    allocator: { ...DEFAULT_SETTINGS.allocator, ...(s.allocator ?? {}) },
    trader: { ...DEFAULT_SETTINGS.trader, ...(s.trader ?? {}) },
    customTfs: s.customTfs && typeof s.customTfs === 'object' ? s.customTfs : {},
    coins: Array.isArray(s.coins) && s.coins.every((c) => typeof c === 'string' && /^[A-Z0-9]{2,20}$/.test(c)) ? s.coins : DEFAULT_SETTINGS.coins,
    longStart: typeof s.longStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.longStart) ? s.longStart : DEFAULT_SETTINGS.longStart,
  };
  if (validateDcaPlan(merged.plan).length) merged.plan = DEFAULT_SETTINGS.plan;
  return merged;
}

export type Tab = 'eth' | 'coins' | 'projection' | 'settings';
export interface UiState {
  tab: Tab;
  ethMode: ModeId;
  coinsMode: ModeId;
  coin: string | null;
}

export class Controller {
  settings: Settings;
  ui: UiState;
  views = new Map<string, ModeView>();
  states = new Map<string, LoadState>();
  tickers = new Map<string, Ticker>();
  feedStatus: FeedStatus = 'connecting';
  readonly liveSince = Date.now();
  readonly market: Market;
  readonly engine: EngineClient;
  readonly feed: LiveFeed;
  private listeners = new Set<() => void>();
  private watchers = new Map<string, { count: number; unsub: () => void; symbol: string; interval: string; modes: Set<ModeId> }>();
  private recomputeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickerUnsubs = new Map<string, () => void>();
  version = 0;

  constructor(opts: { market?: Market; feed?: LiveFeed; engine?: EngineClient } = {}) {
    this.settings = loadSettings(safeGet(SETTINGS_KEY));
    const ui = (safeGet(UI_KEY) ?? {}) as Partial<UiState>;
    const modeOk = (m: unknown): m is ModeId => typeof m === 'string' && m in MODES;
    this.ui = {
      tab: ui.tab && ['eth', 'coins', 'projection', 'settings'].includes(ui.tab) ? ui.tab : 'eth',
      ethMode: modeOk(ui.ethMode) ? ui.ethMode : 'long',
      coinsMode: modeOk(ui.coinsMode) ? ui.coinsMode : 'long',
      coin: null,
    };
    this.market = opts.market ?? new Market();
    this.engine = opts.engine ?? new EngineClient();
    this.feed = opts.feed ?? new LiveFeed();
    this.feed.onStatus = (s) => {
      this.feedStatus = s;
      this.updatePolling();
      this.emit();
    };
    this.feed.onReconnect = () => void this.repairAll();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.repairAll();
      });
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  setUi(patch: Partial<UiState>) {
    this.ui = { ...this.ui, ...patch };
    safeSet(UI_KEY, { tab: this.ui.tab, ethMode: this.ui.ethMode, coinsMode: this.ui.coinsMode });
    this.emit();
  }

  setSettings(next: Settings) {
    this.settings = next;
    safeSet(SETTINGS_KEY, next);
    // results depend on settings: drop them and recompute what is on screen
    this.views.clear();
    for (const [k, st] of [...this.states]) if (st.phase !== 'download') this.states.delete(k);
    for (const w of this.watchers.values()) for (const m of w.modes) void this.compute(w.symbol, m);
    this.emit();
  }

  resetSettings() {
    this.setSettings(loadSettings(null));
  }

  key(symbol: string, mode: ModeId) {
    return `${symbol}|${mode}`;
  }

  view(symbol: string, mode: ModeId) {
    return this.views.get(this.key(symbol, mode));
  }

  state(symbol: string, mode: ModeId): LoadState {
    return this.states.get(this.key(symbol, mode)) ?? { phase: 'idle', progress: 0 };
  }

  forming(symbol: string, mode: ModeId): Kline | null {
    return this.market.get(symbol, MODES[mode].baseTf)?.forming ?? null;
  }

  private setState(symbol: string, mode: ModeId, st: LoadState) {
    this.states.set(this.key(symbol, mode), st);
    this.emit();
  }

  /** Download history (if needed) and simulate. */
  async ensure(symbol: string, mode: ModeId): Promise<void> {
    const key = this.key(symbol, mode);
    const st = this.states.get(key);
    if (st && (st.phase === 'download' || st.phase === 'compute')) return;
    if (st?.phase === 'ready' && this.views.has(key)) return;
    const preset = MODES[mode];
    this.setState(symbol, mode, { phase: 'download', progress: 0 });
    try {
      await this.market.load(symbol, preset.baseTf, preset.fetchDays, (f) => {
        this.states.set(key, { phase: 'download', progress: f });
        this.emit();
      });
      await this.compute(symbol, mode);
    } catch (e) {
      this.setState(symbol, mode, { phase: 'error', progress: 0, error: describeError(e) });
    }
  }

  retry(symbol: string, mode: ModeId) {
    this.states.delete(this.key(symbol, mode));
    void this.ensure(symbol, mode);
  }

  async compute(symbol: string, mode: ModeId): Promise<void> {
    const preset = MODES[mode];
    const set = this.market.get(symbol, preset.baseTf);
    if (!set) return;
    const key = this.key(symbol, mode);
    const had = this.views.has(key);
    this.states.set(key, { phase: 'compute', progress: 1 });
    if (!had) this.emit();
    try {
      const view = await this.engine.simulate({ symbol, mode, interval: preset.baseTf, rows: set.rows, settings: this.settings, liveSince: this.liveSince });
      this.views.set(key, view);
      this.states.set(key, { phase: 'ready', progress: 1 });
    } catch (e) {
      this.states.set(key, { phase: 'error', progress: 0, error: describeError(e) });
    }
    this.emit();
  }

  private scheduleRecompute(symbol: string, mode: ModeId) {
    const key = this.key(symbol, mode);
    const t = this.recomputeTimers.get(key);
    if (t) clearTimeout(t);
    this.recomputeTimers.set(
      key,
      setTimeout(() => {
        this.recomputeTimers.delete(key);
        void this.compute(symbol, mode);
      }, 400),
    );
  }

  /** Follow live candles for a symbol/mode while it is on screen. */
  watch(symbol: string, mode: ModeId): () => void {
    const interval = MODES[mode].baseTf;
    const wkey = `${symbol}:${interval}`;
    let w = this.watchers.get(wkey);
    if (!w) {
      const stream = `${symbol.toLowerCase()}@kline_${interval}`;
      const unsub = this.feed.subscribe(stream, (data) => {
        const parsed = parseWsKline(data);
        if (!parsed) return;
        const added = this.market.applyKline(symbol, interval, parsed.k, parsed.closed);
        const t = this.tickers.get(symbol);
        this.tickers.set(symbol, { price: parsed.k.c, changePct: t?.changePct ?? 0, updated: Date.now() });
        const ww = this.watchers.get(wkey);
        if (added && ww) for (const m of ww.modes) this.scheduleRecompute(symbol, m);
        this.emit();
      });
      w = { count: 0, unsub, symbol, interval, modes: new Set() };
      this.watchers.set(wkey, w);
    }
    w.count++;
    w.modes.add(mode);
    this.updatePolling();
    return () => {
      const cur = this.watchers.get(wkey);
      if (!cur) return;
      cur.count--;
      if (cur.count <= 0) {
        cur.unsub();
        this.watchers.delete(wkey);
      }
    };
  }

  /** Live prices for a list of symbols (WebSocket mini tickers + one REST snapshot). */
  watchTickers(symbols: string[]): () => void {
    void this.market
      .tickers(symbols)
      .then((ts) => {
        for (const t of ts) this.tickers.set(t.symbol, { price: t.lastPrice, changePct: t.priceChangePercent / 100, updated: Date.now() });
        this.emit();
      })
      .catch(() => {});
    const unsubs = symbols.map((sym) => {
      const existing = this.tickerUnsubs.get(sym);
      if (existing) return () => {};
      const unsub = this.feed.subscribe(`${sym.toLowerCase()}@miniTicker`, (d) => {
        const c = Number(d.c);
        const o = Number(d.o);
        if (Number.isFinite(c) && Number.isFinite(o) && o > 0) {
          this.tickers.set(sym, { price: c, changePct: c / o - 1, updated: Date.now() });
          this.emit();
        }
      });
      this.tickerUnsubs.set(sym, unsub);
      return () => {
        unsub();
        this.tickerUnsubs.delete(sym);
      };
    });
    return () => unsubs.forEach((u) => u());
  }

  private updatePolling() {
    const need = this.feedStatus === 'polling' || this.feedStatus === 'offline';
    if (need && !this.pollTimer && this.watchers.size) {
      this.pollTimer = setInterval(() => void this.repairAll(true), 20_000);
    } else if (!need && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Fetch candles missed while disconnected or asleep, then recompute what changed. */
  async repairAll(alsoTickers = false): Promise<void> {
    for (const w of this.watchers.values()) {
      try {
        const changed = await this.market.repair(w.symbol, w.interval);
        const set = this.market.get(w.symbol, w.interval);
        if (set?.forming) this.tickers.set(w.symbol, { price: set.forming.c, changePct: this.tickers.get(w.symbol)?.changePct ?? 0, updated: Date.now() });
        if (changed) for (const m of w.modes) this.scheduleRecompute(w.symbol, m);
      } catch {
        /* next poll will try again */
      }
    }
    if (alsoTickers && this.tickerUnsubs.size) {
      try {
        const ts = await this.market.tickers([...this.tickerUnsubs.keys()]);
        for (const t of ts) this.tickers.set(t.symbol, { price: t.lastPrice, changePct: t.priceChangePercent / 100, updated: Date.now() });
      } catch {
        /* ignore */
      }
    }
    this.emit();
  }

  async projectPlan(opts: { days: number; demean: boolean; bootstrapFrom: number; paths?: number }): Promise<PlanProjection> {
    const set = this.market.get('ETHUSDT', '1d') ?? (await this.market.load('ETHUSDT', '1d', MODES.long.fetchDays));
    return this.engine.projectPlan({ rows: set.rows, settings: this.settings, days: opts.days, paths: opts.paths ?? 300, demean: opts.demean, bootstrapFrom: opts.bootstrapFrom });
  }
}

export function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/451|restricted location/i.test(msg)) return 'Binance market data is not available from your network location.';
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'Could not reach Binance market data. Check your connection and try again.';
  if (/Invalid symbol/i.test(msg)) return 'Binance does not list this trading pair.';
  return msg;
}
