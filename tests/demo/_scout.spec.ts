/**
 * Not a clip — a scouting pass that screenshots every screen the tutorial
 * clips will visit, so choreography can be written against what the app
 * actually renders at 480×960. Safe to delete; kept because re-running it is
 * cheaper than guessing at selectors.
 *
 * Split into small independent tests on purpose: one dead end shouldn't cost
 * the whole sweep.
 *
 *   npx playwright test --config=playwright.demo.config.ts demo/_scout.spec.ts
 */
import { test, expect, Page } from '@playwright/test';
import { beginGame, checkWholeLine, goToTab, makeTeamWithRoster, startPoint } from './setup';

const SHOTS = process.env.DEMO_SHOT_DIR || '/tmp/breakside-scout';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });

/** Team + roster + game + one point started, on the given tab. */
async function inPoint(page: Page, user: string, tab: 'simple' | 'full' | 'field' | 'line' | 'log' | 'all') {
  await makeTeamWithRoster(page, user);
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, tab);
  await startPoint(page);
  await page.waitForTimeout(5000);   // let the sync echo pass
}

test('scout: full tab', async ({ page }) => {
  await inPoint(page, 'sc-full', 'full');
  await shot(page, '30-full-offense');
  console.log('FULL TAB TEXT:\n' + (await page.locator('.game-screen-container').innerText()));
  // The structure matters more than the text here — the clips need to know
  // which element is a player row and which is an action button.
  const html = await page.locator('.game-screen-container').innerHTML();
  console.log('FULL TAB HTML:\n' + html.replace(/\s+/g, ' ').slice(0, 6000));
});

test('scout: field tab', async ({ page }) => {
  await inPoint(page, 'sc-field', 'field');
  await shot(page, '32-field-offense');
  console.log('FIELD TAB:\n' + (await page.locator('.game-screen-container').innerText()));
});

test('scout: log + all tabs', async ({ page }) => {
  await inPoint(page, 'sc-log', 'simple');
  await page.locator('#pbpWeScoreBtn').click();
  await page.locator('#throwerButtons .player-button').filter({ hasText: 'Alice' }).click();
  await page.locator('#receiverButtons .player-button').filter({ hasText: 'Bob' }).click();
  await page.waitForTimeout(1200);

  await goToTab(page, 'log');
  await page.waitForTimeout(800);
  await shot(page, '33-log');

  await goToTab(page, 'all');
  await page.waitForTimeout(800);
  await shot(page, '34-all');

  await page.locator('#gameMenuBtn').click();
  await page.waitForTimeout(700);
  await shot(page, '35-game-menu');
  console.log('GAME MENU:\n' + (await page.locator('#gameMenuDropdown').innerText()));
});

test('scout: key play panels', async ({ page }) => {
  await inPoint(page, 'sc-kp', 'simple');
  await page.locator('#pbpKeyPlayBtn').click();
  await page.waitForTimeout(800);
  console.log('KEYPLAY CLOSED:\n' + (await page.locator('#keyPlayPanels').innerText()));
  for (const panel of ['Throws', 'Turnover', 'Defense']) {
    await page.locator('#keyPlayPanels').getByText(panel, { exact: true }).click();
    await page.waitForTimeout(600);
    await shot(page, `36-keyplay-${panel.toLowerCase()}`);
    console.log(`KEYPLAY ${panel} OPEN:\n` + (await page.locator('#keyPlayPanels').innerText()));
  }
});

test('scout: edit player dialog', async ({ page }) => {
  await makeTeamWithRoster(page, 'sc-ep');
  await page.locator('#showRosterBtn').click();
  await page.waitForTimeout(600);
  await shot(page, '37-roster');

  await page.locator('#rosterList .roster-name-column').filter({ hasText: 'Alice' }).click();
  await expect(page.locator('#editPlayerDialog')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(600);
  await shot(page, '38-edit-player');
  console.log('EDIT PLAYER:\n' + (await page.locator('#editPlayerDialog').innerText()));
});

test('scout: team settings', async ({ page }) => {
  await makeTeamWithRoster(page, 'sc-ts');
  await page.locator('#backFromStartGameBtn').click();
  await page.waitForTimeout(700);
  await shot(page, '39-team-list');
  console.log('TEAM LIST:\n' + (await page.locator('#selectTeamScreen').innerText()));
  console.log('TEAM LIST HTML:\n' + (await page.locator('#teamList').innerHTML()).slice(0, 2500));
});

test('scout: game summary', async ({ page }) => {
  await inPoint(page, 'sc-gs', 'simple');
  await page.locator('#pbpWeScoreBtn').click();
  await page.locator('#throwerButtons .player-button').filter({ hasText: 'Alice' }).click();
  await page.locator('#receiverButtons .player-button').filter({ hasText: 'Bob' }).click();
  await page.waitForTimeout(1200);

  page.once('dialog', d => d.accept());
  await page.locator('#gameMenuBtn').click();
  await page.waitForTimeout(400);
  await page.locator('#menuEndGame').click();
  await expect(page.locator('#gameSummaryScreen')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  await shot(page, '40-game-summary');
  console.log('SUMMARY:\n' + (await page.locator('#gameSummaryScreen').innerText()).slice(0, 1500));
});
