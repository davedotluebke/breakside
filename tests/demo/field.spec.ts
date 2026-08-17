/**
 * Field-mode clip — recording plays on the field diagram.
 *
 * Split out from details.spec.ts because Field mode has its own vocabulary of
 * gestures (chip then spot, geometry-classified modifiers) and its own failure
 * modes, and because it is the one clip that used to be borrowed from the
 * landing page — which only exists in light, and the docs need both themes.
 *
 *   ./scripts/record-demos.sh field
 */
import { test, expect, Page } from '@playwright/test';
import {
  BEAT, DRAG_LIFT_PX, SYNC_ECHO_WAIT, dragLocatorTo, glide, holdEnding, markTrim,
  resetCursor, tapAt, tapLocator,
} from './cinema';
import { beginGame, checkWholeLine, goToTab, makeTeamWithRoster, startPoint } from './setup';

/** A player's chip in the left rail. */
const chip = (page: Page, name: string) =>
  page.locator('.fp-chip').filter({ hasText: name }).first();

/**
 * Tap a spot on the field by fraction of its box.
 *
 * Fractions, not pixels: the field's size depends on the panel layout, which
 * differs between tabs and themes. Portrait, the first point attacks UP, so
 * small y is the endzone we're attacking (DEMO_VIDEOS.md #7).
 */
async function tapField(page: Page, fx: number, fy: number, after = BEAT.action) {
  const box = await page.locator('#fpField').boundingBox();
  if (!box) throw new Error('no #fpField box');
  await tapAt(page, box.x + box.width * fx, box.y + box.height * fy, { after });
}

/** Verify rather than hope: a swallowed gesture plays the rest of the point one
 *  player off and the video still renders. DEMO_VIDEOS.md lesson #1. */
async function expectHolder(page: Page, name: string) {
  await expect(page.locator('.fp-statusbar')).toContainText(name, { timeout: 8_000 });
}

/** Chip, then spot — the two-tap gesture. */
async function tapPass(page: Page, name: string, fx: number, fy: number, after = BEAT.action) {
  await tapLocator(page, chip(page, name), { after: 420 });
  await tapField(page, fx, fy, after);
  await expectHolder(page, name);
}

/**
 * Drag the chip onto the spot — the same event in one gesture.
 *
 * The app records the drop at the pegman's ✕, which floats DRAG_LIFT_PX above
 * the pointer so your finger isn't covering the spot you're aiming at. So the
 * mouse has to finish that far BELOW the intended location (DEMO_VIDEOS.md #3).
 */
async function dragPass(page: Page, name: string, fx: number, fy: number, after = BEAT.action) {
  const box = await page.locator('#fpField').boundingBox();
  if (!box) throw new Error('no #fpField box');
  await dragLocatorTo(
    page,
    chip(page, name),
    box.x + box.width * fx,
    box.y + box.height * fy + DRAG_LIFT_PX,
    after,
  );
  await expectHolder(page, name);
}

test('field-01-offense', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'field01');
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'field');
  await startPoint(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor(240, 900);
  await markTrim(page, t0, 'field-01-offense');

  // Pick up near our own end, then work it up the field. Nobody taps a
  // modifier: the geometry classifies each throw as it lands. The wide ones to
  // Bob and Carol cross enough of the width to read as swings, and the last one
  // covers enough of the playing field to read as a huck.
  //
  // "Enough" is measured against the playing field, not the diagram: the
  // endzones are the outer 18.2% at each end (DEMO_VIDEOS.md #7), so the 70yd
  // between goal lines is 63.6% of the field's height and the 50% huck
  // threshold is ~32% of it. Dave→Eve covers 38%, comfortably over. Eve catches
  // at 0.22 — outside the endzone, since a catch inside it is a score and this
  // clip is about entry, not scoring.
  //
  // Both gestures appear, because both are worth knowing: the drag shows the
  // pegman and where the disc is going in one motion, the two-tap is quicker
  // once you know the rail. They record identical events.
  await dragPass(page, 'Alice', 0.50, 0.76, BEAT.notable);
  await tapPass(page, 'Bob', 0.24, 0.68, BEAT.notable);
  await dragPass(page, 'Carol', 0.72, 0.64, BEAT.notable);
  await tapPass(page, 'Dave', 0.40, 0.60);
  await dragPass(page, 'Eve', 0.55, 0.22, BEAT.notable);

  // Assert the classification rather than assuming it — if a threshold moves,
  // this clip should fail rather than quietly stop demonstrating its subject.
  await expect(page.locator('.fp-modbtn.on').filter({ hasText: 'Huck' }))
    .toBeVisible({ timeout: 8_000 });

  // Rest on the field with the possession drawn across it.
  await glide(page, 240, 620);
  await holdEnding(page, 'field-01-offense');
});
