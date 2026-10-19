/// <reference lib="webworker" />
import { decodeCityBundle, planFleet, solveZoneCoverage, zoneCoverageGraph, type CheckResult, type CityModel, type CoverageResult, type FleetPlan, type RouteStep, type Zone, type ZoneReport } from '@sweep/engine';
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
  | { id: number; op: 'plan'; zone: Zone; roadClasses: string[] | null; direction: 'undirected' | 'directed'; scenario: ScenarioSpec; depotNode: number; dumpNode: number | null; fleet: FleetSettings };

/** A vehicle route as arcs (segment × 2 + direction) with the kind and length of every step. */
export interface VehicleRoute {
  vehicle: number;
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
  method: CoverageResult['method'];
  optimal: boolean;
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
}

export type CoverageResponse = { id: number; ok: true; op: 'init' } | { id: number; ok: true; op: 'plan'; result: CoveragePlanResult } | { id: number; ok: false; error: string };

let city: CityModel | null = null;

const KIND = { service: 0, repeat: 1, deadhead: 2 } as const;

function toVehicleRoute(c: CityModel, nodeOfVertex: Map<string, number>, vehicle: number, steps: RouteStep[], extra: { dumpAfterStep: number[]; seconds: number; trips: number; feasible: { capacity: boolean; shift: boolean } }): VehicleRoute {
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

  const cov = solveZoneCoverage(zg.graph, { direction: req.direction, depotId });
  if (!cov.ok) throw new Error(cov.message);
  const f = req.fleet;
  const needsFleet = f.vehicles > 1 || f.capacity !== null || f.shiftSeconds !== null || dumpId !== null;
  const base: Omit<CoveragePlanResult, 'fleet' | 'routes'> = {
    report: zg.report,
    direction: cov.direction,
    method: cov.method,
    optimal: cov.optimal,
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
    return { ...base, fleet: null, routes: [toVehicleRoute(c, nodeOfVertex, 0, cov.route.steps, { dumpAfterStep: [], seconds, trips: 1, feasible: { capacity: true, shift: true } })] };
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
  });
  if (!fp.ok) throw new Error(fp.message);
  return {
    ...base,
    fleet: { guarantee: fp.guarantee, totals: fp.totals, lowerBounds: fp.lowerBounds, gaps: fp.gaps, feasibility: fp.feasibility, validationOk: fp.validation.ok, checks: fp.validation.checks, timingsMs: fp.timingsMs },
    routes: fp.routes.map((r) => toVehicleRoute(c, nodeOfVertex, r.vehicle, r.steps, { dumpAfterStep: r.dumpAfterStep, seconds: r.seconds, trips: r.tripLoads.length || 1, feasible: r.feasible })),
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
