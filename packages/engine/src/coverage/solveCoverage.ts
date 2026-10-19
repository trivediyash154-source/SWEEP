import type { CheckResult, Edge, Graph, RouteStep, SingleRouteRecord } from '../types.js';
import { toScaled, fromScaled } from '../units.js';
import { solveChinesePostman } from '../solve.js';
import { solveDirectedPostman, findUnserviceableStreets } from '../directed.js';
import { verifyRoute, verifyDirectedRoute } from '../verify.js';
import { buildArcGraph } from './arcs.js';
import { planConnectors, undirectedLowerBound, directedLowerBound, type LowerBound } from './bounds.js';
import { undirectedCoverageHeuristic, type HeuristicResult } from './heuristic.js';

/**
 * Coverage of a zone's required streets by one closed route from a depot.
 *
 *  directed (one-way streets obeyed; both directions of a required two-way
 *  street are serviced, as in kerb-side sweeping):
 *    exact directed postman by minimum-cost flow (solveDirectedPostman).
 *  undirected (one-way restrictions ignored: a relaxation, reported):
 *    odd-degree intersections ≤ exactMaxOdd → exact Edmonds–Johnson (solveChinesePostman);
 *    otherwise → candidate-graph matching heuristic (heuristic.ts).
 *
 * Before solving: required segments that no legal closed route from the depot
 * can service (directed mode) are excluded and listed; disconnected required
 * groups and a depot off the required streets are joined by connector paths
 * (bounds.ts). Exactness is therefore claimed only when no connector was needed.
 * Every route is re-verified independently on the zone graph, and a lower
 * bound valid for the (serviceable) original problem is reported with the gap.
 */

export type CoverageMethod = 'exact-directed-min-cost-flow' | 'exact-undirected-edmonds-johnson' | 'heuristic-candidate-matching';

export interface CoverageOptions {
  direction: 'undirected' | 'directed';
  depotId: string;
  /** Exact undirected matching up to this many odd intersections (default 600, the engine's limit). */
  exactMaxOdd?: number;
  /** Force the heuristic (tests and comparisons). */
  forceHeuristic?: boolean;
  /** Candidate pairs per odd intersection for the heuristic (default 10). */
  candidates?: number;
}

export interface CoverageRoute {
  steps: RouteStep[];
  totalDistance: number;
  requiredDistance: number;
  serviceDistance: number;
  deadheadDistance: number;
  repeatDistance: number;
  /** Steps driving a one-way street against its direction (undirected relaxation only). */
  wrongWayTraversals: number;
}

export interface CoverageResult {
  ok: true;
  direction: 'undirected' | 'directed';
  method: CoverageMethod;
  /** True only for an exact method on the original problem (no connectors needed). */
  optimal: boolean;
  guarantee: string;
  /** The zone graph actually solved (unserviceable segments made optional). */
  graph: Graph;
  depotId: string;
  route: CoverageRoute;
  lowerBound: LowerBound | null;
  /** (total − lowerBound) / lowerBound, or null when no bound is available. */
  gap: number | null;
  connectors: { components: number; paths: number; distance: number; edgeIds: string[] };
  excluded: { unserviceable: string[]; reason: string | null };
  heuristic?: Omit<HeuristicResult, 'steps'>;
  exactRecord?: Pick<SingleRouteRecord, 'algorithm' | 'checks' | 'timingsMs'>;
  checks: CheckResult[];
  timingsMs: { prepare: number; solve: number; bound: number; verify: number; total: number };
}

export interface CoverageFailure {
  ok: false;
  message: string;
  issues: { code: string; message: string }[];
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Recompute kinds and cumulative distances of a route against the given graph and service rule. */
function relabel(graph: Graph, steps: RouteStep[], directed: boolean): CoverageRoute {
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const done = new Set<string>();
  let cum = 0;
  let service = 0;
  let deadhead = 0;
  let repeat = 0;
  let wrong = 0;
  let required = 0;
  for (const e of graph.edges) if (e.required) required += toScaled(e.weight) + (directed && !e.oneway && e.u !== e.v ? toScaled(e.reverseWeight ?? e.weight) : 0);
  const out = steps.map((s, i) => {
    const e = edges.get(s.edgeId)!;
    const fwd = s.from === e.u && s.to === e.v;
    const w = toScaled(directed && !fwd && e.u !== e.v ? (e.reverseWeight ?? e.weight) : e.weight);
    if (e.oneway && !fwd && e.u !== e.v) wrong++;
    const obligation = directed && !e.oneway && e.u !== e.v ? `${e.id}:${fwd ? 'f' : 'b'}` : e.id;
    let kind: RouteStep['kind'];
    if (!e.required) {
      kind = 'deadhead';
      deadhead += w;
    } else if (!done.has(obligation)) {
      kind = 'service';
      done.add(obligation);
      service += w;
    } else {
      kind = 'repeat';
      repeat += w;
    }
    cum += w;
    return { index: i, edgeId: s.edgeId, from: s.from, to: s.to, weight: fromScaled(w), kind, cumulative: fromScaled(cum) };
  });
  return {
    steps: out,
    totalDistance: fromScaled(cum),
    requiredDistance: fromScaled(required),
    serviceDistance: fromScaled(service),
    deadheadDistance: fromScaled(deadhead),
    repeatDistance: fromScaled(repeat),
    wrongWayTraversals: wrong,
  };
}

const BIG_LIMITS = { maxVertices: 400_000, maxEdges: 800_000 };

export function solveZoneCoverage(zoneGraph: Graph, opts: CoverageOptions): CoverageResult | CoverageFailure {
  const t0 = now();
  const directed = opts.direction === 'directed';
  if (!zoneGraph.vertices.some((v) => v.id === opts.depotId)) return { ok: false, message: `Depot ${opts.depotId} is not in the network.`, issues: [{ code: 'DEPOT_UNKNOWN', message: `Depot ${opts.depotId} is not in the network.` }] };
  // 1. Exclusions (directed): required segments no legal closed route from the depot can service.
  let graph: Graph = zoneGraph;
  let unserviceable: string[] = [];
  if (directed) {
    const bad = findUnserviceableStreets(zoneGraph, opts.depotId);
    unserviceable = [...bad.unreachable, ...bad.noReturn];
    if (unserviceable.length) {
      const drop = new Set(unserviceable);
      graph = { ...zoneGraph, edges: zoneGraph.edges.map((e) => (drop.has(e.id) ? { ...e, required: false } : e)) };
    }
  }
  if (!graph.edges.some((e) => e.required)) {
    return { ok: false, message: 'The zone contains no serviceable required street.', issues: [{ code: 'NO_REQUIRED_EDGES', message: unserviceable.length ? `All ${unserviceable.length} required segments are unserviceable from the depot under the one-way rules.` : 'No street in the zone matches the selected road classes.' }] };
  }
  // 2. Connectors for disconnected groups and an off-network depot.
  const agU = buildArcGraph(graph, directed);
  const depot = agU.vertexIndex.get(opts.depotId)!;
  const plan = planConnectors(graph, agU, depot);
  const connectorEdges = new Set<string>();
  let solveGraph: Graph = graph;
  const virtualOf = new Map<string, string>();
  if (plan.arcs.length) {
    if (!directed) {
      for (const path of plan.arcs) for (const a of path) connectorEdges.add(graph.edges[agU.arcEdge[a]!]!.id);
      solveGraph = { ...graph, edges: graph.edges.map((e) => (connectorEdges.has(e.id) && !e.required ? { ...e, required: true } : e)) };
    } else {
      // Directed: one required one-way copy per connector arc, in its legal direction of travel.
      const extra: Edge[] = [];
      plan.arcs.forEach((path, pi) => {
        for (const a of path) {
          const e = graph.edges[agU.arcEdge[a]!]!;
          connectorEdges.add(e.id);
          const fwd = agU.arcFwd[a] === 1;
          const id = `x${pi}.${extra.length}:${e.id}`;
          virtualOf.set(id, e.id);
          extra.push({ id, u: fwd ? e.u : e.v, v: fwd ? e.v : e.u, weight: fromScaled(agU.arcCost[a]!), required: true, oneway: true });
        }
      });
      solveGraph = { ...graph, edges: [...graph.edges, ...extra] };
    }
  }
  const t1 = now();

  // 3. Solve.
  let method: CoverageMethod;
  let rawSteps: RouteStep[];
  let heuristic: HeuristicResult | undefined;
  let exactRecord: CoverageResult['exactRecord'];
  const issuesOf = (v: { issues: { code: string; message: string; severity: string }[] }): { code: string; message: string }[] => v.issues.filter((i) => i.severity === 'error').map((i) => ({ code: i.code, message: i.message }));
  if (directed) {
    const r = solveDirectedPostman(solveGraph, { depotId: opts.depotId, twoWay: 'both', limits: BIG_LIMITS });
    if (!r.ok) return { ok: false, message: 'The directed coverage problem could not be solved.', issues: issuesOf(r.validation) };
    method = 'exact-directed-min-cost-flow';
    rawSteps = r.route.steps.map((s) => ({ ...s, edgeId: virtualOf.get(s.edgeId) ?? s.edgeId }));
    exactRecord = { algorithm: r.algorithm, checks: r.checks, timingsMs: r.timingsMs };
  } else {
    let odd = 0;
    const deg = new Map<string, number>();
    for (const e of solveGraph.edges) if (e.required) for (const x of [e.u, e.v]) deg.set(x, (deg.get(x) ?? 0) + 1);
    for (const d of deg.values()) if (d % 2 === 1) odd++;
    const exactMax = opts.exactMaxOdd ?? 600;
    if (!opts.forceHeuristic && odd <= exactMax) {
      const r = solveChinesePostman(solveGraph, { depotId: opts.depotId, ignoreOneway: true, limits: { ...BIG_LIMITS, maxOddVertices: exactMax } });
      if (!r.ok) return { ok: false, message: 'The undirected coverage problem could not be solved.', issues: issuesOf(r.validation) };
      method = 'exact-undirected-edmonds-johnson';
      rawSteps = r.route.steps;
      exactRecord = { algorithm: r.algorithm, checks: r.checks, timingsMs: r.timingsMs };
    } else {
      heuristic = undirectedCoverageHeuristic(solveGraph, { depot, ...(opts.candidates ? { candidates: opts.candidates } : {}) });
      method = 'heuristic-candidate-matching';
      rawSteps = heuristic.steps;
    }
  }
  const t2 = now();

  // 4. Lower bound for the original (serviceable) problem.
  const exactOriginal = method !== 'heuristic-candidate-matching' && plan.arcs.length === 0;
  const route = relabel(graph, rawSteps, directed);
  let lowerBound: LowerBound | null;
  if (exactOriginal) lowerBound = { value: route.totalDistance, method: directed ? 'min-cost-flow-balance' : 't-join-exact-matching', requiredLength: route.requiredDistance, detail: 'The exact optimum of the original problem (no connector was needed).' };
  else lowerBound = directed ? directedLowerBound(graph) : undirectedLowerBound(graph, opts.forceHeuristic ? 0 : (opts.exactMaxOdd ?? 600));
  const t3 = now();

  // 5. Independent verification on the zone graph.
  const v = directed ? verifyDirectedRoute(graph, route.steps, { depotId: opts.depotId, twoWay: 'both', expectedTotal: route.totalDistance }) : verifyRoute(graph, route.steps, { depotId: opts.depotId, expectedTotal: route.totalDistance });
  const lbCheck: CheckResult = lowerBound
    ? { id: 'lower-bound', label: 'Route is not shorter than the proven lower bound', passed: toScaled(route.totalDistance) >= toScaled(lowerBound.value), detail: `${route.totalDistance.toFixed(1)} m ≥ ${lowerBound.value.toFixed(1)} m (${lowerBound.method}).` }
    : { id: 'lower-bound', label: 'Lower bound', passed: true, detail: 'No lower bound available.' };
  const checks = [...v.checks, lbCheck];
  const t4 = now();
  const gap = lowerBound && lowerBound.value > 0 ? (route.totalDistance - lowerBound.value) / lowerBound.value : null;
  const guarantee =
    method === 'heuristic-candidate-matching'
      ? 'Heuristic (not proven optimal): odd intersections are paired among nearest candidates; the gap to a proven lower bound is reported.'
      : exactOriginal
        ? directed
          ? 'Optimal: minimum-cost flow balancing, certified by LP duality.'
          : 'Optimal: Edmonds–Johnson with an exact minimum-weight perfect matching (LP certificate).'
        : `Exact for the connected problem (${plan.components} required groups, including the depot when it is off the required streets, joined by ${plan.arcs.length} shortest connector paths); covering separated groups optimally is the NP-hard rural postman problem, so only the gap to a proven lower bound is claimed.`;
  const relaxation = !directed && graph.edges.some((e) => e.oneway) ? ` One-way restrictions were ignored (undirected relaxation): ${route.wrongWayTraversals} traversal(s) drive a one-way street against its direction.` : '';
  return {
    ok: true,
    direction: opts.direction,
    method,
    optimal: exactOriginal,
    guarantee: guarantee + relaxation,
    graph,
    depotId: opts.depotId,
    route,
    lowerBound,
    gap,
    connectors: { components: plan.components, paths: plan.arcs.length, distance: plan.distance, edgeIds: [...connectorEdges] },
    excluded: { unserviceable, reason: unserviceable.length ? 'No legal closed route from the depot can service these one-way segments (they enter or leave the connected one-way network).' : null },
    ...(heuristic ? { heuristic: (({ steps: _s, ...rest }) => rest)(heuristic) } : {}),
    ...(exactRecord ? { exactRecord } : {}),
    checks,
    timingsMs: { prepare: t1 - t0, solve: t2 - t1, bound: t3 - t2, verify: t4 - t3, total: t4 - t0 },
  };
}
