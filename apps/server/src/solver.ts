import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { solveChinesePostman, type Graph, type OptimizationResult } from '@sweep/engine';
import { ApiError } from './http.js';

export interface Solver {
  solve(graph: Graph, depotId: string | null): Promise<OptimizationResult>;
  close(): Promise<void>;
}

export function inlineSolver(): Solver {
  return {
    async solve(graph, depotId) {
      return solveChinesePostman(graph, { depotId });
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
  return {
    solve(graph, depotId) {
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
        worker.once('message', (msg: { id: number; ok: boolean; result?: OptimizationResult; error?: string }) => {
          finish();
          if (msg.id !== id) return reject(new Error('solver: mismatched reply'));
          if (msg.ok) resolve(msg.result!);
          else reject(new Error(msg.error ?? 'solver failed'));
        });
        worker.once('error', (err) => {
          finish();
          reject(err);
        });
        worker.postMessage({ id, graph, depotId });
      });
    },
    async close() {
      await Promise.all([...active].map((w) => w.terminate()));
    },
  };
}
