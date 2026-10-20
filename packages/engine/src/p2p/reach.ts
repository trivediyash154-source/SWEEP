import { MinHeap } from './heap.js';
import { weightsFor, type RoutingGraph } from './network.js';

/**
 * Network reachability (travel-time "isochrones" on the street graph).
 *
 * One Dijkstra over the edge-based graph with the TIME objective (arc travel
 * times plus turn penalties) from every arc leaving the origin. For each arc:
 *   entry time = time at which the arc is entered (after any turn penalty),
 *   exit time  = entry time + the arc's travel time.
 * An arc is FULLY reached within T when exit ≤ T, PARTIALLY when
 * entry < T < exit (with fraction (T − entry) / travel time of its length).
 * Because the same labels serve every threshold, the reached set for a larger
 * threshold always contains the set for a smaller one.
 *
 * The search stops once every label ≤ max(thresholds) is final; labels of arcs
 * that are entered before the largest threshold are final at that point
 * (penalties and costs are non-negative), so partial arcs are exact too.
 */
export interface ReachResult {
  origin: number;
  thresholdsS: number[];
  entryS: Float64Array;
  exitS: Float64Array;
  /** Earliest arrival at each city node (Infinity if not reached within the largest threshold). */
  nodeArrivalS: Float64Array;
  levels: {
    thresholdS: number;
    fullArcs: Int32Array;
    partialArcs: Int32Array;
    partialFraction: Float32Array;
    nodes: number;
    lengthM: number;
  }[];
  settled: number;
  runtimeMs: number;
}

export function reachability(g: RoutingGraph, origin: number, thresholdsS: readonly number[] = [300, 600, 900]): ReachResult {
  const t0 = performance.now();
  const th = [...thresholdsS].filter((x) => x > 0).sort((a, b) => a - b);
  const maxT = th[th.length - 1] ?? 0;
  const W = weightsFor(g, 'time');
  const A = g.arcCount;
  const exit = new Float64Array(A).fill(Infinity);
  const entry = new Float64Array(A).fill(Infinity);
  const done = new Uint8Array(A);
  const heap = new MinHeap(1024);
  for (let k = g.nodeOutOff[origin]!; k < g.nodeOutOff[origin + 1]!; k++) {
    const a = g.nodeOutArcs[k]!;
    entry[a] = 0;
    exit[a] = W.arcCost[a]!;
    heap.push(exit[a]!, a);
  }
  let settled = 0;
  while (heap.size > 0) {
    const d = heap.topKey();
    const a = heap.topId();
    heap.pop();
    if (d > maxT) break;
    if (done[a] || d > exit[a]!) continue;
    done[a] = 1;
    settled++;
    for (let k = g.outOff[a]!; k < g.outOff[a + 1]!; k++) {
      const b = g.outTo[k]!;
      const nd = d + W.outW[k]!;
      if (nd < exit[b]!) {
        exit[b] = nd;
        entry[b] = nd - W.arcCost[b]!;
        heap.push(nd, b);
      }
    }
  }
  const N = g.city.nodeCount;
  const nodeArrival = new Float64Array(N).fill(Infinity);
  nodeArrival[origin] = 0;
  for (let a = 0; a < A; a++) {
    const x = exit[a]!;
    if (x <= maxT) {
      const h = g.arcHead[a]!;
      if (x < nodeArrival[h]!) nodeArrival[h] = x;
    }
  }
  const levels = th.map((T) => {
    const full: number[] = [];
    const part: number[] = [];
    const frac: number[] = [];
    let len = 0;
    for (let a = 0; a < A; a++) {
      const en = entry[a]!;
      const ex = exit[a]!;
      if (ex <= T) {
        full.push(a);
        len += g.arcLen[a]!;
      } else if (en < T) {
        const f = Math.max(0, Math.min(1, (T - en) / (ex - en)));
        part.push(a);
        frac.push(f);
        len += f * g.arcLen[a]!;
      }
    }
    let nodes = 0;
    for (let i = 0; i < N; i++) if (nodeArrival[i]! <= T) nodes++;
    return { thresholdS: T, fullArcs: Int32Array.from(full), partialArcs: Int32Array.from(part), partialFraction: Float32Array.from(frac), nodes, lengthM: len };
  });
  return { origin, thresholdsS: th, entryS: entry, exitS: exit, nodeArrivalS: nodeArrival, levels, settled, runtimeMs: performance.now() - t0 };
}
