/**
 * In-game change gating (POLLING_OPTIMIZATION.md F1)
 *
 * The in-game refresh loop used to issue GET /api/games/{id} — the entire
 * game, every point and every event — every 3 seconds, whether or not anything
 * had changed. That is ~20 full payloads a minute per device, and on a phone
 * the cost is not the bytes but the radio: a request every 3s never lets the
 * radio drop to idle.
 *
 * It now pulls only when a change stamp says the server's copy moved. For a
 * coach that stamp rides on the controller ping they were already sending, so
 * an idle game costs *no* requests at all.
 *
 * Two things have to hold at once, and it's the pair that matters — either one
 * alone is trivially satisfiable by breaking the other:
 *
 *   1. An idle game stops pulling.       (test: "an idle game...")
 *   2. A real change still arrives fast. (test: "another coach's...")
 *
 * (2) is the risk the handoff doc flagged: the Active Coach's pendingNextLine
 * merge assumes near-live refresh, so gating it wrong would silently break
 * multi-coach line planning rather than fail loudly.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { BACKEND_URL, TEST_PARAMS, PING_INTERVAL_SOLO_MS } from '../helpers/constants';
import { setupTeamWithPlayers, startGame } from '../helpers/app';
import {
  waitForGameOnServer,
  coachHeaders,
  waitForMultiCoachSeen,
} from '../helpers/controllerApi';

const COACH_A = 'gate-coach-a';
const COACH_B = 'gate-coach-b';

/** The 3s refresh loop's period, from game/gameScreenSync.js. */
const REFRESH_INTERVAL_MS = 3_000;

async function getGameId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as any;
    const game = typeof w.currentGame === 'function' ? w.currentGame() : w.currentGame;
    return game?.id;
  });
}

/**
 * Count GETs of the FULL game payload only.
 *
 * Deliberately exact-match on /api/games/{id}: the sibling routes we do expect
 * traffic on — /ping (the keepalive, which now carries the stamp) and /poll
 * (the ~30-byte stamp fetch) — share that prefix, and a `startsWith` here would
 * count them and hide the very thing under test.
 */
function countFullGameFetches(page: Page, gameId: string) {
  const state = { count: 0, urls: [] as string[] };
  const target = `${BACKEND_URL}/api/games/${gameId}`;
  page.on('request', (req) => {
    if (req.method() !== 'GET') return;
    const url = req.url().split('?')[0];
    if (url === target) {
      state.count++;
      state.urls.push(req.url());
    }
  });
  return state;
}

/** Count controller pings, to prove the loop is alive rather than dead. */
function countPings(page: Page, gameId: string) {
  const state = { count: 0 };
  const target = `${BACKEND_URL}/api/games/${gameId}/ping`;
  page.on('request', (req) => {
    if (req.url().split('?')[0] === target) state.count++;
  });
  return state;
}

/**
 * Set up a coach sitting in a live game, then wait for the app to go quiet:
 * game start syncs, the first (deliberately unconditional) refresh, and the
 * first ping all have to land before a "nothing is happening" measurement
 * means anything.
 */
async function coachInSettledGame(page: Page, request: APIRequestContext, teamName: string) {
  await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH_A}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
  await setupTeamWithPlayers(page, teamName);
  await startGame(page, 'offense');

  const gameId = await getGameId(page);
  await waitForGameOnServer(request, gameId, COACH_A);

  // The gate can only be quiet once a ping has actually handed the client a
  // stamp — before that it has "no opinion" and correctly refetches. Waiting
  // on the wire rather than on module state also pins the contract the client
  // depends on: the keepalive really does carry `gameStamp`.
  const pingResponse = await page.waitForResponse(
    (r) => r.url().split('?')[0] === `${BACKEND_URL}/api/games/${gameId}/ping` && r.ok(),
    { timeout: 15_000 },
  );
  const ping = await pingResponse.json();
  expect(ping.gameStamp, 'the controller ping should carry a game stamp').toBeTruthy();

  // ...and it must be the same token the cheap poll route reports, or a client
  // that seeds from one and compares against the other refetches forever.
  const poll = await request.get(`${BACKEND_URL}/api/games/${gameId}/poll`, {
    headers: coachHeaders(COACH_A),
  });
  expect(poll.ok(), 'the authenticated poll route should answer').toBe(true);
  expect((await poll.json()).version).toBe(ping.gameStamp);

  return gameId;
}

// Proving an idle game stays quiet means sitting through several refresh ticks
// and a few ping gaps, on top of the game setup — more than the 30s default
// allows once game creation is slow under a parallel run.
test.describe.configure({ timeout: 60_000 });

test.describe('in-game change gating', () => {
  test('an idle game stops pulling the whole game payload', async ({ page, request }) => {
    const gameId = await coachInSettledGame(page, request, 'Gate Idle Team');

    // Let the initial burst finish before counting: game-start sync, the
    // first unconditional refresh, auto-sync's first pass.
    await page.waitForTimeout(5_000);

    const fetches = countFullGameFetches(page, gameId);
    const pings = countPings(page, gameId);

    // Long enough to clear several refresh ticks AND to contain several pings:
    // a solo coach is backed off (POLLING_OPTIMIZATION.md F4), so a window
    // shorter than a ping gap would see zero pings and fail the liveness check
    // below for no real reason. Expressed against the cadence rather than a
    // fixed number so retuning the harness can't silently reintroduce that.
    const windowMs = Math.max(REFRESH_INTERVAL_MS * 4, PING_INTERVAL_SOLO_MS * 3);
    await page.waitForTimeout(windowMs);

    // Before this change the loop pulled unconditionally every 3s, so this
    // window would have held ~4 full payloads. It should now hold none: the
    // stamp comes off the ping, and nothing wrote to the game.
    expect(
      fetches.count,
      `idle game should not pull the full payload; got ${fetches.count}: ${fetches.urls.join(', ')}`,
    ).toBe(0);

    // ...and the reason must be "nothing changed", not "everything stopped".
    expect(pings.count, 'the controller ping must still be running').toBeGreaterThan(0);
  });

  test("another coach's line signal still reaches the Active Coach promptly", async ({
    page,
    request,
  }) => {
    const gameId = await coachInSettledGame(page, request, 'Gate Propagation Team');

    // Coach B arrives and pings, as a real second coach's app does on entry.
    // Without this B is a writer the server never sees as *connected*, so the
    // Active Coach stays on the solo backoff and this test would be measuring
    // that discovery gap rather than propagation. The gap itself is pinned in
    // 11-solo-ping-backoff.spec.ts.
    await request.post(`${BACKEND_URL}/api/games/${gameId}/ping`, {
      headers: coachHeaders(COACH_B),
    });
    await waitForMultiCoachSeen(page);

    // Coach B plays Line Coach: pull the game, stamp a "lineup ready" ping
    // onto pendingNextLine, push it back. The server merges pendingNextLine
    // per-field by timestamp even for a non-authoritative writer, so this is
    // the real multi-coach path, not a synthetic file touch.
    const current = await request.get(`${BACKEND_URL}/api/games/${gameId}`, {
      headers: coachHeaders(COACH_B),
    });
    expect(current.ok(), 'coach B should be able to read the game').toBe(true);
    const gameData = await current.json();

    const readyAt = Date.now();
    gameData.pendingNextLine = {
      ...(gameData.pendingNextLine || {}),
      lineupReadyAt: readyAt,
      lineupReadyBy: 'Coach B',
    };

    const t0 = Date.now();
    const sync = await request.post(`${BACKEND_URL}/api/games/${gameId}/sync`, {
      headers: coachHeaders(COACH_B),
      data: gameData,
    });
    expect(sync.ok(), 'coach B sync should succeed').toBe(true);

    // The ping (≤2s) reports a moved stamp and fires
    // breakside:game-stamp-changed, which refreshes immediately rather than
    // waiting out the next 3s tick — so this should land FASTER than the old
    // unconditional poll did, not slower.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = window as any;
            const game = typeof w.currentGame === 'function' ? w.currentGame() : w.currentGame;
            return game?.pendingNextLine?.lineupReadyAt ?? null;
          }),
        {
          message: "the Line Coach's lineup-ready signal never reached the Active Coach",
          timeout: 15_000,
          intervals: [200],
        },
      )
      .toBe(readyAt);

    const elapsed = Date.now() - t0;
    // Generous — the point is to catch a gate that only lets changes through
    // on some much slower fallback path, not to pin exact timing on CI.
    expect(elapsed, `propagation took ${elapsed}ms`).toBeLessThan(10_000);
  });

});
