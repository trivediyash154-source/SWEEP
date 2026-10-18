import type { IndexedGraph } from './graph.js';
import { otherEnd } from './graph.js';

export interface ShortestPathTree {
  sources: number[];
  /** Scaled distances; Infinity when unreachable. */
  dist: Float64Array;
  /** Edge used to reach each vertex (-1 for sources and unreachable vertices). */
  predEdge: Int32Array;
}

/**
 * Binary min-heap keyed by (distance, vertex) so that ties are broken
 * deterministically by vertex index.
 */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  private less(i: number, j: number): boolean {
    const ki = this.keys[i]!;
    const kj = this.keys[j]!;
    return ki < kj || (ki === kj && this.vals[i]! < this.vals[j]!);
  }
  private swap(i: number, j: number): void {
    const k = this.keys[i]!;
    this.keys[i] = this.keys[j]!;
    this.keys[j] = k;
    const v = this.vals[i]!;
    this.vals[i] = this.vals[j]!;
    this.vals[j] = v;
  }
  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.keys[0]!, this.vals[0]!];
    const lastKey = this.keys.pop()!;
    const lastVal = this.vals.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      const n = this.keys.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < n && this.less(l, s)) s = l;
        if (r < n && this.less(r, s)) s = r;
        if (s === i) break;
        this.swap(i, s);
        i = s;
      }
    }
    return top;
  }
}

/**
 * Multi-source Dijkstra over all edges (required and optional) using scaled
 * integer weights. Self-loops never shorten a path and are skipped.
 * Complexity: O((n + m) log n).
 */
export function dijkstra(ig: IndexedGraph, sources: number[]): ShortestPathTree {
  const dist = new Float64Array(ig.n).fill(Infinity);
  const predEdge = new Int32Array(ig.n).fill(-1);
  const done = new Uint8Array(ig.n);
  const heap = new MinHeap();
  for (const s of sources) {
    dist[s] = 0;
    heap.push(0, s);
  }
  while (heap.size > 0) {
    const [d, v] = heap.pop();
    if (done[v]) continue;
    done[v] = 1;
    for (const k of ig.adj[v]!) {
      const w = otherEnd(ig, k, v);
      if (w === v) continue;
      const nd = d + ig.ew[k]!;
      if (nd < dist[w]!) {
        dist[w] = nd;
        predEdge[w] = k;
        heap.push(nd, w);
      }
    }
  }
  return { sources, dist, predEdge };
}

/** Reconstruct the path from the tree's source to `target` as edge and vertex index sequences. */
export function reconstructPath(ig: IndexedGraph, tree: ShortestPathTree, target: number): { vertices: number[]; edges: number[] } {
  if (!Number.isFinite(tree.dist[target]!)) throw new Error('reconstructPath: target unreachable');
  const vertices: number[] = [target];
  const edges: number[] = [];
  let v = target;
  while (tree.predEdge[v] !== -1) {
    const k = tree.predEdge[v]!;
    edges.push(k);
    v = otherEnd(ig, k, v);
    vertices.push(v);
  }
  vertices.reverse();
  edges.reverse();
  return { vertices, edges };
}
