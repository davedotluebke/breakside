/**
 * Off-camera setup for the demo clips.
 *
 * Everything here runs BEFORE markTrim() and gets cut out of the finished mp4,
 * so it uses fast fill/click rather than the cinema glides. The point is to get
 * the app into the state a clip starts from as quickly as possible.
 *
 * Every clip passes its own `user` slug, which becomes ?testUserId=demo-<slug>.
 * The backend scopes team listings by that id when auth is disabled, so each
 * clip sees a Teams screen containing only its own team — no accumulation of
 * "Breakside Demo" rows from earlier clips in the same run.
 */
import { expect, Page } from '@playwright/test';
import { BACKEND_URL } from '../helpers/constants';
import { setupCinema } from './cinema';

/** The fictional roster. Never a real player name — see DEMO_VIDEOS.md. */
export const ROSTER = [
  { name: 'Alice', number: '1', gender: 'FMP' as const },
  { name: 'Bob', number: '2', gender: 'MMP' as const },
  { name: 'Carol', number: '3', gender: 'FMP' as const },
  { name: 'Dave', number: '4', gender: 'MMP' as const },
  { name: 'Eve', number: '5', gender: 'FMP' as const },
  { name: 'Frank', number: '6', gender: 'MMP' as const },
  { name: 'Grace', number: '7', gender: 'FMP' as const },
];

export const TEAM_NAME = 'Breakside Demo';
export const OPPONENT = 'Rivals';

/** Load the app with the cinema cursor installed, as an isolated demo user. */
export async function openApp(page: Page, user: string) {
  await setupCinema(page);
  await page.goto(`/?testMode=true&testUserId=demo-${user}&api=${BACKEND_URL}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
}

/** Create the demo team (fast path). Leaves us on the Start Game subscreen. */
export async function makeTeam(page: Page, name = TEAM_NAME) {
  await page.click('.teams-action-create');
  await expect(page.locator('#createTeamModal')).toBeVisible();
  await page.fill('#newTeamNameInput', name);
  await page.click('#saveNewTeamBtn');
  await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 10_000 });
}

/** Add the full fictional roster (fast path). Returns to the Start Game subscreen. */
export async function addRoster(page: Page, players = ROSTER) {
  await page.click('#showRosterBtn');
  await expect(page.locator('#editRosterSubscreen')).toBeVisible();
  for (const p of players) {
    await page.fill('#newPlayerInput', p.name);
    await page.fill('#newPlayerNumberInput', p.number);
    await page.click(p.gender === 'FMP' ? '#addFMPPlayerBtn' : '#addMMPPlayerBtn');
    await expect(page.locator('#rosterList').getByText(p.name)).toBeVisible({ timeout: 5_000 });
  }
  await page.click('#backToStartGameBtn');
  await expect(page.locator('#startGameSubscreen')).toBeVisible();
}

/** Team + roster in one call. */
export async function makeTeamWithRoster(page: Page, user: string) {
  await openApp(page, user);
  await makeTeam(page);
  await addRoster(page);
}

/** Start a game against the demo opponent (fast path). */
export async function beginGame(page: Page, side: 'offense' | 'defense', opponent = OPPONENT) {
  await page.fill('#opponentNameInput', opponent);
  await page.click(side === 'offense' ? '#startGameOnOBtn' : '#startGameOnDBtn');
  await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 10_000 });
}

/** Check every player in the line table (fast path). */
export async function checkWholeLine(page: Page) {
  const table = page.locator('#panelActivePlayersTable');
  await expect(table).toBeVisible({ timeout: 10_000 });
  const rows = table.locator('tbody tr');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const box = rows.nth(i).locator('input[type="checkbox"]');
    if (!(await box.isChecked())) await box.click();
  }
}

/** Switch the in-game tab without the cinema pacing (off-camera only). */
export async function goToTab(page: Page, tab: 'simple' | 'full' | 'field' | 'line' | 'log' | 'all') {
  await page.locator(`#headerSegControl button[data-tab="${tab}"]`).click();
  await page.waitForTimeout(300);
}

/**
 * Start the point from whichever tab is showing.
 *
 * Each tab renders its own Start Point button with its own id — the shared
 * `#pbpStartPointBtn` only exists on Simple/All, so clicking it while the Full
 * or Field tab is up waits forever on a hidden element. (This cost a session's
 * worth of wedged runs; don't collapse it back to one id.)
 */
export async function startPoint(page: Page) {
  const ids = ['#pbpStartPointBtn', '#fullPbpStartPointBtn', '#lineTabStartPointBtn', '#fpStartPointBtn'];
  for (const id of ids) {
    const btn = page.locator(id);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      return;
    }
  }
  throw new Error('no visible Start Point button on this tab');
}

/** Clear the pull dialog that opens when a defense point starts. */
export async function completePull(page: Page, puller = 'Frank', quality = 'Good Pull') {
  await expect(page.locator('#pullDialog')).toBeVisible({ timeout: 8_000 });
  await page.locator('#pullPlayerButtons .player-button').filter({ hasText: puller }).click();
  await page.locator(`#pullQualityButtons .pull-quality-btn[data-quality="${quality}"]`).click();
  await page.locator('#pullProceedBtn').click();
  await expect(page.locator('#pullDialog')).toBeHidden({ timeout: 8_000 });
}

/** Score for us, attributing assist → goal. Fast path, off-camera. */
export async function scoreFor(page: Page, thrower: string, receiver: string) {
  await page.locator('#pbpWeScoreBtn').click();
  await expect(page.locator('#scoreAttributionDialog')).toBeVisible({ timeout: 8_000 });
  await page.locator('#throwerButtons .player-button').filter({ hasText: thrower }).click();
  await page.locator('#receiverButtons .player-button').filter({ hasText: receiver }).click();
  await expect(page.locator('#scoreAttributionDialog')).toBeHidden({ timeout: 8_000 });
}

/** The whole boring preamble: team, roster, game, line selected, point started. */
export async function readyPoint(
  page: Page,
  user: string,
  side: 'offense' | 'defense' = 'offense',
) {
  await makeTeamWithRoster(page, user);
  await beginGame(page, side);
  await checkWholeLine(page);
  await startPoint(page);
}
