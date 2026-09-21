/**
 * Standby screen (ui/standbyScreen.js)
 *
 * Pins the three rules the module exists for, end to end:
 *   - tapping ☀ in the game header covers the game with a true-black overlay
 *     showing the live score and, between points only, the next-point
 *     countdown — mirrored from the header, so a goal recorded while it is
 *     up shows through
 *   - the tap that wakes the screen is swallowed: the control under the thumb
 *     does not fire (Start Point when a line is ready, They Score mid-point)
 *   - leaving the game tears it down, so it cannot be left over the summary
 *
 * Also pins the ☀ contract change that came with it: the button is visible in
 * a game regardless of wake-lock support (headless Chromium may refuse the
 * lock), and a plain tap no longer releases the lock.
 *
 * Note the countdown only runs after a point ends (game/pointManagement.js
 * moveToNextPoint), never before the first pull — so a fresh game shows the
 * score alone, and the countdown assertions come after the first goal.
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, weScoreSkip, expectScore,
} from '../helpers/app';

const overlay = (page: Page) => page.locator('#standbyScreen');
const sun = (page: Page) => page.locator('#gameWakeLockBtn');
const countdown = (page: Page) => page.locator('#standbyCountdown');

/** Tap the middle of the overlay where `underneathId` sits — the swallow case. */
async function tapOverlayOver(page: Page, underneathId: string) {
  const box = await page.locator(underneathId).boundingBox();
  expect(box, `${underneathId} should be laid out under the overlay`).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

/** How many points the live game has — the thing a swallowed Start Point must not change. */
async function pointCount(page: Page) {
  return page.evaluate(() => (window as any).currentGame()?.points?.length ?? -1);
}

test.describe('standby screen', () => {
  test('☀ enters standby; overlay mirrors score + countdown; waking tap is swallowed', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');

    // The button is there in a game, wake lock or not.
    await expect(sun(page)).toBeVisible();
    await expect(overlay(page)).toBeHidden();

    // A line is picked so Start Point is a live control under the overlay.
    await selectAllPlayers(page);
    await expect(page.locator('#pbpStartPointBtn')).toBeEnabled();
    const pointsBefore = await pointCount(page);

    // Before the first pull: score and labels, no countdown (none is running).
    await sun(page).click();
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('#standbyScoreUs')).toHaveText('0');
    await expect(page.locator('#standbyScoreThem')).toHaveText('0');
    await expect(page.locator('#standbyLabelUs')).toHaveText('Night Owls');
    await expect(page.locator('#standbyLabelThem')).toHaveText('Bad Guys');
    await expect(countdown(page)).toBeHidden();

    // The game screen is still there underneath, untouched — we return to
    // it, not to a rebuilt one.
    await expect(page.locator('#panelActivePlayersTable')).toBeAttached();

    // Waking tap over Start Point must not start a point.
    await tapOverlayOver(page, '#pbpStartPointBtn');
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('#pbpStartPointBtn')).toBeVisible();
    expect(await pointCount(page)).toBe(pointsBefore);
    await expectScore(page, 0, 0);

    // During a point: still no countdown; a waking tap over They Score must
    // not score.
    await startPoint(page);
    await expect(page.locator('#countdownTimer')).toBeHidden();
    await sun(page).click();
    await expect(overlay(page)).toBeVisible();
    await expect(countdown(page)).toBeHidden();
    await tapOverlayOver(page, '#pbpTheyScoreBtn');
    await expect(overlay(page)).toBeHidden();
    await expectScore(page, 0, 0);

    // A goal scored with standby down shows through when it comes back up,
    // and now that a point has ended the next-point countdown is running.
    await weScoreSkip(page);
    await expectScore(page, 1, 0);
    await expect(page.locator('#countdownTimer')).toBeVisible();
    await sun(page).click();
    await expect(overlay(page)).toBeVisible();
    await expect(page.locator('#standbyScoreUs')).toHaveText('1');
    await expect(page.locator('#standbyScoreThem')).toHaveText('0');
    await expect(countdown(page)).toBeVisible();
    await expect(page.locator('#standbyCountdownValue')).toHaveText(/^\d\d:\d\d$/);

    // It ticks, and it is the header's own number: read both in one go so a
    // tick can't land between the two reads.
    const before = await page.locator('#standbyCountdownValue').textContent();
    await expect(page.locator('#standbyCountdownValue')).not.toHaveText(before!, { timeout: 3_000 });
    const [header, mirrored] = await page.evaluate(() => [
      document.getElementById('timerDisplay')!.textContent,
      document.getElementById('standbyCountdownValue')!.textContent,
    ]);
    expect(mirrored).toBe(header);

    // Keyboard exit (desktop): Escape leaves standby.
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toBeHidden();
  });

  test('a mirrored score changes while standby is up', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    await selectAllPlayers(page);
    await startPoint(page);

    await sun(page).click();
    await expect(overlay(page)).toBeVisible();
    await expect(page.locator('#standbyScoreThem')).toHaveText('0');

    // Drive the score from the game's own updater (what a sync from another
    // coach's device does), without touching the covered buttons.
    await page.evaluate(() => (window as any).updateGameScreenScore?.(2, 3));
    await expect(page.locator('#standbyScoreUs')).toHaveText('2');
    await expect(page.locator('#standbyScoreThem')).toHaveText('3');
  });

  test('leaving the game tears standby down', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');

    await sun(page).click();
    await expect(overlay(page)).toBeVisible();

    // exitGameScreen is the documented window survivor every leave/end path
    // funnels through; it flips the power plan's inGame, which is the signal
    // standby listens for.
    await page.evaluate(() => (window as any).exitGameScreen());
    await expect(overlay(page)).toBeHidden();
    await expect(sun(page)).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/standby-active/);
  });
});
