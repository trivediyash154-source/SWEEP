import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { decodeCityBundle, RoutingEngine, reachability } from './engine';
import { contrastRatio, decodePng, luminanceAt } from './png';

// The bundled real dataset; the UI must show exactly what the engine computes on it.
const city = decodeCityBundle(JSON.parse(readFileSync(new URL('../apps/web/public/cities/pune-bibwewadi.json', import.meta.url), 'utf8')));

async function openCity(page: Page, theme: 'velvet' | 'porcelain' = 'velvet'): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem('sweep.theme', t), theme);
  await page.goto('/workspace');
  await expect(page.getByTestId('city-name')).toContainText('Pune', { timeout: 60_000 });
  await page.waitForFunction(() => (window as unknown as { __sweepCity?: { state: () => { meshes: unknown } } }).__sweepCity?.state().meshes, null, { timeout: 60_000 });
}

async function routeBetween(page: Page, from: string, to: string): Promise<void> {
  await page.getByTestId('search-origin').fill(from);
  await page.getByTestId('search-result').first().click();
  await page.getByTestId('search-destination').fill(to);
  await page.getByTestId('search-result').first().click();
  await expect(page.getByTestId('route-results')).toBeVisible({ timeout: 60_000 });
}

const routeState = (page: Page) =>
  page.evaluate(() => {
    const r = (window as unknown as { __sweepCity: { route: () => { origin: number; destination: number; runs: { result: { algorithm: string; cost: number; timeS: number; distanceM: number; found: boolean } }[] } } }).__sweepCity.route();
    return { origin: r.origin, destination: r.destination, runs: r.runs.map((x) => x.result) };
  });

test.describe('city workspace (real Pune OpenStreetMap data)', () => {
  // Real-data routing plus software-rasterised WebGL; two browsers share the CI cores.
  test.describe.configure({ timeout: 180_000 });
  test('opens without signing in, on real attributed data with stated provenance', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openCity(page);
    await expect(page.getByTestId('city-attribution')).toContainText('© OpenStreetMap contributors');
    await page.getByTestId('open-provenance').click();
    await expect(page.getByTestId('provenance')).toContainText('OpenStreetMap');
    await expect(page.getByTestId('prov-buildings')).toContainText(`${city.buildingCount.toLocaleString('en-US')} footprints`);
    await expect(page.getByTestId('prov-buildings')).toContainText('estimated');
    await expect(page.getByTestId('prov-tiles')).toContainText(`${city.provenance.tiles.ok} of ${city.provenance.tiles.total}`);
    expect(errors).toEqual([]);
  });

  test('every algorithm returns the engine optimum on the real network, and each route validates', async ({ page }) => {
    await openCity(page);
    await routeBetween(page, 'Swami Vivek', 'Kamate');
    await expect(page.getByTestId('route-agreement')).toContainText('All 5 algorithms return the same optimal travel time');
    for (const a of ['dijkstra', 'astar', 'bidirectional', 'alt', 'ch']) await expect(page.getByTestId(`valid-${a}`)).toContainText('valid');
    const s = await routeState(page);
    const engine = new RoutingEngine(city, 'car');
    const expected = engine.query('dijkstra', { origin: s.origin, destination: s.destination, objective: 'time' }).result;
    expect(expected.found).toBe(true);
    for (const r of s.runs) expect(Math.abs(r.cost - expected.cost) / expected.cost).toBeLessThan(1e-9);
    // Goal-directed and preprocessed searches settle fewer arcs than plain Dijkstra on this query.
    const settled = async (a: string) => Number((await page.getByTestId(`settled-${a}`).innerText()).replace(/,/g, ''));
    expect(await settled('alt')).toBeLessThan(await settled('dijkstra'));
    expect(await settled('ch')).toBeLessThan(await settled('dijkstra'));
    // Shortest-distance objective is a different, equally exact query.
    await page.getByTestId('objective-distance').click();
    await expect(page.getByTestId('route-agreement')).toContainText('same optimal distance');
    const d = await routeState(page);
    const expD = engine.query('dijkstra', { origin: d.origin, destination: d.destination, objective: 'distance' }).result;
    expect(Math.abs(d.runs[0]!.distanceM - expD.distanceM)).toBeLessThan(1e-6);
  });

  test('reachability uses real travel times and nests 5 ⊆ 10 ⊆ 15 minutes', async ({ page }) => {
    await openCity(page);
    await routeBetween(page, 'Swami Vivek', 'Kamate');
    await page.getByTestId('run-reach').click();
    await expect(page.getByTestId('reach-bands')).toBeVisible();
    const s = await routeState(page);
    const exp = reachability(new RoutingEngine(city, 'car').graph, s.origin, [300, 600, 900]);
    const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
    for (const l of exp.levels) await expect(page.getByTestId(`reach-${l.thresholdS}`)).toContainText(km(l.lengthM));
    expect(exp.levels[0]!.lengthM).toBeLessThanOrEqual(exp.levels[1]!.lengthM);
    expect(exp.levels[1]!.lengthM).toBeLessThanOrEqual(exp.levels[2]!.lengthM);
  });

  test('closing a road clicked on the map recalculates the route against the baseline', async ({ page }) => {
    await openCity(page);
    await routeBetween(page, 'Swami Vivek', 'Kamate');
    await page.waitForTimeout(2600); // camera frames the route
    const before = await routeState(page);
    await page.getByTestId('mode-scenarios').click();
    await page.getByTestId('tool-close-road').click();
    const target = await page.evaluate(() => {
      const w = window as unknown as { __sweepCity: { route: () => { active: string; runs: { result: { algorithm: string; segments: number[] } }[] }; state: () => { city: { segPtOff: Int32Array; segXY: Float64Array } }; project: (x: number, y: number, h: number) => [number, number] } };
      const r = w.__sweepCity.route();
      const segs = r.runs.find((x) => x.result.algorithm === r.active)!.result.segments;
      const c = w.__sweepCity.state().city;
      const s = segs[Math.floor(segs.length / 2)]!;
      const a = c.segPtOff[s]!;
      const z = c.segPtOff[s + 1]!;
      const m = a + Math.floor((z - a) / 2);
      const x = (c.segXY[2 * m]! + c.segXY[2 * (z - 1)]!) / 2;
      const y = (c.segXY[2 * m + 1]! + c.segXY[2 * (z - 1) + 1]!) / 2;
      return { s, p: w.__sweepCity.project(x, y, 0) };
    });
    const box = (await page.getByTestId('city-stage').boundingBox())!;
    await page.mouse.click(box.x + ((target.p[0] + 1) / 2) * box.width, box.y + ((1 - target.p[1]) / 2) * box.height);
    await expect(page.getByTestId('scenario-changes')).toContainText('closed');
    await page.getByTestId('compare-baseline').click();
    await expect(page.getByTestId('scenario-comparison')).toBeVisible();
    const s = await routeState(page);
    const engine = new RoutingEngine(city, 'car', { closedSegments: [target.s] });
    const exp = engine.query('dijkstra', { origin: s.origin, destination: s.destination, objective: 'time' }).result;
    expect(Math.abs(s.runs[0]!.cost - exp.cost) / exp.cost).toBeLessThan(1e-9);
    expect(s.runs[0]!.cost).toBeGreaterThanOrEqual(before.runs[0]!.cost); // a closure never makes the trip faster
    for (const r of s.runs) expect(Math.abs(r.cost - s.runs[0]!.cost)).toBeLessThan(1e-6);
  });

  for (const theme of ['velvet', 'porcelain'] as const) {
    test(`buildings stand out from the ground in the ${theme} theme (3D scene contrast)`, async ({ page }) => {
      await openCity(page, theme);
      await page.getByTestId('cam-focus').click();
      await page.waitForTimeout(2500);
      const samples = await page.evaluate(() => (window as unknown as { __sweepCity: { sample: (n: number) => { buildings: [number, number][]; ground: [number, number][] } } }).__sweepCity.sample(30));
      expect(samples.buildings.length).toBeGreaterThan(10);
      expect(samples.ground.length).toBeGreaterThan(3);
      const box = (await page.getByTestId('city-stage').boundingBox())!;
      const img = decodePng(await page.screenshot());
      const at = (p: [number, number]) => luminanceAt(img, box.x + ((p[0] + 1) / 2) * box.width, box.y + ((1 - p[1]) / 2) * box.height);
      const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const roof = median(samples.buildings.map(at));
      const ground = median(samples.ground.map(at));
      const ratio = contrastRatio(roof, ground);
      test.info().annotations.push({ type: 'contrast', description: `${theme}: roof ${roof.toFixed(3)} vs ground ${ground.toFixed(3)} → ${ratio.toFixed(2)}:1` });
      expect(ratio).toBeGreaterThan(1.3);
    });
  }

  test('switching theme rebuilds the 3D scene, not only the page chrome', async ({ page }) => {
    await openCity(page, 'velvet');
    await page.getByTestId('cam-focus').click();
    await page.waitForTimeout(2500);
    const ground = await page.evaluate(() => (window as unknown as { __sweepCity: { sample: (n: number) => { ground: [number, number][] } } }).__sweepCity.sample(10).ground[0]!);
    const box = (await page.getByTestId('city-stage').boundingBox())!;
    const lum = async () => luminanceAt(decodePng(await page.screenshot()), box.x + ((ground[0] + 1) / 2) * box.width, box.y + ((1 - ground[1]) / 2) * box.height);
    const dark = await lum();
    await page.getByRole('button', { name: /porcelain|light/i }).first().click();
    await page.waitForTimeout(1500);
    const light = await lum();
    expect(light).toBeGreaterThan(dark * 3);
  });

  test('clicking a building identifies the real OSM feature and where its height comes from', async ({ page }) => {
    await openCity(page);
    // The Route lab opens ready to pick an origin; Escape leaves pick mode so the click inspects.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pick-origin')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('cam-focus').click();
    await page.waitForTimeout(2500);
    const p = await page.evaluate(() => (window as unknown as { __sweepCity: { sample: (n: number) => { buildings: [number, number][] } } }).__sweepCity.sample(5).buildings[0]!);
    const box = (await page.getByTestId('city-stage').boundingBox())!;
    await page.mouse.click(box.x + ((p[0] + 1) / 2) * box.width, box.y + ((1 - p[1]) / 2) * box.height);
    await expect(page.getByTestId('feature-building')).toBeVisible();
    await expect(page.getByTestId('height-source')).toHaveText(/OpenStreetMap height tag|building:levels|Estimated for visual context/);
    await expect(page.getByTestId('feature-building').getByRole('link')).toHaveAttribute('href', /openstreetmap\.org\/way\/\d+/);
  });
});
