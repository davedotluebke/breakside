# Dark mode

Status: shipped (branch `dark-mode`, merged to main; verified 2026-09-05). The architecture, the token rules, the lint, and the five traps are all in ARCHITECTURE.md § Theming (light / dark). This note holds only what that section does not.

## Verification workflow

`tests/sweep/` has two Playwright specs: a 27-screen walk and a 22-dialog force-show sweep that is exhaustive by construction. Each screenshots and measures WCAG contrast on the live DOM against the real composited backdrop with opacity folded in.

Run once per theme with `BREAKSIDE_THEME=dark` and `BREAKSIDE_THEME=light`, then diff the two JSON result sets. **Only findings that are dark-only or worse-in-dark matter.** Light mode carries about 147 pre-existing contrast findings of its own; a raw dark-mode count is meaningless without the light baseline. Final state at merge: 0 dark-only, 0 worse-in-dark.

`tests/sweep/shots/` is gitignored because the screenshots once leaked 25 MB into history and the branch had to be rebuilt with `git commit-tree` to strip them.

## Why pure black

Power saving on OLED was the stated design intent, so `--surface-page` is `#000`. Two consequences documented in ARCHITECTURE: a literal inversion of the light border ramp is too faint on black, and neutral drop shadows vanish.

## Deliberately unthemed

Landing page, join page, public viewer. Each is self-contained and none loads `css/tokens.css`. The in-app auth screen draws its own dark blue gradient in both themes and always has.

## Open questions, never decided

- Should landing, join, and the viewer follow the app theme?
- Should the select-line gender badges switch from Material purple/blue to the app's own FMP/MMP purple/green?
- The ~147 pre-existing light-mode contrast findings the sweep surfaced. Nobody has triaged them.

## Related asset

`images/logo.wordmark.dark.png` was derived from the shipped wordmark rather than re-exported: un-composite against white (`alpha = 1 - min(rgb)`, then `c = (p - (1-a))/a`), flip only the low-chroma ink to near-white, keep the saturated orange, quantize to 128 colours. The same recipe produces a transparent asset for the spots listed in [logo-wordmark.md](logo-wordmark.md).
