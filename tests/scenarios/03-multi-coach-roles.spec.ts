/**
 * Multi-coach role management
 *
 * Tests the controller state system with two coaches:
 *   - Coach A drives the UI (creates team, starts game)
 *   - Coach B interacts via API (claims roles, triggers handoffs)
 *
 * Uses X-Test-User-Id header to distinguish coaches on the backend.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { BACKEND_URL, TEST_PARAMS } from '../helpers/constants';
import { setupTeamWithPlayers, startGame } from '../helpers/app';
import { waitForGameOnServer } from '../helpers/controllerApi';

// ─── API helpers for Coach B ────────────────────────────────────────────────

function coachHeaders(userId: string) {
  return {
    'Content-Type': 'application/json',
    'X-Test-User-Id': userId,
  };
}

async function pingAsCoach(request: APIRequestContext, gameId: string, userId: string) {
  return request.post(`${BACKEND_URL}/api/games/${gameId}/ping`, {
    headers: coachHeaders(userId),
  });
}

async function claimRole(
  request: APIRequestContext, gameId: string, userId: string,
  role: 'active' | 'line',
) {
  const endpoint = role === 'active' ? 'claim-active' : 'claim-line';
  return request.post(`${BACKEND_URL}/api/games/${gameId}/${endpoint}`, {
    headers: coachHeaders(userId),
  });
}

async function getControllerState(request: APIRequestContext, gameId: string, userId: string) {
  const resp = await request.get(`${BACKEND_URL}/api/games/${gameId}/controller`, {
    headers: coachHeaders(userId),
  });
  return resp.json();
}

async function respondHandoff(
  request: APIRequestContext, gameId: string, userId: string,
  accept: boolean,
) {
  return request.post(`${BACKEND_URL}/api/games/${gameId}/handoff-response`, {
    headers: coachHeaders(userId),
    data: { accept },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract the current game ID from the page's JS context. */
async function getGameId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const game = (window as any).currentGame?.() || (window as any).currentGame;
    return typeof game === 'function' ? game()?.id : game?.id;
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('multi-coach roles', () => {
  const COACH_A = 'coach-a';
  const COACH_B = 'coach-b';

  test('first coach auto-assigned both roles via ping', async ({ page, request }) => {
    // Coach A creates team and starts game
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Multi-Coach Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    expect(gameId).toBeTruthy();

    // Game creation is offline-first: the server 404s controller calls until
    // the app's queued first sync lands (can lag the UI by ~5s).
    await waitForGameOnServer(request, gameId, COACH_A);

    // Coach A pings — should auto-assign both roles
    const pingResp = await pingAsCoach(request, gameId, COACH_A);
    expect(pingResp.ok()).toBeTruthy();

    // Verify Coach A holds both roles
    const state = await getControllerState(request, gameId, COACH_A);
    expect(state.myRole).toBe('activeCoach');
    expect(state.state.activeCoach.userId).toBe(COACH_A);
    expect(state.state.lineCoach.userId).toBe(COACH_A);
  });

  test('second coach can claim vacant role after first releases', async ({ page, request }) => {
    // Coach A creates game
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Handoff Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH_A);

    // Coach A pings → gets both roles
    const pingResp = await pingAsCoach(request, gameId, COACH_A);
    expect(pingResp.ok()).toBeTruthy();

    // Coach A releases Line Coach role
    const releaseResp = await request.post(`${BACKEND_URL}/api/games/${gameId}/release`, {
      headers: coachHeaders(COACH_A),
      data: { role: 'lineCoach' },
    });
    expect(releaseResp.ok()).toBeTruthy();

    // Coach B claims Line Coach (now vacant)
    const claimResp = await claimRole(request, gameId, COACH_B, 'line');
    expect(claimResp.ok()).toBeTruthy();
    const claimData = await claimResp.json();
    expect(claimData.status).toBe('claimed');

    // Verify split roles
    const state = await getControllerState(request, gameId, COACH_A);
    expect(state.state.activeCoach.userId).toBe(COACH_A);
    expect(state.state.lineCoach.userId).toBe(COACH_B);
  });

  test('handoff request created when claiming occupied role', async ({ page, request }) => {
    // Coach A creates game and holds both roles
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Handoff Request Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH_A);
    const pingResp = await pingAsCoach(request, gameId, COACH_A);
    expect(pingResp.ok()).toBeTruthy();

    // Coach B tries to claim Active Coach (held by Coach A)
    const claimResp = await claimRole(request, gameId, COACH_B, 'active');
    expect(claimResp.ok()).toBeTruthy();
    const claimData = await claimResp.json();
    expect(claimData.status).toBe('handoff_requested');

    // Verify pending handoff exists
    const state = await getControllerState(request, gameId, COACH_A);
    expect(state.hasPendingHandoffForMe).toBe(true);
    expect(state.state.pendingHandoff).toBeTruthy();
    expect(state.state.pendingHandoff.requesterId).toBe(COACH_B);
    expect(state.state.pendingHandoff.role).toBe('activeCoach');
  });

  test('handoff accept transfers role', async ({ page, request }) => {
    // Coach A creates game and holds both roles
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Accept Handoff Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH_A);
    const pingResp = await pingAsCoach(request, gameId, COACH_A);
    expect(pingResp.ok()).toBeTruthy();

    // Coach B requests Active Coach — must land as a handoff request
    // (fail fast here rather than at the downstream state assertions)
    const claimResp = await claimRole(request, gameId, COACH_B, 'active');
    expect(claimResp.ok()).toBeTruthy();
    expect((await claimResp.json()).status).toBe('handoff_requested');

    // Coach A accepts the handoff
    const acceptResp = await respondHandoff(request, gameId, COACH_A, true);
    expect(acceptResp.ok()).toBeTruthy();

    // Verify role transferred
    const state = await getControllerState(request, gameId, COACH_B);
    expect(state.state.activeCoach.userId).toBe(COACH_B);
    expect(state.state.lineCoach.userId).toBe(COACH_A);
    expect(state.myRole).toBe('activeCoach');
  });

  test('holder page prompts on handoff; re-prompts after deny; silent takeover toasts', async ({ page, request }) => {
    // Pins the three G11.1 handoff-toast fixes (branch fix-handoff-toast):
    //  1. the holder's page shows the accept/deny prompt at all;
    //  2. a second request after a deny prompts again (the old boolean
    //     `handoffResolved` latch could suppress it entirely);
    //  3. losing a role WITHOUT having asked (external takeover — what a
    //     stale-expiry grab looks like to the holder's client) shows a
    //     "took over" toast instead of silently greying out.
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Handoff Prompt Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH_A);
    expect((await pingAsCoach(request, gameId, COACH_A)).ok()).toBeTruthy();

    // ── 1. Holder prompt appears ──
    const claim1 = await claimRole(request, gameId, COACH_B, 'active');
    expect((await claim1.json()).status).toBe('handoff_requested');
    const toast = page.locator('#handoffToast');
    await expect(toast).toBeVisible({ timeout: 6_000 }); // holder pings every 2s
    await expect(toast).toContainText('wants to take over');

    // Deny via the UI; server keeps the role with A and clears the handoff.
    await toast.locator('.deny-btn').click();
    await expect(toast).toBeHidden({ timeout: 3_000 });
    const afterDeny = await getControllerState(request, gameId, COACH_A);
    expect(afterDeny.state.activeCoach.userId).toBe(COACH_A);
    expect(afterDeny.state.pendingHandoff).toBeNull();

    // ── 2. A second request must prompt again (latch-deadlock regression) ──
    const claim2 = await claimRole(request, gameId, COACH_B, 'active');
    expect((await claim2.json()).status).toBe('handoff_requested');
    await expect(toast).toBeVisible({ timeout: 6_000 });
    // Accept this one via the UI: role transfers, and the DELIBERATE loss
    // must NOT fire the "took over" toast (suppression check below).
    await toast.locator('.accept-btn').click();
    await expect(toast).toBeHidden({ timeout: 3_000 });
    const afterAccept = await getControllerState(request, gameId, COACH_B);
    expect(afterAccept.state.activeCoach.userId).toBe(COACH_B);
    await page.waitForTimeout(2_500); // window in which a wrong loss toast would appear
    await expect(page.locator('.toast', { hasText: 'took over' })).toHaveCount(0);

    // ── 3. External takeover of A's remaining role (line) toasts the loss ──
    // Release-as-A + claim-as-B via API: A's client never initiated anything,
    // which is exactly how a stale-expiry takeover presents to it.
    const rel = await request.post(`${BACKEND_URL}/api/games/${gameId}/release`, {
      headers: coachHeaders(COACH_A),
      data: { role: 'lineCoach' },
    });
    expect(rel.ok()).toBeTruthy();
    expect((await claimRole(request, gameId, COACH_B, 'line')).ok()).toBeTruthy();
    await expect(page.locator('.toast', { hasText: 'took over Next Line' }))
      .toBeVisible({ timeout: 8_000 });
  });

  test('handoff deny keeps role with original holder', async ({ page, request }) => {
    // Coach A creates game and holds both roles
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Deny Handoff Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH_A);
    const pingResp = await pingAsCoach(request, gameId, COACH_A);
    expect(pingResp.ok()).toBeTruthy();

    // Coach B requests Active Coach — must land as a handoff request
    // (fail fast here rather than at the downstream state assertions)
    const claimResp = await claimRole(request, gameId, COACH_B, 'active');
    expect(claimResp.ok()).toBeTruthy();
    expect((await claimResp.json()).status).toBe('handoff_requested');

    // Coach A denies the handoff
    const denyResp = await respondHandoff(request, gameId, COACH_A, false);
    expect(denyResp.ok()).toBeTruthy();

    // Verify Coach A still holds both roles
    const state = await getControllerState(request, gameId, COACH_A);
    expect(state.state.activeCoach.userId).toBe(COACH_A);
    expect(state.state.lineCoach.userId).toBe(COACH_A);
    expect(state.state.pendingHandoff).toBeNull();
  });
});
