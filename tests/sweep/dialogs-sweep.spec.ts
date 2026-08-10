/**
 * Dialog sweep — the other half of the theme pass.
 *
 * theme-sweep.spec.ts walks the app the way a coach does, which reaches the
 * screens on the happy path and misses everything gated behind a state that is
 * awkward to reach (auth, PWA install prompt, pending-sync, invite created,
 * error/success banners). Those are exactly where an unthemed color hides for
 * months.
 *
 * So this one is exhaustive by construction rather than by itinerary: it
 * enumerates every top-level section and .modal in index.html, forces each
 * visible in turn against a populated app, and screenshots + contrast-audits
 * it. A dialog whose colors were never touched shows up here even if no test
 * knows how to open it legitimately.
 *
 * Caveat, and why this does NOT replace the walk: a force-shown dialog has
 * whatever content the static HTML gives it, so dynamically-rendered rows are
 * empty. It catches chrome (frames, headers, labels, buttons), not content.
 *
 *   BREAKSIDE_THEME=dark npx playwright test --config sweep/sweep.config.ts \
 *     dialogs-sweep
 */
import { test, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { goToApp, setupTeamWithPlayers } from '../helpers/app';
import { auditContrast, Finding } from './contrast';

const THEME = process.env.BREAKSIDE_THEME === 'dark' ? 'dark' : 'light';
const SHOTS = path.join(__dirname, 'shots', `${THEME}-dialogs`);
fs.mkdirSync(SHOTS, { recursive: true });

const findings: Finding[] = [];

test.beforeEach(async ({ page }) => {
  await page.addInitScript((theme) => {
    localStorage.setItem('breakside_advanced_settings',
      JSON.stringify({ 'display.theme': theme, 'hints.hideAll': true }));
  }, THEME);
});

test('sweep every dialog', async ({ page }) => {
  test.setTimeout(300_000);
  await goToApp(page);
  // Give the dialogs real data behind them, so a transparent panel or a
  // washed-out overlay is visible against actual content rather than a blank
  // page — several of these are scrims over the app.
  await setupTeamWithPlayers(page, 'Night Owls');

  const ids: string[] = await page.evaluate(() => {
    const out = new Set<string>();
    document.querySelectorAll('section[id], .modal[id], .dialog[id]').forEach(el => out.add(el.id));
    // Inline banners that only ever appear on an error path
    ['authError', 'authSuccess', 'teamListWarning', 'signupSection',
     'resetPasswordSection', 'versionOverlay'].forEach(id => {
      if (document.getElementById(id)) out.add(id);
    });
    return [...out].filter(Boolean);
  });

  for (const id of ids) {
    // Show exactly this one, hide its siblings, so each shot is unambiguous.
    const shown = await page.evaluate((targetId) => {
      const target = document.getElementById(targetId);
      if (!target) return false;
      document.querySelectorAll<HTMLElement>('section[id], .modal[id]').forEach(el => {
        if (el.id !== targetId) el.style.display = 'none';
      });
      const isModal = target.classList.contains('modal');
      target.style.display = isModal ? 'flex' : 'block';
      // Give empty banners some text so their colors are actually rendered.
      if (!target.textContent?.trim()) target.textContent = 'Sample message text';
      window.scrollTo(0, 0);
      return true;
    }, id);
    if (!shown) continue;
    await page.waitForTimeout(250);
    const file = path.join(SHOTS, `${id}.png`);
    await page.screenshot({ path: file });
    findings.push(...await auditContrast(page, id));
  }

  console.log(`captured ${ids.length} dialogs/screens`);
});

test.afterAll(() => {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.kind}|${f.selector}|${f.sample}`;
    const prev = byKey.get(key);
    if (!prev || f.ratio < prev.ratio) byKey.set(key, f);
  }
  const rows = [...byKey.values()].sort((a, b) => a.ratio - b.ratio);
  fs.writeFileSync(path.join(SHOTS, '..', `contrast-${THEME}-dialogs.json`),
    JSON.stringify(rows, null, 2));
  console.log(`${THEME} dialogs: ${rows.length} contrast findings`);
  for (const r of rows.slice(0, 30)) {
    console.log(`  ${r.ratio.toFixed(2)}  ${r.kind.padEnd(6)} ${r.screen.padEnd(22)} ` +
      `${r.fg} on ${r.bg}  ${r.selector}  ${r.sample.slice(0, 34)}`);
  }
});
