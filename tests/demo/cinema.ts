/**
 * Cinema helpers — shared choreography for the tutorial/demo video clips.
 *
 * These are NOT test helpers. They exist to make Playwright produce footage a
 * human would believe they recorded on a phone: a visible touch cursor, eased
 * pointer glides, and deliberate pauses. See DEMO_VIDEOS.md for the style rules
 * these implement (the values here ARE the series' visual signature — changing
 * them makes new clips stop matching the existing Field-mode demo).
 *
 * Specs under tests/demo/ are recorded with playwright.demo.config.ts and are
 * deliberately outside the default config's testDir, so the e2e suite and the
 * pre-merge hook never run them.
 */
import { expect, Page } from '@playwright/test';

// ─── Pacing constants ───────────────────────────────────────────────────────
// Named so specs read as choreography, not as magic numbers.

export const BEAT = {
  /** Between routine actions. */
  action: 800,
  /** After something notable happens (dialog opens, chip lights up). */
  notable: 1300,
  /** Let the viewer read a screen we just landed on. */
  read: 1800,
  /** Final hold on the payoff shot before the clip ends. */
  hold: 3000,
  /** Settle before pressing down, after gliding to a target. */
  settle: 250,
  /** After mouse.down, before mouse.up. */
  press: 140,
  /** Hold at the end of a drag before releasing. */
  dragRelease: 320,
};

/**
 * The post-Start-Point cloud-sync echo replaces game.points ~3–5s in and
 * discards in-flight entry state, silently eating the first gesture.
 * DEMO_VIDEOS.md gotcha #2 — wait it out before the first on-camera action.
 */
export const SYNC_ECHO_WAIT = 4500;

/** Field-mode chip drops land DRAG_LIFT_PX above the pointer. Gotcha #3. */
export const DRAG_LIFT_PX = 56;

// ─── Fake touch cursor ──────────────────────────────────────────────────────

/**
 * Inject the orange touch dot. Playwright videos have no cursor, so without
 * this the footage shows things happening with nothing causing them.
 *
 * Must be installed via addInitScript BEFORE the first navigation so it
 * survives reloads. Values are fixed by the series style — don't tune them.
 */
const CURSOR_SCRIPT = `
(() => {
  if (window.__demoCursor) return;
  window.__demoCursor = true;
  const install = () => {
    if (!document.body) return void requestAnimationFrame(install);
    const dot = document.createElement('div');
    dot.id = '__demo_cursor';
    dot.style.cssText = [
      'position:fixed',
      'left:0','top:0',
      'width:26px','height:26px',
      'margin-left:-13px','margin-top:-13px',
      'border-radius:50%',
      'background:rgba(255,90,0,.35)',
      'border:2.5px solid rgba(255,90,0,.95)',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)',
      'pointer-events:none',
      'z-index:2147483647',
      'opacity:0',
      'transition:width .09s ease, height .09s ease, margin .09s ease, background .09s ease',
    ].join(';');
    document.body.appendChild(dot);

    const move = (e) => {
      dot.style.opacity = '1';
      dot.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
    };
    const press = () => {
      dot.style.width = '18px'; dot.style.height = '18px';
      dot.style.marginLeft = '-9px'; dot.style.marginTop = '-9px';
      dot.style.background = 'rgba(255,90,0,.75)';
    };
    const release = () => {
      dot.style.width = '26px'; dot.style.height = '26px';
      dot.style.marginLeft = '-13px'; dot.style.marginTop = '-13px';
      dot.style.background = 'rgba(255,90,0,.35)';
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerdown', (e) => { move(e); press(); }, true);
    addEventListener('pointerup', release, true);
    addEventListener('pointercancel', release, true);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
`;

/**
 * Quiet the two things that interrupt a take.
 *
 * `hints.hideAll` stops the new-user hint toasts popping mid-clip.
 *
 * `sync.refreshIntervalSec` is the bigger one: the default 10s cloud refresh
 * replaces game.points and re-renders, and a gesture that lands in that window
 * is silently swallowed — the same failure DEMO_VIDEOS.md gotcha #2 describes
 * right after Start Point, except it recurs every 10 seconds, so any clip with
 * more than ~10s of choreography eventually eats one. 120 is the setting's
 * clamped maximum, which is longer than any clip.
 */
const QUIET_SCRIPT = `
(() => {
  try {
    const k = 'breakside_advanced_settings';
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    s['hints.hideAll'] = true;
    s['sync.refreshIntervalSec'] = 120;
    localStorage.setItem(k, JSON.stringify(s));
  } catch (_) {}
})();
`;

/**
 * Install the cursor + hint suppression. Call once, before page.goto().
 */
export async function setupCinema(page: Page) {
  await page.addInitScript(CURSOR_SCRIPT);
  await page.addInitScript(QUIET_SCRIPT);
}

// ─── Motion ─────────────────────────────────────────────────────────────────

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Where the fake cursor currently is, so glides start from the right place. */
let cursorX = 240;
let cursorY = 700;

/** Reset the cursor origin — call at the start of each clip. */
export function resetCursor(x = 240, y = 860) {
  cursorX = x;
  cursorY = y;
}

/**
 * Glide the pointer to (x, y) with ease-in-out interpolation. Short hops get
 * fewer, faster steps so the cursor doesn't look like it's wading through mud.
 */
export async function glide(page: Page, x: number, y: number) {
  const dist = Math.hypot(x - cursorX, y - cursorY);
  const short = dist < 160;
  const steps = short ? 14 : 22;
  const delay = short ? 18 : 22;
  const x0 = cursorX;
  const y0 = cursorY;

  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps);
    await page.mouse.move(x0 + (x - x0) * t, y0 + (y - y0) * t);
    await page.waitForTimeout(delay);
  }
  cursorX = x;
  cursorY = y;
}

/** Center of an element, in viewport coordinates. */
export async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible({ timeout: 10_000 });
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Glide to a selector and tap it. This is the workhorse — prefer it over
 * page.click() everywhere on camera, since page.click() teleports the pointer.
 */
export async function tap(page: Page, selector: string, opts: { settle?: number; after?: number } = {}) {
  const { x, y } = await centerOf(page, selector);
  await glide(page, x, y);
  await page.waitForTimeout(opts.settle ?? BEAT.settle);
  await page.mouse.down();
  await page.waitForTimeout(BEAT.press);
  await page.mouse.up();
  await page.waitForTimeout(opts.after ?? BEAT.action);
}

/** Tap a Playwright Locator (for text filters and :has-text chains). */
export async function tapLocator(
  page: Page,
  locator: ReturnType<Page['locator']>,
  opts: { settle?: number; after?: number } = {},
) {
  await expect(locator).toBeVisible({ timeout: 10_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('no bounding box for locator');
  await glide(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(opts.settle ?? BEAT.settle);
  await page.mouse.down();
  await page.waitForTimeout(BEAT.press);
  await page.mouse.up();
  await page.waitForTimeout(opts.after ?? BEAT.action);
}

/** Tap at raw viewport coordinates (Field mode). */
export async function tapAt(page: Page, x: number, y: number, opts: { settle?: number; after?: number } = {}) {
  await glide(page, x, y);
  await page.waitForTimeout(opts.settle ?? BEAT.settle);
  await page.mouse.down();
  await page.waitForTimeout(BEAT.press);
  await page.mouse.up();
  await page.waitForTimeout(opts.after ?? BEAT.action);
}

/** Press and hold — long-press menus (possession set list, field side flip). */
export async function longPress(page: Page, selector: string, ms = 700, after = BEAT.notable) {
  const { x, y } = await centerOf(page, selector);
  await glide(page, x, y);
  await page.waitForTimeout(BEAT.settle);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(after);
}

/** Drag from a selector to raw coordinates, with a hold before release. */
export async function dragTo(page: Page, selector: string, x: number, y: number, after = BEAT.action) {
  const from = await centerOf(page, selector);
  await glide(page, from.x, from.y);
  await page.waitForTimeout(BEAT.settle);
  await page.mouse.down();
  await page.waitForTimeout(BEAT.press);
  await glide(page, x, y);
  await page.waitForTimeout(BEAT.dragRelease);
  await page.mouse.up();
  await page.waitForTimeout(after);
}

/**
 * Type into a field the way a person does — a visible tap on the input, then
 * per-character delay. page.fill() would make text appear instantaneously.
 */
export async function typeInto(page: Page, selector: string, text: string, after = BEAT.action) {
  await tap(page, selector, { after: 200 });
  await page.locator(selector).type(text, { delay: 55 });
  await page.waitForTimeout(after);
}

// ─── Trim bookkeeping ───────────────────────────────────────────────────────

/**
 * Mark the end of off-camera setup. Prints DEMO_TRIM_MS for the post-production
 * ffmpeg -ss offset, then pauses so the first on-camera frame isn't mid-action.
 */
export async function markTrim(page: Page, t0: number, label: string) {
  const ms = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`DEMO_TRIM_MS[${label}]=${ms}`);
  // A beat of the starting screen before anything moves. Shorter than this and
  // the clip opens mid-gesture, which reads as a jump cut.
  await page.waitForTimeout(1000);
}

/**
 * Hold the final payoff shot, then declare the take good.
 *
 * The DEMO_OK line is what record-demos.sh gates cutting on. Without it a take
 * that failed halfway still has a video.webm and a DEMO_TRIM_MS line, so the
 * cutter would happily encode and ship a truncated clip — exactly the "it
 * passed but the footage is wrong" trap in DEMO_VIDEOS.md. Only a clip that
 * reaches its own last line gets encoded.
 */
export async function holdEnding(page: Page, label: string, ms = BEAT.hold) {
  await page.waitForTimeout(ms);
  // eslint-disable-next-line no-console
  console.log(`DEMO_OK[${label}]`);
}
