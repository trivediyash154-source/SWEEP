import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { solveChinesePostman, solveRouting, type Graph, type OptimizationResult, type RoutingResult, type RoutingSettings } from '@sweep/engine';
import { ApiError } from './http.js';

export interface Solver {
  /** Undirected solver only (the original /api/optimize contract). */
  solve(graph: Graph, depotId: string | null): Promise<OptimizationResult>;
  /** Scenario routing settings: undirected, directed/mixed, and multi-vehicle. */
  route(graph: Graph, depotId: string | null, settings?: RoutingSettings): Promise<RoutingResult>;
  close(): Promise<void>;
}

export function inlineSolver(): Solver {
  return {
    async solve(graph, depotId) {
      return solveChinesePostman(graph, { depotId });
    },
    async route(graph, depotId, settings) {
      return solveRouting(graph, settings, depotId);
    },
    async close() {},
  };
}

/**
 * Runs each optimisation in a dedicated worker thread so a large instance can
 * never block the HTTP event loop, and enforces a hard wall-clock timeout by
 * terminating the worker.
 */
export function workerSolver(timeoutMs: number): Solver {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const jsPath = `${here}solverWorker.js`;
  const tsPath = `${here}solverWorker.ts`;
  const usingTs = !existsSync(jsPath);
  const spawn = (): Worker =>
    usingTs ? new Worker(tsPath, { execArgv: ['--import', 'tsx'] }) : new Worker(jsPath);
  let seq = 0;
  const active = new Set<Worker>();
  function run<T>(payload: { graph: Graph; depotId: string | null; settings?: RoutingSettings; legacy: boolean }): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = spawn();
      active.add(worker);
      const id = ++seq;
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new ApiError(422, 'COMPUTATION_TIMEOUT', `Optimisation exceeded the ${Math.round(timeoutMs / 1000)} s limit. Reduce the network size or split the area.`));
      }, timeoutMs);
      const finish = (): void => {
        clearTimeout(timer);
        active.delete(worker);
        void worker.terminate();
      };
      worker.once('message', (msg: { id: number; ok: boolean; result?: T; error?: string }) => {
        finish();
        if (msg.id !== id) return reject(new Error('solver: mismatched reply'));
        if (msg.ok) resolve(msg.result!);
        else reject(new Error(msg.error ?? 'solver failed'));
      });
      worker.once('error', (err) => {
        finish();
        reject(err);
      });
      worker.postMessage({ id, ...payload });
    });
  }
  return {
    solve: (graph, depotId) => run<OptimizationResult>({ graph, depotId, legacy: true }),
    route: (graph, depotId, settings) => run<RoutingResult>({ graph, depotId, ...(settings ? { settings } : {}), legacy: false }),
    async close() {
      await Promise.all([...active].map((w) => w.terminate()));
    },
  };
}
