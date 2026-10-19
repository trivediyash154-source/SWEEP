import type { CheckResult, Graph } from '../types.js';
import { fromScaled } from '../units.js';
import { arcDijkstra, buildArcGraph } from './arcs.js';
import { planFleet, type FleetFailure, type FleetPlan, type FleetPlanOptions, type FleetRoute, type FleetTurns } from './carp.js';
import { addTallies } from './turns.js';
import { solveZoneCoverage, type CoverageResult } from './solveCoverage.js';

/**
 * Street coverage from several depots (for example one yard per ward).
 *
 * Method (heuristic; no optimality is claimed):
 *  1. Partition: every required street goes to the depot with the cheapest round
 *     trip through it (shortest legal path from the depot to one end, the street,
 *     shortest legal path back), using exact network distances.
 *  2. Each depot's streets are covered by its own vehicles with the single-depot
 *     engine: solveZoneCoverage (exact where it is exact) then planFleet.
 *
 * Lower bounds (valid for ANY plan that serves every street from these depots
 * with at most the given vehicles, not only for this partition):
 *  - total distance ≥ the length of the required service (each obligation is driven);
 *  - makespan ≥ max over streets of the cheapest round-trip time from any depot
 *    (some vehicle must make that trip), and ≥ total service time ÷ total vehicles.
 * The gaps to these bounds are reported. They are weaker than the single-depot
 * bounds, because they hold for every possible assignment of streets to depots.
 */

export interface DepotSpec {
  depotId: string;
  vehicles: number;
}

export interface MultiDepotOptions extends Omit<FleetPlanOptions, 'vehicles' | 'depotId' | 'coverage'> {
  depots: DepotSpec[];
}

export interface DepotPlan {
  depotId: string;
  vehicles: number;
  /** Required streets assigned to this depot. */
  requiredEdges: string[];
  coverage: CoverageResult | null;
  plan: FleetPlan | null;
  message: string | null;
}

export interface MultiDepotRoute extends FleetRoute {
  depotId: string;
}

export interface MultiDepotPlan {
  ok: true;
  method: 'nearest-depot-partition';
  guarantee: string;
  depots: DepotPlan[];
  routes: MultiDepotRoute[];
  totals: { distance: number; serviceDistance: number; deadheadDistance: number; makespanSeconds: number; totalSeconds: number; vehiclesUsed: number; vehiclesAvailable: number };
  lowerBounds: { totalDistance: { value: number; basis: string }; makespanSeconds: { value: number; basis: string } };
  gaps: { totalDistance: number | null; makespan: number | null };
  /** Required streets no depot can service on a closed legal route (directed mode). */
  unserviceable: string[];
  feasibility: { ok: boolean; issues: string[] };
  validation: { ok: boolean; checks: CheckResult[] };
  /** Turns over all depots' routes (turn rules given). */
  turns: FleetTurns | null;
  timingsMs: { partition: number; plans: number; total: number };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function planMultiDepotFleet(graph: Graph, opts: MultiDepotOptions): MultiDepotPlan | FleetFailure {
  const t0 = now();
  if (opts.depots.length < 1) return { ok: false, message: 'At least one depot is needed.' };
  if (new Set(opts.depots.map((d) => d.depotId)).size !== opts.depots.length) return { ok: false, message: 'Each depot can be listed once.' };
  if (opts.depots.some((d) => !Number.isInteger(d.vehicles) || d.vehicles < 1)) return { ok: false, message: 'Every depot needs at least one vehicle.' };
  if (!(opts.serviceSpeedKmh > 0) || !(opts.deadheadSpeedKmh > 0)) return { ok: false, message: 'Service and deadhead speeds must be positive.' };
  const directed = opts.direction === 'directed';
  const ag = buildArcGraph(graph, directed);
  const depotV = opts.depots.map((d) => ag.vertexIndex.get(d.depotId));
  if (depotV.some((v) => v === undefined)) return { ok: false, message: 'A depot is not on the street network.' };

  // 1. Partition by cheapest round trip (scaled metres), and the per-street bound ingredients.
  const from = depotV.map((v) => arcDijkstra(ag, [v!]).dist);
  const to = depotV.map((v) => (directed ? arcDijkstra(ag, [v!], { reverse: true }).dist : null));
  const vs = (opts.serviceSpeedKmh * 1000) / 3600;
  const vd = (opts.deadheadSpeedKmh * 1000) / 3600;
  const owner = new Map<string, number>();
  const unserviceable: string[] = [];
  let serviceM = 0;
  let worstRoundTripS = 0;
  graph.edges.forEach((e, k) => {
    if (!e.required) return;
    // Obligations: undirected → one traversal either way; directed → each permitted direction of the street.
    const arcs = [ag.fwdArc[k]!, ag.backArc[k]!].filter((a) => a >= 0);
    const obligations = directed ? arcs : [arcs];
    let bestDepot = -1;
    let bestCost = Infinity;
    // Cheapest round trip (scaled metres) from depot d through one obligation.
    const trip = (d: number, ob: number | number[]): number => {
      let c = Infinity;
      for (const a of Array.isArray(ob) ? ob : [ob]) {
        const back = directed ? to[d]![ag.arcHead[a]!]! : from[d]![ag.arcHead[a]!]!;
        c = Math.min(c, from[d]![ag.arcTail[a]!]! + ag.arcCost[a]! + back);
      }
      return c;
    };
    for (let d = 0; d < depotV.length; d++) {
      // The whole street goes to one depot: the one whose worst obligation is cheapest.
      let cost = 0;
      for (const ob of obligations) cost = Math.max(cost, trip(d, ob));
      if (cost < bestCost) [bestCost, bestDepot] = [cost, d];
    }
    if (bestDepot < 0 || !Number.isFinite(bestCost)) {
      unserviceable.push(e.id);
      return;
    }
    owner.set(e.id, bestDepot);
    // Bounds: every obligation is driven, and some vehicle from SOME depot makes its round trip.
    for (const ob of obligations) {
      const len = ag.arcCost[Array.isArray(ob) ? ob[0]! : ob]!;
      serviceM += fromScaled(len);
      let best = Infinity;
      for (let d = 0; d < depotV.length; d++) best = Math.min(best, trip(d, ob));
      if (Number.isFinite(best)) worstRoundTripS = Math.max(worstRoundTripS, fromScaled(len) / vs + fromScaled(Math.max(0, best - len)) / vd);
    }
  });
  const tPartition = now() - t0;

  // 2. One single-depot plan per depot.
  const depots: DepotPlan[] = [];
  const routes: MultiDepotRoute[] = [];
  const issues: string[] = [];
  let vehicle = 0;
  opts.depots.forEach((d, i) => {
    const requiredEdges = graph.edges.filter((e) => owner.get(e.id) === i).map((e) => e.id);
    const entry: DepotPlan = { depotId: d.depotId, vehicles: d.vehicles, requiredEdges, coverage: null, plan: null, message: null };
    depots.push(entry);
    if (!requiredEdges.length) {
      entry.message = 'No street is closer to this depot than to another one; its vehicles stay at the depot.';
      return;
    }
    const mine = new Set(requiredEdges);
    const sub: Graph = { ...graph, edges: graph.edges.map((e) => ({ ...e, required: mine.has(e.id) })) };
    const cov = solveZoneCoverage(sub, { direction: opts.direction, depotId: d.depotId });
    if (!cov.ok) {
      entry.message = cov.message;
      issues.push(`Depot ${d.depotId}: ${cov.message}`);
      return;
    }
    entry.coverage = cov;
    unserviceable.push(...cov.excluded.unserviceable);
    const { depots: _depots, ...rest } = opts;
    void _depots;
    const fp = planFleet(cov.graph, { ...rest, vehicles: d.vehicles, depotId: d.depotId, coverage: cov });
    if (!fp.ok) {
      entry.message = fp.message;
      issues.push(`Depot ${d.depotId}: ${fp.message}`);
      return;
    }
    entry.plan = fp;
    if (!fp.feasibility.ok) issues.push(...fp.feasibility.issues.map((x) => `Depot ${d.depotId}: ${x}`));
    for (const r of fp.routes) routes.push({ ...r, vehicle: vehicle++, depotId: d.depotId });
  });
  const tPlans = now() - t0 - tPartition;

  // Independent checks on the combined plan.
  const checks: CheckResult[] = [];
  const served = new Set<string>();
  for (const r of routes) for (const s of r.steps) if (s.kind === 'service') served.add(directed ? `${s.edgeId}:${s.from}` : s.edgeId);
  const excluded = new Set(unserviceable);
  const missing: string[] = [];
  graph.edges.forEach((e, k) => {
    if (!e.required || excluded.has(e.id)) return;
    if (!directed) {
      if (!served.has(e.id)) missing.push(e.id);
      return;
    }
    for (const a of [ag.fwdArc[k]!, ag.backArc[k]!]) if (a >= 0 && !served.has(`${e.id}:${ag.vertexIds[ag.arcTail[a]!]}`)) missing.push(`${e.id} (${ag.vertexIds[ag.arcTail[a]!]}→${ag.vertexIds[ag.arcHead[a]!]})`);
  });
  checks.push({ id: 'coverage', label: 'Every serviceable street is serviced by some vehicle', passed: missing.length === 0, detail: missing.length ? `${missing.length} obligation(s) not serviced, e.g. ${missing.slice(0, 3).join(', ')}` : `${served.size} service obligation(s) covered across ${routes.length} route(s)` });
  const badEnds = routes.filter((r) => r.steps.length > 0 && (r.steps[0]!.from !== r.depotId || r.steps[r.steps.length - 1]!.to !== r.depotId));
  checks.push({ id: 'depots', label: 'Every route starts and ends at its own depot', passed: badEnds.length === 0, detail: badEnds.length ? `${badEnds.length} route(s) do not` : `${routes.length} route(s) checked` });
  const perDepotValid = depots.every((d) => !d.plan || d.plan.validation.ok);
  checks.push({ id: 'per-depot', label: 'Each depot plan passes its own verification', passed: perDepotValid, detail: depots.map((d) => `${d.depotId}: ${d.plan ? (d.plan.validation.ok ? 'valid' : 'invalid') : (d.message ?? 'no plan')}`).join('; ') });

  const distance = routes.reduce((x, r) => x + r.distance, 0);
  const serviceDistance = routes.reduce((x, r) => x + r.serviceDistance, 0);
  const makespan = routes.reduce((x, r) => Math.max(x, r.seconds), 0);
  const totalSeconds = routes.reduce((x, r) => x + r.seconds, 0);
  const vehiclesAvailable = opts.depots.reduce((x, d) => x + d.vehicles, 0);
  const lbMakespan = Math.max(worstRoundTripS, serviceM / vs / vehiclesAvailable);
  const depotTurns = depots.filter((d) => d.plan).map((d) => d.plan!.turns);
  let turns: FleetTurns | null = null;
  if (opts.turns && depotTurns.length && depotTurns.every((t) => t)) {
    const ts = depotTurns as FleetTurns[];
    const lb = ts.every((t) => t.lowerBound) ? ts.reduce((x, t) => ({ seconds: x.seconds + t.lowerBound!.seconds, banned: x.banned + t.lowerBound!.banned }), { seconds: 0, banned: 0 }) : null;
    const after = addTallies(ts.map((t) => t.after));
    turns = {
      before: addTallies(ts.map((t) => t.before)),
      after,
      lowerBound: lb,
      reorderedRoutes: ts.reduce((x, t) => x + t.reorderedRoutes, 0),
      keptRoutes: ts.reduce((x, t) => x + t.keptRoutes, 0),
      optimal: !!lb && after.seconds <= lb.seconds + 1e-9 && after.banned <= lb.banned,
    };
  }
  return {
    ok: true,
    method: 'nearest-depot-partition',
    guarantee:
      'Heuristic (not proven optimal): each street is assigned to the depot with the cheapest round trip through it, then each depot is planned with the single-depot engine. Gaps are measured against lower bounds that hold for any assignment of streets to these depots.',
    depots,
    routes,
    totals: { distance, serviceDistance, deadheadDistance: distance - serviceDistance, makespanSeconds: makespan, totalSeconds, vehiclesUsed: routes.filter((r) => r.steps.length > 0).length, vehiclesAvailable },
    lowerBounds: {
      totalDistance: { value: serviceM, basis: 'Length of the required service: every obligation must be driven at least once.' },
      makespanSeconds: { value: lbMakespan, basis: `max(the slowest street's cheapest round trip from any depot, total service time ÷ ${vehiclesAvailable} vehicle(s)).` },
    },
    gaps: { totalDistance: serviceM > 0 ? (distance - serviceM) / serviceM : null, makespan: lbMakespan > 0 ? (makespan - lbMakespan) / lbMakespan : null },
    unserviceable: [...excluded],
    feasibility: { ok: issues.length === 0, issues },
    validation: { ok: checks.every((c) => c.passed), checks },
    turns,
    timingsMs: { partition: tPartition, plans: tPlans, total: now() - t0 },
  };
}
