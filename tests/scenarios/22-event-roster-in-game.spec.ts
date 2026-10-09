/**
 * Event roster edited during an event game (teams/eventRoster.js,
 * game/gameScreenEvents.js openEventRosterFromGame, game/gameScreenSync.js).
 *
 * The weekend bug this pins: players unchecked from an event roster, then
 * re-checked when they turned up on Day 2, never showed on the Line tab —
 * the game fielded whatever copy of the event the device held. Now the
 * in-game menu has Event Roster + Stats for an event game, and what it
 * saves is what the Line tab offers from the next point:
 *   New Event → New Event Game → the Line tab lists the roster → uncheck a
 *   player in-game and save → gone from the Line tab, gone from the server's
 *   event → open again, Back without saving changes nothing → re-check them
 *   and add a pickup → both on the Line tab, both on the server; the game's
 *   snapshot grew to list the pickup (Review lists the snapshot).
 * The menu item stays hidden in a game outside an event.
 */
import { test, expect, Page } from '@playwright/test';
import { TEST_PARAMS, BACKEND_URL } from '../helpers/constants';
import {
  createTeam, openEditRoster, addPlayer, backToStartGame, startGame,
} from '../helpers/app';
import { coachHeaders } from '../helpers/controllerApi';

// Own test user, so other specs' teams never show up in this list. "Test" in
// the team name makes the app skip its leave / delete confirms (isTestTeam).
const COACH = 'event-roster-coach';
let TEAM = 'Event Roster Test Team';
const EVENT = 'Fall Test Classic';

const ROSTER = [
  { name: 'Alice', number: '7', gender: 'FMP' as const },
  { name: 'Bob', number: '11', gender: 'MMP' as const },
  { name: 'Charlie', number: '3', gender: 'MMP' as const },
  { name: 'Dana', number: '22', gender: 'FMP' as const },
];

test.describe.configure({ timeout: 120_000 });

/** A team name nobody has used on this backend yet (a retry would find the
 *  previous attempt's team of the same name). */
function uniqueTeamName(base: string) {
  return `${base} ${Date.now().toString(36)}`;
}

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

/** The event's group card on the team card, opened if it is collapsed. */
async function eventCard(page: Page) {
  const ev = card(page).locator('.event-container', {
    has: page.locator('.event-name', { hasText: EVENT }),
  });
  await expect(ev).toBeVisible({ timeout: 15_000 });
  if (await ev.evaluate(el => el.classList.contains('collapsed'))) {
    await ev.locator('.event-header-top').click();
  }
  await expect(ev.locator('.group-body')).toBeVisible();
  return ev;
}

/** The names on the Line tab: the players this game can field. */
async function lineTabNames(page: Page): Promise<string[]> {
  const table = page.locator('#panelActivePlayersTable');
  if (!(await table.isVisible())) {
    await page.click('#headerSegControl button[data-tab="line"]');
  }
  await expect(table).toBeVisible({ timeout: 8_000 });
  const boxes = table.locator('tbody input.active-checkbox');
  await expect(boxes.first()).toBeAttached({ timeout: 8_000 });
  const names = await boxes.evaluateAll(els => els.map(e => (e as HTMLElement).dataset.playerName || ''));
  return names.sort();
}

/** Open Event Roster + Stats from the in-game menu. */
async function openEventRosterFromMenu(page: Page) {
  await page.click('#gameMenuBtn');
  await expect(page.locator('#gameMenuDropdown')).toBeVisible();
  await expect(page.locator('#menuEventRoster')).toBeVisible();
  await page.click('#menuEventRoster');
  await expect(page.locator('#eventRosterScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#eventRosterHeader')).toContainText(EVENT);
  // The table is drawn once the event's games have loaded.
  await expect(page.locator('#eventRosterList tr', { hasText: 'Alice' })).toBeVisible({ timeout: 10_000 });
}

function rosterRow(page: Page, name: string) {
  return page.locator('#eventRosterList tr', { hasText: name });
}

/** Save and land back in the game. */
async function saveAndReturn(page: Page) {
  await page.click('#saveEventRosterBtn');
  await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#eventRosterScreen')).toBeHidden();
}

async function serverEvent(page: Page, eventId: string) {
  const resp = await page.request.get(`${BACKEND_URL}/api/events/${eventId}`, { headers: coachHeaders(COACH) });
  expect(resp.ok(), `GET event ${eventId}`).toBeTruthy();
  return resp.json();
}

async function serverGame(page: Page, gameId: string) {
  const resp = await page.request.get(`${BACKEND_URL}/api/games/${gameId}`, { headers: coachHeaders(COACH) });
  return resp.ok() ? resp.json() : null;
}

test.describe('event roster from the in-game menu', () => {
  test('uncheck, re-check and add a pickup without leaving the game', async ({ page }) => {
    TEAM = uniqueTeamName('Event Roster Test Team');
    await goToTeams(page);
    await createTeam(page, TEAM);
    await openEditRoster(page);
    for (const p of ROSTER) await addPlayer(page, p.name, p.number, p.gender);
    await backToStartGame(page);
    await page.click('#backFromStartGameBtn');
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });

    // ── New Event, then a game inside it ──
    await expandCard(page);
    await card(page).locator('.new-event-btn').click();
    await expect(page.locator('#createEventModal')).toBeVisible();
    await page.fill('#newEventName', EVENT);
    await page.click('#createEventBtn');
    await expect(page.locator('#createEventModal')).toHaveCount(0, { timeout: 10_000 });

    const ev = await eventCard(page);
    await ev.locator('.event-new-game-btn').click();
    await expect(page.locator('#startGameSubscreen')).toBeVisible({ timeout: 10_000 });
    await startGame(page, 'offense');

    // The whole event roster (everyone, on a fresh event) is on the Line tab.
    expect(await lineTabNames(page)).toEqual(['Alice', 'Bob', 'Charlie', 'Dana']);
    const ids = await page.evaluate(() => {
      const g = (window as any).currentGame();
      return { gameId: g.id as string, eventId: g.eventId as string };
    });
    expect(ids.eventId).toBeTruthy();

    // ── Dana didn't make it: uncheck her from the game ──
    await openEventRosterFromMenu(page);
    await expect(rosterRow(page, 'Dana').locator('input[type="checkbox"]')).toBeChecked();
    await rosterRow(page, 'Dana').locator('input[type="checkbox"]').uncheck();
    await saveAndReturn(page);
    expect(await lineTabNames(page)).toEqual(['Alice', 'Bob', 'Charlie']);

    // The save reached the server before the game came back.
    let stored = await serverEvent(page, ids.eventId);
    const danaId = (stored.roster.playerIds as string[]).find(id => id.startsWith('Dana'));
    expect(danaId).toBeUndefined();
    expect((stored.roster.playerIds as string[]).length).toBe(3);

    // ── Back without saving changes nothing ──
    await openEventRosterFromMenu(page);
    await expect(rosterRow(page, 'Dana').locator('input[type="checkbox"]')).not.toBeChecked();
    await rosterRow(page, 'Dana').locator('input[type="checkbox"]').check();
    await page.click('#backFromEventRosterBtn');
    await expect(page.locator('.game-screen-container')).toBeVisible({ timeout: 10_000 });
    expect(await lineTabNames(page)).toEqual(['Alice', 'Bob', 'Charlie']);

    // ── Dana turned up after all, and Zed is playing with us today ──
    await openEventRosterFromMenu(page);
    await rosterRow(page, 'Dana').locator('input[type="checkbox"]').check();
    await page.fill('#eventNewPlayerInput', 'Zed');
    await page.fill('#eventNewPlayerNumberInput', '99');
    await page.click('#eventAddFMPBtn');
    await expect(page.locator('#eventRosterList tr', { hasText: /Zed \(99\) \(pickup\)/ })).toBeVisible();
    await saveAndReturn(page);
    expect(await lineTabNames(page)).toEqual(['Alice', 'Bob', 'Charlie', 'Dana', 'Zed']);

    stored = await serverEvent(page, ids.eventId);
    expect((stored.roster.playerIds as string[]).some(id => id.startsWith('Dana'))).toBeTruthy();
    expect((stored.roster.pickupPlayers as any[]).map(p => p.name)).toEqual(['Zed']);

    // The game's snapshot grew to list the pickup, and that reached the
    // server on the game's next sync (Review lists the snapshot).
    await expect
      .poll(
        async () => {
          const doc = await serverGame(page, ids.gameId);
          return (doc?.rosterSnapshot?.players || []).map((p: any) => p.name).sort();
        },
        { message: 'the grown snapshot never reached the server', timeout: 20_000, intervals: [250] },
      )
      .toEqual(['Alice', 'Bob', 'Charlie', 'Dana', 'Zed']);
  });

  test('the menu item is only offered in an event game', async ({ page }) => {
    TEAM = uniqueTeamName('Event Roster Test Team');
    await goToTeams(page);
    await createTeam(page, TEAM);
    await openEditRoster(page);
    await addPlayer(page, 'Alice', '7', 'FMP');
    await backToStartGame(page);
    await startGame(page, 'offense');

    await page.click('#gameMenuBtn');
    await expect(page.locator('#gameMenuDropdown')).toBeVisible();
    await expect(page.locator('#menuRoster')).toBeVisible();
    await expect(page.locator('#menuEventRoster')).toBeHidden();
  });

  test("another coach's roster edit reaches a coach already in the game", async ({ page }) => {
    TEAM = uniqueTeamName('Event Roster Test Team');
    await goToTeams(page);
    await createTeam(page, TEAM);
    await openEditRoster(page);
    await addPlayer(page, 'Alice', '7', 'FMP');
    await addPlayer(page, 'Bob', '11', 'MMP');
    await backToStartGame(page);
    await page.click('#backFromStartGameBtn');
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });

    await expandCard(page);
    await card(page).locator('.new-event-btn').click();
    await expect(page.locator('#createEventModal')).toBeVisible();
    await page.fill('#newEventName', EVENT);
    await page.click('#createEventBtn');
    await expect(page.locator('#createEventModal')).toHaveCount(0, { timeout: 10_000 });
    const ev = await eventCard(page);
    await ev.locator('.event-new-game-btn').click();
    await expect(page.locator('#startGameSubscreen')).toBeVisible({ timeout: 10_000 });
    await startGame(page, 'offense');
    expect(await lineTabNames(page)).toEqual(['Alice', 'Bob']);
    const ids = await page.evaluate(() => {
      const g = (window as any).currentGame();
      return { gameId: g.id as string, eventId: g.eventId as string };
    });

    // A second coach, on their own phone, takes Bob off the event roster and
    // adds Zed as a pickup — the same PUT the app's save makes.
    const stored = await serverEvent(page, ids.eventId);
    const edited = {
      ...stored,
      roster: {
        playerIds: (stored.roster.playerIds as string[]).filter(id => !id.startsWith('Bob')),
        pickupPlayers: [{ id: 'Zed-9999', name: 'Zed', gender: 'FMP', number: '99' }],
        overrides: {},
      },
    };
    const put = await page.request.put(`${BACKEND_URL}/api/events/${ids.eventId}`, {
      headers: coachHeaders('event-roster-coach-b'), data: edited,
    });
    expect(put.ok(), 'coach B saves the event').toBeTruthy();

    // The ping carries the event's stamp; the first one after the write has
    // this phone refetch the event and redraw the Line tab, no leaving the
    // game — and say what changed.
    await expect
      .poll(() => lineTabNames(page), { message: 'the Line tab never followed the edit', timeout: 20_000, intervals: [500] })
      .toEqual(['Alice', 'Zed']);
    await expect(page.locator('#toastContainer')).toContainText('Event roster updated: Zed added; Bob removed', { timeout: 5_000 });
  });
});
