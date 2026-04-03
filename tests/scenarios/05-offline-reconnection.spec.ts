/**
 * Offline / reconnection
 *
 * Tests the offline-first sync queue:
 *   - Actions while offline are queued in localStorage
 *   - Going back online drains the queue
 *   - Server receives the data after reconnection
 */
import { test, expect, Page } from '@playwright/test';
import { BACKEND_URL, TEST_PARAMS } from '../helpers/constants';
import {
  goToApp, setupTeamWithPlayers, startGame,
  selectAllPlayers, startPoint, weScoreSkip,
  theyScore, completePullDialog, expectScore,
} from '../helpers/app';

const SYNC_QUEUE_KEY = 'ultistats_sync_queue';

/** Read the sync queue from the browser's localStorage. */
async function getSyncQueue(page: Page): Promise<any[]> {
  return page.evaluate((key) => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  }, SYNC_QUEUE_KEY);
}

/** Get the current game ID from the page. */
async function getGameId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const game = (window as any).currentGame?.() || (window as any).currentGame;
    return typeof game === 'function' ? game()?.id : game?.id;
  });
}

test.describe('offline and reconnection', () => {

  test('scoring while offline queues sync, reconnection drains it', async ({ page, request }) => {
    // ── 1. Online: create team, start game ──
    await goToApp(page);
    await setupTeamWithPlayers(page);
    await startGame(page, 'offense');
    await expectScore(page, 0, 0);

    const gameId = await getGameId(page);
    expect(gameId).toBeTruthy();

    // Verify game exists on server (was synced while online)
    const initialResp = await request.get(`${BACKEND_URL}/api/games/${gameId}`, {
      headers: { 'X-Test-User-Id': 'test-user' },
    });
    expect(initialResp.ok()).toBeTruthy();

    // ── 2. Go offline ──
    await page.context().setOffline(true);

    // Verify the app detects offline (isOnline flag)
    const offlineStatus = await page.evaluate(() => (window as any).navigator.onLine);
    expect(offlineStatus).toBe(false);

    // ── 3. Score a point while offline ──
    await selectAllPlayers(page);
    await startPoint(page);
    await weScoreSkip(page);
    await expectScore(page, 1, 0);

    // ── 4. Verify sync queue has items ──
    // Give the app a moment to attempt (and fail) the sync
    await page.waitForTimeout(1000);
    const queue = await getSyncQueue(page);
    expect(queue.length).toBeGreaterThan(0);

    // The queue should contain a game sync item
    const gameQueueItem = queue.find((item: any) => item.type === 'game');
    expect(gameQueueItem).toBeTruthy();

    // ── 5. Go back online ──
    await page.context().setOffline(false);

    // Wait for the 'online' event to fire and queue to process
    await page.waitForTimeout(3000);

    // ── 6. Verify queue drained ──
    const queueAfter = await getSyncQueue(page);
    expect(queueAfter.length).toBe(0);

    // ── 7. Verify server has the updated game ──
    const gameResp = await request.get(`${BACKEND_URL}/api/games/${gameId}`, {
      headers: { 'X-Test-User-Id': 'test-user' },
    });
    expect(gameResp.ok()).toBeTruthy();
    const gameData = await gameResp.json();

    // Server should have the score we recorded offline
    expect(gameData.scores?.team).toBe(1);
    expect(gameData.scores?.opponent).toBe(0);
  });

  test('multiple offline actions sync in correct order', async ({ page, request }) => {
    // Create team and start game while online
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Offline Order Team');
    await startGame(page, 'offense');

    const gameId = await getGameId(page);

    // Go offline
    await page.context().setOffline(true);

    // Point 1 (offense): We score
    await selectAllPlayers(page);
    await startPoint(page);
    await weScoreSkip(page);
    await expectScore(page, 1, 0);

    // Point 2 (defense after we scored): pull → they score
    await selectAllPlayers(page);
    await startPoint(page);
    await completePullDialog(page, 'Bob', 'Good Pull');
    await theyScore(page);
    await expectScore(page, 1, 1);

    // Point 3 (offense after they scored): We score again
    await selectAllPlayers(page);
    await startPoint(page);
    await weScoreSkip(page);
    await expectScore(page, 2, 1);

    await page.waitForTimeout(500);

    // Queue should have items
    const queue = await getSyncQueue(page);
    expect(queue.length).toBeGreaterThan(0);

    // Go online — queue drains
    await page.context().setOffline(false);
    await page.waitForTimeout(3000);

    // Verify queue is empty
    const queueAfter = await getSyncQueue(page);
    expect(queueAfter.length).toBe(0);

    // Server should show score 2-1
    const gameResp = await request.get(`${BACKEND_URL}/api/games/${gameId}`, {
      headers: { 'X-Test-User-Id': 'test-user' },
    });
    const gameData = await gameResp.json();
    expect(gameData.scores?.team).toBe(2);
    expect(gameData.scores?.opponent).toBe(1);
  });
});
