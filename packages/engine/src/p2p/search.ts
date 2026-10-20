import { MinHeap } from './heap.js';
import { transitionIndex, weightsFor, type RoutingGraph, type Weights } from './network.js';
import type { Objective } from './profiles.js';

/**
 * Point-to-point shortest paths on the edge-based routing graph.
 *
 * Formulation (shared by every algorithm): a route from city node o to city
 * node t is a sequence of arcs a1 … ak with tail(a1) = o, head(ak) = t and a
 * permitted transition between consecutive arcs. Its cost is
 * cost(a1) + Σ w(a_i → a_{i+1}), where w(a → b) = turn cost + cost(b)
 * (weightsFor). Equivalently: a super-source with edges to every arc leaving o
 * (weight = that arc's cost) and a super-sink reached from every arc entering t
 * (weight 0) — a standard graph with non-negative weights.
 */

export type AlgorithmId = 'dijkstra' | 'astar' | 'bidirectional' | 'alt' | 'ch';

export interface RouteQuery {
  origin: number;
  destination: number;
  objective: Objective;
}

export interface Preprocessing {
  required: boolean;
  done: boolean;
  ms: number;
  bytes: number;
  detail?: string;
}

export interface RouteResult {
  algorithm: AlgorithmId;
  objective: Objective;
  origin: number;
  destination: number;
  found: boolean;
  /** Objective value: seconds (time) or metres (distance). Infinity when not found. */
  cost: number;
  distanceM: number;
  /** Travel time including turn penalties, seconds. */
  timeS: number;
  arcs: number[];
  segments: number[];
  nodePath: number[];
  /** Graph nodes (arcs) settled by the search. */
  expanded: number;
  /** Transitions examined. */
  edgesScanned: number;
  /** Query time without tracing, ms (performance.now). Median when repeat > 1. */
  runtimeMs: number;
  runs: number;
  preprocessing: Preprocessing;
  turns: { straight: number; left: number; right: number; uturn: number };
}

/** Settle order recorded during the search (real execution order). */
export interface SearchTrace {
  count: number;
  arcs: Int32Array;
  cost: Float64Array;
  /** 0 forward, 1 backward. */
  side: Uint8Array;
}

export class TraceRecorder {
  count = 0;
  arcs = new Int32Array(4096);
  cost = new Float64Array(4096);
  side = new Uint8Array(4096);
  push(arc: number, cost: number, side: number): void {
    if (this.count === this.arcs.length) {
      const n = this.arcs.length * 2;
      const a = new Int32Array(n);
      a.set(this.arcs);
      this.arcs = a;
      const c = new Float64Array(n);
      c.set(this.cost);
      this.cost = c;
      const s = new Uint8Array(n);
      s.set(this.side);
      this.side = s;
    }
    this.arcs[this.count] = arc;
    this.cost[this.count] = cost;
    this.side[this.count] = side;
    this.count++;
  }
  finish(): SearchTrace {
    return { count: this.count, arcs: this.arcs.slice(0, this.count), cost: this.cost.slice(0, this.count), side: this.side.slice(0, this.count) };
  }
}

/** Reusable per-graph search arrays with visit stamps (no per-query zero-filling). */
export class Space {
  dist: Float64Array;
  parent: Int32Array;
  stamp: Uint32Array;
  closedStamp: Uint32Array;
  cur = 0;
  heap = new MinHeap(4096);
  constructor(n: number) {
    this.dist = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closedStamp = new Uint32Array(n);
  }
  reset(): void {
    this.cur++;
    if (this.cur === 0xffffffff) {
      this.stamp.fill(0);
      this.closedStamp.fill(0);
      this.cur = 1;
    }
    this.heap.clear();
  }
  get(i: number): number {
    return this.stamp[i] === this.cur ? this.dist[i]! : Infinity;
  }
  set(i: number, d: number, p: number): void {
    this.stamp[i] = this.cur;
    this.dist[i] = d;
    this.parent[i] = p;
  }
  closed(i: number): boolean {
    return this.closedStamp[i] === this.cur;
  }
  close(i: number): void {
    this.closedStamp[i] = this.cur;
  }
}

const spaces = new WeakMap<RoutingGraph, Space[]>();
export function spaceFor(g: RoutingGraph, k: number): Space {
  let list = spaces.get(g);
  if (!list) {
    list = [];
    spaces.set(g, list);
  }
  while (list.length <= k) list.push(new Space(g.arcCount));
  return list[k]!;
}

export interface RawResult {
  found: boolean;
  cost: number;
  arcs: number[];
  expanded: number;
  edgesScanned: number;
}

const NOT_FOUND = (expanded: number, edgesScanned: number): RawResult => ({ found: false, cost: Infinity, arcs: [], expanded, edgesScanned });

function backtrack(sp: Space, last: number): number[] {
  const out: number[] = [];
  for (let a = last; a >= 0; a = sp.parent[a]!) out.push(a);
  return out.reverse();
}

/** Heuristic: lower bound on the remaining cost after arc a (Infinity = target unreachable from a). */
export type Heuristic = (a: number) => number;

/**
 * Unidirectional best-first search (Dijkstra when h ≡ 0, A* otherwise).
 * Nodes may be re-opened when a cheaper label is found, so the result is
 * optimal for any admissible heuristic, consistent or not; the first target
 * arc taken from the queue is optimal.
 */
export function bestFirst(g: RoutingGraph, w: Weights, q: RouteQuery, h: Heuristic | null, trace?: TraceRecorder): RawResult {
  const sp = spaceFor(g, 0);
  sp.reset();
  const heap = sp.heap;
  const { origin, destination } = q;
  let expanded = 0;
  let scanned = 0;
  for (let k = g.nodeOutOff[origin]!; k < g.nodeOutOff[origin + 1]!; k++) {
    const a = g.nodeOutArcs[k]!;
    const d = w.arcCost[a]!;
    if (d < sp.get(a)) {
      const hv = h ? h(a) : 0;
      if (hv === Infinity) continue;
      sp.set(a, d, -1);
      heap.push(d + hv, a);
    }
  }
  while (heap.size > 0) {
    const f = heap.topKey();
    const a = heap.topId();
    heap.pop();
    const gA = sp.get(a);
    const hv = h ? h(a) : 0;
    if (f > gA + hv) continue; // stale entry
    if (sp.closed(a) && !h) continue;
    sp.close(a);
    expanded++;
    if (trace) trace.push(a, gA, 0);
    if (g.arcHead[a] === destination) return { found: true, cost: gA, arcs: backtrack(sp, a), expanded, edgesScanned: scanned };
    for (let k = g.outOff[a]!; k < g.outOff[a + 1]!; k++) {
      scanned++;
      const b = g.outTo[k]!;
      const nd = gA + w.outW[k]!;
      if (nd < sp.get(b)) {
        const hb = h ? h(b) : 0;
        if (hb === Infinity) continue;
        sp.set(b, nd, a);
        heap.push(nd + hb, b);
      }
    }
  }
  return NOT_FOUND(expanded, scanned);
}

/** Straight-line A* heuristic (admissible: Euclidean distance shrunk by 0.5 % and 0.2 m against projection and rounding error, at the fastest speed in the graph). */
export function euclideanHeuristic(g: RoutingGraph, q: RouteQuery): Heuristic {
  const c = g.city;
  const tx = c.nodeX[q.destination]!;
  const ty = c.nodeY[q.destination]!;
  const scale = q.objective === 'time' ? 1 / g.maxSpeedMs : 1;
  return (a: number): number => {
    const n = g.arcHead[a]!;
    const d = Math.hypot(c.nodeX[n]! - tx, c.nodeY[n]! - ty);
    return Math.max(0, 0.995 * d - 0.2) * scale;
  };
}

/** Bidirectional Dijkstra with the standard stopping rule topF + topB ≥ μ. */
export function bidirectional(g: RoutingGraph, w: Weights, q: RouteQuery, trace?: TraceRecorder): RawResult {
  const F = spaceFor(g, 0);
  const B = spaceFor(g, 1);
  F.reset();
  B.reset();
  const { origin, destination } = q;
  let mu = Infinity;
  let meet = -1;
  for (let k = g.nodeOutOff[origin]!; k < g.nodeOutOff[origin + 1]!; k++) {
    const a = g.nodeOutArcs[k]!;
    const d = w.arcCost[a]!;
    if (d < F.get(a)) {
      F.set(a, d, -1);
      F.heap.push(d, a);
    }
  }
  for (let k = g.nodeInOff[destination]!; k < g.nodeInOff[destination + 1]!; k++) {
    const a = g.nodeInArcs[k]!;
    B.set(a, 0, -1);
    B.heap.push(0, a);
    const df = F.get(a);
    if (df < mu) {
      mu = df;
      meet = a;
    }
  }
  let expanded = 0;
  let scanned = 0;
  while (F.heap.size > 0 || B.heap.size > 0) {
    if (F.heap.topKey() + B.heap.topKey() >= mu) break;
    const forward = F.heap.topKey() <= B.heap.topKey();
    if (forward) {
      const k0 = F.heap.topKey();
      const a = F.heap.topId();
      F.heap.pop();
      if (F.closed(a) || k0 > F.get(a)) continue;
      F.close(a);
      expanded++;
      if (trace) trace.push(a, k0, 0);
      for (let k = g.outOff[a]!; k < g.outOff[a + 1]!; k++) {
        scanned++;
        const b = g.outTo[k]!;
        const nd = k0 + w.outW[k]!;
        if (nd < F.get(b)) {
          F.set(b, nd, a);
          F.heap.push(nd, b);
          const db = B.get(b);
          if (nd + db < mu) {
            mu = nd + db;
            meet = b;
          }
        }
      }
    } else {
      const k0 = B.heap.topKey();
      const a = B.heap.topId();
      B.heap.pop();
      if (B.closed(a) || k0 > B.get(a)) continue;
      B.close(a);
      expanded++;
      if (trace) trace.push(a, k0, 1);
      for (let k = g.inOff[a]!; k < g.inOff[a + 1]!; k++) {
        scanned++;
        const p = g.inFrom[k]!;
        const nd = k0 + w.inW[k]!;
        if (nd < B.get(p)) {
          B.set(p, nd, a);
          B.heap.push(nd, p);
          const df = F.get(p);
          if (df + nd < mu) {
            mu = df + nd;
            meet = p;
          }
        }
      }
    }
  }
  if (meet < 0 || mu === Infinity) return NOT_FOUND(expanded, scanned);
  const arcs = backtrack(F, meet);
  for (let a = B.parent[meet]!; a >= 0; a = B.parent[a]!) arcs.push(a);
  return { found: true, cost: mu, arcs, expanded, edgesScanned: scanned };
}

/** Distance, time (incl. turn penalties) and turn counts of an arc sequence, recomputed from graph data. */
export function measureArcs(g: RoutingGraph, arcs: readonly number[]): { distanceM: number; timeS: number; turns: RouteResult['turns']; ok: boolean } {
  let d = 0;
  let t = 0;
  let ok = true;
  const turns = { straight: 0, left: 0, right: 0, uturn: 0 };
  for (let i = 0; i < arcs.length; i++) {
    const a = arcs[i]!;
    d += g.arcLen[a]!;
    t += g.arcTime[a]!;
    if (i > 0) {
      const k = transitionIndex(g, arcs[i - 1]!, a);
      if (k < 0) {
        ok = false;
        continue;
      }
      t += g.outPen[k]!;
      const code = g.outTurn[k]!;
      if (code === 0) turns.straight++;
      else if (code === 1) turns.left++;
      else if (code === 2) turns.right++;
      else turns.uturn++;
    }
  }
  return { distanceM: d, timeS: t, turns, ok };
}

export function toResult(g: RoutingGraph, algorithm: AlgorithmId, q: RouteQuery, raw: RawResult, runtimeMs: number, runs: number, preprocessing: Preprocessing): RouteResult {
  if (q.origin === q.destination) {
    return {
      algorithm,
      objective: q.objective,
      origin: q.origin,
      destination: q.destination,
      found: true,
      cost: 0,
      distanceM: 0,
      timeS: 0,
      arcs: [],
      segments: [],
      nodePath: [q.origin],
      expanded: 0,
      edgesScanned: 0,
      runtimeMs,
      runs,
      preprocessing,
      turns: { straight: 0, left: 0, right: 0, uturn: 0 },
    };
  }
  const m = measureArcs(g, raw.arcs);
  return {
    algorithm,
    objective: q.objective,
    origin: q.origin,
    destination: q.destination,
    found: raw.found,
    cost: raw.cost,
    distanceM: raw.found ? m.distanceM : Infinity,
    timeS: raw.found ? m.timeS : Infinity,
    arcs: raw.arcs,
    segments: raw.arcs.map((a) => a >> 1),
    nodePath: raw.found ? [g.arcTail[raw.arcs[0]!]!, ...raw.arcs.map((a) => g.arcHead[a]!)] : [],
    expanded: raw.expanded,
    edgesScanned: raw.edgesScanned,
    runtimeMs,
    runs,
    preprocessing,
    turns: m.turns,
  };
}

export { weightsFor };
