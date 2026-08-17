/**
 * The team list has to survive losing the network (audit §2).
 *
 * `populateCloudTeamsAndGames()` fetching /api/auth/teams was the only path to
 * a rendered list, and the service worker deliberately never caches /api/*, so
 * a coach who recorded a tournament with no signal saw "Error loading teams.
 * Check connection and try again." — their work was on the device the whole
 * time, just unreachable through the UI.
 *
 * Real offline, not a mocked failure: the point is the path a coach on a field
 * actually takes.
 */
import { test, expect, Page } from '@playwright/test';
import { TEST_PARAMS } from '../helpers/constants';
import { setupTeamWithPlayers, startGame } from '../helpers/app';

const COACH = 'offline-list-coach';
const TEAM = 'Offline List Team';

test.describe.configure({ timeout: 90_000 });

/** Leave the game screen and re-render the teams screen from scratch. */
async function showTeamsScreen(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.exitGameScreen?.();
    w.showSelectTeamScreen?.();
  });
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
}

test.describe('offline team list', () => {
  test('a coach offline sees their teams and games, not an error', async ({ page, context }) => {
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
    await setupTeamWithPlayers(page, TEAM);
    await startGame(page, 'offense');

    // Cut the network the way a field does — after everything is local.
    await context.setOffline(true);
    try {
      await showTeamsScreen(page);

      const list = page.locator('#cloudTeamsList');
      await expect(list).toContainText(TEAM, { timeout: 15_000 });
      await expect(
        list,
        'the offline list must not report the failure it just recovered from',
      ).not.toContainText('Error loading teams');

      // Say it is local, rather than passing stale data off as synced.
      await expect(list).toContainText('Offline');

      // The game recorded above is the thing the coach is afraid of losing.
      await expect(
        list.locator('.game-item, [class*="game"]').first(),
        'the locally recorded game should be listed',
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await context.setOffline(false);
    }
  });

  test('coming back online replaces the local list with the synced one', async ({
    page,
    context,
  }) => {
    // The fallback must not latch: once the server answers, its list (which
    // includes other coaches' games) is authoritative again.
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
    await setupTeamWithPlayers(page, `${TEAM} Two`);
    await startGame(page, 'offense');

    await context.setOffline(true);
    await showTeamsScreen(page);
    await expect(page.locator('#cloudTeamsList')).toContainText('Offline', { timeout: 15_000 });

    await context.setOffline(false);
    await showTeamsScreen(page);

    const list = page.locator('#cloudTeamsList');
    await expect(list).toContainText(`${TEAM} Two`, { timeout: 15_000 });
    await expect(
      list,
      'the offline notice should be gone once the server answered',
    ).not.toContainText('showing games saved on this device');
  });
});
