/**
 * Mode presets. Every mode is the same engine with a different base timeframe,
 * timeframe set (custom timeframes marked *), data window and strategy parameters.
 * Defaults come from the walk-forward research in research/run-research.ts.
 */
import type { Currency } from './fx.ts';
import type { AllocatorParams } from './strategies/allocator.ts';
import { DEFAULT_ALLOCATOR } from './strategies/allocator.ts';
import type { DcaPlanParams } from './strategies/dcaPlan.ts';
import { DEFAULT_DCA_PLAN } from './strategies/dcaPlan.ts';
import type { PlanPlusParams } from './strategies/planPlus.ts';
import { DEFAULT_PLAN_PLUS } from './strategies/planPlus.ts';
import type { TraderParams } from './strategies/trader.ts';
import { DEFAULT_TRADER } from './strategies/trader.ts';

export type ModeId = 'long' | 'swing' | 'day' | 'scalp';

export interface ModePreset {
  id: ModeId;
  label: string;
  blurb: string;
  baseTf: string;
  /** Timeframes combined in the confluence (custom ones are built from base candles). */
  tfs: string[];
  /** Days of base candles to download (history for indicators + simulated window). */
  fetchDays: number;
  /** Days at the end of the data that are simulated (the rest warms up indicators). */
  simDays: number;
  trader?: Partial<TraderParams>;
}

export const MODES: Record<ModeId, ModePreset> = {
  long: {
    id: 'long',
    label: 'Long-term',
    blurb: 'Daily candles, months to years. Your DCA plan, confluence allocator, buy & hold, with staking.',
    baseTf: '1d',
    tfs: ['2d', '3d', '5d', '1w', '2w', '1M'],
    fetchDays: 4000,
    simDays: 3300,
  },
  swing: {
    id: 'swing',
    label: 'Swing',
    blurb: 'Hourly candles, trades last hours to 5 days.',
    baseTf: '1h',
    tfs: ['2h', '4h', '6h', '12h', '1d', '2d', '3d', '1w'],
    fetchDays: 540,
    simDays: 365,
    trader: { slAtr: 3, tpAtr: 6, maxBars: 120 },
  },
  day: {
    id: 'day',
    label: 'Day trade',
    blurb: '15-minute candles, trades last up to a day.',
    baseTf: '15m',
    tfs: ['30m', '45m', '1h', '2h', '4h', '6h', '12h', '1d'],
    fetchDays: 200,
    simDays: 120,
    trader: { slAtr: 2, tpAtr: 4, maxBars: 96 },
  },
  scalp: {
    id: 'scalp',
    label: 'Scalp',
    blurb: '1-minute candles, trades last minutes to an hour.',
    baseTf: '1m',
    tfs: ['2m', '3m', '5m', '10m', '15m', '30m', '1h'],
    fetchDays: 8,
    simDays: 5,
    trader: { slAtr: 2.5, tpAtr: 5, maxBars: 60 },
  },
};

export const MODE_ORDER: ModeId[] = ['long', 'swing', 'day', 'scalp'];

/** Custom (non-Binance) timeframes in a preset, for labelling. */
export const CUSTOM_TF_IDS = new Set(['2m', '10m', '45m', '2d', '5d', '2w']);

export interface Settings {
  /** Currency for every money amount shown and entered (prices stay in USDT). */
  currency: Currency;
  /** Starting capital, in `currency`. */
  initialCash: number;
  /** Binance spot fee per fill: 0.001 (0.1%), or 0.00075 paying fees with BNB. */
  feeRate: number;
  slippage: number;
  /** Annual staking yield on held ETH. */
  ethStakingApr: number;
  /** Annual staking/earn yield on other held coins. */
  otherStakingApr: number;
  plan: DcaPlanParams;
  planPlus: PlanPlusParams;
  allocator: AllocatorParams;
  trader: TraderParams;
  /** User overrides of the timeframe lists per mode. */
  customTfs: Partial<Record<ModeId, string[]>>;
  /** Symbols in the Coins tab. */
  coins: string[];
  /** First simulated day for long-term mode (ISO date). Fixed so results are stable day to day. */
  longStart: string;
}

export const DEFAULT_COINS = ['BTCUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'TRXUSDT', 'SUIUSDT'];

export const DEFAULT_SETTINGS: Settings = {
  currency: 'PHP',
  initialCash: 500_000,
  feeRate: 0.001,
  slippage: 0.0005,
  ethStakingApr: 0.03,
  otherStakingApr: 0,
  plan: { ...DEFAULT_DCA_PLAN, buyAmount: 25_000 },
  planPlus: DEFAULT_PLAN_PLUS,
  allocator: { ...DEFAULT_ALLOCATOR, wTrend: 1, sLow: 0, sHigh: 0.2, band: 0.25 },
  trader: { ...DEFAULT_TRADER, shadowWindow: 60, shadowZ: 1.5, evMin: 0.05 },
  customTfs: {},
  coins: DEFAULT_COINS,
  longStart: '2018-01-01',
};

/** The same defaults expressed in US dollars ($10,000 capital, $500 weekly buys). */
export const USD_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  currency: 'USD',
  initialCash: 10_000,
  plan: { ...DEFAULT_DCA_PLAN, buyAmount: 500 },
};

export function tfsFor(mode: ModeId, settings: Settings): string[] {
  return settings.customTfs[mode]?.length ? settings.customTfs[mode]! : MODES[mode].tfs;
}
