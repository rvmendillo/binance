import type { ModeId, Settings } from '../engine/presets.ts';
import type { PlanProjection } from '../engine/planProjection.ts';
import type { KlineRow } from '../engine/types.ts';
import type { ModeView } from './viewModel.ts';

export interface SimulateRequest {
  type: 'simulate';
  symbol: string;
  mode: ModeId;
  interval: string;
  rows: KlineRow[];
  settings: Settings;
  /** Trades/fills at or after this time are flagged as live paper trades. */
  liveSince: number;
}

export interface ProjectPlanRequest {
  type: 'projectPlan';
  rows: KlineRow[];
  settings: Settings;
  days: number;
  paths: number;
  demean: boolean;
  /** Only history from this time on is resampled for the synthetic futures. */
  bootstrapFrom: number;
}

export type EngineRequest = SimulateRequest | ProjectPlanRequest;
export type EngineResponse = { id: number; ok: true; result: ModeView | PlanProjection } | { id: number; ok: false; error: string };
