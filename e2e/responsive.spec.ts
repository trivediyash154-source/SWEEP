import { expect, test } from '@playwright/test';

test('network lab is usable on a phone', async ({ page }) => {
  await page.goto('/lab?example=riverside-ladder');
  await expect(page.getByTestId('solver-status')).toBeVisible();
  await expect(page.getByTestId('total-distance')).toBeVisible();
  await expect(page.getByTestId('route-play')).toBeVisible();
  await page.getByTestId('route-play').tap();
  await page.getByTestId('nav-editor').tap();
  await expect(page.getByTestId('network-canvas')).toBeVisible();
  await expect(page.getByTestId('vehicles-input')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('landing is readable on a phone without horizontal scroll', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('city workspace is usable on a phone', async ({ page }) => {
  await page.goto('/workspace');
  await expect(page.getByTestId('city-name')).toContainText('Pune');
  await expect(page.getByTestId('panel-route')).toBeVisible();
  await page.getByTestId('mode-scenarios').tap();
  await expect(page.getByTestId('panel-scenarios')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('city workspace on a phone: compact header, camera buttons clear of it and of the panel, guide usable', async ({ page }) => {
  await page.goto('/workspace');
  await expect(page.getByTestId('city-name')).toContainText('Pune', { timeout: 60_000 });
  const bar = (await page.getByTestId('city-bar').boundingBox())!;
  const cams = (await page.getByRole('toolbar', { name: 'Camera' }).boundingBox())!;
  const panel = (await page.getByTestId('panel-route').boundingBox())!;
  // The camera buttons sit between the header and the bottom sheet, overlapping neither.
  expect(cams.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(cams.y + cams.height).toBeLessThanOrEqual(panel.y);
  // The header stays compact: at most a quarter of the screen.
  expect(bar.height).toBeLessThanOrEqual(page.viewportSize()!.height / 4);
  await expect(page.getByTestId('city-guide')).toBeVisible();
  await page.getByTestId('city-guide-hide').tap();
  await expect(page.getByTestId('city-guide-show')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
