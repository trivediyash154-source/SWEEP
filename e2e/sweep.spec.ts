import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { osmToGraph, mergeElements, DRIVABLE_ROAD_CLASSES, type OsmElement } from '../packages/engine/src/index';
import { planSweep, type SweepPlan, type SweepSettings, type Zone } from '../apps/web/src/sweep/plan';
import { formatTravelDistance } from '../apps/web/src/lib/directions';

// The street download is answered with a REAL Overpass API response cached by the Pune acquisition
// (tile t2_3, 18.457–18.463 N, 73.868–73.874 E), converted exactly as the server does. The map style is a
// plain background (test double). Everything else is the page and the engine.
const tile = JSON.parse(readFileSync(new URL('../data/cache/osm/pune-bibwewadi/tiles/t2_3_streets.json', import.meta.url), 'utf8'));
const classes = [...DRIVABLE_ROAD_CLASSES, 'trunk', 'trunk_link'];
const conv = osmToGraph(tile, { roadClasses: classes });
// Like the real services, every stand-in answers with CORS headers.
const CORS = { 'Access-Control-Allow-Origin': '*' };
const STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9e5dc' } }] };

type W = {
  __sweepMap: { jumpTo: (o: { center: [number, number]; zoom: number }) => void; project: (p: [number, number]) => { x: number; y: number }; loaded: () => boolean; isMoving: () => boolean };
  __sweepPlanner: { state: () => { zone: Zone | null; depot: [number, number] | null; plan: SweepPlan | null; settings: SweepSettings } };
};

async function setup(page: Page) {
  const bboxes: unknown[] = [];
  await page.route('https://tiles.openfreemap.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(STYLE) }));
  await page.route('https://tile.openstreetmap.org/**', (r) => r.abort());
  await page.route('**/api/maps/acquire', (r) => {
    bboxes.push(JSON.parse(r.request().postData() ?? '{}').bbox);
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { graph: conv.graph, report: { stats: conv.stats, notes: conv.notes, roadClassesFound: conv.roadClassesFound }, attempts: [{ endpoint: 'https://overpass-api.de/api/interpreter', host: 'overpass-api.de', ok: true, status: 200, ms: 900 }], cached: false, query: 'cached Pune tile t2_3' } }),
    });
  });
  await page.goto('/sweep');
  await page.waitForFunction(() => (window as unknown as W).__sweepMap?.loaded());
  await page.evaluate(() => (window as unknown as W).__sweepMap.jumpTo({ center: [73.871, 18.46], zoom: 16 }));
  await page.waitForFunction(() => !(window as unknown as W).__sweepMap.isMoving());
  return bboxes;
}

async function clickAt(page: Page, lng: number, lat: number) {
  const box = (await page.getByTestId('sweep-map').boundingBox())!;
  const p = await page.evaluate(([x, y]) => (window as unknown as W).__sweepMap.project([x!, y!]), [lng, lat]);
  await page.mouse.click(box.x + p.x, box.y + p.y);
}

// All cached Pune street tiles (real Overpass responses) with their boxes, to answer tiled requests.
const manifest = JSON.parse(readFileSync(new URL('../data/cache/osm/pune-bibwewadi/manifest.json', import.meta.url), 'utf8')) as { entries: Record<string, { status: string; bbox: number[]; file: string }> };
const streetTiles = Object.entries(manifest.entries)
  .filter(([k, e]) => k.endsWith(':streets') && e.status === 'ok')
  .map(([, e]) => ({ bbox: e.bbox, elements: (JSON.parse(readFileSync(new URL(`../data/cache/osm/pune-bibwewadi/tiles/${e.file}`, import.meta.url), 'utf8')) as { elements: OsmElement[] }).elements }));
/** What a real Overpass server would return for a box, assembled from the cached real tiles that overlap it. */
function overpassFor(bb: number[]): { elements: OsmElement[] } {
  const hits = streetTiles.filter((t) => t.bbox[0]! < bb[2]! && t.bbox[2]! > bb[0]! && t.bbox[1]! < bb[3]! && t.bbox[3]! > bb[1]!);
  return { elements: mergeElements(hits.map((h) => h.elements)).elements };
}

test.describe('Sweep planner (any zone, live OpenStreetMap streets)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('draw a rectangle, plan, and see exactly the engine plan with its bound and an honest label', async ({ page }) => {
    const bboxes = await setup(page);
    await page.getByTestId('sweep-draw-rect').click();
    await clickAt(page, 73.8695, 18.4585);
    await clickAt(page, 73.8725, 18.4615);
    await expect(page.getByTestId('sweep-zone')).toContainText('Rectangle');
    await page.getByTestId('sweep-run').click();
    await expect(page.getByTestId('sweep-result')).toBeVisible({ timeout: 60_000 });
    const st = await page.evaluate(() => (window as unknown as W).__sweepPlanner.state());
    // The download box is the zone plus a 150 m margin.
    const [s, w, n, e] = bboxes[0] as number[];
    expect(s!).toBeLessThan(st.zone!.kind === 'rect' ? st.zone!.bbox[0] : 0);
    expect(e!).toBeGreaterThan(st.zone!.kind === 'rect' ? st.zone!.bbox[3] : 0);
    expect(n! - s!).toBeGreaterThan(0);
    expect(w!).toBeLessThan(e!);
    // Same graph, zone, depot and settings in Node give the same plan.
    const zone = st.zone!;
    const ring = zone.kind === 'rect' ? [[zone.bbox[1], zone.bbox[0]], [zone.bbox[3], zone.bbox[0]], [zone.bbox[3], zone.bbox[2]], [zone.bbox[1], zone.bbox[2]]] : zone.ring;
    const centre: [number, number] = [ring.reduce((a, p) => a + p[0]!, 0) / ring.length, ring.reduce((a, p) => a + p[1]!, 0) / ring.length];
    const exp = planSweep(conv.graph, zone, centre, st.settings) as SweepPlan;
    expect(exp.ok).toBe(true);
    const got = st.plan!;
    expect(got.method).toBe(exp.method);
    expect(Math.abs(got.totals.distanceM - exp.totals.distanceM)).toBeLessThan(1e-6);
    expect(got.lowerBound).toEqual(exp.lowerBound);
    expect(got.required).toEqual(exp.required);
    await expect(page.getByTestId('sweep-total')).toHaveText(formatTravelDistance(exp.totals.distanceM));
    // Proven optimal only when the engine says so; otherwise the bound and gap are shown.
    if (exp.optimal) await expect(page.getByTestId('sweep-method')).toContainText('Proven optimal');
    else await expect(page.getByTestId('sweep-method')).not.toContainText('optimal');
    await expect(page.getByTestId('sweep-bound')).toContainText('proven lower bound');
    for (const c of got.checks) expect(c.passed, c.detail).toBe(true);
    // Exports follow the plan.
    const [gpx] = await Promise.all([page.waitForEvent('download'), page.getByTestId('sweep-gpx').click()]);
    expect(readFileSync((await gpx.path())!, 'utf8').match(/<trk>/g)).toHaveLength(1);
  });

  test('an outline zone with three vehicles: the engine fleet plan, its finish-time bound, one colour per vehicle', async ({ page }) => {
    await setup(page);
    await page.getByTestId('sweep-draw-polygon').click();
    const pts: [number, number][] = [
      [73.8692, 18.4583],
      [73.8728, 18.4586],
      [73.8724, 18.4617],
      [73.8698, 18.4612],
    ];
    for (const [lng, lat] of pts) await clickAt(page, lng, lat);
    await page.getByTestId('sweep-finish').click();
    await expect(page.getByTestId('sweep-zone')).toContainText('4-point outline');
    await page.getByTestId('sweep-vehicles').fill('3');
    await page.getByTestId('sweep-run').click();
    await expect(page.getByTestId('sweep-vehicles-table')).toBeVisible({ timeout: 60_000 });
    const st = await page.evaluate(() => (window as unknown as W).__sweepPlanner.state());
    const zone = st.zone!;
    const ring = zone.kind === 'polygon' ? zone.ring : [];
    const centre: [number, number] = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
    const exp = planSweep(conv.graph, zone, centre, st.settings) as SweepPlan;
    expect(Math.abs(st.plan!.totals.makespanSeconds - exp.totals.makespanSeconds)).toBeLessThan(1e-6);
    expect(st.plan!.fleetBounds!.makespanSeconds).toBe(exp.fleetBounds!.makespanSeconds);
    expect(st.plan!.fleetBounds!.makespanSeconds).toBeLessThanOrEqual(st.plan!.totals.makespanSeconds + 1e-6);
    await expect(page.getByTestId('sweep-vehicles-table').locator('tbody tr')).toHaveCount(exp.routes.length);
    await expect(page.getByTestId('sweep-makespan')).toContainText('no plan with 3 vehicles finishes before');
    await expect(page.getByTestId('sweep-method')).toContainText('heuristic');
  });

  test('a zone larger than 4 km² is downloaded in polite tiles, merged, and planned exactly as the engine plans it', async ({ page }) => {
    await setup(page);
    const requests: number[][] = [];
    await page.route('https://overpass-api.de/api/interpreter', (r) => {
      const q = new URLSearchParams(r.request().postData() ?? '').get('data') ?? '';
      const bb = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/.exec(q)!.slice(1).map(Number);
      requests.push(bb);
      return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(overpassFor(bb)) });
    });
    // About 2.5 × 2.5 km inside the real Pune extract.
    const [s, w, n, e] = [18.452, 73.857, 18.4745, 73.8805];
    await page.evaluate(([x, y]) => (window as unknown as W).__sweepMap.jumpTo({ center: [x!, y!], zoom: 14 }), [(w + e) / 2, (s + n) / 2]);
    await page.waitForFunction(() => !(window as unknown as W).__sweepMap.isMoving());
    await page.getByTestId('sweep-draw-rect').click();
    await clickAt(page, w, s);
    await clickAt(page, e, n);
    await expect(page.getByTestId('sweep-tiled')).toBeVisible();
    await page.getByTestId('sweep-run').click();
    await expect(page.getByTestId('sweep-result')).toBeVisible({ timeout: 90_000 });
    expect(requests.length).toBeGreaterThan(1);
    // Every tile request stays within the polite size.
    for (const bb of requests) expect((bb[2]! - bb[0]!) * 111.195 * (bb[3]! - bb[1]!) * 111.195 * Math.cos((18.46 * Math.PI) / 180)).toBeLessThanOrEqual(3.5 + 1e-6);
    const st = await page.evaluate(() => (window as unknown as W).__sweepPlanner.state());
    expect(st.zone!.kind).toBe('rect');
    const graph = osmToGraph({ elements: mergeElements(requests.map(overpassFor).map((x) => x.elements)).elements }, { roadClasses: classes }).graph;
    const zone = st.zone!;
    const bb = zone.kind === 'rect' ? zone.bbox : [0, 0, 0, 0];
    const exp = planSweep(graph, zone, [(bb[1]! + bb[3]!) / 2, (bb[0]! + bb[2]!) / 2], st.settings) as SweepPlan;
    expect(exp.ok).toBe(true);
    expect(st.plan!.required).toEqual(exp.required);
    expect(st.plan!.required.km).toBeGreaterThan(20);
    expect(Math.abs(st.plan!.totals.distanceM - exp.totals.distanceM)).toBeLessThan(1e-6);
    expect(st.plan!.lowerBound).toEqual(exp.lowerBound);
    await expect(page.getByTestId('sweep-total')).toHaveText(formatTravelDistance(exp.totals.distanceM));
  });

  test('a zone too large for one polite download is refused before any request', async ({ page }) => {
    const bboxes = await setup(page);
    await page.evaluate(() => (window as unknown as W).__sweepMap.jumpTo({ center: [73.871, 18.46], zoom: 12 }));
    await page.waitForFunction(() => !(window as unknown as W).__sweepMap.isMoving());
    await page.getByTestId('sweep-use-view').click();
    await expect(page.getByTestId('sweep-too-large')).toBeVisible();
    await expect(page.getByTestId('sweep-run')).toBeDisabled();
    expect(bboxes).toHaveLength(0);
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await setup(page);
    const results = await new AxeBuilder({ page }).exclude('canvas').exclude('.maplibregl-ctrl').analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });
});
