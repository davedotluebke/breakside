/**
 * Quickstart clips — the path a brand-new user walks: make a team, add players,
 * start a game, pick a line, and score points from Simple mode.
 *
 * One test = one clip = one mp4. Record + cut with:
 *   ./scripts/record-demos.sh quickstart
 */
import { test, expect } from '@playwright/test';
import {
  BEAT, SYNC_ECHO_WAIT, glide, holdEnding, markTrim, resetCursor, scrollLine, tap, tapCheck, tapLocator, typeInto,
} from './cinema';
import {
  OPPONENT, ROSTER, TEAM_NAME,
  beginGame, checkWholeLine, completePull, goToTab, makeTeamWithRoster, openApp,
  scoreFor, startPoint,
} from './setup';

test('qs-01-create-team', async ({ page }) => {
  const t0 = Date.now();
  await openApp(page, 'qs01');
  resetCursor();
  await markTrim(page, t0, 'qs-01-create-team');

  await tap(page, '.teams-action-create', { after: BEAT.notable });
  await expect(page.locator('#createTeamModal')).toBeVisible();

  await typeInto(page, '#newTeamNameInput', TEAM_NAME, 600);
  await tap(page, '#saveNewTeamBtn', { after: BEAT.notable });
  await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 10_000 });

  // Straight on to the roster — a team with no players can't field a line.
  await tap(page, '#showRosterBtn', { after: BEAT.notable });
  await expect(page.locator('#editRosterSubscreen')).toBeVisible();

  // Three adds shows the pattern: name, number, then the button for the
  // player's division (+FMP / +MMP).
  for (const p of ROSTER.slice(0, 3)) {
    await typeInto(page, '#newPlayerInput', p.name, 150);
    await typeInto(page, '#newPlayerNumberInput', p.number, 200);
    await tap(page, p.gender === 'FMP' ? '#addFMPPlayerBtn' : '#addMMPPlayerBtn', { after: BEAT.action });
    await expect(page.locator('#rosterList').getByText(p.name)).toBeVisible();
  }

  await glide(page, 240, 700);
  await holdEnding(page, 'qs-01-create-team');
});

test('qs-02-start-game', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'qs02');
  resetCursor();
  await markTrim(page, t0, 'qs-02-start-game');

  await typeInto(page, '#opponentNameInput', OPPONENT, BEAT.action);
  await tap(page, '#startGameOnOBtn', { after: BEAT.notable });

  await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 10_000 });
  await glide(page, 240, 620);
  await holdEnding(page, 'qs-02-start-game');
});

test('qs-03-pick-line', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'qs03');
  await beginGame(page, 'offense');
  await goToTab(page, 'line');
  resetCursor();
  await markTrim(page, t0, 'qs-03-pick-line');

  // Picking a line out of a full roster, not ticking every row: four, then a
  // look up and down the list, then three more who aren't next to the first
  // four. That's what choosing a line actually looks like.
  const box = (name: string) =>
    page.locator('#panelActivePlayersTable tbody tr').filter({ hasText: name })
      .locator('input[type="checkbox"]');

  for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) {
    await tapCheck(page, box(name), { after: 380 });
  }
  await page.waitForTimeout(BEAT.action);

  // Down to the bottom of the roster for two more, then back up the list for
  // the last one — so the three are nowhere near the first four, and the
  // scrolling is doing real work rather than decorating.
  await scrollLine(page, 'down', 4);
  await page.waitForTimeout(BEAT.action);
  for (const name of ['Oscar', 'Trudy']) {
    await tapCheck(page, box(name), { after: 420 });
  }
  await page.waitForTimeout(BEAT.action);

  await scrollLine(page, 'up', 2);
  await page.waitForTimeout(BEAT.action);
  await tapCheck(page, box('Peggy'), { after: 420 });
  await page.waitForTimeout(BEAT.action);

  // Seven checked, which is what the Start Point button is waiting for.
  await expect(page.locator('#panelActivePlayersTable tbody input[type="checkbox"]:checked'))
    .toHaveCount(7, { timeout: 8_000 });

  // The Line tab has its own Start Point button (#lineTabStartPointBtn) —
  // #pbpStartPointBtn belongs to Simple/All and is hidden here.
  await tap(page, '#lineTabStartPointBtn', { after: BEAT.notable });
  await expect(page.locator('#lineTabStartPointBtn')).toBeHidden({ timeout: 8_000 });

  // End on Simple, not All: Simple is where most of a game is actually run,
  // and All is treated as an advanced layout throughout these docs.
  await tap(page, '#headerSegControl button[data-tab="simple"]', { after: BEAT.read });
  await holdEnding(page, 'qs-03-pick-line');
});

test('qs-04-we-score', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'qs04');
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor();
  await markTrim(page, t0, 'qs-04-we-score');

  await tap(page, '#pbpWeScoreBtn', { after: BEAT.notable });
  await expect(page.locator('#scoreAttributionDialog')).toBeVisible();

  // Assist then goal. Picking both commits the score and closes the dialog.
  await tapLocator(page, page.locator('#throwerButtons .player-button').filter({ hasText: 'Alice' }), { after: 600 });
  await tapLocator(page, page.locator('#receiverButtons .player-button').filter({ hasText: 'Bob' }), { after: BEAT.notable });
  await expect(page.locator('#scoreAttributionDialog')).toBeHidden({ timeout: 8_000 });

  await expect(page.locator('#gameScoreUs')).toHaveText('1');
  await glide(page, 240, 300);
  await holdEnding(page, 'qs-04-we-score');
});

test('qs-05-they-score', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'qs05');
  await beginGame(page, 'defense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  // Starting on defense opens the pull dialog — clear it off-camera.
  await completePull(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor();
  await markTrim(page, t0, 'qs-05-they-score');

  // No attribution dialog — the opponent's goal is one tap.
  await tap(page, '#pbpTheyScoreBtn', { after: BEAT.notable });
  await expect(page.locator('#gameScoreThem')).toHaveText('1');

  await glide(page, 240, 300);
  await holdEnding(page, 'qs-05-they-score');
});

test('qs-06-key-play', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'qs06');
  await beginGame(page, 'defense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await completePull(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor();
  await markTrim(page, t0, 'qs-06-key-play');

  await tap(page, '#pbpKeyPlayBtn', { after: BEAT.notable });
  await expect(page.locator('#keyPlayDialog')).toBeVisible();

  // Open the Defense group, log Carol's block. (Panel labels are Title Case,
  // the plays inside them are lowercase.)
  await tapLocator(page, page.locator('#keyPlayPanels').getByText('Defense', { exact: true }), { after: BEAT.notable });
  await tapLocator(page, page.locator('#keyPlayPanels').getByText('block', { exact: true }), { after: BEAT.action });
  await tapLocator(page, page.locator('#keyPlayPlayerButtons .player-button').filter({ hasText: 'Carol' }), { after: BEAT.notable });

  await expect(page.locator('#keyPlayDialog')).toBeHidden({ timeout: 8_000 });
  await goToTab(page, 'log');
  await page.waitForTimeout(BEAT.action);
  await holdEnding(page, 'qs-06-key-play');
});

test('qs-07-log', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'qs07');
  await beginGame(page, 'offense');

  // Three points of history so the log has something to show. The line table
  // only exists on the Line tab, so each point starts there and moves to
  // Simple to score.
  for (const [i, pair] of ([['Alice', 'Bob'], ['Carol', 'Dave'], ['Eve', 'Grace']] as const).entries()) {
    await goToTab(page, 'line');
    await checkWholeLine(page);
    await goToTab(page, 'simple');
    await startPoint(page);
    if (i > 0) {
      // We scored, so every later point starts on defense — clear the pull.
      await completePull(page);
    }
    await page.waitForTimeout(1200);
    await scoreFor(page, pair[0], pair[1]);
    await page.waitForTimeout(1200);
  }

  await goToTab(page, 'simple');
  resetCursor();
  await markTrim(page, t0, 'qs-07-log');

  await tap(page, '#headerSegControl button[data-tab="log"]', { after: BEAT.read });
  await glide(page, 240, 500);
  await holdEnding(page, 'qs-07-log');
});

test('qs-08-end-game', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'qs08');
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await page.waitForTimeout(1500);
  await scoreFor(page, 'Alice', 'Bob');
  await page.waitForTimeout(1500);
  resetCursor();
  await markTrim(page, t0, 'qs-08-end-game');

  page.once('dialog', d => d.accept());
  await tap(page, '#gameMenuBtn', { after: BEAT.notable });
  await expect(page.locator('#gameMenuDropdown')).toBeVisible();
  await tap(page, '#menuEndGame', { after: BEAT.notable });

  await expect(page.locator('#gameSummaryScreen')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(BEAT.read);
  await glide(page, 240, 560);
  await holdEnding(page, 'qs-08-end-game');
});
