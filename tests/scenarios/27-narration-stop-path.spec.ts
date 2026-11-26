/**
 * Narration stop path (narration/realtimeSession.js + transcriptItems.js)
 *
 * Runs the real session module in the browser against a scripted Realtime
 * server (tests/helpers/fakeRealtime.ts): the WebSocket, the microphone and
 * the token endpoint are stubbed, and each test plays the server's side of a
 * conversation the live API was recorded having
 * (breakside_server/tests/narration/tools/stop_latency_probe.py, 2026-11-25).
 *
 *   - stop after a pause returns as soon as the empty commit is refused,
 *     instead of sitting out a timeout for a completion that never comes
 *   - a word added just before the tap survives an earlier phrase's
 *     completion arriving first
 *   - utterances are joined with a space, in order, never repeated, in the
 *     live callbacks as well as in what stop() returns
 *   - a server that never answers costs the backstop, no more
 *   - a socket that closes mid-wait ends the wait
 *   - a finished session's socket cannot reach into the next session
 */
import { test, expect, Page } from '@playwright/test';
import { goToApp } from '../helpers/app';
import { installFakeRealtime, serverSays, committed, delta, completed, EMPTY_COMMIT } from '../helpers/fakeRealtime';

const FIRST = 'All players come off, Mia and Dana in.';

/** Start a session; everything it reports lands on window.__seen. */
async function startSession(page: Page) {
  await page.evaluate(async () => {
    const { narrationRealtimeSession } = await import('/narration/realtimeSession.js');
    const seen: any = { live: [] as string[], errors: [] as string[] };
    (window as any).__seen = seen;
    (window as any).__session = narrationRealtimeSession;
    await narrationRealtimeSession.start({
      mode: 'transcription',
      onTranscriptDelta: (_d: string, transcript: string) => seen.live.push(transcript),
      onTranscriptComplete: (_u: string, transcript: string) => seen.live.push(transcript),
      onError: (e: any) => seen.errors.push(String(e && e.message || e)),
    });
  });
}

/** Tap stop: returns once the manual commit is on the wire. The result lands on window.__stop. */
async function tapStop(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const before = w.__rt.sent.filter((m: any) => m.type === 'input_audio_buffer.commit').length;
    w.__commitsBefore = before;
    w.__stop = { done: false, ms: 0, transcript: null };
    const t0 = performance.now();
    w.__session.stop().then((r: any) => {
      w.__stop = { done: true, ms: Math.round(performance.now() - t0), transcript: r.transcript };
    });
  });
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.__rt.sent.filter((m: any) => m.type === 'input_audio_buffer.commit').length - w.__commitsBefore;
  })).toBe(1);
}

const stopState = (page: Page) => page.evaluate(() => (window as any).__stop);

test.describe('narration stop path', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeRealtime(page);
    await goToApp(page);
    await startSession(page);
  });

  test('after a pause, stop returns on the empty-commit answer instead of a timeout', async ({ page }) => {
    // The detector committed and transcribed the whole call before the tap.
    await serverSays(page, committed('a'), delta('a', FIRST), completed('a', FIRST));
    await tapStop(page);
    await page.waitForTimeout(150);
    expect((await stopState(page)).done).toBe(false);      // still waiting for the answer to its commit

    await serverSays(page, EMPTY_COMMIT);
    await expect.poll(async () => (await stopState(page)).done).toBe(true);
    const stop = await stopState(page);
    expect(stop.transcript).toBe(FIRST);
    expect(stop.ms).toBeLessThan(1500);                    // the old stop() sat here for 4000 ms
    expect(await page.evaluate(() => (window as any).__seen.errors)).toEqual([]);
  });

  test('a word added just before the tap survives an earlier completion arriving first', async ({ page }) => {
    // "…Mia and Dana in." (pause) "Kris", tap. The first phrase is committed
    // but not yet transcribed when stop() runs.
    await serverSays(page, committed('a'));
    await tapStop(page);

    // Its completion lands first. The old stop() took this as the end and
    // closed the socket with "Kris" still to come.
    await serverSays(page, delta('a', FIRST), completed('a', FIRST));
    await page.waitForTimeout(200);
    expect((await stopState(page)).done).toBe(false);

    await serverSays(page, committed('b'));
    await page.waitForTimeout(100);
    expect((await stopState(page)).done).toBe(false);

    await serverSays(page, delta('b', 'Kris'), completed('b', 'Kris'));
    await expect.poll(async () => (await stopState(page)).done).toBe(true);
    expect((await stopState(page)).transcript).toBe(`${FIRST} Kris`);
  });

  test('utterances are spaced, ordered and never repeated, live and at stop', async ({ page }) => {
    // The second utterance's text arrives before the first one's completion;
    // the first ends without punctuation.
    await serverSays(page,
      committed('a'), delta('a', 'Jake and Charlie go in'),
      committed('b'), delta('b', 'Kris'),
      completed('a', 'Jake and Charlie go in'),
      completed('b', 'Kris'));
    const live = await page.evaluate(() => (window as any).__seen.live);
    expect(live[live.length - 1]).toBe('Jake and Charlie go in Kris');
    for (const t of live) {
      expect(t).not.toContain('inKris');
      expect(t.split('Jake and Charlie').length - 1).toBeLessThanOrEqual(1);
    }

    await tapStop(page);
    await serverSays(page, EMPTY_COMMIT);
    await expect.poll(async () => (await stopState(page)).done).toBe(true);
    expect((await stopState(page)).transcript).toBe('Jake and Charlie go in Kris');
  });

  test('a server that never answers costs the backstop and keeps what was heard', async ({ page }) => {
    await serverSays(page, committed('a'), delta('a', 'Run it back'));
    await tapStop(page);
    await page.waitForTimeout(4500);
    expect((await stopState(page)).done).toBe(false);
    await expect.poll(async () => (await stopState(page)).done, { timeout: 6_000 }).toBe(true);
    const stop = await stopState(page);
    expect(stop.ms).toBeGreaterThanOrEqual(5900);
    expect(stop.ms).toBeLessThan(8000);
    expect(stop.transcript).toBe('Run it back');
  });

  test('a socket that closes while stop is waiting ends the wait', async ({ page }) => {
    await serverSays(page, committed('a'), delta('a', 'Kris in for Wes'));
    await tapStop(page);
    await page.evaluate(() => {
      const rt = (window as any).__rt;
      rt.sockets[rt.sockets.length - 1].drop();
    });
    await expect.poll(async () => (await stopState(page)).done).toBe(true);
    const stop = await stopState(page);
    expect(stop.ms).toBeLessThan(1500);
    expect(stop.transcript).toBe('Kris in for Wes');
    // stop() was already under way: this is not a session failure to report.
    expect(await page.evaluate(() => (window as any).__seen.errors)).toEqual([]);
  });

  test('a finished session\'s socket cannot reach into the next one', async ({ page }) => {
    await serverSays(page, committed('a'), completed('a', 'Run it back.'));
    await tapStop(page);
    await serverSays(page, EMPTY_COMMIT);
    await expect.poll(async () => (await stopState(page)).done).toBe(true);

    await startSession(page);
    await serverSays(page, committed('n1'), delta('n1', 'Kris in for Wes'));

    // The first session's socket speaks, errors and closes late.
    await page.evaluate(() => {
      const rt = (window as any).__rt;
      const old = rt.sockets[0];
      old.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'ghost', delta: 'GHOST' });
      old.dispatch('error', new Event('error'));
      old.dispatch('close', { code: 1006, reason: 'late' });
    });

    const state = await page.evaluate(() => ({
      active: (window as any).__session.isActive(),
      live: (window as any).__seen.live,
      errors: (window as any).__seen.errors,
    }));
    expect(state.active).toBe(true);
    expect(state.errors).toEqual([]);
    expect(state.live[state.live.length - 1]).toBe('Kris in for Wes');

    await tapStop(page);
    await serverSays(page, completed('n1', 'Kris in for Wes.'), EMPTY_COMMIT);
    await expect.poll(async () => (await stopState(page)).done).toBe(true);
    expect((await stopState(page)).transcript).toBe('Kris in for Wes.');
  });
});
