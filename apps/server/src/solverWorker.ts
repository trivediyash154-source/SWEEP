import { parentPort } from 'node:worker_threads';
import { solveChinesePostman, type Graph } from '@sweep/engine';

parentPort?.on('message', (msg: { id: number; graph: Graph; depotId: string | null }) => {
  try {
    const result = solveChinesePostman(msg.graph, { depotId: msg.depotId });
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
