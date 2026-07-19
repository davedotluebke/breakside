/**
 * Shared helpers for specs that drive the controller API directly
 * (multi-coach roles, sleep/wake recovery).
 *
 * These exist to close two timing races that made specs 03/04 flaky:
 *
 * 1. Game creation is offline-first. startNewGame() enqueues the game's first
 *    POST /api/games/{id}/sync and shows the game screen immediately; if a
 *    sync-queue pass is already in flight when the item is enqueued, the item
 *    misses that pass's snapshot and waits for the queue's 5s retry timer. So
 *    the server can lag the UI by ~0–5+ seconds, and every controller endpoint
 *    404s (game_exists guard) until the first sync lands. Specs must wait for
 *    server-side existence (waitForGameOnServer) before pinging/claiming.
 *
 * 2. Role staleness is judged by server-side timestamps at request-processing
 *    time. A fixed client-side sleep of STALE_TIMEOUT+buffer can still lose
 *    the race when the single-worker backend processes a queued ping late
 *    (its lastPing lands later than the client believes). Polling the
 *    controller endpoint until the role is actually reported vacant
 *    (waitForRolesVacant) is deterministic: GET /controller applies the
 *    stale-claim cleanup server-side on every read.
 */
import { expect, APIRequestContext } from '@playwright/test';
import { BACKEND_URL } from './constants';

export function coachHeaders(userId: string) {
  return {
    'Content-Type': 'application/json',
    'X-Test-User-Id': userId,
  };
}

/**
 * Poll until the backend knows this game exists (first sync landed).
 * Uses the controller GET endpoint: it 404s until game_exists() is true and
 * is access-allowed for any test coach. Call this after reading the game id
 * from the page and BEFORE any direct ping/claim/release API call.
 */
export async function waitForGameOnServer(
  request: APIRequestContext,
  gameId: string,
  userId: string,
  timeoutMs = 15_000,
) {
  expect(gameId, 'game id should be readable from the page').toBeTruthy();
  await expect
    .poll(
      async () => {
        const resp = await request.get(`${BACKEND_URL}/api/games/${gameId}/controller`, {
          headers: coachHeaders(userId),
        });
        return resp.status();
      },
      {
        message: `game ${gameId} never appeared on the backend — first offline-first sync still queued?`,
        timeout: timeoutMs,
        intervals: [250],
      },
    )
    .toBe(200);
}

/**
 * Poll until the given role holders are reported vacant by the server
 * (stale-claim cleanup has dropped them). Replaces fixed sleeps of
 * STALE_TIMEOUT+buffer, which raced server-side timestamping under load.
 *
 * `roles`: which of activeCoach/lineCoach must be vacant (default both).
 */
export async function waitForRolesVacant(
  request: APIRequestContext,
  gameId: string,
  userId: string,
  roles: Array<'activeCoach' | 'lineCoach'> = ['activeCoach', 'lineCoach'],
  timeoutMs = 15_000,
) {
  await expect
    .poll(
      async () => {
        const resp = await request.get(`${BACKEND_URL}/api/games/${gameId}/controller`, {
          headers: coachHeaders(userId),
        });
        if (!resp.ok()) return `http ${resp.status()}`;
        const data = await resp.json();
        const held = roles.filter((r) => data.state?.[r] != null);
        return held.length === 0 ? 'vacant' : `held: ${held.join('+')}`;
      },
      {
        message: `roles [${roles.join(', ')}] never went vacant on the server`,
        timeout: timeoutMs,
        intervals: [250],
      },
    )
    .toBe('vacant');
}
