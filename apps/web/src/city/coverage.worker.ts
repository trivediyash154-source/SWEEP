/// <reference lib="webworker" />
import { cityTurnOptions, decodeCityBundle, orderCoverageForTurns, planFleet, planMultiDepotFleet, solveZoneCoverage, TurnModel, zoneCoverageGraph, type CheckResult, type CityModel, type CoverageResult, type FleetPlan, type FleetTurns, type RouteStep, type TurnOptions, type TurnPenalties, type TurnTally, type Zone, type ZoneReport } from '@sweep/engine';
import type { ScenarioSpec } from './router.worker';

/**
 * Street-coverage worker. One request = one zone, scenario, direction mode and
 * fleet: zoneCoverageGraph → solveZoneCoverage (exact directed min-cost flow,
 * exact undirected matching, or the heuristic with a lower bound) → planFleet
 * when more than one vehicle or a capacity / shift limit is set. Results are
 * the engine's own numbers; nothing here estimates or rounds a guarantee.
 */

export interface FleetSettings {
  vehicles: number;
  objective: 'min-total' | 'min-makespan';
  capacity: number | null;
  demandPerKm: number;
  shiftSeconds: number | null;
  serviceSpeedKmh: number;
  deadheadSpeedKmh: number;
  dumpSeconds: number;
}

export type CoverageRequest =
  | { id: number; op: 'init'; url: string }
  | { id: number; op: 'plan'; zone: Zone; roadClasses: string[] | null; direction: 'undirected' | 'directed'; scenario: ScenarioSpec; depotNode: number; dumpNode: number | null; fleet: FleetSettings; extraDepots?: { node: number; vehicles: number }[]; turnAware?: boolean };

/** A vehicle route as arcs (segment × 2 + direction) with the kind and length of every step. */
export interface VehicleRoute {
  vehicle: number;
  /** City node of the depot this vehicle starts and ends at. */
  depotNode: number;
  arcs: Int32Array;
  /** 0 service, 1 repeat, 2 deadhead. */
  kinds: Uint8Array;
  lengths: Float64Array;
  /** Step index after which the vehicle unloads at the disposal site. */
  dumpAfterStep: number[];
  distanceM: number;
  serviceM: number;
  deadheadM: number;
  seconds: number;
  trips: number;
  feasible: { capacity: boolean; shift: boolean };
}

export interface CoveragePlanResult {
  report: ZoneReport;
  direction: 'undirected' | 'directed';
  method: CoverageResult['method'] | 'nearest-depot-partition';
  optimal: boolean;
  /** Several depots: each depot's vehicles and the streets assigned to it (null for one depot). */
  depots: { node: number; vehicles: number; requiredSegments: number; message: string | null }[] | null;
  guarantee: string;
  lowerBoundM: number | null;
  lowerBoundMethod: string | null;
  lowerBoundDetail: string | null;
  gap: number | null;
  connectors: CoverageResult['connectors'];
  excluded: CoverageResult['excluded'];
  wrongWayTraversals: number;
  totals: { distanceM: number; serviceM: number; deadheadM: number; repeatM: number };
  checks: CheckResult[];
  timingsMs: Record<string, number>;
  fleet: null | {
    guarantee: string;
    totals: FleetPlan['totals'];
    lowerBounds: FleetPlan['lowerBounds'];
    gaps: FleetPlan['gaps'];
    feasibility: FleetPlan['feasibility'];
    validationOk: boolean;
    checks: CheckResult[];
    timingsMs: FleetPlan['timingsMs'];
  };
  routes: VehicleRoute[];
  /** Turns of the planned routes (truck turn penalties, left-hand traffic). Not included in the route times. */
  turns: PlanTurns;
}

export interface PlanTurns {
  /** Whether the turn order was optimised (same streets and distance). */
  ordered: boolean;
  penalties: TurnPenalties;
  /** Mapped turn restrictions that apply to the truck profile. */
  restrictions: number;
  /** The engine's order before turn optimisation, and the order shown. */
  before: TurnTally;
  after: TurnTally;
  /** Valid for every order of the same street traversals; null when not computed. */
  lowerBound: { seconds: number; banned: number } | null;
  optimal: boolean;
  /** Routes that unload mid-way keep their order. */
  keptRoutes: number;
}

export type CoverageResponse = { id: number; ok: true; op: 'init' } | { id: number; ok: true; op: 'plan'; result: CoveragePlanResult } | { id: number; ok: false; error: string };

let city: CityModel | null = null;
let rules: TurnOptions | null = null;
let restrictionCount = 0;

function fleetTurns(t: FleetTurns | null, graph: CoverageResult['graph'], steps: RouteStep[][]): PlanTurns {
  if (t) return { ordered: true, penalties: rules!.penalties, restrictions: restrictionCount, before: t.before, after: t.after, lowerBound: t.lowerBound, optimal: t.optimal, keptRoutes: t.keptRoutes };
  const model = new TurnModel(graph, rules!);
  const tallies = steps.map((x) => model.tally(x));
  const sum = tallies.reduce((a, b) => ({ straight: a.straight + b.straight, left: a.left + b.left, right: a.right + b.right, uturn: a.uturn + b.uturn, uturnsAwayFromDeadEnds: a.uturnsAwayFromDeadEnds + b.uturnsAwayFromDeadEnds, banned: a.banned + b.banned, seconds: a.seconds + b.seconds }), model.tally([]));
  return { ordered: false, penalties: rules!.penalties, restrictions: restrictionCount, before: sum, after: sum, lowerBound: null, optimal: false, keptRoutes: 0 };
}

const KIND = { service: 0, repeat: 1, deadhead: 2 } as const;

function toVehicleRoute(c: CityModel, nodeOfVertex: Map<string, number>, vehicle: number, steps: RouteStep[], extra: { depotNode: number; dumpAfterStep: number[]; seconds: number; trips: number; feasible: { capacity: boolean; shift: boolean } }): VehicleRoute {
  const arcs = new Int32Array(steps.length);
  const kinds = new Uint8Array(steps.length);
  const lengths = new Float64Array(steps.length);
  let distanceM = 0;
  let serviceM = 0;
  let deadheadM = 0;
  steps.forEach((s, i) => {
    const seg = Number(s.edgeId.slice(1));
    const from = nodeOfVertex.get(s.from)!;
    arcs[i] = seg * 2 + (from === c.segU[seg] ? 0 : 1);
    kinds[i] = KIND[s.kind];
    lengths[i] = s.weight;
    distanceM += s.weight;
    if (s.kind === 'service') serviceM += s.weight;
    else deadheadM += s.weight;
  });
  return { vehicle, arcs, kinds, lengths, distanceM, serviceM, deadheadM, ...extra };
}

function plan(req: Extract<CoverageRequest, { op: 'plan' }>): CoveragePlanResult {
  const c = city!;
  const depotId = `n${c.nodeOsm[req.depotNode]}`;
  const zg = zoneCoverageGraph(c, {
    zone: req.zone,
    ...(req.roadClasses ? { roadClasses: req.roadClasses } : {}),
    direction: req.direction,
    closedSegments: req.scenario.closed,
    onewayOverrides: new Map(req.scenario.oneway),
    depotId,
  });
  if (!zg.graph.edges.some((e) => e.required)) throw new Error('No street of the selected classes has its midpoint inside this zone.');
  if (!zg.graph.vertices.some((v) => v.id === depotId)) throw new Error('The depot is not connected to the streets of this zone (closures may have cut it off). Pick another depot.');
  const dumpId = req.dumpNode !== null ? `n${c.nodeOsm[req.dumpNode]}` : null;
  if (dumpId && !zg.graph.vertices.some((v) => v.id === dumpId)) throw new Error('The disposal site is not connected to the streets of this zone. Pick another site.');
  const nodeOfVertex = new Map<string, number>();
  zg.graph.vertices.forEach((v, i) => nodeOfVertex.set(v.id, zg.vertexNode[i]!));

  const f = req.fleet;
  if (req.extraDepots && req.extraDepots.length > 0) return planSeveralDepots(req, zg, nodeOfVertex, depotId, dumpId);

  const turnAware = req.turnAware !== false;
  const raw = solveZoneCoverage(zg.graph, { direction: req.direction, depotId });
  if (!raw.ok) throw new Error(raw.message);
  const needsFleet = f.vehicles > 1 || f.capacity !== null || f.shiftSeconds !== null || dumpId !== null;
  // A single route is reordered here; fleet routes are reordered by planFleet, one by one.
  const ordered = turnAware && !needsFleet ? orderCoverageForTurns(raw, rules!) : null;
  const cov = ordered ?? raw;
  const base: Omit<CoveragePlanResult, 'fleet' | 'routes' | 'turns'> = {
    report: zg.report,
    direction: cov.direction,
    method: cov.method,
    optimal: cov.optimal,
    depots: null,
    guarantee: cov.guarantee,
    lowerBoundM: cov.lowerBound?.value ?? null,
    lowerBoundMethod: cov.lowerBound?.method ?? null,
    lowerBoundDetail: cov.lowerBound?.detail ?? null,
    gap: cov.gap,
    connectors: cov.connectors,
    excluded: cov.excluded,
    wrongWayTraversals: cov.route.wrongWayTraversals,
    totals: { distanceM: cov.route.totalDistance, serviceM: cov.route.serviceDistance, deadheadM: cov.route.deadheadDistance, repeatM: cov.route.repeatDistance },
    checks: cov.checks,
    timingsMs: cov.timingsMs,
  };
  if (!needsFleet) {
    const seconds = (cov.route.serviceDistance / 1000 / f.serviceSpeedKmh + (cov.route.totalDistance - cov.route.serviceDistance) / 1000 / f.deadheadSpeedKmh) * 3600;
    const turns: PlanTurns = ordered
      ? { ordered: true, penalties: rules!.penalties, restrictions: restrictionCount, before: ordered.turns.before, after: ordered.turns.after, lowerBound: ordered.turns.lowerBound, optimal: ordered.turns.optimal, keptRoutes: 0 }
      : fleetTurns(null, cov.graph, [cov.route.steps]);
    return { ...base, fleet: null, turns, routes: [toVehicleRoute(c, nodeOfVertex, 0, cov.route.steps, { depotNode: req.depotNode, dumpAfterStep: [], seconds, trips: 1, feasible: { capacity: true, shift: true } })] };
  }
  const fp = planFleet(cov.graph, {
    vehicles: f.vehicles,
    depotId,
    dumpId,
    direction: req.direction,
    objective: f.objective,
    capacity: f.capacity,
    demandPerKm: f.demandPerKm,
    shiftSeconds: f.shiftSeconds,
    serviceSpeedKmh: f.serviceSpeedKmh,
    deadheadSpeedKmh: f.deadheadSpeedKmh,
    dumpSeconds: f.dumpSeconds,
    coverage: cov,
    turns: turnAware ? rules : null,
  });
  if (!fp.ok) throw new Error(fp.message);
  return {
    ...base,
    turns: fleetTurns(fp.turns, cov.graph, fp.routes.map((r) => r.steps)),
    fleet: { guarantee: fp.guarantee, totals: fp.totals, lowerBounds: fp.lowerBounds, gaps: fp.gaps, feasibility: fp.feasibility, validationOk: fp.validation.ok, checks: fp.validation.checks, timingsMs: fp.timingsMs },
    routes: fp.routes.map((r) => toVehicleRoute(c, nodeOfVertex, r.vehicle, r.steps, { depotNode: req.depotNode, dumpAfterStep: r.dumpAfterStep, seconds: r.seconds, trips: r.tripLoads.length || 1, feasible: r.feasible })),
  };
}

/** Several depots: nearest-depot partition, then a single-depot plan per depot (engine planMultiDepotFleet). */
function planSeveralDepots(req: Extract<CoverageRequest, { op: 'plan' }>, zg: ReturnType<typeof zoneCoverageGraph>, nodeOfVertex: Map<string, number>, depotId: string, dumpId: string | null): CoveragePlanResult {
  const c = city!;
  const f = req.fleet;
  const extras = req.extraDepots ?? [];
  const depots = [{ depotId, vehicles: f.vehicles, node: req.depotNode }, ...extras.map((d) => ({ depotId: `n${c.nodeOsm[d.node]}`, vehicles: d.vehicles, node: d.node }))];
  for (const d of depots.slice(1)) if (!zg.graph.vertices.some((v) => v.id === d.depotId)) throw new Error('An additional depot is not connected to the streets of this zone. Pick another one.');
  const md = planMultiDepotFleet(zg.graph, {
    depots: depots.map(({ depotId: id, vehicles }) => ({ depotId: id, vehicles })),
    dumpId,
    direction: req.direction,
    objective: f.objective,
    capacity: f.capacity,
    demandPerKm: f.demandPerKm,
    shiftSeconds: f.shiftSeconds,
    serviceSpeedKmh: f.serviceSpeedKmh,
    deadheadSpeedKmh: f.deadheadSpeedKmh,
    dumpSeconds: f.dumpSeconds,
    turns: req.turnAware !== false ? rules : null,
  });
  if (!md.ok) throw new Error(md.message);
  const covs = md.depots.map((d) => d.coverage).filter((x): x is CoverageResult => !!x);
  const nodeOfDepot = new Map(depots.map((d) => [d.depotId, d.node]));
  const plans = md.depots.map((d) => d.plan).filter((p): p is FleetPlan => !!p);
  const fleetTotals: FleetPlan['totals'] = {
    distance: md.totals.distance,
    serviceDistance: md.totals.serviceDistance,
    deadheadDistance: md.totals.deadheadDistance,
    makespanSeconds: md.totals.makespanSeconds,
    totalSeconds: md.totals.totalSeconds,
    vehiclesUsed: md.totals.vehiclesUsed,
    intermediateDumps: plans.reduce((x, p) => x + p.totals.intermediateDumps, 0),
    demand: plans.reduce((x, p) => x + p.totals.demand, 0),
  };
  return {
    report: zg.report,
    direction: req.direction,
    method: 'nearest-depot-partition',
    optimal: false,
    depots: md.depots.map((d) => ({ node: nodeOfDepot.get(d.depotId)!, vehicles: d.vehicles, requiredSegments: d.requiredEdges.length, message: d.message })),
    guarantee: md.guarantee,
    lowerBoundM: md.lowerBounds.totalDistance.value,
    lowerBoundMethod: 'service length',
    lowerBoundDetail: md.lowerBounds.totalDistance.basis,
    gap: md.gaps.totalDistance,
    connectors: { components: covs.reduce((x, v) => x + v.connectors.components, 0), paths: covs.reduce((x, v) => x + v.connectors.paths, 0), distance: covs.reduce((x, v) => x + v.connectors.distance, 0), edgeIds: covs.flatMap((v) => v.connectors.edgeIds) },
    excluded: { unserviceable: md.unserviceable, reason: md.unserviceable.length ? 'no depot can service them on a closed legal route' : null },
    wrongWayTraversals: covs.reduce((x, v) => x + v.route.wrongWayTraversals, 0),
    totals: { distanceM: md.totals.distance, serviceM: md.totals.serviceDistance, deadheadM: md.totals.deadheadDistance, repeatM: 0 },
    checks: md.validation.checks,
    timingsMs: { total: md.timingsMs.total, partition: md.timingsMs.partition, plans: md.timingsMs.plans },
    fleet: {
      guarantee: md.guarantee,
      totals: fleetTotals,
      lowerBounds: { totalDistance: md.lowerBounds.totalDistance, vehiclesByCapacity: null, vehiclesByShift: null, tripsByCapacity: null, makespanSeconds: md.lowerBounds.makespanSeconds, minimumTotalSeconds: 0 },
      gaps: md.gaps,
      feasibility: md.feasibility,
      validationOk: md.validation.ok,
      checks: [...md.validation.checks, ...plans.flatMap((p) => p.validation.checks)],
      timingsMs: { coverage: 0, table: 0, split: 0, localSearch: 0, expand: 0, verify: 0, total: md.timingsMs.total },
    },
    turns: fleetTurns(md.turns, zg.graph, md.routes.map((r) => r.steps)),
    routes: md.routes.map((r) => toVehicleRoute(c, nodeOfVertex, r.vehicle, r.steps, { depotNode: nodeOfDepot.get(r.depotId)!, dumpAfterStep: r.dumpAfterStep, seconds: r.seconds, trips: r.tripLoads.length || 1, feasible: r.feasible })),
  };
}

const post = (msg: CoverageResponse, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<CoverageRequest>) => {
  const req = ev.data;
  try {
    if (req.op === 'init') {
      const res = await fetch(req.url);
      if (!res.ok) throw new Error(`City data unavailable (HTTP ${res.status}).`);
      city = decodeCityBundle(await res.json());
      rules = cityTurnOptions(city, 'truck');
      restrictionCount = city.restrictions.length;
      post({ id: req.id, ok: true, op: 'init' });
      return;
    }
    if (!city) throw new Error('Coverage worker not initialised.');
    const result = plan(req);
    post({ id: req.id, ok: true, op: 'plan', result }, result.routes.flatMap((r) => [r.arcs.buffer, r.kinds.buffer, r.lengths.buffer]));
  } catch (e) {
    post({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
