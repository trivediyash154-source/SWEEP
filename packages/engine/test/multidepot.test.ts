import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCityBundle, type CityModel } from '../src/city/index.js';
import { nearestNode, zoneCoverageGraph } from '../src/coverage/zone.js';
import { solveZoneCoverage } from '../src/coverage/solveCoverage.js';
import { planFleet } from '../src/coverage/carp.js';
import { planMultiDepotFleet, type MultiDepotPlan } from '../src/coverage/multidepot.js';

const BUNDLED = join(__dirname, '..', '..', '..', 'apps', 'web', 'public', 'cities', 'pune-bibwewadi.json');
const speeds = { serviceSpeedKmh: 8, deadheadSpeedKmh: 20 };

describe.skipIf(!existsSync(BUNDLED))('several depots on the real Pune network', () => {
  const city: CityModel = decodeCityBundle(JSON.parse(readFileSync(BUNDLED, 'utf8')));
  const c = city.focus!.xy;
  const zone = { kind: 'circle' as const, cx: c[0], cy: c[1], r: 600 };
  const idOf = (x: number, y: number) => `n${city.nodeOsm[nearestNode(city, x, y)]}`;
  const west = idOf(c[0] - 500, c[1]);
  const east = idOf(c[0] + 500, c[1]);

  for (const direction of ['directed', 'undirected'] as const) {
    it(`${direction}: covers every street, routes return to their own depot, bounds hold`, () => {
      const zg = zoneCoverageGraph(city, { zone, direction });
      const res = planMultiDepotFleet(zg.graph, { ...speeds, direction, objective: 'min-makespan', depots: [{ depotId: west, vehicles: 2 }, { depotId: east, vehicles: 2 }] });
      expect(res.ok).toBe(true);
      const p = res as MultiDepotPlan;
      for (const ch of p.validation.checks) expect(ch.passed, `${ch.id}: ${ch.detail}`).toBe(true);
      expect(p.depots.map((d) => d.depotId)).toEqual([west, east]);
      expect(p.depots.every((d) => d.requiredEdges.length > 0)).toBe(true);
      // Every serviceable required street belongs to exactly one depot.
      const owners = new Map<string, number>();
      for (const d of p.depots) for (const id of d.requiredEdges) owners.set(id, (owners.get(id) ?? 0) + 1);
      for (const e of zg.graph.edges) if (e.required && !p.unserviceable.includes(e.id)) expect(owners.get(e.id)).toBe(1);
      for (const r of p.routes) {
        expect(r.steps[0]!.from).toBe(r.depotId);
        expect(r.steps[r.steps.length - 1]!.to).toBe(r.depotId);
      }
      // Valid lower bounds never exceed what the plan achieves.
      expect(p.lowerBounds.totalDistance.value).toBeLessThanOrEqual(p.totals.distance + 1e-6);
      expect(p.lowerBounds.makespanSeconds.value).toBeLessThanOrEqual(p.totals.makespanSeconds + 1e-6);
      expect(p.totals.vehiclesAvailable).toBe(4);
      expect(p.guarantee).toMatch(/not proven optimal/);
    });
  }

  it('with one depot it is exactly the single-depot plan', () => {
    const zg = zoneCoverageGraph(city, { zone, direction: 'directed' });
    const multi = planMultiDepotFleet(zg.graph, { ...speeds, direction: 'directed', objective: 'min-makespan', depots: [{ depotId: west, vehicles: 3 }] });
    const cov = solveZoneCoverage(zg.graph, { direction: 'directed', depotId: west });
    if (!cov.ok) throw new Error(cov.message);
    const single = planFleet(cov.graph, { ...speeds, direction: 'directed', objective: 'min-makespan', vehicles: 3, depotId: west, coverage: cov });
    if (!multi.ok || !single.ok) throw new Error('plan failed');
    expect(multi.totals.distance).toBeCloseTo(single.totals.distance, 9);
    expect(multi.totals.makespanSeconds).toBeCloseTo(single.totals.makespanSeconds, 9);
    expect(multi.routes.length).toBe(single.routes.length);
  });

  it('refuses bad depot lists', () => {
    const zg = zoneCoverageGraph(city, { zone, direction: 'undirected' });
    const base = { ...speeds, direction: 'undirected' as const, objective: 'min-total' as const };
    expect(planMultiDepotFleet(zg.graph, { ...base, depots: [] }).ok).toBe(false);
    expect(planMultiDepotFleet(zg.graph, { ...base, depots: [{ depotId: west, vehicles: 1 }, { depotId: west, vehicles: 1 }] }).ok).toBe(false);
    expect(planMultiDepotFleet(zg.graph, { ...base, depots: [{ depotId: west, vehicles: 0 }] }).ok).toBe(false);
    expect(planMultiDepotFleet(zg.graph, { ...base, depots: [{ depotId: 'n-not-a-node', vehicles: 1 }] }).ok).toBe(false);
  });
});
