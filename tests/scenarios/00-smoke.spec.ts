/**
 * Smoke test: verify the app loads and reaches the team selection screen
 * in test mode (no auth required).
 */
import { test, expect } from '@playwright/test';
import { TEST_PARAMS } from '../playwright.config';

test('app loads and shows team selection screen', async ({ page }) => {
  await page.goto(`/?${TEST_PARAMS}`);

  // The team selection screen should become visible
  const teamScreen = page.locator('#selectTeamScreen');
  await expect(teamScreen).toBeVisible({ timeout: 10_000 });

  // Key UI elements should be present
  await expect(page.locator('#createNewTeamBtn')).toBeVisible();
  await expect(page.getByText('Select Your Team')).toBeVisible();
});

test('backend health endpoint is reachable', async ({ request }) => {
  const response = await request.get('http://localhost:8100/health');
  expect(response.ok()).toBeTruthy();
});
