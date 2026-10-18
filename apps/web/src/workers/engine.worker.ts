/// <reference lib="webworker" />
import { solveChinesePostman, type Graph } from '@sweep/engine';

self.onmessage = (ev: MessageEvent<{ id: number; graph: Graph; depotId: string | null }>) => {
  const { id, graph, depotId } = ev.data;
  try {
    const result = solveChinesePostman(graph, { depotId });
    (self as unknown as Worker).postMessage({ id, ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
