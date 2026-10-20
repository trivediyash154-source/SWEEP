import type { Edge, Graph, Vertex } from '../src/index.js';
import { mulberry32 } from '../src/examples/index.js';

/** Random small multigraph (loops, parallel edges, zero weights, optional edges). */
export function randomGraph(seed: number, opts: { maxN?: number; maxM?: number; optionalProb?: number; loops?: boolean } = {}): Graph {
  const rnd = mulberry32(seed);
  const n = 2 + Math.floor(rnd() * ((opts.maxN ?? 7) - 1));
  const m = 1 + Math.floor(rnd() * (opts.maxM ?? 11));
  const vertices: Vertex[] = Array.from({ length: n }, (_, i) => ({ id: `v${i}`, x: Math.round(rnd() * 500), y: Math.round(rnd() * 500) }));
  const edges: Edge[] = [];
  for (let k = 0; k < m; k++) {
    const u = Math.floor(rnd() * n);
    let v = Math.floor(rnd() * n);
    if (!opts.loops && u === v) v = (v + 1) % n;
    edges.push({
      id: `e${k}`,
      u: `v${u}`,
      v: `v${v}`,
      weight: Math.floor(rnd() * 21) + (rnd() < 0.3 ? Math.round(rnd() * 1000) / 1000 : 0),
      required: rnd() >= (opts.optionalProb ?? 0.25),
    });
  }
  return { vertices, edges };
}
