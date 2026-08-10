/**
 * Out-of-game loop alignment (POLLING_OPTIMIZATION.md F3)
 *
 * Four network polls run while a coach is out of a game — team auto-refresh,
 * auto-sync, roster poll (all on the Cloud refresh interval) and the
 * active-game poll (30s). Each used to install its own `setInterval` whenever
 * its module happened to start, so their phases scattered and each one woke
 * the radio at an unrelated moment.
 *
 * That is what costs battery. After a request the radio sits in a high-power
 * state for seconds before dropping to idle, so the bill tracks how many
 * separate times you woke it — three requests in the same moment share one
 * tail, three spread across ten seconds pay three.
 *
 * They now ride a single base tick in utils/powerManager.js. The scheduling
 * arithmetic is unit-tested (tests/unit/powerPolicy.test.mjs); what only an
 * end-to-end run can show is the two things below.
 *
 * A note on what this does NOT prove: on a fresh page load the old
 * `setInterval` calls were all installed within milliseconds of each other, so
 * their phases were incidentally close anyway. Real scatter came from loops
 * being stopped and restarted at unrelated moments — opening the roster
 * screen, signing in, leaving a game. The load-time bunching measured here is
 * therefore a sanity check on the outcome; the tick assertions are the part
 * that actually pins the mechanism.
 */
import { test, expect } from '@playwright/test';
import { BACKEND_URL, TEST_PARAMS } from '../helpers/constants';

/** Requests closer together than this are one radio wake. */
const BUNCH_GAP_MS = 1_500;
/** Three base ticks at the default 10s interval, so the 30s poll must appear. */
const OBSERVE_MS = 32_000;

test('the out-of-game polls run on one shared, aligned tick', async ({ page }) => {
  // A deliberately long observation window — well past the suite default.
  test.setTimeout(OBSERVE_MS + 45_000);

  await page.goto(`/?${TEST_PARAMS}&testUserId=tick-coach`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });

  await page.evaluate(() => {
    const w = window as any;
    w.__ticks = [];
    document.addEventListener('breakside:power-tick', (e: any) => w.__ticks.push(e.detail.due));
  });

  // Let boot settle: the first tick, the initial full refresh and the
  // active-game poll's immediate first check all land in the first seconds.
  await page.waitForTimeout(4_000);

  const times: number[] = [];
  page.on('request', (req) => {
    if (req.url().startsWith(`${BACKEND_URL}/api/`)) times.push(Date.now());
  });

  await page.waitForTimeout(OBSERVE_MS);

  // ── The mechanism ────────────────────────────────────────────────────────

  const ticks: string[][] = await page.evaluate(() => (window as any).__ticks);
  expect(ticks.length, 'the shared tick should be firing').toBeGreaterThan(1);

  // The three refresh-interval loops share a period, so they must never be
  // split across ticks — split phases are exactly what this removed.
  for (const due of ticks) {
    const refreshLoops = ['autoSync', 'rosterPoll', 'teamAutoRefresh'].filter((l) =>
      due.includes(l),
    );
    expect(
      refreshLoops.length,
      `same-cadence loops must come due together, got [${due.join(', ')}]`,
    ).toBe(3);
  }

  // And the 30s poll rides along on one of those ticks rather than waking the
  // radio on a schedule of its own.
  expect(
    ticks.some((due) => due.includes('activeGamePoll')),
    'the 30s active-game poll should have come due within three base ticks',
  ).toBe(true);

  // ── The outcome ──────────────────────────────────────────────────────────

  // The rewiring's real risk isn't bad alignment, it's a loop that quietly
  // stopped running when it lost its own setInterval.
  expect(times.length, 'the out-of-game polls should still be making requests')
    .toBeGreaterThan(0);

  const bunches: number[][] = [];
  for (const t of times) {
    const last = bunches[bunches.length - 1];
    if (last && t - last[last.length - 1] <= BUNCH_GAP_MS) last.push(t);
    else bunches.push([t]);
  }

  // Three base ticks in the window, plus slack for a late one at either edge.
  expect(
    bunches.length,
    `expected a few radio wakes; got ${bunches.length} bunches from ${times.length} ` +
      `requests (sizes ${bunches.map((b) => b.length).join(',')})`,
  ).toBeLessThanOrEqual(5);

  // Each wake should carry more than one loop's traffic — that IS the
  // alignment. One single-request bunch is fine; every bunch being a single
  // request would mean they never coincide.
  const largest = Math.max(...bunches.map((b) => b.length));
  expect(largest, 'at least one wake should carry several loops at once').toBeGreaterThan(1);
});
