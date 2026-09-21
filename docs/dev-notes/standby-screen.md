# Standby screen

Status: shipped — built on branch `standby-screen` 2026-09-19, merged to main 2026-09-20 (2.2.0). The mechanism, the stacking order and the ☀ contract are in ARCHITECTURE.md § Power Management → Standby screen. This note holds the decisions behind them and the verification recipe.

## Decisions

- **Tap enters standby; press-and-hold releases the wake lock.** The 2026-08-09 design said to "repurpose" the ☀. The release-the-lock toggle was kept on the same button as a 450 ms hold (the set picker's long-press, `ui/setPicker.js`) rather than dropped, because it still has a real use on an LCD phone, where black pixels save nothing and letting the screen sleep is the only saving. A toast confirms each hold; a dimmed icon under a thumb is easy to miss. The hold's trailing `click` is swallowed by a flag, and the flag is reset on the next press so an iOS long-press that never fires a click cannot eat the tap after it.
- **Exit on `click`, keep intercepting through the fade.** Exiting on `pointerup` and hiding at once lets the browser's synthesized click land on the control that is now under the finger. The 180 ms opacity fade doubles as a guard for a bounced double-tap. Under `prefers-reduced-motion` the fade collapses to nothing and the guard rests on the click-target rule alone, which is the one that matters.
- **Mirror the DOM, own no timer.** A `MutationObserver` on the two score cells and the countdown text costs nothing between changes. The alternative, a 1 s repaint loop of its own, would have meant a new entry in `utils/powerPolicy.js` for a screen whose whole purpose is to cost less. The pure read rules (`utils/standbyView.js`) exist so the observer callback has nothing to test.
- **No countdown before the first pull.** `startNewGame` (`game/gameLogic.js`) does not start the between-points countdown; only a point ending does (`moveToNextPoint` in `game/pointManagement.js`). Standby shows what the game shows. The first e2e draft expected a countdown on a fresh game and failed on exactly that; the test was wrong, not the feature.
- **Toasts stay above.** A Line Coach in standby still has to see a handoff request, and a share/join toast is harmless lit area for a few seconds. Dialogs (`z-index: 1000`) sit below; a dialog can only open from a control the overlay is covering anyway.
- **`theme-color` goes to black while up** and is handed back by re-running `applyTheme()`, not by restoring the value seen on the way in: an `auto` preference can re-resolve mid-game (dusk), and the saved value would then be the wrong theme's. iOS reads its standalone status-bar style once at launch, so this helps Android and in-browser use only.
- **Visible in every game, wake lock or not.** The old button hid itself where `navigator.wakeLock` was absent or the setting was off; standby needs neither, so the button now keys off the power plan's `inGame` and the icon alone reports the lock. Headless Chromium refuses the lock, which is why the e2e can rely on the button being there.

## Not built

- The idle timeout that would enter standby by itself (TODO.md § UI/UX). Explicit tap only, per the design note.
- Anything specific to the Field landscape takeover: it lives inside the game container's stacking context, so the overlay covers it like any tab, and rotating while in standby just re-lays the black screen.
- A swatch in `tests/sweep`'s board: the overlay is theme-invariant (`--black` and the `--on-overlay-*` family), so the light/dark contrast sweep has nothing to compare.

## Verifying

Preview (any game): tap ☀. `#standbyScreen` gains `standby-screen--active`, `body` gains `standby-active`, `meta[name=theme-color]` reads `#000000`. Tap the overlay: all three revert, and `window.currentGame().points.length` and the header score are unchanged. To prove the overlay is the hit target with a dialog open, call `document.elementFromPoint(innerWidth / 2, innerHeight / 2)` and expect an element inside `#standbyScreen`. A long press can be simulated from the console by dispatching `mousedown` on `#gameWakeLockBtn`, waiting 650 ms, then dispatching `mouseup` and `click`: expect the toast and no standby. The module itself is reachable as `(await import('/ui/standbyScreen.js')).standbyScreen` for `enter()` / `exit()` from a script.

The between-points view needs a point to have ended: pick a line, Start Point, We Score, then tap ☀ and expect the `NEXT POINT` countdown to match `#timerDisplay`.

Automated: `tests/scenarios/15-standby-screen.spec.ts` (mirror, swallow over Start Point and They Score, countdown after the first goal, teardown on `exitGameScreen`) and `tests/unit/standbyView.test.mjs`.
