/**
 * Mic button setting and the denied-microphone toast
 * (settings/advancedSettings.js 'narration.mode', narration/micButton.js,
 * game/controllerState.js showControllerToast actions)
 *
 * Pins:
 *   - the default (plays and lineups) shows the mic on every game tab
 *   - lineups only shows it on the Line and All tabs and nowhere else, and
 *     drives lineup narration there even mid-point on the All tab, where the
 *     default drives event narration
 *   - off hides it everywhere, the moment the setting is written
 *   - a denied getUserMedia raises the mic-blocked toast, whose "Hide mic
 *     button" action turns narration off and removes the button
 *
 * The denial leg stubs the two network legs a session needs before it
 * reaches the microphone — the token POST (page.route) and the OpenAI
 * WebSocket (a fake installed by an init script, scoped to that host) — and
 * then lets headless Chromium refuse getUserMedia, which it does without a
 * prompt (docs/dev-notes/preview-testing.md).
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame, selectAllPlayers, startPoint,
} from '../helpers/app';

const mic = (page: Page) => page.locator('#narrationMicBtn');
const tab = (page: Page, name: string) => page.locator(`#headerSegControl button[data-tab="${name}"]`);

/** The same write the Advanced Settings select makes, live-apply hook included. */
async function setMode(page: Page, mode: 'all' | 'lineup' | 'off') {
  await page.evaluate((m) => {
    (window as any).advancedSettings.set('narration.mode', m);
    (window as any).narrationMicButton.refreshVisibility();
  }, mode);
}

const targetName = (page: Page) =>
  page.evaluate(() => (window as any).narrationMicButton._currentTargetName());

/** A short tap. The button has no click listener, only press and release. */
async function tapMic(page: Page) {
  await mic(page).dispatchEvent('mousedown', { button: 0 });
  await mic(page).dispatchEvent('mouseup', { button: 0 });
}

test.describe('mic button setting', () => {
  test('where the mic shows follows the setting and the tab', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    await tab(page, 'all').click();

    // Default: plays and lineups, on every tab.
    await expect(mic(page)).toBeVisible();
    for (const name of ['simple', 'line', 'log', 'all']) {
      await tab(page, name).click();
      await expect(mic(page)).toBeVisible();
    }

    // Lineups only: Line and All, nowhere else.
    await setMode(page, 'lineup');
    await expect(mic(page)).toBeVisible();
    await tab(page, 'simple').click();
    await expect(mic(page)).toBeHidden();
    await tab(page, 'line').click();
    await expect(mic(page)).toBeVisible();
    await tab(page, 'log').click();
    await expect(mic(page)).toBeHidden();
    await tab(page, 'all').click();
    await expect(mic(page)).toBeVisible();

    // Mid-point on the All tab, lineups only still means the lineup layer;
    // the default hands the same tap to event narration.
    await selectAllPlayers(page);
    await startPoint(page);
    expect(await targetName(page)).toBe('lineup');
    await setMode(page, 'all');
    expect(await targetName(page)).toBe('event');

    // Off: gone at once, and on every tab.
    await setMode(page, 'off');
    await expect(mic(page)).toBeHidden();
    await tab(page, 'line').click();
    await expect(mic(page)).toBeHidden();
    await tab(page, 'all').click();
    await expect(mic(page)).toBeHidden();

    // And back.
    await setMode(page, 'all');
    await expect(mic(page)).toBeVisible();
  });

  test('a denied microphone raises the mic-blocked toast, whose action hides the button', async ({ page }) => {
    // Fake the OpenAI socket before the app loads: it opens on the next tick,
    // swallows session.update and closes quietly. Any other WebSocket is the
    // real one.
    await page.addInitScript(() => {
      const RealWebSocket = (window as any).WebSocket;
      class FakeSocket extends EventTarget {
        url: string;
        readyState: number;
        constructor(url: string, protocols?: string | string[]) {
          super();
          if (!/api\.openai\.com/.test(url)) return new RealWebSocket(url, protocols);
          this.url = url;
          this.readyState = 0;
          setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
          }, 0);
        }
        send() { /* nothing listens */ }
        close() {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.dispatchEvent(new CloseEvent('close', { code: 1000, reason: 'fake' }));
        }
      }
      (FakeSocket as any).CONNECTING = 0;
      (FakeSocket as any).OPEN = 1;
      (FakeSocket as any).CLOSING = 2;
      (FakeSocket as any).CLOSED = 3;
      (window as any).WebSocket = FakeSocket;
    });
    await page.route('**/api/narration/token', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'e2e-fake-token' }),
    }));

    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    await tab(page, 'all').click();
    // Mid-point on the All tab the tap goes to event narration, which has
    // no role gate in the way of reaching the microphone.
    await selectAllPlayers(page);
    await startPoint(page);
    expect(await targetName(page)).toBe('event');

    await tapMic(page);
    // First narration on this device: the where-the-audio-goes disclosure
    // comes first.
    await expect(page.locator('#narrationDisclosureModal')).toBeVisible();
    await page.locator('#narrationDisclosureEnableBtn').click();

    const blocked = page.locator('#toastContainer .toast-error', { hasText: 'Microphone access was denied' });
    await expect(blocked).toBeVisible({ timeout: 15_000 });
    await expect(blocked).toContainText('tap the mic to be asked again');
    // Back to idle, not stuck amber.
    await expect(mic(page)).toHaveClass(/mic-idle/);
    await expect(mic(page)).toBeVisible();

    await blocked.getByRole('button', { name: 'Hide mic button' }).click();
    await expect(blocked).toBeHidden();
    await expect(mic(page)).toBeHidden();
    expect(await page.evaluate(() => (window as any).advancedSettings.get('narration.mode'))).toBe('off');
    await expect(page.locator('#toastContainer .toast-info', { hasText: 'Mic button hidden' })).toBeVisible();
  });
});
