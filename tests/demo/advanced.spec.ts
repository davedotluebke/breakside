/**
 * Advanced clips — the features a team turns on once they want more than the
 * quickstart loop: player details, line filling, game events, pull detail,
 * set tracking, stats scope, and multi-coach roles.
 *
 *   ./scripts/record-demos.sh advanced
 */
import { test, expect, Page } from '@playwright/test';
import {
  BEAT, SYNC_ECHO_WAIT, glide, holdEnding, markTrim, resetCursor, tap, tapLocator, typeInto,
} from './cinema';
import {
  OPPONENT, TEAM_NAME,
  beginGame, checkWholeLine, completePull, goToTab, makeTeamWithRoster, openApp, scoreFor, startPoint,
} from './setup';
import { BACKEND_URL } from '../helpers/constants';
import { waitForGameOnServer } from '../helpers/controllerApi';

test('adv-player-details', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advpd');
  await page.locator('#showRosterBtn').click();
  await expect(page.locator('#editRosterSubscreen')).toBeVisible();
  resetCursor();
  await markTrim(page, t0, 'adv-player-details');

  await tapLocator(page, page.locator('#rosterList .roster-name-column').filter({ hasText: 'Alice' }),
    { after: BEAT.notable });
  await expect(page.locator('#editPlayerDialog')).toBeVisible();
  await page.waitForTimeout(BEAT.read);

  // Position and default line are what the Auto line filler reads.
  await tapLocator(page, page.locator('#editPlayerDialog').getByText('Handler', { exact: true }),
    { after: BEAT.action });
  await tapLocator(page, page.locator('#editPlayerDialog').getByText('O-line', { exact: true }),
    { after: BEAT.notable });
  await tap(page, '#editPlayerConfirmBtn', { after: BEAT.notable });

  await expect(page.locator('#editPlayerDialog')).toBeHidden({ timeout: 8_000 });
  await glide(page, 240, 620);
  await holdEnding(page, 'adv-player-details');
});

test('adv-wholesale-auto', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advwa');
  await beginGame(page, 'offense');
  await goToTab(page, 'line');
  await checkWholeLine(page);
  resetCursor();
  await markTrim(page, t0, 'adv-wholesale-auto');

  // Wholesale lives over the checkbox column and clears the whole line.
  await tap(page, '.select-line-th-wholesale', { after: BEAT.notable });
  await expect(page.locator('#panelActivePlayersTable tbody input[type="checkbox"]:checked'))
    .toHaveCount(0, { timeout: 8_000 });
  await page.waitForTimeout(BEAT.action);

  // Lock in two players by hand...
  const rows = page.locator('#panelActivePlayersTable tbody tr');
  await tapLocator(page, rows.nth(0).locator('input[type="checkbox"]'), { after: 420 });
  await tapLocator(page, rows.nth(1).locator('input[type="checkbox"]'), { after: BEAT.action });

  // ...then Auto fills the rest with whoever has played the fewest points.
  await tap(page, '#panelAutoBtn', { after: BEAT.notable });
  await expect(page.locator('#panelActivePlayersTable tbody input[type="checkbox"]:checked'))
    .toHaveCount(7, { timeout: 8_000 });

  await glide(page, 240, 620);
  await holdEnding(page, 'adv-wholesale-auto');
});

test('adv-game-events', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advge');
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor();
  await markTrim(page, t0, 'adv-game-events');

  await tap(page, '#pbpGameEventsBtn', { after: BEAT.notable });
  await expect(page.locator('#gameEventsModal')).toBeVisible();
  await page.waitForTimeout(BEAT.read);

  // Timeout asks whose it was, and logs it by team name.
  await tap(page, '#geTimeoutBtn', { after: BEAT.notable });
  await tap(page, '#toWhoUsBtn', { after: BEAT.notable });

  await goToTab(page, 'log');
  await page.waitForTimeout(BEAT.action);
  await holdEnding(page, 'adv-game-events');
});

test('adv-pull-hang', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advph');
  await beginGame(page, 'defense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await expect(page.locator('#pullDialog')).toBeVisible({ timeout: 8_000 });
  resetCursor();
  await markTrim(page, t0, 'adv-pull-hang');

  await tapLocator(page, page.locator('#pullPlayerButtons .player-button').filter({ hasText: 'Frank' }),
    { after: BEAT.action });

  // The stopwatch: tap on release, tap again on landing.
  await tap(page, '#pullHangBtn', { after: 200 });
  await page.waitForTimeout(2100);
  await tap(page, '#pullHangBtn', { after: BEAT.notable });

  await tapLocator(page, page.locator('#pullQualityButtons .pull-quality-btn[data-quality="Good Pull"]'),
    { after: BEAT.action });
  await tap(page, '#pullProceedBtn', { after: BEAT.notable });
  await expect(page.locator('#pullDialog')).toBeHidden({ timeout: 8_000 });

  // The hang time rides the event into the log.
  await tap(page, '#headerSegControl button[data-tab="log"]', { after: BEAT.read });
  await expect(page.locator('.game-screen-container')).toContainText(/hang/i, { timeout: 8_000 });
  await holdEnding(page, 'adv-pull-hang');
});

test('adv-sets', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advsets');

  // Team Settings is reachable from the app menu on the team screens.
  await page.locator('#appMenuBtn').click();
  await page.locator('#menuAppTeamSettings').click();
  await expect(page.locator('#teamSettingsScreen')).toBeVisible({ timeout: 8_000 });
  await page.locator('#setsEnabledToggle').scrollIntoViewIfNeeded();
  resetCursor();
  await markTrim(page, t0, 'adv-sets');

  await tap(page, '#setsEnabledToggle', { after: BEAT.notable });
  await expect(page.locator('#setsListsContainer')).toBeVisible();

  await typeInto(page, '#defensiveSetsInput', 'Zone, Match, Junk', BEAT.action);
  await typeInto(page, '#offensiveSetsInput', 'Vert, Ho, Side', BEAT.action);
  await tap(page, '#saveSetsBtn', { after: BEAT.notable });

  await glide(page, 240, 520);
  await holdEnding(page, 'adv-sets');
});

test('adv-sets-tagging', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advsets2');

  // Turn set tracking on off-camera; this clip is about using it.
  await page.locator('#appMenuBtn').click();
  await page.locator('#menuAppTeamSettings').click();
  await expect(page.locator('#teamSettingsScreen')).toBeVisible({ timeout: 8_000 });
  await page.locator('#setsEnabledToggle').check();
  await page.fill('#defensiveSetsInput', 'Zone, Match, Junk');
  await page.fill('#offensiveSetsInput', 'Vert, Ho, Side');
  await page.locator('#saveSetsBtn').click();
  await page.waitForTimeout(800);
  await page.locator('#backFromSettingsBtn').click();
  await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 8_000 });

  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'full');
  await startPoint(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor();
  await markTrim(page, t0, 'adv-sets-tagging');

  // The Set: control offers the offensive list while we have the disc.
  await tap(page, '.full-pbp-set-chip', { after: BEAT.notable });
  await page.waitForTimeout(BEAT.action);
  await tap(page, '.full-pbp-set-chip', { after: BEAT.notable });

  await glide(page, 240, 700);
  await holdEnding(page, 'adv-sets-tagging');
});

test('adv-stats-scope', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advss');
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await page.waitForTimeout(1500);
  await scoreFor(page, 'Alice', 'Bob');
  await page.waitForTimeout(1200);

  // Out to the roster, where the scope control lives.
  await page.locator('#gameMenuBtn').click();
  await page.locator('#menuRoster').click();
  await expect(page.locator('#editRosterSubscreen')).toBeVisible({ timeout: 8_000 });
  resetCursor();
  await markTrim(page, t0, 'adv-stats-scope');

  await tapLocator(page, page.locator('.roster-scope-btn[data-scope="game"]'), { after: BEAT.notable });
  await page.waitForTimeout(BEAT.action);
  await tapLocator(page, page.locator('.roster-scope-btn[data-scope="all"]'), { after: BEAT.notable });

  // Column headers sort.
  await tapLocator(page, page.locator('#rosterTable thead th, #rosterTable tr').first(), { after: BEAT.action })
    .catch(() => { /* header layout varies by stats level; sorting is optional here */ });

  await glide(page, 240, 620);
  await holdEnding(page, 'adv-stats-scope');
});

/**
 * Get to the Teams screen with the team's card expanded.
 *
 * Both steps are conditional: Leave Game already lands on the Teams screen (so
 * there's no back button to press), and the card's expanded state persists
 * across visits (so a second call would collapse what the first opened).
 */
async function openTeamCard(page: Page) {
  const onTeams = await page.locator('#selectTeamScreen').isVisible().catch(() => false);
  if (!onTeams) await page.locator('#backFromStartGameBtn').click();
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.team-header').first()).toBeVisible({ timeout: 10_000 });

  const expanded = await page.locator('.new-event-btn').first().isVisible().catch(() => false);
  if (!expanded) await page.locator('.team-header').first().click();
  await expect(page.locator('.new-event-btn').first()).toBeVisible({ timeout: 10_000 });
}

test('adv-events', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advev');
  await openTeamCard(page);
  await page.waitForTimeout(1000);
  resetCursor();
  await markTrim(page, t0, 'adv-events');

  await tapLocator(page, page.locator('.new-event-btn').first(), { after: BEAT.notable });
  await expect(page.locator('#createEventModal')).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(BEAT.action);

  await typeInto(page, '#newEventName', 'Spring Classic', BEAT.action);
  await tap(page, '#createEventBtn', { after: BEAT.notable });

  // The event gets its own card, with its own roster, settings, and games.
  await expect(page.locator('.event-new-game-btn').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(BEAT.read);
  await glide(page, 240, 520);
  await holdEnding(page, 'adv-events');
});

test('adv-phases', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advph2');
  await openTeamCard(page);

  // Off camera: an event with one game in it, so there's something to file
  // under a phase once the phases exist.
  await page.locator('.new-event-btn').first().click();
  await expect(page.locator('#createEventModal')).toBeVisible({ timeout: 8_000 });
  await page.fill('#newEventName', 'Spring Classic');
  await page.locator('#createEventBtn').click();
  await expect(page.locator('.event-new-game-btn').first()).toBeVisible({ timeout: 10_000 });

  await page.locator('.event-new-game-btn').first().click();
  await expect(page.locator('#startGameSubscreen')).toBeVisible({ timeout: 10_000 });
  await beginGame(page, 'offense');
  page.once('dialog', d => d.accept());
  await page.locator('#gameMenuBtn').click();
  await page.locator('#menuLeaveGame').click();
  await openTeamCard(page);
  await expect(page.locator('.event-header-btn[title="Event Settings"]').first())
    .toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  resetCursor();
  await markTrim(page, t0, 'adv-phases');

  // Phases are named in the event's own settings.
  await tapLocator(page, page.locator('.event-header-btn[title="Event Settings"]').first(),
    { after: BEAT.notable });
  // Wait on the dialog, not on #editEventPhasesList — that <ul> is empty until
  // the first phase exists, so it has no box and reads as hidden.
  await expect(page.locator('#eventSettingsModal')).toBeVisible({ timeout: 8_000 });
  await page.locator('#editEventPhaseInput').scrollIntoViewIfNeeded();

  for (const phase of ['Pool Play', 'Bracket']) {
    await typeInto(page, '#editEventPhaseInput', phase, 200);
    await tap(page, '#editEventPhaseAddBtn', { after: BEAT.action });
  }
  await tap(page, '#saveEventSettingsBtn', { after: BEAT.notable });

  // Back on the team card, every event game gains a phase picker.
  const picker = page.locator('.game-phase-select').first();
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(BEAT.action);

  // A native select's popup isn't captured by the screencast, so glide to it
  // and set the value — what reads on camera is the game re-filing itself under
  // the phase heading, which is the point.
  const box = await picker.boundingBox();
  if (box) await glide(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(BEAT.settle);
  await picker.selectOption('Pool Play');
  await page.waitForTimeout(BEAT.notable);

  await expect(page.locator('.event-phase-header').filter({ hasText: 'Pool Play' }))
    .toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(BEAT.read);
  await glide(page, 240, 560);
  await holdEnding(page, 'adv-phases');
});

/**
 * The second coach is driven through the controller API rather than a second
 * browser: the clip is one phone reacting to someone else joining, so a whole
 * second context only adds a page that never appears on camera — and the
 * offline-first game creation makes "open the app, find the game, resume it"
 * a multi-second race that timed out more often than it worked.
 */
test('adv-multi-coach', async ({ page, request }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advmc');
  await beginGame(page, 'offense');
  await goToTab(page, 'line');

  // Reveal the role buttons — normally they stay hidden while you're solo, and
  // this clip is about what they do once you're not.
  await page.locator('#gameMenuBtn').click();
  await page.locator('#menuToggleRoleButtons').click();
  await page.waitForTimeout(800);

  const gameId: string = await page.evaluate(() => {
    const g = (window as any).currentGame;
    return typeof g === 'function' ? g()?.id : g?.id;
  });
  expect(gameId, 'game id should be readable from the page').toBeTruthy();
  // The first sync is queued, so the backend 404s controller calls until it lands.
  await waitForGameOnServer(request, gameId, 'demo-advmc');

  resetCursor();
  await markTrim(page, t0, 'adv-multi-coach');

  // This clip is shot on the Line tab, so the role the coach takes on camera is
  // the line — taking play-by-play from the Line tab would be showing the wrong
  // half of the handoff.
  await tap(page, '#gameLineCoachBtn', { after: BEAT.notable });
  await expect(page.locator('#gameLineCoachHolder')).not.toHaveText(/Available/i, { timeout: 8_000 });
  await page.waitForTimeout(BEAT.action);

  // A second coach connects and takes play-by-play, off camera.
  const headers = { 'Content-Type': 'application/json', 'X-Test-User-Id': 'demo-pbpcoach' };
  await request.post(`${BACKEND_URL}/api/games/${gameId}/ping`, { headers });
  await request.post(`${BACKEND_URL}/api/games/${gameId}/claim-active`, { headers });

  // The line coach's screen picks it up on the next poll.
  await expect(page.locator('#gameActiveCoachHolder')).not.toHaveText(/Available/i, { timeout: 20_000 });
  await page.waitForTimeout(BEAT.read);

  await glide(page, 240, 300);
  await holdEnding(page, 'adv-multi-coach');
});
