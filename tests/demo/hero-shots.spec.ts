/**
 * Landing-page hero carousel stills — landing/screens/*.png.
 *
 * Re-shoots the seven slides from one consistent game (Breakside 6 – Rival City
 * 6, canonical roster, thirteenth point about a minute old) so the phone frames
 * on the landing page all show the same afternoon. Run whenever the in-game
 * chrome changes enough that the old stills look dated:
 *
 *   cd tests && HERO_SHOTS=1 npx playwright test --config=playwright.demo.config.ts demo/hero-shots.spec.ts
 *
 * Gated behind HERO_SHOTS so a plain `record-demos.sh` (which runs every spec
 * under demo/ with video on) skips it instead of spending three minutes on a
 * take it will never cut.
 *
 * Frames are 375×812 CSS px at 2× (750×1624), matching the phone frame the
 * carousel draws around them; the landscape slide rotates the viewport, which
 * is what flips the Field tab into its takeover layout (see fieldPbp.js).
 */
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { BACKEND_URL } from '../helpers/constants';
import { addRoster, beginGame, checkWholeLine, completePull, goToTab, makeTeam, scoreFor, startPoint } from './setup';

const OUT = path.resolve(__dirname, '..', '..', 'landing', 'screens');

/** The canonical fictional roster (ARCHITECTURE.md § Names in examples). */
const ROSTER = [
  { name: 'Alice', number: '7', gender: 'FMP' as const },
  { name: 'Bob', number: '11', gender: 'MMP' as const },
  { name: 'Charlie', number: '3', gender: 'MMP' as const },
  { name: 'Dana', number: '22', gender: 'FMP' as const },
  { name: 'Eve', number: '9', gender: 'FMP' as const },
  { name: 'Hank', number: '5', gender: 'MMP' as const },
  { name: 'Iris', number: '14', gender: 'FMP' as const },
  { name: 'Jake', number: '8', gender: 'MMP' as const },
  { name: 'Kris', number: '2', gender: 'MMP' as const },
  { name: 'Mia', number: '17', gender: 'FMP' as const },
];
const LINE_A = ['Alice', 'Bob', 'Charlie', 'Dana', 'Eve', 'Hank', 'Iris'];
const LINE_B = ['Alice', 'Bob', 'Dana', 'Eve', 'Jake', 'Kris', 'Mia'];

/** How old the running point is when the stills are taken. */
const POINT_AGE_MS = 75_000;

test.use({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  video: 'off',
});

/** Light theme, no hint toasts, and no 10 s cloud refresh mid-gesture (see cinema.ts). */
async function quiet(page: Page) {
  await page.addInitScript(() => {
    try {
      const k = 'breakside_advanced_settings';
      const s = JSON.parse(localStorage.getItem(k) || '{}');
      s['hints.hideAll'] = true;
      s['sync.refreshIntervalSec'] = 120;
      s['display.theme'] = 'light';
      localStorage.setItem(k, JSON.stringify(s));
    } catch (_) {}
  });
}

/** Chip then spot on the Field tab (fractions of the field box, portrait attacks up). */
async function fieldPass(page: Page, name: string, fx: number, fy: number) {
  await page.locator('.fp-chip').filter({ hasText: name }).first().click();
  const box = await page.locator('#fpField').boundingBox();
  if (!box) throw new Error('no #fpField box');
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await expect(page.locator('.fp-statusbar')).toContainText(name, { timeout: 8_000 });
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

test('hero-shots', async ({ page }) => {
  test.skip(!process.env.HERO_SHOTS, 'set HERO_SHOTS=1 to re-shoot the landing carousel stills');
  test.setTimeout(420_000);

  await quiet(page);
  await page.goto(`/?testMode=true&testUserId=hero-shots&api=${BACKEND_URL}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await makeTeam(page, 'Breakside');
  await addRoster(page, ROSTER);
  await beginGame(page, 'offense', 'Rival City');

  // Twelve points to 6–6, alternating lines. We start on offense and trade:
  // every point we win puts us on defense (pull) for the next, which they win.
  for (let i = 0; i < 12; i++) {
    const line = i % 2 === 0 ? LINE_A : LINE_B;
    const weScore = i % 2 === 0;
    await goToTab(page, 'line');
    await checkWholeLine(page, line);
    await startPoint(page);
    if (!weScore) await completePull(page, line.includes('Hank') ? 'Hank' : 'Jake');
    await page.waitForTimeout(1200);
    await goToTab(page, 'simple');
    if (weScore) {
      await scoreFor(page, line[0], line[1]);
    } else {
      await page.locator('#pbpTheyScoreBtn').click();
    }
    await page.waitForTimeout(1200);
  }
  await expect(page.locator('#gameScoreUs')).toHaveText('6');
  await expect(page.locator('#gameScoreThem')).toHaveText('6');

  // Thirteenth point, on offense, with the starting line; let the point timer
  // age so the header shows a plausible mid-point value rather than 0:0x.
  await goToTab(page, 'line');
  await checkWholeLine(page, LINE_A);
  await startPoint(page);
  await page.waitForTimeout(POINT_AGE_MS);

  await goToTab(page, 'simple');
  await shot(page, 'simple');

  await goToTab(page, 'full');
  await shot(page, 'full');

  await goToTab(page, 'field');
  await fieldPass(page, 'Alice', 0.5, 0.66);
  await shot(page, 'field');

  await fieldPass(page, 'Bob', 0.3, 0.5);
  await page.setViewportSize({ width: 812, height: 375 });
  await expect(page.locator('body')).toHaveClass(/fp-landscape-takeover/, { timeout: 5_000 });
  await shot(page, 'field-landscape');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('body')).not.toHaveClass(/fp-landscape-takeover/, { timeout: 5_000 });

  await goToTab(page, 'line');
  await shot(page, 'line');

  await goToTab(page, 'all');
  await shot(page, 'all');

  // Last, because it ends the point: "We Score" stops point-time accrual
  // before the attribution dialog opens, and the X close does not resume it,
  // so every tab after this one would render its between-points state.
  await goToTab(page, 'simple');
  await page.locator('#pbpWeScoreBtn').click();
  await expect(page.locator('#scoreAttributionDialog')).toBeVisible();
  await shot(page, 'simple-score');
});
