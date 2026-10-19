import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCityBundle, decodeCityBundle, type CityModel, type OsmElement } from '../src/city/index.js';
import type { Graph } from '../src/types.js';
import { nearestNode, zoneCoverageGraph } from '../src/coverage/zone.js';
import { solveZoneCoverage, type CoverageResult } from '../src/coverage/solveCoverage.js';
import { planFleet, verifyFleetPlan, type FleetPlan, type FleetPlanOptions } from '../src/coverage/carp.js';
import { planMultiDepotFleet } from '../src/coverage/multidepot.js';
import { cityTurnOptions } from '../src/coverage/turns.js';
import { mulberry32 } from '../src/examples/index.js';

// ---- fixture (synthetic test data, never presented as map data) ----------------
// An n × n grid; row 0 is a tertiary road (the priority streets), every other street is residential.
const lat0 = 18.46;
const lon0 = 73.86;
const step = 0.001;
function gridCity(n: number): CityModel {
  const els: OsmElement[] = [];
  const id = (i: number, j: number): number => 1 + i * n + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) els.push({ type: 'node', id: id(i, j), lat: lat0 + i * step, lon: lon0 + j * step });
  let w = 100;
  for (let i = 0; i < n; i++) els.push({ type: 'way', id: w++, nodes: Array.from({ length: n }, (_, j) => id(i, j)), tags: { highway: i === 0 ? 'tertiary' : 'residential' } });
  for (let j = 0; j < n; j++) els.push({ type: 'way', id: w++, nodes: Array.from({ length: n }, (_, i) => id(i, j)), tags: { highway: 'residential' } });
  const { bundle } = buildCityBundle({
    id: 'grid',
    name: 'Test grid',
    description: 'synthetic test fixture',
    bbox: [lat0 - step / 2, lon0 - step / 2, lat0 + (n - 0.5) * step, lon0 + (n - 0.5) * step],
    roadClasses: ['residential', 'tertiary'],
    streets: els,
    buildings: [],
    provenance: { endpoints: [], osmBase: ['x', 'x'], fetched: ['x', 'x'], tiles: { total: 1, ok: 1, missing: [] }, queries: { streets: '', buildings: '' } },
  });
  return decodeCityBundle(bundle);
}

const everything = { kind: 'rect' as const, minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
const N = 6;
const city = gridCity(N);
const depotId = `n${N * N}`; // the corner farthest from the tertiary row
const speeds = { serviceSpeedKmh: 8, deadheadSpeedKmh: 25 } as const;

function setup(direction: 'undirected' | 'directed'): { graph: Graph; cov: CoverageResult; pri: string[] } {
  const graph = zoneCoverageGraph(city, { zone: everything, direction }).graph;
  const cov = solveZoneCoverage(graph, { direction, depotId }) as CoverageResult;
  return { graph, cov, pri: graph.edges.filter((e) => e.roadClass === 'tertiary').map((e) => e.id) };
}

/** Properties every plan with a priority deadline must have, whatever the heuristic finds. */
function priorityInvariants(p: FleetPlan, k: number): void {
  const pr = p.priority!;
  expect(p.validation.checks.find((c) => c.id === 'coverage')!.passed).toBe(true);
  expect(p.validation.checks.find((c) => c.id === 'routes-valid')!.passed).toBe(true);
  const check = p.validation.checks.find((c) => c.id === 'priority-deadline')!;
  // The independent check, recomputed from the steps, agrees with the plan's own verdict.
  expect(check.passed).toBe(pr.met);
  for (const r of p.routes) if (r.priorityFinishSeconds !== null) expect(r.priorityFinishSeconds).toBeLessThanOrEqual(r.seconds + 1e-6);
  expect(pr.finishSeconds).toBe(p.routes.reduce((x, r) => Math.max(x, r.priorityFinishSeconds ?? 0), 0));
  expect(pr.lateVehicles).toEqual(p.routes.filter((r) => (r.priorityFinishSeconds ?? -1) > pr.deadlineSeconds + 1e-6).map((r) => r.vehicle));
  if (p.routes.length <= k) {
    // The bounds hold for any plan with at most k vehicles, so also for this one.
    if (pr.obligations > 0) expect(pr.finishSeconds).toBeGreaterThanOrEqual(pr.lowerBounds.finishSeconds - 1e-6);
    if (pr.met) {
      expect(pr.provenInfeasible).toBe(false);
      expect(pr.lowerBounds.vehicles).not.toBeNull();
      expect(pr.lowerBounds.vehicles!).toBeLessThanOrEqual(p.routes.filter((r) => r.priorityFinishSeconds !== null).length);
    }
  }
  if (p.feasibility.ok) expect(pr.met).toBe(true);
}

describe('priority deadline (streets that must be serviced by a given time)', () => {
  it('meets a deadline that the coverage order misses, by servicing the priority streets first', () => {
    const { graph, cov, pri } = setup('undirected');
    const base: FleetPlanOptions = { ...speeds, vehicles: 2, depotId, direction: 'undirected', objective: 'min-makespan', coverage: cov };
    const loose = planFleet(graph, { ...base, priority: { edgeIds: pri, deadlineSeconds: 1e7 } }) as FleetPlan;
    expect(loose.ok).toBe(true);
    expect(loose.priority!.tour).toBe('coverage-order');
    const deadline = 10 * 60;
    expect(loose.priority!.finishSeconds).toBeGreaterThan(deadline);
    const p = planFleet(graph, { ...base, priority: { edgeIds: pri, deadlineSeconds: deadline } }) as FleetPlan;
    expect(p.ok).toBe(true);
    expect(p.priority!.met).toBe(true);
    expect(p.priority!.finishSeconds).toBeLessThanOrEqual(deadline);
    expect(p.priority!.tour).toBe('priority-first');
    expect(p.priority!.obligations).toBe(pri.length);
    expect(p.validation.ok).toBe(true);
    expect(p.feasibility.ok).toBe(true);
    expect(p.routes.length).toBeLessThanOrEqual(2);
    priorityInvariants(p, 2);
  });

  it('proves when no plan with the available vehicles can meet the deadline, and says how many it took', () => {
    const { graph, cov, pri } = setup('undirected');
    const p = planFleet(graph, { ...speeds, vehicles: 1, depotId, direction: 'undirected', objective: 'min-makespan', coverage: cov, priority: { edgeIds: pri, deadlineSeconds: 5 * 60 } }) as FleetPlan;
    expect(p.ok).toBe(true);
    const pr = p.priority!;
    expect(pr.provenInfeasible).toBe(true);
    expect(pr.lowerBounds.finishSeconds > 5 * 60 || (pr.lowerBounds.vehicles ?? Infinity) > 1).toBe(true);
    expect(p.feasibility.ok).toBe(false);
    expect(p.feasibility.issues.join(' ')).toMatch(/can service every priority street by the deadline/);
    // The over-fleet diagnosis: the plan shown needs more vehicles than are available.
    expect(p.routes.length).toBeGreaterThan(1);
    priorityInvariants(p, 1);
  });

  it('keeps every property on random priority sets, deadlines, fleets and directions', () => {
    for (let seed = 1; seed <= 24; seed++) {
      const rnd = mulberry32(seed);
      const direction = rnd() < 0.5 ? 'undirected' : 'directed';
      const { graph, cov } = setup(direction);
      const req = graph.edges.filter((e) => e.required);
      const pri = req.filter(() => rnd() < 0.25).map((e) => e.id);
      if (pri.length === 0) continue;
      const k = 1 + Math.floor(rnd() * 3);
      const objective = rnd() < 0.5 ? 'min-makespan' : 'min-total';
      const deadline = (2 + rnd() * 40) * 60;
      const p = planFleet(graph, { ...speeds, vehicles: k, depotId, direction, objective, coverage: cov, priority: { edgeIds: pri, deadlineSeconds: deadline } });
      expect(p.ok, `seed ${seed}`).toBe(true);
      priorityInvariants(p as FleetPlan, k);
    }
  });

  it('recomputes priority finish times from the steps, independently of the planner', () => {
    const { graph, cov, pri } = setup('directed');
    const deadline = 15 * 60;
    const p = planFleet(graph, { ...speeds, vehicles: 2, depotId, direction: 'directed', objective: 'min-makespan', coverage: cov, priority: { edgeIds: pri, deadlineSeconds: deadline } }) as FleetPlan;
    expect(p.priority!.met).toBe(true);
    const opts = { depotId, dumpId: null, directed: true, capacity: Infinity, shiftSeconds: Infinity, ...speeds, dumpSeconds: 0, demandPerKm: 0 };
    const ok = verifyFleetPlan(p.coverage.graph, p.routes, { ...opts, priority: { edgeIds: pri, deadlineSeconds: deadline } });
    expect(ok.checks.find((c) => c.id === 'priority-deadline')!.passed).toBe(true);
    // An earlier deadline than the plan achieves is caught.
    const tight = verifyFleetPlan(p.coverage.graph, p.routes, { ...opts, priority: { edgeIds: pri, deadlineSeconds: p.priority!.finishSeconds - 1 } });
    expect(tight.checks.find((c) => c.id === 'priority-deadline')!.passed).toBe(false);
    // A reported finish time that does not match the steps is caught.
    const tampered = p.routes.map((r, i) => (i === 0 && r.priorityFinishSeconds !== null ? { ...r, priorityFinishSeconds: r.priorityFinishSeconds - 30 } : r));
    expect(verifyFleetPlan(p.coverage.graph, tampered, { ...opts, priority: { edgeIds: pri, deadlineSeconds: deadline } }).checks.find((c) => c.id === 'priority-deadline')!.passed).toBe(false);
  });

  it('a turn-aware order never services a priority street after a deadline the planned order met', () => {
    const rules = cityTurnOptions(city, 'truck');
    for (const direction of ['undirected', 'directed'] as const) {
      const { graph, cov, pri } = setup(direction);
      for (const minutes of [8, 10, 12, 20]) {
        const p = planFleet(graph, { ...speeds, vehicles: 2, depotId, direction, objective: 'min-makespan', coverage: cov, turns: rules, priority: { edgeIds: pri, deadlineSeconds: minutes * 60 } }) as FleetPlan;
        const plain = planFleet(graph, { ...speeds, vehicles: 2, depotId, direction, objective: 'min-makespan', coverage: cov, priority: { edgeIds: pri, deadlineSeconds: minutes * 60 } }) as FleetPlan;
        if (plain.priority!.met) expect(p.priority!.met, `${direction}, ${minutes} min`).toBe(true);
        expect(p.turns!.reorderedRoutes + p.turns!.keptForDeadline).toBeLessThanOrEqual(p.routes.length);
        priorityInvariants(p, 2);
      }
    }
  });

  it('handles a deadline with no priority street in the zone, and refuses bad input', () => {
    const { graph, cov } = setup('undirected');
    const base: FleetPlanOptions = { ...speeds, vehicles: 2, depotId, direction: 'undirected', objective: 'min-makespan', coverage: cov };
    const none = planFleet(graph, { ...base, priority: { edgeIds: [], deadlineSeconds: 600 } }) as FleetPlan;
    expect(none.priority).toMatchObject({ obligations: 0, met: true, finishSeconds: 0, provenInfeasible: false });
    expect(none.routes.every((r) => r.priorityFinishSeconds === null)).toBe(true);
    const without = planFleet(graph, base) as FleetPlan;
    expect(without.priority).toBeNull();
    expect(none.totals).toEqual(without.totals);
    expect(planFleet(graph, { ...base, priority: { edgeIds: ['x'], deadlineSeconds: 0 } }).ok).toBe(false);
    const multi = planMultiDepotFleet(graph, { ...speeds, direction: 'undirected', objective: 'min-makespan', depots: [{ depotId, vehicles: 2 }], priority: { edgeIds: [], deadlineSeconds: 600 } });
    expect(multi.ok).toBe(false);
  });
});

const BUNDLED = join(__dirname, '..', '..', '..', 'apps', 'web', 'public', 'cities', 'pune-bibwewadi.json');

describe.skipIf(!existsSync(BUNDLED))('priority deadline on the real Pune network', () => {
  const pune: CityModel = decodeCityBundle(JSON.parse(readFileSync(BUNDLED, 'utf8')));
  const c = pune.focus!.xy;
  const zone = { kind: 'circle' as const, cx: c[0], cy: c[1], r: 600 };
  const depot = `n${pune.nodeOsm[nearestNode(pune, c[0], c[1])]}`;
  const MAIN = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);

  it('main roads first: every property holds, with and without turn-aware order', () => {
    const zg = zoneCoverageGraph(pune, { zone, direction: 'directed', depotId: depot });
    const cov = solveZoneCoverage(zg.graph, { direction: 'directed', depotId: depot }) as CoverageResult;
    expect(cov.ok).toBe(true);
    const pri = cov.graph.edges.filter((e) => e.required && MAIN.has(e.roadClass ?? '')).map((e) => e.id);
    expect(pri.length).toBeGreaterThan(0);
    for (const turns of [null, cityTurnOptions(pune, 'truck')]) {
      const p = planFleet(cov.graph, { ...speeds, vehicles: 3, depotId: depot, direction: 'directed', objective: 'min-makespan', coverage: cov, turns, priority: { edgeIds: pri, deadlineSeconds: 45 * 60 } });
      expect(p.ok).toBe(true);
      const fp = p as FleetPlan;
      expect(fp.priority!.obligations).toBeGreaterThan(0);
      priorityInvariants(fp, 3);
      expect(fp.validation.checks.find((x) => x.id === 'limits')!.passed).toBe(true);
    }
  }, 120_000);
});
