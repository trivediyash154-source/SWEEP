import { expect, test } from '@playwright/test';

const unique = () => `user${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

test.describe('accounts and persistence', () => {
  test('register, save to account, store and reopen runs, sign out', async ({ page }) => {
    const email = unique();
    await page.goto('/register');
    await page.getByTestId('register-name').fill('Asha');
    await page.getByTestId('register-email').fill(email);
    await page.getByTestId('register-password').fill('a long test passphrase');
    await page.getByTestId('register-submit').click();
    await expect(page).toHaveURL(/\/workspace/);
    await page.getByTestId('example-old-town-grid').click();
    await page.getByTestId('scenario-name').fill('Ward 7');
    await page.getByTestId('save').click();
    await expect(page.getByText('Saved to your account')).toBeVisible();
    await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/);
    const scenarioUrl = page.url();
    // optimise a saved scenario → stored run
    await page.getByTestId('optimize').click();
    await expect(page.getByTestId('run-history')).toBeVisible();
    await expect(page.getByTestId('run-history').locator('li')).toHaveCount(1);
    // reload and reopen
    await page.goto(scenarioUrl);
    await expect(page.getByTestId('scenario-name')).toHaveValue('Ward 7');
    await page.getByTestId('tab-results').click();
    // sign out protects account pages
    await page.goto('/account');
    await page.getByTestId('signout').click();
    await page.goto('/account');
    await expect(page).toHaveURL(/\/signin/);
    // another user cannot open the scenario
    await page.goto('/register');
    await page.getByTestId('register-name').fill('Ravi');
    await page.getByTestId('register-email').fill(unique());
    await page.getByTestId('register-password').fill('another long passphrase');
    await page.getByTestId('register-submit').click();
    await expect(page).toHaveURL(/\/workspace/);
    await page.goto(scenarioUrl);
    await expect(page.getByText('Scenario not found, or it belongs to another account.')).toBeVisible();
  });

  test('sign-in errors are generic and do not reveal accounts', async ({ page }) => {
    await page.goto('/signin');
    await page.getByTestId('signin-email').fill('nobody@example.com');
    await page.getByTestId('signin-password').fill('wrong password here');
    await page.getByTestId('signin-submit').click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  });
});
