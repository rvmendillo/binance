/**
 * Main-thread side of the engine. Uses a Web Worker so heavy simulations never
 * freeze scrolling; falls back to running in the page if workers are unavailable.
 */
import type { PlanProjection } from '../engine/planProjection.ts';
import type { EngineRequest, EngineResponse, ProjectPlanRequest, SimulateRequest } from './protocol.ts';
import type { ModeView } from './viewModel.ts';
import EngineWorker from './engine.worker.ts?worker&inline';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class EngineClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  usingWorker = false;

  constructor() {
    try {
      this.worker = new EngineWorker();
      this.worker.onmessage = (ev: MessageEvent<EngineResponse>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.ok) p.resolve(ev.data.result);
        else p.reject(new Error(ev.data.error));
      };
      this.worker.onerror = () => {
        // a worker that cannot start: reject everything and use the in-page engine
        for (const p of this.pending.values()) p.reject(new Error('worker-failed'));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
        this.usingWorker = false;
      };
      this.usingWorker = true;
    } catch {
      this.worker = null;
    }
  }

  private async inPage(req: EngineRequest): Promise<unknown> {
    const { handle } = await import('./handle.ts');
    await new Promise((r) => setTimeout(r, 0));
    return handle(req);
  }

  private call(req: EngineRequest): Promise<unknown> {
    if (!this.worker) return this.inPage(req);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, req });
    }).catch((e: Error) => (e.message === 'worker-failed' ? this.inPage(req) : Promise.reject(e)));
  }

  simulate(req: Omit<SimulateRequest, 'type'>): Promise<ModeView> {
    return this.call({ type: 'simulate', ...req }) as Promise<ModeView>;
  }

  projectPlan(req: Omit<ProjectPlanRequest, 'type'>): Promise<PlanProjection> {
    return this.call({ type: 'projectPlan', ...req }) as Promise<PlanProjection>;
  }
}
