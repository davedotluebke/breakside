/**
 * Sleep/wake recovery
 *
 * Tests what happens when a coach's device sleeps (stops pinging)
 * and then wakes up:
 *   - Roles expire on the server after STALE_TIMEOUT (5s in test config)
 *   - Another coach can claim the expired roles
 *   - On wake, the original coach re-claims via ping auto-assign
 *
 * Note: We can't truly stop browser timers in Playwright, so we simulate
 * the server-side expiry by stopping Coach A's pings (via JS override).
 * Expiry is then OBSERVED (polling the controller endpoint until the server
 * reports the roles vacant) rather than assumed after a fixed sleep —
 * staleness is judged by server-side timestamps at request-processing time,
 * and fixed client-side sleeps raced them under load.
 *
 * COVERAGE GAP (deliberate): the app's `visibilitychange` wake handler in
 * game/controllerState.js is NOT exercised here — the "wake" below is
 * simulated by pinging the API directly, which reproduces the handler's
 * auto-assign effect but not its refresh/re-claim logic. Driving the real
 * handler needs module-scoped state manipulation that proved too brittle.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { BACKEND_URL, TEST_PARAMS } from '../helpers/constants';
import { setupTeamWithPlayers, startGame } from '../helpers/app';
import { waitForGameOnServer, waitForRolesVacant } from '../helpers/controllerApi';

// ─── API helpers ────────────────────────────────────────────────────────────

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

async function getControllerState(request: APIRequestContext, gameId: string, userId: string) {
  const resp = await request.get(`${BACKEND_URL}/api/games/${gameId}/controller`, {
    headers: coachHeaders(userId),
  });
  return resp.json();
}

async function getGameId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const game = (window as any).currentGame?.() || (window as any).currentGame;
    return typeof game === 'function' ? game()?.id : game?.id;
  });
}

/**
 * Simulate device sleep: stop the polling interval timer but keep
 * currentGameIdForPolling set (so the wake handler knows what game
 * to recover). This mimics what a real phone does — timers freeze
 * but the app state is preserved.
 */
async function simulateSleep(page: Page) {
  await page.evaluate(() => {
    // Access the module-scoped interval ID via the exposed stop function,
    // but we need to NOT clear currentGameIdForPolling. We'll override
    // pingController to no-op instead.
    const w = window as any;
    w._realPingController = w.pingController;
    w.pingController = async () => null;
    // Also stop the interval timer to prevent it from calling the no-op
    w.stopControllerPolling();
  });
}

// (A simulateWake helper that restored pings and dispatched a synthetic
// visibilitychange event used to live here, but no test ever called it —
// see the COVERAGE GAP note in the header.)

// ─── Tests ──────────────────────────────────────────────────────────────────

const COACH_A = 'coach-a';
const COACH_B = 'coach-b';

// Backend stale timeout is 5s in playwright.config.ts (BREAKSIDE_STALE_TIMEOUT).
// Expiry is observed via waitForRolesVacant rather than slept for.

test.describe('sleep/wake recovery', () => {
  test('roles expire on server after stale timeout', async ({ page, request }) => {
    // Coach A creates game and gets roles via ping
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Sleep Test Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH_A);
    const pingResp = await pingAsCoach(request, gameId, COACH_A);
    expect(pingResp.ok()).toBeTruthy();

    // Verify Coach A holds both roles
    let state = await getControllerState(request, gameId, COACH_A);
    expect(state.state.activeCoach.userId).toBe(COACH_A);

    // Simulate sleep: stop all pings from Coach A
    await simulateSleep(page);

    // Observe the server dropping A's stale roles (no fixed sleep)
    await waitForRolesVacant(request, gameId, COACH_B);

    // Coach B pings — should get auto-assigned both roles (since A's expired)
    await pingAsCoach(request, gameId, COACH_B);
    state = await getControllerState(request, gameId, COACH_B);
    expect(state.state.activeCoach.userId).toBe(COACH_B);
    expect(state.state.lineCoach.userId).toBe(COACH_B);
  });

  test('wake triggers re-claim of lost roles', async ({ page, request }) => {
    // Coach A creates game and gets roles
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Wake Reclaim Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH_A);
    const pingResp = await pingAsCoach(request, gameId, COACH_A);
    expect(pingResp.ok()).toBeTruthy();

    // Verify Coach A has roles
    let state = await getControllerState(request, gameId, COACH_A);
    expect(state.state.activeCoach.userId).toBe(COACH_A);

    // Simulate sleep, then observe the server dropping A's stale roles
    await simulateSleep(page);
    await waitForRolesVacant(request, gameId, COACH_A);

    // Instead of relying on the visibilitychange handler (which has complex
    // interactions with module-scoped state), directly ping as Coach A via API
    // to simulate what the wake handler would do: ping → auto-assign
    await pingAsCoach(request, gameId, COACH_A);

    // Coach A should have re-claimed both roles via auto-assign
    state = await getControllerState(request, gameId, COACH_A);
    expect(state.state.activeCoach.userId).toBe(COACH_A);
    expect(state.state.lineCoach.userId).toBe(COACH_A);
  });

  test('Coach B takes role during sleep, Coach A detects on wake', async ({ page, request }) => {
    // Coach A creates game and gets roles
    await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
    await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
    await setupTeamWithPlayers(page, 'Contested Wake Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);
    await waitForGameOnServer(request, gameId, COACH_A);
    const pingResp = await pingAsCoach(request, gameId, COACH_A);
    expect(pingResp.ok()).toBeTruthy();

    // Simulate sleep, then observe the server dropping A's stale roles
    await simulateSleep(page);
    await waitForRolesVacant(request, gameId, COACH_B);

    // Coach B claims both roles while Coach A is asleep
    await pingAsCoach(request, gameId, COACH_B);
    let state = await getControllerState(request, gameId, COACH_B);
    expect(state.state.activeCoach.userId).toBe(COACH_B);

    // Wait until Coach B's single ping has also gone stale server-side
    await waitForRolesVacant(request, gameId, COACH_A);

    // Coach A wakes up and pings — should reclaim since Coach B's roles
    // are also stale now (Coach B only pinged once, no ongoing pings)
    await pingAsCoach(request, gameId, COACH_A);
    state = await getControllerState(request, gameId, COACH_A);

    // Coach A should hold both roles after wake recovery
    expect(state.state.activeCoach.userId).toBe(COACH_A);
    expect(state.state.lineCoach.userId).toBe(COACH_A);
  });
});
