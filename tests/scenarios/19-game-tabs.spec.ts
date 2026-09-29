/**
 * Which in-game tab, when (utils/gameTabPolicy.js, ui/panelSystem.js)
 *
 * Pins the tab flow end to end:
 *   - a game opens on the Line tab, whatever tab was active last
 *   - the first point ever on a device goes to Simple, with a hint pointing
 *     at the Full and Field tabs; the hint shows once
 *   - a score returns a solo coach to the Line tab; Start Point returns to
 *     the tracking tab used last time, so picking Full once makes every
 *     later point start on Full, in this game and the next
 *   - a game re-opened mid-point comes back on the tab it was left on
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, weScoreSkip, theyScore,
  completePullDialog, expectScore,
} from '../helpers/app';
import { waitForGameOnServer } from '../helpers/controllerApi';

/** A team name no other test or retry shares: the team list is one
 *  server-wide data dir for the whole run, and the card locator is strict. */
const uniqueTeam = () => `Tab Testers ${Date.now().toString(36)}`;
/** The page's coach when TEST_PARAMS names no testUserId. */
const COACH = 'test-user';

const tabButton = (page: Page, tab: string) => page.locator(`#headerSegControl button[data-tab="${tab}"]`);
const hint = (page: Page) => page.locator('#toastContainer .toast', { hasText: 'Full and Field' });

async function expectTab(page: Page, tab: string) {
  await expect(tabButton(page, tab), `the ${tab} tab should be active`).toHaveClass(/\bactive\b/, { timeout: 5_000 });
}

async function getGameId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).currentGame()?.id);
}

/** Leave the game via the menu (no confirm: test team) back to the team list. */
async function leaveGame(page: Page) {
  page.once('dialog', d => d.accept());
  await page.click('#gameMenuBtn');
  await expect(page.locator('#gameMenuDropdown')).toBeVisible();
  await page.click('#menuLeaveGame');
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
}

function card(page: Page, team: string) {
  return page.locator('#cloudTeamsList .team-section', {
    has: page.locator('.team-header-name', { hasText: team }),
  });
}

/** The card's games container is collapsible; open it if it is closed. */
async function expandCard(page: Page, team: string) {
  await expect(card(page, team)).toBeVisible({ timeout: 15_000 });
  const container = card(page, team).locator('.team-games-container');
  if (!(await container.isVisible())) {
    await card(page, team).locator('.team-header').click();
  }
  await expect(container).toBeVisible();
}

/** Rejoin the team's live game from its card. */
async function rejoinGame(page: Page, team: string) {
  await expandCard(page, team);
  await card(page, team).locator('.game-join-btn', { hasText: 'Join' }).first().click();
  await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 10_000 });
}

test.describe('in-game tabs', () => {
  test('opens on Line; first point on Simple with the hint, once; the tracking tab used last is remembered', async ({ page }) => {
    const team = uniqueTeam();
    await goToApp(page);
    await setupTeamWithPlayers(page, team);
    await startGame(page, 'offense');

    // A fresh device: the game opens on the Line tab, not All, with the
    // Line tab's own Start Point button.
    await expectTab(page, 'line');
    await expect(page.locator('#panelActivePlayersTable')).toBeVisible();
    await expect(page.locator('#lineTabStartPointBtn')).toBeVisible();
    await expect(page.locator('#pbpStartPointBtn')).toBeHidden();

    // First point ever: Simple, and the hint about Full and Field.
    await selectAllPlayers(page);
    await startPoint(page);
    await expectTab(page, 'simple');
    await expect(hint(page)).toBeVisible({ timeout: 5_000 });
    await hint(page).locator('.toast-close').click();
    await expect(hint(page)).toBeHidden();

    // A score sends the solo coach back to the Line tab.
    await weScoreSkip(page);
    await expectScore(page, 1, 0);
    await expectTab(page, 'line');

    // Second point: Simple again, the preference now, and no second hint.
    await selectAllPlayers(page);
    await startPoint(page);
    await expectTab(page, 'simple');
    await completePullDialog(page, 'Bob', 'Good Pull');
    await expect(hint(page)).toHaveCount(0);
    await theyScore(page);
    await expectScore(page, 1, 1);
    await expectTab(page, 'line');

    // Picking Full between points makes it the tracking tab used last;
    // Start Point from the Line tab now lands on Full.
    await tabButton(page, 'full').click();
    await expectTab(page, 'full');
    await selectAllPlayers(page);   // goes back to the Line tab for the table
    await expectTab(page, 'line');
    await startPoint(page);
    await expectTab(page, 'full');
    await expect(hint(page)).toHaveCount(0);

    // The next game, same device: opens on Line all the same, and its first
    // point starts on Full, the tab used last time — no hint, no Simple.
    await leaveGame(page);
    await expandCard(page, team);
    await card(page, team).locator('.new-game-btn', { hasText: 'New Game' }).click();
    await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 8_000 });
    await startGame(page, 'offense', 'Rivals');
    await expectTab(page, 'line');
    await selectAllPlayers(page);
    await startPoint(page);
    await expectTab(page, 'full');
    await expect(hint(page)).toHaveCount(0);
  });

  test('re-opened mid-point, a game comes back on the tab it was left on', async ({ page, request }) => {
    const team = uniqueTeam();
    await goToApp(page);
    await setupTeamWithPlayers(page, team);
    await startGame(page, 'offense');
    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH);

    await selectAllPlayers(page);
    await startPoint(page);
    await expectTab(page, 'simple');

    // Mid-point, on the Log tab, the coach leaves and rejoins from the
    // team list: back to Log, not to Line (the point is still running).
    await tabButton(page, 'log').click();
    await expectTab(page, 'log');
    await leaveGame(page);
    await rejoinGame(page, team);
    await expectTab(page, 'log');

    // Score, then leave and rejoin between points: the Line tab, whatever
    // tab was active last.
    await tabButton(page, 'simple').click();
    await weScoreSkip(page);
    await expectScore(page, 1, 0);
    await tabButton(page, 'log').click();
    await expectTab(page, 'log');
    await leaveGame(page);
    await rejoinGame(page, team);
    await expectTab(page, 'line');
  });
});
