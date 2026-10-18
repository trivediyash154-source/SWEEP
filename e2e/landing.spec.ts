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
