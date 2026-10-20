import type {
  CheckResult,
  FleetObjective,
  FleetRecord,
  FleetResult,
  Graph,
  Issue,
  OptimizationFailure,
  RouteStep,
  RoutingMode,
  SingleRouteRecord,
  TraversalKind,
  TwoWayService,
  VehicleRoute,
} from './types.js';
import { ENGINE_VERSION } from './version.js';
import { toScaled, fromScaled } from './units.js';
import { isOneway, validateGraph } from './validate.js';
import { solveChinesePostman } from './solve.js';
import { solveDirectedPostman } from './directed.js';
import { verifyFleet } from './verify.js';

/**
 * Multi-vehicle routing from one shared depot.
 *
 * Problem (min–max k-Chinese/rural postman, single depot): find k closed
 * routes that start and end at the depot such that every service obligation
 * is fulfilled by at least one route. Objectives:
 *   - 'balance': minimise the LONGEST route (makespan); total distance is the tie-breaker.
 *   - 'total':   minimise the TOTAL distance, optionally subject to a per-route length limit.
 * Both are NP-hard for k ≥ 2. Method: route first, split second.
 *   1. Solve the single-vehicle problem exactly (certified tour of length L).
 *   2. Split that tour into ≤ k consecutive pieces; vehicle j drives a shortest
 *      path from the depot to the start of its piece, the piece, and a shortest
 *      path back. Pure deadhead runs at a cut may be dropped (they service nothing).
 *   3. The split is chosen by the Frederickson–Hecht–Kim threshold rule (which
 *      carries the guarantee below) and, for tours up to SPLIT_DP_MAX steps,
 *      improved by an exact dynamic programme over all splits of the tour.
 *
 * Guarantee (undirected, 'balance'): every route is at most (L − D)/k + D, where
 * D is the longest depot → street → depot round trip over required streets. Since
 * the optimum makespan is at least max(L/k, D), the longest route is within a factor
 * 2 − 1/k of optimal (Frederickson, Hecht & Kim 1978). Directed networks: the same
 * construction, but no ratio is proven (the bound uses symmetric distances), so
 * results are labelled heuristic with the lower bound for comparison.
 * 'total' without a limit: one route of length L is exactly optimal, because any
 * set of depot routes can be joined at the depot into one covering route; extra
 * vehicles cannot reduce total distance. With a limit: heuristic, no ratio.
 */

export const MAX_VEHICLES = 12;
export const SPLIT_DP_MAX = 2500;

export interface FleetOptions {
  vehicles: number;
  mode?: RoutingMode;
  twoWay?: TwoWayService;
  ignoreOneway?: boolean;
  objective?: FleetObjective;
  maxRouteLength?: number | null;
  depotId?: string | null;
  /** A previously computed single-vehicle record for the same graph and settings (saves re-solving). */
  base?: SingleRouteRecord;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

interface Arcs {
  n: number;
  index: Map<string, number>;
  ids: string[];
  tail: number[];
  head: number[];
  cost: number[];
  edgeId: string[];
}

/** Permitted arcs: both directions of a two-way street, one direction of a one-way street. */
function permittedArcs(graph: Graph, directed: boolean): Arcs {
  const index = new Map(graph.vertices.map((v, i) => [v.id, i]));
  const A: Arcs = { n: graph.vertices.length, index, ids: graph.vertices.map((v) => v.id), tail: [], head: [], cost: [], edgeId: [] };
  for (const e of graph.edges) {
    const u = index.get(e.u)!;
    const v = index.get(e.v)!;
    A.tail.push(u);
    A.head.push(v);
    A.cost.push(toScaled(e.weight));
    A.edgeId.push(e.id);
    if (u !== v && !(directed && isOneway(e))) {
      A.tail.push(v);
      A.head.push(u);
      A.cost.push(toScaled(directed ? (e.reverseWeight ?? e.weight) : e.weight));
      A.edgeId.push(e.id);
    }
  }
  return A;
}

/** Dijkstra from (reverse=false) or to (reverse=true) a vertex. */
function tree(A: Arcs, s: number, reverse: boolean): { dist: Float64Array; pred: Int32Array } {
  const adj: number[][] = Array.from({ length: A.n }, () => []);
  A.tail.forEach((t, a) => (reverse ? adj[A.head[a]!]! : adj[t]!).push(a));
  const next = reverse ? A.tail : A.head;
  const dist = new Float64Array(A.n).fill(Infinity);
  const pred = new Int32Array(A.n).fill(-1);
  const done = new Uint8Array(A.n);
  dist[s] = 0;
  const heap: [number, number][] = [[0, s]];
  const less = (x: [number, number], y: [number, number]) => x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  while (heap.length > 0) {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    const [d, v] = top;
    if (done[v]) continue;
    done[v] = 1;
    for (const a of adj[v]!) {
      const w = next[a]!;
      const nd = d + A.cost[a]!;
      if (nd < dist[w]!) {
        dist[w] = nd;
        pred[w] = a;
        heap.push([nd, w]);
        let i = heap.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (!less(heap[i]!, heap[p]!)) break;
          [heap[p], heap[i]] = [heap[i]!, heap[p]!];
          i = p;
        }
      }
    }
  }
  return { dist, pred };
}

function fail(graph: Graph, issues: Issue[], base?: OptimizationFailure): OptimizationFailure {
  const validation = base?.validation ?? validateGraph(graph, { onewayPolicy: 'directed' });
  return { ok: false, engine: { name: 'sweep-engine', version: ENGINE_VERSION }, validation: { ...validation, ok: false, issues: [...validation.issues, ...issues] } };
}

export function solveFleet(graph: Graph, options: FleetOptions): FleetResult {
  const t0 = now();
  const k = options.vehicles;
  const mode: RoutingMode = options.mode ?? 'undirected';
  const twoWay: TwoWayService = options.twoWay ?? 'both';
  const objective: FleetObjective = options.objective ?? 'balance';
  const limit = options.maxRouteLength ?? null;
  if (!Number.isInteger(k) || k < 1 || k > MAX_VEHICLES) {
    return fail(graph, [{ code: 'FLEET_INVALID', severity: 'error', message: `The number of vehicles must be a whole number from 1 to ${MAX_VEHICLES} (got ${JSON.stringify(k)}).` }]);
  }
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    return fail(graph, [{ code: 'FLEET_INVALID', severity: 'error', message: 'The route length limit must be a positive number.' }]);
  }

  // 1. Certified single-vehicle route.
  const base: SingleRouteRecord | OptimizationFailure =
    options.base ??
    (mode === 'directed'
      ? solveDirectedPostman(graph, { depotId: options.depotId ?? null, twoWay })
      : solveChinesePostman(graph, { depotId: options.depotId ?? null, ignoreOneway: options.ignoreOneway ?? false }));
  if (!base.ok) return base;
  const tBase = now();
  const directed = base.mode === 'directed';
  const A = permittedArcs(graph, directed);
  const s = A.index.get(base.input.depotId)!;
  const from = tree(A, s, false);
  const to = tree(A, s, true);

  // Tour as vertex sequence v_0..v_m with prefix lengths (scaled).
  const steps = base.route.steps;
  const m = steps.length;
  const vIdx = [s, ...steps.map((st) => A.index.get(st.to)!)];
  const pre = new Float64Array(m + 1);
  steps.forEach((st, i) => (pre[i + 1] = pre[i]! + toScaled(st.weight)));
  const L = pre[m]!;
  const droppable = new Uint8Array(m + 1); // droppable[i]: step i (1-based) is a deadhead on an optional street
  steps.forEach((st, i) => (droppable[i + 1] = st.kind === 'deadhead' ? 1 : 0));
  const dS = (i: number) => from.dist[vIdx[i]!]!;
  const dT = (i: number) => to.dist[vIdx[i]!]!;
  const seg = (a: number, b: number) => dS(a) + (pre[b]! - pre[a]!) + dT(b);

  // Lower bound D: farthest required street round trip (cheapest permitted service direction).
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  let D = 0;
  let farthest: { edgeId: string; roundTrip: number } | null = null;
  for (const e of graph.edges) {
    if (!e.required) continue;
    const u = A.index.get(e.u)!;
    const v = A.index.get(e.v)!;
    const fwd = from.dist[u]! + toScaled(e.weight) + to.dist[v]!;
    const back = directed && isOneway(e) ? Infinity : from.dist[v]! + toScaled(directed ? (e.reverseWeight ?? e.weight) : e.weight) + to.dist[u]!;
    // 'both' service needs both directions; the bound uses the larger round trip only when both are obligatory.
    const rt = directed && twoWay === 'both' && !isOneway(e) && u !== v ? Math.max(fwd, back) : Math.min(fwd, back);
    if (rt > D) {
      D = rt;
      farthest = { edgeId: e.id, roundTrip: fromScaled(rt) };
    }
  }
  const lower = Math.max(L / k, D);

  const issues: Issue[] = [];
  const obligationCount = graph.edges.filter((e) => e.required).reduce((acc, e) => acc + (directed && twoWay === 'both' && !isOneway(e) && e.u !== e.v ? 2 : 1), 0);
  if (k > obligationCount) issues.push({ code: 'FLEET_IDLE', severity: 'warning', message: `${k} vehicles for ${obligationCount} service obligations: at least ${k - obligationCount} vehicle(s) will have nothing to do.` });
  if (limit !== null && D > toScaled(limit)) {
    return fail(graph, [
      {
        code: 'FLEET_LIMIT_INFEASIBLE',
        severity: 'error',
        message: `Impossible with a route limit of ${limit}: servicing street "${farthest!.edgeId}" alone needs a round trip of ${farthest!.roundTrip} from the depot, so no vehicle can do it within the limit.`,
        edgeIds: [farthest!.edgeId],
      },
    ]);
  }

  // 2a. Frederickson–Hecht–Kim threshold split.
  const fhk = fhkSplit();
  function fhkSplit(): Array<[number, number]> {
    if (k === 1) return [[0, m]];
    const cuts: Array<[number, number]> = []; // [end of vehicle j, start of vehicle j+1]
    for (let j = 1; j < k; j++) {
      const Lj = (j / k) * (L - D) + D / 2;
      let i = 1;
      while (i <= m && pre[i]! < Lj) i++;
      if (i > m) {
        cuts.push([m, m]);
        continue;
      }
      if (pre[i] === Lj || pre[i - 1] === Lj) {
        const at = pre[i] === Lj ? i : i - 1;
        cuts.push([at, at]);
        continue;
      }
      if (droppable[i]) {
        let a = i - 1;
        while (a > 0 && droppable[a]) a--;
        let b = i;
        while (b < m && droppable[b + 1]) b++;
        cuts.push([a, b]);
        continue;
      }
      // Required street x→y contains the threshold: give it to the side whose detour is shorter.
      const alpha = Lj - pre[i - 1]!;
      const beta = pre[i]! - Lj;
      const optA = Math.max(beta + dT(i), dS(i) - beta); // vehicle j drives the street
      const optB = Math.max(dT(i - 1) - alpha, alpha + dS(i - 1)); // vehicle j+1 drives it
      cuts.push(optA <= optB ? [i, i] : [i - 1, i - 1]);
    }
    const segs: Array<[number, number]> = [];
    let start = 0;
    for (let j = 0; j < k; j++) {
      const end = j < k - 1 ? cuts[j]![0] : m;
      segs.push([start, end]);
      if (j < k - 1) start = cuts[j]![1];
    }
    return segs;
  }

  // 2b. Exact DP over all splits of the tour (non-overlapping pieces, droppable gaps).
  const lastHard = new Int32Array(m + 1);
  for (let i = 1; i <= m; i++) lastHard[i] = droppable[i] ? lastHard[i - 1]! : i;
  function dp(kind: 'max' | 'sum', bound: number): { value: number; segs: Array<[number, number]> } | null {
    const INF = Infinity;
    let F = new Float64Array(m + 1).fill(INF);
    for (let i = 0; i <= m; i++) if (lastHard[i] === 0) F[i] = 0;
    const choiceA: Int32Array[] = [];
    const choiceG: Int32Array[] = [];
    let best: { value: number; j: number; b: number } | null = null;
    for (let j = 1; j <= k; j++) {
      const G = new Float64Array(m + 1);
      const Gi = new Int32Array(m + 1);
      for (let a = 0; a <= m; a++) {
        G[a] = F[a]!;
        Gi[a] = a;
        if (a > 0 && droppable[a] && G[a - 1]! < G[a]!) {
          G[a] = G[a - 1]!;
          Gi[a] = Gi[a - 1]!;
        }
      }
      const NF = new Float64Array(m + 1).fill(INF);
      const NA = new Int32Array(m + 1).fill(-1);
      for (let a = 0; a < m; a++) {
        const g = G[a]!;
        if (g === INF) continue;
        const base0 = dS(a) - pre[a]!;
        for (let b = a + 1; b <= m; b++) {
          const c = base0 + pre[b]! + dT(b);
          if (c > bound) continue;
          const val = kind === 'max' ? (g > c ? g : c) : g + c;
          if (val < NF[b]!) {
            NF[b] = val;
            NA[b] = a;
          }
        }
      }
      choiceA.push(NA);
      choiceG.push(Gi);
      for (let b = lastHard[m]!; b <= m; b++) if (NF[b]! < INF && (!best || NF[b]! < best.value)) best = { value: NF[b]!, j, b };
      F = NF;
    }
    if (!best) return null;
    const segs: Array<[number, number]> = [];
    let b = best.b;
    for (let j = best.j; j >= 1; j--) {
      const a = choiceA[j - 1]![b]!;
      segs.push([a, b]);
      b = choiceG[j - 1]![a]!;
    }
    segs.reverse();
    return { value: best.value, segs };
  }

  const boundScaled = limit === null ? Infinity : toScaled(limit);
  let segs: Array<[number, number]>;
  let split: FleetRecord['algorithm']['split'] = 'fhk-threshold';
  const segCost = (x: [number, number]) => (x[1] > x[0] ? seg(x[0], x[1]) : 0);
  if (objective === 'total' && limit === null) {
    segs = [[0, m]];
    split = 'optimal-split-dp';
  } else if (m <= SPLIT_DP_MAX) {
    let chosen: { value: number; segs: Array<[number, number]> } | null;
    if (objective === 'balance') {
      const mk = dp('max', boundScaled);
      chosen = mk ? dp('sum', mk.value) : null;
    } else chosen = dp('sum', boundScaled);
    if (!chosen) {
      return fail(graph, [
        {
          code: 'FLEET_LIMIT_UNMET',
          severity: 'error',
          message: `No way of splitting the optimal single route into at most ${k} routes keeps every route within ${limit}. A feasible plan may still exist (this problem is NP-hard in general); try more vehicles or a larger limit.`,
        },
      ]);
    }
    segs = chosen.segs;
    split = 'optimal-split-dp';
    const fhkMax = Math.max(...fhk.map(segCost));
    if (objective === 'balance' && Math.max(...segs.map(segCost)) > fhkMax) {
      segs = fhk; // cannot happen (FHK's split is among the DP's candidates); kept as a safeguard
      split = 'fhk-threshold';
    }
  } else {
    segs = fhk;
    if (limit !== null && Math.max(...segs.map(segCost)) > boundScaled) {
      return fail(graph, [{ code: 'FLEET_LIMIT_UNMET', severity: 'error', message: `The tour is too long (${m} steps) for the exact split search, and the threshold split exceeds the limit ${limit}.` }]);
    }
  }
  const tSplit = now();

  // 3. Materialise routes: approach path + tour piece + return path, classified fleet-wide.
  const pathFrom = (target: number): number[] => {
    const arcs: number[] = [];
    for (let v = target; v !== s; v = A.tail[from.pred[v]!]!) arcs.push(from.pred[v]!);
    return arcs.reverse();
  };
  const pathTo = (source: number): number[] => {
    const arcs: number[] = [];
    for (let v = source; v !== s; v = A.head[to.pred[v]!]!) arcs.push(to.pred[v]!);
    return arcs;
  };
  const obligationKey = (edgeId: string, fromId: string): string | null => {
    const e = edgeById.get(edgeId)!;
    if (!e.required) return null;
    if (!directed || twoWay === 'either' || isOneway(e) || e.u === e.v) return e.id;
    return `${e.id}:${fromId === e.u ? 'f' : 'b'}`;
  };
  const fulfilled = new Set<string>();
  const routes: VehicleRoute[] = [];
  let vehicleNo = 0;
  for (const [a, b] of segs) {
    if (b <= a) continue;
    vehicleNo++;
    const raw: { edgeId: string; from: string; to: string; cost: number }[] = [];
    for (const arc of pathFrom(vIdx[a]!)) raw.push({ edgeId: A.edgeId[arc]!, from: A.ids[A.tail[arc]!]!, to: A.ids[A.head[arc]!]!, cost: A.cost[arc]! });
    const approach = raw.length;
    for (let i = a + 1; i <= b; i++) {
      const st = steps[i - 1]!;
      raw.push({ edgeId: st.edgeId, from: st.from, to: st.to, cost: toScaled(st.weight) });
    }
    const pieceEnd = raw.length;
    for (const arc of pathTo(vIdx[b]!)) raw.push({ edgeId: A.edgeId[arc]!, from: A.ids[A.tail[arc]!]!, to: A.ids[A.head[arc]!]!, cost: A.cost[arc]! });
    let cum = 0;
    let service = 0;
    const serviced = new Set<string>();
    const out: RouteStep[] = raw.map((r, idx) => {
      cum += r.cost;
      const ob = obligationKey(r.edgeId, r.from);
      let kind: TraversalKind;
      if (!edgeById.get(r.edgeId)!.required) kind = 'deadhead';
      else if (ob !== null && !fulfilled.has(ob)) {
        kind = 'service';
        fulfilled.add(ob);
        service += r.cost;
        serviced.add(r.edgeId);
      } else kind = 'repeat';
      return { index: idx, edgeId: r.edgeId, from: r.from, to: r.to, weight: fromScaled(r.cost), kind, cumulative: fromScaled(cum) };
    });
    routes.push({
      vehicle: vehicleNo,
      steps: out,
      distance: fromScaled(cum),
      serviceDistance: fromScaled(service),
      approachDistance: fromScaled(raw.slice(0, approach).reduce((x, r) => x + r.cost, 0)),
      returnDistance: fromScaled(raw.slice(pieceEnd).reduce((x, r) => x + r.cost, 0)),
      tourRange: [a, b],
      servicedEdgeIds: [...serviced],
      checks: [],
    });
  }

  // 4. Independent verification.
  const verification = verifyFleet(graph, routes, { depotId: base.input.depotId, directed, twoWay });
  routes.forEach((r, i) => (r.checks = verification.perVehicle[i]!));
  const makespanScaled = Math.max(...routes.map((r) => toScaled(r.distance)));
  const totalScaled = routes.reduce((x, r) => x + toScaled(r.distance), 0);
  const undirectedGuarantee = !directed && objective === 'balance';
  const fhkBound = (L - D) / k + D;
  const checks: CheckResult[] = [
    ...verification.checks,
    {
      id: 'lower-bound',
      label: 'Longest route is at least the lower bound',
      passed: makespanScaled >= lower - 1e-6,
      detail: `Longest route ${fromScaled(makespanScaled)} ≥ max(L/k, D) = ${fromScaled(Math.round(lower))}.`,
    },
  ];
  if (undirectedGuarantee) {
    checks.push({
      id: 'fhk-bound',
      label: 'Proven FHK bound holds for every route',
      passed: makespanScaled <= fhkBound + 1e-6,
      detail: `Longest route ${fromScaled(makespanScaled)} ≤ (L − D)/k + D = ${fromScaled(Math.round(fhkBound))}, which is within (2 − 1/k) of optimal.`,
    });
  }
  if (base.mode === 'undirected' && base.algorithm.directionPolicy === 'oneway-ignored') {
    issues.push({ code: 'ONEWAY_IGNORED', severity: 'warning', message: 'One-way streets were treated as two-way; these routes may break one-way rules.' });
  }
  const tVerify = now();

  const ratioBound = undirectedGuarantee ? 2 - 1 / k : objective === 'total' && limit === null ? 1 : null;
  const guarantee =
    objective === 'total' && limit === null
      ? 'Exact: minimising total distance from one depot never benefits from extra vehicles (routes joined at the depot form one covering route), so the certified single route is optimal and the other vehicles stay idle.'
      : undirectedGuarantee
        ? `Approximation: the longest route is at most (L − D)/k + D ≤ (2 − 1/k) × optimum = ${(2 - 1 / k).toFixed(3)} × optimum (Frederickson–Hecht–Kim tour splitting of a certified optimal tour${split === 'optimal-split-dp' ? ', improved by the best split of that tour' : ''}). The optimum itself is unknown (NP-hard); it lies between the lower bound and the longest route shown.`
        : directed
          ? 'Heuristic: the same tour-splitting construction on a directed network. No approximation ratio is proven for one-way networks; compare with the lower bound.'
          : 'Heuristic: best split of the certified tour under the route-length limit. No approximation ratio is proven for this objective.';

  const record: FleetRecord = {
    ok: true,
    mode: 'fleet',
    engine: { name: 'sweep-engine', version: ENGINE_VERSION },
    vehicles: k,
    activeVehicles: routes.length,
    objective,
    maxRouteLength: limit,
    routingMode: directed ? 'directed' : 'undirected',
    depotId: base.input.depotId,
    algorithm: { method: 'tour-splitting', split, ratioBound, guarantee },
    base,
    routes,
    makespan: fromScaled(makespanScaled),
    totalDistance: fromScaled(totalScaled),
    singleVehicleDistance: fromScaled(L),
    lowerBound: { value: fromScaled(Math.round(lower)), perVehicleShare: fromScaled(Math.round(L / k)), farthestStreet: farthest },
    gapRatio: Math.round((makespanScaled / Math.max(1, lower)) * 10000) / 10000,
    coverage: verification.coverage,
    checks,
    warnings: [...base.warnings, ...issues],
    timingsMs: { base: r3(tBase - t0), split: r3(tSplit - tBase), verify: r3(tVerify - tSplit), total: r3(now() - t0) },
  };
  return record;
}
