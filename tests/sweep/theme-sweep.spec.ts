/**
 * Theme sweep — drives the app through every screen, dialog and panel and
 * screenshots each one in the current theme.
 *
 * Not an assertion test: it exists so a whole-app dark-mode pass can be
 * eyeballed as a contact sheet instead of by clicking through 30 screens by
 * hand, and so a later change can be diffed against the same shot list.
 *
 * Run it once per theme (BREAKSIDE_THEME=light|dark) — the theme is stamped
 * into localStorage by an init script, before the app's own boot script reads
 * it, so each run boots straight into the theme with no flash and no toggling
 * mid-run:
 *
 *   BREAKSIDE_THEME=dark npx playwright test --config sweep/sweep.config.ts
 *
 * Shots land in tests/sweep/shots/<theme>/NN-name.png.
 */
import { test, Page, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  goToApp, setupTeamWithPlayers, startGame, selectAllPlayers, startPoint,
  weScoreWithAttribution, theyScore, completePullDialog,
} from '../helpers/app';

const THEME = process.env.BREAKSIDE_THEME === 'dark' ? 'dark' : 'light';
const SHOTS = path.join(__dirname, 'shots', THEME);
fs.mkdirSync(SHOTS, { recursive: true });

let n = 0;
async function shot(page: Page, name: string) {
  n += 1;
  const file = path.join(SHOTS, `${String(n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
}

/** Dismiss any toast that would sit on top of the next screenshot. */
async function clearToasts(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('#toastContainer > *').forEach(t => t.remove());
  });
}

test.beforeEach(async ({ page }) => {
  // Stamp the preference before ANY page script runs, so index.html's inline
  // theme boot reads it on the very first load.
  await page.addInitScript((theme) => {
    localStorage.setItem('breakside_advanced_settings',
      JSON.stringify({ 'display.theme': theme, 'hints.hideAll': true }));
  }, THEME);
});

test('sweep every screen', async ({ page }) => {
  test.setTimeout(300_000);

  // ── Team list ────────────────────────────────────────────────────────────
  await goToApp(page);
  await shot(page, 'team-list-empty');

  await page.click('.teams-action-create');
  await expect(page.locator('#createTeamModal')).toBeVisible();
  await shot(page, 'create-team-modal');
  await page.locator('#createTeamModal .close, #createTeamModal .cancel-btn').first().click()
    .catch(() => page.keyboard.press('Escape'));

  // ── Roster ───────────────────────────────────────────────────────────────
  await setupTeamWithPlayers(page, 'Night Owls');
  await shot(page, 'start-game-subscreen');

  await page.click('#showRosterBtn');
  await expect(page.locator('#editRosterSubscreen')).toBeVisible();
  await shot(page, 'edit-roster');

  // Roster row expanded (per-player detail + role tags)
  const firstRow = page.locator('#rosterList .roster-player-row, #rosterList li').first();
  if (await firstRow.count()) {
    await firstRow.click().catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, 'roster-row-expanded');
  }
  await page.click('#backToStartGameBtn');

  // ── Team settings ────────────────────────────────────────────────────────
  const settingsBtn = page.locator('#teamSettingsBtn, #showTeamSettingsBtn').first();
  if (await settingsBtn.count()) {
    await settingsBtn.click().catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, 'team-settings');
    await page.locator('#backToStartGameBtn, .title-bar-back-btn').first().click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // ── In-game: line selection ──────────────────────────────────────────────
  await startGame(page, 'offense', 'Bad Guys');
  await page.waitForTimeout(500);
  await shot(page, 'game-select-line');

  await selectAllPlayers(page);
  await shot(page, 'game-line-selected');

  // Advanced Settings modal (the theme control itself lives here)
  await page.click('#gameMenuBtn');
  await expect(page.locator('#gameMenuDropdown')).toBeVisible();
  await shot(page, 'game-hamburger-menu');
  await page.keyboard.press('Escape');
  await page.click('body', { position: { x: 5, y: 400 } }).catch(() => {});

  await startPoint(page);
  await page.waitForTimeout(600);
  await clearToasts(page);
  await shot(page, 'game-offense-pbp');

  // Score attribution dialog
  await page.click('#pbpWeScoreBtn');
  await expect(page.locator('#scoreAttributionDialog')).toBeVisible();
  await shot(page, 'score-attribution-dialog');
  await page.locator('#throwerButtons .player-button').filter({ hasText: 'Alice' }).click();
  await shot(page, 'score-attribution-thrower-picked');
  await page.locator('#receiverButtons .player-button').filter({ hasText: 'Bob' }).click();
  await expect(page.locator('#scoreAttributionDialog')).not.toBeVisible();
  await page.waitForTimeout(400);
  await clearToasts(page);
  await shot(page, 'game-after-score');

  // ── Defense point + pull dialog ──────────────────────────────────────────
  await selectAllPlayers(page);
  await startPoint(page);
  await page.waitForTimeout(600);
  const pull = page.locator('#pullDialog');
  if (await pull.isVisible().catch(() => false)) {
    await shot(page, 'pull-dialog');
    await completePullDialog(page, 'Alice');
    await page.waitForTimeout(400);
  }
  await clearToasts(page);
  await shot(page, 'game-defense-pbp');

  // Key play dialog
  const keyPlay = page.locator('#pbpKeyPlayBtn');
  if (await keyPlay.count() && await keyPlay.isVisible().catch(() => false)) {
    await keyPlay.click();
    await page.waitForTimeout(400);
    await shot(page, 'key-play-dialog');
    await page.keyboard.press('Escape');
    await page.locator('#keyPlayDialog .close').first().click().catch(() => {});
    await page.waitForTimeout(300);
  }

  await theyScore(page);
  await page.waitForTimeout(500);
  await clearToasts(page);

  // ── Panel tabs: Stats / Log / Full PBP / Field ───────────────────────────
  const tabs: Array<[string, string]> = [
    ['#panelTabStats', 'panel-stats'],
    ['#panelTabLog', 'panel-event-log'],
    ['#panelTabFullPbp', 'panel-full-pbp'],
    ['#panelTabField', 'panel-field'],
    ['#panelTabLine', 'panel-line'],
  ];
  for (const [sel, name] of tabs) {
    const tab = page.locator(sel);
    if (!(await tab.count()) || !(await tab.isVisible().catch(() => false))) continue;
    await tab.click().catch(() => {});
    await page.waitForTimeout(700);
    await clearToasts(page);
    await shot(page, name);
  }

  // Every tab, by whatever its real selector turns out to be
  const anyTabs = page.locator('.panel-tab, .game-tab-btn');
  const tabCount = await anyTabs.count();
  for (let i = 0; i < tabCount; i++) {
    const t = anyTabs.nth(i);
    const label = ((await t.textContent()) || `tab${i}`).trim().toLowerCase().replace(/\W+/g, '-');
    await t.click().catch(() => {});
    await page.waitForTimeout(700);
    await clearToasts(page);
    await shot(page, `tab-${label || i}`);
  }

  // ── Advanced Settings (contains the Theme control) ───────────────────────
  await page.click('#gameMenuBtn').catch(() => {});
  await page.waitForTimeout(300);
  const advItem = page.locator('#menuAdvancedSettings, [id*="dvanced"]').first();
  if (await advItem.count()) {
    await advItem.click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, 'advanced-settings');
    const body = page.locator('.adv-settings-body');
    if (await body.count()) {
      await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);
      await shot(page, 'advanced-settings-bottom');
    }
    await page.locator('#advancedSettingsModal .adv-done-btn').click().catch(() => {});
  }
  await page.keyboard.press('Escape');

  // ── Game summary ─────────────────────────────────────────────────────────
  page.once('dialog', d => d.accept());
  await page.click('#gameMenuBtn').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#menuEndGame').catch(() => {});
  await expect(page.locator('#gameSummaryScreen')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await shot(page, 'game-summary');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await shot(page, 'game-summary-bottom');

  // ── Back to the team list, now with a finished game on it ────────────────
  await page.locator('.title-bar-back-btn, #backToTeamsBtn').first().click().catch(() => {});
  await page.waitForTimeout(800);
  await clearToasts(page);
  await shot(page, 'team-list-with-game');
});
