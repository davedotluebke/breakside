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
 *   together → End Scrimmage ends both halves and bounces a coach still
 *   tracking one → delete removes both games.
 *
 * The pure rules (dealing, grouping, scores) are pinned in
 * tests/unit/scrimmage.test.mjs; this is about the wiring between the dialog,
 * the two Game objects, the server, the team list and the game screen.
 */
import { test, expect, Page } from '@playwright/test';
import { TEST_PARAMS, BACKEND_URL, FRONTEND_URL } from '../helpers/constants';
import {
  createTeam, openEditRoster, addPlayer, backToStartGame,
  selectAllPlayers, startPoint, weScoreWithAttribution, expectScore,
} from '../helpers/app';
import { coachHeaders } from '../helpers/controllerApi';

// Own test user, so other specs' teams never show up in this list. "Test" in
// the team name makes the app skip its leave / delete confirms (isTestTeam).
const COACH = 'scrimmage-coach';
// Reassigned per test attempt (see uniqueTeamName); the helpers below read it
// at call time, so their defaults follow.
let TEAM = 'Scrimmage Test Team';

/**
 * A team name nobody has used on this backend yet. Nothing deletes a test's
 * team, so a retry would otherwise find the previous attempt's team of the
 * same name and the card locator would match two sections. "Test" stays in
 * the name: it is what makes the app skip the leave / delete confirms.
 */
function uniqueTeamName(base: string) {
  return `${base} ${Date.now().toString(36)}`;
}

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

async function goToTeams(page: Page, coach = COACH) {
  await page.goto(`/?${TEST_PARAMS}&testUserId=${coach}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
}

function card(page: Page, team = TEAM) {
  return page.locator('#cloudTeamsList .team-section', {
    has: page.locator('.team-header-name', { hasText: team }),
  });
}

/** The card's games container is collapsible; open it if it is closed. */
async function expandCard(page: Page, team = TEAM) {
  await expect(card(page, team)).toBeVisible({ timeout: 15_000 });
  const container = card(page, team).locator('.team-games-container');
  if (!(await container.isVisible())) {
    await card(page, team).locator('.team-header').click();
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

/** The server's id for one of this coach's teams, once its first sync has landed. */
async function serverTeamId(page: Page, coach: string, teamName: string): Promise<string> {
  let id = '';
  await expect
    .poll(
      async () => {
        const resp = await page.request.get(`${BACKEND_URL}/api/auth/teams`, { headers: coachHeaders(coach) });
        if (!resp.ok()) return '';
        const entry = ((await resp.json()).teams || []).find((t: any) => t.team?.name === teamName);
        id = entry?.team?.id || '';
        return id;
      },
      { message: `team "${teamName}" never reached the server`, timeout: 20_000, intervals: [250] },
    )
    .not.toBe('');
  return id;
}

/**
 * This test team's squad-games on the server, once the sync queue has landed
 * them. Filtered by team id, not squad name: earlier attempts' teams stay on
 * the backend, and their halves carry the same names.
 */
async function serverScrimmageGames(page: Page, expectCount: number, coach = COACH, teamName = TEAM) {
  const teamId = await serverTeamId(page, coach, teamName);
  let games: any[] = [];
  await expect
    .poll(
      async () => {
        const resp = await page.request.get(`${BACKEND_URL}/api/games`, { headers: coachHeaders(coach) });
        if (!resp.ok()) return -1;
        games = (await resp.json()).games.filter((g: any) => g.teamId === teamId && g.scrimmageId);
        return games.length;
      },
      { message: 'the two squad-games never reached the server', timeout: 20_000, intervals: [250] },
    )
    .toBe(expectCount);
  return games;
}

/** One game's stored document. */
async function serverGame(page: Page, gameId: string, coach: string) {
  const resp = await page.request.get(`${BACKEND_URL}/api/games/${gameId}`, { headers: coachHeaders(coach) });
  expect(resp.ok(), `GET game ${gameId}`).toBeTruthy();
  return resp.json();
}

/** Poll until a squad-game's stored snapshot lists exactly these players. */
async function expectServerSquad(page: Page, gameId: string, coach: string, names: string[]) {
  await expect
    .poll(
      async () => {
        const doc = await serverGame(page, gameId, coach);
        return (doc.rosterSnapshot?.players || []).map((p: any) => p.name).sort();
      },
      { message: `the server never showed squad ${names.join(',')} on ${gameId}`, timeout: 20_000, intervals: [250] },
    )
    .toEqual([...names].sort());
}

test.describe('intrasquad scrimmage', () => {
  test('create, track one squad, track the other, review stats, end, delete', async ({ page, browser }) => {
    TEAM = uniqueTeamName('Scrimmage Test Team');
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
    // The scrimmage sits in the card's Scrimmages group, a collapsible card
    // like an event's; the group and its newest scrimmage start open.
    await expect
      .poll(async () => {
        const resp = await page.request.get(`${BACKEND_URL}/api/games/${redGame.game_id}`, { headers: coachHeaders(COACH) });
        return resp.ok() ? (await resp.json()).scores?.team : -1;
      }, { timeout: 20_000, intervals: [250] })
      .toBe(1);
    await goToTeams(page);   // a fresh load lists what the server has
    await expandCard(page);
    await expect(card(page).locator('.game-count')).toHaveText('0 games · 1 scrimmage');
    const group = card(page).locator('.scrimmages-group');
    await expect(group).toHaveCount(1);
    await expect(group).not.toHaveClass(/collapsed/);
    await expect(group.locator(':scope > .event-header .event-name')).toHaveText('Scrimmages (1)');
    const scrimCard = card(page).locator('.scrimmage-container');
    await expect(scrimCard).toHaveCount(1);
    await expect(scrimCard).not.toHaveClass(/collapsed/);
    await expect(scrimCard.locator('.scrimmage-squad-name')).toHaveText(['Red', 'Blue']);
    await expect(scrimCard.locator('.scrimmage-score')).toHaveText('Red 1 – 0 Blue');
    await expect(scrimCard.locator('.scrimmage-end-btn')).toBeVisible();
    await expect(card(page).locator('.games-list .game-item:not(.scrimmage-squad-item)')).toHaveCount(0);

    // Tapping the group's top row folds it to one line and back; the choice
    // survives the list's periodic redraw (store/teamListGroups.js).
    await group.locator(':scope > .event-header .event-header-top').click();
    await expect(group).toHaveClass(/collapsed/);
    await expect(scrimCard).toBeHidden();
    await group.locator(':scope > .event-header .event-header-top').click();
    await expect(group).not.toHaveClass(/collapsed/);
    await expect(scrimCard).toBeVisible();

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

    // The team header's Scrimmages button opens the card's Scrimmages group
    // in place (folded shut here first, to prove it); the group's own
    // Scrimmage stats button is the all-scrimmages screen.
    await page.click('#backFromScrimmageStatsBtn');
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await expandCard(page);
    await card(page).locator('.scrimmages-group > .event-header .event-header-top').click();
    await expect(card(page).locator('.scrimmages-group')).toHaveClass(/collapsed/);
    await card(page).locator('.team-scrimmages-btn').click();
    await expect(card(page).locator('.scrimmages-group')).not.toHaveClass(/collapsed/);
    await expect(page.locator('#scrimmageStatsScreen')).toBeHidden();
    await card(page).locator('.scrimmages-stats-btn').click();
    await expect(page.locator('#scrimmageStatsScreen')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#scrimmageScopeFilter')).toHaveValue('');
    await expect(page.locator('#scrimmageStatsHeader')).toHaveText(`${TEAM} — Scrimmages`);
    await page.click('#backFromScrimmageStatsBtn');
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });

    // ── End Scrimmage ends both halves, under a coach still tracking one ──
    // A second phone (same coach account) tracks Red. The card's End
    // Scrimmage stamps both games on the server by a metadata PATCH; the
    // tracking phone's next refresh sends it back to the team list.
    const phone2 = await (await browser.newContext()).newPage();
    await phone2.goto(`${FRONTEND_URL}/?${TEST_PARAMS}&testUserId=${COACH}`);
    await expect(phone2.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await expandCard(phone2);
    await card(phone2).locator('.scrimmage-squad-item', { hasText: 'Red' }).locator('.game-join-btn', { hasText: 'Track' }).click();
    await expect(phone2.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });
    await expect(phone2.locator('#headerTeamUs')).toHaveText('Red');

    await expandCard(page);
    page.once('dialog', d => d.accept());
    await card(page).locator('.scrimmage-end-btn').click();
    await expect(card(page).locator('.scrimmage-container')).toHaveClass(/scrimmage-over/, { timeout: 10_000 });
    await expect(card(page).locator('.scrimmage-end-btn')).toHaveCount(0);
    await expect(card(page).locator('.scrimmage-squad-item .game-join-btn')).toHaveText(['Review', 'Review']);
    for (const g of [redGame, blueGame]) {
      await expect
        .poll(async () => (await serverGame(page, g.game_id, COACH)).gameEndTimestamp || null,
          { message: `${g.team}'s half never ended on the server`, timeout: 20_000, intervals: [250] })
        .toBeTruthy();
    }
    // Red's score survived the end (the PATCH touches nothing else).
    expect((await serverGame(page, redGame.game_id, COACH)).scores.team).toBe(1);

    await expect(phone2.locator('#toastContainer')).toContainText('Game has ended', { timeout: 30_000 });
    await expect(phone2.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await phone2.context().close();

    // ── Delete removes both halves ──
    await expandCard(page);
    page.once('dialog', d => d.accept());
    await card(page).locator('.scrimmage-container .event-header-btn[title^="Delete"]').click();
    await expect(card(page).locator('.scrimmage-container')).toHaveCount(0, { timeout: 15_000 });
    await serverScrimmageGames(page, 0);
    await expect(card(page).locator('.game-count')).toHaveText('0 games');
  });

  /**
   * Squads change after creation (store/scrimmage.js § editing squads):
   *   in-game Edit Squads → move a player, add a late arrival from the dialog,
   *   save → the Line tab and both halves' snapshots follow → another coach
   *   PATCHes this squad mid-point → toast, header, Line tab follow while the
   *   point on the field keeps its line → the card's Squads button relabels.
   */
  test('edit squads after creation: from the game, from another coach, from the card', async ({ page }) => {
    const EDITOR = 'scrimmage-editor';
    const EDIT_TEAM = uniqueTeamName('Scrimmage Edit Test Team');

    await goToTeams(page, EDITOR);
    await createTeam(page, EDIT_TEAM);
    await openEditRoster(page);
    for (const p of ROSTER) await addPlayer(page, p.name, p.number, p.gender);
    await backToStartGame(page);
    await page.click('#backFromStartGameBtn');
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });

    await expandCard(page, EDIT_TEAM);
    await card(page, EDIT_TEAM).locator('.new-scrimmage-btn').click();
    const modal = page.locator('#newScrimmageModal');
    await expect(modal.locator('#scrimmagePickerBody tr[data-player-id]')).toHaveCount(ROSTER.length);
    await modal.locator('#scrimmageSquadNameX').fill('Red');
    await modal.locator('#scrimmageSquadNameY').fill('Blue');
    await modal.locator('.scrimmage-pull-btn[data-squad="Y"]').click();   // Red starts on offense
    let squads = await dialogSquads(page);
    const red = [...squads.X].sort();
    const blue = [...squads.Y].sort();
    await modal.locator('#scrimmageStartX').click();
    await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 8_000 });
    const games = await serverScrimmageGames(page, 2, EDITOR, EDIT_TEAM);
    const redGame = games.find(g => g.team === 'Red');
    const blueGame = games.find(g => g.team === 'Blue');

    // ── In-game: Edit Squads on the menu (a scrimmage half only) ──
    await page.click('#gameMenuBtn');
    await expect(page.locator('#gameMenuDropdown')).toBeVisible();
    await expect(page.locator('#menuEditSquads')).toBeVisible();
    await page.click('#menuEditSquads');
    const edit = page.locator('#editSquadsModal');
    await expect(edit).toBeVisible();
    await expect(edit.locator('#scrimmagePickerBody tr[data-player-id]')).toHaveCount(ROSTER.length);
    await expect(edit.locator('#scrimmageSquadNameX')).toHaveValue('Red');
    await expect(edit.locator('#scrimmageSquadNameY')).toHaveValue('Blue');
    squads = await dialogSquads(page);
    expect([...squads.X].sort()).toEqual(red);
    expect([...squads.Y].sort()).toEqual(blue);

    // Move one Red player to Blue.
    const mover = red[0];
    await edit.locator('#scrimmagePickerBody tr', { hasText: mover }).locator('.scrimmage-pick[data-squad="Y"]').click();

    // A late arrival, added without leaving the dialog: lands sitting out,
    // then one tap puts them on Red.
    await edit.locator('#scrimmageNewPlayerName').fill('Kris');
    await edit.locator('#scrimmageNewPlayerNumber').fill('21');
    await edit.locator('#scrimmageAddMMPBtn').click();
    const krisRow = edit.locator('#scrimmagePickerBody tr', { hasText: 'Kris' });
    await expect(krisRow).toHaveClass(/scrimmage-sitting-out/);
    await expect(edit.locator('#scrimmageSitting')).toHaveText('1 sitting out');
    await expect(edit.locator('#scrimmageNewPlayerName')).toHaveValue('');
    await krisRow.locator('.scrimmage-pick[data-squad="X"]').click();

    const redAfter = [...red.filter(n => n !== mover), 'Kris'].sort();
    const blueAfter = [...blue, mover].sort();
    squads = await dialogSquads(page);
    expect([...squads.X].sort()).toEqual(redAfter);
    expect([...squads.Y].sort()).toEqual(blueAfter);
    expect(squads.out).toEqual([]);

    await edit.locator('#scrimmageSaveBtn').click();
    await expect(edit).toHaveCount(0);
    await expect(page.locator('#toastContainer')).toContainText('Squads saved', { timeout: 5_000 });
    await expect(page.locator('#toastContainer')).toContainText('Kris joined Red');
    await expect(page.locator('#toastContainer')).toContainText(`${mover} left`);
    // This game fields the new squad at once; both halves' snapshots follow on the server.
    expect(await lineTabNames(page)).toEqual(redAfter);
    await expectServerSquad(page, redGame.game_id, EDITOR, redAfter);
    await expectServerSquad(page, blueGame.game_id, EDITOR, blueAfter);
    const blueDoc = await serverGame(page, blueGame.game_id, EDITOR);
    expect(blueDoc.team).toBe('Blue');
    expect(blueDoc.opponent).toBe('Red');
    expect(blueDoc.points).toEqual([]);
    // Kris is a real roster player on the server too, not just a snapshot
    // entry — once the queued player and team syncs land (the squad PATCH
    // went straight through; those ride the sync queue).
    await expect
      .poll(
        async () => {
          const resp = await page.request.get(`${BACKEND_URL}/api/teams/${redGame.teamId}/players`, { headers: coachHeaders(EDITOR) });
          return resp.ok() ? (await resp.json()).players.map((p: any) => p.name) : [];
        },
        { message: 'Kris never reached the server roster', timeout: 20_000, intervals: [250] },
      )
      .toContain('Kris');

    // ── Another coach edits this squad mid-point ──
    // Start a point with the whole squad on the field, then PATCH the half
    // the way another phone's Edit Squads would: one on-field player moves to
    // Blue, and the squads are renamed.
    await selectAllPlayers(page);
    await startPoint(page);
    const onField: string[] = await page.evaluate(() => (window as any).currentGame().points.at(-1).players);
    expect(onField.length).toBe(redAfter.length);

    const redDoc = await serverGame(page, redGame.game_id, EDITOR);
    const idOf = new Map<string, string>();
    for (const doc of [redDoc, blueDoc]) {
      for (const p of doc.rosterSnapshot.players) idOf.set(p.name, p.id);
    }
    const mover2 = redAfter.find(n => n !== 'Kris')!;
    const redFinal = redAfter.filter(n => n !== mover2);
    const patch = await page.request.patch(`${BACKEND_URL}/api/games/${redGame.game_id}/scrimmage`, {
      headers: coachHeaders(EDITOR),
      data: {
        rosterSnapshot: {
          players: redFinal.map(n => ({ id: idOf.get(n), name: n })),
          capturedAt: new Date().toISOString(),
        },
        team: 'Crimson',
        opponent: 'Navy',
      },
    });
    expect(patch.ok()).toBeTruthy();

    // The tracking phone adopts it on its next refresh: a toast that says
    // what changed (and that the live point keeps its line), the header and
    // the Line tab (the next point) follow; the point on the field does not.
    await expect(page.locator('#toastContainer')).toContainText('Squads updated', { timeout: 20_000 });
    await expect(page.locator('#toastContainer')).toContainText(`${mover2} left`);
    await expect(page.locator('#toastContainer')).toContainText('Red is now Crimson');
    await expect(page.locator('#toastContainer')).toContainText('keeps its line');
    await expect(page.locator('#headerTeamUs')).toHaveText('Crimson');
    await expect(page.locator('#headerTeamThem')).toHaveText('Navy');
    // Start Point moved the coach to the Simple tab (2.7.2); the Line tab
    // holds the next point's table.
    await page.locator('#headerSegControl button[data-tab="line"]').click();
    expect(await lineTabNames(page)).toEqual([...redFinal].sort());
    const stillOnField: string[] = await page.evaluate(() => (window as any).currentGame().points.at(-1).players);
    expect(stillOnField).toEqual(onField);
    // …and the edit survives this phone's own full syncs (it is the Active Coach).
    await page.locator('#headerSegControl button[data-tab="simple"]').click();
    await weScoreWithAttribution(page, mover2, redFinal[0]);
    await expectScore(page, 1, 0);
    await expect
      .poll(async () => (await serverGame(page, redGame.game_id, EDITOR)).scores?.team, { timeout: 20_000, intervals: [250] })
      .toBe(1);
    const synced = await serverGame(page, redGame.game_id, EDITOR);
    expect(synced.rosterSnapshot.players.map((p: any) => p.name).sort()).toEqual([...redFinal].sort());
    expect(synced.team).toBe('Crimson');
    expect(synced.opponent).toBe('Navy');
    await leaveGame(page);

    // ── From the card: the Squads button, a relabel ──
    await goToTeams(page, EDITOR);   // a fresh load lists what the server has
    await expandCard(page, EDIT_TEAM);
    const scrimCard = card(page, EDIT_TEAM).locator('.scrimmage-container');
    // The API-side edit touched Red's half only (the dialog patches both), so
    // Blue's game still calls itself Blue and the card reads each half's own
    // name: the honest state of an inconsistent pair.
    await expect(scrimCard.locator('.scrimmage-squad-name')).toHaveText(['Crimson', 'Blue']);
    await scrimCard.locator('.scrimmage-edit-btn').click();
    const edit2 = page.locator('#editSquadsModal');
    await expect(edit2).toBeVisible();
    await expect(edit2.locator('#scrimmagePickerBody tr[data-player-id]')).toHaveCount(ROSTER.length + 1);
    await expect(edit2.locator('#scrimmageSquadNameX')).toHaveValue('Crimson');
    await expect(edit2.locator('#scrimmageSquadNameY')).toHaveValue('Blue');
    squads = await dialogSquads(page);
    expect([...squads.X].sort()).toEqual([...redFinal].sort());
    // Blue's game was never told about the API-side move either: the dialog
    // shows the halves as they are (mover2 is on neither).
    expect([...squads.Y].sort()).toEqual(blueAfter);
    expect(squads.out).toEqual([mover2]);
    await edit2.locator('#newScrimmageName').fill('Tuesday practice');
    await edit2.locator('#scrimmageSaveBtn').click();
    await expect(edit2).toHaveCount(0);
    await expect(card(page, EDIT_TEAM).locator('.scrimmage-name')).toContainText('Tuesday practice', { timeout: 15_000 });
    // Both halves carry the label, and the save healed the pair's names: each
    // half's opponent is the other's name again.
    const relabelled = await serverGame(page, blueGame.game_id, EDITOR);
    expect(relabelled.scrimmageName).toBe('Tuesday practice');
    expect(relabelled.team).toBe('Blue');
    expect(relabelled.opponent).toBe('Crimson');
    const healed = await serverGame(page, redGame.game_id, EDITOR);
    expect(healed.scrimmageName).toBe('Tuesday practice');
    expect(healed.team).toBe('Crimson');
    expect(healed.opponent).toBe('Blue');
  });
});
