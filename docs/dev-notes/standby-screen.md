# Standby screen

Status: shipped — built on branch `standby-screen` 2026-09-19, merged to main 2026-09-20 (2.2.0). The idle timer was added on branch `standby-timer` 2026-09-22 (see § Idle timer below). The mechanism, the stacking order and the ☀ contract are in ARCHITECTURE.md § Power Management → Standby screen. This note holds the decisions behind them and the verification recipe.

## Decisions

- **Tap enters standby; press-and-hold releases the wake lock.** The 2026-08-09 design said to "repurpose" the ☀. The release-the-lock toggle was kept on the same button as a 450 ms hold (the set picker's long-press, `ui/setPicker.js`) rather than dropped, because it still has a real use on an LCD phone, where black pixels save nothing and letting the screen sleep is the only saving. A toast confirms each hold; a dimmed icon under a thumb is easy to miss. The hold's trailing `click` is swallowed by a flag, and the flag is reset on the next press so an iOS long-press that never fires a click cannot eat the tap after it.
- **Exit on `click`, keep intercepting through the fade.** Exiting on `pointerup` and hiding at once lets the browser's synthesized click land on the control that is now under the finger. The 180 ms opacity fade doubles as a guard for a bounced double-tap. Under `prefers-reduced-motion` the fade collapses to nothing and the guard rests on the click-target rule alone, which is the one that matters.
- **Mirror the DOM, own no timer.** A `MutationObserver` on the two score cells and the countdown text costs nothing between changes. The alternative, a 1 s repaint loop of its own, would have meant a new entry in `utils/powerPolicy.js` for a screen whose whole purpose is to cost less. The pure read rules (`utils/standbyView.js`) exist so the observer callback has nothing to test.
- **No countdown before the first pull.** `startNewGame` (`game/gameLogic.js`) does not start the between-points countdown; only a point ending does (`moveToNextPoint` in `game/pointManagement.js`). Standby shows what the game shows. The first e2e draft expected a countdown on a fresh game and failed on exactly that; the test was wrong, not the feature.
- **Toasts stay above.** A Line Coach in standby still has to see a handoff request, and a share/join toast is harmless lit area for a few seconds. Dialogs (`z-index: 1000`) sit below; a dialog can only open from a control the overlay is covering anyway.
- **`theme-color` goes to black while up** and is handed back by re-running `applyTheme()`, not by restoring the value seen on the way in: an `auto` preference can re-resolve mid-game (dusk), and the saved value would then be the wrong theme's. iOS reads its standalone status-bar style once at launch, so this helps Android and in-browser use only.
- **Visible in every game, wake lock or not.** The old button hid itself where `navigator.wakeLock` was absent or the setting was off; standby needs neither, so the button now keys off the power plan's `inGame` and the icon alone reports the lock. Headless Chromium refuses the lock, which is why the e2e can rely on the button being there.

## Idle timer (2026-09-22)

The mechanism and the gate table are in ARCHITECTURE.md § Standby screen. Decisions worth keeping:

- **The warning is a toast, and the toast is the cancel.** The maintainer's design: "Idle for N seconds, entering standby in 5 seconds" with the 5 counting down, a smaller "Long-press ☀ to toggle standby timer" line, and dismissing the toast (tap, × or swipe) cancels the standby because dismissing is itself a tap. In practice *any* input cancels — the toast is just the obvious target. `showControllerToast` inserts its message as HTML, which is what lets the countdown number be bold and the hint smaller; the number is updated in place each tick rather than re-toasting.
- **The fade-in must not swallow, the fade-out must.** Opposite rules for the two directions, for the same reason: the coach's tap has to land somewhere sensible. On the way in the coach did not ask for standby, so their tap goes to the UI and cancels the entry; on the way out they tapped the black screen, so the tap is consumed. A cancelled fade-in therefore hides instantly instead of fading out.
- **Long-press ☀ moved from the wake lock to the timer.** The wake-lock release was my own preservation of an older affordance; the timer toggle is what a coach interrupted by the countdown actually needs one gesture for. Letting the screen sleep is the "Keep screen awake" setting now. `wakeLockManager.toggleByUser()` still exists, unused by any UI.
- **No tab gate.** The first staging build held the Active Coach on the Full/Field tabs between points as well as mid-point, and the maintainer's test found it: on the Full tab the screen never faded, on the Line tab it did. Between points the screen may always fade, Active Coach included — waking is a tap and a tap's delay before Start Point is nothing (2026-09-22). The tab is no longer an input to the gate at all.
- **Hidden means disarmed.** The timer arms off the power plan (`inGame && visible`), so a hidden page never counts as idle and never shows the toast on return. In an IDE preview pane that reports itself hidden, a synthetic tap during the fade does nothing — that is the rule working, not a bug; verify the cancel path in a visible pane or in the e2e.
- **Toast text is now non-selectable in WebKit.** The toast container sits at the top of the screen where ☀ is, so a press-and-hold raised a toast under the still-held finger and the hold selected its text. `.toast` had `user-select: none` but WebKit needs the prefixed form and `-webkit-touch-callout: none`.

### The e2e polling trap

Playwright's `expect(locator).toHaveClass()` backs its polling off to once a second after a few tries, so it can step right over the 700 ms `standby-screen--entering` window and report only the final class list. The first draft of `tests/scenarios/17-standby-timer.spec.ts` failed exactly that way while the feature worked. Watch a transient state with `page.waitForFunction(..., { polling: 'raf' })` and measure whatever the tap needs (the Start Point bounding box) *before* waiting.

## Not built

- An idle timer for the share-link viewer or the team screens: standby is an in-game thing.
- Anything specific to the Field landscape takeover: it lives inside the game container's stacking context, so the overlay covers it like any tab, and rotating while in standby just re-lays the black screen.
- A swatch in `tests/sweep`'s board: the overlay is theme-invariant (`--black` and the `--on-overlay-*` family), so the light/dark contrast sweep has nothing to compare.

## Verifying

Preview (any game): tap ☀. `#standbyScreen` gains `standby-screen--active`, `body` gains `standby-active`, `meta[name=theme-color]` reads `#000000`. Tap the overlay: all three revert, and `window.currentGame().points.length` and the header score are unchanged. To prove the overlay is the hit target with a dialog open, call `document.elementFromPoint(innerWidth / 2, innerHeight / 2)` and expect an element inside `#standbyScreen`. A long press can be simulated from the console by dispatching `mousedown` on `#gameWakeLockBtn`, waiting 650 ms, then dispatching `mouseup` and `click`: expect the toast and no standby. The module itself is reachable as `(await import('/ui/standbyScreen.js')).standbyScreen` for `enter()` / `exit()` from a script.

The between-points view needs a point to have ended: pick a line, Start Point, We Score, then tap ☀ and expect the `NEXT POINT` countdown to match `#timerDisplay`.

Automated: `tests/scenarios/15-standby-screen.spec.ts` (mirror, swallow over Start Point and They Score, countdown after the first goal, teardown on `exitGameScreen`), `tests/scenarios/17-standby-timer.spec.ts` (idle → toast → soft fade-in, cancel by input and by ×, the mid-point gate, the ☀ hold), `tests/unit/standbyView.test.mjs` and `tests/unit/standbyPolicy.test.mjs`. For a quick look at the timer in a preview, set `advancedSettings.set('power.standbyIdleSec', 3); standbyTimer.refresh()` from the console and keep the pane visible.
