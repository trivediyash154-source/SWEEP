import type { Graph } from '../types.js';
import { toScaled } from '../units.js';

/**
 * Directed arc view of a coverage graph with CSR adjacency, shared by the
 * coverage heuristics and the fleet planner.
 *
 * - directed = false: every street gives two arcs (u→v and v→u) with cost `weight`.
 * - directed = true:  u→v always; v→u unless the street is one-way, with cost
 *   `reverseWeight ?? weight`.
 * Costs are scaled integers (milli-units, see units.ts) so sums are exact.
 */
export interface ArcGraph {
  graph: Graph;
  directed: boolean;
  n: number;
  vertexIds: string[];
  vertexIndex: Map<string, number>;
  edgeIndex: Map<string, number>;
  arcTail: Int32Array;
  arcHead: Int32Array;
  arcCost: Float64Array;
  arcEdge: Int32Array;
  /** 1 when the arc runs u → v of its street. */
  arcFwd: Uint8Array;
  /** CSR: arcs leaving vertex v are outArcs[outStart[v] .. outStart[v + 1]). */
  outStart: Int32Array;
  outArcs: Int32Array;
  inStart: Int32Array;
  inArcs: Int32Array;
  /** Arc index of street k in direction u → v / v → u, or -1. */
  fwdArc: Int32Array;
  backArc: Int32Array;
}

export function buildArcGraph(graph: Graph, directed: boolean): ArcGraph {
  const n = graph.vertices.length;
  const vertexIds = graph.vertices.map((v) => v.id);
  const vertexIndex = new Map<string, number>();
  vertexIds.forEach((id, i) => vertexIndex.set(id, i));
  const edgeIndex = new Map<string, number>();
  const tail: number[] = [];
  const head: number[] = [];
  const cost: number[] = [];
  const edge: number[] = [];
  const fwd: number[] = [];
  const m = graph.edges.length;
  const fwdArc = new Int32Array(m).fill(-1);
  const backArc = new Int32Array(m).fill(-1);
  graph.edges.forEach((e, k) => {
    edgeIndex.set(e.id, k);
    const u = vertexIndex.get(e.u);
    const v = vertexIndex.get(e.v);
    if (u === undefined || v === undefined) throw new Error(`buildArcGraph: unknown endpoint on ${e.id}`);
    fwdArc[k] = tail.length;
    tail.push(u);
    head.push(v);
    cost.push(toScaled(e.weight));
    edge.push(k);
    fwd.push(1);
    const oneway = e.oneway === true || e.directed === true;
    if (u !== v && !(directed && oneway)) {
      backArc[k] = tail.length;
      tail.push(v);
      head.push(u);
      cost.push(toScaled(directed ? (e.reverseWeight ?? e.weight) : e.weight));
      edge.push(k);
      fwd.push(0);
    }
  });
  const A = tail.length;
  const csr = (keyOf: number[]): { start: Int32Array; arcs: Int32Array } => {
    const start = new Int32Array(n + 1);
    for (let a = 0; a < A; a++) start[keyOf[a]! + 1] = start[keyOf[a]! + 1]! + 1;
    for (let v = 0; v < n; v++) start[v + 1] = start[v + 1]! + start[v]!;
    const fill = start.slice(0, n);
    const arcs = new Int32Array(A);
    for (let a = 0; a < A; a++) {
      arcs[fill[keyOf[a]!]!] = a;
      fill[keyOf[a]!] = fill[keyOf[a]!]! + 1;
    }
    return { start, arcs };
  };
  const o = csr(tail);
  const i = csr(head);
  return {
    graph,
    directed,
    n,
    vertexIds,
    vertexIndex,
    edgeIndex,
    arcTail: Int32Array.from(tail),
    arcHead: Int32Array.from(head),
    arcCost: Float64Array.from(cost),
    arcEdge: Int32Array.from(edge),
    arcFwd: Uint8Array.from(fwd),
    outStart: o.start,
    outArcs: o.arcs,
    inStart: i.start,
    inArcs: i.arcs,
    fwdArc,
    backArc,
  };
}

/** Binary heap of (key, value) with deterministic tie-breaking on value. */
export class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  clear(): void {
    this.k.length = 0;
    this.v.length = 0;
  }
  private lt(i: number, j: number): boolean {
    return this.k[i]! < this.k[j]! || (this.k[i] === this.k[j] && this.v[i]! < this.v[j]!);
  }
  push(key: number, val: number): void {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.lt(i, p)) break;
      [k[i], k[p]] = [k[p]!, k[i]!];
      [v[i], v[p]] = [v[p]!, v[i]!];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0]!, v[0]!];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length > 0) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < k.length && this.lt(l, s)) s = l;
        if (r < k.length && this.lt(r, s)) s = r;
        if (s === i) break;
        [k[i], k[s]] = [k[s]!, k[i]!];
        [v[i], v[s]] = [v[s]!, v[i]!];
        i = s;
      }
    }
    return top;
  }
}

export interface ArcTree {
  dist: Float64Array;
  /** Arc used to reach each vertex (-1 for sources and unreached vertices). */
  pred: Int32Array;
}

/**
 * Dijkstra over arcs from one or more sources. `reverse` follows arcs
 * backwards (distances TO the sources). `stop(v)` is called when v is settled;
 * returning true ends the search early (settled distances stay exact).
 */
export function arcDijkstra(ag: ArcGraph, sources: readonly number[], opts: { reverse?: boolean; stop?: (v: number, d: number) => boolean } = {}): ArcTree {
  const dist = new Float64Array(ag.n).fill(Infinity);
  const pred = new Int32Array(ag.n).fill(-1);
  const done = new Uint8Array(ag.n);
  const heap = new MinHeap();
  for (const s of sources) {
    if (dist[s] === 0) continue;
    dist[s] = 0;
    heap.push(0, s);
  }
  const start = opts.reverse ? ag.inStart : ag.outStart;
  const list = opts.reverse ? ag.inArcs : ag.outArcs;
  const next = opts.reverse ? ag.arcTail : ag.arcHead;
  while (heap.size > 0) {
    const [d, u] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (opts.stop && opts.stop(u, d)) break;
    for (let i = start[u]!; i < start[u + 1]!; i++) {
      const a = list[i]!;
      const w = next[a]!;
      if (w === u) continue;
      const nd = d + ag.arcCost[a]!;
      if (nd < dist[w]!) {
        dist[w] = nd;
        pred[w] = a;
        heap.push(nd, w);
      }
    }
  }
  return { dist, pred };
}

/** Arc sequence from the tree's source to `target` (forward tree), in travel order. */
export function treePath(ag: ArcGraph, tree: ArcTree, target: number): number[] {
  const arcs: number[] = [];
  let v = target;
  while (tree.pred[v]! >= 0) {
    const a = tree.pred[v]!;
    arcs.push(a);
    v = ag.arcTail[a]!;
  }
  return arcs.reverse();
}

/** Arc sequence from `source` to the tree's target set for a REVERSE tree (distances to the sources), in travel order. */
export function reverseTreePath(ag: ArcGraph, tree: ArcTree, source: number): number[] {
  const arcs: number[] = [];
  let v = source;
  while (tree.pred[v]! >= 0) {
    const a = tree.pred[v]!;
    arcs.push(a);
    v = ag.arcHead[a]!;
  }
  return arcs;
}
