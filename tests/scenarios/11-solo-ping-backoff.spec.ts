/**
 * Solo-coach ping backoff (POLLING_OPTIMIZATION.md F4)
 *
 * After F1 the controller ping is the ONLY in-game network loop — everything
 * else was either removed or gated. It runs at 2s because the coach holds a
 * role. But a coach alone in a game is pinging 30x/minute to keep a role
 * nobody is contesting and, since F1 put the change stamp on that same ping,
 * to detect changes nobody is making. So the server names the cadence: slow
 * while solo, fast the moment a second coach connects.
 *
 * Three things have to hold together, and each one alone is trivially
 * satisfiable by breaking another:
 *
 *   1. A solo coach really does back off.        ("a solo coach's ping...")
 *   2. A second coach's arrival is noticed, and  ("a second coach's arrival...")
 *      bounded — this is the cost the backoff buys, so it gets pinned, not
 *      hidden. Other specs synchronize past it with waitForMultiCoachSeen.
 *   3. Roles survive the slow cadence.           ("a backed-off coach keeps...")
 *
 * (3) is the one that would fail silently and matter most: ping too slowly and
 * the server frees your role mid-game. The margin is large (120s expiry vs a
 * 10s cadence) but the whole point of backing off is to spend some of it.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { BACKEND_URL, TEST_PARAMS } from '../helpers/constants';
import { setupTeamWithPlayers, startGame } from '../helpers/app';
import {
  waitForGameOnServer,
  coachHeaders,
  waitForMultiCoachSeen,
} from '../helpers/controllerApi';

const COACH_A = 'backoff-coach-a';
const COACH_B = 'backoff-coach-b';

/** Server-side cadences, from ultistats_server/storage/controller_storage.py. */
const PING_INTERVAL_SOLO_MS = 10_000;
const PING_INTERVAL_MULTI_MS = 2_000;

async function getGameId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as any;
    const game = typeof w.currentGame === 'function' ? w.currentGame() : w.currentGame;
    return game?.id;
  });
}

/** Count controller pings issued by the page. */
function countPings(page: Page, gameId: string) {
  const state = { count: 0 };
  const target = `${BACKEND_URL}/api/games/${gameId}/ping`;
  page.on('request', (req) => {
    if (req.url().split('?')[0] === target) state.count++;
  });
  return state;
}

/**
 * A coach sitting alone in a live game, already settled onto the slow cadence.
 *
 * The first ping goes out at the role-based 2s rate — the client can't know it
 * is solo until the server has told it — so measurements have to start after
 * that response has been applied, not at game start.
 */
async function soloCoachInSettledGame(
  page: Page,
  request: APIRequestContext,
  teamName: string,
) {
  await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
  await setupTeamWithPlayers(page, teamName);
  await startGame(page, 'offense');

  const gameId = await getGameId(page);
  await waitForGameOnServer(request, gameId, COACH_A);

  const pingResponse = await page.waitForResponse(
    (r) => r.url().split('?')[0] === `${BACKEND_URL}/api/games/${gameId}/ping` && r.ok(),
    { timeout: 15_000 },
  );
  const ping = await pingResponse.json();

  // The contract the client depends on. If the server stops naming a cadence,
  // the client silently falls back to 2s and the rest of this spec is vacuous.
  expect(
    ping.pingInterval,
    'a solo coach should be told to back off',
  ).toBe(PING_INTERVAL_SOLO_MS);

  return gameId;
}

test.describe('solo ping backoff', () => {
  test("a solo coach's ping drops to the backed-off cadence", async ({ page, request }) => {
    const gameId = await soloCoachInSettledGame(page, request, 'Backoff Solo Team');

    // Let the client apply the cadence it was just handed before counting.
    await page.waitForTimeout(PING_INTERVAL_SOLO_MS);

    const pings = countPings(page, gameId);
    const windowMs = 30_000;
    await page.waitForTimeout(windowMs);

    // At 2s this window would hold ~15 pings; at 10s it holds ~3. Assert well
    // clear of both so the test fails on a real regression, not on jitter.
    const atFastRate = windowMs / PING_INTERVAL_MULTI_MS;
    expect(
      pings.count,
      `expected roughly ${windowMs / PING_INTERVAL_SOLO_MS} pings at the solo cadence, got ${pings.count}`,
    ).toBeLessThan(atFastRate / 2);

    // ...and the reason must be "slowed down", not "stopped".
    expect(pings.count, 'the ping loop must still be running').toBeGreaterThan(0);
  });

  test("a second coach's arrival brings the cadence back within one slow interval", async ({
    page,
    request,
  }) => {
    const gameId = await soloCoachInSettledGame(page, request, 'Backoff Snapback Team');
    await page.waitForTimeout(PING_INTERVAL_SOLO_MS);

    // Coach B's app enters the game and pings, exactly as a real one does.
    const t0 = Date.now();
    await request.post(`${BACKEND_URL}/api/games/${gameId}/ping`, {
      headers: coachHeaders(COACH_B),
    });

    // Discovery is bounded by the backed-off interval: A finds out on its next
    // ping. This is the latency the backoff costs, stated as a number.
    await waitForMultiCoachSeen(page, PING_INTERVAL_SOLO_MS * 2);
    const discoveryMs = Date.now() - t0;
    expect(
      discoveryMs,
      `a solo coach should notice an arrival within one slow interval; took ${discoveryMs}ms`,
    ).toBeLessThan(PING_INTERVAL_SOLO_MS * 1.5);

    // Having noticed, the client must actually speed back up.
    const pings = countPings(page, gameId);
    const windowMs = 10_000;
    await page.waitForTimeout(windowMs);

    const atSoloRate = windowMs / PING_INTERVAL_SOLO_MS;
    expect(
      pings.count,
      `expected roughly ${windowMs / PING_INTERVAL_MULTI_MS} pings at the fast cadence, got ${pings.count}`,
    ).toBeGreaterThan(atSoloRate * 2);
  });

  test('a backed-off coach keeps its roles', async ({ page, request }) => {
    /**
     * The failure this guards is silent and severe: ping slower than the
     * server's stale timeout and it frees your roles underneath you, so the
     * coach's own taps start being rejected mid-game.
     */
    const gameId = await soloCoachInSettledGame(page, request, 'Backoff Roles Team');

    // Several backed-off intervals of doing nothing at all.
    await page.waitForTimeout(PING_INTERVAL_SOLO_MS * 4);

    const state = await request.get(`${BACKEND_URL}/api/games/${gameId}/controller`, {
      headers: coachHeaders(COACH_A),
    });
    expect(state.ok()).toBe(true);
    const body = await state.json();

    expect(
      body.state.activeCoach?.userId,
      'the backed-off coach should still hold Active Coach',
    ).toBe(COACH_A);
    expect(
      body.state.lineCoach?.userId,
      'the backed-off coach should still hold Line Coach',
    ).toBe(COACH_A);
  });
});
