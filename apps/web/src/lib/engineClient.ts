import type { Graph, OptimizationResult, RoutingResult, RoutingSettings, SingleRouteRecord } from '@sweep/engine';
import { api, ApiRequestError, serverAvailable } from './api';

export type EngineSource = 'server' | 'browser';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result);
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

function inWorker<T>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
    getWorker().postMessage({ id, ...msg });
  });
}

/**
 * Solve with the authoritative server engine when it is reachable; otherwise
 * run the identical engine package in a Web Worker (offline / static builds).
 */
export async function route(graph: Graph, depotId: string | null, settings: RoutingSettings): Promise<{ result: RoutingResult; source: EngineSource }> {
  if (await serverAvailable()) {
    try {
      const result = await api<RoutingResult>('/route', { method: 'POST', body: { graph, depotId, settings } });
      return { result, source: 'server' };
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 0) throw err;
    }
  }
  return { result: await inWorker<RoutingResult>({ op: 'route', graph, depotId, settings }), source: 'browser' };
}

/** Same engine, always local: used by the laboratory for comparison runs. */
export function routeLocal(graph: Graph, depotId: string | null, settings: RoutingSettings): Promise<RoutingResult> {
  return inWorker<RoutingResult>({ op: 'route', graph, depotId, settings });
}

export interface FleetSweepPoint {
  k: number;
  ok: boolean;
  makespan?: number;
  total?: number;
  lowerBound?: number;
  active?: number;
  ratioBound?: number | null;
  issue?: string;
}

export function fleetSweep(graph: Graph, depotId: string | null, settings: RoutingSettings, base: SingleRouteRecord, ks: number[]): Promise<FleetSweepPoint[]> {
  return inWorker<FleetSweepPoint[]>({ op: 'fleetSweep', graph, depotId, settings, base, ks });
}

/** Original undirected-only contract (kept for callers that need it). */
export async function optimize(graph: Graph, depotId: string | null): Promise<{ result: OptimizationResult; source: EngineSource }> {
  if (await serverAvailable()) {
    try {
      return { result: await api<OptimizationResult>('/optimize', { method: 'POST', body: { graph, depotId } }), source: 'server' };
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 0) throw err;
    }
  }
  return { result: await inWorker<OptimizationResult>({ op: 'optimize', graph, depotId }), source: 'browser' };
}
