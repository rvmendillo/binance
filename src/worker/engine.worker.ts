/// <reference lib="webworker" />
import { handle } from './handle.ts';
import type { EngineRequest, EngineResponse } from './protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<{ id: number; req: EngineRequest }>) => {
  const { id, req } = ev.data;
  let msg: EngineResponse;
  try {
    msg = { id, ok: true, result: handle(req) };
  } catch (e) {
    msg = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  ctx.postMessage(msg);
};
