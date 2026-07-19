/**
 * Id-era point.players resolution
 *
 * Regression test for the "pull dialog never enables Proceed" bug: games
 * whose lines arrive through pendingNextLine sync store player IDS (not
 * names) in point.players. UI that resolved those entries with a raw
 * name lookup got undefined back — the pull dialog's selection sentinel
 * collided with it (tapped buttons never enabled Proceed) and Full PBP
 * silently dropped the player rows.
 *
 * Stages the real production path: seed pendingNextLine.odLine with player
 * ids between points, start a defense point, and verify the pull dialog
 * shows names, enables Proceed on selection, and records the right puller.
 */
import { test, expect } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, weScoreSkip, expectScore,
} from '../helpers/app';

test.describe('id-era point.players entries', () => {
  test('pull dialog resolves ids to names and enables Proceed', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Id Era Team');
    await startGame(page, 'offense');

    // Point 1 (offense): play and score so the next point starts on defense
    // (we pull) and the between-points window is open for line planning.
    await selectAllPlayers(page);
    await startPoint(page);
    await weScoreSkip(page);
    await expectScore(page, 1, 0);

    // Between points: seed pendingNextLine.odLine with player IDS — exactly
    // what a line synced from another coach's device looks like. The fresh
    // ModifiedAt stamp makes it win the effective-line comparison, so the
    // next point's point.players will be ids, not names.
    const seeded = await page.evaluate(() => {
      const game = (window as any).currentGame();
      const ids = (game.rosterSnapshot?.players || []).map((p: any) => p.id);
      if (!ids.length) return 0;
      game.pendingNextLine = game.pendingNextLine || {};
      game.pendingNextLine.odLine = ids.slice(0, 7);
      game.pendingNextLine.odLineModifiedAt = new Date().toISOString();
      game.pendingNextLine.odOnDeckLine = [];
      return ids.length;
    });
    expect(seeded).toBeGreaterThanOrEqual(7);

    await startPoint(page);

    // The new point's players really are ids (the era under test).
    const pointPlayers = await page.evaluate(() =>
      (window as any).currentGame().points.at(-1).players);
    expect(pointPlayers.every((e: string) => /-[a-z0-9]{4}$/.test(e))).toBe(true);

    // Defense point → pull dialog. Buttons must show player names (labels
    // may carry jersey numbers), never raw ids.
    const dialog = page.locator('#pullDialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    const buttons = page.locator('#pullPlayerButtons .player-button:not(.unknown-player)');
    await expect(buttons).toHaveCount(7);
    await expect(buttons.filter({ hasText: 'Alice' })).toHaveCount(1);
    for (const label of await buttons.allTextContents()) {
      expect(label).not.toMatch(/-[a-z0-9]{4}( |$)/);
    }

    // Selecting a player must enable Proceed (the original bug: it stayed
    // disabled because the id-era entry resolved to undefined).
    const proceedBtn = page.locator('#pullProceedBtn');
    await expect(proceedBtn).toBeDisabled();
    await buttons.filter({ hasText: 'Alice' }).click();
    await expect(proceedBtn).toBeEnabled();
    await proceedBtn.click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // The recorded pull is attributed to the real roster player.
    const pullerName = await page.evaluate(() => {
      const point = (window as any).currentGame().points.at(-1);
      const events = point.possessions[0]?.events || [];
      const pull = events.find((e: any) => e.type === 'Pull');
      return pull?.puller?.name || null;
    });
    expect(pullerName).toBe('Alice');
  });
});
