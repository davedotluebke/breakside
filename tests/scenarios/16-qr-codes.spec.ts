/**
 * QR codes for share links and invites (utils/qrCode.js + the two dialogs)
 *
 * Pins, end to end against the test backend:
 *   - creating a share link opens its QR panel by itself, with a real SVG
 *     symbol whose quiet zone matches the encoder's contract; the QR button
 *     toggles the panel and reports its state through aria-expanded
 *   - the Invite Created modal renders the invite link as a code
 *
 * Decodability is pinned in tests/unit/qrCode.test.mjs (an independent
 * decoder round-trips every level, version and mask), so here the check is
 * that the dialogs actually mount the symbol for the right URL.
 */
import { test, expect, Page } from '@playwright/test';
import { goToApp, setupTeamWithPlayers, startGame } from '../helpers/app';
import { waitForGameOnServer } from '../helpers/controllerApi';

/** The identity ?testMode=true injects (auth/auth.js); the test backend honours it. */
const TEST_USER_ID = 'test-user';

async function openGameMenuItem(page: Page, itemId: string) {
  await page.click('#gameMenuBtn');
  await expect(page.locator('#gameMenuDropdown')).toBeVisible();
  await page.click(itemId);
}

test.describe('QR codes', () => {
  test('share link: created link opens with its QR code, button toggles it', async ({ page, request }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    const gameId = await page.evaluate(() => (window as any).currentGame().id as string);
    await waitForGameOnServer(request, gameId, TEST_USER_ID);

    await openGameMenuItem(page, '#menuShareGame');
    const modal = page.locator('#shareGameModal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#shareLinksList')).toContainText('No active links yet');

    await modal.locator('#createShareLinkBtn').click();
    const row = modal.locator('.share-link-row').first();
    await expect(row).toBeVisible({ timeout: 8_000 });
    const url = await row.getAttribute('data-share-url');
    expect(url).toMatch(/\/view\/[A-Za-z0-9]+$/);

    // Opened by itself for the link that was just made.
    const panel = modal.locator('.share-qr-panel').first();
    const qrBtn = row.locator('.share-qr-btn');
    await expect(panel).toBeVisible();
    await expect(qrBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(qrBtn).toHaveText('QR');
    await expect(panel.locator('.share-qr-url')).toHaveText(url!);

    // A real symbol: square viewBox with the four-module quiet zone on each
    // side of an odd module count (17 + 4·version), a white field, dark path.
    const svg = panel.locator('svg');
    await expect(svg).toHaveAttribute('aria-label', `QR code for ${url}`);
    const viewBox = await svg.getAttribute('viewBox');
    const dim = Number(viewBox!.split(' ')[3]);
    expect(viewBox).toBe(`0 0 ${dim} ${dim}`);
    expect((dim - 8 - 17) % 4).toBe(0);
    expect(dim - 8).toBeGreaterThanOrEqual(21);
    await expect(svg.locator('rect')).toHaveAttribute('fill', '#ffffff');
    await expect(svg.locator('path')).toHaveAttribute('fill', '#000000');

    // Toggle off and on again.
    await qrBtn.click();
    await expect(panel).toBeHidden();
    await expect(qrBtn).toHaveAttribute('aria-expanded', 'false');
    await qrBtn.click();
    await expect(panel).toBeVisible();
    await expect(qrBtn).toHaveAttribute('aria-expanded', 'true');
  });

  test('invite: the Invite Created modal carries the link as a QR code', async ({ page, request }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Night Owls');
    await startGame(page, 'offense');
    const gameId = await page.evaluate(() => (window as any).currentGame().id as string);
    await waitForGameOnServer(request, gameId, TEST_USER_ID);

    await openGameMenuItem(page, '#menuTeamSettings');
    await expect(page.locator('#teamSettingsScreen')).toBeVisible();
    await page.click('#createCoachInviteBtn');

    const modal = page.locator('#inviteCreatedModal');
    await expect(modal).toBeVisible({ timeout: 8_000 });
    const link = await page.locator('#inviteLinkText').inputValue();
    expect(link).toMatch(/\/join\/[A-Za-z0-9]+$/);

    const qr = page.locator('#inviteQrCode');
    await expect(qr).toBeVisible();
    await expect(qr.locator('svg')).toHaveAttribute('aria-label', `QR code for ${link}`);
    await expect(qr.locator('.invite-qr-caption')).toContainText('scan');
    await expect(qr.locator('svg rect')).toHaveAttribute('fill', '#ffffff');
  });
});
