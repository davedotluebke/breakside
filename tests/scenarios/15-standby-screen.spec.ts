/**
 * Standby screen (ui/standbyScreen.js)
 *
 * Pins the three rules the module exists for, end to end:
 *   - tapping ☀ in the game header covers the game with a true-black overlay
 *     showing the live score and, between points only, the next-point
 *     countdown — mirrored from the header, so a goal recorded while it is
 *     up shows through
 *   - the tap that wakes the screen is swallowed: the control under the thumb
 *     does not fire (Start Point between points, They Score during a point)
 *   - leaving the game tears it down, so it cannot be left over the summary
 *
 * Also pins the ☀ contract change that came with it: the button is visible in
 * a game regardless of wake-lock support (headless Chromium may refuse the
 * lock), and a plain tap no longer releases the lock.
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, weScoreSkip, expectScore,
} from '../helpers/app';

const overlay = (page: Page) => page.locator('#standbyScreen');
const sun = (page: Page) => page.locator('#gameWakeLockBtn');

/** Tap the middle of the overlay where `underneathId` sits — the swallow case. */
async function tapOverlayOver(page: Page, underneathId: string) {
  const box = await page.locator(underneathId).boundingBox();
  expect(box, `${underneathId} should be laid out under the overlay`).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test.describe('standby screen', () => {
  test('☀ enters standby; overlay mirrors score + countdown; waking tap is swallowed', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');

    // The button is there in a game, wake lock or not.
    await expect(sun(page)).toBeVisible();
    await expect(overlay(page)).toBeHidden();

    // Between points (fresh game): score, labels, and the next-point countdown.
    await sun(page).click();
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('#standbyScoreUs')).toHaveText('0');
    await expect(page.locator('#standbyScoreThem')).toHaveText('0');
    await expect(page.locator('#standbyLabelUs')).toHaveText('Night Owls');
    await expect(page.locator('#standbyLabelThem')).toHaveText('Bad Guys');

    const countdown = page.locator('#standbyCountdown');
    await expect(countdown).toBeVisible();
    await expect(page.locator('#standbyCountdownValue')).toHaveText(/^\d\d:\d\d$/);
    // It ticks: the mirrored value moves with the header's box.
    const before = await page.locator('#standbyCountdownValue').textContent();
    await expect(page.locator('#standbyCountdownValue')).not.toHaveText(before!, { timeout: 3_000 });
    await expect(page.locator('#standbyCountdownValue')).toHaveText(
      await page.locator('#timerDisplay').textContent() as string);

    // Nothing but the overlay is lit: the game screen is still there
    // underneath, untouched (we return to it, not to a rebuilt one).
    await expect(page.locator('#panelActivePlayersTable')).toBeAttached();

    // Waking tap over Start Point must not start a point: the countdown box
    // is still up afterwards and the Start Point button is still offered.
    await tapOverlayOver(page, '#pbpStartPointBtn');
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('#countdownTimer')).toBeVisible();
    await expect(page.locator('#pbpStartPointBtn')).toBeVisible();
    await expectScore(page, 0, 0);

    // During a point: no countdown; a waking tap over They Score must not score.
    await selectAllPlayers(page);
    await startPoint(page);
    await expect(page.locator('#countdownTimer')).toBeHidden();
    await sun(page).click();
    await expect(overlay(page)).toBeVisible();
    await expect(countdown).toBeHidden();
    await tapOverlayOver(page, '#pbpTheyScoreBtn');
    await expect(overlay(page)).toBeHidden();
    await expectScore(page, 0, 0);

    // A goal scored with standby down shows through when it comes back up,
    // and the countdown returns because we are between points again.
    await weScoreSkip(page);
    await expectScore(page, 1, 0);
    await sun(page).click();
    await expect(overlay(page)).toBeVisible();
    await expect(page.locator('#standbyScoreUs')).toHaveText('1');
    await expect(page.locator('#standbyScoreThem')).toHaveText('0');
    await expect(countdown).toBeVisible();

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
