import { readFileSync } from 'node:fs';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { decodeCityBundle, planFleet, RoutingEngine, reachability, solveZoneCoverage, zoneCoverageGraph } from './engine';
import { contrastRatio, decodePng, luminanceAt } from './png';

// The bundled real dataset; the UI must show exactly what the engine computes on it.
const city = decodeCityBundle(JSON.parse(readFileSync(new URL('../apps/web/public/cities/pune-bibwewadi.json', import.meta.url), 'utf8')));

/**
 * Diagnostic for the rare page-load freeze (HANDOFF §4.1): pause the page's JavaScript through the DevTools
 * protocol and attach where it stopped. If it never pauses, the main thread is inside native code (for example
 * a synchronous call into the software GPU process). The session is opened and the debugger enabled before
 * navigation: attaching to, or enabling the debugger on, an already-stuck page never answers, while a pause
 * request interrupts running JavaScript. With no breakpoints the enabled debugger does not stop the page.
 * Every call here is time-bounded; the original failure is kept.
 */
async function attachFreezeDiagnosis(cdp: CDPSession): Promise<void> {
  const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
  let report: string;
  try {
    const paused = new Promise<string>((resolve) =>
      cdp.on('Debugger.paused', (e) => resolve(e.callFrames.slice(0, 15).map((f) => `${f.functionName || '(anonymous)'} ${f.url.split('/').pop() || '(eval)'}:${f.location.lineNumber + 1}:${(f.location.columnNumber ?? 0) + 1}`).join('\n'))),
    );
    void cdp.send('Debugger.pause').catch(() => undefined);
    const stack = await within(paused, 10_000);
    report = stack === 'timeout' ? 'Debugger.pause did not take effect in 10 s: the main thread is stuck outside JavaScript (native or GPU call).' : `JavaScript stack when paused:\n${stack}`;
  } catch (e) {
    report = `Could not attach the debugger: ${String(e)}`;
  }
  await test.info().attach('freeze-diagnosis', { body: report, contentType: 'text/plain' });
}

async function openCity(page: Page, theme: 'velvet' | 'porcelain' = 'velvet'): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem('sweep.theme', t), theme);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable');
  await page.goto('/workspace');
  try {
    await expect(page.getByTestId('city-name')).toContainText('Pune', { timeout: 60_000 });
  } catch (e) {
    await attachFreezeDiagnosis(cdp);
    throw e;
  }
  await cdp.detach();
  await page.waitForFunction(() => (window as unknown as { __sweepCity?: { state: () => { meshes: unknown } } }).__sweepCity?.state().meshes, null, { timeout: 60_000 });
}

// The workspace's display formats (apps/web/src/city/panels/RouteLab.tsx, CoveragePanel.tsx).
const fmtDist = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const inr = (x: number): string => `₹${Math.round(x).toLocaleString('en-IN')}`;

/** Waits until no camera transition is running, so projected screen positions stay valid for clicks. */
async function waitForCamera(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __sweepCity?: { cameraMoving: () => boolean } }).__sweepCity?.cameraMoving() === false, null, { timeout: 30_000, polling: 100 });
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
    // The printable report reads the same comparison: same time and distance, one row per algorithm with the same
    // search work, and a route sheet whose legs add up to the route distance.
    await page.getByTestId('route-open-report').click();
    await expect(page.getByTestId('rrep-time')).toHaveText(await page.getByTestId('route-time').innerText());
    await expect(page.getByTestId('rrep-distance')).toHaveText(await page.getByTestId('route-distance').innerText());
    await expect(page.getByTestId('rrep-agreement')).toContainText('All 5 algorithms return the same optimal travel time');
    await expect(page.getByTestId('rrep-tiles')).toContainText(`${city.provenance.tiles.ok} of ${city.provenance.tiles.total}`);
    for (const a of ['dijkstra', 'astar', 'bidirectional', 'alt', 'ch']) await expect(page.getByTestId(`rrep-settled-${a}`)).toHaveText(await page.getByTestId(`settled-${a}`).innerText());
    await expect(page.getByTestId('rrep-from')).toContainText(`OSM node ${city.nodeOsm[s.origin]}`);
    const lastLeg = page.getByTestId('rrep-sheet').locator('tbody tr').last().locator('td').last();
    await expect(lastLeg).toHaveText(await page.getByTestId('route-distance').innerText());
    await page.getByTestId('route-report-close').click();
    await expect(page.getByTestId('route-report')).toHaveCount(0);
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
    // The camera glides to frame the route; click only once the transition has finished.
    await waitForCamera(page);
    const before = await routeState(page);
    await page.getByTestId('mode-scenarios').click();
    await page.getByTestId('tool-close-road').click();
    const box = (await page.getByTestId('city-stage').boundingBox())!;
    // A street of the route that is visible on the map (not under the 420 px side panel or the tool rail).
    const target = await page.evaluate(
      ({ w0, h0 }) => {
        const w = window as unknown as { __sweepCity: { route: () => { active: string; runs: { result: { algorithm: string; segments: number[] } }[] }; state: () => { city: { segPtOff: Int32Array; segXY: Float64Array; segLen: Float64Array } }; project: (x: number, y: number, h: number) => [number, number] | null } };
        const r = w.__sweepCity.route();
        const segs = r.runs.find((x) => x.result.algorithm === r.active)!.result.segments;
        const c = w.__sweepCity.state().city;
        const order = segs.map((s, i) => ({ s, i })).sort((a, b) => Math.abs(a.i - segs.length / 2) - Math.abs(b.i - segs.length / 2));
        for (const { s } of order) {
          if (c.segLen[s]! < 40) continue;
          const a = c.segPtOff[s]!;
          const z = c.segPtOff[s + 1]!;
          // A point on the street itself: a middle vertex, or the midpoint of a straight segment.
          const m = a + Math.floor((z - a) / 2);
          const [x, y] = z - a >= 3 ? [c.segXY[2 * m]!, c.segXY[2 * m + 1]!] : [(c.segXY[2 * a]! + c.segXY[2 * a + 2]!) / 2, (c.segXY[2 * a + 1]! + c.segXY[2 * a + 3]!) / 2];
          const p = w.__sweepCity.project(x, y, 0);
          if (!p) continue;
          const px = ((p[0] + 1) / 2) * w0;
          const py = ((1 - p[1]) / 2) * h0;
          if (px > 450 && px < w0 - 100 && py > 120 && py < h0 - 120) return { s, p };
        }
        return null;
      },
      { w0: box.width, h0: box.height },
    );
    expect(target).not.toBeNull();
    await page.mouse.click(box.x + ((target!.p[0] + 1) / 2) * box.width, box.y + ((1 - target!.p[1]) / 2) * box.height);
    await expect(page.getByTestId('scenario-changes')).toContainText('closed');
    await page.getByTestId('compare-baseline').click();
    await expect(page.getByTestId('scenario-comparison')).toBeVisible();
    const s = await routeState(page);
    const engine = new RoutingEngine(city, 'car', { closedSegments: [target!.s] });
    const exp = engine.query('dijkstra', { origin: s.origin, destination: s.destination, objective: 'time' }).result;
    expect(Math.abs(s.runs[0]!.cost - exp.cost) / exp.cost).toBeLessThan(1e-9);
    expect(s.runs[0]!.cost).toBeGreaterThanOrEqual(before.runs[0]!.cost); // a closure never makes the trip faster
    for (const r of s.runs) expect(Math.abs(r.cost - s.runs[0]!.cost)).toBeLessThan(1e-6);
  });

  for (const theme of ['velvet', 'porcelain'] as const) {
    test(`buildings stand out from the ground in the ${theme} theme (3D scene contrast)`, async ({ page }) => {
      await openCity(page, theme);
      await page.getByTestId('cam-focus').click();
      await waitForCamera(page);
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
    await waitForCamera(page);
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
    await waitForCamera(page);
    const p = await page.evaluate(() => (window as unknown as { __sweepCity: { sample: (n: number) => { buildings: [number, number][] } } }).__sweepCity.sample(5).buildings[0]!);
    const box = (await page.getByTestId('city-stage').boundingBox())!;
    await page.mouse.click(box.x + ((p[0] + 1) / 2) * box.width, box.y + ((1 - p[1]) / 2) * box.height);
    await expect(page.getByTestId('feature-building')).toBeVisible();
    await expect(page.getByTestId('height-source')).toHaveText(/OpenStreetMap height tag|building:levels|Estimated for visual context/);
    await expect(page.getByTestId('feature-building').getByRole('link')).toHaveAttribute('href', /openstreetmap\.org\/way\/\d+/);
  });

  test('circle and free-outline zones plan exactly what the engine plans for the same shape', async ({ page }) => {
    type Z = { kind: 'circle'; cx: number; cy: number; r: number } | { kind: 'polygon'; points: [number, number][] };
    type W = {
      __sweepCity: {
        project: (x: number, y: number, h: number) => [number, number] | null;
        state: () => { city: { focus: { xy: [number, number] } | null; nodeX: Float64Array; nodeY: Float64Array; nodeCount: number } };
        coverage: () => { zone: Z | null; draft: [number, number][]; depot: number | null; result: { method: string; direction: string; totals: { distanceM: number } } | null };
      };
    };
    await openCity(page);
    await page.getByTestId('mode-coverage').click();
    await page.getByTestId('cam-top').click();
    await waitForCamera(page);
    const box = (await page.getByTestId('city-stage').boundingBox())!;
    const [cx, cy] = await page.evaluate(() => (window as unknown as W).__sweepCity.state().city.focus?.xy ?? [0, 0]);
    const click = async (x: number, y: number) => {
      const p = (await page.evaluate(([a, b]) => (window as unknown as W).__sweepCity.project(a!, b!, 0), [x, y]))!;
      await page.mouse.click(box.x + ((p[0] + 1) / 2) * box.width, box.y + ((1 - p[1]) / 2) * box.height);
    };
    const cov = () => page.evaluate(() => (window as unknown as W).__sweepCity.coverage());
    const engineTotal = (zone: Z, direction: 'directed' | 'undirected', depot: number) => {
      const depotId = `n${city.nodeOsm[depot]}`;
      const zg = zoneCoverageGraph(city, { zone, direction, depotId });
      const exp = solveZoneCoverage(zg.graph, { direction, depotId });
      if (!exp.ok) throw new Error(exp.message);
      return exp;
    };

    // Circle: centre on the VIT focus point, rim about 300 m east.
    await page.getByTestId('cov-shape-circle').click();
    await page.getByTestId('cov-draw-zone').click();
    await expect(page.getByTestId('cov-zone')).toHaveText('Click the centre');
    await click(cx, cy);
    await expect(page.getByTestId('cov-zone')).toHaveText('Click a point on the edge');
    await click(cx + 300, cy);
    await expect(page.getByTestId('cov-zone')).toContainText('Radius');
    await expect(page.getByTestId('cov-draw-zone')).toHaveAttribute('aria-pressed', 'false');
    const circle = (await cov()).zone!;
    expect(circle.kind).toBe('circle');
    if (circle.kind === 'circle') expect(Math.abs(circle.r - 300)).toBeLessThan(20); // one screen pixel is a few metres from above

    // Depot: the intersection nearest the centre.
    const node = await page.evaluate(([x, y]) => {
      const c = (window as unknown as W).__sweepCity.state().city;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < c.nodeCount; i++) {
        const d = (c.nodeX[i]! - x!) ** 2 + (c.nodeY[i]! - y!) ** 2;
        if (d < bd) [best, bd] = [i, d];
      }
      return { x: c.nodeX[best]!, y: c.nodeY[best]! };
    }, [cx, cy]);
    await page.getByTestId('pick-depot').click();
    await click(node.x, node.y);
    await expect(page.getByTestId('cov-depot')).not.toHaveText(/Not set|Click/);
    await page.getByTestId('cov-run').click();
    await expect(page.getByTestId('cov-results')).toBeVisible({ timeout: 90_000 });
    let st = await cov();
    const expCircle = engineTotal(st.zone!, 'directed', st.depot!);
    expect(st.result!.method).toBe(expCircle.method);
    expect(Math.abs(st.result!.totals.distanceM - expCircle.route.totalDistance)).toBeLessThan(1e-6);

    // Free outline: points that would cross the outline are refused; undo removes the last point.
    await page.getByTestId('cov-shape-polygon').click();
    await page.getByTestId('cov-draw-zone').click();
    await click(cx - 300, cy - 200);
    await click(cx + 250, cy - 250);
    await click(cx + 350, cy + 150);
    await expect(page.getByTestId('cov-zone-finish')).toBeEnabled();
    await click(cx - 100, cy - 500); // this edge would cut through the first edge
    await expect(page.getByTestId('cov-zone-hint')).toContainText('cross');
    expect((await cov()).draft).toHaveLength(3);
    await click(cx + 600, cy + 600);
    await page.getByTestId('cov-zone-undo').click();
    expect((await cov()).draft).toHaveLength(3);
    await click(cx, cy + 300);
    await click(cx - 280, cy + 180);
    await expect(page.getByTestId('cov-zone')).toContainText('5 points');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('cov-zone')).toContainText('5-point outline');
    await expect(page.getByTestId('cov-stale')).toBeVisible();
    await page.getByTestId('cov-dir-undirected').click();
    await page.getByTestId('cov-run').click();
    await expect(page.getByTestId('cov-stale')).toHaveCount(0, { timeout: 90_000 });
    st = await cov();
    expect(st.zone!.kind).toBe('polygon');
    const expPoly = engineTotal(st.zone!, 'undirected', st.depot!);
    expect(st.result!.direction).toBe('undirected');
    expect(st.result!.method).toBe(expPoly.method);
    expect(Math.abs(st.result!.totals.distanceM - expPoly.route.totalDistance)).toBeLessThan(1e-6);
    await page.getByTestId('cov-open-report').click();
    await expect(page.getByTestId('rep-zone')).toHaveText(await page.getByTestId('cov-zone').innerText());
  });

  test('a multi-vehicle fleet with a shift limit shows the engine plan, its bounds and every over-shift vehicle', async ({ page }) => {
    type R = { seconds: number; distanceM: number; arcs: Int32Array; feasible: { shift: boolean } };
    type W = {
      __sweepCity: {
        project: (x: number, y: number, h: number) => [number, number] | null;
        state: () => { city: { focus: { xy: [number, number] } | null; nodeX: Float64Array; nodeY: Float64Array; nodeCount: number } };
        coverage: () => {
          zone: { kind: 'rect'; minX: number; minY: number; maxX: number; maxY: number } | null;
          depot: number | null;
          result: { routes: R[]; fleet: { totals: { makespanSeconds: number; distance: number; vehiclesUsed: number }; lowerBounds: { makespanSeconds: { value: number }; vehiclesByShift: number | null; totalDistance: { value: number } }; feasibility: { ok: boolean } } | null } | null;
        };
      };
    };
    await openCity(page);
    await page.getByTestId('mode-coverage').click();
    await page.getByTestId('cam-top').click();
    await waitForCamera(page);
    const box = (await page.getByTestId('city-stage').boundingBox())!;
    const [cx, cy] = await page.evaluate(() => (window as unknown as W).__sweepCity.state().city.focus?.xy ?? [0, 0]);
    const click = async (x: number, y: number) => {
      const p = (await page.evaluate(([a, b]) => (window as unknown as W).__sweepCity.project(a!, b!, 0), [x, y]))!;
      await page.mouse.click(box.x + ((p[0] + 1) / 2) * box.width, box.y + ((1 - p[1]) / 2) * box.height);
    };
    await page.getByTestId('cov-draw-zone').click();
    await click(cx - 250, cy - 200);
    await click(cx + 250, cy + 200);
    const node = await page.evaluate(([x, y]) => {
      const c = (window as unknown as W).__sweepCity.state().city;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < c.nodeCount; i++) {
        const d = (c.nodeX[i]! - x!) ** 2 + (c.nodeY[i]! - y!) ** 2;
        if (d < bd) [best, bd] = [i, d];
      }
      return { x: c.nodeX[best]!, y: c.nodeY[best]! };
    }, [cx, cy]);
    await page.getByTestId('pick-depot').click();
    await click(node.x, node.y);
    await expect(page.getByTestId('cov-depot')).not.toHaveText(/Not set|Click/);
    await page.getByTestId('cov-vehicles').fill('3');

    const plan = async (shiftHours: number) => {
      await page.getByTestId('cov-shift').fill(String(shiftHours));
      await page.getByTestId('cov-run').click();
      await expect(page.getByTestId('cov-fleet-guarantee')).toBeVisible({ timeout: 90_000 });
      await expect(page.getByTestId('cov-stale')).toHaveCount(0, { timeout: 90_000 });
      const st = await page.evaluate(() => (window as unknown as W).__sweepCity.coverage());
      const depotId = `n${city.nodeOsm[st.depot!]}`;
      const zg = zoneCoverageGraph(city, { zone: st.zone!, direction: 'directed', depotId });
      const cov = solveZoneCoverage(zg.graph, { direction: 'directed', depotId });
      if (!cov.ok) throw new Error(cov.message);
      const fp = planFleet(cov.graph, { vehicles: 3, depotId, dumpId: null, direction: 'directed', objective: 'min-makespan', capacity: null, demandPerKm: 0, shiftSeconds: shiftHours * 3600, serviceSpeedKmh: 8, deadheadSpeedKmh: 20, dumpSeconds: 0, coverage: cov });
      if (!fp.ok) throw new Error(fp.message);
      const r = st.result!;
      // The UI shows the engine's own plan: same routes, totals and valid lower bounds.
      expect(r.routes).toHaveLength(fp.routes.length);
      fp.routes.forEach((v, i) => {
        expect(Math.abs(r.routes[i]!.distanceM - v.distance)).toBeLessThan(1e-6);
        expect(Math.abs(r.routes[i]!.seconds - v.seconds)).toBeLessThan(1e-6);
        expect(r.routes[i]!.feasible.shift).toBe(v.feasible.shift);
      });
      expect(Math.abs(r.fleet!.totals.makespanSeconds - fp.totals.makespanSeconds)).toBeLessThan(1e-6);
      expect(r.fleet!.totals.vehiclesUsed).toBe(fp.totals.vehiclesUsed);
      expect(Math.abs(r.fleet!.lowerBounds.makespanSeconds.value - fp.lowerBounds.makespanSeconds.value)).toBeLessThan(1e-6);
      // The makespan bound holds for plans with at most 3 vehicles. When the limits force more routes, the plan is a
      // diagnosis: it gets no makespan gap, and the UI must say how many routes it needs instead of showing a gap.
      if (fp.routes.length <= 3) {
        expect(r.fleet!.lowerBounds.makespanSeconds.value).toBeLessThanOrEqual(r.fleet!.totals.makespanSeconds + 1e-6);
        await expect(page.getByTestId('cov-overfleet')).toHaveCount(0);
      } else {
        expect(fp.gaps.makespan).toBeNull();
        await expect(page.getByTestId('cov-overfleet')).toContainText(`uses ${fp.routes.length} routes`);
        await expect(page.getByTestId('cov-vehicles-used')).toContainText(`${fp.routes.length} routes needed, 3 available`);
        await expect(page.getByTestId('cov-makespan')).not.toContainText('gap');
      }
      expect(r.fleet!.lowerBounds.totalDistance.value).toBeLessThanOrEqual(fp.totals.distance + 1e-6);
      expect(r.fleet!.lowerBounds.vehiclesByShift).toBe(fp.lowerBounds.vehiclesByShift);
      // The headline is what the vehicles drive, which includes their trips from and back to the depot.
      expect(fp.totals.distance).toBeGreaterThanOrEqual(cov.route.totalDistance - 1e-6);
      await expect(page.getByTestId('cov-total')).toHaveText(fmtDist(fp.totals.distance));
      await expect(page.getByTestId('cov-single')).toContainText(fmtDist(cov.route.totalDistance));
      await expect(page.getByTestId('cov-feasible')).toHaveText(fp.feasibility.ok ? 'yes' : /^no: /);
      // Timeline: one row per vehicle; at the end of the shift every used vehicle is back, and exactly the vehicles over the limit are flagged.
      await expect(page.locator('[data-testid^="tl-vehicle-"]')).toHaveCount(fp.routes.length);
      const max = Number(await page.getByTestId('tl-scrub').getAttribute('max'));
      expect(Math.abs(max - Math.ceil(fp.totals.makespanSeconds))).toBeLessThanOrEqual(1);
      await page.getByTestId('tl-scrub').fill(String(max));
      for (const [i, v] of fp.routes.entries()) {
        if (v.steps.length) await expect(page.getByTestId(`tl-progress-${i}`)).toHaveText('100 %');
        await expect(page.getByTestId(`tl-vehicle-${i}`).getByText(/over shift by/)).toHaveCount(v.seconds > shiftHours * 3600 ? 1 : 0);
      }
      return fp;
    };

    // A full-day limit: nothing is flagged.
    const loose = await plan(24);
    expect(loose.feasibility.ok).toBe(true);
    await expect(page.getByText(/over shift by/)).toHaveCount(0);
    // A quarter-hour limit: the engine's makespan bound already exceeds it, so no 3-route plan can meet the shift; the engine
    // diagnoses with more routes, and the UI must say the fleet is too small rather than show a gap.
    const tight = await plan(0.25);
    expect(tight.lowerBounds.makespanSeconds.value).toBeGreaterThan(0.25 * 3600);
    expect(tight.feasibility.ok).toBe(false);
    expect(tight.routes.length).toBeGreaterThan(3);
    await expect(page.getByTestId('cov-makespan')).toContainText('lower bound');

    // Scenario with a different operation: 2 vehicles from another depot and a higher fuel price, on the same streets.
    const base = await plan(24);
    await page.getByTestId('cost-fuel-service').fill('40');
    await page.getByTestId('cost-fuel-transit').fill('25');
    await page.getByTestId('cost-fuel-price').fill('100');
    await page.getByTestId('cost-crew').fill('2');
    await page.getByTestId('cost-wage').fill('150');
    const other = await page.evaluate(([x, y]) => {
      const c = (window as unknown as W).__sweepCity.state().city;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < c.nodeCount; i++) {
        const d = (c.nodeX[i]! - x!) ** 2 + (c.nodeY[i]! - y!) ** 2;
        if (d < bd) [best, bd] = [i, d];
      }
      return { x: c.nodeX[best]!, y: c.nodeY[best]! };
    }, [cx + 180, cy + 140]);
    await page.getByTestId('mode-scenarios').click();
    await page.getByTestId('scenario-vehicles').fill('2');
    await expect(page.getByTestId('scenario-custom')).toContainText('Operations change');
    await page.getByTestId('scenario-fuel-price').fill('120');
    await page.getByTestId('pick-scenario-depot').click();
    await click(other.x, other.y);
    await expect(page.getByTestId('scenario-depot')).not.toHaveText(/as panel|Click/);
    await expect(page.getByTestId('scenario-custom')).toContainText('3 operation changes');
    await page.getByTestId('mode-coverage').click();
    await expect(page.getByTestId('cov-overrides')).toContainText('2 vehicles');
    await expect(page.getByTestId('cov-stale')).toBeVisible();
    await page.getByTestId('cov-compare').click();
    await expect(page.getByTestId('cov-comparison')).toBeVisible({ timeout: 90_000 });
    type S = { distanceM: number; serviceM: number; transitM: number; vehicleSeconds: number; vehiclesUsed: number };
    const { cmp, sd, bd } = await page.evaluate(() => {
      const w = window as unknown as { __sweepCity: { coverage: () => { depot: number; comparison: { baseline: S; scenario: S } }; scenarios: () => { active: () => { plan?: { depot?: number } } } } };
      return { cmp: w.__sweepCity.coverage().comparison, sd: w.__sweepCity.scenarios().active().plan!.depot!, bd: w.__sweepCity.coverage().depot };
    });
    expect(sd).not.toBe(bd);
    const zone = (await page.evaluate(() => (window as unknown as W).__sweepCity.coverage().zone))!;
    const fleetFrom = (depot: number, vehicles: number) => {
      const depotId = `n${city.nodeOsm[depot]}`;
      const zg = zoneCoverageGraph(city, { zone, direction: 'directed', depotId });
      const cv = solveZoneCoverage(zg.graph, { direction: 'directed', depotId });
      if (!cv.ok) throw new Error(cv.message);
      const fp = planFleet(cv.graph, { vehicles, depotId, dumpId: null, direction: 'directed', objective: 'min-makespan', capacity: null, demandPerKm: 0, shiftSeconds: 24 * 3600, serviceSpeedKmh: 8, deadheadSpeedKmh: 20, dumpSeconds: 0, coverage: cv });
      if (!fp.ok) throw new Error(fp.message);
      return fp;
    };
    const expScenario = fleetFrom(sd, 2);
    expect(Math.abs(cmp.baseline.distanceM - base.totals.distance)).toBeLessThan(1e-6);
    expect(cmp.baseline.vehiclesUsed).toBe(base.totals.vehiclesUsed);
    expect(Math.abs(cmp.scenario.distanceM - expScenario.totals.distance)).toBeLessThan(1e-6);
    expect(cmp.scenario.vehiclesUsed).toBe(expScenario.totals.vehiclesUsed);
    await expect(page.getByTestId('cmp-vehicles').locator('td').nth(1)).toHaveText(String(expScenario.totals.vehiclesUsed));
    // Cost from each side's own assumptions: fuel at ₹100/L for the baseline, ₹120/L for the scenario; 2 crew at ₹150/h.
    const cost = (p: S, price: number) => ((p.serviceM / 1000) * 0.4 + (p.transitM / 1000) * 0.25) * price + (p.vehicleSeconds / 3600) * 2 * 150;
    await expect(page.getByTestId('cmp-cost').locator('td').nth(0)).toHaveText(inr(cost(cmp.baseline, 100)));
    await expect(page.getByTestId('cmp-cost').locator('td').nth(1)).toHaveText(inr(cost(cmp.scenario, 120)));
    await expect(page.getByTestId('cmp-fuel').locator('td').nth(2)).toHaveText(/^[+−]\d/);
  });

  test('coverage plan of a drawn zone matches the engine, with honest method and guarantee labels', async ({ page }) => {
    await openCity(page);
    await page.getByTestId('mode-coverage').click();
    await page.getByTestId('cam-top').click();
    await waitForCamera(page);
    const box = (await page.getByTestId('city-stage').boundingBox())!;
    type W = { __sweepCity: { project: (x: number, y: number, h: number) => [number, number] | null; state: () => { city: { focus: { xy: [number, number] } | null; nodeX: Float64Array; nodeY: Float64Array; nodeCount: number } }; coverage: () => { zone: { minX: number; minY: number; maxX: number; maxY: number } | null; depot: number | null; result: { method: string; optimal: boolean; gap: number | null; lowerBoundM: number | null; totals: { distanceM: number } } | null } } };
    const screen = async (x: number, y: number) => {
      const p = (await page.evaluate(([a, b]) => (window as unknown as W).__sweepCity.project(a!, b!, 0), [x, y]))!;
      return [box.x + ((p[0] + 1) / 2) * box.width, box.y + ((1 - p[1]) / 2) * box.height] as const;
    };
    const centre = await page.evaluate(() => {
      const c = (window as unknown as W).__sweepCity.state().city;
      return c.focus?.xy ?? [0, 0];
    });
    // A zone of roughly 500 m × 400 m around the VIT focus point, drawn with two clicks.
    await page.getByTestId('cov-draw-zone').click();
    let [sx, sy] = await screen(centre[0] - 250, centre[1] - 200);
    await page.mouse.click(sx, sy);
    [sx, sy] = await screen(centre[0] + 250, centre[1] + 200);
    await page.mouse.click(sx, sy);
    await expect(page.getByTestId('cov-zone')).toContainText('km²');
    // Depot: the intersection nearest the zone centre.
    const node = await page.evaluate(([cx, cy]) => {
      const c = (window as unknown as W).__sweepCity.state().city;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < c.nodeCount; i++) {
        const d = (c.nodeX[i]! - cx!) ** 2 + (c.nodeY[i]! - cy!) ** 2;
        if (d < bd) [best, bd] = [i, d];
      }
      return { i: best, x: c.nodeX[best]!, y: c.nodeY[best]! };
    }, centre);
    await page.getByTestId('pick-depot').click();
    [sx, sy] = await screen(node.x, node.y);
    await page.mouse.click(sx, sy);
    await expect(page.getByTestId('cov-depot')).not.toHaveText(/Not set|Click/);

    // Directed (respect one-ways): exact min-cost flow, and the UI shows the engine's own optimum.
    await page.getByTestId('cov-run').click();
    await expect(page.getByTestId('cov-results')).toBeVisible({ timeout: 90_000 });
    const st = await page.evaluate(() => (window as unknown as W).__sweepCity.coverage());
    const zone = { kind: 'rect' as const, ...st.zone! };
    const depotId = `n${city.nodeOsm[st.depot!]}`;
    const zg = zoneCoverageGraph(city, { zone, direction: 'directed', depotId });
    const exp = solveZoneCoverage(zg.graph, { direction: 'directed', depotId });
    if (!exp.ok) throw new Error(exp.message);
    expect(st.result!.method).toBe('exact-directed-min-cost-flow');
    expect(Math.abs(st.result!.totals.distanceM - exp.route.totalDistance)).toBeLessThan(1e-6);
    await expect(page.getByTestId('cov-method')).toContainText('Exact · directed min-cost flow');
    await expect(page.getByTestId('cov-method')).not.toContainText('undirected');
    if (!exp.optimal) await expect(page.getByTestId('cov-optimal')).not.toHaveText('Proven optimal');

    // Shift timeline: a deterministic clock over the planned route, scrubbable end to end.
    await expect(page.getByTestId('shift-timeline')).toBeVisible();
    await expect(page.getByTestId('tl-clock')).toHaveText('06:00');
    await expect(page.getByTestId('tl-progress-0')).toHaveText('0 %');
    const max = Number(await page.getByTestId('tl-scrub').getAttribute('max'));
    // Service 8 km/h, transit 20 km/h (the defaults): the end of the shift is the engine route timed at those speeds.
    const expS = (exp.route.serviceDistance / 1000 / 8 + (exp.route.totalDistance - exp.route.serviceDistance) / 1000 / 20) * 3600;
    expect(Math.abs(max - Math.ceil(expS))).toBeLessThanOrEqual(1);
    await page.getByTestId('tl-scrub').fill(String(max));
    await expect(page.getByTestId('tl-progress-0')).toHaveText('100 %');
    await expect(page.getByTestId('tl-vehicle-0')).toContainText('back at depot');

    // Exports follow the same plan: one CSV row per engine route step, ending at the engine's total, and one GPX track.
    const [csvFile] = await Promise.all([page.waitForEvent('download'), page.getByTestId('cov-export-csv').click()]);
    const csv = readFileSync((await csvFile.path())!, 'utf8').trim().split('\r\n');
    expect(csv).toHaveLength(1 + exp.route.steps.length);
    expect(csv[1]!.split(',')[9]).toBe('06:00:00');
    expect(Math.abs(Number(csv[csv.length - 1]!.split(',').at(-1)) - exp.route.totalDistance / 1000)).toBeLessThan(0.0015);
    const [gpxFile] = await Promise.all([page.waitForEvent('download'), page.getByTestId('cov-export-gpx').click()]);
    const gpx = readFileSync((await gpxFile.path())!, 'utf8');
    expect(gpx.match(/<trk>/g)).toHaveLength(1);
    expect(gpx).toContain('OpenStreetMap contributors');

    // Cost model: nothing is shown until assumptions are entered; then fuel and CO₂ follow from the plan's distances.
    await expect(page.getByTestId('cost-fuel')).toHaveText('enter both fuel rates');
    await page.getByTestId('cost-fuel-service').fill('40');
    await page.getByTestId('cost-fuel-transit').fill('25');
    const fuel = (exp.route.serviceDistance / 1000) * 0.4 + ((exp.route.totalDistance - exp.route.serviceDistance) / 1000) * 0.25;
    await expect(page.getByTestId('cost-fuel')).toHaveText(`${fuel.toFixed(1)} L`);
    await expect(page.getByTestId('cost-co2-kg')).toHaveText(`${(fuel * 2.68).toFixed(1)} kg`);
    await expect(page.getByTestId('cost-total')).toHaveText('–');

    // Undirected relaxation: a different problem, labelled as such; a heuristic never claims optimality.
    await page.getByTestId('cov-dir-undirected').click();
    await expect(page.getByTestId('cov-stale')).toBeVisible();
    await page.getByTestId('cov-run').click();
    await expect(page.getByTestId('cov-stale')).toHaveCount(0, { timeout: 90_000 });
    const st2 = await page.evaluate(() => (window as unknown as W).__sweepCity.coverage());
    const zg2 = zoneCoverageGraph(city, { zone, direction: 'undirected', depotId });
    const exp2 = solveZoneCoverage(zg2.graph, { direction: 'undirected', depotId });
    if (!exp2.ok) throw new Error(exp2.message);
    expect(st2.result!.method).toBe(exp2.method);
    expect(Math.abs(st2.result!.totals.distanceM - exp2.route.totalDistance)).toBeLessThan(1e-6);
    await expect(page.getByTestId('cov-wrongway')).toBeVisible();
    if (exp2.method === 'heuristic-candidate-matching') await expect(page.getByTestId('cov-optimal')).toContainText('Within');
    if (st2.result!.lowerBoundM !== null) expect(st2.result!.lowerBoundM).toBeLessThanOrEqual(st2.result!.totals.distanceM + 1e-6);

    // Printable report reads the same plan.
    await page.getByTestId('cov-open-report').click();
    await expect(page.getByTestId('rep-total')).toHaveText(await page.getByTestId('cov-total').innerText());
    await expect(page.getByTestId('rep-tiles')).toContainText(`${city.provenance.tiles.ok} of ${city.provenance.tiles.total}`);
    await page.getByTestId('cov-report-close').click();

    // Scenario: close one required street in the zone; both plans are recomputed and match the engine.
    const seg = zg2.edgeSegment[zg2.graph.edges.findIndex((e) => e.required && e.u !== depotId && e.v !== depotId)]!;
    await page.evaluate((sg) => {
      const sc = (window as unknown as { __sweepCity: { scenarios: () => { create: () => void; toggleClosed: (s: number) => void } } }).__sweepCity.scenarios();
      sc.create();
      sc.toggleClosed(sg);
    }, seg);
    await page.getByTestId('cov-compare').click();
    await expect(page.getByTestId('cov-comparison')).toBeVisible({ timeout: 90_000 });
    const cmp = await page.evaluate(() => (window as unknown as { __sweepCity: { coverage: () => { comparison: { baseline: { distanceM: number }; scenario: { distanceM: number } } } } }).__sweepCity.coverage().comparison);
    const zg3 = zoneCoverageGraph(city, { zone, direction: 'undirected', depotId, closedSegments: [seg] });
    const exp3 = solveZoneCoverage(zg3.graph, { direction: 'undirected', depotId });
    if (!exp3.ok) throw new Error(exp3.message);
    expect(Math.abs(cmp.baseline.distanceM - exp2.route.totalDistance)).toBeLessThan(1e-6);
    expect(Math.abs(cmp.scenario.distanceM - exp3.route.totalDistance)).toBeLessThan(1e-6);
  });
});
