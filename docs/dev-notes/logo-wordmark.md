# Wordmark logo rollout

Status: complete as of 2026-09-07 (branch `retire-disc-logo`); the disc artwork survives only in the favicon / app-icon set.

## What shipped

`images/logo.wordmark.png` (all-orange wordmark, tightly cropped, baked white background) in the main app header, both landing navs, and the in-game header. Because the wordmark has black lettering it needs a light background everywhere, so headers went white with an orange accent border; staging is differentiated only by the purple pill. `theme-color` is white.

`images/logo.wordmark.dark.png` (transparent background, light lettering) was derived later for dark mode; the recipe is in [dark-mode.md](dark-mode.md).

## iOS notch decision

`apple-mobile-web-app-status-bar-style` is `default` (was `black-translucent`). **Do not use `viewport-fit=cover`.** An attempt with it extended the canvas under the notch, and top-anchored fixed elements that are not safe-area aware (the "Next Point" countdown at `top:10px`, toasts) drew into the dynamic island while `env()`-padded elements sat below: an inconsistent top reference. Without cover, the layout viewport stays below the notch and the default status bar paints it white. The main `<header>` still breaks out of body's 5 px padding via negative margins; the `env(safe-area-inset-top)` paddings on the headers remain but are no-ops.

## Disc logo retired (2026-09-07)

`images/logo.disc.only.png` and `images/logo.png` are deleted. The last three
`<img>` spots (in-app auth screen, landing footer, join footer) all sit on dark
surfaces in both themes, so they use `logo.wordmark.dark.png` directly with no
`data-dark-src` swap. The landing hero carousel stills were re-shot from the
current chrome with `tests/demo/hero-shots.spec.ts` (see
`landing/screens/README.md`).

What still carries the disc artwork: `images/favicon-*.png`, `images/favicon.ico`,
`images/staging/favicon-*.png` (and `browserconfig.xml`'s tile). Replacing the
app icon needs a square mark derived from the wordmark, which is a design
decision, not a search-and-replace.

## Loose end from the same review

Two in-game clocks exist: the floating dark "Next Point" 90 s countdown (`#countdownTimer`, driven by `game/pointManagement.js`) and the header point timer (`#gameTimerValue`). The maintainer flagged them as possibly redundant and was unsure which worked; nobody has investigated.
