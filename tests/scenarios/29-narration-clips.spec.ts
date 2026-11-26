/**
 * Narration clip recorder (narration/clipRecorder.js)
 *
 * Pins the privacy contract end to end:
 *   - the Advanced Settings toggle is off by default and flipping it shows
 *     the keep-clips disclosure; Cancel leaves the setting off, Keep clips
 *     persists it
 *   - with it on, a session (driven through the recorder's `_tap` seam — no
 *     mic, no OpenAI) is saved with its transcript, and the slow-pass result
 *     attaches from the event bus
 *   - a result goes to the clip of the session it names, however late it
 *     comes: not to a later clip, and nowhere when it names no kept session
 *   - Manage clips lists it; Export hands the share sheet one zip in the
 *     harness's scenario layout; Delete all empties the store
 *   - with it off, an identical session saves nothing
 *   - a browser that never saved a clip never opens the clip database, at
 *     startup or from the manage dialog; the first save creates it
 *   - a squad-picker session is saved as its own kind, with the roster and
 *     answer of the squads pass and no game context, and names its build
 *   - a spoken lineup session, run through the real session module and the
 *     real capture layer (narration/rosterNarration.js) against a scripted
 *     recognizer, is saved with what its pass was asked and answered; a pass
 *     that failed leaves its clip without a result, and neither words typed
 *     through the layer's _narrate seam nor a later session that was not
 *     kept can fill it in
 *   - in-point narration, through the real engine: the next recording can
 *     start and finish while the previous slow pass is still out, and each
 *     answer still reaches its own clip
 */
import { test, expect, Page } from '@playwright/test';
import { goToApp, setupTeamWithPlayers, startGame } from '../helpers/app';
import { installFakeRealtime, serverSays, committed, delta, completed, commitsSent, EMPTY_COMMIT } from '../helpers/fakeRealtime';

const TRANSCRIPT = 'Alice throws to Bob for the score.';

const advancedModal = (page: Page) => page.locator('#advancedSettingsModal');
const toggleRow = (page: Page) =>
  advancedModal(page).locator('.adv-setting-row', { has: page.locator('input[data-key="narration.recordClips"]') });
const toggleInput = (page: Page) => advancedModal(page).locator('input[data-key="narration.recordClips"]');
const disclosure = (page: Page) => page.locator('.modal', { hasText: 'Keep narration clips on this device?' });
const manageModal = (page: Page) => page.locator('#narrationClipManagerModal');

async function openAdvanced(page: Page) {
  await page.evaluate(() => (window as any).advancedSettings.showAdvancedSettings());
  await expect(advancedModal(page)).toBeVisible();
  // Groups start collapsed and reopen the way they were left; the recorder's
  // rows live under Audio Narration.
  const group = advancedModal(page).locator('details.adv-group[data-group="Audio Narration"]');
  if (!(await group.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await group.locator('summary').click();
  }
  await expect(toggleRow(page)).toBeVisible();
}

const settingValue = (page: Page) =>
  page.evaluate(() => (window as any).advancedSettings.get('narration.recordClips'));

const clipCount = (page: Page) =>
  page.evaluate(async () => (await (window as any).narrationClipRecorder.listClips()).length);

/**
 * A 1.5 s session through the seam: 15 × 100 ms chunks at 24 kHz. The
 * session id is what a result published later has to name to reach its clip.
 */
async function simulateSession(page: Page, transcript: string, sessionId = 'seam-1') {
  await page.evaluate(([t, id]) => {
    const rec = (window as any).narrationClipRecorder;
    rec._tap.onSessionStart({ sessionId: id, mode: 'transcription', transcriptionModel: 'gpt-4o-transcribe', sampleRate: 24000 });
    for (let k = 0; k < 15; k++) rec._tap.onAudioChunk(new Int16Array(2400).fill(k * 100));
    rec._tap.onSessionStop({ sessionId: id, transcript: t });
  }, [transcript, sessionId] as const);
}

/** A slow-pass answer on the bus, as the engine publishes it. */
async function publishFinalized(page: Page, sessionId: string | null | undefined, marker: string) {
  await page.evaluate(async ([id, m]) => {
    const { narrationEventBus } = await import('/narration/eventBus.js');
    const payload: any = {
      transcript: '', roster: [], gameContext: null, error: null,
      operations: [{ op: 'ADD', event: { kind: 'throw', thrower: m, receiver: 'Bob' } }],
    };
    if (id !== undefined) payload.sessionId = id;
    narrationEventBus.publish('narrationFinalized', payload);
  }, [sessionId, marker] as const);
}

/**
 * Answer /api/narration/lineup inside the page: no backend model, no key.
 * window.__lineup holds the next answer ({status, body}) and every request.
 */
async function stubLineupEndpoint(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__lineup = { status: 200, body: {}, requests: [] as any[] };
    const inner = window.fetch.bind(window);
    window.fetch = (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('/api/narration/lineup')) return inner(input, init);
      w.__lineup.requests.push(JSON.parse((init && init.body) || '{}'));
      return Promise.resolve(new Response(JSON.stringify(w.__lineup.body), {
        status: w.__lineup.status, headers: { 'Content-Type': 'application/json' },
      }));
    };
  });
}

/**
 * Hold /api/narration/finalize: each request waits on window.__finalize.pending
 * ({body, release(answer)}) until the test answers it, so answers can be made
 * to come back as late, and in whatever order, a test needs.
 */
async function holdFinalizeEndpoint(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__finalize = { pending: [] as any[] };
    const inner = window.fetch.bind(window);
    window.fetch = (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('/api/narration/finalize')) return inner(input, init);
      return new Promise((resolve) => {
        w.__finalize.pending.push({
          body: JSON.parse((init && init.body) || '{}'),
          release: (answer: any) => resolve(new Response(JSON.stringify(answer), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })),
        });
      });
    };
  });
}

/**
 * Speak a line into the real lineup layer: start, the recognizer hears
 * `said`, stop. Resolves once the layer is idle again (its pass has run).
 */
async function speakLineup(page: Page, said: string) {
  await page.evaluate(() => (window as any).lineupNarration.start());
  expect(await page.evaluate(() => (window as any).lineupNarration.getPhase())).toBe('recording');
  // A second and a half of audio, through the recorder's own seam: what the
  // headless browser's audio graph delivers is not this test's business.
  await page.evaluate(() => {
    const rec = (window as any).narrationClipRecorder;
    for (let k = 0; k < 15; k++) rec._tap.onAudioChunk(new Int16Array(2400).fill(k * 100));
  });
  await serverSays(page, committed('u1'), delta('u1', said), completed('u1', said));

  const commitsBefore = await commitsSent(page);
  await page.evaluate(() => { (window as any).lineupNarration.stop(); });
  await expect.poll(() => commitsSent(page)).toBe(commitsBefore + 1);
  await serverSays(page, EMPTY_COMMIT);
  await expect.poll(() => page.evaluate(() => (window as any).lineupNarration.getPhase())).toBe('idle');
}

/** Saved clips, oldest first, without their audio. */
const savedClips = (page: Page) => page.evaluate(async () => {
  const clips = await (window as any).narrationClipRecorder.listClips();
  return clips
    .map((c: any) => ({ kind: c.kind, transcript: c.transcript, gameId: c.gameId, result: c.result, createdAt: c.createdAt }))
    .sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
});

test.describe('narration clip recorder', () => {
  test('a spoken lineup session keeps what its pass was asked and answered; typed words attach nothing', async ({ page }) => {
    await installFakeRealtime(page);
    await stubLineupEndpoint(page);
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Clip Keepers');
    await startGame(page, 'offense');
    await expect(page.locator('#panelActivePlayersTable')).toBeVisible({ timeout: 8_000 });
    await page.evaluate(() => (window as any).advancedSettings.set('narration.recordClips', true));
    const answer = (status: number, body: Record<string, unknown>) =>
      page.evaluate(([s, b]) => { Object.assign((window as any).__lineup, { status: s, body: b }); }, [status, body] as const);
    const requests = () => page.evaluate(() => (window as any).__lineup.requests);
    const heard = (players: string[]) => ({
      players, unmatched: [], note: '', voiced_in: players, voiced_out: [],
      voiced_clear: false, voiced_group_out: [], fills: [],
    });

    // The pass fails: the session is still kept, with nothing claimed for it.
    await answer(503, { detail: 'narration is not configured' });
    await speakLineup(page, 'Alice and Bob go in.');
    await expect.poll(() => clipCount(page)).toBe(1);
    expect(await requests()).toHaveLength(1);
    let clips = await savedClips(page);
    expect(clips[0]).toMatchObject({ kind: 'lineup', transcript: 'Alice and Bob go in.', result: null });
    expect(clips[0].gameId).toBeTruthy();

    // Typed words run the same pass, and it answers; but no session heard
    // them, so the answer belongs to no clip, least of all the last one.
    await answer(200, heard(['Carol']));
    expect(await page.evaluate(() => (window as any).lineupNarration._narrate('Carol goes in'))).toBe(true);
    expect(await requests()).toHaveLength(2);
    await page.waitForTimeout(400);
    expect((await savedClips(page))[0].result).toBeNull();

    // Nor does a later session that was not kept (the setting went off in
    // between): its pass answers, but that answer is its own, and it has no
    // clip. The failed clip does not inherit it.
    await page.evaluate(() => (window as any).advancedSettings.set('narration.recordClips', false));
    await answer(200, heard(['Bob']));
    await speakLineup(page, 'Bob goes in.');
    expect(await requests()).toHaveLength(3);
    await page.waitForTimeout(400);
    expect(await clipCount(page)).toBe(1);
    expect((await savedClips(page))[0].result).toBeNull();
    await page.evaluate(() => (window as any).advancedSettings.set('narration.recordClips', true));

    // A spoken session whose pass answers: its own clip gets the request the
    // pass was given and the answer, and the earlier clip stays as it was.
    await answer(200, heard(['Alice', 'Eve']));
    await speakLineup(page, 'Alice and Eve go in.');
    await expect.poll(() => clipCount(page)).toBe(2);
    await expect.poll(async () => (await savedClips(page))[1]?.result?.type ?? null).toBe('lineup');
    clips = await savedClips(page);
    expect(clips[0].result).toBeNull();
    expect(clips[1]).toMatchObject({ kind: 'lineup', transcript: 'Alice and Eve go in.' });
    expect(clips[1].result.request.transcript).toBe('Alice and Eve go in.');
    expect(clips[1].result.request.roster.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Alice', 'Eve']));
    expect(clips[1].result.request.expected_count).toBe(7);
    expect(clips[1].result.response.players).toEqual(['Alice', 'Eve']);
    expect(await requests()).toHaveLength(4);
  });

  test('in-point narration: the next recording finishes while the first slow pass is out; each answer reaches its own clip', async ({ page }) => {
    await installFakeRealtime(page);
    await holdFinalizeEndpoint(page);
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Clip Keepers');
    await startGame(page, 'offense');
    await expect(page.locator('#panelActivePlayersTable')).toBeVisible({ timeout: 8_000 });
    await page.evaluate(async () => {
      const w = window as any;
      w.advancedSettings.set('narration.recordClips', true);
      // What the engine announces, as the recorder hears it.
      w.__announced = [];
      const { narrationEventBus } = await import('/narration/eventBus.js');
      narrationEventBus.subscribe('narrationFinalized', (p: any) =>
        w.__announced.push({ sessionId: p.sessionId, transcript: p.transcript }));
    });

    /** One recording through the real engine; returns with its slow pass still out. */
    const record = async (said: string, outstanding: number) => {
      await page.evaluate(async () => {
        const { narrationEngine } = await import('/narration/narrationEngine.js');
        await narrationEngine.startRecording();
      });
      await page.evaluate(() => {
        const rec = (window as any).narrationClipRecorder;
        for (let k = 0; k < 15; k++) rec._tap.onAudioChunk(new Int16Array(2400).fill(k * 100));
      });
      await serverSays(page, committed('u1'), delta('u1', said), completed('u1', said));
      const commitsBefore = await commitsSent(page);
      await page.evaluate(async () => {
        const { narrationEngine } = await import('/narration/narrationEngine.js');
        narrationEngine.stopRecording();
      });
      await expect.poll(() => commitsSent(page)).toBe(commitsBefore + 1);
      await serverSays(page, EMPTY_COMMIT);
      await expect.poll(() => page.evaluate(() => (window as any).__finalize.pending.length)).toBe(outstanding);
    };
    const release = (i: number, marker: string) => page.evaluate(([n, m]) => {
      (window as any).__finalize.pending[n].release({ operations: [{ op: 'CONFIRM', provisional_id: m }] });
    }, [i, marker] as const);
    /** transcript → the marker of the answer its clip holds, or null. */
    const answers = async () => Object.fromEntries((await savedClips(page)).map((c: any) =>
      [c.transcript, c.result ? c.result.operations[0].provisional_id : null]));

    // The coach narrates, stops, and narrates again before the first answer
    // is in (the mic takes a tap while the engine is finalizing).
    await record('Alice has the disc.', 1);
    await record('Carol has the disc.', 2);
    await expect.poll(() => clipCount(page)).toBe(2);
    expect(await page.evaluate(() => (window as any).__finalize.pending.map((p: any) => p.body.transcript)))
      .toEqual(['Alice has the disc.', 'Carol has the disc.']);
    expect(await answers()).toEqual({ 'Alice has the disc.': null, 'Carol has the disc.': null });
    expect((await savedClips(page)).map((c: any) => c.kind)).toEqual(['events', 'events']);

    // The first answer comes back only now, with the second clip already
    // saved. It belongs to the first.
    await release(0, 'first-answer');
    await expect.poll(answers).toEqual({ 'Alice has the disc.': 'first-answer', 'Carol has the disc.': null });

    await release(1, 'second-answer');
    await expect.poll(answers).toEqual({ 'Alice has the disc.': 'first-answer', 'Carol has the disc.': 'second-answer' });

    // Each announcement named its own session and carried its own words.
    const announced = await page.evaluate(() => (window as any).__announced);
    expect(announced.map((a: any) => a.transcript)).toEqual(['Alice has the disc.', 'Carol has the disc.']);
    expect(announced[0].sessionId).not.toBeNull();
    expect(announced[1].sessionId).not.toBeNull();
    expect(announced[0].sessionId).not.toBe(announced[1].sessionId);
  });

  test('a result reaches the clip of the session it names, however late; never another one', async ({ page }) => {
    await goToApp(page);
    await page.evaluate(() => (window as any).advancedSettings.set('narration.recordClips', true));

    // Two sessions are saved before either answer is in.
    await simulateSession(page, 'First call.', 'first');
    await simulateSession(page, 'Second call.', 'second');
    await expect.poll(() => clipCount(page)).toBe(2);
    /** transcript → the thrower named in the answer its clip holds, or null. */
    const throwers = async () => Object.fromEntries((await savedClips(page)).map((c: any) =>
      [c.transcript, c.result ? c.result.operations[0].event.thrower : null]));

    // An answer that names no session, or one that was never kept, lands nowhere.
    await publishFinalized(page, undefined, 'Nobody');
    await publishFinalized(page, null, 'Nobody');
    await publishFinalized(page, 'never-kept', 'Nobody');
    await page.waitForTimeout(400);
    expect(await throwers()).toEqual({ 'First call.': null, 'Second call.': null });

    // The first session's answer, arriving after the second clip was saved,
    // still goes to the first clip.
    await publishFinalized(page, 'first', 'Alice');
    await expect.poll(throwers).toEqual({ 'First call.': 'Alice', 'Second call.': null });

    await publishFinalized(page, 'second', 'Carol');
    await expect.poll(throwers).toEqual({ 'First call.': 'Alice', 'Second call.': 'Carol' });

    // One answer per session: a repeat changes nothing.
    await publishFinalized(page, 'first', 'Eve');
    await page.waitForTimeout(400);
    expect(await throwers()).toEqual({ 'First call.': 'Alice', 'Second call.': 'Carol' });
  });

  test('off by default; the disclosure gates the toggle', async ({ page }) => {
    await goToApp(page);
    await openAdvanced(page);
    await expect(toggleInput(page)).not.toBeChecked();
    expect(await settingValue(page)).toBe(false);

    // Cancel: the toggle springs back and nothing was persisted.
    await toggleRow(page).locator('label.adv-switch').click();
    await expect(disclosure(page)).toBeVisible();
    await disclosure(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(disclosure(page)).toHaveCount(0);
    await expect(toggleInput(page)).not.toBeChecked();
    expect(await settingValue(page)).toBe(false);

    // Keep clips: persisted only now.
    await toggleRow(page).locator('label.adv-switch').click();
    await expect(disclosure(page)).toBeVisible();
    await disclosure(page).getByRole('button', { name: 'Keep clips' }).click();
    await expect(disclosure(page)).toHaveCount(0);
    await expect(toggleInput(page)).toBeChecked();
    expect(await settingValue(page)).toBe(true);
  });

  test('saves a session with transcript + result; manage, export, delete', async ({ page }) => {
    await goToApp(page);
    await page.evaluate(() => (window as any).advancedSettings.set('narration.recordClips', true));

    await simulateSession(page, TRANSCRIPT);
    await expect(page.locator('#toastContainer')).toContainText('Narration clip saved', { timeout: 5_000 });
    await expect.poll(() => clipCount(page)).toBe(1);

    // The slow-pass result arrives after the session and attaches to the clip.
    await page.evaluate(async () => {
      const { narrationEventBus } = await import('/narration/eventBus.js');
      narrationEventBus.publish('narrationFinalized', {
        sessionId: 'seam-1',
        transcript: 'Alice throws to Bob for the score.', roster: [], gameContext: null,
        operations: [{ op: 'ADD', event: { kind: 'throw', thrower: 'Alice', receiver: 'Bob', score: true } }],
        error: null,
      });
    });
    await expect.poll(() => page.evaluate(async () => {
      const [c] = await (window as any).narrationClipRecorder.listClips();
      return c?.result?.type ?? null;
    })).toBe('finalize');

    // Manage clips, reached through the real settings button.
    await openAdvanced(page);
    await advancedModal(page).locator('.adv-action-btn', { hasText: 'Manage clips' }).click();
    await expect(manageModal(page)).toBeVisible();
    const row = manageModal(page).locator('.clip-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(TRANSCRIPT);
    await expect(row).toContainText('not exported');

    // Export: the share sheet gets one zip in the harness's scenario layout.
    await page.evaluate(() => {
      (navigator as any).canShare = () => true;
      (navigator as any).share = async ({ files }: { files: File[] }) => {
        const b = new Uint8Array(await files[0].arrayBuffer());
        const v = new DataView(b.buffer);
        const eocd = b.length - 22;
        const n = v.getUint16(eocd + 10, true);
        let p = v.getUint32(eocd + 16, true);
        const names: string[] = [];
        for (let i = 0; i < n; i++) {
          const len = v.getUint16(p + 28, true);
          names.push(new TextDecoder().decode(b.subarray(p + 46, p + 46 + len)));
          p += 46 + len;
        }
        (window as any).__shared = { name: files[0].name, sig: v.getUint32(eocd, true), names };
      };
    });
    await row.getByRole('button', { name: 'Export' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__shared ?? null)).not.toBeNull();
    const shared = await page.evaluate(() => (window as any).__shared);
    expect(shared.name).toMatch(/^breakside-clip-[a-z]+-\d{8}-\d{6}\.zip$/);
    expect(shared.sig).toBe(0x06054b50);
    expect(shared.names).toEqual(['audio.wav', 'transcript.txt', 'roster.json', 'meta.json', 'expected.draft.json']);
    await expect(row).toContainText(/\bexported\b/);
    await expect(row).not.toContainText('not exported');

    // Delete all empties the list and the store.
    page.once('dialog', (d) => d.accept());
    await manageModal(page).getByRole('button', { name: 'Delete all' }).click();
    await expect(manageModal(page).locator('.clip-manager-empty')).toBeVisible();
    await expect.poll(() => clipCount(page)).toBe(0);
  });

  test('with the setting off, a session saves nothing', async ({ page }) => {
    await goToApp(page);
    expect(await settingValue(page)).toBe(false);
    await simulateSession(page, TRANSCRIPT);
    await page.waitForTimeout(500);
    expect(await clipCount(page)).toBe(0);
    expect(await page.evaluate(() => (window as any).narrationClipRecorder.isCapturing())).toBe(false);
  });

  test('a squad session is saved as squads: the pass\'s roster and answer, no game, the build', async ({ page }) => {
    await goToApp(page);
    await page.evaluate(() => (window as any).advancedSettings.set('narration.recordClips', true));

    // The squad surface is live for the length of the session: its phase is
    // how the recorder tells whose session this is.
    const said = 'Alice and Bob on Dark, the rest on Light.';
    await page.evaluate((t) => {
      const squads = (window as any).squadNarration;
      const realPhase = squads.getPhase;
      squads.getPhase = () => 'recording';
      try {
        const rec = (window as any).narrationClipRecorder;
        rec._tap.onSessionStart({ sessionId: 'squad-1', mode: 'transcription', transcriptionModel: 'gpt-4o-transcribe', sampleRate: 24000 });
        for (let k = 0; k < 15; k++) rec._tap.onAudioChunk(new Int16Array(2400).fill(k * 100));
        rec._tap.onSessionStop({ sessionId: 'squad-1', transcript: t });
      } finally {
        squads.getPhase = realPhase;
      }
    }, said);
    await expect.poll(() => clipCount(page)).toBe(1);

    // What the squads pass was asked and answered arrives on the bus.
    await page.evaluate(async (t) => {
      const { narrationEventBus } = await import('/narration/eventBus.js');
      narrationEventBus.publish('squadsResolved', {
        sessionId: 'squad-1',
        transcript: t,
        request: {
          transcript: t, squad_names: { X: 'Dark', Y: 'Light' }, current_squads: { X: [], Y: [] },
          roster: [
            { name: 'Alice', nickname: null, number: '7', gender: 'FMP', here: true, pinned: false },
            { name: 'Bob', nickname: null, number: null, gender: 'MMP', here: true, pinned: false },
            { name: 'Dana', nickname: null, number: '22', gender: 'FMP', here: true, pinned: false },
          ],
        },
        response: { squads: { X: ['Alice', 'Bob'], Y: ['Dana'] } },
      });
    }, said);
    await expect.poll(() => page.evaluate(async () => {
      const [c] = await (window as any).narrationClipRecorder.listClips();
      return c?.result?.type ?? null;
    })).toBe('squads');

    const clip = await page.evaluate(async () => {
      const [c] = await (window as any).narrationClipRecorder.listClips();
      return { kind: c.kind, gameId: c.gameId, gameContext: c.gameContext, onField: c.onField,
               roster: c.roster, app: c.app };
    });
    expect(clip.kind).toBe('squads');
    // No game owns a squad-picker session, whatever game was open last.
    expect(clip.gameId).toBeNull();
    expect(clip.gameContext).toBeNull();
    expect(clip.onField).toEqual([]);
    expect(clip.roster).toEqual([
      { name: 'Alice', nickname: null, number: '7' },
      { name: 'Bob', nickname: null, number: null },
      { name: 'Dana', nickname: null, number: '22' },
    ]);
    expect(clip.app.version).toBeTruthy();
    expect(clip.app.build).toBeTruthy();

    // Listed as a squads clip, and exported with the pass's draft.
    await page.evaluate(() => (window as any).narrationClipRecorder.showClips());
    await expect(manageModal(page).locator('.clip-row')).toContainText('Squads');
    const names = await page.evaluate(async () => {
      let shared: string[] = [];
      (navigator as any).canShare = () => true;
      (navigator as any).share = async ({ files }: { files: File[] }) => {
        const b = new Uint8Array(await files[0].arrayBuffer());
        const v = new DataView(b.buffer);
        const eocd = b.length - 22;
        let p = v.getUint32(eocd + 16, true);
        for (let i = 0; i < v.getUint16(eocd + 10, true); i++) {
          const len = v.getUint16(p + 28, true);
          shared.push(new TextDecoder().decode(b.subarray(p + 46, p + 46 + len)));
          p += 46 + len;
        }
      };
      const [c] = await (window as any).narrationClipRecorder.listClips();
      await (window as any).narrationClipRecorder.exportClip(c.id);
      return shared;
    });
    expect(names).toEqual(['audio.wav', 'transcript.txt', 'roster.json', 'meta.json', 'squads.draft.json']);
  });

  test('a browser that never saved a clip has no clip database', async ({ page }) => {
    const clipDatabases = () => page.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name).filter((n) => n === 'breakside-narration-clips'));

    // Startup, a session with the setting off, and a look at the (empty)
    // manage dialog, Export all and Delete all included, leave no trace.
    await goToApp(page);
    await simulateSession(page, TRANSCRIPT);
    await openAdvanced(page);
    await advancedModal(page).locator('.adv-action-btn', { hasText: 'Manage clips' }).click();
    await expect(manageModal(page).locator('.clip-manager-empty')).toBeVisible();
    await manageModal(page).getByRole('button', { name: 'Export all' }).click();
    await manageModal(page).getByRole('button', { name: 'Delete all' }).click();
    await expect(manageModal(page).locator('.clip-manager-empty')).toBeVisible();
    expect(await clipCount(page)).toBe(0);
    expect(await clipDatabases()).toEqual([]);

    // The first save creates it, and the next startup trims it.
    await page.evaluate(() => (window as any).advancedSettings.set('narration.recordClips', true));
    await simulateSession(page, TRANSCRIPT);
    await expect.poll(() => clipCount(page)).toBe(1);
    expect(await clipDatabases()).toEqual(['breakside-narration-clips']);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).narrationClipRecorder);
    await expect.poll(() => clipCount(page)).toBe(1);
  });
});
