// Captures the city workspace for the docs: the same camera in both themes, a route comparison and a coverage plan.
// Usage: node scripts/city-screenshots.mjs [baseUrl] [outDir]   (server must be running, e.g. node scripts/e2e-server.mjs 8790)
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:8790';
const out = process.argv[3] ?? 'docs/screenshots';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });

// Park the pointer over the panel (no hover tooltip or street highlight) and close any inspector card.
async function settle(page) {
  await page.mouse.move(200, 870);
  await page.evaluate(() => window.__sweepCity.state().select(null));
  await page.waitForTimeout(400);
}

// The theme pair shows a first visit, with the getting-started guide; the result shots hide it, as a returning user would.
async function open(theme, { guide = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => localStorage.setItem('sweep.theme', t), theme);
  if (!guide) await ctx.addInitScript(() => localStorage.setItem('sweep.cityGuide', 'hidden'));
  const page = await ctx.newPage();
  await page.goto(`${base}/workspace`);
  await page.getByTestId('city-name').filter({ hasText: 'Pune' }).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => window.__sweepCity?.state().meshes, null, { timeout: 60_000 });
  await page.keyboard.press('Escape');
  return { ctx, page };
}

for (const theme of ['velvet', 'porcelain']) {
  const { ctx, page } = await open(theme, { guide: true });
  await page.getByTestId('cam-focus').click();
  await page.waitForTimeout(3000);
  await settle(page);
  await page.screenshot({ path: `${out}/city-${theme}.png` });
  await ctx.close();
}

{
  const { ctx, page } = await open('velvet');
  await page.getByTestId('search-origin').fill('Swami Vivek');
  await page.getByTestId('search-result').first().click();
  await page.getByTestId('search-destination').fill('Kamate');
  await page.getByTestId('search-result').first().click();
  await page.getByTestId('route-agreement').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6000);
  await settle(page);
  await page.screenshot({ path: `${out}/city-route-velvet.png` });
  await ctx.close();
}

{
  const { ctx, page } = await open('porcelain');
  await page.getByTestId('mode-coverage').click();
  await page.getByTestId('cam-top').click();
  await page.waitForTimeout(2500);
  const box = await page.getByTestId('city-stage').boundingBox();
  const screen = async (x, y) => {
    const p = await page.evaluate(([a, b]) => window.__sweepCity.project(a, b, 0), [x, y]);
    return [box.x + ((p[0] + 1) / 2) * box.width, box.y + ((1 - p[1]) / 2) * box.height];
  };
  const c = await page.evaluate(() => window.__sweepCity.state().city.focus.xy);
  await page.getByTestId('cov-shape-circle').click();
  await page.getByTestId('cov-draw-zone').click();
  await page.mouse.click(...(await screen(c[0], c[1])));
  await page.mouse.click(...(await screen(c[0] + 350, c[1])));
  const node = await page.evaluate(([cx, cy]) => {
    const city = window.__sweepCity.state().city;
    let best = 0, bd = Infinity;
    for (let i = 0; i < city.nodeCount; i++) {
      const d = (city.nodeX[i] - cx) ** 2 + (city.nodeY[i] - cy) ** 2;
      if (d < bd) [best, bd] = [i, d];
    }
    return [city.nodeX[best], city.nodeY[best]];
  }, c);
  await page.getByTestId('pick-depot').click();
  await page.mouse.click(...(await screen(node[0], node[1])));
  await page.getByTestId('cov-vehicles').fill('3');
  await page.getByTestId('cov-run').click();
  await page.getByTestId('cov-results').waitFor({ timeout: 90_000 });
  await page.getByTestId('tl-scrub').fill(String(Math.round(Number(await page.getByTestId('tl-scrub').getAttribute('max')) * 0.45)));
  await page.waitForTimeout(2500);
  await settle(page);
  await page.screenshot({ path: `${out}/city-coverage-porcelain.png` });
  await ctx.close();
}

await browser.close();
console.log('screenshots written to', out);
