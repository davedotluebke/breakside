/**
 * Intrasquad scrimmage (store/scrimmage.js, teams/scrimmageDialogs.js,
 * teams/scrimmageStats.js).
 *
 * A scrimmage is two linked squad-games, created together from the team card.
 * This drives the whole loop as two coaches would:
 *   New Scrimmage → the dialog deals the roster onto two squads → start,
 *   tracking one squad → that game fields only its squad → score a point →
 *   leave → the card shows both squads with the score → Track the other squad
 *   → it fields the other players → the Stats screen folds both halves
 *   together → delete removes both games.
 *
 * The pure rules (dealing, grouping, scores) are pinned in
 * tests/unit/scrimmage.test.mjs; this is about the wiring between the dialog,
 * the two Game objects, the server, the team list and the game screen.
 */
import { test, expect, Page } from '@playwright/test';
import { TEST_PARAMS, BACKEND_URL } from '../helpers/constants';
import {
  createTeam, openEditRoster, addPlayer, backToStartGame,
  selectAllPlayers, startPoint, weScoreWithAttribution, expectScore,
} from '../helpers/app';
import { coachHeaders } from '../helpers/controllerApi';

// Own test user, so other specs' teams never show up in this list. "Test" in
// the team name makes the app skip its leave / delete confirms (isTestTeam).
const COACH = 'scrimmage-coach';
const TEAM = 'Scrimmage Test Team';

// Four FMP, four MMP: the auto split should give each squad two of each.
const ROSTER = [
  { name: 'Alice', number: '7', gender: 'FMP' as const },
  { name: 'Bob', number: '11', gender: 'MMP' as const },
  { name: 'Charlie', number: '3', gender: 'MMP' as const },
  { name: 'Dana', number: '22', gender: 'FMP' as const },
  { name: 'Eve', number: '9', gender: 'FMP' as const },
  { name: 'Hank', number: '5', gender: 'MMP' as const },
  { name: 'Iris', number: '14', gender: 'FMP' as const },
  { name: 'Jake', number: '8', gender: 'MMP' as const },
];

test.describe.configure({ timeout: 150_000 });

async function goToTeams(page: Page) {
  await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
}

function card(page: Page) {
  return page.locator('#cloudTeamsList .team-section', {
    has: page.locator('.team-header-name', { hasText: TEAM }),
  });
}

/** The card's games container is collapsible; open it if it is closed. */
async function expandCard(page: Page) {
  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  const container = card(page).locator('.team-games-container');
  if (!(await container.isVisible())) {
    await card(page).locator('.team-header').click();
  }
  await expect(container).toBeVisible();
}

/** Leave the game via the menu (no confirm: test team) back to the team list. */
async function leaveGame(page: Page) {
  page.once('dialog', d => d.accept());
  await page.click('#gameMenuBtn');
  await expect(page.locator('#gameMenuDropdown')).toBeVisible();
  await page.click('#menuLeaveGame');
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
}

/** The names on the Line tab: the players this game can field. */
async function lineTabNames(page: Page): Promise<string[]> {
  const table = page.locator('#panelActivePlayersTable');
  await expect(table).toBeVisible({ timeout: 8_000 });
  const boxes = table.locator('tbody input.active-checkbox');
  await expect(boxes.first()).toBeAttached({ timeout: 8_000 });
  const names = await boxes.evaluateAll(els => els.map(e => (e as HTMLElement).dataset.playerName || ''));
  return names.sort();
}

/** The dialog's current squads, from the pressed pick buttons (one DOM read:
 *  a per-row locator would wait on a row with no pressed button). */
async function dialogSquads(page: Page) {
  return page.evaluate(() => {
    const out: { X: string[]; Y: string[]; out: string[] } = { X: [], Y: [], out: [] };
    document.querySelectorAll('#scrimmagePickerBody tr[data-player-id]').forEach(row => {
      const name = (row.querySelector('.scrimmage-player-col')?.textContent || '').replace(/\s*\(.*\)\s*$/, '').trim();
      const on = (row.querySelector('.scrimmage-pick.on') as HTMLElement | null)?.dataset.squad;
      if (on === 'X') out.X.push(name);
      else if (on === 'Y') out.Y.push(name);
      else out.out.push(name);
    });
    return out;
  });
}

/** This test team's games on the server, once the sync queue has landed them. */
async function serverScrimmageGames(page: Page, expectCount: number) {
  let games: any[] = [];
  await expect
    .poll(
      async () => {
        const resp = await page.request.get(`${BACKEND_URL}/api/games`, { headers: coachHeaders(COACH) });
        if (!resp.ok()) return -1;
        games = (await resp.json()).games.filter((g: any) => g.team === 'Red' || g.team === 'Blue');
        return games.length;
      },
      { message: 'the two squad-games never reached the server', timeout: 20_000, intervals: [250] },
    )
    .toBe(expectCount);
  return games;
}

test.describe('intrasquad scrimmage', () => {
  test('create, track one squad, track the other, review stats, delete', async ({ page }) => {
    await goToTeams(page);
    await createTeam(page, TEAM);
    await openEditRoster(page);
    for (const p of ROSTER) await addPlayer(page, p.name, p.number, p.gender);
    await backToStartGame(page);
    await page.click('#backFromStartGameBtn');
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });

    // ── New Scrimmage: the roster is dealt onto two balanced squads ──
    await expandCard(page);
    await expect(card(page).locator('.game-count')).toHaveText('0 games');
    await card(page).locator('.new-scrimmage-btn').click();
    const modal = page.locator('#newScrimmageModal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#scrimmagePickerBody tr[data-player-id]')).toHaveCount(ROSTER.length);

    let squads = await dialogSquads(page);
    expect(squads.X.length + squads.Y.length).toBe(ROSTER.length);
    expect(Math.abs(squads.X.length - squads.Y.length)).toBeLessThanOrEqual(1);
    await expect(modal.locator('th[data-squad="X"] .scrimmage-col-count')).toHaveText('4 · 2F / 2M');
    await expect(modal.locator('th[data-squad="Y"] .scrimmage-col-count')).toHaveText('4 · 2F / 2M');
    await expect(modal.locator('#scrimmageSitting')).toHaveText('Everyone is on a squad');

    // Jake didn't show up: tap his squad again to sit him out.
    const jakeRow = modal.locator('#scrimmagePickerBody tr', { hasText: 'Jake' });
    await jakeRow.locator('.scrimmage-pick.on').click();
    await expect(jakeRow).toHaveClass(/scrimmage-sitting-out/);
    await expect(modal.locator('#scrimmageSitting')).toHaveText('1 sitting out');

    // Name the squads; the headers, pull toggle and Start buttons follow.
    await modal.locator('#scrimmageSquadNameX').fill('Red');
    await modal.locator('#scrimmageSquadNameY').fill('Blue');
    await expect(modal.locator('th[data-squad="X"] .scrimmage-col-name')).toHaveText('Red');
    await expect(modal.locator('#scrimmageStartX')).toHaveText(/Start, tracking Red/);
    await expect(modal.locator('#scrimmageStartY')).toHaveText(/Start, tracking Blue/);

    // Blue pulls first, so Red starts on offense (no pull dialog for Red).
    await modal.locator('.scrimmage-pull-btn[data-squad="Y"]').click();
    await expect(modal.locator('.scrimmage-pull-btn[data-squad="Y"]')).toHaveClass(/active/);

    squads = await dialogSquads(page);
    expect(squads.out).toEqual(['Jake']);
    const red = [...squads.X].sort();
    const blue = [...squads.Y].sort();

    // ── Start, tracking Red: the game fields only Red's players ──
    await modal.locator('#scrimmageStartX').click();
    await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#headerTeamUs')).toHaveText('Red');
    await expect(page.locator('#headerTeamThem')).toHaveText('Blue');
    expect(await lineTabNames(page)).toEqual(red);

    // Both halves reach the server, linked and with mirrored squads.
    const games = await serverScrimmageGames(page, 2);
    const redGame = games.find(g => g.team === 'Red');
    const blueGame = games.find(g => g.team === 'Blue');
    expect(redGame.scrimmageId).toBeTruthy();
    expect(blueGame.scrimmageId).toBe(redGame.scrimmageId);
    expect(redGame.scrimmageSquad).toBe('X');
    expect(blueGame.scrimmageSquad).toBe('Y');
    expect(redGame.opponent).toBe('Blue');
    expect(blueGame.opponent).toBe('Red');
    for (const [g, names] of [[redGame, red], [blueGame, blue]] as const) {
      const full = await (await page.request.get(`${BACKEND_URL}/api/games/${g.game_id}`, { headers: coachHeaders(COACH) })).json();
      expect(full.rosterSnapshot.players.map((p: any) => p.name).sort()).toEqual(names);
      expect(full.alternateGenderRatio).toBe('No');
    }
    expect(redGame.game_id).not.toBe(blueGame.game_id);

    // Play a point for Red: on offense, Red scores.
    await selectAllPlayers(page);
    await startPoint(page);
    await weScoreWithAttribution(page, red[0], red[1]);
    await expectScore(page, 1, 0);
    await leaveGame(page);

    // ── The team card: one scrimmage, no games, both squads listed ──
    await expect
      .poll(async () => {
        const resp = await page.request.get(`${BACKEND_URL}/api/games/${redGame.game_id}`, { headers: coachHeaders(COACH) });
        return resp.ok() ? (await resp.json()).scores?.team : -1;
      }, { timeout: 20_000, intervals: [250] })
      .toBe(1);
    await goToTeams(page);   // a fresh load lists what the server has
    await expandCard(page);
    await expect(card(page).locator('.game-count')).toHaveText('0 games · 1 scrimmage');
    const scrimCard = card(page).locator('.scrimmage-container');
    await expect(scrimCard).toHaveCount(1);
    await expect(scrimCard.locator('.scrimmage-squad-name')).toHaveText(['Red', 'Blue']);
    await expect(scrimCard.locator('.scrimmage-score')).toHaveText('Red 1 – 0 Blue');
    await expect(card(page).locator('.games-list .game-item:not(.scrimmage-squad-item)')).toHaveCount(0);

    // ── Track Blue: the other half fields the other players ──
    await scrimCard.locator('.scrimmage-squad-item', { hasText: 'Blue' }).locator('.game-join-btn', { hasText: 'Track' }).click();
    await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#headerTeamUs')).toHaveText('Blue');
    expect(await lineTabNames(page)).toEqual(blue);
    // Blue's own score is still 0–0: each coach records their squad's game.
    await expectScore(page, 0, 0);
    await leaveGame(page);

    // ── Scrimmage stats: both halves together ──
    await expandCard(page);
    await card(page).locator('.scrimmage-container .event-header-btn', { hasText: 'Stats' }).click();
    await expect(page.locator('#scrimmageStatsScreen')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#scrimmageStatsHeader')).toContainText(`${TEAM} — Scrimmages — Scrimmage`);
    await expect(page.locator('#scrimmageStatsNote')).toHaveText(/1 scrimmage, 2 squad-games/, { timeout: 15_000 });
    // Everyone on a squad is listed (Jake sat out); the scorers have their point.
    const statsRows = page.locator('#scrimmageStatsList tr:not(:first-child):not(.team-aggregate-row)');
    await expect(statsRows).toHaveCount(ROSTER.length - 1);
    await expect(page.locator('#scrimmageStatsList')).not.toContainText('Jake');
    const scorerRow = statsRows.filter({ hasText: red[1] });
    const goalsIdx = (await page.locator('#scrimmageStatsList tr:first-child th').allTextContents()).indexOf('Goals');
    expect(goalsIdx).toBeGreaterThan(0);
    await expect(scorerRow.locator('td').nth(goalsIdx)).toHaveText('1');
    await expect(page.locator('#scrimmageStatsList .team-aggregate-row')).toHaveCount(1);
    await expect(page.locator('#exportScrimmageStatsBtn')).toBeVisible();
    await expect(page.locator('#scrimmageScopeFilter option')).toHaveCount(2);

    // The team-header entry point opens the same screen across all scrimmages.
    await page.click('#backFromScrimmageStatsBtn');
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await card(page).locator('.team-scrimmages-btn').click();
    await expect(page.locator('#scrimmageStatsScreen')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#scrimmageScopeFilter')).toHaveValue('');
    await expect(page.locator('#scrimmageStatsHeader')).toHaveText(`${TEAM} — Scrimmages`);
    await page.click('#backFromScrimmageStatsBtn');

    // ── Delete removes both halves ──
    await expandCard(page);
    page.once('dialog', d => d.accept());
    await card(page).locator('.scrimmage-container .event-header-btn[title^="Delete"]').click();
    await expect(card(page).locator('.scrimmage-container')).toHaveCount(0, { timeout: 15_000 });
    await serverScrimmageGames(page, 0);
    await expect(card(page).locator('.game-count')).toHaveText('0 games');
  });
});
