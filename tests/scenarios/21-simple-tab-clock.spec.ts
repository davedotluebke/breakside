/**
 * The point clock on the Simple tab (store/pointClock.js, ARCHITECTURE.md
 * § Point clock and the first touch)
 *
 * Simple mode has no pickup tap, so an offensive point armed on Full / Field
 * (waiting for the first touch) would never start its clock once the coach
 * moved to Simple, and nobody on the line would bank playing time. Pins:
 *   - an offensive point started on Simple runs its clock from Start Point
 *   - armed on Full, the clock stays armed through the Line tab and Field,
 *     and starts the moment the coach arrives on Simple
 *   - a clock already started by a pickup on Full is not overwritten when
 *     the coach then switches to Simple
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, theyScore, expectScore,
} from '../helpers/app';

const uniqueTeam = () => `Clock Testers ${Date.now().toString(36)}`;

const tabButton = (page: Page, tab: string) => page.locator(`#headerSegControl button[data-tab="${tab}"]`);

async function expectTab(page: Page, tab: string) {
  await expect(tabButton(page, tab), `the ${tab} tab should be active`).toHaveClass(/\bactive\b/, { timeout: 5_000 });
}

/** The live point's clock fields, as plain values. */
async function clock(page: Page) {
  return page.evaluate(() => {
    const p = (window as any).currentGame()?.points.at(-1);
    return {
      side: p?.startingPosition ?? null,
      pending: !!p?.clockPending,
      start: p?.startTimestamp ? new Date(p.startTimestamp).getTime() : null,
    };
  });
}

/** Start the next point from the Line tab, landing on the tracking tab used last. */
async function startNextPoint(page: Page, expectedTab: string) {
  await selectAllPlayers(page);
  await startPoint(page);
  await expectTab(page, expectedTab);
  // Let the post-start sync echo land before the first gesture (it replaces
  // game.points; docs/dev-notes/preview-testing.md § State and roles).
  await page.waitForTimeout(4_500);
}

test.describe('point clock on the Simple tab', () => {
  test('armed on Full, the clock starts on arriving at Simple; a running clock is left alone', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, uniqueTeam());
    await startGame(page, 'offense');

    // Point 1, recorded on Simple from the start: the clock runs at Start Point.
    await startNextPoint(page, 'simple');
    let c = await clock(page);
    expect(c.side).toBe('offense');
    expect(c.pending).toBe(false);
    expect(c.start).not.toBeNull();
    // They score, so we receive again on point 2.
    await theyScore(page);
    await expectScore(page, 0, 1);
    await expectTab(page, 'line');

    // Make Full the tracking tab.
    await tabButton(page, 'full').click();
    await expectTab(page, 'full');

    // Point 2 on Full: armed, waiting for the first touch.
    await startNextPoint(page, 'full');
    c = await clock(page);
    expect(c.side).toBe('offense');
    expect(c.pending, 'Full arms an offensive clock').toBe(true);
    expect(c.start).toBeNull();

    // Passing through Line (maps to the last tracking tab, Full) and Field
    // changes nothing.
    await tabButton(page, 'line').click();
    await expectTab(page, 'line');
    expect((await clock(page)).pending, 'still armed on Line').toBe(true);
    await tabButton(page, 'field').click();
    await expectTab(page, 'field');
    expect((await clock(page)).pending, 'still armed on Field').toBe(true);

    // Arriving on Simple starts it.
    const before = Date.now();
    await tabButton(page, 'simple').click();
    await expectTab(page, 'simple');
    c = await clock(page);
    expect(c.pending, 'Simple starts the armed clock').toBe(false);
    expect(c.start).not.toBeNull();
    expect(c.start!).toBeGreaterThanOrEqual(before - 1_000);
    const startedAt = c.start;

    // Going back to Full and returning to Simple does not restart it.
    await tabButton(page, 'full').click();
    await expectTab(page, 'full');
    await page.waitForTimeout(1_200);
    await tabButton(page, 'simple').click();
    await expectTab(page, 'simple');
    expect((await clock(page)).start).toBe(startedAt);
  });

  test('a clock started by a pickup on Full keeps its start time on Simple', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, uniqueTeam());
    await startGame(page, 'offense');

    // Full as the tracking tab before the first point.
    await tabButton(page, 'full').click();
    await expectTab(page, 'full');
    await startNextPoint(page, 'full');
    expect((await clock(page)).pending).toBe(true);

    // Somebody picks up the disc: the first touch starts the clock.
    await page.locator('.full-pbp-row-action-pickup').first().click();
    await expect.poll(async () => (await clock(page)).pending).toBe(false);
    const pickedUpAt = (await clock(page)).start;
    expect(pickedUpAt).not.toBeNull();

    await page.waitForTimeout(1_200);
    await tabButton(page, 'simple').click();
    await expectTab(page, 'simple');
    const c = await clock(page);
    expect(c.pending).toBe(false);
    expect(c.start, 'the pickup time is not overwritten').toBe(pickedUpAt);
  });
});
