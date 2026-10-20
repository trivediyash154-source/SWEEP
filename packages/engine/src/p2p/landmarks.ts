import { MinHeap } from './heap.js';
import { weightsFor, type RoutingGraph, type Weights } from './network.js';
import type { Objective } from './profiles.js';
import type { Heuristic, RouteQuery } from './search.js';

/**
 * ALT (A*, Landmarks, Triangle inequality; Goldberg & Harrelson 2005) on the
 * edge-based graph.
 *
 * With δ(x, y) the folded distance (costs after x up to and including y), for
 * every landmark L and every target arc e:
 *   δ(a, e) ≥ δ(L, e) − δ(L, a)      and      δ(a, e) ≥ δ(a, L) − δ(e, L).
 * The target is a SET of arcs (all arcs entering the destination node), so
 *   min_e δ(a, e) ≥ max_L max( min_e δ(L, e) − δ(L, a),  δ(a, L) − max_e δ(e, L) ),
 * which is a valid lower bound. Infinite distances are handled exactly: if L
 * reaches a but no target arc, or every target arc reaches L but a does not,
 * then no target arc is reachable from a and the bound is +∞ (pruned); terms
 * with an infinite δ(L, a) or max_e δ(e, L) carry no information and are skipped.
 */
export interface Landmarks {
  objective: Objective;
  k: number;
  arcs: number[];
  /** δ(L, x): row-major k × arcCount. */
  from: Float64Array;
  /** δ(x, L). */
  to: Float64Array;
  ms: number;
  bytes: number;
}

function sssp(g: RoutingGraph, w: Weights, src: number, reverse: boolean, out: Float64Array, offset: number): void {
  const A = g.arcCount;
  for (let i = 0; i < A; i++) out[offset + i] = Infinity;
  const heap = new MinHeap(1024);
  out[offset + src] = 0;
  heap.push(0, src);
  while (heap.size > 0) {
    const d = heap.topKey();
    const a = heap.topId();
    heap.pop();
    if (d > out[offset + a]!) continue;
    if (!reverse) {
      for (let k = g.outOff[a]!; k < g.outOff[a + 1]!; k++) {
        const b = g.outTo[k]!;
        const nd = d + w.outW[k]!;
        if (nd < out[offset + b]!) {
          out[offset + b] = nd;
          heap.push(nd, b);
        }
      }
    } else {
      for (let k = g.inOff[a]!; k < g.inOff[a + 1]!; k++) {
        const p = g.inFrom[k]!;
        const nd = d + w.inW[k]!;
        if (nd < out[offset + p]!) {
          out[offset + p] = nd;
          heap.push(nd, p);
        }
      }
    }
  }
}

/**
 * Farthest-landmark selection: start from the allowed arc farthest from the
 * arc nearest the network centre, then repeatedly add the arc that maximises
 * its smallest distance to the chosen landmarks (both directions, finite only).
 */
export function buildLandmarks(g: RoutingGraph, objective: Objective, k = 8): Landmarks {
  const t0 = performance.now();
  const w = weightsFor(g, objective);
  const A = g.arcCount;
  const c = g.city;
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (let a = 0; a < A; a++) {
    if (!g.arcAllowed[a]) continue;
    cx += c.nodeX[g.arcHead[a]!]!;
    cy += c.nodeY[g.arcHead[a]!]!;
    n++;
  }
  const from = new Float64Array(k * A);
  const to = new Float64Array(k * A);
  const chosen: number[] = [];
  if (n === 0) return { objective, k: 0, arcs: [], from: new Float64Array(0), to: new Float64Array(0), ms: performance.now() - t0, bytes: 0 };
  cx /= n;
  cy /= n;
  let seed = -1;
  let best = Infinity;
  for (let a = 0; a < A; a++) {
    if (!g.arcAllowed[a] || g.outOff[a + 1]! === g.outOff[a]!) continue;
    const h = g.arcHead[a]!;
    const d = Math.hypot(c.nodeX[h]! - cx, c.nodeY[h]! - cy);
    if (d < best) {
      best = d;
      seed = a;
    }
  }
  if (seed < 0) return { objective, k: 0, arcs: [], from: new Float64Array(0), to: new Float64Array(0), ms: performance.now() - t0, bytes: 0 };
  // First landmark: farthest (finite) from the seed.
  const tmp = new Float64Array(A);
  sssp(g, w, seed, false, tmp, 0);
  let first = seed;
  let far = -1;
  for (let a = 0; a < A; a++) if (Number.isFinite(tmp[a]!) && tmp[a]! > far) {
    far = tmp[a]!;
    first = a;
  }
  const minD = new Float64Array(A).fill(Infinity);
  let next = first;
  for (let i = 0; i < k; i++) {
    chosen.push(next);
    sssp(g, w, next, false, from, i * A);
    sssp(g, w, next, true, to, i * A);
    for (let a = 0; a < A; a++) {
      const f = from[i * A + a]!;
      const t = to[i * A + a]!;
      const m = Math.min(f, t);
      if (m < minD[a]!) minD[a] = m;
    }
    let pick = -1;
    let pickScore = -1;
    for (let a = 0; a < A; a++) {
      if (!g.arcAllowed[a] || chosen.includes(a)) continue;
      const s = minD[a]!;
      // Only arcs connected to the landmarks in both directions are useful.
      if (!Number.isFinite(s)) continue;
      if (s > pickScore) {
        pickScore = s;
        pick = a;
      }
    }
    if (pick < 0) break;
    next = pick;
  }
  const kk = chosen.length;
  return { objective, k: kk, arcs: chosen, from: from.subarray(0, kk * A), to: to.subarray(0, kk * A), ms: performance.now() - t0, bytes: 2 * kk * A * 8 };
}

/** ALT heuristic for one query (target = every allowed arc entering the destination). */
export function altHeuristic(g: RoutingGraph, lm: Landmarks, q: RouteQuery): Heuristic {
  const A = g.arcCount;
  const K = lm.k;
  const minFromE = new Float64Array(K).fill(Infinity);
  const maxToE = new Float64Array(K).fill(-Infinity);
  const ends: number[] = [];
  for (let k = g.nodeInOff[q.destination]!; k < g.nodeInOff[q.destination + 1]!; k++) ends.push(g.nodeInArcs[k]!);
  for (let i = 0; i < K; i++) {
    for (const e of ends) {
      const f = lm.from[i * A + e]!;
      const t = lm.to[i * A + e]!;
      if (f < minFromE[i]!) minFromE[i] = f;
      if (t > maxToE[i]!) maxToE[i] = t;
    }
  }
  if (ends.length === 0) return () => Infinity;
  return (a: number): number => {
    let h = 0;
    for (let i = 0; i < K; i++) {
      const la = lm.from[i * A + a]!;
      // Term 1: δ(L,e) ≤ δ(L,a) + δ(a,e).
      if (Number.isFinite(la)) {
        if (minFromE[i] === Infinity) return Infinity; // L reaches a but no target arc ⇒ a reaches no target arc
        const t1 = minFromE[i]! - la;
        if (t1 > h) h = t1;
      }
      // Term 2: δ(a,L) ≤ δ(a,e) + δ(e,L).
      const al = lm.to[i * A + a]!;
      const me = maxToE[i]!;
      if (Number.isFinite(me)) {
        if (al === Infinity) return Infinity; // every target arc reaches L, a does not ⇒ a reaches no target arc
        const t2 = al - me;
        if (t2 > h) h = t2;
      }
    }
    // Guard against floating-point rounding making the bound exceed the true value.
    return h * (1 - 1e-12);
  };
}
