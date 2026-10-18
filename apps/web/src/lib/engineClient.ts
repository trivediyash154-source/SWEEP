import type { Graph, OptimizationResult } from '@sweep/engine';
import { api, ApiRequestError, serverAvailable } from './api';

export type EngineSource = 'server' | 'browser';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: OptimizationResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: OptimizationResult; error?: string }>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result!);
      else p.reject(new Error(ev.data.error ?? 'Engine failed'));
    };
    worker.onerror = (ev) => {
      for (const p of pending.values()) p.reject(new Error(ev.message || 'Engine worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function solveInBrowser(graph: Graph, depotId: string | null): Promise<OptimizationResult> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, graph, depotId });
  });
}

/**
 * Optimise with the authoritative server engine when it is reachable;
 * otherwise run the identical engine package in a Web Worker.
 */
export async function optimize(graph: Graph, depotId: string | null): Promise<{ result: OptimizationResult; source: EngineSource }> {
  if (await serverAvailable()) {
    try {
      const result = await api<OptimizationResult>('/optimize', { method: 'POST', body: { graph, depotId } });
      return { result, source: 'server' };
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 0) throw err;
    }
  }
  return { result: await solveInBrowser(graph, depotId), source: 'browser' };
}
