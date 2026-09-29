/**
 * Viewport sweep — walks the app once per phone in phones.ts, screenshots
 * every screen and dialog, and runs the layout audit (layout-audit.ts) on
 * each one.
 *
 * Not an assertion test. It exists so a small-screen pass can be judged from a
 * contact sheet (screens down, phones across) plus a findings list, instead of
 * by borrowing a coach's phone, and so a fix can be diffed against the same
 * shot list.
 *
 *   npx playwright test --config sweep/sweep.config.ts viewport-sweep
 *   BREAKSIDE_PHONES=mini-safari,oneplus-8 npx playwright test ...   # a subset
 *
 * Output lands in tests/sweep/shots/viewport/: one directory of PNGs per
 * phone, <phone>.json with every screen's findings, and index.html, the
 * contact sheet, rebuilt from whatever JSON is present after each run.
 *
 * The walk uses a 16-player roster on purpose. The e2e helpers' 7-player team
 * fits everywhere; a real one does not, and the dialogs that list players
 * (line selection, score attribution, pull) are where small phones run out
 * of room first.
 *
 * Clicks go through press(), which clicks the way a finger could: straight
 * away if the control is on screen and uncovered, by scrolling if a real
 * scroll container holds it. A control no finger could reach is recorded as
 * an `unclickable` finding and then clicked through the DOM, so one hidden
 * button does not end the walk for that phone.
 */
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { goToApp, openEditRoster, addPlayer, backToStartGame } from '../helpers/app';
import { PHONES, Phone, userAgentFor } from './phones';
import { auditLayout, installLayoutAudit, reachOf, LayoutIssue } from './layout-audit';
import { serveFontsLocally } from './offline-fonts';

const OUT = path.join(__dirname, 'shots', 'viewport');
const DATA_DIR = path.join(__dirname, '..', 'test-data-dir');

// ARCHITECTURE.md § Names in examples: the canonical fictional roster.
const ROSTER: { name: string; number: string; gender: 'FMP' | 'MMP' }[] = [
  { name: 'Alice', number: '7', gender: 'FMP' },
  { name: 'Bob', number: '11', gender: 'MMP' },
  { name: 'Charlie', number: '3', gender: 'MMP' },
  { name: 'Dana', number: '22', gender: 'FMP' },
  { name: 'Eve', number: '9', gender: 'FMP' },
  { name: 'Hank', number: '5', gender: 'MMP' },
  { name: 'Iris', number: '14', gender: 'FMP' },
  { name: 'Jake', number: '8', gender: 'MMP' },
  { name: 'Kris', number: '2', gender: 'MMP' },
  { name: 'Mia', number: '17', gender: 'FMP' },
  { name: 'Nora', number: '21', gender: 'FMP' },
  { name: 'Omar', number: '4', gender: 'MMP' },
  { name: 'Sam', number: '10', gender: 'MMP' },
  { name: 'Tara', number: '13', gender: 'FMP' },
  { name: 'Wes', number: '6', gender: 'MMP' },
  { name: 'Morgan Vale', number: '99', gender: 'FMP' },
];

type Screen = { name: string; file: string; inGame: boolean; issues: LayoutIssue[] };

const only = (process.env.BREAKSIDE_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);
const phones = only.length ? PHONES.filter(p => only.includes(p.id)) : PHONES;

class Walk {
  screens: Screen[] = [];
  constructor(private page: Page, private phone: Phone) {}

  async clearToasts() {
    await this.page.evaluate(() => {
      document.querySelectorAll('#toastContainer > *').forEach(t => t.remove());
    });
  }

  /** Screenshot the current screen and audit its layout. */
  async snap(name: string, opts: { inGame?: boolean; layer?: string } = {}) {
    await this.clearToasts();
    await this.page.waitForTimeout(350);
    const dir = path.join(OUT, this.phone.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${this.phone.id}/${name}.png`;
    await this.page.screenshot({ path: path.join(OUT, file) });
    const issues = await auditLayout(this.page, opts);
    this.screens.push({ name, file, inGame: !!opts.inGame, issues });
  }

  /** Attach a finding to the screen most recently captured. */
  note(issue: LayoutIssue) {
    const last = this.screens[this.screens.length - 1];
    if (last) last.issues.push(issue);
  }

  /**
   * Click the way a finger could (see the file header). Returns false if the
   * control is not in the DOM at all.
   */
  async press(selector: string, what = '') {
    const el = this.page.locator(selector).first();
    if (!(await el.count())) return false;
    if (!(await el.isVisible())) return false;
    await this.clearToasts();
    const reach = await reachOf(el);
    if (reach === 'none') {
      this.note({
        kind: 'unclickable', severity: 'high', selector, label: what,
        detail: 'no finger could reach this control: off screen or covered, and nothing scrolls to it',
      });
      await el.evaluate(n => (n as HTMLElement).click());
      return true;
    }
    try {
      await el.click({ timeout: 4_000 });
    } catch (e) {
      this.note({
        kind: 'unclickable', severity: 'high', selector, label: what,
        detail: String((e as Error).message).split('\n')[0].slice(0, 160),
      });
      await el.evaluate(n => (n as HTMLElement).click());
    }
    return true;
  }

  /** Close whatever dialog or dropdown is open, by its own close control if it has one. */
  async dismiss() {
    const page = this.page;
    const closed = await page.evaluate(() => {
      const open = [...document.querySelectorAll<HTMLElement>('.modal, .dialog, [role="dialog"]')]
        .filter(m => m.checkVisibility?.() && m.getBoundingClientRect().height > 0);
      const top = open[open.length - 1];
      if (!top) return false;
      const byClass = top.querySelector<HTMLElement>('.close, .modal-close, .dialog-close, [data-dismiss], .cancel-btn');
      const byText = [...top.querySelectorAll<HTMLElement>('button')]
        .find(b => /^(cancel|close|done|×|✕)$/i.test(b.innerText.trim()));
      const target = byClass || byText;
      if (target) { target.click(); return true; }
      return false;
    });
    if (!closed) await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  async closeGameMenu() {
    const menu = this.page.locator('#gameMenuDropdown');
    if (await menu.isVisible().catch(() => false)) {
      await this.page.locator('#gameMenuBtn').evaluate(n => (n as HTMLElement).click());
      await this.page.waitForTimeout(250);
    }
  }

  async openGameMenuItem(itemSelector: string) {
    await this.closeGameMenu();
    await this.press('#gameMenuBtn', 'menu');
    await this.page.waitForTimeout(300);
    return this.press(itemSelector);
  }

  async activeTab() {
    return this.page.evaluate(() =>
      document.querySelector('#headerSegControl button.active, #headerSegControl [aria-selected="true"]')
        ?.getAttribute('data-tab') || null);
  }
}

for (const phone of phones) {
  test.describe(phone.id, () => {
    test.use({
      viewport: phone.viewport,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: userAgentFor(phone),
    });

    test.beforeEach(async ({ page }) => {
      // A clean team list for every phone: the list is membership-scoped, so
      // dropping the memberships hides the previous phones' teams.
      fs.rmSync(path.join(DATA_DIR, 'memberships'), { recursive: true, force: true });
      await serveFontsLocally(page);
      await installLayoutAudit(page);
      await page.addInitScript(() => {
        localStorage.setItem('breakside_advanced_settings',
          JSON.stringify({ 'display.theme': 'light', 'hints.hideAll': true }));
      });
      page.on('dialog', d => d.accept());
    });

    test(`sweep ${phone.label}`, async ({ page }) => {
      test.setTimeout(420_000);
      const w = new Walk(page, phone);

      try {
        await walk(page, w);
      } finally {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, `${phone.id}.json`), JSON.stringify({
          phone, capturedAt: new Date().toISOString(), screens: w.screens,
        }, null, 2));
        writeContactSheet();
      }
    });
  });
}

async function walk(page: Page, w: Walk) {
  // ── Team list and team setup ─────────────────────────────────────────────
  await goToApp(page);
  await w.snap('team-list-empty');

  await w.press('.teams-action-create', 'Create team');
  await expect(page.locator('#createTeamModal')).toBeVisible();
  await w.snap('create-team-modal');
  await page.fill('#newTeamNameInput', 'Breakside');
  await w.press('#saveNewTeamBtn', 'Save team');
  await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(400);
  await w.snap('team-home-empty');

  await openEditRoster(page);
  for (const p of ROSTER) await addPlayer(page, p.name, p.number, p.gender);
  await page.evaluate(() => window.scrollTo(0, 0));
  await w.snap('edit-roster');

  if (await w.press('#rosterList .roster-player-row, #rosterList li', 'roster row')) {
    await page.waitForTimeout(400);
    await w.snap('roster-row-expanded');
    await w.dismiss();
  }
  await backToStartGame(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await w.snap('team-home');

  if (await w.press('#teamSettingsBtn, #showTeamSettingsBtn', 'Team settings')) {
    await page.waitForTimeout(600);
    await w.snap('team-settings');
    await w.press('#backToStartGameBtn, .title-bar-back-btn', 'Back');
    await page.waitForTimeout(400);
  }

  // ── Start the game, first line ──────────────────────────────────────────
  await page.fill('#opponentNameInput', 'Rival City');
  await w.press('#startGameOnOBtn', 'Start on O');
  await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(800);
  const homeTab = await w.activeTab();
  await w.snap('game-line-empty', { inGame: true });

  if (await page.locator('#panelStartingRatioFMP').isVisible().catch(() => false)) {
    await w.press('#panelStartingRatioFMP', 'Starting ratio FMP');
  }
  await w.press('#panelAutoBtn', 'Auto');
  await page.waitForTimeout(400);
  await w.snap('game-line-auto', { inGame: true });

  await w.press('#gameMenuBtn', 'menu');
  await page.waitForTimeout(300);
  await w.snap('game-menu', { inGame: true, layer: '#gameMenuDropdown' });
  await w.closeGameMenu();

  // ── Offense point ───────────────────────────────────────────────────────
  await w.press('#pbpStartPointBtn, #lineTabStartPointBtn', 'Start Point');
  await page.waitForTimeout(900);
  await w.snap('offense-point', { inGame: true });

  await w.press('#pbpWeScoreBtn', 'We Score');
  await expect(page.locator('#scoreAttributionDialog')).toBeVisible();
  await w.snap('score-attribution', { inGame: true });
  await w.press('#throwerButtons .player-button:not(.unknown-player) >> nth=0', 'thrower');
  await page.waitForTimeout(250);
  await w.snap('score-attribution-thrower', { inGame: true });
  await w.press('#receiverButtons .player-button:not(.unknown-player):not(.disabled) >> nth=1', 'receiver');
  await page.waitForTimeout(600);
  if (await page.locator('#scoreAttributionDialog').isVisible().catch(() => false)) {
    await w.press('#receiverButtons .player-button.unknown-player', 'Unknown receiver');
  }
  await page.waitForTimeout(500);
  await w.snap('between-points', { inGame: true });

  // ── Defense point: pull, then the in-point dialogs ──────────────────────
  await w.press('#panelAutoBtn', 'Auto');
  await page.waitForTimeout(300);
  await w.press('#pbpStartPointBtn, #lineTabStartPointBtn', 'Start Point');
  await page.waitForTimeout(900);
  if (await page.locator('#pullDialog').isVisible().catch(() => false)) {
    await w.snap('pull-dialog', { inGame: true });
    await w.press('#pullPlayerButtons .player-button >> nth=0', 'puller');
    await w.press('#pullQualityButtons .pull-quality-btn[data-quality="Good Pull"]', 'Good Pull');
    await w.press('#pullProceedBtn', 'Proceed');
    await page.waitForTimeout(500);
  }
  await w.snap('defense-point', { inGame: true });

  // More first: Sub Players and Game Events live on the row it opens.
  const dialogs: [string, string][] = [
    ['#pbpKeyPlayBtn', 'key-play-dialog'],
    ['#pbpMoreBtn', 'more-options'],
    ['#pbpSubPlayersBtn', 'sub-players-dialog'],
    ['#pbpGameEventsBtn', 'game-events-dialog'],
  ];
  for (const [btn, name] of dialogs) {
    if (!(await w.press(btn, name))) continue;
    await page.waitForTimeout(500);
    await w.snap(name, { inGame: true });
    await w.dismiss();
    await w.closeGameMenu();
  }

  // ── Every panel tab, mid-point ──────────────────────────────────────────
  for (const tab of ['simple', 'full', 'field', 'line', 'log', 'all']) {
    if (!(await w.press(`#headerSegControl button[data-tab="${tab}"]`, `${tab} tab`))) continue;
    await page.waitForTimeout(800);
    await w.snap(`tab-${tab}`, { inGame: true });
  }
  if (homeTab) await w.press(`#headerSegControl button[data-tab="${homeTab}"]`, 'home tab');
  await page.waitForTimeout(400);

  // ── In-game menus that open full screens ────────────────────────────────
  if (await w.openGameMenuItem('#menuGameSettings')) {
    await page.waitForTimeout(600);
    await w.snap('game-settings', { inGame: true });
    await w.press('#continueGameBtn', 'Continue Game');
    await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });
  }
  if (await w.openGameMenuItem('#menuSettings')) {
    await page.waitForTimeout(600);
    await w.snap('advanced-settings', { inGame: true });
    const body = page.locator('.adv-settings-body');
    if (await body.count()) {
      await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);
      await w.snap('advanced-settings-bottom', { inGame: true });
    }
    await w.press('#advancedSettingsModal .adv-done-btn', 'Done');
    await page.waitForTimeout(300);
  }

  // ── End the game ────────────────────────────────────────────────────────
  await w.press('#pbpTheyScoreBtn', 'They Score');
  await page.waitForTimeout(600);
  await w.openGameMenuItem('#menuEndGame');
  await expect(page.locator('#gameSummaryScreen')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(700);
  await w.snap('game-summary');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await w.snap('game-summary-bottom');

  await w.press('.title-bar-back-btn, #backToTeamsBtn', 'Back');
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo(0, 0));
  await w.snap('team-home-after-game');
}

// ── Contact sheet ───────────────────────────────────────────────────────────

const SEV_ORDER = { high: 0, med: 1, low: 2 } as const;

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Rebuild index.html from every <phone>.json present, in phones.ts order. */
function writeContactSheet() {
  const runs = PHONES
    .map(p => path.join(OUT, `${p.id}.json`))
    .filter(f => fs.existsSync(f))
    .map(f => JSON.parse(fs.readFileSync(f, 'utf8')) as { phone: Phone; screens: Screen[] });
  if (!runs.length) return;

  const names: string[] = [];
  for (const r of runs) for (const s of r.screens) if (!names.includes(s.name)) names.push(s.name);

  const cell = (s: Screen | undefined) => {
    if (!s) return '<td class="missing">not reached</td>';
    const issues = [...s.issues].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    const counts = (['high', 'med', 'low'] as const)
      .map(sev => [sev, issues.filter(i => i.severity === sev).length] as const)
      .filter(([, n]) => n > 0)
      .map(([sev, n]) => `<span class="badge ${sev}">${n} ${sev}</span>`).join(' ');
    const list = issues.filter(i => i.severity !== 'low').map(i =>
      `<li class="${i.severity}"><b>${esc(i.kind)}</b> ${esc(i.label || i.selector)}` +
      `<br><small>${esc(i.selector)}: ${esc(i.detail)}</small></li>`).join('');
    return `<td><a href="${esc(s.file)}"><img loading="lazy" src="${esc(s.file)}"></a>` +
      `<div class="counts">${counts || '<span class="badge ok">clean</span>'}</div>` +
      (list ? `<details><summary>findings</summary><ul>${list}</ul></details>` : '') + '</td>';
  };

  const head = runs.map(r =>
    `<th>${esc(r.phone.label)}<br><small>${r.phone.viewport.width}×${r.phone.viewport.height}</small></th>`).join('');
  const rows = names.map(n =>
    `<tr><th class="screen">${esc(n)}</th>${runs.map(r => cell(r.screens.find(s => s.name === n))).join('')}</tr>`).join('\n');

  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html>
<meta charset="utf-8"><title>Viewport sweep</title>
<style>
  body { font: 13px system-ui, sans-serif; margin: 16px; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 6px; vertical-align: top; }
  thead th { position: sticky; top: 0; background: #fff; z-index: 1; }
  th.screen { text-align: left; white-space: nowrap; }
  td { width: 230px; }
  img { width: 220px; display: block; border: 1px solid #ccc; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 8px; color: #fff; font-size: 11px; }
  .badge.high { background: #c62828; } .badge.med { background: #ef6c00; }
  .badge.low { background: #888; } .badge.ok { background: #2e7d32; }
  .counts { margin: 4px 0; }
  ul { margin: 4px 0; padding-left: 16px; } li { margin-bottom: 4px; }
  li.high b { color: #c62828; } li.med b { color: #ef6c00; }
  td.missing { color: #999; text-align: center; }
</style>
<h1>Viewport sweep</h1>
<table><thead><tr><th></th>${head}</tr></thead><tbody>
${rows}
</tbody></table>`);
}
