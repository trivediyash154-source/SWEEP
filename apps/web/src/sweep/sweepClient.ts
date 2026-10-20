import type { Graph } from '@sweep/engine';
import type { LngLatPair, SweepFailure, SweepPlan, SweepSettings, Zone } from './plan';
import type { SweepResponse } from './sweep.worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: SweepPlan | SweepFailure) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./sweep.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<SweepResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if ('error' in ev.data) p.reject(new Error(ev.data.error));
    else p.resolve(ev.data.result);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The planning worker failed.'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Plan in the worker; one plan at a time is enough for this page. */
export function planInWorker(graph: Graph, zone: Zone, depot: LngLatPair, settings: SweepSettings): Promise<SweepPlan | SweepFailure> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, graph, zone, depot, settings });
  });
}
