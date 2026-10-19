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
