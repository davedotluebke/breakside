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
import { BACKEND_URL, TEST_PARAMS } from '../playwright.config';
import {
  goToApp, setupTeamWithPlayers, startGame, selectAllPlayers,
} from '../helpers/app';

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

    // Coach A pings → gets both roles
    await pingAsCoach(request, gameId, COACH_A);

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
    await pingAsCoach(request, gameId, COACH_A);

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
    await pingAsCoach(request, gameId, COACH_A);

    // Coach B requests Active Coach
    await claimRole(request, gameId, COACH_B, 'active');

    // Coach A accepts the handoff
    const acceptResp = await respondHandoff(request, gameId, COACH_A, true);
    expect(acceptResp.ok()).toBeTruthy();

    // Verify role transferred
    const state = await getControllerState(request, gameId, COACH_B);
    expect(state.state.activeCoach.userId).toBe(COACH_B);
    expect(state.state.lineCoach.userId).toBe(COACH_A);
    expect(state.myRole).toBe('activeCoach');
  });

  test('handoff deny keeps role with original holder', async ({ page, request }) => {
    // Coach A creates game and holds both roles
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Deny Handoff Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await pingAsCoach(request, gameId, COACH_A);

    // Coach B requests Active Coach
    await claimRole(request, gameId, COACH_B, 'active');

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
