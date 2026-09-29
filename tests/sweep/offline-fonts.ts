/**
 * Serve the app's web fonts from local npm packages instead of the CDNs.
 *
 * Layout audits measure text, so they are only as good as the fonts they
 * render with: Poppins is noticeably wider than the fallback sans-serif, and a
 * missing Font Awesome turns every icon button into an empty box of the wrong
 * width. Claude Code cloud sessions cannot reach cdnjs, so there the sweep
 * would audit a layout no user ever sees.
 *
 * Point BREAKSIDE_SWEEP_FONTS at a node_modules directory holding
 * @fortawesome/fontawesome-free@5.15.3 (the version index.html loads),
 * @fontsource/poppins and @fontsource/jetbrains-mono, e.g.
 *
 *   mkdir -p /tmp/fonts && cd /tmp/fonts && npm i @fortawesome/fontawesome-free@5.15.3 \
 *     @fontsource/poppins @fontsource/jetbrains-mono
 *   BREAKSIDE_SWEEP_FONTS=/tmp/fonts/node_modules npx playwright test ...
 *
 * Unset (a laptop with normal network access) this does nothing.
 */
import { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const FA_PREFIX = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/';
const LOCAL_FONT_PREFIX = 'https://fonts.gstatic.com/breakside-local/';

function fontFaceCss(family: string, pkg: string, weights: number[]) {
  return weights.map(w => `@font-face {
  font-family: '${family}'; font-style: normal; font-weight: ${w}; font-display: swap;
  src: url(${LOCAL_FONT_PREFIX}${pkg}/${pkg}-latin-${w}-normal.woff2) format('woff2');
}`).join('\n');
}

export async function serveFontsLocally(page: Page) {
  const dir = process.env.BREAKSIDE_SWEEP_FONTS;
  if (!dir) return;
  const fa = path.join(dir, '@fortawesome', 'fontawesome-free');
  if (!fs.existsSync(fa)) throw new Error(`BREAKSIDE_SWEEP_FONTS: no ${fa}`);

  await page.route(`${FA_PREFIX}**`, route => {
    const rel = route.request().url().slice(FA_PREFIX.length).split('?')[0];
    const file = path.join(fa, rel);
    if (!file.startsWith(fa) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    // Fonts load in CORS mode; without this header the browser discards them.
    return route.fulfill({ path: file, headers: { 'Access-Control-Allow-Origin': '*' } });
  });

  await page.route('https://fonts.googleapis.com/css2**', route => {
    const url = route.request().url();
    const css = url.includes('Poppins')
      ? fontFaceCss('Poppins', 'poppins', [300, 400, 500, 600, 700])
      : url.includes('JetBrains')
        ? fontFaceCss('JetBrains Mono', 'jetbrains-mono', [400, 700])
        : '';
    return route.fulfill({ contentType: 'text/css', body: css });
  });

  await page.route(`${LOCAL_FONT_PREFIX}**`, route => {
    const [pkg, file] = route.request().url().slice(LOCAL_FONT_PREFIX.length).split('/');
    const p = path.join(dir, '@fontsource', pkg, 'files', file);
    if (!fs.existsSync(p)) return route.fulfill({ status: 404 });
    return route.fulfill({
      path: p, contentType: 'font/woff2', headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
}
