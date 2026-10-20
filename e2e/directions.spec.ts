import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The external services are replaced by test doubles in their real response formats: the map style
// (a plain background), Photon place search and the OSRM route servers. The page under test is real.
// Like the real services, every stand-in answers with CORS headers.
const CORS = { 'Access-Control-Allow-Origin': '*' };
const STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9e5dc' } }] };
const feature = (name: string, lng: number, lat: number, extra: Record<string, string> = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { osm_type: 'N', osm_id: Math.round(lng * 1e4), name, city: 'Pune', state: 'Maharashtra', country: 'India', ...extra } });
const route = (distance: number, duration: number, via: string) => ({
  distance,
  duration,
  geometry: { type: 'LineString', coordinates: [[73.8553, 18.5195], [73.865, 18.524], [73.8744, 18.5289]] },
  legs: [
    {
      steps: [
        { name: 'Bajirao Road', distance: 400, duration: 60, maneuver: { type: 'depart', bearing_after: 80, location: [73.8553, 18.5195] } },
        { name: via, distance: distance - 400, duration: duration - 60, maneuver: { type: 'turn', modifier: 'right', location: [73.86, 18.521] } },
        { name: 'Station Road', distance: 0, duration: 0, maneuver: { type: 'arrive', location: [73.8744, 18.5289] } },
      ],
    },
  ],
});
const OSRM = { code: 'Ok', routes: [route(3120, 545, 'Laxmi Road'), route(3480, 600, 'Shivaji Road')] };

async function stubServices(page: Page, opts: { footBusy?: boolean } = {}) {
  const calls: string[] = [];
  await page.route('https://tiles.openfreemap.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(STYLE) }));
  await page.route('https://tile.openstreetmap.org/**', (r) => r.abort());
  await page.route('https://photon.komoot.io/**', (r) => {
    const u = new URL(r.request().url());
    calls.push(u.toString());
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const features = u.pathname.startsWith('/reverse') ? [feature('Somwar Peth', 73.86, 18.52)] : q.includes('shaniwar') ? [feature('Shaniwar Wada', 73.8553, 18.5195, { osm_key: 'historic', osm_value: 'castle' })] : q.includes('station') ? [feature('Pune Railway Station', 73.8744, 18.5289)] : [];
    return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ type: 'FeatureCollection', features }) });
  });
  await page.route(/routing\.openstreetmap\.de|router\.project-osrm\.org/, (r) => {
    const u = r.request().url();
    calls.push(u);
    if (opts.footBusy && u.includes('routed-foot')) return r.fulfill({ status: 503, headers: CORS, body: 'busy' });
    return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(OSRM) });
  });
  return calls;
}

async function pick(page: Page, field: 'dir-from' | 'dir-to', text: string, option: string) {
  await page.getByTestId(`${field}-input`).fill(text);
  await page.getByTestId(`${field}-option`).filter({ hasText: option }).first().click();
}

test.describe('Directions (anywhere, on OSRM)', () => {
  test('search two places, get routes with times, distances and turn-by-turn steps, honestly attributed', async ({ page }) => {
    const calls = await stubServices(page);
    await page.goto('/directions');
    await expect(page.getByRole('heading', { name: 'Directions' })).toBeVisible();
    await pick(page, 'dir-from', 'Shaniwar', 'Shaniwar Wada');
    await pick(page, 'dir-to', 'station', 'Pune Railway Station');
    await expect(page.getByTestId('dir-result')).toBeVisible();
    // 545 s and 3,120 m from the service, shown as the service gave them.
    await expect(page.getByTestId('dir-time')).toHaveText('9 min');
    await expect(page.getByTestId('dir-distance')).toHaveText('3.1 km');
    await expect(page.getByTestId('dir-route-1')).toContainText('10 min');
    await expect(page.getByTestId('dir-steps')).toContainText('Head east on Bajirao Road');
    await expect(page.getByTestId('dir-steps')).toContainText('Turn right onto Laxmi Road');
    await expect(page.getByTestId('dir-provider')).toContainText('FOSSGIS OSRM, car profile');
    await expect(page.getByTestId('dir-provider')).toContainText("not by SWEEP's own engine");
    const req = calls.find((u) => u.includes('routed-car'))!;
    expect(req).toContain('/route/v1/driving/73.855300,18.519500;73.874400,18.528900');
    // The trip is in the URL, so it can be shared.
    await expect(page).toHaveURL(/from=18\.519500%2C73\.855300&to=18\.528900%2C73\.874400|from=18\.519500,73\.855300&to=18\.528900,73\.874400/);
    // Choosing the alternative selects it.
    await page.getByTestId('dir-route-1').click();
    await expect(page.getByTestId('dir-route-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('dir-steps')).toContainText('Shivaji Road');
  });

  test('a shared link opens the same trip; a busy server is reported, not hidden', async ({ page }) => {
    const calls = await stubServices(page, { footBusy: true });
    await page.goto('/directions?from=18.519500,73.855300&to=18.528900,73.874400&mode=foot');
    await expect(page.getByTestId('dir-mode-foot')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('dir-error')).toContainText('No routing service answered');
    await expect(page.getByTestId('dir-error')).toContainText('FOSSGIS OSRM, foot profile: busy (HTTP 503)');
    expect(calls.some((u) => u.includes('routed-foot'))).toBe(true);
    await page.getByTestId('dir-mode-bike').click();
    await expect(page.getByTestId('dir-time')).toHaveText('9 min');
    expect(calls.some((u) => u.includes('routed-bike'))).toBe(true);
  });

  test('clicking the map sets the start and the destination', async ({ page }) => {
    await stubServices(page);
    await page.goto('/directions');
    const map = page.getByTestId('dir-map');
    await expect(map).toBeVisible();
    await page.waitForFunction(() => (window as unknown as { __sweepMap?: { loaded: () => boolean } }).__sweepMap?.loaded());
    const box = (await map.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await expect(page.getByTestId('marker-from')).toBeVisible();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.45);
    await expect(page.getByTestId('marker-to')).toBeVisible();
    await expect(page.getByTestId('dir-result')).toBeVisible();
    await expect(page.getByTestId('dir-from-input')).toHaveValue(/Somwar Peth|\d+\.\d+, \d+\.\d+/);
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await stubServices(page);
    await page.goto('/directions');
    await expect(page.getByTestId('dir-map')).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude('canvas').exclude('.maplibregl-ctrl').analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });
});
