import { parentPort } from 'node:worker_threads';
import { solveChinesePostman, solveRouting, type Graph, type RoutingSettings } from '@sweep/engine';

parentPort?.on('message', (msg: { id: number; graph: Graph; depotId: string | null; settings?: RoutingSettings; legacy?: boolean }) => {
  try {
    const result = msg.legacy ? solveChinesePostman(msg.graph, { depotId: msg.depotId }) : solveRouting(msg.graph, msg.settings, msg.depotId);
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
