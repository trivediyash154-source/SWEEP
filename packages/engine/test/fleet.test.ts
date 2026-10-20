import { describe, expect, it } from 'vitest';
import type { FleetRecord, Graph, OptimizationFailure } from '../src/index.js';
import { MAX_VEHICLES, shortestCoveringWalk, solveChinesePostman, solveDirectedPostman, solveFleet, solveRouting, verifyFleet } from '../src/index.js';
import { getExample } from '../src/examples/index.js';
import { randomGraph } from './helpers.js';

function fleet(g: Graph, opts: Parameters<typeof solveFleet>[1]): FleetRecord {
  const r = solveFleet(g, opts);
  if (!r.ok) throw new Error(JSON.stringify(r.validation.issues.filter((i) => i.severity === 'error')));
  expect(r.checks.every((c) => c.passed), JSON.stringify(r.checks.filter((c) => !c.passed))).toBe(true);
  for (const route of r.routes) expect(route.checks.every((c) => c.passed)).toBe(true);
  return r;
}

const codes = (r: ReturnType<typeof solveFleet>): string[] => (r as OptimizationFailure).validation.issues.filter((i) => i.severity === 'error').map((i) => i.code);

describe('fleet: tour splitting from one depot', () => {
  const heritage = getExample('heritage-loop')!.graph;
  const meridian = getExample('meridian-district')!.graph;

  it('one vehicle reproduces the certified single-vehicle route exactly', () => {
    const single = solveChinesePostman(heritage);
    if (!single.ok) throw new Error('example should solve');
    const r = fleet(heritage, { vehicles: 1 });
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]!.steps).toEqual(single.route.steps);
    expect(r.makespan).toBe(single.route.totalDistance);
    expect(r.totalDistance).toBe(single.route.totalDistance);
  });

  for (const k of [2, 3, 5]) {
    it(`${k} vehicles cover every required street, with consistent per-vehicle costs and the proven bound`, () => {
      const r = fleet(meridian, { vehicles: k });
      expect(r.activeVehicles).toBeLessThanOrEqual(k);
      expect(r.coverage.covered).toBe(r.coverage.obligations);
      expect(r.coverage.missingEdgeIds).toEqual([]);
      const required = new Set(meridian.edges.filter((e) => e.required).map((e) => e.id));
      const serviced = new Set(r.routes.flatMap((x) => x.servicedEdgeIds));
      expect(serviced).toEqual(required);
      // Each required street is serviced exactly once fleet-wide, so service distances add up to the required length.
      expect(r.routes.reduce((s, x) => s + x.serviceDistance, 0)).toBeCloseTo(r.base.route.requiredDistance, 6);
      for (const route of r.routes) {
        const sum = route.steps.reduce((s, st) => s + st.weight, 0);
        expect(route.distance).toBeCloseTo(sum, 6);
        expect(route.steps[0]!.from).toBe(r.depotId);
        expect(route.steps.at(-1)!.to).toBe(r.depotId);
      }
      expect(r.makespan).toBeCloseTo(Math.max(...r.routes.map((x) => x.distance)), 6);
      expect(r.totalDistance).toBeCloseTo(r.routes.reduce((s, x) => s + x.distance, 0), 6);
      // Splitting never reduces total distance below the single optimal route.
      expect(r.totalDistance).toBeGreaterThanOrEqual(r.singleVehicleDistance - 1e-6);
      expect(r.makespan).toBeLessThan(r.singleVehicleDistance);
      expect(r.algorithm.ratioBound).toBeCloseTo(2 - 1 / k, 9);
      expect(r.gapRatio).toBeLessThanOrEqual(2 - 1 / k + 1e-9);
      expect(r.checks.find((c) => c.id === 'fhk-bound')!.passed).toBe(true);
    });
  }

  it('rejects empty, invalid and excessive fleet sizes', () => {
    for (const k of [0, -1, 1.5, Number.NaN, MAX_VEHICLES + 1]) expect(codes(solveFleet(heritage, { vehicles: k }))).toEqual(['FLEET_INVALID']);
    expect(codes(solveFleet(heritage, { vehicles: 2, maxRouteLength: -5 }))).toEqual(['FLEET_INVALID']);
    const tiny: Graph = { vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }], edges: [{ id: 'ab', u: 'a', v: 'b', weight: 3, required: true }] };
    const r = fleet(tiny, { vehicles: 4 });
    expect(r.activeVehicles).toBe(1);
    expect(r.warnings.map((w) => w.code)).toContain('FLEET_IDLE');
  });

  it('reports invalid depots and unreachable streets from the base solver', () => {
    expect(codes(solveFleet(heritage, { vehicles: 2, depotId: 'nope' }))).toContain('DEPOT_UNKNOWN');
    const split: Graph = {
      vertices: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, x: i, y: 0 })),
      edges: [
        { id: 'ab', u: 'a', v: 'b', weight: 1, required: true },
        { id: 'cd', u: 'c', v: 'd', weight: 1, required: true },
      ],
    };
    expect(codes(solveFleet(split, { vehicles: 2 }))).toContain('REQUIRED_UNREACHABLE');
  });

  it('total-distance objective without a limit keeps one route (extra vehicles cannot reduce total distance)', () => {
    const r = fleet(meridian, { vehicles: 4, objective: 'total' });
    expect(r.activeVehicles).toBe(1);
    expect(r.totalDistance).toBe(r.singleVehicleDistance);
    expect(r.algorithm.ratioBound).toBe(1);
  });

  it('respects a per-route length limit, or explains why it cannot', () => {
    const base = fleet(meridian, { vehicles: 6 });
    const limit = Math.ceil(base.makespan * 1.05);
    const r = fleet(meridian, { vehicles: 6, objective: 'total', maxRouteLength: limit });
    for (const route of r.routes) expect(route.distance).toBeLessThanOrEqual(limit);
    expect(r.algorithm.ratioBound).toBeNull();
    const impossible = solveFleet(meridian, { vehicles: 6, maxRouteLength: base.lowerBound.farthestStreet!.roundTrip - 1 });
    expect(codes(impossible)).toEqual(['FLEET_LIMIT_INFEASIBLE']);
    const tooFew = solveFleet(meridian, { vehicles: 2, maxRouteLength: base.lowerBound.farthestStreet!.roundTrip + 1 });
    expect(codes(tooFew)).toEqual(['FLEET_LIMIT_UNMET']);
  });

  it('directed fleets obey one-way streets in every route', () => {
    const g: Graph = {
      vertices: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, x: i * 50, y: (i % 2) * 40 })),
      edges: [
        { id: 'ab', u: 'a', v: 'b', weight: 4, required: true, oneway: true },
        { id: 'bc', u: 'b', v: 'c', weight: 3, required: true },
        { id: 'cd', u: 'c', v: 'd', weight: 5, required: true, oneway: true },
        { id: 'da', u: 'd', v: 'a', weight: 6, required: true },
        { id: 'ce', u: 'c', v: 'e', weight: 2, required: true, reverseWeight: 7 },
        { id: 'ea', u: 'e', v: 'a', weight: 9, required: false, oneway: true },
      ],
      depotId: 'a',
    };
    for (const twoWay of ['both', 'either'] as const) {
      const single = solveDirectedPostman(g, { twoWay });
      if (!single.ok) throw new Error('should solve');
      for (const k of [1, 2, 3]) {
        const r = fleet(g, { vehicles: k, mode: 'directed', twoWay });
        expect(r.algorithm.ratioBound).toBe(k === 1 ? null : null);
        const v = verifyFleet(g, r.routes, { depotId: 'a', directed: true, twoWay });
        expect(v.ok).toBe(true);
        for (const route of r.routes) for (const st of route.steps) {
          const e = g.edges.find((x) => x.id === st.edgeId)!;
          if (e.oneway) expect([st.from, st.to]).toEqual([e.u, e.v]);
        }
        if (k === 1) expect(r.makespan).toBe(single.route.totalDistance);
      }
    }
  });

  it('is deterministic', () => {
    const a = solveFleet(meridian, { vehicles: 3 });
    const b = solveFleet(meridian, { vehicles: 3 });
    const strip = (x: typeof a) => JSON.stringify({ ...x, timingsMs: null, base: null });
    expect(strip(a)).toEqual(strip(b));
  });

  it('solveRouting applies scenario settings and keeps the single route when a fleet split fails', () => {
    const r = solveRouting({ ...meridian, routing: { vehicles: 3 } });
    if (!r.ok) throw new Error('should solve');
    expect(r.fleet?.activeVehicles).toBeGreaterThan(1);
    const bad = solveRouting({ ...meridian, routing: { vehicles: 2, maxRouteLength: 1 } });
    if (!bad.ok) throw new Error('single route should still solve');
    expect(bad.fleet).toBeNull();
    expect(bad.fleetIssues.map((i) => i.code)).toEqual(['FLEET_LIMIT_INFEASIBLE']);
  });
});

/**
 * Exact min–max optimum for 2 vehicles on tiny graphs: try every assignment of
 * required streets to the two vehicles and solve each vehicle's covering walk
 * exactly with the independent state-space search.
 */
function exactMinMax2(g: Graph, depotId: string): number {
  const req = g.edges.map((e, i) => (e.required ? i : -1)).filter((i) => i >= 0);
  let best = Infinity;
  const cache = new Map<number, number>();
  const costOf = (mask: number): number => {
    if (cache.has(mask)) return cache.get(mask)!;
    let c = 0;
    if (mask !== 0) {
      const sub: Graph = { ...g, edges: g.edges.map((e, i) => ({ ...e, required: e.required && (mask & (1 << req.indexOf(i))) !== 0 })) };
      c = shortestCoveringWalk(sub, { depotId, twoWay: 'either' }) ?? Infinity;
    }
    cache.set(mask, c);
    return c;
  };
  const full = (1 << req.length) - 1;
  for (let mask = 0; mask <= full; mask++) best = Math.min(best, Math.max(costOf(mask), costOf(full ^ mask)));
  return best;
}

describe('fleet guarantee against the exact min–max optimum (k = 2, tiny graphs)', () => {
  it('the longest route is between OPT and (2 − 1/2)·OPT', () => {
    let compared = 0;
    let strictlyBetter = 0;
    for (let seed = 1; seed <= 400 && compared < 120; seed++) {
      const g = randomGraph(seed, { maxN: 6, maxM: 8, optionalProb: 0.2 });
      if (g.edges.filter((e) => e.required).length > 8) continue;
      const single = solveChinesePostman(g);
      if (!single.ok) continue;
      const r = solveFleet(g, { vehicles: 2, base: single });
      if (!r.ok) throw new Error(`seed ${seed}`);
      expect(r.checks.every((c) => c.passed), `seed ${seed}`).toBe(true);
      const opt = exactMinMax2(g, single.input.depotId);
      expect(r.makespan, `seed ${seed}`).toBeGreaterThanOrEqual(opt - 1e-9);
      expect(r.makespan, `seed ${seed}`).toBeLessThanOrEqual(1.5 * opt + 1e-9);
      expect(r.lowerBound.value, `seed ${seed}`).toBeLessThanOrEqual(opt + 1e-3);
      if (r.makespan < single.route.totalDistance) strictlyBetter++;
      compared++;
    }
    expect(compared).toBeGreaterThan(80);
    expect(strictlyBetter).toBeGreaterThan(20);
  });
});
