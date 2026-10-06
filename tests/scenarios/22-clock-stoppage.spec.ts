/**
 * Stoppages and the "Clock stopped" toast (store/pointClock.js § Stoppages,
 * game/clockStoppedToast.js; ARCHITECTURE.md § Point clock → Stoppages)
 *
 * A timeout, an injury sub or the header pause button stops the point clock
 * until the next recorded play. Pins, end to end on the Simple tab:
 *   - a mid-point timeout stops the clock (segment banked, marker nulled,
 *     reason recorded), freezes the header chip, and raises a persistent
 *     toast with a Restart button
 *   - the next recorded play restarts the clock and takes the toast away;
 *     the stoppage is not play (banked time does not grow across it)
 *   - the pause button is the same state: it stops with the same toast, and
 *     the toast's Restart button restarts
 *   - dismissing the toast leaves the clock stopped; the header play button
 *     restarts it
 *   - standby hides the toast and brings it back on the way out
 *   - undoing the timeout resumes the clock from the moment it stopped
 *   - a timeout between points stops nothing and shows nothing
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, theyScore, expectScore,
} from '../helpers/app';

const uniqueTeam = () => `Stoppage Testers ${Date.now().toString(36)}`;

const toast = (page: Page) => page.locator('.toast.toast-clock-stopped');
const restartBtn = (page: Page) => toast(page).locator('.toast-action-btn', { hasText: 'Restart clock' });
const chip = (page: Page) => page.locator('#gameTimerValue');
const pauseBtn = (page: Page) => page.locator('#gameTimerPauseBtn');
const sun = (page: Page) => page.locator('#gameWakeLockBtn');
const overlay = (page: Page) => page.locator('#standbyScreen');

/** The live point's clock fields, as plain values. */
async function clock(page: Page) {
  return page.evaluate(() => {
    const p = (window as any).currentGame()?.points.at(-1);
    return {
      winner: p?.winner ?? null,
      pending: !!p?.clockPending,
      stopped: p?.clockStopped ?? null,
      start: p?.startTimestamp ? new Date(p.startTimestamp).getTime() : null,
      stoppedAt: p?.lastPauseTime ? new Date(p.lastPauseTime).getTime() : null,
      banked: p?.totalPointTime ?? 0,
    };
  });
}

/**
 * Record a timeout from the Game Events modal, attributed to us. The modal
 * opens from the Line tab's own Events button (where the app sits between
 * points) or the Simple / All panel's, whichever is showing.
 */
async function callTimeout(page: Page) {
  const lineTabBtn = page.locator('#lineTabGameEventsBtn');
  const btn = (await lineTabBtn.isVisible()) ? lineTabBtn : page.locator('#pbpGameEventsBtn');
  await btn.click();
  await expect(page.locator('#gameEventsModal')).toBeVisible({ timeout: 5_000 });
  await page.click('#geTimeoutBtn');
  await expect(page.locator('#timeoutWhoModal')).toBeVisible({ timeout: 5_000 });
  await page.click('#toWhoUsBtn');
  await expect(page.locator('#timeoutWhoModal')).not.toBeVisible({ timeout: 5_000 });
}

/**
 * Record a completed pass through the shared possession core — the same
 * chokepoint the Full / Field tabs, the Key Play dialog and the narration
 * engine append plays through.
 */
async function recordThrow(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const team = (w.teams || []).find((t: any) => t.games && t.games.length);
    const [thrower, receiver] = team.teamRoster;
    w.pbpPossession.createThrow(thrower, receiver, {});
  });
}

async function startFirstPoint(page: Page) {
  await goToApp(page);
  await setupTeamWithPlayers(page, uniqueTeam());
  await startGame(page, 'offense');
  await selectAllPlayers(page);
  await startPoint(page);
  // Simple tab: the clock runs from Start Point.
  await expect.poll(async () => (await clock(page)).start).not.toBeNull();
  // Let the post-start sync echo land before the first gesture (it replaces
  // game.points; docs/dev-notes/preview-testing.md § State and roles).
  await page.waitForTimeout(4_500);
}

test.describe('point clock stoppages', () => {
  test('a timeout stops the clock with a persistent toast; the next play restarts it', async ({ page }) => {
    await startFirstPoint(page);
    await expect(toast(page)).toHaveCount(0);

    const before = Date.now();
    await callTimeout(page);
    let c = await clock(page);
    expect(c.stopped, 'the reason is recorded').toBe('timeout');
    expect(c.start, 'no running segment').toBeNull();
    expect(c.stoppedAt!).toBeGreaterThanOrEqual(before - 1_000);
    expect(c.banked, 'the segment so far is banked').toBeGreaterThan(0);
    const bankedAtStop = c.banked;

    await expect(toast(page)).toBeVisible({ timeout: 5_000 });
    await expect(toast(page)).toContainText('Clock stopped');
    await expect(toast(page)).toContainText('timeout');
    await expect(restartBtn(page)).toBeVisible();
    await expect(chip(page)).toHaveClass(/timer-paused/);
    await expect(pauseBtn(page)).toHaveClass(/paused/);

    // The toast does not expire, and its counter moves.
    const counter = toast(page).locator('.clock-stopped-for');
    const first = await counter.textContent();
    await page.waitForTimeout(2_200);
    await expect(toast(page)).toBeVisible();
    expect(await counter.textContent()).not.toBe(first);

    // A recorded play restarts the clock: fresh segment, toast gone, and
    // nothing banked for the stoppage.
    const restartAfter = Date.now();
    await recordThrow(page);
    await expect(toast(page)).toHaveCount(0, { timeout: 5_000 });
    c = await clock(page);
    expect(c.stopped).toBeNull();
    expect(c.start).not.toBeNull();
    expect(c.start!).toBeGreaterThanOrEqual(restartAfter - 1_000);
    expect(c.banked, 'the stoppage is not play').toBe(bankedAtStop);
    await expect(chip(page)).not.toHaveClass(/timer-paused/);
    await expect(pauseBtn(page)).not.toHaveClass(/paused/);
  });

  test('the pause button is the same stopped state; the toast\'s Restart button restarts', async ({ page }) => {
    await startFirstPoint(page);

    await pauseBtn(page).click();
    let c = await clock(page);
    expect(c.stopped).toBe('manual');
    expect(c.start).toBeNull();
    await expect(toast(page)).toBeVisible({ timeout: 5_000 });
    await expect(toast(page)).toContainText('paused');

    await restartBtn(page).click();
    await expect(toast(page)).toHaveCount(0, { timeout: 5_000 });
    c = await clock(page);
    expect(c.stopped).toBeNull();
    expect(c.start).not.toBeNull();
  });

  test('dismissing the toast leaves the clock stopped; the header play button restarts it', async ({ page }) => {
    await startFirstPoint(page);
    await callTimeout(page);
    await expect(toast(page)).toBeVisible({ timeout: 5_000 });

    await toast(page).locator('.toast-close').click();
    await expect(toast(page)).toHaveCount(0, { timeout: 5_000 });
    // Still stopped, and the toast stays away for this stop (the 1 s
    // reconcile must not bring it back).
    await page.waitForTimeout(2_200);
    expect((await clock(page)).stopped).toBe('timeout');
    await expect(toast(page)).toHaveCount(0);
    await expect(pauseBtn(page)).toHaveClass(/paused/);

    await pauseBtn(page).click();
    const c = await clock(page);
    expect(c.stopped).toBeNull();
    expect(c.start).not.toBeNull();

    // A later stop shows the toast again.
    await pauseBtn(page).click();
    await expect(toast(page)).toBeVisible({ timeout: 5_000 });
  });

  test('standby hides the toast and brings it back on the way out', async ({ page }) => {
    await startFirstPoint(page);
    await callTimeout(page);
    await expect(toast(page)).toBeVisible({ timeout: 5_000 });

    await sun(page).click();
    await expect(page.locator('body')).toHaveClass(/standby-active/);
    await expect(toast(page)).toHaveCount(0, { timeout: 5_000 });
    expect((await clock(page)).stopped, 'standby changes nothing about the clock').toBe('timeout');

    // Tap the black screen: the overlay swallows the tap and the toast is
    // back by the time it has gone.
    await overlay(page).click({ position: { x: 20, y: 200 } });
    await expect(page.locator('body')).not.toHaveClass(/standby-active/);
    await expect(toast(page)).toBeVisible({ timeout: 5_000 });
    await expect(restartBtn(page)).toBeVisible();
  });

  test('undoing the timeout resumes the clock from the moment it stopped', async ({ page }) => {
    await startFirstPoint(page);
    await callTimeout(page);
    const stopped = await clock(page);
    expect(stopped.stopped).toBe('timeout');
    await page.waitForTimeout(1_500);

    await page.click('#pbpUndoBtn');
    await expect(toast(page)).toHaveCount(0, { timeout: 5_000 });
    const c = await clock(page);
    expect(c.stopped).toBeNull();
    expect(c.start, 'the segment runs from the stop, not from the undo').toBe(stopped.stoppedAt);
    expect(c.banked).toBe(stopped.banked);
    await expect(chip(page)).not.toHaveClass(/timer-paused/);
  });

  test('a timeout between points stops nothing and shows nothing', async ({ page }) => {
    await startFirstPoint(page);
    await theyScore(page);
    await expectScore(page, 0, 1);

    await callTimeout(page);
    const c = await clock(page);
    expect(c.winner).toBe('opponent');
    expect(c.stopped).toBeNull();
    await page.waitForTimeout(1_500);
    await expect(toast(page)).toHaveCount(0);
  });
});
