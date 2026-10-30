/**
 * The Stat Keeper membership role (store/roles.js; server side
 * breakside_server/storage/membership_storage.py).
 *
 * A coach invites a stat keeper to a team with a game in progress. On the
 * stat keeper's phone the team card must offer what it takes to record the
 * game — Join, New Game — and nothing administrative: no team settings gear,
 * no New Event, no delete-game trash. Joining the game puts them on the
 * tracking screen (not the viewer's spectating log), and a point they record
 * reaches the server. Team Settings, if they open it, shows no invite or
 * email-list sections. The server refuses an invite minted by them.
 *
 * The backend runs with auth disabled in this suite, but the role checks
 * themselves still read the membership, so the 403 is real.
 */
import { test, expect, Page } from '@playwright/test';
import { BACKEND_URL, TEST_PARAMS } from '../helpers/constants';
import {
  setupTeamWithPlayers, startGame, selectAllPlayers, startPoint, weScoreSkip, expectScore,
} from '../helpers/app';
import { coachHeaders, waitForGameOnServer, waitForRolesVacant } from '../helpers/controllerApi';

const COACH = 'keeper-spec-coach';
const KEEPER = 'keeper-spec-keeper';
const TEAM = 'Keeper Spec Team';

test.describe.configure({ timeout: 120_000 });

async function openApp(page: Page, userId: string) {
  await page.goto(`/?${TEST_PARAMS}&testUserId=${userId}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
}

function card(page: Page, name: string) {
  return page.locator('#cloudTeamsList .team-section', {
    has: page.locator('.team-header-name', { hasText: name }),
  });
}

async function getGameId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const game = (window as any).currentGame?.() || (window as any).currentGame;
    return typeof game === 'function' ? game()?.id : game?.id;
  });
}

test('a stat keeper records games but administers nothing', async ({ page, browser, request }) => {
  // ── Coach: team, roster, a game in progress ──
  await openApp(page, COACH);
  await setupTeamWithPlayers(page, TEAM);
  await startGame(page, 'offense', 'Scrimmage Blue');
  const gameId = await getGameId(page);
  await waitForGameOnServer(request, gameId, COACH);

  const teamsResp = await request.get(`${BACKEND_URL}/api/auth/teams`, { headers: coachHeaders(COACH) });
  const teamEntry = (await teamsResp.json()).teams.find((t: any) => t.team?.name === TEAM);
  expect(teamEntry, 'the coach’s team is listed with a role').toBeTruthy();
  expect(teamEntry.role).toBe('coach');
  const teamId = teamEntry.team.id as string;

  // The coach mints a stat keeper invite: single-use, like a coach's.
  const inviteResp = await request.post(`${BACKEND_URL}/api/teams/${teamId}/invites`, {
    headers: coachHeaders(COACH), data: { role: 'statkeeper' },
  });
  expect(inviteResp.ok(), await inviteResp.text()).toBe(true);
  const invite = await inviteResp.json();
  expect(invite.invite.role).toBe('statkeeper');
  expect(invite.invite.maxUses).toBe(1);

  // The injured player redeems it.
  const redeem = await request.post(`${BACKEND_URL}/api/invites/${invite.code}/redeem`, {
    headers: coachHeaders(KEEPER),
  });
  expect(redeem.ok(), await redeem.text()).toBe(true);
  expect((await redeem.json()).membership.role).toBe('statkeeper');

  // The coach puts the phone down: their controller roles lapse so the
  // stat keeper is the solo recorder once they join (no handoff to drive).
  await page.close();
  await waitForRolesVacant(request, gameId, KEEPER);

  // ── Stat keeper's phone ──
  const phone = await (await browser.newContext()).newPage();
  await openApp(phone, KEEPER);
  const c = card(phone, TEAM);
  await expect(c).toBeVisible({ timeout: 15_000 });

  await expect(c.locator('.role-badge')).toHaveText(/Stat Keeper/);
  await expect(c.locator('.team-settings-btn'), 'no team settings gear').toHaveCount(0);
  await expect(c.locator('[title="Erase team permanently"]'), 'no erase-team trash').toHaveCount(0);

  // The card opens on its own when it is the only team; open it if not.
  const joinBtn = c.locator('.game-item .game-join-btn', { hasText: 'Join' });
  if (!(await joinBtn.isVisible())) await c.locator('.team-header').click();
  await expect(joinBtn, 'an in-progress game is joinable, not merely watchable').toBeVisible();
  await expect(c.locator('.game-item .game-join-btn', { hasText: 'Watch' })).toHaveCount(0);
  await expect(c.locator('.game-item [title="Delete Game"]'), 'no delete-game trash').toHaveCount(0);
  await expect(c.locator('.new-game-btn', { hasText: 'New Game' })).toBeVisible();
  await expect(c.locator('.new-scrimmage-btn')).toBeVisible();
  await expect(c.locator('.new-event-btn'), 'events are a coach’s').toHaveCount(0);

  // ── Join and record a point ──
  await joinBtn.click();
  await expect(phone.locator('.game-screen-container')).toBeVisible({ timeout: 10_000 });
  await expect(phone.locator('.spectating-badge'), 'not the viewer layout').toHaveCount(0);
  await selectAllPlayers(phone);
  await startPoint(phone);
  await weScoreSkip(phone);
  await expectScore(phone, 1, 0);

  await expect
    .poll(async () => {
      const resp = await request.get(`${BACKEND_URL}/api/games/${gameId}`, { headers: coachHeaders(KEEPER) });
      if (!resp.ok()) return `http ${resp.status()}`;
      return (await resp.json()).scores?.team;
    }, { message: 'the stat keeper’s point should sync to the server', timeout: 15_000 })
    .toBe(1);

  // Game menu: no Share Game (a share link is the team's to publish).
  await phone.click('#gameMenuBtn');
  await expect(phone.locator('#gameMenuDropdown')).toBeVisible();
  await expect(phone.locator('#menuShareGame')).toBeHidden();
  await expect(phone.locator('#menuEndGame')).toBeVisible();
  await phone.keyboard.press('Escape');

  // ── Team Settings: members yes, invites and email lists no ──
  await phone.evaluate(async () => {
    const m = await import('/teams/teamSettings.js');
    (window as any).hideGameScreen?.();
    m.showTeamSettingsScreen('gameScreen');
  });
  await expect(phone.locator('#teamSettingsScreen')).toBeVisible();
  await expect(phone.locator('#membersList')).toContainText('Stat Keeper', { timeout: 10_000 });
  await expect(phone.locator('#createCoachInviteBtn')).toBeHidden();
  await expect(phone.locator('#createStatKeeperInviteBtn')).toBeHidden();
  await expect(phone.locator('#openTeamMailBtn')).toBeHidden();

  // ── And the server, not just the screen, says no ──
  const asKeeper = await request.post(`${BACKEND_URL}/api/teams/${teamId}/invites`, {
    headers: coachHeaders(KEEPER), data: { role: 'viewer' },
  });
  expect(asKeeper.status()).toBe(403);
  const mail = await request.get(`${BACKEND_URL}/api/teams/${teamId}/mail`, { headers: coachHeaders(KEEPER) });
  expect(mail.status()).toBe(403);
  const members = await request.get(`${BACKEND_URL}/api/teams/${teamId}/members`, { headers: coachHeaders(KEEPER) });
  expect(members.ok()).toBe(true);
  const coachRow = (await members.json()).members.find((m: any) => m.userId === COACH);
  expect(coachRow, 'the coach is listed').toBeTruthy();
  expect(coachRow.email, 'but not with an email address').toBeUndefined();
});
