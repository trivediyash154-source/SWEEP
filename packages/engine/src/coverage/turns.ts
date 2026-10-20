import type { CityModel } from '../city/types.js';
import type { Graph, RouteStep } from '../types.js';
import { toScaled, fromScaled } from '../units.js';
import { classifyTurn, PROFILE_SPECS, restrictionApplies, type ProfileId, type TurnKind, type TurnPenalties } from '../p2p/profiles.js';
import { sparseAssignment } from './assignment.js';
import { MinHeap } from './arcs.js';

/**
 * Turns along coverage routes.
 *
 * Every closed walk that drives the same street traversals (same streets, same
 * directions, same number of times) has the same length, but not the same turns:
 * at each intersection the order in which the vehicle leaves after each arrival is
 * free. `orderForTurns` picks that order to reduce turn penalties (U-turns, then
 * right turns in left-hand traffic) and banned turns, without changing the length.
 *
 * Method (heuristic for an NP-hard problem; a lower bound is reported):
 *  1. At every intersection, pair each arrival with a departure by an exact
 *     assignment (`sparseAssignment`) of minimum penalty. At the depot one free
 *     pair is the start and the end of the route.
 *  2. The pairing splits the traversals into closed sub-tours. They are merged
 *     greedily: swapping the departures of two arrivals at a shared intersection
 *     joins their sub-tours; the swap with the smallest added penalty goes first.
 *  3. The result is kept only if it is no worse than the original order.
 *
 * Lower bounds, valid for every order of these traversals: the sum over
 * intersections of the optimal pairing's penalty, and, separately, of the
 * minimum number of banned turns. When the route reaches both, its order is
 * optimal for these traversals. A different choice of deadhead streets could do
 * better; the bound does not cover that.
 */

export interface TurnTally {
  straight: number;
  left: number;
  right: number;
  uturn: number;
  /** U-turns at intersections where another street continues (not forced by a dead end). */
  uturnsAwayFromDeadEnds: number;
  /** Turns forbidden by a mapped turn restriction. */
  banned: number;
  /** Sum of the turn penalties, seconds. */
  seconds: number;
}

/** Whether driving from `fromEdgeId` through vertex `via` into `toEdgeId` is a banned turn. */
export type TurnBan = (fromEdgeId: string, via: string, toEdgeId: string) => boolean;

export interface TurnOptions {
  penalties: TurnPenalties;
  banned?: TurnBan | null;
}

export interface TurnOrder {
  steps: RouteStep[];
  before: TurnTally;
  after: TurnTally;
  lowerBound: { seconds: number; banned: number };
  /** The order reaches both lower bounds, so no order of these traversals has fewer penalty seconds or banned turns. */
  optimal: boolean;
  /** False when the original order was kept (not a closed walk from the depot, or nothing better was found). */
  reordered: boolean;
  /** Sub-tours after the per-intersection pairing, before merging. */
  subTours: number;
  ms: number;
}

/** Penalty weight of one banned turn: larger than any penalty difference at one intersection. */
const BANNED = 1e6;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Turn geometry of a graph: travel directions at both ends of every edge, and dead ends. */
export class TurnModel {
  private readonly edgeIndex = new Map<string, number>();
  private readonly outU: Float64Array;
  private readonly inV: Float64Array;
  private readonly ends: [string, string][];
  private readonly degree = new Map<string, number>();

  constructor(
    graph: Graph,
    private readonly opts: TurnOptions,
  ) {
    const pos = new Map(graph.vertices.map((v) => [v.id, [v.x, v.y] as const]));
    const m = graph.edges.length;
    this.outU = new Float64Array(2 * m);
    this.inV = new Float64Array(2 * m);
    this.ends = graph.edges.map((e) => [e.u, e.v]);
    graph.edges.forEach((e, k) => {
      this.edgeIndex.set(e.id, k);
      const pts: (readonly [number, number])[] = [pos.get(e.u) ?? [0, 0], ...(e.shape ?? []).map((p) => [p[0], p[1]] as const), pos.get(e.v) ?? [0, 0]];
      // First direction leaving u and last direction arriving at v that are not zero.
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i]![0] - pts[0]![0];
        const dy = pts[i]![1] - pts[0]![1];
        if (dx !== 0 || dy !== 0) {
          this.outU[2 * k] = dx;
          this.outU[2 * k + 1] = dy;
          break;
        }
      }
      const last = pts[pts.length - 1]!;
      for (let i = pts.length - 2; i >= 0; i--) {
        const dx = last[0] - pts[i]![0];
        const dy = last[1] - pts[i]![1];
        if (dx !== 0 || dy !== 0) {
          this.inV[2 * k] = dx;
          this.inV[2 * k + 1] = dy;
          break;
        }
      }
      this.degree.set(e.u, (this.degree.get(e.u) ?? 0) + 1);
      if (e.v !== e.u) this.degree.set(e.v, (this.degree.get(e.v) ?? 0) + 1);
    });
  }

  private forward(s: RouteStep, k: number): boolean {
    const [u, v] = this.ends[k]!;
    return u === v || (s.from === u && s.to === v);
  }

  /** Kind of turn from step a into step b (b starts where a ends). */
  kind(a: RouteStep, b: RouteStep): TurnKind {
    if (a.edgeId === b.edgeId && a.from !== a.to && b.from === a.to && b.to === a.from) return 'uturn';
    const ka = this.edgeIndex.get(a.edgeId);
    const kb = this.edgeIndex.get(b.edgeId);
    if (ka === undefined || kb === undefined) return 'straight';
    const fa = this.forward(a, ka);
    const fb = this.forward(b, kb);
    const inX = fa ? this.inV[2 * ka]! : -this.outU[2 * ka]!;
    const inY = fa ? this.inV[2 * ka + 1]! : -this.outU[2 * ka + 1]!;
    const outX = fb ? this.outU[2 * kb]! : -this.inV[2 * kb]!;
    const outY = fb ? this.outU[2 * kb + 1]! : -this.inV[2 * kb + 1]!;
    return classifyTurn(inX, inY, outX, outY);
  }

  isBanned(a: RouteStep, b: RouteStep): boolean {
    return !!this.opts.banned && this.opts.banned(a.edgeId, a.to, b.edgeId);
  }

  deadEnd(v: string): boolean {
    return (this.degree.get(v) ?? 0) <= 1;
  }

  seconds(a: RouteStep, b: RouteStep): number {
    return this.opts.penalties[this.kind(a, b)];
  }

  /** Turns of a walk, from its first step to its last (none before the start or after the end). */
  tally(steps: readonly RouteStep[]): TurnTally {
    const t: TurnTally = { straight: 0, left: 0, right: 0, uturn: 0, uturnsAwayFromDeadEnds: 0, banned: 0, seconds: 0 };
    for (let i = 0; i + 1 < steps.length; i++) {
      const a = steps[i]!;
      const b = steps[i + 1]!;
      const k = this.kind(a, b);
      t[k]++;
      if (k === 'uturn' && !this.deadEnd(a.to)) t.uturnsAwayFromDeadEnds++;
      if (this.isBanned(a, b)) t.banned++;
      t.seconds += this.opts.penalties[k];
    }
    return t;
  }
}

/** Renumber steps and recompute cumulative distances (exact, in scaled units). */
function renumber(steps: readonly RouteStep[]): RouteStep[] {
  let cum = 0;
  return steps.map((s, i) => {
    cum += toScaled(s.weight);
    return { ...s, index: i, cumulative: fromScaled(cum) };
  });
}

/**
 * Reorder a closed walk from the depot to reduce turn penalties and banned turns,
 * keeping every traversal (and so the length) unchanged. Steps keep their kinds.
 */
export function orderForTurns(graph: Graph, steps: readonly RouteStep[], depotId: string, opts: TurnOptions): TurnOrder {
  const t0 = now();
  const model = new TurnModel(graph, opts);
  const before = model.tally(steps);
  const keep = (lb = { seconds: before.seconds, banned: before.banned }, subTours = 1): TurnOrder => ({
    steps: renumber(steps),
    before,
    after: before,
    lowerBound: lb,
    optimal: before.seconds <= lb.seconds + 1e-9 && before.banned <= lb.banned,
    reordered: false,
    subTours,
    ms: now() - t0,
  });
  const n = steps.length;
  if (n < 2) return keep();
  // Only closed walks from the depot can be reordered.
  if (steps[0]!.from !== depotId || steps[n - 1]!.to !== depotId) return { ...keep({ seconds: 0, banned: 0 }), optimal: false };
  for (let i = 0; i + 1 < n; i++) if (steps[i]!.to !== steps[i + 1]!.from) return { ...keep({ seconds: 0, banned: 0 }), optimal: false };

  // Step n is the virtual start/end at the depot: arriving there ends the route, leaving it starts the route.
  const S = n;
  const ins = new Map<string, number[]>();
  const outs = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const s = steps[i]!;
    (ins.get(s.to) ?? ins.set(s.to, []).get(s.to)!).push(i);
    (outs.get(s.from) ?? outs.set(s.from, []).get(s.from)!).push(i);
  }
  ins.get(depotId)!.push(S);
  outs.get(depotId)!.push(S);
  const cost = (a: number, b: number): number => {
    if (a === S && b === S) return Infinity;
    if (a === S || b === S) return 0;
    const sa = steps[a]!;
    const sb = steps[b]!;
    return model.seconds(sa, sb) + (model.isBanned(sa, sb) ? BANNED : 0);
  };

  // 1. Optimal pairing at every intersection, and the two lower bounds.
  const succ = new Int32Array(n + 1).fill(-1);
  let lbSeconds = 0;
  let lbBanned = 0;
  const solve = (rows: number[], cols: number[], c: (a: number, b: number) => number): Int32Array | null => {
    const k = rows.length;
    const rowOff = new Int32Array(k + 1);
    const col: number[] = [];
    const cst: number[] = [];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        const w = c(rows[i]!, cols[j]!);
        if (!Number.isFinite(w)) continue;
        col.push(j);
        cst.push(w);
      }
      rowOff[i + 1] = col.length;
    }
    const r = sparseAssignment(k, rowOff, Int32Array.from(col), Float64Array.from(cst));
    return r ? r.rowSol : null;
  };
  for (const [v, rows] of ins) {
    const cols = outs.get(v) ?? [];
    if (cols.length !== rows.length) return { ...keep({ seconds: 0, banned: 0 }), optimal: false }; // not balanced: not a closed walk
    const best = solve(rows, cols, cost);
    if (!best) return { ...keep({ seconds: 0, banned: 0 }), optimal: false };
    rows.forEach((a, i) => (succ[a] = cols[best[i]!]!));
    // Bounds: penalty seconds alone, and banned turns alone (each valid for every order).
    const secOnly = (a: number, b: number): number => (a === S && b === S ? Infinity : a === S || b === S ? 0 : model.seconds(steps[a]!, steps[b]!));
    const banOnly = (a: number, b: number): number => (a === S && b === S ? Infinity : a === S || b === S ? 0 : model.isBanned(steps[a]!, steps[b]!) ? 1 : 0);
    const bs = solve(rows, cols, secOnly)!;
    rows.forEach((a, i) => (lbSeconds += secOnly(a, cols[bs[i]!]!)));
    if (opts.banned) {
      const bb = solve(rows, cols, banOnly)!;
      rows.forEach((a, i) => (lbBanned += banOnly(a, cols[bb[i]!]!)));
    }
  }
  const lowerBound = { seconds: lbSeconds, banned: lbBanned };

  // 2. Sub-tours of the pairing, merged greedily at shared intersections.
  const tour = new Int32Array(n + 1).fill(-1);
  let subTours = 0;
  for (let i = 0; i <= n; i++) {
    if (tour[i]! >= 0) continue;
    let x = i;
    while (tour[x]! < 0) {
      tour[x] = subTours;
      x = succ[x]!;
    }
    subTours++;
  }
  const parent = Int32Array.from({ length: subTours }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const heap = new MinHeap();
  const cand: number[] = []; // per candidate: a, c, succ[a], succ[c]
  const push = (a: number, c: number): void => {
    if (find(tour[a]!) === find(tour[c]!)) return;
    const sa = succ[a]!;
    const sc = succ[c]!;
    const delta = cost(a, sc) + cost(c, sa) - cost(a, sa) - cost(c, sc);
    if (!Number.isFinite(delta)) return;
    heap.push(delta, cand.length / 4);
    cand.push(a, c, sa, sc);
  };
  for (const rows of ins.values()) for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) push(rows[i]!, rows[j]!);
  let left = subTours;
  while (left > 1 && heap.size > 0) {
    heap.popMin();
    const q = heap.topVal * 4;
    const a = cand[q]!;
    const c = cand[q + 1]!;
    if (find(tour[a]!) === find(tour[c]!) || succ[a] !== cand[q + 2] || succ[c] !== cand[q + 3]) continue; // stale
    const sa = succ[a]!;
    succ[a] = succ[c]!;
    succ[c] = sa;
    parent[find(tour[a]!)] = find(tour[c]!);
    left--;
    // The two arrivals now leave differently: refresh their candidates at this intersection.
    const at = a === S ? depotId : steps[a]!.to;
    for (const x of ins.get(at)!) {
      if (x !== a) push(a, x);
      if (x !== c && x !== a) push(c, x);
    }
  }
  if (left > 1) return keep(lowerBound, subTours);

  // 3. Read the merged tour from the depot; keep it only if it is no worse.
  const order: RouteStep[] = [];
  for (let x = succ[S]!; x !== S && order.length <= n; x = succ[x]!) order.push(steps[x]!);
  if (order.length !== n) return keep(lowerBound, subTours);
  const after = model.tally(order);
  const pen = (t: TurnTally): number => t.banned * BANNED + t.seconds;
  if (pen(after) > pen(before) + 1e-9) return keep(lowerBound, subTours);
  return {
    steps: renumber(order),
    before,
    after,
    lowerBound,
    optimal: after.seconds <= lowerBound.seconds + 1e-9 && after.banned <= lowerBound.banned,
    reordered: true,
    subTours,
    ms: now() - t0,
  };
}

/** Sum of several tallies. */
export function addTallies(ts: readonly TurnTally[]): TurnTally {
  const t: TurnTally = { straight: 0, left: 0, right: 0, uturn: 0, uturnsAwayFromDeadEnds: 0, banned: 0, seconds: 0 };
  for (const x of ts) for (const k of Object.keys(t) as (keyof TurnTally)[]) t[k] += x[k];
  return t;
}

/**
 * Turn rules of a zone graph built from a city: the profile's turn penalties and
 * its mapped turn restrictions ('no' forbids that turn; 'only' forbids every other
 * turn from that street at that node). Edge ids are `s<segment>`, vertex ids `n<osm>`.
 */
export function cityTurnOptions(city: CityModel, profile: ProfileId = 'truck'): TurnOptions {
  const spec = PROFILE_SPECS[profile];
  const penalties = spec.turns ?? { straight: 0, left: 0, right: 0, uturn: 0 };
  const no = new Set<string>();
  const only = new Map<string, Set<number>>();
  for (const r of city.restrictions ?? []) {
    if (!restrictionApplies(r.except, spec)) continue;
    const via = `n${city.nodeOsm[r.via]}`;
    if (r.kind === 'no') no.add(`${r.fromSeg}|${via}|${r.toSeg}`);
    else {
      const key = `${r.fromSeg}|${via}`;
      (only.get(key) ?? only.set(key, new Set()).get(key)!).add(r.toSeg);
    }
  }
  if (no.size === 0 && only.size === 0) return { penalties, banned: null };
  const seg = (id: string): number => (id.startsWith('s') ? Number(id.slice(1)) : -1);
  return {
    penalties,
    banned: (fromEdgeId, via, toEdgeId) => {
      const f = seg(fromEdgeId);
      const t = seg(toEdgeId);
      if (f < 0 || t < 0) return false;
      if (no.has(`${f}|${via}|${t}`)) return true;
      const allowed = only.get(`${f}|${via}`);
      return !!allowed && !allowed.has(t);
    },
  };
}
