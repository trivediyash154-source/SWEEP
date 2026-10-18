import type { Graph } from './types.js';
import { toScaled } from './units.js';

/** Dense, index-based view of a structurally valid graph. */
export interface IndexedGraph {
  graph: Graph;
  n: number;
  m: number;
  vertexIds: string[];
  vertexIndex: Map<string, number>;
  edgeIds: string[];
  edgeIndex: Map<string, number>;
  eu: Int32Array;
  ev: Int32Array;
  /** Scaled (integer milli-unit) weights. */
  ew: Float64Array;
  required: Uint8Array;
  /** Incident edge indices per vertex. A self-loop appears once in its vertex's list. */
  adj: number[][];
}

export function indexGraph(graph: Graph): IndexedGraph {
  const n = graph.vertices.length;
  const m = graph.edges.length;
  const vertexIds = graph.vertices.map((v) => v.id);
  const vertexIndex = new Map<string, number>();
  vertexIds.forEach((id, i) => vertexIndex.set(id, i));
  const edgeIds = graph.edges.map((e) => e.id);
  const edgeIndex = new Map<string, number>();
  edgeIds.forEach((id, i) => edgeIndex.set(id, i));
  const eu = new Int32Array(m);
  const ev = new Int32Array(m);
  const ew = new Float64Array(m);
  const required = new Uint8Array(m);
  const adj: number[][] = Array.from({ length: n }, () => []);
  graph.edges.forEach((e, k) => {
    const u = vertexIndex.get(e.u);
    const v = vertexIndex.get(e.v);
    if (u === undefined || v === undefined) throw new Error(`indexGraph: unknown endpoint on edge ${e.id}`);
    eu[k] = u;
    ev[k] = v;
    ew[k] = toScaled(e.weight);
    required[k] = e.required ? 1 : 0;
    adj[u]!.push(k);
    if (u !== v) adj[v]!.push(k);
  });
  return { graph, n, m, vertexIds, vertexIndex, edgeIds, edgeIndex, eu, ev, ew, required, adj };
}

export function otherEnd(ig: IndexedGraph, k: number, from: number): number {
  return ig.eu[k] === from ? ig.ev[k]! : ig.eu[k]!;
}

export class UnionFind {
  private parent: Int32Array;
  private rank: Uint8Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[x] !== root) {
      const next = this.parent[x]!;
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra]! < this.rank[rb]!) this.parent[ra] = rb;
    else if (this.rank[ra]! > this.rank[rb]!) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra] = this.rank[ra]! + 1;
    }
    return true;
  }
}

/**
 * Connected components of the subgraph formed by the given edges.
 * Only vertices incident to at least one selected edge are reported.
 * Components and their members are ordered by first vertex index.
 */
export function edgeComponents(ig: IndexedGraph, include: (k: number) => boolean): number[][] {
  const uf = new UnionFind(ig.n);
  const touched = new Uint8Array(ig.n);
  for (let k = 0; k < ig.m; k++) {
    if (!include(k)) continue;
    touched[ig.eu[k]!] = 1;
    touched[ig.ev[k]!] = 1;
    uf.union(ig.eu[k]!, ig.ev[k]!);
  }
  const byRoot = new Map<number, number[]>();
  for (let v = 0; v < ig.n; v++) {
    if (!touched[v]) continue;
    const r = uf.find(v);
    let list = byRoot.get(r);
    if (!list) {
      list = [];
      byRoot.set(r, list);
    }
    list.push(v);
  }
  return [...byRoot.values()].sort((a, b) => a[0]! - b[0]!);
}
