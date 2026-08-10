/** Throwaway probe — not a clip. Delete once the question it answers is settled. */
import { test, expect, Page } from '@playwright/test';
import { BEAT, SYNC_ECHO_WAIT, resetCursor, tapLocator } from './cinema';
import { beginGame, checkWholeLine, goToTab, makeTeamWithRoster, startPoint } from './setup';

const row = (page: Page, n: string) => page.locator('.full-pbp-player-row').filter({ hasText: n });

test('probe: full-01 exact sequence', async ({ page }) => {
  page.on('console', m => console.log(`[page:${m.type()}] ${m.text()}`.slice(0, 240)));
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));

  await makeTeamWithRoster(page, 'probe2');
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'full');
  await startPoint(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor();

  await tapLocator(page, row(page, 'Alice').locator('.full-pbp-name-btn'), { after: BEAT.notable });
  await tapLocator(page, row(page, 'Bob').locator('.full-pbp-name-btn'), { after: BEAT.action });
  await tapLocator(page, row(page, 'Carol').locator('.full-pbp-name-btn'), { after: BEAT.action });
  await tapLocator(page, page.locator('.full-pbp-modifier-chip').filter({ hasText: 'huck' }),
    { after: BEAT.notable });

  console.log('PROBE about to tap Score');
  const btn = row(page, 'Grace').locator('.full-pbp-row-action-score');
  console.log('PROBE box:', JSON.stringify(await btn.boundingBox()));
  console.log('PROBE elementFromPoint:', await page.evaluate(() => {
    const el = document.elementFromPoint(439, 564);
    return el ? el.className + ' | ' + (el.textContent || '').slice(0, 20) : 'none';
  }));

  await tapLocator(page, btn, { after: 1500 });

  const dlg = page.locator('#scoreAttributionDialog');
  console.log('PROBE dialog visible:', await dlg.isVisible().catch(() => 'err'));
  console.log('PROBE score:', await page.locator('#gameScoreUs').innerText());
  await page.screenshot({ path: '/tmp/breakside-scout/probe2.png' });
});
