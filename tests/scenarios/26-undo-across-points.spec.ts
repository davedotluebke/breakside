/**
 * Undo across point boundaries (game/undoLogic.js, ARCHITECTURE.md § Undo)
 *
 * Pins, end to end on the Simple tab:
 *   - between points, a timeout recorded after the score is undone on its
 *     own by the first Undo tap; the score stays
 *   - with nothing on top of the score, the first Undo from between points
 *     only warns, and a second tap within the window reopens the point
 *   - press and hold a Log line: the confirm names what goes, and the
 *     line's event and everything after it are undone — a reopened point is
 *     live again with its clock stopped, a removed point seeds the next line
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, theyScore, weScoreWithAttribution, expectScore,
  completePullDialog,
} from '../helpers/app';

// Not a "test" name on purpose: isTestGame skips the confirm, and the
// confirm text is part of what this spec pins.
const uniqueTeam = () => `Undo Checkers ${Date.now().toString(36)}`;

const tabButton = (page: Page, tab: string) => page.locator(`#headerSegControl button[data-tab="${tab}"]`);
const logLine = (page: Page, text: string) => page.locator('#gameLogEvents [data-entry]', { hasText: text }).first();

/** The game as plain values. */
async function state(page: Page) {
  return page.evaluate(() => {
    const g = (window as any).currentGame();
    const last = g.points.at(-1);
    return {
      points: g.points.length,
      scores: { us: g.scores.team, them: g.scores.opponent },
      lastWinner: last?.winner ?? null,
      lastEvents: last ? last.possessions.reduce((n: number, p: any) => n + p.events.length, 0) : null,
      lastStopped: last?.clockStopped ?? null,
      lastStart: last?.startTimestamp ? new Date(last.startTimestamp).getTime() : null,
      odLine: (g.pendingNextLine && g.pendingNextLine.odLine) || null,
    };
  });
}

/** Record a completed pass through the shared possession core. */
async function recordThrow(page: Page, thrower = 'Alice', receiver = 'Bob') {
  await page.evaluate(([t, r]) => {
    const w = window as any;
    const team = (w.teams || []).find((x: any) => x.games && x.games.length);
    const byName = (n: string) => team.teamRoster.find((p: any) => p.name === n);
    w.pbpPossession.createThrow(byName(t), byName(r), {});
  }, [thrower, receiver]);
}

/** Record a timeout from the Game Events modal, attributed to us. */
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

/** Press and hold a Log line (the undo-to-here gesture). */
async function pressAndHold(page: Page, line: ReturnType<typeof logLine>) {
  await line.scrollIntoViewIfNeeded();
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

async function startNextPoint(page: Page) {
  await selectAllPlayers(page);
  await startPoint(page);
  // Let the post-start sync echo land before the first gesture (it replaces
  // game.points; docs/dev-notes/preview-testing.md § State and roles).
  await page.waitForTimeout(4_500);
}

/**
 * A game at 1–1: point 1 a pass then our goal, point 2 (we pull: Alice's pull
 * is its one play) a They Score.
 */
async function twoPoints(page: Page) {
  await goToApp(page);
  await setupTeamWithPlayers(page, uniqueTeam());
  await startGame(page, 'offense');
  await startNextPoint(page);
  await recordThrow(page, 'Alice', 'Bob');
  await weScoreWithAttribution(page, 'Bob', 'Carol');
  await expectScore(page, 1, 0);
  await selectAllPlayers(page);
  await startPoint(page);
  await completePullDialog(page, 'Alice');
  await page.waitForTimeout(4_500);
  await theyScore(page);
  await expectScore(page, 1, 1);
  await page.waitForTimeout(1_500);
}

test.describe('undo across point boundaries', () => {
  test.describe.configure({ timeout: 60_000 });

  test('between points: a timeout on top of the score is undone first; reopening the point takes a second tap', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, uniqueTeam());
    await startGame(page, 'offense');
    await startNextPoint(page);
    await theyScore(page);
    await expectScore(page, 0, 1);

    await callTimeout(page);
    let s = await state(page);
    expect(s.lastEvents, 'the timeout sits on the finished point').toBe(1);

    // The Simple panel's Undo is live between points.
    await tabButton(page, 'simple').click();
    await page.click('#pbpUndoBtn');
    s = await state(page);
    expect(s.lastEvents, 'the timeout is gone').toBe(0);
    expect(s.lastWinner, 'the score stays').toBe('opponent');
    await expectScore(page, 0, 1);

    // Nothing on top of the score now: the first tap warns.
    await page.click('#pbpUndoBtn');
    await expect(page.locator('.toast', { hasText: 'tap Undo again to reopen' })).toBeVisible({ timeout: 5_000 });
    s = await state(page);
    expect(s.lastWinner).toBe('opponent');
    await expectScore(page, 0, 1);

    // The second tap reopens — a They Score with nothing recorded is simply
    // removed, back to between points.
    await page.click('#pbpUndoBtn');
    await expectScore(page, 0, 0);
    s = await state(page);
    expect(s.points).toBe(0);
    // Back on the Line tab, Start Point offered again.
    await expect(page.locator('#lineTabStartPointBtn')).toBeVisible({ timeout: 5_000 });
  });

  test('press and hold a line of an earlier point: the confirm names what goes, the point is reopened with its clock stopped', async ({ page }) => {
    await twoPoints(page);

    const dialogs: string[] = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

    await tabButton(page, 'log').click();
    const line = logLine(page, 'Alice throws to Bob');
    await expect(line).toBeVisible({ timeout: 5_000 });
    await pressAndHold(page, line);

    await expect.poll(() => dialogs.length, 'the confirm was shown').toBe(1);
    expect(dialogs[0]).toBe('Undo 4 events back to here? Point 1 is reopened and point 2 is removed.');

    await expectScore(page, 0, 0);
    const s = await state(page);
    expect(s.points).toBe(1);
    expect(s.lastWinner, 'point 1 is live again').toBe('');
    expect(s.lastEvents, 'the pass went too — it was the pressed line').toBe(0);
    expect(s.lastStopped, 'a reopened point does not count the wall time as play').toBe('manual');
    expect(s.lastStart).toBeNull();
    await expect(page.locator('.toast', { hasText: 'point 1 reopened' })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.toast.toast-clock-stopped')).toBeVisible({ timeout: 5_000 });

    // Play on: the next recorded play restarts the clock, and the point can
    // be finished again.
    await recordThrow(page, 'Carol', 'Dave');
    await expect.poll(async () => (await state(page)).lastStopped).toBeNull();
    await tabButton(page, 'simple').click();
    await theyScore(page);
    await expectScore(page, 0, 1);
    expect((await state(page)).points).toBe(1);
  });

  test('press and hold a roster line removes that point and seeds the next line with its roster', async ({ page }) => {
    await twoPoints(page);

    const dialogs: string[] = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

    await tabButton(page, 'log').click();
    const line = logLine(page, 'Point 2 roster:');
    await expect(line).toBeVisible({ timeout: 5_000 });
    await pressAndHold(page, line);

    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toBe('Undo 2 events back to here? Point 2 is removed.');

    await expectScore(page, 1, 0);
    const s = await state(page);
    expect(s.points).toBe(1);
    expect(s.lastWinner, 'point 1 is untouched').toBe('team');
    expect(s.odLine, 'the removed point\'s line is Next').toEqual(expect.arrayContaining(['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace']));
    // Between points again, on the Line tab with Start Point offered.
    await expect(tabButton(page, 'line')).toHaveClass(/\bactive\b/, { timeout: 5_000 });
    await expect(page.locator('#lineTabStartPointBtn')).toBeVisible({ timeout: 5_000 });
  });

  test('a header line is not an undo target; a tap still seeks rather than undoing', async ({ page }) => {
    await twoPoints(page);
    const dialogs: string[] = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

    await tabButton(page, 'log').click();
    const header = logLine(page, 'Game Summary:');
    await expect(header).toBeVisible({ timeout: 5_000 });
    await pressAndHold(page, header);
    await page.waitForTimeout(500);
    expect(dialogs.length).toBe(0);
    await expectScore(page, 1, 1);

    // A plain tap on an event line changes nothing.
    await logLine(page, 'Alice throws to Bob').click();
    await page.waitForTimeout(500);
    expect(dialogs.length).toBe(0);
    expect((await state(page)).points).toBe(2);
  });
});
