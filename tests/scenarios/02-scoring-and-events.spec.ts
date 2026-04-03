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
  });
});
