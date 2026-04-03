/**
 * Shared helpers for Breakside Playwright tests.
 *
 * Provides reusable functions for common app interactions:
 *   - Loading the app in test mode
 *   - Creating a team and adding players
 *   - Starting a game (offense or defense)
 *   - Scoring points (with or without attribution)
 *   - Navigating pull dialog
 *   - Ending a game
 */
import { expect, Page } from '@playwright/test';
import { TEST_PARAMS } from './constants';

// ─── App Navigation ─────────────────────────────────────────────────────────

/** Navigate to the app in test mode and wait for the team selection screen. */
export async function goToApp(page: Page) {
  await page.goto(`/?${TEST_PARAMS}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
}

// ─── Team & Roster ──────────────────────────────────────────────────────────

/** Create a new team and wait for navigation to the roster screen. */
export async function createTeam(page: Page, name: string) {
  await page.click('#createNewTeamBtn');
  await expect(page.locator('#createTeamModal')).toBeVisible();
  await page.fill('#newTeamNameInput', name);
  await page.click('#saveNewTeamBtn');
  await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 8_000 });
}

/** Navigate to the Edit Roster subscreen. */
export async function openEditRoster(page: Page) {
  await page.click('#showRosterBtn');
  await expect(page.locator('#editRosterSubscreen')).toBeVisible();
}

/** Add a player on the Edit Roster subscreen. */
export async function addPlayer(page: Page, name: string, number: string, gender: 'FMP' | 'MMP') {
  await page.fill('#newPlayerInput', name);
  await page.fill('#newPlayerNumberInput', number);
  const btnId = gender === 'FMP' ? '#addFMPPlayerBtn' : '#addMMPPlayerBtn';
  await page.click(btnId);
  await expect(page.locator('#rosterList').getByText(name)).toBeVisible({ timeout: 5_000 });
}

/** Navigate back from Edit Roster to Start Game subscreen. */
export async function backToStartGame(page: Page) {
  await page.click('#backToStartGameBtn');
  await expect(page.locator('#startGameSubscreen')).toBeVisible();
}

/** Standard set of 7 test players. */
export const DEFAULT_PLAYERS = [
  { name: 'Alice', number: '1', gender: 'FMP' as const },
  { name: 'Bob',   number: '2', gender: 'MMP' as const },
  { name: 'Carol', number: '3', gender: 'FMP' as const },
  { name: 'Dave',  number: '4', gender: 'MMP' as const },
  { name: 'Eve',   number: '5', gender: 'FMP' as const },
  { name: 'Frank', number: '6', gender: 'MMP' as const },
  { name: 'Grace', number: '7', gender: 'FMP' as const },
];

/** Create a team with the default 7 players and navigate to Start Game. */
export async function setupTeamWithPlayers(page: Page, teamName = 'Test Team') {
  await createTeam(page, teamName);
  await openEditRoster(page);
  for (const p of DEFAULT_PLAYERS) {
    await addPlayer(page, p.name, p.number, p.gender);
  }
  await backToStartGame(page);
}

// ─── Game Start ─────────────────────────────────────────────────────────────

/** Start a game on offense or defense. Waits for the game screen to appear. */
export async function startGame(page: Page, side: 'offense' | 'defense', opponent = 'Bad Guys') {
  await page.fill('#opponentNameInput', opponent);
  const btnId = side === 'offense' ? '#startGameOnOBtn' : '#startGameOnDBtn';
  await page.click(btnId);
  await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });
}

// ─── Player Selection & Points ──────────────────────────────────────────────

/** Check all player checkboxes in the panel table. */
export async function selectAllPlayers(page: Page) {
  const playerTable = page.locator('#panelActivePlayersTable');
  await expect(playerTable).toBeVisible({ timeout: 8_000 });
  const rows = playerTable.locator('tbody tr');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const checkbox = rows.nth(i).locator('input[type="checkbox"]');
    if (!(await checkbox.isChecked())) {
      await checkbox.click();
    }
  }
}

/** Click the Start Point button. */
export async function startPoint(page: Page) {
  const btn = page.locator('#pbpStartPointBtn');
  await expect(btn).toBeVisible({ timeout: 5_000 });
  await btn.click();
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/** Click "We Score" and skip attribution. Score increments by 1. */
export async function weScoreSkip(page: Page) {
  await page.click('#pbpWeScoreBtn');
  await expect(page.locator('#scoreAttributionDialog')).toBeVisible({ timeout: 5_000 });
  await page.click('#skipAttributionBtn');
}

/**
 * Click "We Score" and attribute to thrower → receiver.
 * Dialog auto-closes when both are selected.
 */
export async function weScoreWithAttribution(page: Page, throwerName: string, receiverName: string) {
  await page.click('#pbpWeScoreBtn');
  const dialog = page.locator('#scoreAttributionDialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Click thrower button in the thrower column
  await page.locator('#throwerButtons .player-button').filter({ hasText: throwerName }).click();
  // Click receiver button in the receiver column
  await page.locator('#receiverButtons .player-button').filter({ hasText: receiverName }).click();

  // Dialog auto-closes when both selected
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

/** Click "They Score". No dialog — just increments opponent score. */
export async function theyScore(page: Page) {
  await page.click('#pbpTheyScoreBtn');
}

// ─── Pull Dialog ────────────────────────────────────────────────────────────

/**
 * Complete the pull dialog by selecting a puller and quality.
 * Called after starting a defense point.
 */
export async function completePullDialog(page: Page, pullerName: string, quality = 'Good Pull') {
  const dialog = page.locator('#pullDialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Select the puller
  await page.locator('#pullPlayerButtons .player-button').filter({ hasText: pullerName }).click();
  // Select pull quality
  await page.locator(`#pullQualityButtons .pull-quality-btn[data-quality="${quality}"]`).click();
  // Proceed
  await page.click('#pullProceedBtn');
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

// ─── End Game ───────────────────────────────────────────────────────────────

/** End the game via the hamburger menu. Handles the confirm dialog. */
export async function endGame(page: Page) {
  page.once('dialog', dialog => dialog.accept());
  await page.click('#gameMenuBtn');
  await expect(page.locator('#gameMenuDropdown')).toBeVisible();
  await page.click('#menuEndGame');
  await expect(page.locator('#gameSummaryScreen')).toBeVisible({ timeout: 8_000 });
}

// ─── Assertions ─────────────────────────────────────────────────────────────

/** Assert the in-game score display. */
export async function expectScore(page: Page, us: number, them: number) {
  await expect(page.locator('#gameScoreUs')).toHaveText(String(us), { timeout: 5_000 });
  await expect(page.locator('#gameScoreThem')).toHaveText(String(them));
}

/** Assert the game summary final score. */
export async function expectFinalScore(page: Page, team: number, opponent: number) {
  await expect(page.locator('#teamFinalScore')).toHaveText(String(team));
  await expect(page.locator('#opponentFinalScore')).toHaveText(String(opponent));
}
