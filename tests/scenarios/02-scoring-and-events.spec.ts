/**
 * Scoring & events
 *
 * Tests the core play-by-play recording flows:
 *   - Defense point with pull dialog
 *   - Score attribution (thrower + receiver)
 *   - Opponent scoring ("They Score")
 *   - Multi-point game with mixed scoring
 */
import { test, expect } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, weScoreSkip,
  weScoreWithAttribution, theyScore,
  completePullDialog, expectScore, endGame, expectFinalScore,
} from '../helpers/app';

test.describe('scoring and events', () => {
  // Each test starts fresh: create team, add players, navigate to Start Game
  test.beforeEach(async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page);
  });

  test('defense point with pull dialog', async ({ page }) => {
    await startGame(page, 'defense');
    await expectScore(page, 0, 0);

    await selectAllPlayers(page);
    await startPoint(page);

    // Pull dialog should appear for defense points
    await completePullDialog(page, 'Bob', 'Good Pull');

    // Now on defense — opponent scores
    await theyScore(page);
    await expectScore(page, 0, 1);
  });

  test('score attribution with thrower and receiver', async ({ page }) => {
    await startGame(page, 'offense');

    await selectAllPlayers(page);
    await startPoint(page);

    // Score with full attribution — dialog auto-closes when both selected
    await weScoreWithAttribution(page, 'Alice', 'Bob');
    await expectScore(page, 1, 0);
  });

  test('hockey assist is the coach\'s call in the score dialog', async ({ page }) => {
    await startGame(page, 'offense');
    await selectAllPlayers(page);
    await startPoint(page);

    // Simple mode records no throws, so the dialog opens with the hockey-
    // assist box unchecked and nobody pre-selected. Naming a player first,
    // then the thrower and receiver (which auto-commits), records the call
    // on the scoring throw; the chosen player drops out of the dropdown
    // the moment they become the thrower or receiver.
    await page.click('#pbpWeScoreBtn');
    const dialog = page.locator('#scoreAttributionDialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    const haCheck = page.locator('#haCheck');
    const haSelect = page.locator('#haSelect');
    await expect(haCheck).not.toBeChecked();
    await expect(haSelect).toBeDisabled();
    await haCheck.check();
    await expect(haSelect).toBeEnabled();
    await haSelect.selectOption('Carol');
    await expect(page.locator('#haHuckCheck')).toBeEnabled();
    await page.locator('#throwerButtons .player-button').filter({ hasText: 'Alice' }).click();
    await expect(haSelect.locator('option', { hasText: 'Alice' })).toHaveCount(0);
    await expect(haSelect).toHaveValue('Carol');
    await page.locator('#receiverButtons .player-button').filter({ hasText: 'Bob' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    await expectScore(page, 1, 0);

    const recorded = await page.evaluate(() => {
      const game = (window as any).currentGame();
      const ev = game.points.at(-1).possessions.at(-1).events.at(-1);
      return { summary: ev.summarize(), ha: ev.hockeyAssist?.name ?? null, huck: ev.hockeyAssistHuck_flag, none: ev.noHockeyAssist_flag };
    });
    expect(recorded).toEqual({ summary: 'Alice throws to Bob for the score! (hockey assist: Carol)', ha: 'Carol', huck: false, none: false });

    // A second score with the box left unchecked is an explicit "none",
    // which is what keeps the stats fallback (the previous throw) off it.
    await selectAllPlayers(page);
    await startPoint(page);
    await completePullDialog(page, 'Dave', 'Good Pull');
    await weScoreWithAttribution(page, 'Eve', 'Frank');
    await expectScore(page, 2, 0);
    const second = await page.evaluate(() => {
      const ev = (window as any).currentGame().points.at(-1).possessions.at(-1).events.at(-1);
      return { ha: ev.hockeyAssist, none: ev.noHockeyAssist_flag };
    });
    expect(second).toEqual({ ha: null, none: true });
  });

  test('They Score increments opponent score', async ({ page }) => {
    await startGame(page, 'offense');

    await selectAllPlayers(page);
    await startPoint(page);

    await theyScore(page);
    await expectScore(page, 0, 1);
  });

  test('multi-point game with mixed scoring ends correctly', async ({ page }) => {
    await startGame(page, 'offense', 'Rivals');

    // ── Point 1: We score (skip) ──
    await selectAllPlayers(page);
    await startPoint(page);
    await weScoreSkip(page);
    await expectScore(page, 1, 0);

    // ── Point 2: They score ──
    await selectAllPlayers(page);
    await startPoint(page);
    // After we scored on O, next point starts on D — pull dialog
    await completePullDialog(page, 'Dave', 'Okay Pull');
    await theyScore(page);
    await expectScore(page, 1, 1);

    // ── Point 3: We score with attribution ──
    await selectAllPlayers(page);
    await startPoint(page);
    await weScoreWithAttribution(page, 'Carol', 'Eve');
    await expectScore(page, 2, 1);

    // End game and verify summary
    await endGame(page);
    await expectFinalScore(page, 2, 1);

    // Game Flow (ui/gameFlowChart.js) is collapsed by default
    // (ui/summarySections.js); opening it draws the chart — one marker per
    // point — with the headline lines and the Connections block for the
    // attributed score. Stats and log start open and collapse on tap.
    const flowSection = page.locator('#gameFlowSection');
    await expect(flowSection).toBeVisible();
    await expect(flowSection).toHaveClass(/collapsed/);
    await expect(page.locator('#gameFlowChartHost .gf-pt')).toHaveCount(0);
    await flowSection.locator('.summary-section-toggle').click();
    await expect(flowSection).not.toHaveClass(/collapsed/);
    await expect(page.locator('#gameFlowChartHost .gf-pt')).toHaveCount(3);
    await expect(page.locator('#gameFlowChartHost .gf-line', { hasText: 'Lead changes' })).toBeVisible();
    await expect(page.locator('#gameConnectionsHost .gf-pair').first()).toBeVisible();

    await expect(page.locator('#playerStats')).not.toHaveClass(/collapsed/);
    await expect(page.locator('#gameSummaryEventLog')).toBeVisible();
    await page.locator('#gameSummaryEventLogSection .summary-section-toggle').click();
    await expect(page.locator('#gameSummaryEventLog')).toBeHidden();
    await page.locator('#gameSummaryEventLogSection .summary-section-toggle').click();
    await expect(page.locator('#gameSummaryEventLog')).toBeVisible();
  });
});
