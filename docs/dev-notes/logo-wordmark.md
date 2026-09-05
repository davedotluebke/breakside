# Wordmark logo rollout

Status: shipped (branch `logo-refresh`, mid-2026); three spots still on the old disc asset as of 2026-09-05.

## What shipped

`images/logo.wordmark.png` (all-orange wordmark, tightly cropped, baked white background) in the main app header, both landing navs, and the in-game header. Because the wordmark has black lettering it needs a light background everywhere, so headers went white with an orange accent border; staging is differentiated only by the purple pill. `theme-color` is white.

`images/logo.wordmark.dark.png` (transparent background, light lettering) was derived later for dark mode; the recipe is in [dark-mode.md](dark-mode.md).

## iOS notch decision

`apple-mobile-web-app-status-bar-style` is `default` (was `black-translucent`). **Do not use `viewport-fit=cover`.** An attempt with it extended the canvas under the notch, and top-anchored fixed elements that are not safe-area aware (the "Next Point" countdown at `top:10px`, toasts) drew into the dynamic island while `env()`-padded elements sat below: an inconsistent top reference. Without cover, the layout viewport stays below the notch and the default status bar paints it white. The main `<header>` still breaks out of body's 5 px padding via negative margins; the `env(safe-area-inset-top)` paddings on the headers remain but are no-ops.

## Still on `logo.disc.only.png`

These sit on dark or non-white backgrounds and want the transparent wordmark:

- In-app auth screen logo: `index.html` (search for `logo.disc.only`)
- Landing footer: `landing/index.html`, `landing/join.html`

The public viewer has been updated. Also: the landing hero's phone-mockup screenshots still show the old orange in-game header and should be regenerated.

## Loose end from the same review

Two in-game clocks exist: the floating dark "Next Point" 90 s countdown (`#countdownTimer`, driven by `game/pointManagement.js`) and the header point timer (`#gameTimerValue`). The maintainer flagged them as possibly redundant and was unsure which worked; nobody has investigated.
