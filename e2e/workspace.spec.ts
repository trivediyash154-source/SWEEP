import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { getExample, solveRouting } from './engine';

const km = (m: number): string => (m < 1000 ? `${m.toLocaleString('en-US', { maximumFractionDigits: 1 })} m` : `${(m / 1000).toFixed(2)} km`);

/** Engine result for an example with its own routing settings (plus overrides). */
function expected(id: string, override?: Parameters<typeof solveRouting>[1]) {
  const r = solveRouting(getExample(id)!.graph, override);
  if (!r.ok) throw new Error(`engine failed for ${id}`);
  return r;
}

async function solved(page: Page) {
  await expect(page.getByTestId('solver-status')).toBeVisible();
}

async function surface(page: Page, id: string) {
  await page.getByTestId(`nav-${id}`).click();
  await expect(page.locator(`#surface-${id}`)).toBeInViewport({ ratio: 0.1 });
}

test.describe('workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('sweep.e2e.keep')) {
          for (const k of Object.keys(localStorage)) if (k.startsWith('sweep.') && k !== 'sweep.theme') localStorage.removeItem(k);
        }
      } catch {
        /* ignore */
      }
    });
  });

  test('opens straight into a solved city without signing in', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/workspace');
    await solved(page);
    const r = expected('meridian-district');
    await expect(page.getByTestId('total-distance')).toHaveText(km(r.single.route.totalDistance));
    await expect(page.getByTestId('solver-status')).toContainText('Exact');
    await expect(page.getByTestId('route-summary')).toContainText(km(r.single.route.totalDistance));
    await expect(page.locator('[data-testid=sim-stage] canvas').first().or(page.getByTestId('sim-2d'))).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('loads a bundled network and compares the exact route with real baselines', async ({ page }) => {
    await page.goto('/workspace');
    await solved(page);
    await surface(page, 'editor');
    await page.getByTestId('example-greedy-trap').click();
    await expect(page.getByTestId('total-distance')).toHaveText('360 m');
    await surface(page, 'laboratory');
    await expect(page.getByTestId('compare-optimal')).toContainText('360 m');
    // greedy pairing adds 140 m instead of 80 m: 280 + 140 = 420 m, a real valid route
    await expect(page.getByTestId('compare-greedy-pairing')).toContainText('420 m');
    await expect(page.getByTestId('compare-lower-bound')).toContainText('not a route');
  });

  test('switches the main stage between 3D and 2D', async ({ page }) => {
    await page.goto('/workspace?example=konigsberg');
    await solved(page);
    await page.getByTestId('stage-2d').click();
    await expect(page.getByTestId('sim-2d')).toBeVisible();
    await page.getByTestId('stage-3d').click();
    await expect(page.getByTestId('sim-2d')).toHaveCount(0);
  });

  test('builds and edits a network; changes propagate and re-solve automatically', async ({ page }) => {
    await page.goto('/workspace');
    await solved(page);
    await surface(page, 'editor');
    await page.getByTestId('new-blank').click();
    await expect(page.getByText('An empty district.')).toBeVisible();
    const canvas = page.getByTestId('network-canvas');
    await canvas.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = (await canvas.boundingBox())!;
    const pts = [
      [0.35, 0.35],
      [0.65, 0.35],
      [0.65, 0.65],
      [0.35, 0.65],
    ] as const;
    for (const [fx, fy] of pts) await canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
    await expect(page.locator('[data-vid]')).toHaveCount(4);
    await page.getByTestId('tool-connect').click();
    for (const id of ['v0', 'v1', 'v2', 'v3', 'v0']) await page.locator(`[data-vid="${id}"]`).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-eid]')).toHaveCount(4);
    await page.locator('[data-vid="v0"]').click();
    await page.locator('[data-vid="v2"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-eid]')).toHaveCount(5);
    // Auto-solve has produced a route for the square with a diagonal.
    await expect(page.getByTestId('route-summary')).toContainText('steps');
    const before = await page.getByTestId('total-distance').textContent();
    // Change a length through the inspector.
    await page.getByTestId('tool-select').click();
    await page.locator('[data-eid="e4"]').click({ force: true });
    await page.getByTestId('edge-weight').fill('500');
    await page.getByTestId('edge-weight').press('Enter');
    await expect(page.getByTestId('total-distance')).not.toHaveText(before!);
    // Mark a street optional: the route still verifies.
    await page.locator('label.switch', { hasText: 'Required service street' }).click();
    await expect(page.getByTestId('edge-required')).not.toBeChecked();
    await expect(page.getByTestId('solver-status')).toContainText('Exact');
    // Undo restores the previous state and the route follows.
    await page.getByTestId('undo').click();
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('total-distance')).toHaveText(before!);
  });

  test('plays, pauses and changes the speed of the vehicle on the computed route', async ({ page }) => {
    await page.goto('/workspace?example=riverside-ladder');
    await solved(page);
    const readout = page.getByTestId('playback-readout');
    await expect(readout).toContainText('0 m');
    await page.getByTestId('speed-2').click();
    await expect(page.getByTestId('speed-2')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('route-play').click();
    await page.waitForTimeout(1500);
    await page.getByTestId('route-play').click();
    const paused = await readout.textContent();
    expect(paused).not.toContain('Travelled0 m');
    await page.waitForTimeout(600);
    expect(await readout.textContent()).toBe(paused);
    await page.getByTestId('camera-reset').click();
    await page.getByTestId('camera-top').click();
    await page.getByTestId('camera-route').click();
  });

  test('investigates the algorithm: odd vertices, shortest paths, matching, verification', async ({ page }) => {
    await page.goto('/workspace?example=old-town-grid');
    await solved(page);
    const r = expected('old-town-grid');
    if (r.single.mode !== 'undirected') throw new Error('expected undirected');
    await page.getByTestId('hdr-math').click();
    await expect(page.getByTestId('math-overview')).toContainText(`${r.single.oddVertexIds.length} odd`);
    await page.getByTestId('math-step-odd').click();
    const odd = r.single.oddVertexIds[0]!;
    await page.getByTestId(`vchip-${odd}`).click();
    await page.getByTestId('math-next').click();
    await expect(page.getByTestId('math-panel')).toContainText('Shortest paths');
    await page.getByRole('button', { name: new RegExp(`Shortest path ${r.single.oddVertexIds[0]} to ${r.single.oddVertexIds[1]}`) }).click();
    await expect(page.getByTestId('math-panel')).toContainText(`Showing ${r.single.oddVertexIds[0]} → ${r.single.oddVertexIds[1]}`);
    await page.getByTestId('math-next').click();
    await expect(page.getByTestId('math-panel')).toContainText('Minimum-weight matching');
    await page.getByTestId('pair-0').click();
    await page.getByTestId('math-step-verify').click();
    await expect(page.getByTestId('math-panel').locator('li.is-pass')).toHaveCount(r.single.checks.length);
  });

  test('verification surface lists every independent check as passed', async ({ page }) => {
    await page.goto('/workspace?example=four-corners');
    await solved(page);
    await surface(page, 'verification');
    const r = expected('four-corners');
    await expect(page.getByTestId('ver-verdict')).toContainText('Optimal and verified');
    for (const c of r.single.checks) await expect(page.getByTestId(`check-${c.id}`)).toHaveClass(/is-pass/);
  });

  test('changes theme across the workspace', async ({ page }) => {
    await page.goto('/workspace?example=konigsberg');
    await solved(page);
    await page.getByRole('button', { name: 'Porcelain' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'porcelain');
    await page.getByRole('button', { name: 'Velvet' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'velvet');
  });

  test('saves a scenario locally and reopens it after a reload', async ({ page }) => {
    await page.goto('/workspace?example=heritage-loop');
    await solved(page);
    await page.getByTestId('scenario-name').fill('Night sweep');
    await surface(page, 'history');
    await page.getByTestId('save-local').click();
    await expect(page.getByTestId('saved-scenarios')).toContainText('Night sweep');
    await expect(page.getByTestId('experiment-log')).toBeVisible();
    await page.evaluate(() => sessionStorage.setItem('sweep.e2e.keep', '1'));
    await page.goto('/workspace?example=konigsberg');
    await solved(page);
    await surface(page, 'history');
    await page.getByTestId('saved-scenarios').locator('[data-testid^="open-scenario-"]', { hasText: 'Night sweep' }).click();
    await expect(page.getByTestId('scenario-name')).toHaveValue('Night sweep');
    await expect(page.getByTestId('total-distance')).toHaveText(km(expected('heritage-loop').single.route.totalDistance));
  });

  test('exports JSON and CSV that agree with the computation', async ({ page }) => {
    await page.goto('/workspace?example=konigsberg');
    await solved(page);
    await surface(page, 'export');
    const r = expected('konigsberg');
    const [json] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
    const doc = JSON.parse(readFileSync((await json.path())!, 'utf8'));
    expect(doc.result.route.totalDistance).toBe(r.single.route.totalDistance);
    expect(doc.graph.edges).toHaveLength(7);
    expect(doc.settings.mode).toBe('undirected');
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-route-csv').click()]);
    const lines = readFileSync((await csv.path())!, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(r.single.route.steps.length + 1);
    expect(Number(lines.at(-1)!.split(',').at(-1))).toBe(r.single.route.totalDistance);
    await page.getByTestId('export-report').click();
    await expect(page.getByTestId('report')).toContainText(km(r.single.route.totalDistance));
  });

  test('solves the real Zurich OSM sample in directed mode and compares it with the two-way relaxation', async ({ page }) => {
    await page.goto('/workspace?example=zurich-altstadt');
    await solved(page);
    const directed = expected('zurich-altstadt');
    const relaxed = expected('zurich-altstadt', { mode: 'undirected', ignoreOneway: true });
    expect(directed.single.mode).toBe('directed');
    await expect(page.getByTestId('total-distance')).toHaveText(km(directed.single.route.totalDistance));
    await expect(page.getByTestId('route-summary')).toContainText('directed');
    await expect(page.getByTestId('sim-attribution')).toContainText('© OpenStreetMap contributors');
    await surface(page, 'laboratory');
    await page.getByTestId('run-relax').click();
    await expect(page.getByTestId('relax-wrongway')).toHaveText(String(relaxed.single.route.wrongWayTraversals));
    expect(relaxed.single.route.wrongWayTraversals).toBeGreaterThan(0);
    await page.getByTestId('hdr-math').click();
    await page.getByTestId('math-step-flow').click();
    await expect(page.getByTestId('math-panel')).toContainText('LP dual certificate');
  });

  test('plans a fleet: every vehicle animates its own route and the plan exports with validation', async ({ page }) => {
    await page.goto('/workspace?example=meridian-district');
    await solved(page);
    await page.getByTestId('hdr-vehicles').selectOption('3');
    await expect(page.getByTestId('vehicle-3')).toBeVisible();
    const fleet = expected('meridian-district', { vehicles: 3 }).fleet!;
    await expect(page.getByTestId('total-distance')).toHaveText(km(fleet.makespan));
    await expect(page.getByTestId('solver-status')).toContainText('Within 1.67× of optimal');
    await page.getByTestId('vehicle-2').click();
    await expect(page.getByTestId('vehicle-2')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('route-play').click();
    await page.waitForTimeout(800);
    await page.getByTestId('route-play').click();
    await surface(page, 'verification');
    await expect(page.locator('[data-testid^=check-]:not(.is-pass)')).toHaveCount(0);
    await surface(page, 'export');
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-fleet-csv').click()]);
    const rows = readFileSync((await csv.path())!, 'utf8').trim().split(/\r?\n/).slice(1);
    expect(rows).toHaveLength(fleet.routes.reduce((n, r) => n + r.steps.length, 0));
    expect(new Set(rows.map((r) => r.split(',')[0]))).toEqual(new Set(['1', '2', '3']));
    expect(rows.every((r) => r.endsWith(',true'))).toBe(true);
  });

  test('imports GeoJSON with a one-way dead end, explains why it is infeasible and fixes it', async ({ page }) => {
    await page.goto('/workspace');
    await solved(page);
    await surface(page, 'editor');
    await page.getByTestId('open-import-bar').click();
    await page.getByTestId('import-file').setInputFiles('e2e/fixtures/oneway-deadend.geojson');
    await expect(page.getByTestId('import-preview')).toContainText('one-way');
    await page.getByTestId('import-confirm').click();
    await expect(page.getByTestId('mode-directed')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('fix-infeasible')).toBeVisible();
    await page.getByTestId('fix-infeasible').click();
    await expect(page.getByTestId('solver-status')).toContainText('Exact');
  });

  test('acquires a map area through the acquisition dialog (provider response mocked)', async ({ page }) => {
    const sample = getExample('zurich-altstadt')!.graph;
    const graph = { ...sample, name: 'Acquired area', source: { ...sample.source!, kind: 'live-acquisition', retrievedAt: new Date().toISOString() } };
    await page.route('**/api/maps/acquire', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            graph,
            report: { stats: { ways: 144, nodes: 831, vertices: graph.vertices.length, edges: graph.edges.length, onewayEdges: 29, duplicateSegments: 0, droppedComponents: 0, droppedLength: 0, totalLength: 9000, skippedWays: 0 }, notes: [], roadClassesFound: { residential: 15 } },
            attempts: [{ endpoint: 'https://overpass.example/api/interpreter', host: 'overpass.example', ok: true, status: 200, ms: 120 }],
            cached: false,
            query: 'mocked',
          },
        }),
      }),
    );
    await page.goto('/workspace');
    await solved(page);
    await surface(page, 'editor');
    await page.getByTestId('open-map').click();
    await expect(page.getByTestId('map-dialog')).toBeVisible();
    await page.getByTestId('map-acquire').click();
    await expect(page.getByTestId('map-result')).toBeVisible();
    await page.getByTestId('map-load').click();
    await expect(page.getByTestId('scenario-name')).toHaveValue('Acquired area');
    await expect(page.getByTestId('sim-source')).toHaveText('Live map acquisition');
  });

  test('clears local data only after confirmation', async ({ page }) => {
    await page.goto('/workspace?example=konigsberg');
    await solved(page);
    await surface(page, 'history');
    await expect(page.getByTestId('experiment-log')).toBeVisible();
    await page.getByTestId('clear-data').click();
    await page.getByRole('button', { name: 'Keep my data' }).click();
    await expect(page.getByTestId('experiment-log')).toBeVisible();
    await page.getByTestId('clear-data').click();
    await page.getByTestId('confirm-clear').click();
    await expect(page.getByText('Local data cleared')).toBeVisible();
  });

  test('blossom field is present over the workspace and never blocks controls', async ({ page }) => {
    await page.goto('/workspace?example=konigsberg');
    await solved(page);
    const field = page.getByTestId('botanical-field');
    await expect(field).toHaveCount(1);
    await expect(field).toHaveCSS('pointer-events', 'none');
    for (let i = 0; i < 12; i++) await page.mouse.move(300 + i * 50, 420 + Math.sin(i) * 60);
    await page.getByTestId('stage-2d').click();
    await expect(page.getByTestId('sim-2d')).toBeVisible();
  });

  test('honours reduced motion: no blossom field and playback jumps to the finished route', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('/workspace?example=riverside-ladder');
    await solved(page);
    await expect(page.getByTestId('botanical-field')).toHaveCount(0);
    await page.getByTestId('route-play').click();
    await expect(page.getByTestId('playback-readout')).toContainText('100%');
    await ctx.close();
  });
});
