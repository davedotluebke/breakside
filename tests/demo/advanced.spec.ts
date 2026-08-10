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
  await expect(page.locator('#gameLogContainer, .game-log-container, #panel-gameLog').first())
    .toContainText(/hang/i, { timeout: 8_000 });
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

test('adv-events-phases', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advev');
  // Back out to the Teams screen, where each team card offers New Event.
  await page.locator('#backFromStartGameBtn').click();
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(1200);
  resetCursor();
  await markTrim(page, t0, 'adv-events-phases');

  await tapLocator(page, page.locator('.new-event-btn').first(), { after: BEAT.notable });
  await expect(page.locator('#createEventModal')).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(BEAT.action);

  await typeInto(page, '#newEventName', 'Spring Classic', BEAT.action);
  await tap(page, '#createEventBtn', { after: BEAT.notable });

  await page.waitForTimeout(BEAT.read);
  await glide(page, 240, 480);
  await holdEnding(page, 'adv-events-phases');
});

/**
 * Multi-coach needs two browser contexts. Only the first page's video is the
 * clip — the second coach acts off-camera, so what the viewer sees is one
 * phone reacting to another coach joining and claiming a role.
 */
test('adv-multi-coach', async ({ page, browser }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'advmc');
  await beginGame(page, 'offense');
  await goToTab(page, 'line');

  // Reveal the role buttons — normally they stay hidden until a second coach
  // is detected, and we want them on screen from the clip's first frame.
  await page.locator('#gameMenuBtn').click();
  await page.locator('#menuToggleRoleButtons').click();
  await page.waitForTimeout(800);

  resetCursor();
  await markTrim(page, t0, 'adv-multi-coach');

  // Coach A claims play-by-play control.
  await tap(page, '#gameActiveCoachBtn', { after: BEAT.notable });
  await expect(page.locator('#gameActiveCoachHolder')).not.toHaveText(/Available/i, { timeout: 8_000 });
  await page.waitForTimeout(BEAT.action);

  // A second coach opens the same game on another device and takes the line.
  const ctxB = await browser.newContext({ viewport: { width: 480, height: 960 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(`/?testMode=true&testUserId=demo-advmc&api=${BACKEND_URL}`);
  await pageB.waitForTimeout(2500);
  const resume = pageB.locator('#continueGameBtn');
  if (await resume.isVisible().catch(() => false)) await resume.click();
  await pageB.waitForTimeout(2500);
  await pageB.locator('#gameLineCoachBtn').click().catch(() => {});

  // Coach A's screen shows the line role taken by someone else.
  await page.waitForTimeout(BEAT.read);
  await glide(page, 240, 300);
  await holdEnding(page, 'adv-multi-coach');
  await ctxB.close();
});
