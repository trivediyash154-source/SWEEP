import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = ['/', '/workspace', '/lab?example=old-town-grid', '/mathematics', '/signin', '/register'];

for (const theme of ['velvet', 'porcelain'] as const) {
  for (const path of PAGES) {
    test(`no serious accessibility violations: ${path} (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('sweep.theme', t), theme);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      if (path === '/workspace') await expect(page.getByTestId('city-name')).not.toHaveText('Loading city…');
      const results = await new AxeBuilder({ page }).exclude('canvas').analyze();
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
    });
  }
}
