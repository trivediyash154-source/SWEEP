import { expect, test } from '@playwright/test';

test('workspace is usable on a phone', async ({ page }) => {
  await page.goto('/workspace?example=riverside-ladder');
  await expect(page.getByTestId('network-canvas')).toBeVisible();
  await page.getByTestId('optimize').click();
  await expect(page.getByTestId('results')).toBeVisible();
  await expect(page.getByTestId('total-distance')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('landing is readable on a phone without horizontal scroll', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
