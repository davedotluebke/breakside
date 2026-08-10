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
import { auditContrast, Finding } from './contrast';

const THEME = process.env.BREAKSIDE_THEME === 'dark' ? 'dark' : 'light';
const SHOTS = path.join(__dirname, 'shots', THEME);
fs.mkdirSync(SHOTS, { recursive: true });

let n = 0;
const findings: Finding[] = [];

/** Screenshot the current screen AND measure its contrast. */
async function shot(page: Page, name: string) {
  n += 1;
  const file = path.join(SHOTS, `${String(n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  findings.push(...await auditContrast(page, name));
}

/** Dismiss any toast that would sit on top of the next screenshot. */
async function clearToasts(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('#toastContainer > *').forEach(t => t.remove());
  });
}

/**
 * Click something that may or may not be there, without paying Playwright's
 * 30s actionability timeout when it isn't. The sweep is a best-effort walk —
 * a missing optional control should cost a second, not half a minute.
 */
async function tap(page: Page, selector: string, timeout = 2_000) {
  const el = page.locator(selector).first();
  try {
    if (!(await el.count())) return false;
    await el.click({ timeout });
    return true;
  } catch {
    return false;
  }
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
  test.setTimeout(480_000);

  // ── Team list ────────────────────────────────────────────────────────────
  await goToApp(page);
  await shot(page, 'team-list-empty');

  await page.click('.teams-action-create');
  await expect(page.locator('#createTeamModal')).toBeVisible();
  await shot(page, 'create-team-modal');
  if (!(await tap(page, '#createTeamModal .close'))) await page.keyboard.press('Escape');

  // ── Roster ───────────────────────────────────────────────────────────────
  await setupTeamWithPlayers(page, 'Night Owls');
  await shot(page, 'start-game-subscreen');

  await page.click('#showRosterBtn');
  await expect(page.locator('#editRosterSubscreen')).toBeVisible();
  await shot(page, 'edit-roster');

  // Roster row expanded (per-player detail + role tags)
  if (await tap(page, '#rosterList .roster-player-row, #rosterList li')) {
    await page.waitForTimeout(400);
    await shot(page, 'roster-row-expanded');
  }
  await tap(page, '#backToStartGameBtn');

  // ── Team settings ────────────────────────────────────────────────────────
  if (await tap(page, '#teamSettingsBtn, #showTeamSettingsBtn')) {
    await page.waitForTimeout(600);
    await shot(page, 'team-settings');
    await tap(page, '#backToStartGameBtn, .title-bar-back-btn');
    await page.waitForTimeout(400);
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
  await page.mouse.click(5, 400);
  await page.waitForTimeout(200);

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
  if (await tap(page, '#pbpKeyPlayBtn')) {
    await page.waitForTimeout(500);
    await shot(page, 'key-play-dialog');
    if (!(await tap(page, '#keyPlayDialog .close'))) await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  await theyScore(page);
  await page.waitForTimeout(500);
  await clearToasts(page);

  // ── Panel tabs (the segmented control in the game header) ────────────────
  for (const tab of ['simple', 'full', 'field', 'line', 'log', 'all']) {
    if (!(await tap(page, `#headerSegControl button[data-tab="${tab}"]`))) continue;
    await page.waitForTimeout(800);
    await clearToasts(page);
    await shot(page, `tab-${tab}`);
  }

  // Field mode again in landscape — it has its own takeover layout
  await tap(page, '#headerSegControl button[data-tab="field"]');
  await page.setViewportSize({ width: 932, height: 430 });
  await page.waitForTimeout(900);
  await clearToasts(page);
  await shot(page, 'tab-field-landscape');
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(600);
  await tap(page, '#headerSegControl button[data-tab="all"]');
  await page.waitForTimeout(500);

  // ── Advanced Settings (contains the Theme control) ───────────────────────
  await tap(page, '#gameMenuBtn');
  await page.waitForTimeout(300);
  if (await tap(page, '#menuSettings')) {
    await page.waitForTimeout(600);
    await shot(page, 'advanced-settings');
    const body = page.locator('.adv-settings-body');
    if (await body.count()) {
      await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(400);
      await shot(page, 'advanced-settings-bottom');
    }
    await tap(page, '#advancedSettingsModal .adv-done-btn');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── Game summary ─────────────────────────────────────────────────────────
  page.on('dialog', d => d.accept());
  // Make sure no menu/modal is already open — the hamburger TOGGLES, so a
  // stale-open dropdown means this click closes it instead of opening it.
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 900);
  await page.waitForTimeout(400);
  const menu = page.locator('#gameMenuDropdown');
  if (!(await menu.isVisible().catch(() => false))) await tap(page, '#gameMenuBtn');
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(400);   // let the open transition settle
  await page.locator('#menuEndGame').click({ timeout: 15_000 });
  await expect(page.locator('#gameSummaryScreen')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(700);
  await shot(page, 'game-summary');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  await shot(page, 'game-summary-bottom');

  // ── Back to the team list, now with a finished game on it ────────────────
  await tap(page, '.title-bar-back-btn, #backToTeamsBtn');
  await page.waitForTimeout(900);
  await clearToasts(page);
  await shot(page, 'team-list-with-game');

  // A toast, deliberately: they are fixed-position and easy to miss by eye
  await page.evaluate(() => {
    (window as unknown as { showToast?: (m: string, t?: string) => void })
      .showToast?.('Dark-mode toast sample', 'success');
  });
  await page.waitForTimeout(500);
  await shot(page, 'toast');
});

test.afterAll(() => {
  // One row per distinct (selector, kind) — the same control reappears on many
  // screens and the fix is the same wherever it shows up.
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.kind}|${f.selector}|${f.sample}`;
    const prev = byKey.get(key);
    if (!prev || f.ratio < prev.ratio) byKey.set(key, f);
  }
  const rows = [...byKey.values()].sort((a, b) => a.ratio - b.ratio);
  fs.writeFileSync(path.join(SHOTS, '..', `contrast-${THEME}.json`),
    JSON.stringify(rows, null, 2));
  console.log(`\n${THEME}: ${rows.length} contrast findings ` +
    `(${rows.filter(r => r.kind === 'text').length} text, ` +
    `${rows.filter(r => r.kind === 'border').length} border)`);
  for (const r of rows.slice(0, 40)) {
    console.log(`  ${r.ratio.toFixed(2)}  ${r.kind.padEnd(6)} ${r.screen.padEnd(22)} ` +
      `${r.fg} on ${r.bg}  ${r.selector}  ${r.kind === 'text' ? JSON.stringify(r.sample) : r.sample}`);
  }
});
