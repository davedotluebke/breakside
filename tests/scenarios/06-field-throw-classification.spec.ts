/**
 * Field-mode auto-classification of throws (huck / reset / swing).
 *
 * Verifies the swing rule: a throw is auto-tagged as a swing when its lateral
 * travel is ≥ the settable fraction of the field width (default 25%) — NOT
 * merely when it crosses a lateral field third. A short pass that straddles a
 * third boundary must not light the Swing chip; a genuine cross-field throw
 * must.
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp,
  setupTeamWithPlayers,
  startGame,
  selectAllPlayers,
  startPoint,
} from '../helpers/app';

const FIELD = '#panel-playByPlayField-content';

/** Tap a player chip on the Field-mode rail. */
async function tapChip(page: Page, name: string) {
  await page.locator(`${FIELD} .fp-chip[data-pname="${name}"]`).click();
}

/**
 * Tap the field at (lengthFrac, widthFrac) — fractions along the field's
 * length and width axes. Maps to screen axes by the rendered aspect ratio
 * (landscape: length is horizontal; portrait: length is vertical).
 */
async function tapField(page: Page, lengthFrac: number, widthFrac: number) {
  const box = await page.locator(`${FIELD} #fpField`).boundingBox();
  if (!box) throw new Error('#fpField not visible');
  const landscape = box.width >= box.height;
  const fx = landscape ? lengthFrac : widthFrac;
  const fy = landscape ? widthFrac : lengthFrac;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

async function expectStatus(page: Page, text: string) {
  await expect(page.locator(`${FIELD} .fp-statusbar`)).toContainText(text, { timeout: 5_000 });
}

/** Read the last Throw event's stored geometry + auto-set flags. */
async function lastThrow(page: Page) {
  return page.evaluate(() => {
    const teams = (window as any).teams || [];
    const team = teams.find((t: any) => t.games && t.games.length);
    const game = team.games[team.games.length - 1];
    const point = game.points[game.points.length - 1];
    const events: any[] = [];
    point.possessions.forEach((poss: any) => (poss.events || []).forEach((e: any) => events.push(e)));
    const throws = events.filter(e => e.type === 'Throw');
    const t = throws[throws.length - 1];
    return t ? {
      from: t.from, to: t.to,
      huck: !!t.huck_flag, reset: !!t.dump_flag, swing: !!t.swing_flag,
    } : null;
  });
}

test('swing auto-tags on lateral travel ≥ 25% of field width, not on third crossings', async ({ page }) => {
  await goToApp(page);
  await setupTeamWithPlayers(page);
  await startGame(page, 'offense');
  await selectAllPlayers(page);
  await startPoint(page);

  // Let the post-start cloud-sync echo land before the first gesture — it
  // replaces game.points and would silently eat an in-flight entry.
  await page.waitForTimeout(4_500);

  // Switch to the Field tab.
  await page.click('button[data-tab="field"]');
  await expect(page.locator(`${FIELD} #fpField`)).toBeVisible({ timeout: 5_000 });

  // Pickup: Alice picks up at 40% across the width.
  await tapChip(page, 'Alice');
  await tapField(page, 0.30, 0.40);
  await expectStatus(page, 'Alice has the disc');

  // Throw 1 — Alice → Bob, 10% lateral travel that crosses the 1/3 width
  // boundary. Old third-crossing rule would call this a swing; the lateral
  // distance rule must not.
  await tapChip(page, 'Bob');
  await tapField(page, 0.35, 0.30);
  await expectStatus(page, 'Bob has the disc');

  let t = await lastThrow(page);
  expect(t).not.toBeNull();
  const third = (y: number) => (y < 1 / 3 ? 0 : y <= 2 / 3 ? 1 : 2);
  const dy1 = Math.abs(t!.to.y - t!.from.y);
  expect(dy1).toBeGreaterThan(0.05);
  expect(dy1).toBeLessThan(0.25);
  expect(third(t!.from.y)).not.toBe(third(t!.to.y)); // premise: crosses a third
  expect(t!.huck).toBe(false);
  expect(t!.swing).toBe(false);
  await expect(page.locator(`${FIELD} .fp-modbtn[data-lastmod="swing_flag"]`)).not.toHaveClass(/\bon\b/);

  // Throw 2 — Bob → Carol, 35% lateral travel: a real swing.
  await tapChip(page, 'Carol');
  await tapField(page, 0.40, 0.65);
  await expectStatus(page, 'Carol has the disc');

  t = await lastThrow(page);
  expect(t).not.toBeNull();
  const dy2 = Math.abs(t!.to.y - t!.from.y);
  expect(dy2).toBeGreaterThanOrEqual(0.25);
  expect(t!.huck).toBe(false);
  expect(t!.swing).toBe(true);
  await expect(page.locator(`${FIELD} .fp-modbtn[data-lastmod="swing_flag"]`)).toHaveClass(/\bon\b/);
});
