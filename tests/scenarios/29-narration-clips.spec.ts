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
 *     that failed leaves its clip without a result, and words typed through
 *     the layer's _narrate seam attach to no clip
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

/** A 1.5 s session through the seam: 15 × 100 ms chunks at 24 kHz. */
async function simulateSession(page: Page, transcript: string) {
  await page.evaluate((t) => {
    const rec = (window as any).narrationClipRecorder;
    rec._tap.onSessionStart({ mode: 'transcription', transcriptionModel: 'gpt-4o-transcribe', sampleRate: 24000 });
    for (let k = 0; k < 15; k++) rec._tap.onAudioChunk(new Int16Array(2400).fill(k * 100));
    rec._tap.onSessionStop({ transcript: t });
  }, transcript);
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
    expect(await requests()).toHaveLength(3);
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
        rec._tap.onSessionStart({ mode: 'transcription', transcriptionModel: 'gpt-4o-transcribe', sampleRate: 24000 });
        for (let k = 0; k < 15; k++) rec._tap.onAudioChunk(new Int16Array(2400).fill(k * 100));
        rec._tap.onSessionStop({ transcript: t });
      } finally {
        squads.getPhase = realPhase;
      }
    }, said);
    await expect.poll(() => clipCount(page)).toBe(1);

    // What the squads pass was asked and answered arrives on the bus.
    await page.evaluate(async (t) => {
      const { narrationEventBus } = await import('/narration/eventBus.js');
      narrationEventBus.publish('squadsResolved', {
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
