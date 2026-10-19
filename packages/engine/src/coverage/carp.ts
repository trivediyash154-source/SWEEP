import type { CheckResult, Graph, RouteStep } from '../types.js';
import { fromScaled, toScaled } from '../units.js';
import { arcDijkstra, buildArcGraph, treePath, type ArcGraph } from './arcs.js';
import { solveZoneCoverage, type CoverageResult } from './solveCoverage.js';

/**
 * Multi-vehicle street coverage: the capacitated arc routing problem (CARP)
 * with a depot, optional disposal site, vehicle capacity and shift limit.
 *
 * Model
 *  - Tasks: the service obligations of the zone. Undirected mode: one task per
 *    required street, serviceable in either direction. Directed mode: one task
 *    per required direction (both directions of a two-way street, one for a
 *    one-way street), direction fixed.
 *  - Every vehicle leaves the depot and returns to it (returnToDepot is always
 *    true in this version).
 *  - Load: each task carries demand = length (km) × demandPerKm. A vehicle's
 *    load between unloadings may not exceed `capacity`. With a disposal site,
 *    a vehicle may unload there mid-route (true shortest-path detour) and, when
 *    it carries any load, unloads there before returning to the depot. Without
 *    one, capacity limits the whole route.
 *  - Time: service at serviceSpeedKmh, every other movement at
 *    deadheadSpeedKmh, plus dumpSeconds per unloading. A route may not exceed
 *    shiftSeconds.
 *  - Objective: 'min-total' (total fleet distance) or 'min-makespan' (time of
 *    the longest route; ties broken by total distance).
 *
 * Method (route-first, cluster-second; Beasley 1983, Ulusoy 1985, with
 * intermediate facilities as in Ghiani et al.):
 *  1. Giant tour: the order in which the single-vehicle coverage route of the
 *     zone first services each task (exact where solveZoneCoverage is exact).
 *  2. Optimal split of the giant tour into at most `vehicles` routes by dynamic
 *     programming, respecting capacity and shift (with a disposal site: first
 *     into capacity-feasible trips, then trips into vehicle shifts). The split
 *     is optimal FOR THE GIVEN TASK ORDER, not over all orders.
 *  3. Each route's unloading stops are re-placed optimally (DP over the route).
 *  4. Local search (granular neighbourhood: each task's 10 nearest tasks):
 *     relocate a task into another route, or swap two tasks between routes,
 *     with the best service direction; only improving feasible moves are
 *     applied; a fixed evaluation budget keeps the result deterministic.
 *  No optimality is claimed. Valid lower bounds (see `lowerBounds`) and the
 *  resulting gaps are reported.
 */

export interface FleetPlanOptions {
  vehicles: number;
  depotId: string;
  dumpId?: string | null;
  direction: 'undirected' | 'directed';
  objective: 'min-total' | 'min-makespan';
  /** Load per trip in demand units; null or undefined = unlimited. */
  capacity?: number | null;
  /** Demand units per kilometre of serviced street (default 0). */
  demandPerKm?: number;
  /** Per-vehicle shift limit in seconds; null or undefined = unlimited. */
  shiftSeconds?: number | null;
  serviceSpeedKmh: number;
  deadheadSpeedKmh: number;
  /** Seconds per unloading at the disposal site (default 0). */
  dumpSeconds?: number;
  /** A coverage result for the same graph, depot and direction (reused as the giant tour). */
  coverage?: CoverageResult;
  /** Local-search evaluation budget (default 200 000). */
  maxEvaluations?: number;
  /** Refuse instances whose distance table would exceed this many endpoints (default 4 000). */
  maxEndpoints?: number;
}

export interface FleetRoute {
  vehicle: number;
  steps: RouteStep[];
  /** Service order: street id and direction. */
  tasks: { edgeId: string; from: string; to: string }[];
  /** Unloadings at the disposal site: index of the step after which the vehicle unloads (−1 = at the start, never used). */
  dumpAfterStep: number[];
  distance: number;
  serviceDistance: number;
  deadheadDistance: number;
  seconds: number;
  /** Load of each trip (between unloadings). */
  tripLoads: number[];
  intermediateDumps: number;
  feasible: { capacity: boolean; shift: boolean };
}

export interface FleetLowerBounds {
  totalDistance: { value: number; basis: string };
  vehiclesByCapacity: number | null;
  vehiclesByShift: number | null;
  tripsByCapacity: number | null;
  makespanSeconds: { value: number; basis: string };
  minimumTotalSeconds: number;
}

export interface FleetPlan {
  ok: true;
  method: 'route-first-cluster-second';
  objective: FleetPlanOptions['objective'];
  direction: FleetPlanOptions['direction'];
  guarantee: string;
  vehiclesAvailable: number;
  routes: FleetRoute[];
  totals: { distance: number; serviceDistance: number; deadheadDistance: number; makespanSeconds: number; totalSeconds: number; vehiclesUsed: number; intermediateDumps: number; demand: number };
  lowerBounds: FleetLowerBounds;
  gaps: { totalDistance: number | null; makespan: number | null };
  feasibility: { ok: boolean; issues: string[] };
  localSearch: { evaluations: number; applied: number; before: { distance: number; makespanSeconds: number }; after: { distance: number; makespanSeconds: number } };
  validation: { ok: boolean; checks: CheckResult[]; perVehicle: CheckResult[][] };
  coverage: CoverageResult;
  timingsMs: { coverage: number; table: number; split: number; localSearch: number; expand: number; verify: number; total: number };
}

export interface FleetFailure {
  ok: false;
  message: string;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface Task {
  edge: number;
  /** Arc in the giant-tour direction, and the opposite arc (−1 when the direction is fixed). */
  arc: [number, number];
  /** Scaled length per orientation. */
  cost: [number, number];
  demand: number;
}

interface Ctx {
  ag: ArcGraph;
  tasks: Task[];
  /** Endpoint table index of task t's start / end in orientation o. */
  s: Int32Array[];
  e: Int32Array[];
  D: Float64Array;
  P: number;
  /** Graph vertex of each endpoint-table index. */
  pVert: number[];
  depot: number;
  dump: number;
  hasDump: boolean;
  Q: number;
  shift: number;
  vs: number;
  vd: number;
  dumpSec: number;
  objective: FleetPlanOptions['objective'];
}

interface Item {
  t: number;
  o: number;
}

interface RouteEval {
  dist: number;
  service: number;
  deadhead: number;
  time: number;
  loads: number[];
  /** Positions after which the vehicle unloads (mid-route); the final unloading is implicit when load > 0. */
  breaks: number[];
  feasCap: boolean;
  feasShift: boolean;
}

const d = (c: Ctx, a: number, b: number): number => c.D[a * c.P + b]!;
const secs = (c: Ctx, serviceScaled: number, deadheadScaled: number, unloads: number): number => fromScaled(serviceScaled) / c.vs + fromScaled(deadheadScaled) / c.vd + unloads * c.dumpSec;

/** Evaluate one vehicle route (task sequence), placing unloading stops optimally when there is a disposal site. */
function evalRoute(c: Ctx, seq: readonly Item[]): RouteEval {
  if (seq.length === 0) return { dist: 0, service: 0, deadhead: 0, time: 0, loads: [], breaks: [], feasCap: true, feasShift: true };
  let service = 0;
  let load = 0;
  for (const it of seq) {
    service += c.tasks[it.t]!.cost[it.o]!;
    load += c.tasks[it.t]!.demand;
  }
  const n = seq.length;
  const S = (i: number): number => c.s[seq[i]!.o]![seq[i]!.t]!;
  const E = (i: number): number => c.e[seq[i]!.o]![seq[i]!.t]!;
  if (!c.hasDump || load <= 0) {
    let dh = d(c, c.depot, S(0)) + d(c, E(n - 1), c.depot);
    for (let i = 0; i + 1 < n; i++) dh += d(c, E(i), S(i + 1));
    const time = secs(c, service, dh, 0);
    return { dist: service + dh, service, deadhead: dh, time, loads: [load], breaks: [], feasCap: load <= c.Q + 1e-9, feasShift: time <= c.shift + 1e-9 };
  }
  // DP over unloading positions: best[j] = cheapest way to have serviced 0..j−1 and unloaded at the dump.
  const unitCost = (dh: number, unloads: number): number => (c.objective === 'min-makespan' ? fromScaled(dh) / c.vd + unloads * c.dumpSec : dh + unloads * 1e-3);
  const best = new Float64Array(n + 1).fill(Infinity);
  const bestDh = new Float64Array(n + 1);
  const bestUnloads = new Int32Array(n + 1);
  const from = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  let feasCap = true;
  for (let a = 0; a < n; a++) {
    if (!Number.isFinite(best[a]!)) continue;
    const start = a === 0 ? c.depot : c.dump;
    let tl = 0;
    let inner = 0;
    for (let b = a; b < n; b++) {
      tl += c.tasks[seq[b]!.t]!.demand;
      if (b > a) inner += d(c, E(b - 1), S(b));
      if (tl > c.Q + 1e-9) {
        if (b === a) feasCap = false; // one task alone exceeds the capacity
        if (b > a) break;
      }
      const dh = bestDh[a]! + d(c, start, S(a)) + inner + d(c, E(b), c.dump);
      const un = bestUnloads[a]! + 1;
      const cost = unitCost(dh, un);
      if (cost < best[b + 1]! - 1e-12) {
        best[b + 1] = cost;
        bestDh[b + 1] = dh;
        bestUnloads[b + 1] = un;
        from[b + 1] = a;
      }
      if (tl > c.Q + 1e-9) break;
    }
  }
  const dh = bestDh[n]! + d(c, c.dump, c.depot);
  const breaks: number[] = [];
  const loads: number[] = [];
  for (let j = n; j > 0; j = from[j]!) {
    const a = from[j]!;
    if (a < 0) break;
    let tl = 0;
    for (let i = a; i < j; i++) tl += c.tasks[seq[i]!.t]!.demand;
    loads.unshift(tl);
    if (a > 0) breaks.unshift(a - 1);
  }
  const unloads = bestUnloads[n]!;
  const time = secs(c, service, dh, unloads);
  return { dist: service + dh, service, deadhead: dh, time, loads, breaks, feasCap: feasCap && loads.every((l) => l <= c.Q + 1e-9), feasShift: time <= c.shift + 1e-9 };
}

/** Upper bound on evalRoute's cost with a disposal site: unload greedily when the next task would not fit. O(length). */
function evalRouteGreedy(c: Ctx, seq: readonly Item[]): RouteEval {
  if (!c.hasDump) return evalRoute(c, seq);
  const n = seq.length;
  if (n === 0) return evalRoute(c, seq);
  let service = 0;
  let dh = 0;
  let load = 0;
  let total = 0;
  let unloads = 0;
  const loads: number[] = [];
  const breaks: number[] = [];
  let feasCap = true;
  let at = c.depot;
  for (let i = 0; i < n; i++) {
    const t = c.tasks[seq[i]!.t]!;
    if (t.demand > c.Q + 1e-9) feasCap = false;
    if (load > 0 && load + t.demand > c.Q + 1e-9) {
      dh += d(c, at, c.dump);
      unloads++;
      loads.push(load);
      breaks.push(i - 1);
      load = 0;
      at = c.dump;
    }
    dh += d(c, at, c.s[seq[i]!.o]![seq[i]!.t]!);
    service += t.cost[seq[i]!.o]!;
    load += t.demand;
    total += t.demand;
    at = c.e[seq[i]!.o]![seq[i]!.t]!;
  }
  if (total > 0) {
    dh += d(c, at, c.dump) + d(c, c.dump, c.depot);
    unloads++;
    loads.push(load);
  } else dh += d(c, at, c.depot);
  const time = secs(c, service, dh, unloads);
  return { dist: service + dh, service, deadhead: dh, time, loads, breaks, feasCap, feasShift: time <= c.shift + 1e-9 };
}

/** Optimal split of the giant tour into at most `kMax` routes (no disposal site). */
function splitNoDump(c: Ctx, tour: Item[], kMax: number): { routes: Item[][] } | null {
  const n = tour.length;
  const S = (i: number): number => c.s[tour[i]!.o]![tour[i]!.t]!;
  const E = (i: number): number => c.e[tour[i]!.o]![tour[i]!.t]!;
  const INF = Infinity;
  // f[v][j]: objective key for covering tasks 0..j−1 with exactly v routes.
  const keyA = Array.from({ length: kMax + 1 }, () => new Float64Array(n + 1).fill(INF)); // makespan or total
  const keyB = Array.from({ length: kMax + 1 }, () => new Float64Array(n + 1).fill(INF)); // total (tie-break for makespan)
  const prev = Array.from({ length: kMax + 1 }, () => new Int32Array(n + 1).fill(-1));
  keyA[0]![0] = 0;
  keyB[0]![0] = 0;
  for (let v = 1; v <= kMax; v++) {
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(keyA[v - 1]![i]!)) continue;
      let svc = 0;
      let inner = 0;
      let load = 0;
      for (let j = i; j < n; j++) {
        const t = c.tasks[tour[j]!.t]!;
        svc += t.cost[tour[j]!.o]!;
        load += t.demand;
        if (j > i) inner += d(c, E(j - 1), S(j));
        if (load > c.Q + 1e-9) break;
        const dh = d(c, c.depot, S(i)) + inner + d(c, E(j), c.depot);
        const time = secs(c, svc, dh, 0);
        if (time > c.shift + 1e-9) {
          // Shift exceeded; extending further only adds time.
          break;
        }
        const dist = svc + dh;
        const a = c.objective === 'min-makespan' ? Math.max(keyA[v - 1]![i]!, time) : keyA[v - 1]![i]! + dist;
        const b = keyB[v - 1]![i]! + dist;
        if (a < keyA[v]![j + 1]! - 1e-9 || (Math.abs(a - keyA[v]![j + 1]!) <= 1e-9 && b < keyB[v]![j + 1]! - 1e-9)) {
          keyA[v]![j + 1] = a;
          keyB[v]![j + 1] = b;
          prev[v]![j + 1] = i;
        }
      }
    }
  }
  let bestV = -1;
  for (let v = 1; v <= kMax; v++) {
    if (!Number.isFinite(keyA[v]![n]!)) continue;
    if (bestV < 0 || keyA[v]![n]! < keyA[bestV]![n]! - 1e-9 || (Math.abs(keyA[v]![n]! - keyA[bestV]![n]!) <= 1e-9 && keyB[v]![n]! < keyB[bestV]![n]! - 1e-9)) bestV = v;
  }
  if (bestV < 0) return null;
  const routes: Item[][] = [];
  for (let v = bestV, j = n; v > 0; v--) {
    const i = prev[v]![j]!;
    routes.unshift(tour.slice(i, j));
    j = i;
  }
  return { routes };
}

/** Split with a disposal site: capacity-feasible trips first, then trips grouped into at most kMax shifts. */
function splitWithDump(c: Ctx, tour: Item[], kMax: number): { routes: Item[][] } | null {
  const n = tour.length;
  const S = (i: number): number => c.s[tour[i]!.o]![tour[i]!.t]!;
  const E = (i: number): number => c.e[tour[i]!.o]![tour[i]!.t]!;
  // Stage 1: trips, each starting and ending at the dump.
  const best = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let a = 0; a < n; a++) {
    if (!Number.isFinite(best[a]!)) continue;
    let tl = 0;
    let inner = 0;
    for (let b = a; b < n; b++) {
      tl += c.tasks[tour[b]!.t]!.demand;
      if (b > a) inner += d(c, E(b - 1), S(b));
      if (tl > c.Q + 1e-9 && b > a) break;
      const cost = best[a]! + d(c, c.dump, S(a)) + inner + d(c, E(b), c.dump);
      if (cost < best[b + 1]!) {
        best[b + 1] = cost;
        from[b + 1] = a;
      }
      if (tl > c.Q + 1e-9) break;
    }
  }
  if (!Number.isFinite(best[n]!)) return null;
  const trips: [number, number][] = [];
  for (let j = n; j > 0; j = from[j]!) trips.unshift([from[j]!, j]);
  // Trip internals.
  const T = trips.length;
  const svc = trips.map(([a, b]) => {
    let s = 0;
    for (let i = a; i < b; i++) s += c.tasks[tour[i]!.t]!.cost[tour[i]!.o]!;
    return s;
  });
  const innerDh = trips.map(([a, b]) => {
    let s = 0;
    for (let i = a; i + 1 < b; i++) s += d(c, E(i), S(i + 1));
    return s + d(c, E(b - 1), c.dump);
  });
  // Stage 2: group consecutive trips into vehicle routes.
  const keyA = Array.from({ length: kMax + 1 }, () => new Float64Array(T + 1).fill(Infinity));
  const keyB = Array.from({ length: kMax + 1 }, () => new Float64Array(T + 1).fill(Infinity));
  const prev = Array.from({ length: kMax + 1 }, () => new Int32Array(T + 1).fill(-1));
  keyA[0]![0] = 0;
  keyB[0]![0] = 0;
  for (let v = 1; v <= kMax; v++) {
    for (let i = 0; i < T; i++) {
      if (!Number.isFinite(keyA[v - 1]![i]!)) continue;
      let s = 0;
      let dh = d(c, c.depot, S(trips[i]![0]));
      for (let j = i; j < T; j++) {
        s += svc[j]!;
        dh += innerDh[j]! + (j > i ? d(c, c.dump, S(trips[j]![0])) : 0);
        const totalDh = dh + d(c, c.dump, c.depot);
        const time = secs(c, s, totalDh, j - i + 1);
        if (time > c.shift + 1e-9) break;
        const dist = s + totalDh;
        const a = c.objective === 'min-makespan' ? Math.max(keyA[v - 1]![i]!, time) : keyA[v - 1]![i]! + dist;
        const b = keyB[v - 1]![i]! + dist;
        if (a < keyA[v]![j + 1]! - 1e-9 || (Math.abs(a - keyA[v]![j + 1]!) <= 1e-9 && b < keyB[v]![j + 1]! - 1e-9)) {
          keyA[v]![j + 1] = a;
          keyB[v]![j + 1] = b;
          prev[v]![j + 1] = i;
        }
      }
    }
  }
  let bestV = -1;
  for (let v = 1; v <= kMax; v++) {
    if (!Number.isFinite(keyA[v]![T]!)) continue;
    if (bestV < 0 || keyA[v]![T]! < keyA[bestV]![T]! - 1e-9 || (Math.abs(keyA[v]![T]! - keyA[bestV]![T]!) <= 1e-9 && keyB[v]![T]! < keyB[bestV]![T]! - 1e-9)) bestV = v;
  }
  if (bestV < 0) return null;
  const routes: Item[][] = [];
  for (let v = bestV, j = T; v > 0; v--) {
    const i = prev[v]![j]!;
    routes.unshift(tour.slice(trips[i]![0], trips[j - 1]![1]));
    j = i;
  }
  return { routes };
}

interface PlanKey {
  a: number;
  b: number;
}
function planKey(c: Ctx, evals: RouteEval[]): PlanKey {
  let total = 0;
  let mk = 0;
  for (const e of evals) {
    total += e.dist;
    if (e.time > mk) mk = e.time;
  }
  return c.objective === 'min-makespan' ? { a: mk, b: total } : { a: total, b: mk };
}
const better = (x: PlanKey, y: PlanKey): boolean => x.a < y.a - 1e-6 || (Math.abs(x.a - y.a) <= 1e-6 && x.b < y.b - 1e-6);

/** Granular local search: relocate and swap between routes, best service direction, improving feasible moves only. */
function localSearch(c: Ctx, routes: Item[][], budget: number): { routes: Item[][]; evaluations: number; applied: number } {
  const nT = c.tasks.length;
  // Neighbour lists by proximity (min over orientations of end→start distance, both ways).
  const near: Int32Array[] = [];
  const K = Math.min(10, nT - 1);
  for (let t = 0; t < nT; t++) {
    const cand: [number, number][] = [];
    for (let u = 0; u < nT; u++) {
      if (u === t) continue;
      let best = Infinity;
      for (let o = 0; o < 2; o++) {
        if (o === 1 && c.tasks[t]!.arc[1] < 0) continue;
        for (let p = 0; p < 2; p++) {
          if (p === 1 && c.tasks[u]!.arc[1] < 0) continue;
          best = Math.min(best, d(c, c.e[o]![t]!, c.s[p]![u]!), d(c, c.e[p]![u]!, c.s[o]![t]!));
        }
      }
      cand.push([best, u]);
    }
    cand.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    near.push(Int32Array.from(cand.slice(0, K).map((x) => x[1])));
  }
  const where = new Int32Array(nT);
  const pos = new Int32Array(nT);
  const reindex = (): void => {
    routes.forEach((r, ri) =>
      r.forEach((it, i) => {
        where[it.t] = ri;
        pos[it.t] = i;
      }),
    );
  };
  reindex();
  let evals = routes.map((r) => evalRoute(c, r));
  let evaluations = 0;
  let applied = 0;
  const orients = (t: number): number[] => (c.tasks[t]!.arc[1] < 0 ? [0] : [0, 1]);
  const feasible = (e: RouteEval): boolean => e.feasCap && e.feasShift;
  let improved = true;
  while (improved && evaluations < budget) {
    improved = false;
    for (let t = 0; t < nT && evaluations < budget; t++) {
      const A = where[t]!;
      for (const u of near[t]!) {
        if (evaluations >= budget) break;
        const B = where[u]!;
        if (A === B) continue;
        const ra = routes[A]!;
        const rb = routes[B]!;
        const pa = pos[t]!;
        const pb = pos[u]!;
        const baseKey = planKey(c, evals);
        let bestMove: { na: Item[]; nb: Item[]; ea: RouteEval; eb: RouteEval } | null = null;
        let bestKey = baseKey;
        const keyWith = (ea: RouteEval, eb: RouteEval): PlanKey => {
          const trial = evals.slice();
          trial[A] = ea;
          trial[B] = eb;
          return planKey(c, trial);
        };
        const tryMove = (na: Item[], nb: Item[]): void => {
          evaluations++;
          if (c.hasDump) {
            // Screen with the greedy upper bound; only confirmed improvements are evaluated exactly.
            const ga = evalRouteGreedy(c, na);
            const gb = evalRouteGreedy(c, nb);
            if (!feasible(ga) || !feasible(gb) || !better(keyWith(ga, gb), bestKey)) return;
          }
          const ea = evalRoute(c, na);
          const eb = evalRoute(c, nb);
          if (!feasible(ea) || !feasible(eb)) return;
          const k = keyWith(ea, eb);
          if (better(k, bestKey)) {
            bestKey = k;
            bestMove = { na, nb, ea, eb };
          }
        };
        const without = ra.slice(0, pa).concat(ra.slice(pa + 1));
        for (const o of orients(t)) {
          // Relocate t before or after u.
          tryMove(without, rb.slice(0, pb).concat([{ t, o }], rb.slice(pb)));
          tryMove(without, rb.slice(0, pb + 1).concat([{ t, o }], rb.slice(pb + 1)));
          // Swap t and u.
          for (const p of orients(u)) {
            const na = ra.slice();
            na[pa] = { t: u, o: p };
            const nb = rb.slice();
            nb[pb] = { t, o };
            tryMove(na, nb);
          }
        }
        if (bestMove) {
          const m = bestMove as { na: Item[]; nb: Item[]; ea: RouteEval; eb: RouteEval };
          routes[A] = m.na;
          routes[B] = m.nb;
          evals = evals.slice();
          evals[A] = m.ea;
          evals[B] = m.eb;
          reindex();
          applied++;
          improved = true;
          break;
        }
      }
    }
  }
  return { routes, evaluations, applied };
}

export function planFleet(graph: Graph, opts: FleetPlanOptions): FleetPlan | FleetFailure {
  const t0 = now();
  const k = Math.floor(opts.vehicles);
  if (!(k >= 1 && k <= 50)) return { ok: false, message: 'The fleet size must be between 1 and 50 vehicles.' };
  if (!(opts.serviceSpeedKmh > 0) || !(opts.deadheadSpeedKmh > 0)) return { ok: false, message: 'Service and deadhead speeds must be positive.' };
  if (opts.capacity != null && !(opts.capacity > 0)) return { ok: false, message: 'Capacity must be positive (or unset for unlimited).' };
  if (opts.shiftSeconds != null && !(opts.shiftSeconds > 0)) return { ok: false, message: 'The shift limit must be positive (or unset for unlimited).' };
  const directed = opts.direction === 'directed';
  const coverage = opts.coverage ?? solveZoneCoverage(graph, { direction: opts.direction, depotId: opts.depotId });
  if (!coverage.ok) return { ok: false, message: `Coverage could not be computed: ${coverage.message}` };
  const work = coverage.graph; // serviceable obligations only
  const t1 = now();

  // Tasks in giant-tour order (first service traversal of each obligation).
  const ag = buildArcGraph(work, directed);
  const arcOf = (edge: number, from: string, to: string): number => {
    const f = ag.fwdArc[edge]!;
    if (ag.vertexIds[ag.arcTail[f]!] === from && ag.vertexIds[ag.arcHead[f]!] === to) return f;
    const b = ag.backArc[edge]!;
    if (b >= 0 && ag.vertexIds[ag.arcTail[b]!] === from && ag.vertexIds[ag.arcHead[b]!] === to) return b;
    return f; // a loop
  };
  const demandPerKm = opts.demandPerKm ?? 0;
  const tasks: Task[] = [];
  const tour: Item[] = [];
  for (const st of coverage.route.steps) {
    if (st.kind !== 'service') continue;
    const edge = ag.edgeIndex.get(st.edgeId)!;
    const a = arcOf(edge, st.from, st.to);
    const other = directed ? -1 : a === ag.fwdArc[edge] ? ag.backArc[edge]! : ag.fwdArc[edge]!;
    const len = work.edges[edge]!.weight;
    tasks.push({ edge, arc: [a, other], cost: [ag.arcCost[a]!, other >= 0 ? ag.arcCost[other]! : Infinity], demand: (len / 1000) * demandPerKm });
    tour.push({ t: tasks.length - 1, o: 0 });
  }
  // Endpoint table.
  const depot = ag.vertexIndex.get(opts.depotId);
  if (depot === undefined) return { ok: false, message: `Depot ${opts.depotId} is not in the network.` };
  const dumpV = opts.dumpId != null ? ag.vertexIndex.get(opts.dumpId) : undefined;
  if (opts.dumpId != null && dumpV === undefined) return { ok: false, message: `Disposal site ${opts.dumpId} is not in the network.` };
  const pIndex = new Map<number, number>();
  const pVert: number[] = [];
  const pid = (v: number): number => {
    let i = pIndex.get(v);
    if (i === undefined) {
      i = pVert.length;
      pIndex.set(v, i);
      pVert.push(v);
    }
    return i;
  };
  const dp = pid(depot);
  const up = dumpV !== undefined ? pid(dumpV) : -1;
  const s: Int32Array[] = [new Int32Array(tasks.length), new Int32Array(tasks.length)];
  const e: Int32Array[] = [new Int32Array(tasks.length), new Int32Array(tasks.length)];
  tasks.forEach((t, i) => {
    for (let o = 0; o < 2; o++) {
      const a = t.arc[o]!;
      if (a < 0) {
        s[o]![i] = s[0]![i]!;
        e[o]![i] = e[0]![i]!;
        continue;
      }
      s[o]![i] = pid(ag.arcTail[a]!);
      e[o]![i] = pid(ag.arcHead[a]!);
    }
  });
  const P = pVert.length;
  if (P > (opts.maxEndpoints ?? 4000)) return { ok: false, message: `The zone has ${P} distinct task endpoints; fleet planning is limited to ${opts.maxEndpoints ?? 4000}. Choose a smaller zone.` };
  const D = new Float64Array(P * P);
  for (let i = 0; i < P; i++) {
    const tree = arcDijkstra(ag, [pVert[i]!]);
    for (let j = 0; j < P; j++) D[i * P + j] = tree.dist[pVert[j]!]!;
  }
  for (const x of D) if (!Number.isFinite(x)) return { ok: false, message: 'Some task endpoints cannot reach each other under the travel rules.' };
  const t2 = now();
  const c: Ctx = {
    ag,
    tasks,
    s,
    e,
    D,
    P,
    pVert,
    depot: dp,
    dump: up,
    hasDump: up >= 0,
    Q: opts.capacity ?? Infinity,
    shift: opts.shiftSeconds ?? Infinity,
    vs: opts.serviceSpeedKmh / 3.6,
    vd: opts.deadheadSpeedKmh / 3.6,
    dumpSec: opts.dumpSeconds ?? 0,
    objective: opts.objective,
  };
  const totalDemand = tasks.reduce((x, t) => x + t.demand, 0);
  const issues: string[] = [];

  // Split (allowing more vehicles than available only to diagnose infeasibility).
  const unconstrained = opts.objective === 'min-total' && !Number.isFinite(c.Q) && !Number.isFinite(c.shift);
  const split = (kk: number): { routes: Item[][] } | null =>
    // Without capacity or shift limits, one route is optimal for the min-total objective: splitting adds
    // depot visits, which by the triangle inequality never shorten the walk.
    unconstrained ? { routes: [tour.slice()] } : c.hasDump && totalDemand > 0 ? splitWithDump(c, tour, kk) : splitNoDump(c, tour, kk);
  let sp = split(k);
  let vehiclesOk = true;
  if (!sp) {
    vehiclesOk = false;
    for (const kk of [2 * k, 4 * k, 50]) {
      sp = split(Math.min(50, kk));
      if (sp) break;
    }
    if (sp) issues.push(`No plan with ${k} vehicle(s) satisfies the ${opts.capacity != null && !c.hasDump ? 'capacity and ' : ''}shift limits for this task order; the plan below uses ${sp.routes.length} vehicles.`);
  }
  if (!sp) {
    // Individual tasks that violate the limits on their own.
    sp = { routes: tour.map((it) => [it]) };
    issues.push('Even one route per task violates the limits: some single streets exceed the capacity or cannot be serviced within the shift.');
    vehiclesOk = false;
  }
  let routes = sp.routes;
  const before = planKey(c, routes.map((r) => evalRoute(c, r)));
  const beforeTotals = { distance: 0, makespanSeconds: 0 };
  routes.map((r) => evalRoute(c, r)).forEach((x) => {
    beforeTotals.distance += x.dist;
    beforeTotals.makespanSeconds = Math.max(beforeTotals.makespanSeconds, x.time);
  });
  const t3 = now();
  const ls = localSearch(c, routes.map((r) => r.slice()), opts.maxEvaluations ?? 200_000);
  const after = planKey(c, ls.routes.map((r) => evalRoute(c, r)));
  if (!better(before, after)) routes = ls.routes; // never worse (ties keep the search result, which is equal)
  routes = routes.filter((r) => r.length > 0);
  const t4 = now();

  // Expand routes into street-level steps.
  const fleet: FleetRoute[] = routes.map((seq, vi) => expandRoute(c, work, seq, vi + 1));
  const t5 = now();
  const v = verifyFleetPlan(work, fleet, { depotId: opts.depotId, dumpId: opts.dumpId ?? null, directed, capacity: c.Q, shiftSeconds: c.shift, serviceSpeedKmh: opts.serviceSpeedKmh, deadheadSpeedKmh: opts.deadheadSpeedKmh, dumpSeconds: c.dumpSec, demandPerKm });
  const t6 = now();

  // Lower bounds (valid; see FleetLowerBounds docs in the module note).
  const serviceScaled = tasks.reduce((x, t) => x + t.cost[0]!, 0);
  const lbTotal = coverage.lowerBound ? toScaled(coverage.lowerBound.value) : serviceScaled;
  const tripsLb = c.hasDump && totalDemand > 0 && Number.isFinite(c.Q) ? Math.ceil(totalDemand / c.Q - 1e-9) : totalDemand > 0 && Number.isFinite(c.Q) ? Math.ceil(totalDemand / c.Q - 1e-9) : null;
  const minTotalSeconds = fromScaled(serviceScaled) / c.vs + Math.max(0, fromScaled(lbTotal - serviceScaled)) / c.vd + (c.hasDump && totalDemand > 0 ? (tripsLb ?? 1) * c.dumpSec : 0);
  let longestSingle = 0;
  tasks.forEach((t, i) => {
    let bestT = Infinity;
    for (let o = 0; o < 2; o++) {
      if (t.arc[o]! < 0) continue;
      const back = c.hasDump && t.demand > 0 ? d(c, e[o]![i]!, up) + d(c, up, dp) : d(c, e[o]![i]!, dp);
      bestT = Math.min(bestT, fromScaled(d(c, dp, s[o]![i]!) + back) / c.vd + fromScaled(t.cost[o]!) / c.vs + (c.hasDump && t.demand > 0 ? c.dumpSec : 0));
    }
    longestSingle = Math.max(longestSingle, bestT);
  });
  const lowerBounds: FleetLowerBounds = {
    totalDistance: {
      value: fromScaled(lbTotal),
      basis: coverage.optimal
        ? 'The single-vehicle coverage optimum (exact): all routes together form one closed walk from the depot covering every street.'
        : `A lower bound for single-vehicle coverage (${coverage.lowerBound?.method ?? 'required length'}); all routes together form one closed walk from the depot covering every street.`,
    },
    vehiclesByCapacity: !c.hasDump && tripsLb !== null ? tripsLb : null,
    vehiclesByShift: Number.isFinite(c.shift) ? Math.ceil(minTotalSeconds / c.shift - 1e-9) : null,
    tripsByCapacity: tripsLb,
    makespanSeconds: {
      value: Math.max(minTotalSeconds / k, longestSingle),
      basis: `For any plan with at most ${k} vehicle(s): max(minimum total working time ÷ ${k}, the longest single-street round trip from the depot).`,
    },
    minimumTotalSeconds: minTotalSeconds,
  };
  const totals = {
    distance: fleet.reduce((x, r) => x + r.distance, 0),
    serviceDistance: fleet.reduce((x, r) => x + r.serviceDistance, 0),
    deadheadDistance: fleet.reduce((x, r) => x + r.deadheadDistance, 0),
    makespanSeconds: fleet.reduce((x, r) => Math.max(x, r.seconds), 0),
    totalSeconds: fleet.reduce((x, r) => x + r.seconds, 0),
    vehiclesUsed: fleet.length,
    intermediateDumps: fleet.reduce((x, r) => x + r.intermediateDumps, 0),
    demand: totalDemand,
  };
  const capOk = fleet.every((r) => r.feasible.capacity);
  const shiftOk = fleet.every((r) => r.feasible.shift);
  if (!capOk) issues.push('At least one route exceeds the vehicle capacity.');
  if (!shiftOk) issues.push('At least one route exceeds the shift limit.');
  if (fleet.length > k) vehiclesOk = false;
  return {
    ok: true,
    method: 'route-first-cluster-second',
    objective: opts.objective,
    direction: opts.direction,
    guarantee: `Heuristic (not proven optimal): optimal split of the coverage tour into routes for the given task order, optimal placement of unloading stops, then improving local search. Gaps are measured against valid lower bounds.${coverage.optimal ? '' : ' The total-distance bound comes from single-vehicle coverage.'}`,
    vehiclesAvailable: k,
    routes: fleet,
    totals,
    lowerBounds,
    gaps: {
      totalDistance: lowerBounds.totalDistance.value > 0 ? (totals.distance - lowerBounds.totalDistance.value) / lowerBounds.totalDistance.value : null,
      // The makespan bound holds for plans with at most `vehicles` routes; an over-fleet (infeasible) plan gets no gap.
      makespan: lowerBounds.makespanSeconds.value > 0 && fleet.length <= k ? (totals.makespanSeconds - lowerBounds.makespanSeconds.value) / lowerBounds.makespanSeconds.value : null,
    },
    feasibility: { ok: capOk && shiftOk && vehiclesOk, issues },
    localSearch: {
      evaluations: ls.evaluations,
      applied: ls.applied,
      before: { distance: fromScaled(beforeTotals.distance), makespanSeconds: beforeTotals.makespanSeconds },
      after: { distance: totals.distance, makespanSeconds: totals.makespanSeconds },
    },
    validation: v,
    coverage,
    timingsMs: { coverage: t1 - t0, table: t2 - t1, split: t3 - t2, localSearch: t4 - t3, expand: t5 - t4, verify: t6 - t5, total: t6 - t0 },
  };
}

function expandRoute(c: Ctx, graph: Graph, seq: readonly Item[], vehicle: number): FleetRoute {
  const ev = evalRoute(c, seq);
  const ag = c.ag;
  const steps: RouteStep[] = [];
  const dumpAfterStep: number[] = [];
  let cum = 0;
  let service = 0;
  let deadhead = 0;
  const depotV = c.pVert[c.depot]!;
  const dumpV = c.hasDump ? c.pVert[c.dump]! : -1;
  let at = depotV;
  const push = (a: number, kind: RouteStep['kind']): void => {
    const e = graph.edges[ag.arcEdge[a]!]!;
    cum += ag.arcCost[a]!;
    if (kind === 'service') service += ag.arcCost[a]!;
    else deadhead += ag.arcCost[a]!;
    steps.push({ index: steps.length, edgeId: e.id, from: ag.vertexIds[ag.arcTail[a]!]!, to: ag.vertexIds[ag.arcHead[a]!]!, weight: fromScaled(ag.arcCost[a]!), kind, cumulative: fromScaled(cum) });
    at = ag.arcHead[a]!;
  };
  const travel = (to: number): void => {
    if (to === at) return;
    const tree = arcDijkstra(ag, [at], { stop: (v) => v === to });
    for (const a of treePath(ag, tree, to)) push(a, graph.edges[ag.arcEdge[a]!]!.required ? 'repeat' : 'deadhead');
  };
  const breaks = new Set(ev.breaks);
  const tasksOut: FleetRoute['tasks'] = [];
  seq.forEach((it, i) => {
    const a = c.tasks[it.t]!.arc[it.o]!;
    travel(ag.arcTail[a]!);
    push(a, 'service');
    tasksOut.push({ edgeId: graph.edges[ag.arcEdge[a]!]!.id, from: ag.vertexIds[ag.arcTail[a]!]!, to: ag.vertexIds[ag.arcHead[a]!]! });
    if (breaks.has(i)) {
      travel(dumpV);
      dumpAfterStep.push(steps.length - 1);
    }
  });
  const load = ev.loads.reduce((x, y) => x + y, 0);
  if (c.hasDump && load > 0) {
    travel(dumpV);
    dumpAfterStep.push(steps.length - 1);
  }
  travel(depotV);
  const unloads = c.hasDump && load > 0 ? ev.breaks.length + 1 : 0;
  const seconds = secs(c, service, deadhead, unloads);
  return {
    vehicle,
    steps,
    tasks: tasksOut,
    dumpAfterStep,
    distance: fromScaled(cum),
    serviceDistance: fromScaled(service),
    deadheadDistance: fromScaled(deadhead),
    seconds,
    tripLoads: ev.loads,
    intermediateDumps: ev.breaks.length,
    feasible: { capacity: ev.loads.every((l) => l <= c.Q + 1e-9), shift: seconds <= c.shift + 1e-9 },
  };
}

/**
 * Independent check of a fleet plan, re-derived from the raw graph and the
 * street-level steps: legal closed walks from the depot, consistent
 * distances, every obligation serviced exactly once, and the capacity and
 * shift limits recomputed from the steps.
 */
export function verifyFleetPlan(
  graph: Graph,
  routes: readonly FleetRoute[],
  opts: { depotId: string; dumpId: string | null; directed: boolean; capacity: number; shiftSeconds: number; serviceSpeedKmh: number; deadheadSpeedKmh: number; dumpSeconds: number; demandPerKm: number },
): { ok: boolean; checks: CheckResult[]; perVehicle: CheckResult[][] } {
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const obligation = (id: string, fwd: boolean): string => {
    const e = edges.get(id)!;
    return opts.directed && !e.oneway && e.u !== e.v ? `${id}:${fwd ? 'f' : 'b'}` : id;
  };
  const needed = new Set<string>();
  for (const e of graph.edges) {
    if (!e.required) continue;
    if (opts.directed && !e.oneway && e.u !== e.v) {
      needed.add(`${e.id}:f`);
      needed.add(`${e.id}:b`);
    } else needed.add(e.id);
  }
  const serviced = new Map<string, number>();
  const vs = opts.serviceSpeedKmh / 3.6;
  const vd = opts.deadheadSpeedKmh / 3.6;
  const perVehicle = routes.map((r) => {
    let legal = r.steps.length > 0 && r.steps[0]!.from === opts.depotId;
    let detail = legal ? '' : `Vehicle ${r.vehicle} does not start at the depot.`;
    let running = 0;
    let svc = 0;
    let dh = 0;
    let weightsOk = true;
    const dumps = new Set(r.dumpAfterStep);
    const loads: number[] = [];
    let load = 0;
    for (let i = 0; i < r.steps.length; i++) {
      const st = r.steps[i]!;
      const e = edges.get(st.edgeId);
      const fwd = !!e && st.from === e.u && st.to === e.v;
      const back = !!e && st.from === e.v && st.to === e.u;
      if (legal && (!e || (!fwd && !back) || (opts.directed && e.oneway && !fwd) || (i > 0 && r.steps[i - 1]!.to !== st.from))) {
        legal = false;
        detail = `Step ${i + 1} (${st.edgeId}: ${st.from}→${st.to}) is not a legal continuation.`;
      }
      if (!e) continue;
      const w = toScaled(opts.directed && !fwd && e.u !== e.v ? (e.reverseWeight ?? e.weight) : e.weight);
      running += w;
      if (toScaled(st.weight) !== w || toScaled(st.cumulative) !== running) weightsOk = false;
      if (st.kind === 'service') {
        if (!e.required) weightsOk = false;
        const key = obligation(e.id, fwd);
        serviced.set(key, (serviced.get(key) ?? 0) + 1);
        svc += w;
        load += (e.weight / 1000) * opts.demandPerKm;
      } else dh += w;
      if (dumps.has(i)) {
        if (opts.dumpId === null || st.to !== opts.dumpId) {
          legal = false;
          detail = `Unloading after step ${i + 1} is not at the disposal site.`;
        }
        loads.push(load);
        load = 0;
      }
    }
    if (load > 1e-9 || loads.length === 0) loads.push(load);
    if (toScaled(r.distance) !== running) weightsOk = false;
    const closed = r.steps.length > 0 && r.steps[r.steps.length - 1]!.to === opts.depotId;
    const unloads = r.dumpAfterStep.length;
    const seconds = fromScaled(svc) / vs + fromScaled(dh) / vd + unloads * opts.dumpSeconds;
    const capOk = loads.every((l) => l <= opts.capacity + 1e-6);
    const shiftOk = seconds <= opts.shiftSeconds + 1e-6;
    if (legal) detail = `${r.steps.length} legal steps from the depot.`;
    return [
      { id: 'continuity', label: 'Route is continuous and legal', passed: legal, detail },
      { id: 'closed', label: 'Route returns to the depot', passed: closed, detail: closed ? `Ends at ${opts.depotId}.` : 'Does not end at the depot.' },
      { id: 'weights', label: 'Distances are consistent', passed: weightsOk, detail: weightsOk ? `Length ${fromScaled(running)} m.` : 'A step or the route total is inconsistent.' },
      { id: 'capacity', label: 'Load stays within capacity', passed: capOk, detail: `Trip loads ${loads.map((l) => l.toFixed(1)).join(', ')} (capacity ${Number.isFinite(opts.capacity) ? opts.capacity : 'unlimited'}).` },
      { id: 'shift', label: 'Route fits the shift', passed: shiftOk, detail: `${(seconds / 3600).toFixed(2)} h (limit ${Number.isFinite(opts.shiftSeconds) ? (opts.shiftSeconds / 3600).toFixed(2) + ' h' : 'none'}).` },
      { id: 'time', label: 'Reported time matches the steps', passed: Math.abs(seconds - r.seconds) <= 1e-6 * Math.max(1, seconds), detail: `${seconds.toFixed(1)} s recomputed.` },
    ];
  });
  const missing = [...needed].filter((k) => !serviced.has(k));
  const twice = [...serviced.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  const extra = [...serviced.keys()].filter((k) => !needed.has(k));
  const checks: CheckResult[] = [
    { id: 'routes-valid', label: 'Every vehicle route is a legal closed walk from the depot', passed: perVehicle.every((p) => p.slice(0, 3).every((x) => x.passed)), detail: `${routes.length} route(s) checked step by step.` },
    { id: 'coverage', label: 'Every obligation is serviced exactly once', passed: missing.length === 0 && twice.length === 0 && extra.length === 0, detail: missing.length + twice.length + extra.length === 0 ? `${needed.size} of ${needed.size} obligations serviced exactly once.` : `Missing ${missing.length}, serviced twice ${twice.length}, unexpected ${extra.length}.` },
    { id: 'limits', label: 'Capacity and shift limits hold on every route', passed: perVehicle.every((p) => p[3]!.passed && p[4]!.passed), detail: 'Recomputed from the steps.' },
  ];
  return { ok: checks.every((x) => x.passed) && perVehicle.every((p) => p.every((x) => x.passed)), checks, perVehicle };
}
