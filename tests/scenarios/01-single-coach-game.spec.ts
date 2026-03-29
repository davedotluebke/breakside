/**
 * Single-coach game flow
 *
 * Covers the most regression-prone path:
 *   create team → add players → start game → play offense point
 *   → score (skip attribution) → verify score → end game → summary
 */
import { test, expect, Page } from '@playwright/test';
import { TEST_PARAMS } from '../playwright.config';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function goToApp(page: Page) {
  await page.goto(`/?${TEST_PARAMS}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
}

async function createTeam(page: Page, name: string) {
  await page.click('#createNewTeamBtn');
  await expect(page.locator('#createTeamModal')).toBeVisible();
  await page.fill('#newTeamNameInput', name);
  await page.click('#saveNewTeamBtn');
  // After saving, navigates to roster screen
  await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 8_000 });
}

async function addPlayer(page: Page, name: string, number: string, gender: 'FMP' | 'MMP') {
  await page.fill('#newPlayerInput', name);
  await page.fill('#newPlayerNumberInput', number);
  const btnId = gender === 'FMP' ? '#addFMPPlayerBtn' : '#addMMPPlayerBtn';
  await page.click(btnId);
  // Wait for the player to appear in the roster list
  await expect(page.locator('#rosterList').getByText(name)).toBeVisible({ timeout: 5_000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('single-coach full game flow', () => {
  test('create team, add players, start game, score, end game', async ({ page }) => {
    // ── 1. Load app ──────────────────────────────────────────────────────────
    await goToApp(page);

    // ── 2. Create a team ──────────────────────────────────────────────────────
    await createTeam(page, 'Smoke Signals');

    // ── 3. Add players via Edit Roster ────────────────────────────────────────
    await page.click('#showRosterBtn');
    await expect(page.locator('#editRosterSubscreen')).toBeVisible();

    const players = [
      { name: 'Alice', number: '1', gender: 'FMP' as const },
      { name: 'Bob',   number: '2', gender: 'MMP' as const },
      { name: 'Carol', number: '3', gender: 'FMP' as const },
      { name: 'Dave',  number: '4', gender: 'MMP' as const },
      { name: 'Eve',   number: '5', gender: 'FMP' as const },
      { name: 'Frank', number: '6', gender: 'MMP' as const },
      { name: 'Grace', number: '7', gender: 'FMP' as const },
    ];
    for (const p of players) {
      await addPlayer(page, p.name, p.number, p.gender);
    }

    // ── 4. Back to Start Game ──────────────────────────────────────────────────
    await page.click('#backToStartGameBtn');
    await expect(page.locator('#startGameSubscreen')).toBeVisible();

    // ── 5. Configure and start game on offense ────────────────────────────────
    await page.fill('#opponentNameInput', 'Bad Guys');
    await page.click('#startGameOnOBtn');

    // Game screen should appear
    await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });

    // Initial score should be 0 – 0
    await expect(page.locator('#gameScoreUs')).toHaveText('0');
    await expect(page.locator('#gameScoreThem')).toHaveText('0');

    // ── 6. Select 7 players for the first point ───────────────────────────────
    // Check all players in the panel table
    const playerTable = page.locator('#panelActivePlayersTable');
    await expect(playerTable).toBeVisible({ timeout: 8_000 });

    const playerRows = playerTable.locator('tbody tr');
    await expect(playerRows).toHaveCount(7, { timeout: 5_000 });

    // Check all 7
    for (let i = 0; i < 7; i++) {
      const checkbox = playerRows.nth(i).locator('input[type="checkbox"]');
      if (!(await checkbox.isChecked())) {
        await checkbox.click();
      }
    }

    // ── 7. Start the point ─────────────────────────────────────────────────────
    const startPointBtn = page.locator('#pbpStartPointBtn');
    await expect(startPointBtn).toBeVisible({ timeout: 5_000 });
    await startPointBtn.click();

    // ── 8. Score a point (We Score → Skip attribution) ────────────────────────
    const weScoreBtn = page.locator('#pbpWeScoreBtn');
    await expect(weScoreBtn).toBeVisible({ timeout: 5_000 });
    await weScoreBtn.click();

    // Score attribution dialog
    await expect(page.locator('#scoreAttributionDialog')).toBeVisible({ timeout: 5_000 });
    await page.click('#skipAttributionBtn');

    // ── 9. Verify score incremented ───────────────────────────────────────────
    await expect(page.locator('#gameScoreUs')).toHaveText('1', { timeout: 5_000 });
    await expect(page.locator('#gameScoreThem')).toHaveText('0');

    // ── 10. End game via menu ──────────────────────────────────────────────────
    // Handle the confirm() dialog
    page.once('dialog', dialog => dialog.accept());
    await page.click('#gameMenuBtn');
    await expect(page.locator('#gameMenuDropdown')).toBeVisible();
    await page.click('#menuEndGame');

    // Should land on game summary screen
    await expect(page.locator('#gameSummaryScreen')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#teamFinalScore')).toHaveText('1');
    await expect(page.locator('#opponentFinalScore')).toHaveText('0');
  });
});
