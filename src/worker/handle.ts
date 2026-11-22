/** Request handler shared by the Web Worker and the main-thread fallback. */
import { projectPlan, type PlanProjection } from '../engine/planProjection.ts';
import { MODES } from '../engine/presets.ts';
import { defaultStartIndex, simulate } from '../engine/simulate.ts';
import { parseTf } from '../engine/timeframe.ts';
import { seriesFromRows } from '../engine/types.ts';
import type { EngineRequest } from './protocol.ts';
import { buildView, type ModeView } from './viewModel.ts';

export function handle(req: EngineRequest): ModeView | PlanProjection {
  if (req.type === 'simulate') {
    const t0 = Date.now();
    const series = seriesFromRows(req.rows, parseTf(req.interval).ms);
    if (MODES[req.mode].baseTf !== req.interval) throw new Error(`Mode ${req.mode} expects ${MODES[req.mode].baseTf} candles`);
    const res = simulate(req.symbol, req.mode, series, req.settings, { startIndex: defaultStartIndex(series, req.mode, req.settings), fx: req.fx });
    return buildView(res, {
      computeMs: Date.now() - t0,
      liveSince: req.liveSince,
      stopOf: (id) => res.runs.find((r) => r.id === id)?.result.pending.stop ?? null,
    });
  }
  const series = seriesFromRows(req.rows, parseTf('1d').ms);
  const startIndex = defaultStartIndex(series, 'long', req.settings);
  let from = series.t.findIndex((t) => t >= req.bootstrapFrom);
  if (from < 1) from = 1;
  return projectPlan(series, req.settings, { startIndex, days: req.days, paths: req.paths, demean: req.demean, bootstrapFrom: from, fx: req.fx });
}
