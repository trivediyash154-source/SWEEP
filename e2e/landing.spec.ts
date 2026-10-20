import { expect, test } from '@playwright/test';
import { getExample, solveChinesePostman } from './engine';

test.describe('landing page', () => {
  test('renders the hero, live engine figures and navigation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Every street.');
    await expect(page.getByTestId('hero-instrument')).toContainText('optimal ✓');
    // The ledger reproduces engine output exactly.
    const oldTown = solveChinesePostman(getExample('old-town-grid')!.graph);
    if (!oldTown.ok) throw new Error('engine failed');
    const row = page.getByTestId('ledger').getByRole('row', { name: /Old Town Grid/ });
    await expect(row).toContainText(`${(oldTown.route.totalDistance / 1000).toFixed(2)} km`);
    await expect(page.locator('.hero__scene canvas, .hero-fallback svg').first()).toBeVisible();
    await page.getByTestId('cta-workspace').click();
    await expect(page).toHaveURL(/\/workspace/);
    expect(errors).toEqual([]);
  });

  test('four tools, each card a link, saying who computes the result', async ({ page }) => {
    // Only the links are followed here; the map pages' internet services are not needed.
    await page.route(/^https:\/\//, (r) => r.abort());
    await page.goto('/');
    await expect(page.getByTestId('tools-honesty')).toContainText('Directions are computed by the public OSRM service');
    await expect(page.getByTestId('tool-directions')).toContainText('not by SWEEP');
    const sweep = page.getByTestId('tool-sweep');
    for (const fact of ['up to 25 km²', 'downloaded live from OpenStreetMap', 'around VIT (1 km²)', 'Kothrud (4 km²)', 'the old city (9 km²)', 'the centre (about 20 km²)', 'Play the shift', 'proven lower bound and gap'])
      await expect(sweep).toContainText(fact);
    // A click anywhere on a card follows its link.
    for (const [id, path] of [['directions', '/directions'], ['sweep', '/sweep'], ['workspace', '/workspace'], ['lab', '/lab']] as const) {
      await expect(page.getByTestId(`tool-link-${id}`)).toHaveAttribute('href', path);
      await page.getByTestId(`tool-${id}`).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await page.goBack();
      await expect(page.getByTestId(`tool-${id}`)).toBeVisible();
    }
    await page.getByTestId('cta-sweep').click();
    await expect(page).toHaveURL(/\/sweep$/);
  });

  test('a light hero: the static drawing, and the 3D scene only on a wide screen with motion allowed', async ({ browser }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
      const page = await ctx.newPage();
      const heroCode: string[] = [];
      page.on('request', (r) => {
        if (/HeroScene/.test(r.url())) heroCode.push(r.url());
      });
      await page.goto('/');
      await expect(page.getByTestId('hero-note')).toContainText('synthetic illustration');
      if (reducedMotion === 'no-preference') {
        await expect(page.locator('.hero__scene canvas')).toBeVisible({ timeout: 30_000 });
      } else {
        await expect(page.locator('.hero-fallback svg')).toBeVisible();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
        expect(heroCode).toEqual([]);
        await expect(page.locator('.hero__scene canvas')).toHaveCount(0);
      }
      await ctx.close();
    }
  });

  test('botanical cursor field never blocks interaction', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    const field = page.getByTestId('botanical-field');
    await expect(field).toHaveCount(1);
    await expect(field).toHaveCSS('pointer-events', 'none');
    for (let i = 0; i < 20; i++) await page.mouse.move(200 + i * 40, 400 + Math.sin(i / 2) * 80);
    // Links under the overlay remain clickable.
    await page.getByRole('link', { name: 'Explore the mathematics' }).click();
    await expect(page).toHaveURL(/\/mathematics/);
  });

  test('respects reduced motion: no cursor field, motion toggle reflects state', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByTestId('botanical-field')).toHaveCount(0);
    await expect(page.getByTestId('motion-toggle')).toHaveText('Resume motion');
    await ctx.close();
  });

  test('theme toggle switches between Velvet and Porcelain and persists', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Porcelain' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'porcelain');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'porcelain');
    await page.getByRole('button', { name: 'Velvet' }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'velvet');
  });

  test('mathematics page explains the method with computed figures', async ({ page }) => {
    await page.goto('/mathematics');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Chinese Postman');
    await expect(page.getByText('greedy pairing adds 140 m')).toBeVisible();
  });

  test('unknown routes show a helpful 404', async ({ page }) => {
    await page.goto('/no/such/street');
    await expect(page.getByRole('heading', { name: 'This street does not exist.' })).toBeVisible();
  });
});
