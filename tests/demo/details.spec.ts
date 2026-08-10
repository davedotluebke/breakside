/**
 * Details clips — the Full play-by-play tab, the Line tab during a point, and
 * the combined All layout. Field mode has its own committed clip
 * (docs/clips/field-mode.mp4, copied from the landing-page demo).
 *
 *   ./scripts/record-demos.sh details
 */
import { test, expect, Page } from '@playwright/test';
import {
  BEAT, SYNC_ECHO_WAIT, glide, holdEnding, markTrim, resetCursor, tap, tapLocator,
} from './cinema';
import {
  beginGame, checkWholeLine, completePull, goToTab, makeTeamWithRoster, scoreFor, startPoint,
} from './setup';

/** A player's row in the Full tab, addressed by name. */
const row = (page: Page, name: string) =>
  page.locator('.full-pbp-player-row').filter({ hasText: name });

const nameBtn = (page: Page, name: string) =>
  row(page, name).locator('.full-pbp-name-btn');

/** Off-camera: get to a live offense point on the Full tab. */
async function fullOffensePoint(page: Page, user: string) {
  await makeTeamWithRoster(page, user);
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'full');
  await startPoint(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
}

/** Off-camera: get to a live defense point on the Full tab (pull cleared). */
async function fullDefensePoint(page: Page, user: string) {
  await makeTeamWithRoster(page, user);
  await beginGame(page, 'defense');
  await checkWholeLine(page);
  await goToTab(page, 'full');
  await startPoint(page);
  await completePull(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
}

test('full-01-offense', async ({ page }) => {
  const t0 = Date.now();
  await fullOffensePoint(page, 'full01');
  resetCursor();
  await markTrim(page, t0, 'full-01-offense');

  // First tap establishes who has the disc — no event is logged for it.
  await tapLocator(page, nameBtn(page, 'Alice'), { after: BEAT.notable });
  await expect(row(page, 'Alice')).toHaveClass(/is-holder/);

  // Every tap after that is a completed pass to the tapped player.
  await tapLocator(page, nameBtn(page, 'Bob'), { after: BEAT.action });
  await expect(row(page, 'Bob')).toHaveClass(/is-holder/);

  await tapLocator(page, nameBtn(page, 'Carol'), { after: BEAT.action });
  await expect(row(page, 'Carol')).toHaveClass(/is-holder/);

  // The chip strip amends the pass that just landed.
  await tapLocator(page, page.locator('.full-pbp-modifier-chip').filter({ hasText: 'huck' }),
    { after: BEAT.notable });
  await expect(page.locator('.full-pbp-modifier-chip').filter({ hasText: 'huck' }))
    .toHaveClass(/checked/);

  // One more pass, then rest on the mini log — the running record of the
  // possession is this clip's payoff.
  //
  // The clip deliberately stops short of scoring. Tapping Score on a row opens
  // the same attribution dialog Simple mode uses, and qs-04-we-score already
  // shows that dialog; scripting it here also proved flaky in a way that wasn't
  // worth chasing for a clip whose subject is pass entry.
  await tapLocator(page, nameBtn(page, 'Dave'), { after: BEAT.notable });
  await expect(row(page, 'Dave')).toHaveClass(/is-holder/);
  await expect(page.locator('#fullPbpLogList')).toContainText('hucks to Carol');

  await glide(page, 240, 740);
  await holdEnding(page, 'full-01-offense');
});

test('full-02-defense', async ({ page }) => {
  const t0 = Date.now();
  await fullDefensePoint(page, 'full02');
  resetCursor();
  await markTrim(page, t0, 'full-02-defense');

  await expect(page.locator('#fullPbpModePill')).toHaveText(/Defense/i);

  // On defense every row offers Block and Interception instead of Drop/Score.
  await tapLocator(page, row(page, 'Carol').locator('.full-pbp-row-action-interception'),
    { after: BEAT.notable });

  // Interception flips us to offense with the defender holding the disc.
  await expect(page.locator('#fullPbpModePill')).toHaveText(/Offense/i, { timeout: 8_000 });
  await expect(row(page, 'Carol')).toHaveClass(/is-holder/);

  await tapLocator(page, nameBtn(page, 'Dave'), { after: BEAT.action });
  await tapLocator(page, nameBtn(page, 'Eve'), { after: BEAT.notable });

  await glide(page, 240, 760);
  await holdEnding(page, 'full-02-defense');
});

test('full-03-od-pill', async ({ page }) => {
  const t0 = Date.now();
  await fullOffensePoint(page, 'full03');
  // A couple of passes so the log isn't empty when the possession flips.
  await nameBtn(page, 'Alice').click();
  await page.waitForTimeout(400);
  await nameBtn(page, 'Bob').click();
  await page.waitForTimeout(800);
  resetCursor();
  await markTrim(page, t0, 'full-03-od-pill');

  await expect(page.locator('#fullPbpModePill')).toHaveText(/Offense/i);

  // One tap on the pill records the turnover you didn't see and flips sides.
  await tap(page, '#fullPbpModePill', { after: BEAT.notable });
  await expect(page.locator('#fullPbpModePill')).toHaveText(/Defense/i, { timeout: 8_000 });
  await page.waitForTimeout(BEAT.action);

  // Tapping it again retracts that inferred event rather than stacking another.
  await tap(page, '#fullPbpModePill', { after: BEAT.notable });
  await expect(page.locator('#fullPbpModePill')).toHaveText(/Offense/i, { timeout: 8_000 });

  await glide(page, 240, 760);
  await holdEnding(page, 'full-03-od-pill');
});

test('full-04-mini-log', async ({ page }) => {
  const t0 = Date.now();
  await fullOffensePoint(page, 'full04');
  await nameBtn(page, 'Alice').click();
  await page.waitForTimeout(300);
  for (const n of ['Bob', 'Carol', 'Dave', 'Eve']) {
    await nameBtn(page, n).click();
    await page.waitForTimeout(300);
  }
  resetCursor();
  await markTrim(page, t0, 'full-04-mini-log');

  // Undo walks the possession back one event at a time.
  await tap(page, '#fullPbpUndoBtn', { after: BEAT.action });
  await tap(page, '#fullPbpUndoBtn', { after: BEAT.notable });
  await expect(row(page, 'Carol')).toHaveClass(/is-holder/, { timeout: 8_000 });

  // The density toggle trades row height for more of the mini log.
  await tap(page, '#fullPbpDensityBtn', { after: BEAT.notable });
  await glide(page, 240, 800);
  await holdEnding(page, 'full-04-mini-log');
});

test('line-01-next-line', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'line01');
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor();
  await markTrim(page, t0, 'line-01-next-line');

  // The point is running on Simple; the Line tab is where the next line is set.
  await tap(page, '#headerSegControl button[data-tab="line"]', { after: BEAT.read });

  const rows = page.locator('#panelActivePlayersTable tbody tr');
  for (const i of [0, 2, 4]) {
    await tapLocator(page, rows.nth(i).locator('input[type="checkbox"]'), { after: 420 });
  }

  await glide(page, 240, 620);
  await holdEnding(page, 'line-01-next-line');
});

test('all-01-panels', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'all01');
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await page.waitForTimeout(1500);
  await scoreFor(page, 'Alice', 'Bob');
  await page.waitForTimeout(1500);
  await goToTab(page, 'simple');
  resetCursor();
  await markTrim(page, t0, 'all-01-panels');

  await tap(page, '#headerSegControl button[data-tab="all"]', { after: BEAT.read });
  await glide(page, 240, 500);
  await holdEnding(page, 'all-01-panels');
});
