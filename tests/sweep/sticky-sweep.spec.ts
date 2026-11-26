/**
 * Sticky-cell sweep: every table with a pinned header row or pinned columns,
 * checked for content showing through the pinned cells.
 *
 * Not part of the normal suite (tests/playwright.config.ts runs scenarios/
 * only). Run it after touching table, border or sticky CSS:
 *
 *   cd tests
 *   npx playwright test --config sweep/sweep.config.ts sticky-sweep
 *   BREAKSIDE_STICKY_DPRS=3 npx playwright test --config sweep/sweep.config.ts sticky-sweep
 *
 * Method. A pinned cell that fully covers what scrolls under it looks the
 * same at every scroll position. For each pinned region (a header row, or the
 * pinned columns) the sweep screenshots it at four scroll positions, scroll 0
 * among them, and diffs each shot against the first. A changed pixel is
 * either scrolled content showing through, or the pinned cells moving (a jump
 * on the first scroll); both are bugs. Shots come straight from CDP at the
 * emulated DPR, because a gap narrower than a CSS pixel only shows at device
 * scale, and the scroll positions are multiples of 8 CSS px so they land on
 * whole device pixels at every DPR tested (2.625 x 8 = 21).
 *
 * Fails on any difference at a whole-number DPR, and on any region that did
 * not scroll (it would pass without testing anything). At a fractional DPR
 * (2.625, some Android phones) Chromium's pixel snapping leaves
 * one-device-pixel seams between adjacent pinned cells; those are reported in
 * the results, not failed.
 *
 * Output: tests/sweep/shots/sticky/results.json, and for each region that
 * differs the shots that disagree (<table>-<axis>-dpr<n>-<i>.png).
 *
 * Covered: the Line tab, event roster, game summary, flow-chart connections
 * matrix, team roster (Roster + Stats), scrimmage squad picker and scrimmage
 * stats. A new table with pinned cells belongs here. Background:
 * ARCHITECTURE.md § CSS Styling Gotchas, sticky table cells.
 */
import { test, expect, Page, CDPSession } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { TEST_PARAMS } from '../helpers/constants';
import {
  createTeam, openEditRoster, addPlayer, backToStartGame, startGame,
  startPoint, weScoreWithAttribution, theyScore, completePullDialog, endGame,
} from '../helpers/app';

const OUT = path.join(__dirname, 'shots', 'sticky');
const COACH = 'sticky-sweep';
const EVENT = 'Sweep Cup';
const DPRS = (process.env.BREAKSIDE_STICKY_DPRS || '1,2,3,2.625').split(',').map(Number);
// Short enough that every stats container (max-height: 70vh) scrolls with a
// 20-player roster, narrow enough that every wide table scrolls sideways.
const W = 390, H = 664;

// Fictional names (ARCHITECTURE.md § Names in examples). None is a substring
// of another: the attribution helpers match player buttons by text.
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy',
  'Karl', 'Walter', 'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Rupert', 'Sybil', 'Trent', 'Victor'];
const ROSTER = NAMES.map((name, i) => ({ name, number: String(i + 1), gender: (i % 2 ? 'MMP' : 'FMP') as 'FMP' | 'MMP' }));

type Axis = 'x' | 'y';
type Diff = { n: number; maxD: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } | null };
type Result = {
  name: string; axis: Axis; dpr: number;
  skipped?: string;
  clip?: { x: number; y: number; width: number; height: number };
  scrollMax?: number; reached?: number[]; diffs?: Diff[]; bad?: number;
};

test.describe.configure({ timeout: 480_000 });

let team = '';
let cdp: CDPSession | null = null;
const results: Result[] = [];

function card(page: Page) {
  return page.locator('#cloudTeamsList .team-section', {
    has: page.locator('.team-header-name', { hasText: team }),
  });
}

async function goToTeams(page: Page) {
  await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
}

async function expandCard(page: Page) {
  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  const container = card(page).locator('.team-games-container');
  if (!(await container.isVisible())) await card(page).locator('.team-header').click();
  await expect(container).toBeVisible();
}

/** Check exactly `names` on the Line tab. The table re-renders on every click, so re-query each time. */
async function setLine(page: Page, names: string[]) {
  const table = page.locator('#panelActivePlayersTable');
  if (!(await table.isVisible())) await page.click('#headerSegControl button[data-tab="line"]');
  await expect(table).toBeVisible({ timeout: 8_000 });
  for (let i = 0; i < 60; i++) {
    const state = await table.locator('tbody input.active-checkbox').evaluateAll(els =>
      els.map(e => ({ n: (e as HTMLElement).dataset.playerName || '', c: (e as HTMLInputElement).checked })));
    const todo = state.find(s => names.includes(s.n) !== s.c);
    if (!todo) return;
    await table.locator(`tbody input.active-checkbox[data-player-name="${todo.n}"]`).click();
    await page.waitForTimeout(50);
  }
  throw new Error(`could not set the line to ${names.join(', ')}`);
}

/** Play a point: O points end in our score, D points (pull dialog) in theirs. */
async function playPoint(page: Page, line: string[]) {
  await setLine(page, line);
  await startPoint(page);
  const pulling = await page.locator('#pullDialog').waitFor({ state: 'visible', timeout: 1_500 })
    .then(() => true, () => false);
  if (pulling) {
    await completePullDialog(page, line[2]);
    await theyScore(page);
  } else {
    await weScoreWithAttribution(page, line[0], line[1]);
  }
}

/**
 * Emulate a phone at `dpr` through one CDP session kept open for the whole
 * run: detaching a session drops its metrics override, and the page falls
 * back to a 1280px window. Playwright's own screenshot ignores this DPR, so
 * shots go through the same session (shoot below).
 */
async function setDpr(page: Page, dpr: number) {
  if (!cdp) cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: dpr, mobile: false });
  await page.waitForTimeout(150);
  const got = await page.evaluate(() => ({ w: innerWidth, dpr: devicePixelRatio }));
  if (got.w !== W || Math.abs(got.dpr - dpr) > 0.01) throw new Error(`metrics override failed: ${JSON.stringify(got)}`);
}

async function shoot(clip: { x: number; y: number; width: number; height: number }) {
  const { data } = await cdp!.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  return Buffer.from(data, 'base64');
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(120);
}

/** Pixels that differ by more than antialiasing noise, decoded in the page. */
async function diff(page: Page, a: Buffer, b: Buffer): Promise<Diff> {
  return page.evaluate(async ([a64, b64]) => {
    const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
    });
    const [ia, ib] = await Promise.all([load('data:image/png;base64,' + a64), load('data:image/png;base64,' + b64)]);
    const w = ia.width, h = ia.height;
    const px = (img: HTMLImageElement) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d')!; x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data;
    };
    const da = px(ia), db = px(ib);
    let n = 0, minX = w, minY = h, maxX = -1, maxY = -1, maxD = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const d = Math.max(Math.abs(da[k] - db[k]), Math.abs(da[k + 1] - db[k + 1]), Math.abs(da[k + 2] - db[k + 2]));
      if (d > 24) {
        n++; maxD = Math.max(maxD, d);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    return { n, maxD, bbox: n ? { minX, minY, maxX, maxY } : null };
  }, [a.toString('base64'), b.toString('base64')] as const);
}

/**
 * The pinned region of a scroll container in document coordinates (CDP clips
 * are document-relative): for 'x' the pinned columns, from the scrollport's
 * left edge to the stickies' right edge; for 'y' the header row, from the
 * scrollport's top to the header cells' bottom. The inner edge's last pixel
 * is shared with whatever scrolls past it (antialiased), so the clip stops
 * one pixel short of it. `inside` confirms the clip is over the container.
 */
async function region(page: Page, containerSel: string, stickySel: string, axis: Axis) {
  return page.evaluate(([cs, ss, ax]) => {
    const c = document.querySelector(cs) as HTMLElement;
    const r = c.getBoundingClientRect();
    const left = r.left + c.clientLeft, top = r.top + c.clientTop;
    const right = left + c.clientWidth, bottom = top + c.clientHeight;
    const cells = [...c.querySelectorAll(ss)].map(e => e.getBoundingClientRect())
      .filter(b => b.width > 0 && b.height > 0 && b.bottom > top && b.top < bottom);
    let x0 = left, y0 = top, x1 = right, y1 = bottom;
    if (ax === 'x') x1 = Math.min(right, Math.max(...cells.map(b => b.right)) - 1);
    else y1 = Math.min(bottom, Math.max(...cells.filter(b => b.top < top + 2).map(b => b.bottom)) - 1);
    x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, innerWidth); y1 = Math.min(y1, innerHeight);
    const vx = Math.ceil(x0), vy = Math.ceil(y0);
    const vw = Math.floor(x1) - vx, vh = Math.floor(y1) - vy;
    const hit = vw > 0 && vh > 0 ? document.elementFromPoint(vx + vw / 2, vy + vh / 2) : null;
    return {
      clip: { x: vx + scrollX, y: vy + scrollY, width: vw, height: vh },
      inside: !!hit && c.contains(hit),
      scrollMax: ax === 'x' ? c.scrollWidth - c.clientWidth : c.scrollHeight - c.clientHeight,
    };
  }, [containerSel, stickySel, axis] as const);
}

async function scrollTo(page: Page, containerSel: string, axis: Axis, v: number) {
  await page.evaluate(([cs, ax, val]) => {
    const c = document.querySelector(cs) as HTMLElement;
    if (ax === 'x') c.scrollLeft = val as number; else c.scrollTop = val as number;
  }, [containerSel, axis, v] as const);
  await settle(page);
}

/** Check one pinned region at every DPR. */
async function audit(page: Page, name: string, containerSel: string, stickySel: string, axis: Axis) {
  for (const dpr of DPRS) {
    await setDpr(page, dpr);
    await scrollTo(page, containerSel, 'x', 0);
    await scrollTo(page, containerSel, 'y', 0);
    await page.locator(containerSel).first().evaluate(el => el.scrollIntoView({ block: 'nearest' }));
    await settle(page);
    const { clip, scrollMax, inside } = await region(page, containerSel, stickySel, axis);
    if (!inside || scrollMax < 16 || clip.width <= 0 || clip.height <= 0) {
      results.push({ name, axis, dpr, clip, scrollMax,
        skipped: !inside ? 'the clip is not over the container' : `nothing to scroll (scrollMax ${scrollMax})` });
      continue;
    }
    const at = (f: number) => 8 * Math.floor(scrollMax * f / 8);
    const positions = [0, Math.max(8, at(1 / 3)), Math.max(16, at(2 / 3)), at(1)];
    const shots: Buffer[] = [];
    const reached: number[] = [];
    for (const p of positions) {
      await scrollTo(page, containerSel, axis, p);
      reached.push(await page.locator(containerSel).first().evaluate((el, ax) =>
        ax === 'x' ? el.scrollLeft : el.scrollTop, axis));
      shots.push(await shoot(clip));
    }
    const diffs: Diff[] = [];
    for (let i = 1; i < shots.length; i++) diffs.push(await diff(page, shots[0], shots[i]));
    const bad = diffs.reduce((sum, d) => sum + d.n, 0);
    if (bad) {
      const tag = `${name}-${axis}-dpr${dpr}`.replace(/[^\w.-]+/g, '_');
      shots.forEach((s, i) => fs.writeFileSync(path.join(OUT, `${tag}-${i}.png`), s));
    }
    results.push({ name, axis, dpr, clip, scrollMax, reached, diffs, bad });
  }
  await setDpr(page, 1);
  await scrollTo(page, containerSel, 'x', 0);
  await scrollTo(page, containerSel, 'y', 0);
}

test('pinned table cells cover what scrolls under them', async ({ page }) => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  page.on('dialog', d => d.accept());
  await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH}`);
  await setDpr(page, 1);
  team = `Sticky Sweep Test Team ${Date.now().toString(36)}`;

  await goToTeams(page);
  await createTeam(page, team);
  await openEditRoster(page);
  for (const p of ROSTER) await addPlayer(page, p.name, p.number, p.gender);
  await backToStartGame(page);
  await page.click('#backFromStartGameBtn');
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });

  // ── An event game of twelve points: enough point columns to scroll the Line tab ──
  await expandCard(page);
  await card(page).locator('.new-event-btn').click();
  await page.fill('#newEventName', EVENT);
  await page.click('#createEventBtn');
  await expect(page.locator('#createEventModal')).toHaveCount(0, { timeout: 10_000 });
  const ev = card(page).locator('.event-container', { has: page.locator('.event-name', { hasText: EVENT }) });
  await expect(ev).toBeVisible({ timeout: 15_000 });
  if (await ev.evaluate(el => el.classList.contains('collapsed'))) await ev.locator('.event-header-top').click();
  await ev.locator('.event-new-game-btn').click();
  await expect(page.locator('#startGameSubscreen')).toBeVisible({ timeout: 10_000 });
  await startGame(page, 'offense');
  for (let i = 0; i < 12; i++) {
    await playPoint(page, Array.from({ length: 7 }, (_, k) => NAMES[(i * 3 + k) % NAMES.length]));
  }
  if (!(await page.locator('#panelActivePlayersTable').isVisible())) {
    await page.click('#headerSegControl button[data-tab="line"]');
  }
  await expect(page.locator('#panelActivePlayersTable')).toBeVisible();
  await page.waitForTimeout(500);

  // ── Line tab: pinned checkbox / name / time columns and the score-row headers ──
  await audit(page, 'line-tab', '#panelTableContainer',
    '.active-checkbox-column, .active-name-column, .active-time-column, .active-header-teams', 'x');

  // ── Event roster, from the in-game menu ──
  await page.click('#gameMenuBtn');
  await page.click('#menuEventRoster');
  await expect(page.locator('#eventRosterScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#eventRosterList tr', { hasText: 'Alice' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  const eventRoster = '#eventRosterScreen .roster-table-container';
  await audit(page, 'event-roster', eventRoster, '#eventRosterTable tr:first-child th', 'y');
  await audit(page, 'event-roster', eventRoster,
    '#eventRosterTable td:nth-child(-n+2), #eventRosterTable th:nth-child(-n+2)', 'x');
  await page.click('#backFromEventRosterBtn');
  await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 10_000 });

  // ── Game summary, and its flow-chart connections matrix ──
  await endGame(page);
  await page.waitForTimeout(800);
  const summary = '#gameSummaryScreen .roster-table-container:has(#gameSummaryTable)';
  await audit(page, 'game-summary', summary, '#gameSummaryTable tr:first-child th', 'y');
  await audit(page, 'game-summary', summary, '#gameSummaryTable td:nth-child(1), #gameSummaryTable th:nth-child(1)', 'x');
  const flowSection = page.locator('#gameFlowSection');
  if (await flowSection.evaluate(el => el.classList.contains('collapsed'))) {
    await flowSection.locator('.summary-section-toggle').click();
  }
  await page.locator('#gameConnectionsHost .gf-conn-head button', { hasText: 'Matrix' }).click();
  await expect(page.locator('#gameConnectionsHost .gf-matrix')).toBeVisible();
  await audit(page, 'flow-matrix', '#gameConnectionsHost .gf-matrix-scroll', 'th.gf-row, thead th.gf-corner', 'x');

  // ── Team roster (Roster + Stats), now with stats columns ──
  await goToTeams(page);
  await expandCard(page);
  await card(page).locator('.new-game-btn', { hasText: 'New Game' }).click();
  await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 8_000 });
  await openEditRoster(page);
  await page.waitForTimeout(1_000);
  const roster = '#editRosterSubscreen .roster-table-container';
  await audit(page, 'team-roster', roster, '#rosterTable .roster-header', 'y');
  await audit(page, 'team-roster', roster,
    '.roster-sticky-checkbox, .roster-sticky-name, .roster-checkbox-header, .roster-name-header', 'x');
  await backToStartGame(page);
  await page.click('#backFromStartGameBtn');
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });

  // ── Scrimmage: the squad picker, then a few points for the stats screen ──
  await expandCard(page);
  await card(page).locator('.new-scrimmage-btn').click();
  const modal = page.locator('#newScrimmageModal');
  await expect(modal.locator('#scrimmagePickerBody tr[data-player-id]')).toHaveCount(ROSTER.length, { timeout: 15_000 });
  await audit(page, 'scrimmage-picker', '#newScrimmageModal .scrimmage-picker-scroll', '.scrimmage-picker th', 'y');
  await modal.locator('#scrimmageAutoBtn').click();
  await modal.locator('#scrimmageStartX').click();
  await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });
  const squad = await page.locator('#panelActivePlayersTable tbody input.active-checkbox').evaluateAll(els =>
    els.map(e => (e as HTMLElement).dataset.playerName || ''));
  for (let i = 0; i < 4; i++) await playPoint(page, squad.slice(0, 7));
  await page.click('#gameMenuBtn');
  await page.click('#menuLeaveGame');
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expandCard(page);
  await card(page).locator('.scrimmage-container .event-header-btn', { hasText: 'Stats' }).click();
  await expect(page.locator('#scrimmageStatsScreen')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('#scrimmageStatsList tr').nth(3)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  const scrimmageStats = '#scrimmageStatsScreen .roster-table-container';
  await audit(page, 'scrimmage-stats', scrimmageStats, '#scrimmageStatsTable tr:first-child th', 'y');
  await audit(page, 'scrimmage-stats', scrimmageStats,
    '#scrimmageStatsTable td:nth-child(1), #scrimmageStatsTable th:nth-child(1)', 'x');

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const line = (r: Result) => `${r.name} ${r.axis} @${r.dpr}x: ${r.skipped
    ?? `${r.bad} px differ ${JSON.stringify(r.diffs!.map(d => d.bbox))} (scroll ${r.reached!.join('/')})`}`;
  const fractional = results.filter(r => !Number.isInteger(r.dpr) && (r.bad || r.skipped));
  if (fractional.length) console.log(`Fractional-DPR differences (reported, not failed):\n  ${fractional.map(line).join('\n  ')}`);
  const failures = results.filter(r => Number.isInteger(r.dpr) && (r.bad || r.skipped)).map(line);
  expect(failures, `pinned regions that changed or were not exercised; shots in ${OUT}`).toEqual([]);
});
