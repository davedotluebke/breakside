/**
 * Single-coach game flow
 *
 * Covers the most regression-prone path:
 *   create team → add players → start game → play offense point
 *   → score (skip attribution) → verify score → end game → summary
 */
import { test } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, weScoreSkip,
  expectScore, endGame, expectFinalScore,
} from '../helpers/app';

test.describe('single-coach full game flow', () => {
  test('create team, add players, start game, score, end game', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Smoke Signals');
    await startGame(page, 'offense');

    await expectScore(page, 0, 0);

    // Play a point: select players → start → score → skip attribution
    await selectAllPlayers(page);
    await startPoint(page);
    await weScoreSkip(page);

    await expectScore(page, 1, 0);

    // End game
    await endGame(page);
    await expectFinalScore(page, 1, 0);
  });
});
