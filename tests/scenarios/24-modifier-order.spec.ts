/**
 * Throw-modifier order (playByPlay/eventAmend.js THROW_MODIFIERS)
 *
 * The stats a coach most wants to mark lead every modifier strip: break,
 * huck, layout, sky, hammer, reset. The Full tab strip reads "Last
 * pass/catch was a:" and omits swing (Field geometry sets it; the replay
 * editor can still edit it). The score dialog's flag buttons follow the
 * same order.
 */
import { test, expect, Page } from '@playwright/test';
import {
  goToApp, setupTeamWithPlayers, startGame, selectAllPlayers, startPoint,
} from '../helpers/app';

const uniqueTeam = () => `Modifier Testers ${Date.now().toString(36)}`;
const SHOT_DIR = process.env.BREAKSIDE_E2E_SHOT_DIR;

const row = (page: Page, name: string) =>
  page.locator('.full-pbp-player-row').filter({ hasText: name });

async function shot(page: Page, locator: ReturnType<Page['locator']>, name: string) {
  if (!SHOT_DIR) return;
  await locator.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

test.describe('throw modifier order', () => {
  test('Full tab strip and score dialog list break, huck, layout, sky, hammer, reset', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, uniqueTeam());
    await startGame(page, 'offense');
    await selectAllPlayers(page);
    await startPoint(page);
    await page.waitForTimeout(4_500);   // let the post-start sync echo land

    // Full tab: catch the pull, complete one pass, read the strip.
    await page.locator('#headerSegControl button[data-tab="full"]').click();
    await row(page, 'Alice').locator('.full-pbp-row-action-pullcatch').click();
    await expect(row(page, 'Alice')).toHaveClass(/is-holder/);
    await row(page, 'Bob').locator('.full-pbp-name-btn').click();
    await expect(row(page, 'Bob')).toHaveClass(/is-holder/);

    const strip = page.locator('#fullPbpModifierRow');
    await expect(strip.locator('.full-pbp-modifier-row-label')).toHaveText('Last pass/catch was a:');
    await expect(strip.locator('.full-pbp-modifier-chip:not(.full-pbp-set-chip)'))
      .toHaveText(['break', 'huck', 'layout', 'sky', 'hammer', 'reset']);
    await shot(page, strip, 'full-strip');

    // Score dialog from the Simple tab: the flag buttons, same order.
    await page.locator('#headerSegControl button[data-tab="simple"]').click();
    await page.click('#pbpWeScoreBtn');
    const dialog = page.locator('#scoreAttributionDialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator('.throw-flag-btn')).toHaveText(['Break', 'Huck', 'Layout', 'Sky', 'Hammer']);
    await shot(page, dialog.locator('.throw-flags-container'), 'score-flags');
    await page.click('#continuePossessionBtn');
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});
