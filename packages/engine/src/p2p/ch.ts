import { MinHeap } from './heap.js';
import { weightsFor, type RoutingGraph } from './network.js';
import type { Objective } from './profiles.js';
import type { RawResult, RouteQuery } from './search.js';
import type { TraceRecorder } from './search.js';

/**
 * Contraction Hierarchies (Geisberger et al. 2008) on the EDGE-BASED graph,
 * so turn restrictions and turn costs are part of the contracted graph and
 * every CH answer is exact for the same cost function as Dijkstra.
 *
 * Preprocessing: nodes (arcs) are contracted in order of a lazily updated
 * priority (edge difference + contracted neighbours). Contracting v adds a
 * shortcut u → w for every pair of uncontracted neighbours unless a witness
 * search (Dijkstra from u avoiding v, bounded by the shortcut cost and a
 * settle limit) finds a path no longer than u → v → w. A bounded witness
 * search can only ADD unnecessary shortcuts, never omit a needed one, so
 * correctness does not depend on the limit.
 *
 * Query: bidirectional search restricted to upward edges, from all arcs
 * leaving the origin (label = arc cost) and all arcs entering the destination
 * (label 0); each side stops when its smallest key reaches the best meeting
 * cost μ. Shortcuts are unpacked recursively into real arcs.
 */
export interface ContractionHierarchy {
  objective: Objective;
  rank: Int32Array;
  /** Edge store: original transitions first (index = transition index), then shortcuts. */
  eFrom: Int32Array;
  eTo: Int32Array;
  eW: Float64Array;
  eC1: Int32Array;
  eC2: Int32Array;
  originalEdges: number;
  shortcuts: number;
  /** Upward edges out of each node (forward search) and upward edges into each node (backward search). */
  upOutOff: Int32Array;
  upOut: Int32Array;
  upInOff: Int32Array;
  upIn: Int32Array;
  ms: number;
  bytes: number;
  witnessSettleLimit: number;
}

class Grow {
  from: number[] = [];
  to: number[] = [];
  w: number[] = [];
  c1: number[] = [];
  c2: number[] = [];
  add(f: number, t: number, w: number, c1: number, c2: number): number {
    this.from.push(f);
    this.to.push(t);
    this.w.push(w);
    this.c1.push(c1);
    this.c2.push(c2);
    return this.from.length - 1;
  }
}

export function buildCH(g: RoutingGraph, objective: Objective, opts: { settleLimit?: number } = {}): ContractionHierarchy {
  const t0 = performance.now();
  const limit = opts.settleLimit ?? 60;
  const W = weightsFor(g, objective);
  const A = g.arcCount;
  const E = new Grow();
  const outAdj: Map<number, number>[] = new Array(A);
  const inAdj: Map<number, number>[] = new Array(A);
  for (let a = 0; a < A; a++) {
    outAdj[a] = new Map();
    inAdj[a] = new Map();
  }
  for (let a = 0; a < A; a++) {
    for (let k = g.outOff[a]!; k < g.outOff[a + 1]!; k++) {
      const b = g.outTo[k]!;
      const id = E.add(a, b, W.outW[k]!, -1, -1);
      outAdj[a]!.set(b, id);
      inAdj[b]!.set(a, id);
    }
  }
  const originalEdges = E.from.length;
  const contracted = new Uint8Array(A);
  const deletedNeighbors = new Int32Array(A);
  // Witness search state.
  const wDist = new Float64Array(A);
  const wStamp = new Uint32Array(A);
  let stamp = 0;
  const wHeap = new MinHeap(256);

  /** Bounded Dijkstra from u avoiding v; returns nothing, distances readable through wd(). */
  const witness = (u: number, v: number, maxCost: number): void => {
    stamp++;
    wHeap.clear();
    wStamp[u] = stamp;
    wDist[u] = 0;
    wHeap.push(0, u);
    let settled = 0;
    while (wHeap.size > 0) {
      const d = wHeap.topKey();
      const x = wHeap.topId();
      wHeap.pop();
      if (d > wDist[x]!) continue;
      if (d > maxCost) break;
      if (++settled > limit) break;
      for (const [y, e] of outAdj[x]!) {
        if (y === v || contracted[y]) continue;
        const nd = d + E.w[e]!;
        if (wStamp[y] !== stamp || nd < wDist[y]!) {
          wStamp[y] = stamp;
          wDist[y] = nd;
          wHeap.push(nd, y);
        }
      }
    }
  };
  const wd = (x: number): number => (wStamp[x] === stamp ? wDist[x]! : Infinity);

  /** Shortcuts needed to contract v: list of [u, w, cost, e1, e2]. */
  const needed = (v: number): [number, number, number, number, number][] => {
    const out: [number, number, number, number, number][] = [];
    const ins = [...inAdj[v]!].filter(([u]) => !contracted[u]);
    const outs = [...outAdj[v]!].filter(([w]) => !contracted[w]);
    if (ins.length === 0 || outs.length === 0) return out;
    for (const [u, e1] of ins) {
      let maxCost = 0;
      for (const [w, e2] of outs) if (w !== u) maxCost = Math.max(maxCost, E.w[e1]! + E.w[e2]!);
      witness(u, v, maxCost);
      for (const [w, e2] of outs) {
        if (w === u) continue;
        const c = E.w[e1]! + E.w[e2]!;
        if (wd(w) <= c) continue;
        out.push([u, w, c, e1, e2]);
      }
    }
    return out;
  };
  const priority = (v: number): number => {
    const sc = needed(v).length;
    let deg = 0;
    for (const [u] of inAdj[v]!) if (!contracted[u]) deg++;
    for (const [w] of outAdj[v]!) if (!contracted[w]) deg++;
    return sc - deg + deletedNeighbors[v]!;
  };

  const pq = new MinHeap(A);
  for (let v = 0; v < A; v++) pq.push(priority(v), v);
  const rank = new Int32Array(A).fill(-1);
  const upOutLists: number[][] = new Array(A);
  const upInLists: number[][] = new Array(A);
  let order = 0;
  while (pq.size > 0) {
    const v = pq.topId();
    pq.pop();
    if (contracted[v]) continue;
    const p = priority(v);
    if (pq.size > 0 && p > pq.topKey()) {
      pq.push(p, v);
      continue;
    }
    // Contract v.
    const sc = needed(v);
    for (const [u, w, c, e1, e2] of sc) {
      const existing = outAdj[u]!.get(w);
      if (existing !== undefined) {
        if (E.w[existing]! <= c) continue;
        E.w[existing] = c;
        E.c1[existing] = e1;
        E.c2[existing] = e2;
      } else {
        const id = E.add(u, w, c, e1, e2);
        outAdj[u]!.set(w, id);
        inAdj[w]!.set(u, id);
      }
    }
    const ups: number[] = [];
    const downs: number[] = [];
    for (const [w, e] of outAdj[v]!) if (!contracted[w]) ups.push(e);
    for (const [u, e] of inAdj[v]!) if (!contracted[u]) downs.push(e);
    upOutLists[v] = ups;
    upInLists[v] = downs;
    for (const [w] of outAdj[v]!) if (!contracted[w]) {
      inAdj[w]!.delete(v);
      deletedNeighbors[w]!++;
    }
    for (const [u] of inAdj[v]!) if (!contracted[u]) {
      outAdj[u]!.delete(v);
      deletedNeighbors[u]!++;
    }
    contracted[v] = 1;
    rank[v] = order++;
  }
  const toCsr = (lists: number[][]): { off: Int32Array; arr: Int32Array } => {
    const off = new Int32Array(A + 1);
    for (let v = 0; v < A; v++) off[v + 1] = off[v]! + (lists[v]?.length ?? 0);
    const arr = new Int32Array(off[A]!);
    for (let v = 0; v < A; v++) arr.set(lists[v] ?? [], off[v]!);
    return { off, arr };
  };
  const uo = toCsr(upOutLists);
  const ui = toCsr(upInLists);
  const eFrom = Int32Array.from(E.from);
  const eTo = Int32Array.from(E.to);
  const eW = Float64Array.from(E.w);
  const eC1 = Int32Array.from(E.c1);
  const eC2 = Int32Array.from(E.c2);
  const bytes = eFrom.byteLength * 4 + eW.byteLength + uo.arr.byteLength + ui.arr.byteLength + uo.off.byteLength * 2 + rank.byteLength;
  return {
    objective,
    rank,
    eFrom,
    eTo,
    eW,
    eC1,
    eC2,
    originalEdges,
    shortcuts: eFrom.length - originalEdges,
    upOutOff: uo.off,
    upOut: uo.arr,
    upInOff: ui.off,
    upIn: ui.arr,
    ms: performance.now() - t0,
    bytes,
    witnessSettleLimit: limit,
  };
}

/** Unpack an edge into the arcs it passes AFTER its tail (iterative, so deep shortcut nesting is safe). */
function unpackInto(ch: ContractionHierarchy, e: number, out: number[]): void {
  const stack = [e];
  while (stack.length) {
    const x = stack.pop()!;
    if (ch.eC1[x]! < 0) out.push(ch.eTo[x]!);
    else {
      stack.push(ch.eC2[x]!);
      stack.push(ch.eC1[x]!);
    }
  }
}

interface ChSpace {
  dF: Float64Array;
  dB: Float64Array;
  sF: Uint32Array;
  sB: Uint32Array;
  pF: Int32Array;
  pB: Int32Array;
  cur: number;
  hF: MinHeap;
  hB: MinHeap;
}
const chSpaces = new WeakMap<ContractionHierarchy, ChSpace>();

export function chQuery(g: RoutingGraph, ch: ContractionHierarchy, q: RouteQuery, trace?: TraceRecorder): RawResult {
  if (ch.objective !== q.objective) throw new Error(`Contraction hierarchy was built for '${ch.objective}', query asks for '${q.objective}'.`);
  const A = g.arcCount;
  let s = chSpaces.get(ch);
  if (!s) {
    s = { dF: new Float64Array(A), dB: new Float64Array(A), sF: new Uint32Array(A), sB: new Uint32Array(A), pF: new Int32Array(A), pB: new Int32Array(A), cur: 0, hF: new MinHeap(256), hB: new MinHeap(256) };
    chSpaces.set(ch, s);
  }
  const sp = s;
  sp.cur++;
  const cur = sp.cur;
  sp.hF.clear();
  sp.hB.clear();
  const getF = (x: number): number => (sp.sF[x] === cur ? sp.dF[x]! : Infinity);
  const getB = (x: number): number => (sp.sB[x] === cur ? sp.dB[x]! : Infinity);
  const W = weightsFor(g, q.objective);
  let mu = Infinity;
  let meet = -1;
  for (let k = g.nodeOutOff[q.origin]!; k < g.nodeOutOff[q.origin + 1]!; k++) {
    const a = g.nodeOutArcs[k]!;
    const d = W.arcCost[a]!;
    if (d < getF(a)) {
      sp.sF[a] = cur;
      sp.dF[a] = d;
      sp.pF[a] = -1;
      sp.hF.push(d, a);
    }
  }
  for (let k = g.nodeInOff[q.destination]!; k < g.nodeInOff[q.destination + 1]!; k++) {
    const a = g.nodeInArcs[k]!;
    sp.sB[a] = cur;
    sp.dB[a] = 0;
    sp.pB[a] = -1;
    sp.hB.push(0, a);
    const f = getF(a);
    if (f < mu) {
      mu = f;
      meet = a;
    }
  }
  let expanded = 0;
  let scanned = 0;
  let doneF = false;
  let doneB = false;
  while (!doneF || !doneB) {
    const useF = !doneF && (doneB || sp.hF.topKey() <= sp.hB.topKey());
    const heap = useF ? sp.hF : sp.hB;
    if (heap.size === 0 || heap.topKey() >= mu) {
      if (useF) doneF = true;
      else doneB = true;
      continue;
    }
    const d = heap.topKey();
    const x = heap.topId();
    heap.pop();
    if (useF ? d > getF(x) : d > getB(x)) continue;
    expanded++;
    if (trace) trace.push(x, d, useF ? 0 : 1);
    if (useF) {
      for (let k = ch.upOutOff[x]!; k < ch.upOutOff[x + 1]!; k++) {
        scanned++;
        const e = ch.upOut[k]!;
        const y = ch.eTo[e]!;
        const nd = d + ch.eW[e]!;
        if (nd < getF(y)) {
          sp.sF[y] = cur;
          sp.dF[y] = nd;
          sp.pF[y] = e;
          sp.hF.push(nd, y);
          const b = getB(y);
          if (nd + b < mu) {
            mu = nd + b;
            meet = y;
          }
        }
      }
    } else {
      for (let k = ch.upInOff[x]!; k < ch.upInOff[x + 1]!; k++) {
        scanned++;
        const e = ch.upIn[k]!;
        const y = ch.eFrom[e]!;
        const nd = d + ch.eW[e]!;
        if (nd < getB(y)) {
          sp.sB[y] = cur;
          sp.dB[y] = nd;
          sp.pB[y] = e;
          sp.hB.push(nd, y);
          const f = getF(y);
          if (f + nd < mu) {
            mu = f + nd;
            meet = y;
          }
        }
      }
    }
  }
  if (meet < 0 || mu === Infinity) return { found: false, cost: Infinity, arcs: [], expanded, edgesScanned: scanned };
  // Forward chain: edges from the source up to meet.
  const fEdges: number[] = [];
  let x = meet;
  while (sp.pF[x]! >= 0) {
    const e = sp.pF[x]!;
    fEdges.push(e);
    x = ch.eFrom[e]!;
  }
  const arcs: number[] = [x];
  for (let i = fEdges.length - 1; i >= 0; i--) unpackInto(ch, fEdges[i]!, arcs);
  let y = meet;
  while (sp.pB[y]! >= 0) {
    const e = sp.pB[y]!;
    unpackInto(ch, e, arcs);
    y = ch.eTo[e]!;
  }
  return { found: true, cost: mu, arcs, expanded, edgesScanned: scanned };
}
