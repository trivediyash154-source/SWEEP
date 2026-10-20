import type { Graph } from './types.js';
import { toScaled, fromScaled } from './units.js';
import { isOneway } from './validate.js';

/**
 * Shortest path between two intersections, for interactive inspection.
 * Undirected: every street both ways at `weight`. Directed: one-way streets
 * forwards only, two-way streets backwards at `reverseWeight ?? weight`.
 * Returns null when `to` is unreachable from `from`.
 */
export function shortestPathBetween(
  graph: Graph,
  from: string,
  to: string,
  directed = false,
): { distance: number; vertexIds: string[]; edgeIds: string[] } | null {
  const index = new Map(graph.vertices.map((v, i) => [v.id, i]));
  const s = index.get(from);
  const t = index.get(to);
  if (s === undefined || t === undefined) return null;
  const n = graph.vertices.length;
  const adj: Array<Array<{ to: number; cost: number; edge: number }>> = Array.from({ length: n }, () => []);
  graph.edges.forEach((e, k) => {
    const u = index.get(e.u);
    const v = index.get(e.v);
    if (u === undefined || v === undefined || u === v) return;
    adj[u]!.push({ to: v, cost: toScaled(e.weight), edge: k });
    if (!(directed && isOneway(e))) adj[v]!.push({ to: u, cost: toScaled(directed ? (e.reverseWeight ?? e.weight) : e.weight), edge: k });
  });
  const dist = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const predV = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[s] = 0;
  // O(n²) selection is fine for interactive use on networks of a few thousand intersections.
  const heap: Array<[number, number]> = [[0, s]];
  while (heap.length > 0) {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i]![0] < heap[bi]![0] || (heap[i]![0] === heap[bi]![0] && heap[i]![1] < heap[bi]![1])) bi = i;
    const [d, v] = heap[bi]!;
    heap[bi] = heap[heap.length - 1]!;
    heap.pop();
    if (done[v]) continue;
    done[v] = 1;
    if (v === t) break;
    for (const a of adj[v]!) {
      const nd = d + a.cost;
      if (nd < dist[a.to]!) {
        dist[a.to] = nd;
        pred[a.to] = a.edge;
        predV[a.to] = v;
        heap.push([nd, a.to]);
      }
    }
  }
  if (!Number.isFinite(dist[t]!)) return null;
  const vertexIds: string[] = [];
  const edgeIds: string[] = [];
  for (let v = t; v !== -1; v = predV[v]!) {
    vertexIds.push(graph.vertices[v]!.id);
    if (pred[v]! >= 0) edgeIds.push(graph.edges[pred[v]!]!.id);
  }
  return { distance: fromScaled(dist[t]!), vertexIds: vertexIds.reverse(), edgeIds: edgeIds.reverse() };
}
