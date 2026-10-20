import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCityBundle, decodeCityBundle, type CityModel, type OsmElement } from '../src/city/index.js';
import type { Graph } from '../src/types.js';
import { exhaustiveOptimalTotal } from '../src/exhaustive.js';
import { minCostPerfectMatchingComplete as minCostPerfectMatchingCompleteForTest } from '../src/matching/blossom.js';
import { buildArcGraph, arcDijkstra } from '../src/coverage/arcs.js';
import { pointInZone, zoneCoverageGraph, nearestNode, segmentMidpoint } from '../src/coverage/zone.js';
import { undirectedLowerBound, directedLowerBound, fractionalMatchingDual, planConnectors } from '../src/coverage/bounds.js';
import { solveZoneCoverage, type CoverageResult } from '../src/coverage/solveCoverage.js';
import { planFleet, type FleetPlan } from '../src/coverage/carp.js';
import { randomGraph } from './helpers.js';

// ---- fixtures (synthetic test data, never presented as map data) ----------------
const lat0 = 18.46;
const lon0 = 73.86;
const step = 0.001;
function gridCity(n = 5, oneway: number[] = []): CityModel {
  const els: OsmElement[] = [];
  const id = (i: number, j: number): number => 1 + i * n + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) els.push({ type: 'node', id: id(i, j), lat: lat0 + i * step, lon: lon0 + j * step });
  let w = 100;
  for (let i = 0; i < n; i++) els.push({ type: 'way', id: w++, nodes: Array.from({ length: n }, (_, j) => id(i, j)), tags: { highway: i === 0 ? 'tertiary' : 'residential', ...(oneway.includes(i) ? { oneway: 'yes' } : {}) } });
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
const passed = (r: { checks: { passed: boolean }[] }): boolean => r.checks.every((c) => c.passed);

describe('service zones', () => {
  it('tests points against rectangles, circles and polygons', () => {
    expect(pointInZone({ kind: 'rect', minX: 0, minY: 0, maxX: 10, maxY: 5 }, 5, 5)).toBe(true);
    expect(pointInZone({ kind: 'rect', minX: 0, minY: 0, maxX: 10, maxY: 5 }, 5, 6)).toBe(false);
    expect(pointInZone({ kind: 'circle', cx: 0, cy: 0, r: 5 }, 3, 4)).toBe(true);
    expect(pointInZone({ kind: 'circle', cx: 0, cy: 0, r: 5 }, 4, 4)).toBe(false);
    const tri = { kind: 'polygon' as const, points: [[0, 0], [10, 0], [0, 10]] as [number, number][] };
    expect(pointInZone(tri, 2, 2)).toBe(true);
    expect(pointInZone(tri, 8, 8)).toBe(false);
  });

  it('marks zone segments required and keeps the rest of the network as deadhead streets', () => {
    const city = gridCity(5);
    // Left half of the grid (x < 0 relative to the centre).
    const zone = { kind: 'rect' as const, minX: -1e6, maxX: -1, minY: -1e6, maxY: 1e6 };
    const z = zoneCoverageGraph(city, { zone, direction: 'undirected' });
    expect(z.graph.edges).toHaveLength(city.segCount);
    for (const e of z.graph.edges) {
      const s = Number(e.id.slice(1));
      const [mx] = segmentMidpoint(city, s);
      expect(e.required).toBe(mx <= -1);
      expect(e.sourceRef).toMatch(/^osm:way\/\d+$/);
      expect(z.edgeSegment[z.graph.edges.indexOf(e)]).toBe(s);
    }
    expect(z.report.requiredSegments).toBeGreaterThan(0);
    expect(z.report.optionalSegments).toBeGreaterThan(0);
    expect(z.report.requiredKm + z.report.optionalKm).toBeCloseTo(city.stats.roadLengthKm, 1);
  });

  it('applies road-class filters, closures and one-way overrides', () => {
    const city = gridCity(5);
    const onlyTertiary = zoneCoverageGraph(city, { zone: everything, direction: 'undirected', roadClasses: ['tertiary'] });
    expect(onlyTertiary.graph.edges.filter((e) => e.required).every((e) => e.roadClass === 'tertiary')).toBe(true);
    const closed = zoneCoverageGraph(city, { zone: everything, direction: 'directed', closedSegments: [0, 1] });
    expect(closed.graph.edges.map((e) => e.id)).not.toContain('s0');
    expect(closed.report.closedSegments).toBe(2);
    const rev = zoneCoverageGraph(city, { zone: everything, direction: 'directed', onewayOverrides: new Map([[3, 'reverse' as const]]) });
    const e3 = rev.graph.edges.find((e) => e.id === 's3')!;
    expect(e3.oneway).toBe(true);
    expect(e3.u).toBe(`n${city.nodeOsm[city.segV[3]!]}`);
    expect(e3.v).toBe(`n${city.nodeOsm[city.segU[3]!]}`);
  });

  it('reports required segments cut off from the network by closures', () => {
    const city = gridCity(3);
    // Isolate one segment: close every other segment touching either of its end nodes.
    const target = 0;
    const a = city.segU[target]!;
    const b = city.segV[target]!;
    const closures: number[] = [];
    for (let s = 0; s < city.segCount; s++) if (s !== target && [a, b].some((x) => city.segU[s] === x || city.segV[s] === x)) closures.push(s);
    const cut = zoneCoverageGraph(city, { zone: everything, direction: 'undirected', closedSegments: closures });
    expect(cut.report.cutOffSegments).toEqual([target]);
    expect(cut.graph.edges.map((e) => e.id)).not.toContain(`s${target}`);
    expect(cut.graph.edges.every((e) => !closures.includes(Number(e.id.slice(1))))).toBe(true);
  });
});

describe('connectors and lower bounds', () => {
  it('connects separated required groups with shortest connector paths', () => {
    const city = gridCity(5);
    const g = zoneCoverageGraph(city, { zone: everything, direction: 'undirected' }).graph;
    // Keep two far-apart corner streets required.
    const keep = new Set([g.edges[0]!.id, g.edges[g.edges.length - 1]!.id]);
    const two: Graph = { ...g, edges: g.edges.map((e) => ({ ...e, required: keep.has(e.id) })) };
    const ag = buildArcGraph(two, false);
    const depot = ag.vertexIndex.get(two.edges[0]!.u)!;
    const plan = planConnectors(two, ag, depot);
    expect(plan.components).toBe(2);
    expect(plan.arcs).toHaveLength(1);
    expect(plan.distance).toBeGreaterThan(0);
  });

  it('the fractional-matching dual is feasible for every pair and never exceeds the exact matching', () => {
    let checked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const g = randomGraph(seed * 31 + 7, { maxN: 12, maxM: 26, optionalProb: 0.2 });
      const ag = buildArcGraph(g, false);
      const deg = new Int32Array(ag.n);
      g.edges.forEach((e, k) => {
        if (!e.required) return;
        const a = ag.fwdArc[k]!;
        deg[ag.arcTail[a]!]!++;
        deg[ag.arcHead[a]!]!++;
      });
      const T: number[] = [];
      for (let v = 0; v < ag.n; v++) if (deg[v]! % 2 === 1) T.push(v);
      if (T.length < 4) continue;
      const D = T.map((s) => arcDijkstra(ag, [s]).dist);
      if (D.some((row) => T.some((v) => !Number.isFinite(row[v]!)))) continue;
      for (const K of [1, 2, 5]) {
        const dual = fractionalMatchingDual(ag, T, K);
        for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) expect(dual.y[i]! + dual.y[j]!).toBeLessThanOrEqual(D[i]![T[j]!]! + 1e-6);
        const exact = minCostPerfectMatchingCompleteForTest(T.length, (i, j) => D[i]![T[j]!]!).total;
        expect(dual.value).toBeLessThanOrEqual(exact + 1e-6);
        expect(dual.value).toBeGreaterThanOrEqual(dual.start - 1e-6);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

/** Random connected instance where the depot lies on a required street. */
function instance(seed: number): { g: Graph; depotId: string } | null {
  const g = randomGraph(seed, { maxN: 9, maxM: 12, optionalProb: 0.3 });
  if (!g.edges.some((e) => e.required)) return null;
  const ag = buildArcGraph(g, false);
  const firstReq = g.edges.find((e) => e.required)!;
  const t = arcDijkstra(ag, [ag.vertexIndex.get(firstReq.u)!]);
  for (const e of g.edges) if (e.required && (!Number.isFinite(t.dist[ag.vertexIndex.get(e.u)!]!) || !Number.isFinite(t.dist[ag.vertexIndex.get(e.v)!]!))) return null;
  return { g, depotId: firstReq.u };
}

describe('coverage solver (undirected)', () => {
  it('exact ≥ lower bound, heuristic ≥ exact, and the bound never exceeds the true (rural postman) optimum', () => {
    let compared = 0;
    let withConnectors = 0;
    for (let seed = 1; compared < 120 && seed < 2000; seed++) {
      const inst = instance(seed * 7919);
      if (!inst) continue;
      const ex = solveZoneCoverage(inst.g, { direction: 'undirected', depotId: inst.depotId });
      const he = solveZoneCoverage(inst.g, { direction: 'undirected', depotId: inst.depotId, forceHeuristic: true });
      if (!ex.ok || !he.ok) continue;
      expect(passed(ex)).toBe(true);
      expect(passed(he)).toBe(true);
      expect(he.optimal).toBe(false);
      expect(he.route.totalDistance).toBeGreaterThanOrEqual(ex.route.totalDistance - 1e-6);
      expect(ex.route.totalDistance).toBeGreaterThanOrEqual(ex.lowerBound!.value - 1e-6);
      const lbExact = undirectedLowerBound(ex.graph, 600);
      const lbDual = undirectedLowerBound(ex.graph, 0);
      expect(lbDual.value).toBeLessThanOrEqual(lbExact.value + 1e-6);
      if (inst.g.edges.length <= 10) {
        const truth = exhaustiveOptimalTotal(ex.graph, 2);
        if (truth) {
          expect(lbExact.value).toBeLessThanOrEqual(truth.total + 1e-6);
          expect(ex.route.totalDistance).toBeGreaterThanOrEqual(truth.total - 1e-6);
          if (ex.optimal) expect(ex.route.totalDistance).toBeCloseTo(truth.total, 6);
        }
      }
      if (ex.connectors.paths > 0) {
        withConnectors++;
        expect(ex.optimal).toBe(false);
      }
      compared++;
    }
    expect(compared).toBe(120);
    expect(withConnectors).toBeGreaterThan(5);
  });

  it('uses the exact solver when no connector is needed and calls it optimal', () => {
    const city = gridCity(5);
    const z = zoneCoverageGraph(city, { zone: everything, direction: 'undirected' });
    const r = solveZoneCoverage(z.graph, { direction: 'undirected', depotId: z.graph.vertices[0]!.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe('exact-undirected-edmonds-johnson');
    expect(r.optimal).toBe(true);
    expect(r.gap).toBe(0);
    expect(passed(r)).toBe(true);
  });
});

describe('coverage solver (directed)', () => {
  it('obeys one-way streets, services both directions of two-way streets, and matches its flow bound', () => {
    const city = gridCity(5, [1, 3]);
    const z = zoneCoverageGraph(city, { zone: everything, direction: 'directed' });
    const r = solveZoneCoverage(z.graph, { direction: 'directed', depotId: z.graph.vertices[0]!.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(passed(r)).toBe(true);
    const edges = new Map(r.graph.edges.map((e) => [e.id, e]));
    for (const s of r.route.steps) {
      const e = edges.get(s.edgeId)!;
      if (e.oneway) expect([s.from, s.to]).toEqual([e.u, e.v]);
    }
    const lb = directedLowerBound(r.graph)!;
    expect(r.route.totalDistance).toBeGreaterThanOrEqual(lb.value - 1e-6);
    if (r.optimal) expect(r.route.totalDistance).toBeCloseTo(lb.value, 6);
  });

  it('excludes and lists required one-way streets that no closed route from the depot can service', () => {
    const city = gridCity(3, [0]);
    const z = zoneCoverageGraph(city, { zone: everything, direction: 'directed' });
    // Make the whole bottom row one-way towards a dead end by closing its return streets is overkill;
    // reverse one street so a one-way corner cannot be left legally.
    const corner = z.graph.vertices[0]!.id;
    const g: Graph = {
      ...z.graph,
      edges: z.graph.edges.map((e) => (e.u === corner || e.v === corner ? { ...e, oneway: true, ...(e.v === corner ? {} : { u: e.v, v: e.u }) } : e)),
    };
    const r = solveZoneCoverage(g, { direction: 'directed', depotId: g.vertices[4]!.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.excluded.unserviceable.length).toBeGreaterThan(0);
    expect(r.excluded.reason).toMatch(/one-way/);
    expect(passed(r)).toBe(true);
  });
});

function fleetBasics(p: FleetPlan, k: number): void {
  expect(p.validation.ok).toBe(true);
  expect(p.validation.checks.find((c) => c.id === 'coverage')!.passed).toBe(true);
  expect(p.totals.distance).toBeGreaterThanOrEqual(p.lowerBounds.totalDistance.value - 1e-6);
  if (p.routes.length <= k) expect(p.totals.makespanSeconds).toBeGreaterThanOrEqual(p.lowerBounds.makespanSeconds.value - 1e-6);
  const key = (x: { distance: number; makespanSeconds: number }): [number, number] => (p.objective === 'min-makespan' ? [x.makespanSeconds, x.distance] : [x.distance, x.makespanSeconds]);
  const [a0, b0] = key(p.localSearch.before);
  const [a1, b1] = key(p.localSearch.after);
  expect(a1 < a0 - 1e-9 || (Math.abs(a1 - a0) <= 1e-6 && b1 <= b0 + 1e-6) || a1 <= a0 + 1e-6).toBe(true);
}

describe('multi-vehicle coverage (fleet planning)', () => {
  const city = gridCity(6, [2]);
  const graph = zoneCoverageGraph(city, { zone: everything, direction: 'undirected' }).graph;
  const depotId = graph.vertices[0]!.id;
  const dumpId = graph.vertices[graph.vertices.length - 1]!.id;
  const base = { depotId, serviceSpeedKmh: 8, deadheadSpeedKmh: 25 } as const;
  const cov = solveZoneCoverage(graph, { direction: 'undirected', depotId }) as CoverageResult;

  it('one vehicle without limits reproduces the single coverage route', () => {
    const p = planFleet(graph, { ...base, vehicles: 1, direction: 'undirected', objective: 'min-total', coverage: cov });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    fleetBasics(p, 1);
    expect(p.routes).toHaveLength(1);
    expect(p.totals.distance).toBeLessThanOrEqual(cov.route.totalDistance + 1e-6);
    expect(p.totals.distance).toBeCloseTo(cov.route.totalDistance, 3);
  });

  it('respects capacity and shift limits on every route and services every street exactly once', () => {
    const p = planFleet(graph, { ...base, vehicles: 6, direction: 'undirected', objective: 'min-total', capacity: 400, demandPerKm: 150, shiftSeconds: 2.5 * 3600, coverage: cov });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    fleetBasics(p, 6);
    expect(p.feasibility.ok).toBe(true);
    for (const r of p.routes) {
      expect(r.tripLoads.every((l) => l <= 400 + 1e-6)).toBe(true);
      expect(r.seconds).toBeLessThanOrEqual(2.5 * 3600 + 1e-6);
    }
    expect(p.routes.length).toBeGreaterThanOrEqual(p.lowerBounds.vehiclesByCapacity ?? 1);
    expect(p.routes.length).toBeGreaterThanOrEqual(p.lowerBounds.vehiclesByShift ?? 1);
  });

  it('balances the longest route for the makespan objective', () => {
    const one = planFleet(graph, { ...base, vehicles: 1, direction: 'undirected', objective: 'min-makespan', coverage: cov });
    const three = planFleet(graph, { ...base, vehicles: 3, direction: 'undirected', objective: 'min-makespan', coverage: cov });
    expect(one.ok && three.ok).toBe(true);
    if (!one.ok || !three.ok) return;
    fleetBasics(three, 3);
    expect(three.totals.makespanSeconds).toBeLessThan(one.totals.makespanSeconds);
    expect(three.gaps.makespan).not.toBeNull();
  });

  it('visits the disposal site mid-route only when capacity binds', () => {
    const loose = planFleet(graph, { ...base, vehicles: 2, direction: 'undirected', objective: 'min-total', capacity: 1e9, demandPerKm: 150, dumpId, dumpSeconds: 600, coverage: cov });
    const tight = planFleet(graph, { ...base, vehicles: 2, direction: 'undirected', objective: 'min-total', capacity: 300, demandPerKm: 150, dumpId, dumpSeconds: 600, coverage: cov });
    expect(loose.ok && tight.ok).toBe(true);
    if (!loose.ok || !tight.ok) return;
    fleetBasics(loose, 2);
    fleetBasics(tight, 2);
    expect(loose.totals.intermediateDumps).toBe(0);
    expect(tight.totals.intermediateDumps).toBeGreaterThan(0);
    for (const r of tight.routes) {
      expect(r.tripLoads.every((l) => l <= 300 + 1e-6)).toBe(true);
      expect(r.dumpAfterStep.length).toBe(r.intermediateDumps + 1);
      for (const i of r.dumpAfterStep) expect(r.steps[i]!.to).toBe(dumpId);
    }
  });

  it('reports infeasible fleets honestly instead of hiding violations', () => {
    const p = planFleet(graph, { ...base, vehicles: 1, direction: 'undirected', objective: 'min-total', shiftSeconds: 1800, coverage: cov });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.feasibility.ok).toBe(false);
    expect(p.feasibility.issues.join(' ')).toMatch(/No plan with 1 vehicle/);
    expect(p.routes.length).toBeGreaterThan(1);
    expect(p.gaps.makespan).toBeNull();
    expect(p.validation.checks.find((c) => c.id === 'coverage')!.passed).toBe(true);
  });

  it('obeys one-way streets in directed fleets', () => {
    const dg = zoneCoverageGraph(city, { zone: everything, direction: 'directed' }).graph;
    const p = planFleet(dg, { ...base, vehicles: 3, direction: 'directed', objective: 'min-makespan', capacity: 500, demandPerKm: 150 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    fleetBasics(p, 3);
    const edges = new Map(dg.edges.map((e) => [e.id, e]));
    for (const r of p.routes) for (const s of r.steps) {
      const e = edges.get(s.edgeId)!;
      if (e.oneway) expect([s.from, s.to]).toEqual([e.u, e.v]);
    }
  });

  it('is deterministic', () => {
    const run = (): unknown => {
      const p = planFleet(graph, { ...base, vehicles: 4, direction: 'undirected', objective: 'min-makespan', capacity: 500, demandPerKm: 150, dumpId, dumpSeconds: 300, coverage: cov });
      return p.ok ? p.routes.map((r) => [r.steps.map((s) => s.edgeId + s.from), r.dumpAfterStep, r.seconds]) : p;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('rejects invalid inputs', () => {
    expect(planFleet(graph, { ...base, vehicles: 0, direction: 'undirected', objective: 'min-total' }).ok).toBe(false);
    expect(planFleet(graph, { ...base, vehicles: 2, direction: 'undirected', objective: 'min-total', capacity: -1 }).ok).toBe(false);
    expect(planFleet(graph, { ...base, vehicles: 2, direction: 'undirected', objective: 'min-total', depotId: 'nope' }).ok).toBe(false);
  });
});

const BUNDLED = join(__dirname, '..', '..', '..', 'apps', 'web', 'public', 'cities', 'pune-bibwewadi.json');
describe.skipIf(!existsSync(BUNDLED))('coverage on the real Pune dataset', () => {
  const city = decodeCityBundle(JSON.parse(readFileSync(BUNDLED, 'utf8')));
  const cx = (city.bounds.minX + city.bounds.maxX) / 2;
  const cy = (city.bounds.minY + city.bounds.maxY) / 2;
  const zone = { kind: 'circle' as const, cx, cy, r: 450 };
  const depotId = `n${city.nodeOsm[nearestNode(city, cx, cy)]}`;

  it('extracts a real zone with traceable OSM segments', () => {
    const z = zoneCoverageGraph(city, { zone, direction: 'directed', depotId });
    expect(z.report.unserviceable).toBeDefined();
    const r = solveZoneCoverage(z.graph, { direction: 'directed', depotId });
    if (r.ok) expect(r.excluded.unserviceable.length).toBe(z.report.unserviceable!.unreachable.length + z.report.unserviceable!.noReturn.length);
    expect(z.report.requiredSegments).toBeGreaterThan(20);
    expect(z.graph.edges.every((e) => /^osm:way\/\d+$/.test(e.sourceRef!))).toBe(true);
    expect(z.graph.vertices.every((v) => v.geo && Math.abs(v.geo[1] - 18.46) < 0.1)).toBe(true);
  });

  it('solves directed coverage of the zone exactly or reports why not, and verifies every arc', () => {
    const z = zoneCoverageGraph(city, { zone, direction: 'directed' });
    const r = solveZoneCoverage(z.graph, { direction: 'directed', depotId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe('exact-directed-min-cost-flow');
    expect(passed(r)).toBe(true);
    expect(r.route.totalDistance).toBeGreaterThanOrEqual(r.lowerBound!.value - 1e-6);
    expect(r.gap).not.toBeNull();
  });

  it('plans a capacitated fleet on the real zone that validates', () => {
    const z = zoneCoverageGraph(city, { zone, direction: 'undirected' });
    const p = planFleet(z.graph, { vehicles: 3, depotId, direction: 'undirected', objective: 'min-makespan', capacity: 1200, demandPerKm: 150, shiftSeconds: 8 * 3600, serviceSpeedKmh: 8, deadheadSpeedKmh: 25 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    fleetBasics(p, 3);
  });
});
