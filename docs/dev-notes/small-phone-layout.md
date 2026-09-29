# Small-phone layout: the viewport sweep and what it found

Status: in progress (branch `claude/vibrant-bohr-hdb37l`, unmerged). Last verified 2026-09-29.

Prompted by a coach on an iPhone 13 mini: odd sizing, and text pushing the useful controls off the screen. The app had been tuned on an iPhone 15 Pro Max. This note covers the tool built to see the problem, what it found, what was fixed, and what was left as a design call.

## The sweep

`tests/sweep/viewport-sweep.spec.ts` walks the app once per phone in `tests/sweep/phones.ts`. The walk covers the team list, roster, Start Game, a game with a point on O and a point on D, every in-game dialog and tab, settings, the end of the game and its summary. At each stop it takes a screenshot and runs the layout audit in `tests/sweep/layout-audit.ts`.

```bash
cd tests
npx playwright test --config sweep/sweep.config.ts viewport-sweep
BREAKSIDE_PHONES=mini-safari,oneplus-8 npx playwright test --config sweep/sweep.config.ts viewport-sweep
```

Output goes to `tests/sweep/shots/viewport/` (gitignored): one PNG directory per phone, `<phone>.json` with every finding, and `index.html`, a contact sheet with screens down and phones across.

Choices that matter:

- **The viewport is what the browser leaves, not the screen.** The in-game screen never scrolls, so Safari's toolbars never collapse during a game: a 13 mini in Safari gets 375x629, not 375x812. Installed as a Home Screen app it gets 375x762 (index.html has no `viewport-fit=cover`, so it loses only the status bar). Browser sizes match Playwright's own descriptors (`devices['iPhone 13 Mini']`). `phones.ts` explains how to add a phone.
- **A 16-player roster.** The e2e helpers' 7-player team fits everywhere. The screens that list players are where small phones run out of room.
- **Clicks go through `press()`,** which clicks the way a finger could: directly, or by scrolling a real scroll container. It deliberately avoids Playwright's scrollIntoView, which will happily scroll an `overflow: hidden` box that no finger can scroll. A control nobody could reach is recorded as `unclickable` and clicked through the DOM so the walk goes on.
- **The audit measures against the phone's width, not `window.innerWidth`.** Once anything overflows, a mobile browser widens the layout viewport to fit it, so `innerWidth` reports the overflow as normal (ARCHITECTURE.md § CSS Styling Gotchas).
- **Clipping follows the containing-block chain.** An `overflow: hidden` ancestor does not clip a `position: fixed` or out-of-flow absolute descendant. The first version of the audit got this wrong and reported the whole game menu as hidden.
- **Cloud sessions can't reach cdnjs,** so Font Awesome and the Google fonts are served from local npm packages when `BREAKSIDE_SWEEP_FONTS` points at them (`tests/sweep/offline-fonts.ts`). Without that, icon buttons render at the wrong width and the audit measures a layout no user sees.
- **Chromium only.** Safari-specific behaviour (the `vh` unit, toolbar resizing) is invisible here; see ARCHITECTURE.md § CSS Styling Gotchas.

## What it found (2026-09-29, before the fixes)

Worst first. "Mini" is the 13 mini in Safari unless stated.

1. **Whole screens zoomed out.** A page wider than the phone gets shrunk to fit, so every font on it gets smaller. The Gender Ratio select zoomed Start Game and Game Settings to 89% on every phone 412px wide or narrower. The roster/stats table container zoomed Roster + Stats and Game Summary to 96–99% on every phone, the Pro Max included. Probably a good part of "odd sizing".
2. **Next Line got two or three player rows.** The panel was pinned at 45% of the screen height and the game log kept the rest. On the mini that left 3 visible rows (2 on an SE) while the log held a quarter of the screen.
3. **In-game dialogs squeezed the player lists.** The headers, margins and footers kept their full size, so on the mini the score dialog showed 4½ players, and the pull dialog's Proceed button was below the fold.
4. **The mic FAB covered controls on every phone:** Simple-tab Events, the edge of Field-tab They score, the Score / Proceed / Done buttons of any open dialog (it sat above the modals), and the bottom rows of the Line tab.
5. **Tab bar:** each tab looked 44px tall but took taps only in its middle 24px. The rest was the global `button { margin: 10px }`.
6. **Label wraps that doubled row heights:** Line-tab "Point in progress" / "Start Point (Offense)" at 390px and below; dialog titles such as "ADVANCED SETTINGS".
7. **Safari-only, by reading the CSS:** the score dialog was capped at `96vh`. In Safari that is the toolbar-hidden height, so its bottom (the Score button) sat under the toolbar.

## What was fixed

| Finding | Fix |
|---|---|
| 1 | `#enforceGenderRatioSelect` sized by its row, capped at 280px (css/tables.css). `.roster-table-container` lost its 20px side margin. |
| 2 | `selectLineAutoHeight()` (game/gameScreenSync.js): 45% on tall phones as before, but on a short screen the panel grows until a whole line is visible, down to the log's minimum. |
| 3 | Short-screen block at the end of css/pbp.css (portrait, height 700px and under): compact prominent header, the modal hugs the top, and the score dialog takes its landscape economies (one action row, no separator, Callahan hidden when inapplicable). The pull dialog moves its checkboxes, hang stopwatch and Proceed into the empty right-hand column. |
| 4 | micButton.css: idle, the FAB sits under dialogs (z-index 990). While recording it stays on top. When the Simple tab's action row runs along the bottom (its full layout), the FAB rises above it: `updatePlayByPlayLayout` toggles `body.pbp-actions-at-bottom`, the same pattern as `body.fp-landscape-takeover`. The Field events bar reserves the FAB's real footprint (88px, was 72px). The Line-tab table can scroll its last rows past it. |
| 5 | `.header-seg-control button`: margin 0, same height from padding. The tab bar is 12px shorter on short screens. |
| 6 | Line-tab Events / Undo go icon-only at 400px and below (as the Play-by-Play row already did). Prominent titles are smaller at 400px and below. |
| 7 | `svh` caps after the `vh` fallback on the score dialog and the other overlay caps. |

Also fixed along the way:

- The score dialog's Assist column was clipped 4px on the left on every phone. A dead legacy rule (`.player-buttons, .action-buttons { flex-basis: 45%; margin-right: 5% }` in css/tables.css) gave each player list a right margin, and its centring column pushed it left into the list's `overflow` clip. Nothing used `.action-buttons`, so the rule is gone.
- The game menu is capped at the screen height and scrolls (its last item was 35px off an SE). Its items stick out 10px (width 100% plus the global button margin), hence `overflow-x: hidden`.
- The Full tab's log minimum drops from 110px to 88px on short screens. It can't go lower, because the FAB has to fit inside the log strip.

Result, across the six phones: high-severity findings 363 before, 18 after. The 18 are the between-points countdown over the header's buttons (every phone, see below) and the Field tab's own mic placeholder under the real FAB (below). On the Pro Max the only visible changes are that the Next Line panel is 10px taller (its 7th row used to be cut), the tab highlight fills its segment, Roster + Stats and Game Summary are no longer zoomed out, and the idle FAB sits under open dialogs.

## Left as design calls

- The Simple tab's big squarish buttons wrap their labels ("We / Score") on every phone. That's the designed look; a full-width, one-line variant (as the SE height already gets) would read better on small phones.
- The mic FAB is a floating element over a dense layout. Docking it into each tab's bottom row would end the overlap for good, but that's a layout decision.
- Header: logo, score and timer take a 51px row on every phone. The logo already shrinks; the next saving would be dropping the wordmark in-game on short screens.
- Between points, the "Next Point" countdown sits over the header's THEM score, standby button and timer on every phone (not small-phone specific).
- Roster + Stats: at 390px wide and below the scope/stats row wraps, and the Add Player row ends up just below the fold. It's reachable by scrolling.
- Screen title bars (Game Summary) wrap Share / Export onto a second row at 360px. The stylesheet does this on purpose (css/shell.css).
- The Field tab renders its own mic button (`.fp-mic` in playByPlay/fieldPbp.js) with no click handler. In portrait the real FAB covers it. In the landscape takeover (z-index 9999) the real FAB is covered instead, so the only mic a coach sees there does nothing. Not a small-phone issue; noted here because the sweep flags it on every phone.

## Verifying on a real phone

Chromium emulation can't show Safari's toolbar behaviour. Before calling this done, check on a real iPhone in Safari (not the Home Screen app): open the score dialog and the pull dialog mid-game and confirm Score / Proceed clear the bottom toolbar.
