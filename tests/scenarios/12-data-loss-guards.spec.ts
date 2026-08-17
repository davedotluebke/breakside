/**
 * Guards against silently destroying a coach's work.
 *
 * Both behaviors here were added after the 2026-08-16 offline audit
 * (docs/offline-no-account-audit.md §§ 5-6), and both are the kind of thing
 * that regresses invisibly: the failure mode is "no prompt appeared", which
 * looks like success until someone loses a tournament's data.
 *
 *   - Sign Out must not wipe local data while changes are still unsynced
 *     without saying so first (teams/syncStatusUI.js confirmSignOutWithPending).
 *   - The manual "Update Now" path must not reload mid-game without asking
 *     (main.js forceAppUpdate → isReloadUnsafe).
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame, selectAllPlayers,
} from '../helpers/app';

// The two game-starting tests below build a team and a full roster before they
// can assert anything, which runs long on a loaded machine. 30s (the config
// default) left no headroom.
test.describe.configure({ timeout: 60_000 });

/** Collect every native dialog, answering each with `accept`. */
function captureDialogs(page: Page, accept: boolean): string[] {
  const seen: string[] = [];
  page.on('dialog', async (d) => {
    seen.push(d.message());
    await (accept ? d.accept() : d.dismiss());
  });
  return seen;
}

/**
 * Seed localStorage BEFORE the app's modules evaluate.
 *
 * store/sync.js reads the queue into memory once at module init, so seeding
 * after load would need a second navigation — and each extra load drags the
 * test through the queue's 5s retry cycles. An init script gets the state in
 * place for the first and only load.
 */
async function seedStorage(page: Page, entries: Record<string, unknown>) {
  await page.addInitScript((seed) => {
    try {
      for (const [key, value] of Object.entries(seed)) {
        localStorage.setItem(key, JSON.stringify(value));
      }
    } catch { /* opaque origin on about:blank — the real load re-runs this */ }
  }, entries);
}

/** A queue entry that the test backend will never accept. */
const stuckGame = (id: string) => ({ type: 'game', action: 'update', id, data: {}, timestamp: 1 });

test.describe('sign-out guard', () => {
  test('warns before discarding unsynced changes, and Cancel keeps them', async ({ page }) => {
    await seedStorage(page, { ultistats_sync_queue: [stuckGame('g1'), stuckGame('g2')] });
    await goToApp(page);
    await expect(page.locator('#signOutBtn')).toBeVisible();

    // Offline so the guard skips the drain attempt and goes straight to asking.
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    const dialogs = captureDialogs(page, false);   // dismiss == Cancel
    await page.click('#signOutBtn');

    await expect.poll(() => dialogs.length, { timeout: 8_000 }).toBe(1);
    expect(dialogs[0]).toContain('2 changes have not synced');
    expect(dialogs[0]).toContain('cannot be undone');

    // Cancelling must leave everything exactly as it was.
    const queueLen = await page.evaluate(
      () => JSON.parse(localStorage.getItem('ultistats_sync_queue') || '[]').length);
    expect(queueLen).toBe(2);
    await expect(page.locator('#signOutBtn')).toBeEnabled();
    await expect(page.locator('#signOutBtn')).toContainText('Sign Out');

    await page.context().setOffline(false);
  });

  test('does not prompt when nothing is pending', async ({ page }) => {
    await goToApp(page);
    await expect(page.locator('#signOutBtn')).toBeVisible();

    const dialogs = captureDialogs(page, false);
    await page.click('#signOutBtn');
    await page.waitForTimeout(1_500);

    expect(dialogs).toEqual([]);
  });

  test('backs up local data before wiping it', async ({ page }) => {
    await seedStorage(page, {
      teamsData: [{ id: 'Sideline-ab12', name: 'Sideline FC', teamRoster: [], games: [], lines: [] }],
      ultistats_sync_queue: [stuckGame('g1')],
    });
    await goToApp(page);

    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    captureDialogs(page, true);   // accept == "Sign out anyway"
    await page.click('#signOutBtn');

    await expect.poll(async () => page.evaluate(
      () => localStorage.getItem('teamsData')), { timeout: 8_000 }).toBeNull();

    const backup = await page.evaluate(
      () => JSON.parse(localStorage.getItem('breakside_signout_backup') || 'null'));
    expect(backup).not.toBeNull();
    expect(Object.keys(backup.data).sort()).toEqual(['teamsData', 'ultistats_sync_queue']);
    expect(JSON.parse(backup.data.teamsData)[0].name).toBe('Sideline FC');

    await page.context().setOffline(false);
  });
});

test.describe('manual update guard', () => {
  /**
   * forceAppUpdate(), once past the guard, calls caches.keys() and then reloads.
   * Making caches.keys() throw a sentinel both proves the guard was passed (the
   * function's catch alerts with it) and stops a real reload from tearing the
   * page down mid-assertion.
   */
  async function stubUpdatePath(page: Page) {
    await page.evaluate(() => {
      (window as any).swRegistration = { update: async () => {} };
      Object.defineProperty(window, 'caches', {
        configurable: true,
        value: { keys: async () => { throw new Error('REACHED_UPDATE'); } },
      });
    });
  }

  test('updates without asking when no game is on screen', async ({ page }) => {
    await goToApp(page);
    await stubUpdatePath(page);

    const dialogs = captureDialogs(page, false);
    await page.evaluate(() => (window as any).forceAppUpdate());

    await expect.poll(() => dialogs.join('|'), { timeout: 8_000 }).toContain('REACHED_UPDATE');
    // The sentinel alert is the ONLY dialog — no confirm was raised.
    expect(dialogs).toHaveLength(1);
  });

  test('asks first mid-game, and Cancel does not update', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Guard FC');
    await startGame(page, 'offense');
    await selectAllPlayers(page);
    await stubUpdatePath(page);

    const dialogs = captureDialogs(page, false);   // dismiss == Cancel
    await page.evaluate(() => (window as any).forceAppUpdate());

    await expect.poll(() => dialogs.length, { timeout: 8_000 }).toBe(1);
    expect(dialogs[0]).toContain('game is in progress');
    // Cancelled → never reached the cache clear, so no reload was attempted.
    expect(dialogs.join('|')).not.toContain('REACHED_UPDATE');
  });

  test('proceeds mid-game when the user confirms', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Guard FC 2');
    await startGame(page, 'offense');
    await selectAllPlayers(page);
    await stubUpdatePath(page);

    const dialogs = captureDialogs(page, true);    // accept == "Update now anyway"
    await page.evaluate(() => (window as any).forceAppUpdate());

    await expect.poll(() => dialogs.join('|'), { timeout: 8_000 }).toContain('REACHED_UPDATE');
    expect(dialogs[0]).toContain('game is in progress');
  });
});
