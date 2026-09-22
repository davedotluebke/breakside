/**
 * Standby timer (ui/standbyTimer.js + utils/standbyPolicy.js)
 *
 * Pins, end to end with a two-second idle time:
 *   - idle in a game between points → the warning toast with its countdown
 *     and the long-press hint → left alone, standby fades in and then swallows
 *   - any input during the countdown cancels it and re-arms the clock; so
 *     does dismissing the toast with its ×
 *   - the gate: the Active Coach mid-point is never taken to standby, and
 *     the clock is already running when the point ends
 *   - press-and-hold ☀ turns the timer off (persisted, with a toast) and on
 *     again
 *
 * The idle time is set through the same setting the Battery section writes,
 * via the window seam ui/standbyTimer.js exposes for exactly this.
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, weScoreSkip, expectScore,
} from '../helpers/app';

const overlay = (page: Page) => page.locator('#standbyScreen');
const warning = (page: Page) => page.locator('#toastContainer .toast-standby');
const sun = (page: Page) => page.locator('#gameWakeLockBtn');

const IDLE_SECONDS = 2;
/** Idle time plus the 5-second countdown, with slack for a loaded machine. */
const ENTRY_TIMEOUT = (IDLE_SECONDS + 5 + 4) * 1000;

async function setIdleSeconds(page: Page, seconds: number) {
  await page.evaluate((s) => {
    (window as any).advancedSettings.set('power.standbyIdleSec', s);
    (window as any).standbyTimer.refresh();
  }, seconds);
}

async function expectActiveCoach(page: Page) {
  // A solo coach auto-claims both roles shortly after entering the game; the
  // mid-point gate below only applies to the Active Coach, so pin that first.
  await expect.poll(() => page.evaluate(() => !!(window as any).isActiveCoach?.()), { timeout: 10_000 }).toBe(true);
}

async function longPressSun(page: Page) {
  const box = await sun(page).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

test.describe('standby timer', () => {
  test('idle → countdown toast → soft fade-in; input cancels; the clock re-arms', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    await expectActiveCoach(page);
    await setIdleSeconds(page, IDLE_SECONDS);

    // Between points, idle: the warning appears, with the countdown and the hint.
    await expect(warning(page)).toBeVisible({ timeout: (IDLE_SECONDS + 4) * 1000 });
    await expect(warning(page)).toContainText(`Idle for ${IDLE_SECONDS} seconds`);
    await expect(warning(page)).toContainText('entering standby in');
    await expect(warning(page).locator('.toast-sub')).toHaveText('Long-press ☀ to toggle standby timer');
    const first = await warning(page).locator('strong').textContent();
    await expect(warning(page).locator('strong')).not.toHaveText(first!, { timeout: 3_000 });
    await expect(overlay(page)).toBeHidden();

    // A key press is input: the warning goes and standby does not come.
    await page.keyboard.press('Shift');
    await expect(warning(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();

    // The clock re-armed: left alone, the warning returns, runs out, and the
    // overlay fades in (not yet the tap target) and then becomes the ordinary
    // standby screen.
    await expect(warning(page)).toBeVisible({ timeout: (IDLE_SECONDS + 4) * 1000 });
    await expect(overlay(page)).toHaveClass(/standby-screen--active/, { timeout: ENTRY_TIMEOUT });
    await expect(overlay(page)).not.toHaveClass(/standby-screen--entering/, { timeout: 4_000 });
    await expect(warning(page)).toBeHidden();
    await expect(page.locator('body')).toHaveClass(/standby-active/);
    await expect(overlay(page)).toHaveCSS('pointer-events', 'auto');

    // Tap to leave, as ever.
    await overlay(page).click();
    await expect(overlay(page)).toBeHidden();

    // Dismissing the warning with its × cancels as well, and re-arms.
    await expect(warning(page)).toBeVisible({ timeout: (IDLE_SECONDS + 4) * 1000 });
    await warning(page).locator('.toast-close').click();
    await expect(warning(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();
    await expect(warning(page)).toBeVisible({ timeout: (IDLE_SECONDS + 4) * 1000 });
    await page.keyboard.press('Shift');
    await expect(warning(page)).toBeHidden();
  });

  test('a tap during the soft fade-in reaches the game and cancels the standby', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    await expectActiveCoach(page);
    await selectAllPlayers(page);
    await setIdleSeconds(page, IDLE_SECONDS);

    // Where Start Point sits, measured now: the fade-in lasts 700 ms and the
    // tap has to land inside it.
    const box = await page.locator('#pbpStartPointBtn').boundingBox();
    expect(box).not.toBeNull();

    // Wait for the fade-in to begin. Not an expect(): Playwright's expect
    // backs its polling off to once a second, which can step right over a
    // 700 ms window. waitForFunction polls every frame.
    await page.waitForFunction(
      () => document.getElementById('standbyScreen')?.classList.contains('standby-screen--entering'),
      null, { timeout: ENTRY_TIMEOUT, polling: 'raf' },
    );
    const midFade = await page.evaluate(() => {
      const el = document.getElementById('standbyScreen')!;
      return { pe: getComputedStyle(el).pointerEvents, active: el.classList.contains('standby-screen--active') };
    });
    expect(midFade).toEqual({ pe: 'none', active: true });
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

    // Not swallowed: the point started. And the standby is gone.
    await expect(page.locator('#countdownTimer')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).currentGame().points.length)).toBe(1);
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/standby-active/);
  });

  test('never for the Active Coach mid-point; the clock is running when the point ends', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    await expectActiveCoach(page);
    await selectAllPlayers(page);
    await startPoint(page);
    await setIdleSeconds(page, IDLE_SECONDS);

    // Idle well past the idle time plus the countdown: nothing happens.
    await page.waitForTimeout((IDLE_SECONDS + 6) * 1000);
    await expect(warning(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();

    // The goal ends the point; the clock was re-armed on each held check, so
    // the warning follows within one idle period of the last tap.
    await weScoreSkip(page);
    await expectScore(page, 1, 0);
    await expect(warning(page)).toBeVisible({ timeout: (IDLE_SECONDS + 4) * 1000 });
  });

  test('press-and-hold ☀ turns the timer off (with a toast) and on again', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    await expectActiveCoach(page);
    await setIdleSeconds(page, IDLE_SECONDS);

    await longPressSun(page);
    await expect(page.locator('#toastContainer .toast').filter({ hasText: 'Standby timer off' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).standbyTimer.isEnabled())).toBe(false);
    // The hold did not also enter standby (its trailing click is swallowed).
    await expect(overlay(page)).toBeHidden();

    // Off means off: nothing after the idle time and the countdown.
    await page.waitForTimeout((IDLE_SECONDS + 6) * 1000);
    await expect(warning(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();

    await longPressSun(page);
    await expect(page.locator('#toastContainer .toast').filter({ hasText: 'Standby timer on' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).standbyTimer.isEnabled())).toBe(true);
    await expect(warning(page)).toBeVisible({ timeout: (IDLE_SECONDS + 4) * 1000 });
  });
});
