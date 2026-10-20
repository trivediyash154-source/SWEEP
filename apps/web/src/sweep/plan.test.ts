import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRIVABLE_ROAD_CLASSES, localProjection, orderCoverageForTurns, osmToGraph, planFleet, PROFILE_SPECS, solveZoneCoverage } from '@sweep/engine';
import { edgeGeometries, graphUnprojection, nearestVertex, planSweep, positionAt, planToCsv, planToGpx, pointInRing, ringAreaKm2, ringSelfIntersects, zoneGraph, zoneRing, DEFAULT_SWEEP_SETTINGS, type SweepPlan, type Zone } from './plan';

// A real Overpass API response cached by the Pune acquisition (tile t2_3, 18.457–18.463 N, 73.868–73.874 E).
const TILE = join(__dirname, '..', '..', '..', '..', 'data', 'cache', 'osm', 'pune-bibwewadi', 'tiles', 't2_3_streets.json');
const classes = [...DRIVABLE_ROAD_CLASSES, 'trunk', 'trunk_link'];
const graph = osmToGraph(JSON.parse(readFileSync(TILE, 'utf8')), { roadClasses: classes }).graph;
const zone: Zone = { kind: 'rect', bbox: [18.4585, 73.8695, 18.4615, 73.8725] };
const centre: [number, number] = [73.871, 18.46];
const TURNS = { penalties: PROFILE_SPECS.truck.turns!, banned: null };

describe('zone geometry', () => {
  it('area, containment and self-crossing', () => {
    const sq = zoneRing({ kind: 'rect', bbox: [0, 0, 0.01, 0.01] });
    // 0.01° × 0.01° at the equator ≈ 1.1119 km × 1.1119 km.
    expect(ringAreaKm2(sq)).toBeCloseTo(1.2364, 3);
    expect(pointInRing(0.005, 0.005, sq)).toBe(true);
    expect(pointInRing(0.02, 0.005, sq)).toBe(false);
    expect(ringSelfIntersects(sq)).toBe(false);
    expect(ringSelfIntersects([[0, 0], [1, 1], [1, 0], [0, 1]])).toBe(true); // a bow tie
  });

  it('recovers the graph projection exactly enough to draw it', () => {
    const un = graphUnprojection(graph);
    let worst = 0;
    for (const v of graph.vertices) {
      const [lng, lat] = un([v.x, v.y]);
      worst = Math.max(worst, Math.abs(lng - v.geo![0]), Math.abs(lat - v.geo![1]));
    }
    expect(worst).toBeLessThan(2e-7); // x/y are stored to 1 cm, about 1e-7 degrees
    // Shapes too: re-projecting the recovered shape points gives the stored metres back.
    const geoms = edgeGeometries(graph);
    const v0 = graph.vertices[0]!;
    const ky = (Math.PI / 180) * 6_371_008.8;
    const lat0 = v0.geo![1] + v0.y / ky;
    const lon0 = v0.geo![0] - v0.x / (ky * Math.cos((lat0 * Math.PI) / 180));
    const project = localProjection(lon0, lat0);
    const e = graph.edges.find((x) => (x.shape?.length ?? 0) > 1)!;
    const back = geoms.get(e.id)!.slice(1, -1).map((p) => project(p));
    back.forEach((p, i) => {
      expect(Math.abs(p[0] - e.shape![i]![0])).toBeLessThan(0.02);
      expect(Math.abs(p[1] - e.shape![i]![1])).toBeLessThan(0.02);
    });
  });
});

describe.each(['directed', 'undirected'] as const)('sweep plan on real Pune streets (%s)', (direction) => {
  const zg = zoneGraph(graph, zone);
  const depotId = nearestVertex(graph, centre[0], centre[1])!;

  it('one vehicle: exactly the engine route, turn-ordered, with its bound and checks', () => {
    const res = planSweep(graph, zone, centre, { ...DEFAULT_SWEEP_SETTINGS, direction });
    expect(res.ok).toBe(true);
    const plan = res as SweepPlan;
    const cov = solveZoneCoverage(zg.graph, { direction, depotId });
    if (!cov.ok) throw new Error(cov.message);
    const turned = orderCoverageForTurns(cov, TURNS);
    expect(zg.requiredSegments).toBeGreaterThan(10);
    expect(plan.required.segments).toBe(zg.requiredSegments);
    expect(plan.method).toBe(cov.method);
    expect(plan.optimal).toBe(cov.optimal);
    expect(plan.totals.distanceM).toBeCloseTo(cov.route.totalDistance, 6);
    expect(plan.totals.serviceM).toBeCloseTo(cov.route.serviceDistance, 6);
    expect(plan.lowerBound.distanceM).toBe(cov.lowerBound?.value ?? null);
    expect(plan.lowerBound.gap).toBe(cov.gap);
    expect(plan.turns!.after).toEqual(turned.turns.after);
    for (const c of plan.checks) expect(c.passed, `${c.id}: ${c.detail}`).toBe(true);
    // The drawn route is one continuous line from the depot back to the depot.
    const r = plan.routes[0]!;
    expect(r.coords[0]).toEqual(plan.depot);
    expect(r.coords[r.coords.length - 1]).toEqual(plan.depot);
    expect(r.steps.length).toBe(turned.route.steps.length);
    // Its time is the route timed at the two speeds.
    expect(r.seconds).toBeCloseTo(cov.route.serviceDistance / (8 / 3.6) + (cov.route.totalDistance - cov.route.serviceDistance) / (20 / 3.6), 6);
  });

  it('three vehicles: exactly the engine fleet plan and its bounds', () => {
    const res = planSweep(graph, zone, centre, { ...DEFAULT_SWEEP_SETTINGS, direction, vehicles: 3 });
    expect(res.ok).toBe(true);
    const plan = res as SweepPlan;
    const cov = solveZoneCoverage(zg.graph, { direction, depotId });
    if (!cov.ok) throw new Error(cov.message);
    const fp = planFleet(cov.graph, { vehicles: 3, depotId, direction, objective: 'min-makespan', shiftSeconds: null, serviceSpeedKmh: 8, deadheadSpeedKmh: 20, coverage: cov, turns: TURNS });
    if (!fp.ok) throw new Error(fp.message);
    expect(plan.totals.distanceM).toBeCloseTo(fp.totals.distance, 6);
    expect(plan.totals.makespanSeconds).toBeCloseTo(fp.totals.makespanSeconds, 6);
    expect(plan.fleetBounds!.distanceM).toBe(fp.lowerBounds.totalDistance.value);
    expect(plan.fleetBounds!.makespanSeconds).toBe(fp.lowerBounds.makespanSeconds.value);
    expect(plan.fleetBounds!.makespanSeconds).toBeLessThanOrEqual(plan.totals.makespanSeconds + 1e-6);
    expect(plan.routes.length).toBe(fp.routes.length);
    for (const c of plan.checks) expect(c.passed, `${c.id}: ${c.detail}`).toBe(true);
    const gpx = planToGpx(plan, 'test');
    expect(gpx.match(/<trk>/g)).toHaveLength(plan.routes.length);
    expect(planToCsv(plan).trim().split('\r\n')).toHaveLength(1 + plan.routes.reduce((a, r) => a + r.steps.length, 0));
  });
});

describe('shift playback', () => {
  it('starts and ends at the depot, progresses monotonically, and takes exactly the planned time', () => {
    const plan = planSweep(graph, zone, centre, { ...DEFAULT_SWEEP_SETTINGS, vehicles: 2 }) as SweepPlan;
    for (const r of plan.routes) {
      expect(r.stepStart).toHaveLength(r.steps.length);
      expect(positionAt(r, 0, 8, 20).at).toEqual(plan.depot);
      let last = -1;
      for (let k = 0; k <= 20; k++) {
        const p = positionAt(r, (r.seconds * k) / 20, 8, 20);
        expect(p.doneM).toBeGreaterThanOrEqual(last - 1e-9);
        last = p.doneM;
      }
      const end = positionAt(r, r.seconds + 1, 8, 20);
      expect(end.finished).toBe(true);
      expect(end.at).toEqual(plan.depot);
      expect(end.doneM).toBeCloseTo(r.distanceM, 6);
      expect(positionAt(r, r.seconds - 1, 8, 20).finished).toBe(false);
    }
  });
});

describe('sweep plan refusals', () => {
  it('a zone with no street midpoint inside is refused with a clear message', () => {
    const res = planSweep(graph, { kind: 'rect', bbox: [10, 10, 10.001, 10.001] }, centre, DEFAULT_SWEEP_SETTINGS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/No downloaded street/);
  });
});
