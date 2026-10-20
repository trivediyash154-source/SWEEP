import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCityBundle, DRIVABLE_ROAD_CLASSES } from '@sweep/engine';
import { bundledCoverage, bundledStreetGraph, coversBox } from './bundled';
import { graphUnprojection, planSweep, DEFAULT_SWEEP_SETTINGS, type SweepPlan, type Zone } from './plan';

// The real Pune extract the site ships (public/cities), the same file the page loads.
const city = decodeCityBundle(JSON.parse(readFileSync(join(__dirname, '..', '..', 'public', 'cities', 'pune-bibwewadi.json'), 'utf8')));
const classes = [...DRIVABLE_ROAD_CLASSES, 'trunk', 'trunk_link'];

describe('bundled Pune streets for the sweep planner', () => {
  const cov = bundledCoverage(city);

  it('knows the extract box and its missing street tiles', () => {
    expect(cov.bbox).toEqual([18.445, 73.85, 18.481, 73.888]);
    expect(cov.missing.length).toBeGreaterThan(0);
    // A box around VIT is fully covered; one straddling a missing street tile (t3_5) is not; one outside is not.
    expect(coversBox(cov, [18.458, 73.862, 18.469, 73.875])).toBe(true);
    expect(coversBox(cov, [18.464, 73.881, 18.466, 73.883])).toBe(false);
    expect(coversBox(cov, [18.5, 73.8, 18.51, 73.81])).toBe(false);
  });

  it('is one connected network of the chosen classes with positions the planner can draw', () => {
    const g = bundledStreetGraph(city, classes);
    expect(g.edges.length).toBeGreaterThan(4000);
    expect(g.edges.every((e) => !e.required && classes.includes(e.roadClass!))).toBe(true);
    const local = bundledStreetGraph(city, ['residential', 'living_street', 'unclassified', 'service', 'pedestrian']);
    expect(local.edges.length).toBeLessThan(g.edges.length);
    const un = graphUnprojection(g);
    let worst = 0;
    for (const v of g.vertices) {
      const [lng, lat] = un([v.x, v.y]);
      worst = Math.max(worst, Math.abs(lng - v.geo![0]), Math.abs(lat - v.geo![1]));
    }
    expect(worst).toBeLessThan(2e-6); // x/y are stored to 10 cm, about 1e-6 degrees
  });

  it('covers the two instant examples (VIT 1 km², Bibwewadi & VIT 4 km²) with their 150 m margin', () => {
    const sq = (lat: number, lng: number, km: number): [number, number, number, number] => {
      const dLat = (km * 500 + 150) / 111_195;
      const dLng = (km * 500 + 150) / (111_195 * Math.cos((lat * Math.PI) / 180));
      return [lat - dLat, lng - dLng, lat + dLat, lng + dLng];
    };
    expect(coversBox(cov, sq(18.4636, 73.8682, 1))).toBe(true);
    expect(coversBox(cov, sq(18.4605, 73.868, 2))).toBe(true);
    expect(coversBox(cov, sq(18.5074, 73.8077, 2))).toBe(false); // Kothrud: downloaded live
  });

  it('plans the 4 km² example from the bundle, one-ways obeyed, every check passing', () => {
    const zone: Zone = { kind: 'rect', bbox: [18.451506, 73.858513, 18.469494, 73.877487] };
    const t0 = performance.now();
    const res = planSweep(bundledStreetGraph(city, classes), zone, [73.868, 18.4605], DEFAULT_SWEEP_SETTINGS);
    const ms = performance.now() - t0;
    expect(res.ok).toBe(true);
    const plan = res as SweepPlan;
    expect(plan.required.km).toBeGreaterThan(30);
    for (const c of plan.checks) expect(c.passed, `${c.id}: ${c.detail}`).toBe(true);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);

  it('plans the VIT example from the bundle with every check passing', () => {
    const zone: Zone = { kind: 'rect', bbox: [18.4591, 73.8635, 18.4681, 73.8729] };
    const res = planSweep(bundledStreetGraph(city, classes), zone, [73.8682, 18.4636], DEFAULT_SWEEP_SETTINGS);
    expect(res.ok).toBe(true);
    const plan = res as SweepPlan;
    expect(plan.required.segments).toBeGreaterThan(50);
    expect(plan.totals.distanceM).toBeGreaterThanOrEqual(plan.totals.serviceM);
    for (const c of plan.checks) expect(c.passed, `${c.id}: ${c.detail}`).toBe(true);
    const r = plan.routes[0]!;
    expect(r.coords[0]).toEqual(plan.depot);
    expect(r.coords[r.coords.length - 1]).toEqual(plan.depot);
  }, 120_000);
});
