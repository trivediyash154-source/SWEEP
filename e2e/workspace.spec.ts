import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { getExample, solveChinesePostman } from './engine';

const km = (m: number): string => (m < 1000 ? `${m.toLocaleString('en-US', { maximumFractionDigits: 1 })} m` : `${(m / 1000).toFixed(2)} km`);

async function optimize(page: Page) {
  await page.getByTestId('optimize').click();
  await expect(page.getByTestId('results')).toBeVisible();
}

test.describe('workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('sweep.workspaceDraft.v1');
      } catch {
        /* ignore */
      }
    });
  });

  test('loads an example and shows the authoritative optimal route', async ({ page }) => {
    await page.goto('/workspace');
    await page.getByTestId('example-old-town-grid').click();
    await optimize(page);
    const expected = solveChinesePostman(getExample('old-town-grid')!.graph);
    if (!expected.ok) throw new Error('engine failed');
    await expect(page.getByTestId('total-distance')).toHaveText(km(expected.route.totalDistance));
    await expect(page.getByTestId('optimal-chip')).toBeVisible();
    const checks = page.getByTestId('checks').locator('li');
    await expect(checks).toHaveCount(expected.checks.length);
    await expect(page.getByTestId('checks').locator('li.is-fail')).toHaveCount(0);
  });

  test('exact matching beats greedy pairing on Crescent Quay', async ({ page }) => {
    await page.goto('/workspace?example=greedy-trap');
    await optimize(page);
    await expect(page.getByTestId('total-distance')).toHaveText('360 m');
    await expect(page.getByTestId('repeated-distance')).toContainText('80 m');
    await expect(page.getByText('Exact matching saves 60 m over greedy pairing')).toBeVisible();
  });

  test('builds a network from scratch, edits it and optimises', async ({ page }) => {
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Blank' }).click();
    await expect(page.getByText('An empty district.')).toBeVisible();
    const box = (await page.getByTestId('network-canvas').boundingBox())!;
    const pts = [
      [0.35, 0.35],
      [0.65, 0.35],
      [0.65, 0.65],
      [0.35, 0.65],
    ] as const;
    for (const [fx, fy] of pts) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await expect(page.locator('[data-vid]')).toHaveCount(4);
    await page.getByTestId('tool-connect').click();
    for (const id of ['v0', 'v1', 'v2', 'v3', 'v0']) await page.locator(`[data-vid="${id}"]`).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-eid]')).toHaveCount(4);
    // add a diagonal → two odd vertices
    await page.locator('[data-vid="v0"]').click();
    await page.locator('[data-vid="v2"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-eid]')).toHaveCount(5);
    // edit the diagonal's length through the inspector
    await page.getByTestId('tool-select').click();
    await page.locator('[data-eid="e4"]').click({ force: true });
    await page.getByTestId('edge-weight').fill('500');
    await page.getByTestId('edge-weight').press('Enter');
    await optimize(page);
    // square sides + diagonal 500, plus the cheapest v0↔v2 path duplicated
    const total = await page.getByTestId('total-distance').textContent();
    expect(total).toMatch(/m$/);
    await expect(page.getByTestId('checks').locator('li.is-fail')).toHaveCount(0);
    // undo restores the previous length and marks the result stale
    await page.keyboard.press('Control+z');
    await expect(page.getByText('The network changed after this route was computed')).toBeVisible();
  });

  test('explains the algorithm step by step from the actual record', async ({ page }) => {
    await page.goto('/workspace?example=old-town-grid');
    await optimize(page);
    await page.getByTestId('view-explain').click();
    await expect(page.getByTestId('explain-text')).toContainText('intersections and 24 streets');
    await page.getByTestId('explain-next').click();
    await expect(page.getByTestId('explain-text')).toContainText('8 intersections have odd degree');
    await page.getByTestId('explain-next').click();
    await page.getByTestId('explain-next').click();
    await expect(page.getByTestId('explain-text')).toContainText("Edmonds' blossom algorithm");
    await page.getByRole('button', { name: 'Step 7: Verification' }).click();
    await expect(page.getByTestId('explain-text')).toContainText('checks passed');
  });

  test('explains disconnected required streets and offers connectors', async ({ page }) => {
    await page.goto('/workspace?example=twin-districts');
    await expect(page.getByTestId('optimize')).toBeDisabled();
    await expect(page.getByText(/Rural Postman Problem/).first()).toBeVisible();
    await page.getByTestId('apply-connectors').click();
    await expect(page.getByTestId('optimize')).toBeEnabled();
    await optimize(page);
    await expect(page.getByTestId('optimal-chip')).toBeVisible();
  });

  test('plays the route animation in sync with the readout', async ({ page }) => {
    await page.goto('/workspace?example=riverside-ladder');
    await optimize(page);
    const readout = page.getByTestId('playback-readout');
    await expect(readout).toContainText('0 m');
    await page.getByTestId('route-play').click();
    await page.waitForTimeout(1500);
    const mid = await readout.textContent();
    expect(mid).not.toMatch(/^0 m/);
    await page.getByTestId('route-play').click(); // pause
    const paused = await readout.textContent();
    await page.waitForTimeout(600);
    expect(await readout.textContent()).toBe(paused);
  });

  test('renders the 3D route view (or the 2D fallback)', async ({ page }) => {
    await page.goto('/workspace?example=konigsberg');
    await optimize(page);
    await page.getByTestId('view-fly').click();
    await expect(page.getByTestId('route-3d').locator('canvas').or(page.getByText('WebGL is not available'))).toBeVisible();
  });

  test('exports JSON and CSV that agree with the result', async ({ page }) => {
    await page.goto('/workspace?example=konigsberg');
    await optimize(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
    const json = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    const expected = solveChinesePostman(getExample('konigsberg')!.graph);
    if (!expected.ok) throw new Error('engine failed');
    expect(json.result.route.totalDistance).toBe(expected.route.totalDistance);
    expect(json.graph.edges).toHaveLength(7);
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Route CSV' }).click()]);
    const lines = readFileSync((await csv.path())!, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(expected.route.steps.length + 1);
    expect(Number(lines.at(-1)!.split(',').at(-1))).toBe(expected.route.totalDistance);
  });

  test('opens a printable report consistent with the workspace', async ({ page }) => {
    await page.goto('/workspace?example=four-corners');
    await optimize(page);
    const total = await page.getByTestId('total-distance').textContent();
    await page.getByTestId('open-report').click();
    await expect(page.getByTestId('report')).toBeVisible();
    await expect(page.getByTestId('report')).toContainText(total!.trim());
    await expect(page.getByTestId('report')).toContainText('equally optimal pairings exist');
  });

  test('imports a GeoJSON street network', async ({ page }) => {
    await page.goto('/workspace');
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-file').setInputFiles('e2e/fixtures/cross.geojson');
    await expect(page.getByTestId('import-preview')).toContainText('1 feature(s) skipped');
    await page.getByTestId('import-confirm').click();
    // ring start/end + the two points shared with Market Cut → 3 intersections, 4 street segments
    await expect(page.locator('[data-vid]')).toHaveCount(3);
    await expect(page.locator('[data-eid]')).toHaveCount(4);
    await optimize(page);
    await expect(page.getByTestId('optimal-chip')).toBeVisible();
  });

  test('saves locally without an account and reloads the scenario', async ({ page }) => {
    await page.goto('/workspace?example=heritage-loop');
    await page.getByTestId('scenario-name').fill('My heritage walk');
    await page.getByTestId('save').click();
    await expect(page).toHaveURL(/\/workspace\/local-/);
    const url = page.url();
    await page.goto('/');
    await page.goto(url);
    await expect(page.getByTestId('scenario-name')).toHaveValue('My heritage walk');
  });

  test('keyboard-accessible streets table edits lengths', async ({ page }) => {
    await page.goto('/workspace?example=riverside-ladder');
    await page.getByRole('button', { name: 'Streets table' }).click();
    const input = page.getByRole('textbox', { name: 'Length of Middle Crossing' });
    await input.fill('999');
    await input.press('Tab');
    await page.keyboard.press('Escape');
    await page.locator('[data-eid="c1"]').click({ force: true });
    await expect(page.getByTestId('edge-weight')).toHaveValue('999');
  });
});
