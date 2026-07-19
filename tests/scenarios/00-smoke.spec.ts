/**
 * Smoke test: verify the app loads and reaches the team selection screen
 * in test mode (no auth required).
 */
import { test, expect } from '@playwright/test';
import { BACKEND_URL, TEST_PARAMS } from '../helpers/constants';

test('app loads and shows team selection screen', async ({ page }) => {
  await page.goto(`/?${TEST_PARAMS}`);

  // The team selection screen should become visible
  const teamScreen = page.locator('#selectTeamScreen');
  await expect(teamScreen).toBeVisible({ timeout: 10_000 });

  // Key UI elements should be present
  await expect(page.locator('.teams-action-create')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Teams, Events, and Games' })).toBeVisible();
});

test('backend health endpoint is reachable', async ({ request }) => {
  const response = await request.get(`${BACKEND_URL}/health`);
  expect(response.ok()).toBeTruthy();
});
