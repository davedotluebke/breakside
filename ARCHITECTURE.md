# Breakside Architecture

This document describes the technical architecture of the Breakside ultimate frisbee statistics tracker.

## Target Platform

**Phone-first.** Layout, gesture surfaces, and UI density are designed for a
phone in the coach's hand on the sideline. Tablet may be optimized for later.
Desktop is not an important target — desktop-specific affordances (hover
states, keyboard shortcuts beyond basics, multi-column layouts) are
nice-to-have at best, and should not constrain phone UX decisions.

Practical implications:

- iOS PWA is a primary runtime. Capabilities that don't work there (e.g.
  Fullscreen API on non-`<video>` elements) need CSS-based workarounds, not
  feature detection that silently degrades.
- "Looks fine on desktop" is not a sign-off; test on phone-sized viewports
  (iPhone 15 Pro 393×852 / 15 Pro Max 430×932) before declaring a UI change
  done.
- Touch ergonomics (tap targets ≥ ~36px, drag affordances, no hover-only UI)
  take precedence over visual density.

## System Overview

Breakside uses a hybrid architecture with a Progressive Web App (PWA) frontend hosted on CloudFront/S3 and a FastAPI backend on EC2.

```
                              USERS
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
   breakside.pro          www.breakside.pro      api.breakside.pro
   (apex domain)                                        
         │                      │                      │
         ▼                      ▼                      ▼
   EC2 / nginx              CloudFront             EC2 / nginx
   (301 redirect)             (CDN)                 (proxy)
         │                      │                      │
         └──────────────►  S3 Bucket              FastAPI
                          (PWA + Viewer)         (port 8000)
```

### Live URLs

| Service | URL | Hosted On |
|---------|-----|-----------|
| **PWA** | https://www.breakside.pro | CloudFront (`E6M9KCXIU9CKD`) → S3 |
| **PWA (redirect)** | https://breakside.pro | EC2 → www |
| **Staging PWA** | https://staging.breakside.pro | CloudFront (`E12N2STN9MM8FA`) → S3 |
| **Static Viewer** | https://www.breakside.pro/viewer/ | CloudFront → S3 |
| **API** | https://api.breakside.pro | EC2 → FastAPI |
| **Health Check** | https://api.breakside.pro/health | EC2 |

Staging uses the same production API. The API endpoint can be overridden via `?api=<url>` query parameter (saved to localStorage, clear with `?api=reset`).

---

## Frontend Architecture

### PWA Structure

The frontend is a vanilla JavaScript Progressive Web App with no framework dependencies.

```
ultistats/
├── index.html              # Main HTML entry point
├── main.js                 # Application bootstrap (~436 lines)
├── css/                    # Application styles: tokens.css (color palette) + per-concern files split from the old main.css (load order preserved in index.html)
├── manifest.json           # PWA manifest
├── service-worker.js       # Service worker for offline functionality
├── version.json            # Version tracking
│
├── store/                   # Data layer
│   ├── models.js           # Data structure definitions (Player, Game, Team, etc.)
│   ├── storage.js          # Serialization/deserialization and local storage
│   └── sync.js             # Server synchronization logic
│
├── utils/                   # Utility functions
│   ├── helpers.js          # Pure utility functions and state accessors
│   ├── statistics.js       # Legacy statistics calculation and game summaries
│   ├── eventStats.js       # Player + team stat aggregation (goals, assists,
│   │                       # hockey assists, breaks/holds), event/phase filters
│   ├── statsHelp.js        # Long-press column-header help modal for stats tables
│   ├── tableSort.js        # Click-to-sort controller for on-screen stats tables
│   └── xlsxExport.js       # Excel (.xlsx) export builders (SheetJS-backed)
│
├── vendor/                  # Third-party libraries (vendored for offline use)
│   └── xlsx.mini.min.js    # SheetJS community build (xlsx read/write)
│
├── screens/                 # Screen management
│   └── navigation.js       # Screen navigation and state management
│
├── teams/                   # Team management
│   ├── teamSelection.js    # Team selection and team CRUD operations
│   ├── rosterManagement.js # Roster display, player and line management
│   └── teamSettings.js     # Team settings, member list, invite management
│
├── game/                    # Game core logic
│   ├── gameLogic.js        # Game initialization, scoring, undo
│   ├── gameScreen.js       # Game screen with tabbed panel layout (Simple / Full / Line / Log / All)
│   ├── pointManagement.js  # Point creation, timing, transitions
│   ├── controllerState.js  # Multi-coach role management
│   └── genderRatioDropdown.js # Gender ratio rule selection
│
├── playByPlay/              # Play-by-play tracking
│   ├── keyPlayDialog.js    # Key play recording dialog (Simple mode)
│   ├── pullDialog.js       # Pull tracking dialog
│   ├── scoreAttribution.js # Score attribution dialog
│   ├── fullPbp.js          # Full PBP tab — every-event entry surface (see docs/full-pbp-requirements.md)
│   └── fullPbp.css         # Full PBP layout + density styles
│
├── narration/               # AI speech narration (mic → transcript → events)
│   ├── micButton.js        # Floating mic FAB (tap or hold-to-record)
│   ├── micButton.css       # Mic button + transcript panel styles
│   ├── eventBus.js         # Tiny pub/sub for client update pipeline
│   ├── realtimeSession.js  # OpenAI Realtime API WebSocket client
│   ├── narrationEngine.js  # Orchestrator: fast pass + slow pass + apply
│   └── transcriptDisplay.js # Live transcript panel above the mic button
│
├── ui/                      # UI components
│   ├── panelSystem.js       # Panel layout and drag-to-resize system
│   ├── panelSystem.css      # Panel system styles
│   ├── activePlayersDisplay.js # Line-tab helpers (running scores)
│   ├── eventLogDisplay.js   # Event log management
│   └── buttonLayout.js      # UI consistency functions
│
└── images/                  # App icons and logos
    ├── logo.png            # Full logo with text
    ├── logo.disc.only.png  # Icon-only logo
    └── favicon-*.png       # Various favicon sizes
```

### Module Loading (ES modules)

The frontend is native ES modules — still no build step, no bundler; every file
ships to S3 as-is and runs directly in the browser.

- `index.html` loads exactly one app script: `<script type="module" src="main.js">`.
  The only other script tags are the Supabase CDN client, `vendor/xlsx.mini.min.js`
  (both classic scripts providing the `supabase`/`XLSX` globals), and three tiny
  inline bootstrap snippets (staging flag, icons, manifest).
- `main.js` is the entry point. Its top import block lists every module in the
  order the old `<script>` tags used, so top-level side effects (state init,
  DOM wiring) keep their historical relative order. Modules import what they
  use by name: `import { currentGame } from './utils/helpers.js'`.
- Shared mutable state lives in `store/storage.js` (`currentTeam`, `teams`,
  `currentEvent`, …) and is exported as **live bindings**. Reads import the
  binding; cross-module **writes must use the exported setters**
  (`setCurrentTeam()`, `setCurrentEvent()`, `setTeams()`) — assigning to an
  imported binding is a runtime TypeError.
- Dependency flow is still data → utils → features → UI for *imports*.
  **Back-edges** (a lower layer notifying a higher one, e.g. `store/sync.js`
  refreshing the teams screen) do NOT import upward; they call late-bound
  window hooks: `window.updateSyncStatusDisplay?.()`. Each such hook is a
  deliberate, documented `// window survivor:` at its owner. Cross-module
  reactions also use DOM CustomEvents: `breakside:screen-shown` (dispatched by
  `screens/navigation.js showScreen()`) and `breakside:controller-ui-updated`
  (dispatched by `game/controllerState.js`) replaced the pre-module
  monkey-patching of `window.showScreen`/`window.updateControllerUI`.
- **Adding a new file**: create it as a module (use `export`, import what you
  need), then add `import './dir/newFile.js';` to `main.js`'s import block at
  the position matching its layer. Never add a classic `<script>` tag for app
  code. If lower-layer code must call into your file, expose a
  `window.myHook = myHook; // window survivor: late-bound back-edge hook` and
  call it as `window.myHook?.()` from below — don't import upward.
- **Module timing**: modules are deferred — they evaluate after the DOM is
  parsed (so top-level `document.getElementById(...)` works) and before
  `DOMContentLoaded` fires. Modules are always strict mode: undeclared-variable
  assignments throw, so declare everything.
- **Surviving `window.*` globals** are the exception, not the wiring. Every one
  carries a `// window survivor:` comment at its assignment. Categories:
  e2e test seams (`window.currentGame`, `window.pingController` — the Playwright
  suite reads/replaces these, and controller polling deliberately calls
  `window.pingController(...)` so the test override takes effect;
  `window.startControllerPolling`/`stopControllerPolling`), generated-HTML
  onclick handlers (`openJoinTeamModal`, `showConnectionInfo`, `handleSignOut`, …
  in `teams/teamList.js`/`teams/syncStatusUI.js` templates), `main.js` bootstrap
  globals (`APP_VERSION`/`APP_BUILD`/`swRegistration`/… — nothing may import
  from the entry module), the `window.breakside.auth`/`.loginScreen` auth
  namespace, late-bound back-edge hooks (above), and a few documented debug
  seams.
- `landing/` pages are separate HTML entry points with their own self-contained
  classic scripts (they share no files with the app) and are exempt from all of
  this. `service-worker.js` is a worker script — also classic, also exempt; it
  caches module files at fetch time exactly like any other asset, so no SW
  changes were needed for the migration.

### Boot Splash

`index.html` ships with `#teamRosterScreen` **visible** — it is the one screen
section without an inline `display: none`. Nothing navigates away from it until
`initializeApp()` finishes (auth init is async and can take a network round
trip), so between first paint and that point the user briefly sees the Start
Game subscreen before the app lands on the team list.

[css/splash.css](css/splash.css) + [ui/splashScreen.js](ui/splashScreen.js) cover
that window with `#splashScreen`: a full-viewport white panel holding the
wordmark (white to match the logo's own background), `z-index: 100000`, first
element in `<body>`, which retracts upward like a window shade and is then
removed from the DOM.

Two decisions worth knowing before changing it:

- **It's an overlay, not "hide the screens until ready."** `main.js` runs
  `matchButtonWidths()` at `DOMContentLoaded`, and hidden elements measure zero.
  Giving `#teamRosterScreen` a `display: none` would silently break button
  sizing; a fixed overlay leaves the layout underneath intact. If you ever do
  hide it, fix the measurement first.
- **Dismissal is signal-driven.** `screens/navigation.js` dispatches
  `breakside:screen-shown` on every `showScreen()`; the first one retracts the
  splash. `main.js` calls `dismissSplash()` directly on the auth-screen path,
  which bypasses `showScreen()`. Any *new* boot path that shows UI without going
  through `showScreen()` must call `dismissSplash()` too — the `MAX_VISIBLE_MS`
  timer in the module is a safety net so a missed signal can't lock the user
  out, not a substitute for wiring the path up. The logged-out redirect to
  `/landing/` deliberately keeps the splash up: covering that hop is the point.

The wordmark is `<link rel="preload" as="image">`ed in `<head>` (same file the
header logo uses, so no extra bytes) and the module waits briefly for it, so the
shade never flies up as an empty white panel on a cold load. In dark mode the
panel is `--surface-page` (true black) and the preload is rewritten to the dark
wordmark — see § Theming below.

### Theming (light / dark)

The app ships two palettes. Dark is not only a preference: `--surface-page` is
**pure `#000`**, and on the OLED phone propped on a sideline for two hours a
black pixel is an unlit pixel. That is why the dark palette steps up from black
as little as it can and leans on borders rather than luminance for separation.

**Where the colors live.** [css/tokens.css](css/tokens.css) is the only file
allowed to contain a raw color. It has exactly two blocks:

- `:root` — the light palette (the app's original look)
- `:root[data-theme="dark"]` — the dark overrides

Every component stylesheet references `var(--token)` and nothing else.
[scripts/lint-css-tokens.py](scripts/lint-css-tokens.py) keeps that honest and
is worth re-running after any color work. It makes three checks, each catching
a class of bug that light mode hides and dark mode exposes: a **raw color**
outside tokens.css (it cannot flip with the theme), a **role mismatch** (a
`--surface-*` in a `color:` is fine in light mode by accident and gone in
dark), and a **parity** break (a `:root` token with no dark counterpart keeps
its light value on a black page; it also flags dark-only and unreferenced
tokens).

```bash
./scripts/lint-css-tokens.py
```

**How a theme is chosen.** [utils/theme.js](utils/theme.js) resolves the
`display.theme` setting (`auto` | `light` | `dark`, stored in the same
`breakside_advanced_settings` blob as every other Advanced Setting) against
`prefers-color-scheme` and writes the **resolved** value — never `auto` — to
`data-theme` on `<html>`.

The default is **`dark`**, not `auto`: the app is used outdoors on a phone for
hours at a stretch, so the battery argument wins even for a user whose device
is set to light. That default is written in *three* places that must agree —
`getPreference()` in theme.js, the pre-paint copy in `index.html`, and the
`DEFAULTS` map in [settings/advancedSettings.js](settings/advancedSettings.js).
A user who has explicitly chosen a theme is unaffected; only "never touched it"
resolves to the default. Resolving in JS rather than wrapping the dark block in
a media query means the palette is defined once, and the `<meta name="theme-color">`
/ iOS status-bar style can be kept in agreement with whatever CSS decided.

`index.html` carries a deliberately duplicated, minimal copy of the read-and-
resolve step **inline in `<head>`**. Without it the app paints white and snaps
to black. The duplicate and `theme.js` must agree on the storage key; if you
move the setting, move both.

**Four rules for adding a color** (also stated at the top of tokens.css):

1. No raw hex in a component stylesheet — add a token.
2. Every `:root` token gets a dark counterpart, unless it is deliberately
   theme-invariant (`--white`, `--black`, the `--overlay-scrim` family).
3. Pick the token by **role**, not by value. The same light-mode hex is often
   three different tokens: `#ddd` is `--surface-dim` in a `background`,
   `--border-light` in a `border`, and neither in a `color`. Only the
   role-correct one survives the flip.
4. An accent drawn as **text on the page** uses the `--*-ink` variant, not the
   base. Base accents are tuned as button *fills* with white labels on top;
   inks are tuned for legibility against the page. The two must diverge in
   dark, because a fill dark enough to carry white text cannot also be light
   enough to read as text on black.
   *Worked example:* the Full PBP "Break" action drew in `--pbp-blue-deep` —
   the fill behind an armed chip. In light that reads fine and nobody notices;
   in dark it is 2.65:1 while every sibling action, all on `-ink` tokens, sits
   at 7.9–9.5. The family simply had no blue ink in it. If you reach for a
   base accent in a `color:` and there is no matching `-ink`, that is the bug,
   not the workaround — add the ink.

**Gender coding is one purple/green pair, everywhere.** `--gender-fmp-*` is
purple and `--gender-mmp-*` is green, in the app and in the public viewer.
Deliberately *not* blue/pink, and not the Material purple/blue the select-line
ratio badge used until Aug 2026 — blue reads as a gendered signal. A gender
control takes `--gender-*-surface` as its fill and `--gender-*-ink` as its
text; the `-tint` variants are for cells that carry inherited body text. Chips
on near-black need real chroma to survive: the first dark cut lifted only
1.2–1.5:1 off the card and read as grey blocks rather than purple and green
ones.

**Things that are deliberately theme-invariant**, and why:

- `--white` / `--black`. `--white` is the label color on every colored button,
  so it stays `#fff` in both themes. The *sheet* color that used to be white is
  a separate token, `--surface-card`, and that one goes near-black. Confusing
  the two is how the app header ended up white with a dark-mode wordmark on it.
- Everything drawn **on the Field-mode pitch** — the disc, event markers, the
  pegman halo. The pitch is green in both themes, so those follow the pitch,
  not the page. See the `--fp-*` block in
  [playByPlay/fieldPbp.css](playByPlay/fieldPbp.css), which keeps its own light
  and dark palettes next to each other for the same reason.
- Modal scrims. A scrim sits *over* content in both themes, so it is dark in
  both. Translucent **washes** (`--wash-*`) are the opposite case: they flip
  polarity, because a black wash reads as "slightly recessed" on a light
  surface and as nothing at all on a dark one.

**Shadows become rings.** A soft black blur over a black page renders as
nothing, so the `--shadow-*` presets carry a hairline light ring in dark mode
instead. Use the presets rather than writing a `box-shadow` literal — a raw
one silently disappears in dark.

**Borders are pitched brighter than a literal inversion.** `#eee` on white is a
1.24:1 hairline the eye still resolves; the same ratio near black is not,
because contrast sensitivity falls with luminance. The dark ramp lands at
roughly 1.5–3.8:1 against `--surface-card`.

**The two-tone wordmark.** `images/logo.wordmark.png` is black-and-orange
lettering on a baked white background, so on a dark surface the black half
vanishes and the white block shows. `images/logo.wordmark.dark.png` is derived
from it (un-composited off the white, neutral ink flipped, orange kept). An
element opts in with `data-dark-src`; `theme.js` swaps `src` on every theme
change. Markup **built at runtime** must call `refreshThemedImages(root)` after
building — pass the subtree, since `document.querySelectorAll` cannot see a node
that has not been inserted yet. `game/gameScreenPanels.js` is the live example.

**Not themed** (all self-contained, none of them load `css/tokens.css`): the
marketing landing page, the invite join page, and the public game viewer. The
in-app auth screen has always drawn its own dark blue gradient and looks the
same in both themes.

**Verifying a change.** [tests/sweep](tests/sweep) runs the app through 27
screens and 22 dialogs per theme, screenshotting each and measuring WCAG
contrast for every visible text run and border against its real composited
backdrop (opacity folded in, so a deliberately dimmed control scores the way it
actually looks). Run it once per theme and diff the two result sets — what
matters is findings that are *dark-only* or *worse in dark*, since the app
carries plenty of pre-existing light-mode ones:

```bash
cd tests
BREAKSIDE_THEME=dark  ./node_modules/.bin/playwright test --config sweep/sweep.config.ts
BREAKSIDE_THEME=light ./node_modules/.bin/playwright test --config sweep/sweep.config.ts
```

Two things about that harness are load-bearing:

- **A walk only measures what it can reach.** Components gated behind unusual
  game state — an alternating gender ratio, a held coach role, a Start Point
  in its warning state, a negative point timer — never render, so they are
  never measured, and both dark-mode color bugs found by eye after the sweep
  came back clean were in exactly that blind spot. The **swatch board** at the
  end of `dialogs-sweep.spec.ts` mounts those from their real class names
  against the real stylesheets. When you add a state-gated component, add it
  there; it is cheaper than teaching the walk to reach it.
- **The auditor freezes animations before sampling.** The point timer pulses,
  so a live sample returns whatever opacity the pulse was mid-way through —
  the same token measured 4.42, then 3.23, then 3.80. Findings are now
  reproducible run to run, and pulsing elements are scored at full opacity,
  i.e. their best case.

### CSS Styling Gotchas

A handful of non-obvious cascade and box-model details have bitten layout work in this codebase. Check this list before chasing a "why is the button the wrong size" rabbit hole.

- **Global `button { padding: 10px 15px; margin: 10px; }`** lives in [css/base.css](css/base.css). Every panel button inherits both. When a custom button looks too tall, too narrow, or has unexpected gaps, it's almost always the inherited `margin: 10px` (not just padding). Override **both** in the panel/component scope: e.g. `.panel-playByPlayFull button { margin: 0; }`. Forgetting this was the root cause of the Full PBP row-height debugging episode.
  - **Recurring symptom: `<button>`s and `<div>`s in the same flex container space differently.** A flex/grid layout that mixes the two — e.g. a column of `<div>` chips followed by `<button>` modifiers, or a button row relying on `gap` — will look unevenly spaced and overflow, because only the buttons carry the inherited `margin: 10px` (flex margins are *not* collapsed, and they stack on top of `gap`). The buttons appear "spaced more widely" than the divs, and a `gap`-based row wraps sooner than its measured widths predict. Both the Field-tab pull modifier overflow and the score-dialog action row wrapping to extra rows were this. Fix: `margin: 0` on the button elements in that scope and let `gap` (or the chips' own spacing) do the work.
- **Reusable button presets carry their own size.** `.pbp-start-point-btn` (in [ui/panelSystem.css](ui/panelSystem.css)) is a "loud CTA" preset (16px/20px padding, 1.2rem font, 12px radius) designed for the PBP panel where it's the only thing competing for space. Reusing it in denser contexts requires slimming via a sibling class — see `.line-tab-start-point-btn`. Setting only `display` is not enough.
- **`width: 100%` on flex/grid children resolves against the *containing block including its padding*.** When a 100%-width child overflows on the right, the fix is usually to drop `width: 100%`, use `align-self: stretch`, and add `box-sizing: border-box`. The "They turnover / They score" buttons in Full PBP hit this.
- **Flex/grid children with their own min-content won't shrink below it** unless you give them `min-width: 0` (flex) or `minmax(0, …fr)` (grid columns). If a 60/40 split is rendering more like 75/25, this is why. Full PBP migrated from flex to grid for exactly this reason.
- **Service worker caching makes CSS look "stuck."** The PWA serves the cached `service-worker.js` until its `cacheName` constant changes. If a CSS edit isn't visible after deploy, bump `cacheName` in [service-worker.js](service-worker.js) and double-reload. Always verify against build number in version.json before assuming the change didn't deploy.
- **`.form-group` is styled globally for the DARK auth screen.** [auth/auth.css](auth/auth.css) defines `.form-group`, `.form-group label`, `.form-group input` and `::placeholder` **unscoped** — white label text, `rgba(255,255,255,0.05)` input background, white input text, `rgba(255,255,255,0.2)` border. Those rules leak into every `.form-group` in the app. Drop one onto a white settings card (`.settings-section` is `background: white`) and it renders **white-on-white**: invisible label, invisible placeholder, and an input you can only locate by tapping it, because the orange `:focus` border is its only visible state. Set Tracking shipped this way and it read as "an apparently blank space". The fix is an ancestor class in [css/teams-manage.css](css/teams-manage.css) (`.identity-form`, `.sets-form`), which outranks auth.css on specificity so no `!important` is needed even though auth.css loads later — but it is opt-in per section, so **any new form on a settings card must be added to that selector list** or it inherits the same invisibility. Note the file is `auth/auth.css`, not `css/auth.css`; grepping only `css/` will convince you the rules don't exist.
- **`position: sticky` table cells need `border-collapse: separate`.** The stats tables (game summary, event/team roster) use sticky header rows and sticky leftmost columns. With the default `border-collapse: collapse`, sticky cell backgrounds render transparent and other rows bleed through on scroll. The fix (in [css/tables.css](css/tables.css)) is `border-collapse: separate; border-spacing: 0;` plus an opaque `background-color` on every `th`/`td`, and a raised `z-index` on the header-row corner cells so they outrank both the sticky row and sticky column. Sticky also silently no-ops unless the scroll container (`.roster-table-container`) is the actual `overflow: auto` ancestor.

When CLAUDE finds a *new* gotcha worth remembering across sessions, add it here rather than to CLAUDE.md.

### Line Selection: Wholesale & Auto

Player selection is **always manual** — the coach checks/unchecks players directly. Two one-shot action buttons augment it (there is no persistent "mode" — an earlier Manual/Wholesale/Auto cycling toggle was removed):

- **Wholesale** — clears the active line (blank-checkbox icon).
- **Auto** — fills the *empty* slots up to the field count, **keeping** whoever is already checked, choosing players with the fewest points played in the current game and respecting the gender ratio. If the line is already full it no-ops with a warning toast.

`computeAutoLine(alreadySelected)` does the augment-fill; `clearLineSelection(context)`, `autoFillLineSelection(context)`, and the shared `applyLineSelection(context, players)` implement the actions (all in `game/gameScreen.js`). Two contexts: `'main'` (the Line tab) and `'sub'` (the injury-substitution dialog).

**Where the controls live.** To keep the toolbar uncluttered, **Wholesale** and the **Game/Event** time-stats toggle live in a dedicated **controls header row** inside the player table — built in `updateSelectLineTable`, light-grey banded with a thick bottom border, between the score rows and the player rows. The Wholesale icon sits over the checkbox column (the whole `th.select-line-th-wholesale` cell is tappable), a "Player" label over the names, and the Game/Event toggle over the time column (whole `th.select-line-th-stats` cell tappable). The **Auto** button stays in the toolbar.

- The table is rebuilt on every refresh, so these header clicks are **delegated** on `#panelTableContainer` (matching `.select-line-th-wholesale` / `.select-line-th-stats`), not bound to the cells directly.
- Gotcha: the per-second `updateSelectLineTimeCells()` updater is scoped to `tbody .active-time-column` — the header toggle cell also carries `.active-time-column`, and an unscoped query would overwrite it and shift every player's time down a row.

**Auto algorithm:**
1. Determine expected player count and gender ratio from game settings; subtract what's already checked.
2. Sort the remaining roster by points played ascending (fewest first).
3. Fill the gender deficit first (target counts minus already-selected per gender), then top up any remaining slots from whoever's left.

### Combined vs Separate line planning

`game.pendingNextLine.useSeparateLines` (synced, last-writer-wins on `useSeparateLinesAt`) controls how the coach plans lines and what the line-type toggle button flips between:

- **Combined** (default) — one **Next** line (`odLine`) plus an **On Deck** line (`odOnDeckLine`); the toggle flips `od ↔ odOnDeck`.
- **Separate** — distinct **O** and **D** lines; the toggle flips `o ↔ d` (green/red cue). On Deck is Combined-only.

The flag only changes which buckets the UI exposes — `getEffectiveLineForNextPoint` still blends `oLine`/`dLine`/`odLine` by timestamp at point start, so the fielded-line logic below is unchanged. `autoSelectActiveTypeForNextPoint` is clamped so Combined mode never lands on a side-specific bucket the UI can't show.

### Effective Line for the Next Point

The Line tab maintains up to three independent lineups per game — `oLine`, `dLine`, and `odLine` — under `game.pendingNextLine`. When `startNextPoint()` fires, only one of them gets played. The selection rule (in `getEffectiveLineForNextPoint(game)` in `game/gameScreen.js`) is intentionally simple:

1. Determine whether the next point is offense or defense (via `determineStartingPosition()`).
2. Compare the matching typed line's `*ModifiedAt` to `odLineModifiedAt`. The most recently edited non-empty line wins.
3. Fall back to whichever is populated; final fallback is empty `odLine`.

The interesting consequence: a separate O line, once created, persists across points until the OD line is edited *more recently*. Run a separate O line for several offense points without re-touching it, sprinkle in a defense point, run the O line again — all without re-doing the lineup.

`autoSelectActiveTypeForNextPoint()` keeps the visible view in lockstep with the effective line by setting `pendingNextLine.activeType` to match. It runs both at point-end transition (`transitionToBetweenPoints`) and after each `refreshPendingLineFromCloud` poll cycle, so the Active Coach's view follows the Line Coach's edits without any manual toggle. The Start Point button label tags the line type when a separate typed line is in play (`Start Point (O-line)` / `Start Point (D-line)`); the combined OD case stays `Start Point (Offense)` / `Start Point (Defense)`.

Feedback colors (count / gender-ratio warnings) on the Start Point button are computed against the *effective* line, not the visible checkboxes — so even if a coach is browsing a different line at tap time, the feedback hue reflects what would actually start.

### On Deck Line (planning two points ahead)

The Line Coach can prepare the line for the point *after* the next one while the current point is still in progress. This is a single, **side-agnostic** lineup (not a full O/D/OD mirror): `game.pendingNextLine.odOnDeckLine`, paired with `odOnDeckLineModifiedAt`. The motivation: once the next line is set, the Line Coach was otherwise idle and would start points early just to advance the panel.

**Toggle / storage.** On Deck is the second view in **Combined** mode — the line-type toggle flips `od ↔ odOnDeck` (see *Combined vs Separate line planning* above). The `activeType` value `'odOnDeck'` is chosen so the existing `activeType + 'Line'` string-concatenation pattern (used throughout `savePanelSelectionsToPendingNextLine`, `updateSelectLineTable`, `updateSelectLineSubtitle`) resolves to the `odOnDeckLine` bucket with no special-casing.

**Promotion.** In `startNextPoint()` (`game/pointManagement.js`), *after* the effective line for the point being started has been read, a non-empty `odOnDeckLine` is promoted into the next-line bucket: `odLine = [...odOnDeckLine]; odLineModifiedAt = now`, then `odOnDeckLine` is cleared. Promotion is side-agnostic — it always seeds `odLine`, dodging the O/D side-consistency logic entirely; `getEffectiveLineForNextPoint` then resolves the side normally at the following point. Stamping `odLineModifiedAt = now` (a time *during* the just-started point) is load-bearing: it keeps the promoted line from being overwritten by the ending-7 reseed in `transitionToBetweenPoints`, whose reference time is the *previous* point's end. Empty On Deck = no-op; the cleared view re-renders to its empty default for fresh planning.

**Projection column.** In the On Deck view only, `updateSelectLineTable` appends one read-only column: each player's points-played-so-far, `+1` if they're in the *tentative next* set (a dash otherwise, matching the table's points-not-played idiom). The tentative-next set is phase-dependent — `isPointInProgress() ? odLine : getEffectiveLineForNextPoint(game).line` — because the O/D side is genuinely unknown until the in-progress point ends. The column is pure-derived (recomputed each render, no stored projection state). Its header is colored by the on-deck point's gender ratio via `getGenderRatioForPoint(game, game.points.length + 1)` — deterministic because the alternation schedule doesn't depend on who wins.

**Two guards** keep the new view from leaking into the next-line logic:
- `getEffectiveLineForNextPoint` treats a `lineCoachViewing` value of `'odOnDeck'` as "no Next-line view preference" (Priority 1 is skipped) — an On Deck view must never resolve into a Next bucket.
- `autoSelectActiveTypeForNextPoint` returns early when `activeType === 'odOnDeck'`, so a coach planning On Deck isn't yanked back to the Next view when a point ends.

**Sync.** `odOnDeckLine` merges per-axis by `odOnDeckLineModifiedAt`, exactly like the O/D/OD lines: added to `_LINE_KEYS` in `merge_pending_next_line` (`ultistats_server/storage/game_storage.py`), to both client read-merge sites in `store/sync.js`, and to `serializeGame`/`deserializeGame` in `store/storage.js`. (`activeType` itself stays local-only, as before.)

### Lineup Ready Signal

Multi-coach coordination ping. The Line Coach taps a button on the Line tab to signal the Active Coach that the next line is set. Implementation:

- `game.pendingNextLine.lineupReadyAt` (ms timestamp) and `lineupReadyBy` (display name) — written by the Line Coach, persisted via `serializeGame` (in `store/storage.js`) so they cross the sync boundary.
- The Active Coach's existing 3-second pendingLine refresh diffs the timestamp pre/post-merge. New + recent (<60s) → toast `<Coach> says lineup ready`.
- Visible state machine, shared between both coaches:
  - **Active** (Line Coach, no ping yet this window): blue button, label `Lineup Ready`, tap sends.
  - **Sent**: green button/badge, label `✓ Lineup Ready`. Both coaches see it.
  - **Pending** (Active Coach view, awaiting ping): desaturated-blue read-only badge, label `Lineup Pending`.
  - **Disabled**: solo coach, point in progress, no peer, etc. — desaturated-blue, tap surfaces a reason toast.
- Staleness gate: a `lineupReadyAt` from before the most recent `point.startTimestamp` is treated as leftover from a prior between-points window, not the current one. This is also how the field gets implicitly "cleared" cross-device — `startNextPoint` sets the local copy to null, but the staleness check is what makes the UI actually reset.

The ping is **not** a commit gate. Lineup edits sync continuously through `savePanelSelectionsToPendingNextLine` → `saveAllTeamsData()` → server, regardless of whether the Lineup Ready ping has been sent.

### Multi-Coach Connection Recovery

Three layers, in order from least to most invasive:

1. **Server-side role timeout = 120s** (`STALE_TIMEOUT_SECONDS` in `ultistats_server/storage/controller_storage.py`, override via `BREAKSIDE_STALE_TIMEOUT` env var). Mobile browsers aggressively throttle/freeze setInterval when the page is hidden, so a coach pocketing their phone for ~half a minute would lose their roles; 120s gives a more forgiving grace window. Genuine disconnects still free the role eventually.
2. **Wake-handler fallback** (`document.addEventListener('visibilitychange', ...)` in `game/controllerState.js`). If polling was running before the sleep, immediately re-pings + retries to re-claim any expired roles. New: if `currentGameIdForPolling` is null but `currentGame()` exists (PWA reload from background that didn't restart polling), it now restarts polling from the in-memory game id.
3. **Manual "Rejoin Game" menu item** (in the in-game hamburger menu). Visible only when controller polling is not active. Tapping it walks `currentGame()` → `teams[].games` (any game without `gameEndTimestamp`) to find the in-progress game and calls `startControllerPolling(gameId)`. Toast: `"Reconnected — tap a role button to reclaim it"`. The fallback path covers cases where the wake handler couldn't fire (e.g. user opened the menu without a sleep/wake cycle).

### In-Game Tab System

The in-game UI is organized into five tabs, switched via a segmented control in the orange header:

- **Simple** — The legacy Key Play–driven Play-by-Play panel only, full-screen. Streamlined buttons (We Score / They Score / Key Play / Undo / Sub / Events / More) plus the Key Play modal for granular event entry.
- **Full** — The new every-event-entry panel (`playByPlay/fullPbp.js`), full-screen. Player rows + per-row contextual action buttons (drop / score / throwaway / break / block / interception / …), a horizontal modifier-flag chip strip below, a bottom-row "They turnover / Events / They score" action set in D-mode, and a flex-sized mini event log at the bottom. See **docs/full-pbp-requirements.md** for the full design and **Full PBP integration** below for the runtime architecture.
- **Line** — Select Next Line panel only, full-screen (the O/D toggle switches the single panel between combined, O, D, and On Deck views).
- **Log** — Game Log (Follow) panel only, full-screen.
- **All** — The full vertical panel stack with drag-to-resize (see next section). Default tab. Uses Simple PBP — the Full PBP layout is excluded from All-view because its custom-shaped panel doesn't compose well with the drag-to-resize stack.

The segmented control DOM lives in `createHeaderPanel()` (`game/gameScreen.js`); switching logic and persistence live in `panelSystem.js` (`switchTab()`, `applyTabState()`, `updateSegmentedSlider()`). Active tab is persisted in `localStorage` under `breakside_active_tab`. The most-recent PBP tab choice (`simple` or `full`) is separately tracked under `breakside_last_pbp_tab` so post-score auto-navigation (Line tab → user's preferred PBP tab) routes back to whichever the user was last using.

**Single-tab mode** sets the visible panel's class to `tab-fullscreen`, which hides its title bar and applies `flex: 1 1 auto` so it fills the viewport. All other content panels get `hidden`. **All mode** removes the class and re-applies saved panel states via `applyAllPanelStates()`, restoring drag heights.

`updatePanelsForRole()` re-applies the tab state at the end so role-based visibility (e.g. viewer mode hiding play/line panels) doesn't leak into single-tab mode. `enterSplitMode`/`exitSplitMode` adjust `selectLine` vs `selectOLine`/`selectDLine` visibility independently of the tab state, and the Line tab routes to whichever panels are appropriate.

### Panel Drag-to-Resize System

The in-game UI is a vertical stack of panels managed by `ui/panelSystem.js`. Panels are resized by dragging their title bars. The last panel (Follow/Game Log) is flex-fill and absorbs remaining space. This system is active in the **All** tab; in the other tabs, drag handles are hidden and a single panel fills the viewport.

**Layout model:** Panels `P[0], P[1], …, P[N-1]` are stacked vertically. Each has a title bar (~36px) at its top edge and a content area below. Each has a `minHeight` (title-bar-only for most; larger for PBP and Follow). Title bar position of panel `i` equals the sum of heights of panels `0` through `i-1`.

**Drag algorithm — `moveTitleBar(i, delta)`:** A recursive function that moves title bar `i` by `delta` pixels. Moving down grows the panel above and shrinks the panel below. When the panel being shrunk hits its `minHeight`, the function recurses to push the next neighbor in the same direction (cascading). Title bar 0 is pinned (never moves). Follow (last panel) absorbs freely with no title bar below to push.

```
moveTitleBar(i, delta):
    if delta > 0 (moving down):
        canShrink = height[i] - minHeight[i]
        if canShrink < delta and not last panel:
            pushed = moveTitleBar(i + 1, delta - canShrink)  // cascade
            canShrink += pushed
        actual = min(delta, canShrink)
        height[i-1] += actual    // panel above grows
        height[i]   -= actual    // panel below shrinks

    if delta < 0 (moving up):
        canShrink = height[i-1] - minHeight[i-1]
        if canShrink < |delta| and i-1 > 0:
            pushed = moveTitleBar(i - 1, delta + canShrink)  // cascade
            canShrink += |pushed|
        actual = max(delta, -canShrink)
        height[i-1] += actual    // panel above shrinks
        height[i]   -= actual    // panel below grows
```

**Two drag modes** (toggled in Settings):

- **Spring-back (default):** Each frame resets heights to their start-of-drag values and applies the absolute delta from the drag start position. When the finger reverses, all panels spring back to their original sizes.
- **Physical:** Each frame applies an incremental delta from the previous frame's position. Pushed panels stay where they are because nothing asks them to move back — the recursion only pushes, never pulls.

**Line type toggle:** The O/D button on the Select Next Line toolbar cycles through four modes: `od` → `o` → `d` → `odOnDeck` → `od`. Each mode manages a separate player selection stored in `pendingNextLine` (`odLine`, `oLine`, `dLine`, `odOnDeckLine`). When a point ends, `selectAppropriateLineAtPointEnd()` (→ `autoSelectActiveTypeForNextPoint()`) decides which view to show next:
- If the coach was in combined `od` view, it stays in `od` (sticky preference).
- If in `o` or `d` view, auto-switches to `o` or `d` based on who scored (team scored → defense next, opponent scored → offense next).
- If in `odOnDeck` view, it stays there (the coach is planning two points ahead; don't interrupt — see *On Deck Line* above).

### Full PBP integration

The "Full" tab (`playByPlay/fullPbp.js`) is a self-contained panel that subscribes to `narrationEventBus` and writes events through the same code paths the manual Key Play flow and AI narration use — `ensurePossessionExists`, stat updates, `logEvent`, `updateScore` / `moveToNextPoint`, `saveAllTeamsData`. There's no separate Full-PBP data model.

Key runtime properties:

- **State reconstruction.** Every `render()` call walks the current point's possessions and derives `(mode, holder)` from the most recent event, rather than storing UI state. Drop a Simple Mode event mid-stream, undo via the global Undo, or have narration finalize a slow-pass — the Full panel reflects the new truth on the next render.
- **Inferred events.** A boolean `inferred_flag` on the base `Event` class (default `false`) is set on synthetic events created by the Full panel's O/D pill toggle (Turnover / Defense{unforcedError}). Surfaces as `(inferred)` prefix in `summarize()` output. Tap the pill twice in a row with no events between → second tap retracts the inferred event rather than stacking another one.
- **Bus integration.** Full PBP publishes `eventAdded` (source `'manual'`), `eventAmended` (modifier-chip toggles), and `eventRetracted` (Undo, pill-toggle retraction) so other subscribers (transcript display, future ultra-compact log) see all manual edits the same way they see narration events.
- **Layout.** Player rows fill the panel's full width; modifier chips live in a horizontal strip below the rows; a bottom action row holds `[They turnover] [⚙ Events] [They score]` in D-mode and just `[⚙ Events]` centered in O-mode; a mini event log fills whatever vertical slack remains. Density is governed by a small set of CSS knobs flipped between "roomy" (default, build-207 values) and "compact" (build-206 values) by an inline icon button in the Full PBP header; the choice is persisted per-device in localStorage (`breakside_full_pbp_density`, see `playByPlay/fullPbp.js`) and applied as a `density-compact` class on `.panel-playByPlayFull`.
- **Score auto-tab-switch.** `moveToNextPoint()` (in `game/pointManagement.js`) auto-switches to the **Line** tab if the current user holds the Line Coach role, regardless of which PBP mode (Simple, Full, narration) triggered the score. Conversely, `startNextPoint()` auto-switches from the Line tab back to the user's last-used PBP tab — so a solo coach round-trips Simple/Full → Line → Simple/Full automatically.

Full design + decision history: **docs/full-pbp-requirements.md**.

### Field PBP spatial coordinate frame

The "Field" tab (`playByPlay/fieldPbp.js`) is a spatial event-entry surface: the
coach taps a drawn field to record *where* each throw / catch / turnover / block
/ pull happened. It writes the same `Throw` / `Turnover` / `Defense` / `Pull`
events as the other tabs (through `pbpPossession`), but each event also stores a
`from` / `to` location.

Stored locations use a **normalized, size-independent field frame** — an `{x, y}`
pair on each event's `from` / `to`:

- **`x` = progress toward the attacking endzone.** `x = 0` at the **defending**
  endzone (goal) line, `x = 1` at the **attacking** endzone (goal) line. `x < 0`
  is inside the defending endzone; `x > 1` is inside the attacking endzone.
- **`y` = across the field.** `y = 0` at the **home** sideline, `y = 1` at the
  **away** sideline.

Why normalized rather than yards: the frame is deliberately decoupled from the
endzone-depth setting and from yards/meters, so it works unchanged for short
fields (4v4/5v5/middle-school) and **a change to the endzone-depth setting only
re-scales the on-screen endzone margins — it never moves a stored point relative
to the playing field.** (This supersedes an earlier "canonical yards keyed off
endzone depth" frame, which re-scaled past games when the depth setting changed.)

At render time the normalized `{x, y}` is scaled to the on-screen field — whose
length *includes* the depth-dependent endzones — by the yard-based `pct()` /
`toField()` helpers; `toNorm()` / `fromNorm()` in `fieldPbp.js` are the only
bridge between the two frames. The two display flips (`flipAD` = attack
direction, which auto-alternates per point; `flipHA` = which sideline is home)
are **render-time only** — stored `{x, y}` never change, so re-opening a game or
flipping orientation never moves a recorded event. The canonical convention lives
in the `fieldPbp.js` file header; keep the two in sync.

### Feature Worktrees

For parallel development, feature branches use git worktrees in `.worktrees/<feature-name>`. See CLAUDE.md for the workflow.

### Offline Support

The service worker implements a network-first strategy with cache fallback:

1. Try network request first
2. On success, cache the response
3. On failure (or timeout), serve from cache
4. API calls to `api.breakside.pro` are never cached

---

## Backend Architecture

### Local development backends (isolated per session)

When several Claude Code sessions / worktrees advance different server-side work
at once, each should run its **own** backend against its **own** copy of the
data store — never sharing state, and never pointing a localhost frontend at the
production API (which risks polluting real games and writing experimental schema
into prod). `scripts/dev-backend.sh` provides this:

```bash
./scripts/dev-backend.sh                     # auto-picks a free port from 8000;
                                             # copies the main worktree's data/ into
                                             # .dev-data/be-<port>/ and serves it
./scripts/dev-backend.sh --port 8001 --label on-deck   # explicit port + named data dir
./scripts/dev-backend.sh --fresh             # empty data store
./scripts/dev-backend.sh --from <dir>        # seed from a snapshot (e.g. a prod export)
./scripts/dev-backend.sh --reset             # wipe & re-seed this label's data
```

Each instance runs with `ULTISTATS_AUTH_REQUIRED=false` (no Supabase secrets
needed; membership checks are skipped — see [dependencies.py](ultistats_server/auth/dependencies.py)),
so a locally-served frontend reads/writes the copied data with no CORS or auth
setup. Pair a frontend by opening it once with `?api=http://localhost:<port>`
(saved to that origin's localStorage; `?api=reset` clears it). Because
localStorage is keyed per origin **including port**, frontend port 3001↔backend
8001 and 3002↔8002 stay independent. `--reload` watches the worktree's own
`ultistats_server/`, so each session tests its own server changes. The
`.dev-data/` copies are gitignored and disposable.

This is the durable replacement for adding `localhost` to the prod API's
`ULTISTATS_ALLOWED_ORIGINS` — keep prod CORS locked to the real origins.

#### `uvicorn` / `pytest` not found on PATH (python.org macOS builds)

If a bare `uvicorn main:app …` or `pytest` reports "command not found" even
though they're installed, the package console-scripts are in the python.org
framework's own `bin/` — which the installer does **not** add to PATH. It only
symlinks the interpreter (`/usr/local/bin/python3.12 → …/Versions/3.12/bin/python3.12`);
the `uvicorn`/`pytest`/`fastapi`/`pip` wrappers next to it stay unreachable.

Two ways through it:

```bash
# One-off: run the module via the interpreter (no PATH change needed)
/usr/local/bin/python3.12 -m uvicorn main:app --reload --port 8000

# Permanent: put the framework bin on PATH (add to ~/.zshrc), so the bare
# `uvicorn` / `pytest` commands in this doc and CLAUDE.md just work:
export PATH="/Library/Frameworks/Python.framework/Versions/3.12/bin:$PATH"
```

### Server Stack

| Component | Details |
|-----------|---------|
| **Runtime** | Python 3.8 with venv |
| **Framework** | FastAPI with uvicorn |
| **Web Server** | nginx (reverse proxy, SSL termination) |
| **Process Manager** | systemd |
| **Data Storage** | JSON files on filesystem |
| **SSL** | Let's Encrypt (certbot) |

### TLS Certificate Renewal (and the PATH gotcha)

nginx terminates TLS using Let's Encrypt certs under `/etc/letsencrypt/live/`. Two
lineages exist: `api.breakside.pro` (covers `api.breakside.pro` + `api.breakside.us`,
both served from EC2) and `api.breakside.us` (the apex/redirect block). **`www.breakside.pro`
must NOT be on any EC2 cert** — it's served by CloudFront, so its http-01 challenge
404s on EC2 and fails the whole renewal.

Renewal runs from `/etc/cron.d/certbot` (`certbot renew --quiet`, twice daily) using the
**nginx authenticator plugin**.

**Historical root cause (June 2026 outage):** the `api.breakside.pro` cert silently failed
to auto-renew for ~3 months and eventually expired, taking the API down. The cron job *was*
running certbot twice daily the whole time, but every run failed with `The nginx plugin is
not working`. The real reason buried in `/var/log/letsencrypt/letsencrypt.log` was
`Could not find a usable 'nginx' binary ... your PATH`: **cron's default PATH
(`/usr/bin:/bin`) does not include `/usr/sbin`, where the `nginx` binary lives.** The nginx
plugin shells out to `nginx`, couldn't find it, and aborted — but only under cron. Run by
hand (login PATH includes `/usr/sbin`) it always worked, which masked the bug. Fix: a
`PATH=...:/usr/sbin:...` line at the top of `/etc/cron.d/certbot`. Verify with
`sudo env -i PATH=/usr/bin:/bin certbot renew --dry-run` (reproduces the failure) vs
adding `/usr/sbin` (succeeds).

**Expiry tripwire:** Let's Encrypt stopped emailing expiry warnings in 2025, so the silent
failure went unnoticed until the API died. `/usr/local/bin/cert-expiry-check.sh` (daily via
`/etc/cron.d/cert-expiry-check`) checks days-to-expiry on every `live/*/fullchain.pem` and,
under 20 days, logs to syslog (`logger -t cert-expiry`) **and** emails dave@luebke.us — an
alarm independent of whatever certbot does, so it catches any future cause.

### Outbound Mail (Postfix → Gmail relay)

The box sends mail (cert alarm; also the old text-adventure game's git-sync/db-backup
notices) via local **Postfix**. EC2 blocks outbound port 25 to the internet, so Postfix
cannot deliver directly — it **must** relay through an authenticated SMTP service. It's
configured to relay through Gmail (`relayhost = [smtp.gmail.com]:587`, SASL creds in
`/etc/postfix/sasl_passwd`, perms 600). The auth account is a `luebke.us` Google account
using an **app password** (not the login password; requires 2FA). If mail stops delivering,
check `sudo postqueue -p` and `/var/log/maillog` — `relay=none ... Network is unreachable`
on port 25 means the relay config was lost; `535 Username and Password not accepted` means
the app password is stale. The harmless `connect to smtp.gmail.com[<ipv6>]:587: Network is
unreachable` log lines are just the box falling back from IPv6 to IPv4.

### Server File Structure

```
ultistats_server/
├── main.py              # App wiring only: FastAPI app, CORS, router includes
├── config.py            # Configuration from environment variables
├── narration.py         # AI narration router (token + finalize endpoints)
├── validation.py        # ID validation + safe static-path resolution
├── requirements.txt     # Python dependencies
│
├── routers/             # API endpoints, one APIRouter per group
│   ├── __init__.py
│   ├── _shared.py       # Dual-mode import shim (storage/auth/config re-exports)
│   ├── auth_api.py      # /api/auth/* (me, sync-check, teams)
│   ├── events.py        # /api/events*, /api/teams/{id}/events
│   ├── games.py         # /api/games* (sync, list, phase, versions, restore)
│   ├── controller.py    # Controller roles: status/claim/release/handoff/ping
│   ├── shares.py        # Game share links + public /api/share/{hash}
│   ├── invites.py       # Team invites + redeem/revoke
│   ├── teams.py         # Team CRUD, members, roster, games, active-game
│   ├── players.py       # Player CRUD + games/teams lookups
│   ├── misc.py          # /api info, /health, /api/proxy-image, /api/index/*
│   └── static_files.py  # PWA/landing/join serving; /{path} catch-all is LAST
│
├── storage/             # Data storage layer
│   ├── __init__.py
│   ├── _config.py       # Dual-mode config import (single copy of the dance)
│   ├── file_utils.py    # atomic_write_json + entity_lock (crash/race safety)
│   ├── id_utils.py      # Shared {name}-{hash} ID generation
│   ├── entity_store.py  # JsonEntityStore: shared CRUD for player/team/event
│   ├── json_index.py    # JsonIndex: locked, atomic _index.json plumbing
│   ├── game_storage.py  # Game versioning, merge, pruning
│   ├── team_storage.py  # Team CRUD operations
│   ├── player_storage.py# Player CRUD operations
│   ├── event_storage.py # Tournament/event CRUD operations
│   ├── user_storage.py  # User account CRUD operations
│   ├── membership_storage.py # Team membership management
│   ├── invite_storage.py    # Invite code management
│   ├── share_storage.py     # Game sharing management
│   ├── controller_storage.py # In-memory game controller state (single-worker!)
│   └── index_storage.py # Cross-entity index management
│
├── static/
│   └── viewer/          # Static game viewer
│       ├── index.html
│       ├── viewer.js
│       └── viewer.css
│
├── auth/                # Authentication
│   ├── __init__.py
│   ├── jwt_validation.py   # Supabase JWT verification
│   └── dependencies.py     # FastAPI auth dependencies
│
└── tests/
    └── narration/       # Audio-driven narration test harness
        ├── runner.py            # Streams audio → transcript → /finalize → metrics
        ├── test_scenarios.py    # pytest entry point (auto-discovers scenarios)
        ├── tools/
        │   └── generate_synthetic_audio.py   # OpenAI TTS → audio.flac
        └── scenarios/
            └── 001_single_throw/
                ├── transcript.txt   # ground-truth narration
                ├── roster.json      # on-field players + game context
                ├── expected.json    # expected events
                └── audio.flac       # 24kHz mono FLAC, lossless
```

### Data Directory Structure

```
/var/lib/breakside/data/
├── games/
│   └── {game_id}/
│       ├── current.json      # Latest game state
│       └── versions/         # Historical versions
│           ├── 2024-01-15T10-30-45.json
│           └── 2024-01-15T10-35-12.json
├── teams/
│   └── {team_id}.json
├── players/
│   └── {player_id}.json
├── users/
│   └── {user_id}.json        # User profile (synced from Supabase)
├── memberships.json          # Team membership index
└── index.json                # Cross-entity index
```

**Ops rule: never run servers or scripts that touch `/var/lib/breakside/data`
as root.** The API runs as the `breakside` service user; anything created by
root (a dir, a `versions/` folder, an index file) is root-owned and the
service user can no longer write inside it. This caused a real incident
(2026-07-03): one root-owned `versions/` dir made every sync of that game 500
with `PermissionError`. Always run one-off scripts/servers as the service
user (`sudo -u breakside ...`), and fix damage with
`chown -R breakside:breakside /var/lib/breakside/data`. Two server-side
guards now exist, but prevention still beats them: at startup the app probes
the data dir and refuses to boot if it isn't writable (unwritable *nested*
dirs are logged as prominent ERRORs without blocking startup — see
`storage/file_utils.assert_data_dir_writable`, called from the lifespan in
`main.py`), and a failed version-backup write no longer fails the sync (see
below).

### API Endpoints

#### Games
- `POST /api/games/{game_id}/sync` - Sync complete game state
- `GET /api/games/{game_id}` - Get current game state
- `GET /api/games` - List all games (list metadata includes each game's `phase`)
- `PATCH /api/games/{game_id}/phase` - Update only a game's `phase` label (retroactive event-phase labeling). Metadata-only write — does **not** create a version backup like a full sync does
- `DELETE /api/games/{game_id}` - Delete game

#### Teams
- `POST /api/teams/{team_id}/sync` - Sync team data
- `GET /api/teams/{team_id}` - Get team
- `GET /api/teams` - List all teams
- `GET /api/teams/{team_id}/events` - List a team's tournament events

#### Events
- `POST /api/events` - Create a tournament event
- `GET /api/events/{event_id}` - Get an event
- `PUT /api/events/{event_id}` - Update an event (name, defaults, roster, `phases`)
- `DELETE /api/events/{event_id}` - Delete an event (games become standalone)

#### Players
- `POST /api/players/{player_id}/sync` - Sync player data
- `GET /api/players/{player_id}` - Get player
- `GET /api/players` - List all players

#### Index
- `POST /api/index/rebuild` - Rebuild cross-entity index
- `GET /api/index` - Get current index

#### Versions
- `GET /api/games/{game_id}/versions` - List all versions
- `GET /api/games/{game_id}/versions/{timestamp}` - Get specific version
- `POST /api/games/{game_id}/restore/{timestamp}` - Restore to version

#### Authentication
- `GET /api/auth/me` - Get current user profile (requires auth)
- `PATCH /api/auth/me` - Update current user profile
- `GET /api/auth/teams` - List teams user has access to

#### Memberships
- `POST /api/teams/{team_id}/invite` - Generate invite code
- `POST /api/invites/{code}/redeem` - Redeem invite code
- `GET /api/teams/{team_id}/members` - List team members
- `DELETE /api/teams/{team_id}/members/{user_id}` - Remove member

#### Game Control
- `GET /api/games/{game_id}/controller` - Get controller state (roles, pending handoffs)
- `POST /api/games/{game_id}/ping` - Ping to keep role alive; returns controller state + `connectedCoaches` list
- `POST /api/games/{game_id}/claim-active` - Request Active Coach role
- `POST /api/games/{game_id}/claim-line` - Request Line Coach role
- `POST /api/games/{game_id}/release` - Release current role
- `POST /api/games/{game_id}/request-handoff` - Request handoff of a role from current holder
- `POST /api/games/{game_id}/handoff-response` - Accept or deny a handoff request

#### AI Narration
- `POST /api/narration/token` - Mint an ephemeral OpenAI Realtime API session token (so the browser can open a WebSocket without seeing the real API key)
- `POST /api/narration/finalize` - Run the slow-pass: take the accumulated transcript + roster + game context, return a list of `ADD` operations from Claude Sonnet describing the events found in the narration

---

## Data Model

### Names in examples, fixtures and test data

**Never commit a real player's name.** Breakside is coached by the people who
build it, so real rosters leak in easily — sample teams, test fixtures, prompt
examples, mockups, screenshots, commit messages. Everything in the repo uses one
canonical fictional roster, the same one the landing-page screenshots show:

| # | Name | | # | Name |
|---|---------|---|---|---------|
| 7 | Alice | | 5 | Hank |
| 11 | Bob | | 14 | Iris |
| 3 | Charlie | | 8 | Jake |
| 22 | Dana | | 2 | Kris |
| 9 | Eve | | 17 | Mia |

Extend with Nora / Omar / Sam / Tara / Wes / Zoe, and `Morgan Vale` ("MV")
where a full name is needed. Teams are `Team A`…`Team I`; `Breakside` vs
`Rival City` in user-facing screenshots; team symbols `BRK` / `RVL`.

Two standing exceptions, both deliberate:

- `ultistats_server/tests/narration/scenarios/001`–`021` use their own
  synthetic roster (Alice / Bob / Carla / Daniel / Ella / Felix / Gina, plus
  Cara / Sky / Hannah). Each scenario's `audio.flac` **speaks** those names, so
  renaming the fixtures would desync them from the audio and silently break the
  eval. Leave them alone, and mirror that roster in the prompt examples in
  `ultistats_server/narration.py` that describe it.
- `Dave` / `David Luebke` appear as the author's own name — the LICENSE
  copyright, `Coach Dave` signup placeholders, `Dave L.` invite copy, and
  review-doc prose. Those are intentional, not leaks.

Recorded audio is the one thing a find-and-replace cannot fix. If you hand-record
a narration scenario, call the generic roster out loud.

### Entity IDs

Human-readable IDs with collision-resistant hash suffix:

```javascript
/**
 * Generate a short, human-readable ID
 * Format: {sanitized-name}-{4-char-hash}
 * Examples: "Alice-7f3a", "Sample-Team-b2c4"
 */
function generateShortId(name) {
    const safeName = name
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 20)
        .replace(/-+$/, '');
    
    const hash = Math.random().toString(36).substring(2, 6);
    return `${safeName}-${hash}`;
}
```

**Collision Handling:**
- On sync, if ID exists with different data, append 2 more chars
- Example: `Alice-7f3a` collides → try `Alice-7f3a2b`
- Extremely rare with 4-char hash (1 in 1.6M chance per name)

### point.players entries: names OR ids (data eras)

`point.players` (and `substitutedOutPlayers` / `substitutedInPlayers`) store
bare strings with no `{name, id}` structure, and what those strings *are*
varies by data era:

- **names** — older games and locally-picked lines (checkbox flows)
- **player ids** — games whose lines came through `pendingNextLine` sync
  (e.g. the Nov-2025 Team D tournament)
- **stale names** — a player renamed or removed mid-game leaves the old
  name frozen in earlier points

**Never resolve these entries with a raw `getPlayerFromName()`** — an id-era
or stale entry comes back `undefined`, which has variously meant dead
Proceed buttons (pull/score dialogs) and player rows silently vanishing
(Full PBP, Field rail). Route through the helpers in `utils/helpers.js`:

- `buildPointPlayerLookup(game)` — entry → `{player, name, obj}` for UI that
  renders player buttons/chips from `point.players` (`obj` is always safe to
  render or record an event against; it falls back to `playerStub(name)`)
- `buildPointMembership(game)` — rename-proof onLine/subbedOut/played tests
- `buildPlayerNameResolver(game)` — entry → stable stats key (stats layer)

Related: button labels may carry jersey-number suffixes
(`formatPlayerName`), so match buttons on `dataset.playerName` (canonical
current name), never on `textContent`.

### Server-Side Index

Cross-entity index for efficient queries:

```json
{
  "lastRebuilt": "2024-01-15T10:30:00Z",
  "playerGames": {
    "Alice-7f3a": ["game_id_1", "game_id_2"],
    "Bob-2d9e": ["game_id_1"]
  },
  "teamGames": {
    "Sample-Team-b2c4": ["game_id_1", "game_id_2"]
  },
  "gameRoster": {
    "game_id_1": ["Alice-7f3a", "Bob-2d9e", "Charlie-4k1m"]
  }
}
```

**Rebuild Logic:**
- Scan all games, extract player IDs from roster snapshots
- Scan all teams, extract player IDs
- Takes ~1 second for hundreds of games
- Triggered via `POST /api/index/rebuild` or automatically if missing

### Roster Snapshots

Games capture player state at game time for historical accuracy:

```javascript
{
  rosterSnapshot: {
    players: [
      {
        id: "Alice-7f3a",
        name: "Alice",
        nickname: "Ace",
        number: "7",
        gender: "FMP"
      }
    ],
    capturedAt: "2024-01-15T10:30:00Z"
  }
}
```

### Event References

Events reference players by ID:

```javascript
{
  type: "Throw",
  throwerId: "Alice-7f3a",
  receiverId: "Bob-2d9e",
  // ... flags
}
```

### Tournament Events and Phases

A `TournamentEvent` groups a team's games (tournament, league, etc.) for aggregate stats and a shared event roster. Stored server-side one JSON file per event (`storage/event_storage.py`), referenced from each game via `game.eventId`.

Events carry an ordered, free-form **phases** list, and each game carries an optional `phase` label:

```javascript
// TournamentEvent
{ id, name, teamId, status, defaults, roster, gameIds,
  phases: ["Day 1", "Day 2", "Bracket"] }   // ordered, free-form

// Game
{ /* … */ eventId: "HS-States-a3f2", phase: "Day 1" | null }
```

- **Retroactive & backwards-compatible.** Both fields default to `[]` / `null`. Games predating the feature read back as `phase: null` ("Unassigned"); events without phases behave exactly as before. The schema-loose JSON storage round-trips both with no migration.
- **Phase writes are metadata-only.** The per-game phase picker calls `PATCH /api/games/{id}/phase` rather than a full game sync, so labeling doesn't spawn a version backup of the whole game.
- **Stats are phase-aware.** `getEventPlayerStats`, `getEventRecord`, and `getEventTeamStats` take an optional `{ phase }` filter to scope aggregation to one phase ("Day 1 holds", "bracket-only hockey assists").

### Derived Statistics

All stats are computed on demand from the event stream — none are stored on players. The live aggregation path is `utils/eventStats.js` (the older `utils/statistics.js` is legacy):

- **Player stats** (`accumulateGameStats`): goals, assists, **hockey assists** (the thrower of the pass *before* the assist) and **huck hockey assists** (a hockey assist that was itself a huck — counted in the HA total too), completions, completion %, hucks, defensive plays, turnovers, +/-, points/time played.
- **Team point classification** (`classifyPoint`): each completed point is one of `break` (scored on D), `cleanHold` (scored on O, no turnover), `hold`/dirty (scored on O after ≥1 turnover), `broken` (started O, lost), or `opponentHold` (started D, lost). Surfaced as per-point badges in the game log and as a per-game / per-event summary line.
- **Break denominators.** `getGameTeamStats` reports breaks per D-point *and* per D-possession. A D-point can contain multiple defensive possessions (turnover-back), so the per-possession rate is the truer measure of D-line conversion.

### Possession Sets (zone tracking)

Teams can tag each possession with the set being played — zone, ho-stack,
vert, force-middle, junk — so "is our zone working?" becomes answerable.
The whole feature is **invisible until a team opts in**.

```js
// Team
{ setsEnabled: false,                       // team-level opt-in
  sets: { offensive: [], defensive: [] } }  // coach-defined label lists

// Possession
{ set: "Zone" | null }                      // null = unspecified
```

- **One set per possession — a mid-possession switch overwrites.** `set` is a
  single label, so a team that starts a defensive possession in zone and calls
  "Fire!" partway through can only re-tag it: the possession then reads as man
  for its whole length, and the zone that forced the situation gets no credit
  in the breakdown. Recording the *transition* would need `set` to become a
  sequence (or a set-change event on the possession's event stream) plus a rule
  for which segment a stop or break is attributed to. See TODO.md § Backlog for
  the sketch.

- **Where tags come from.** One control, in three places, all tagging the same
  live possession and offering the label list for the side in play — offensive
  labels on offence, defensive on defence:
  - **Full tab header**, on the top line with the O/D pill and Undo. The
    primary one: a coach taps it as the possession unfolds.
  - **Full tab modifier row** ("Last pass was a:" / "Last D was a:"), a mirror
    of the same possession, so whatever was picked during the possession is
    what shows next to the play it belongs with.
  - **Field tab action row**, immediately left of Events.

  **Tap cycles** — → label1 → … → —; **long-press (450 ms) opens the full
  list**, which also surfaces a tag whose label the team has since deleted
  (marked "no longer configured"). Gestures live in
  [ui/setPicker.js](ui/setPicker.js) and the side/cycle logic in
  [utils/possessionSets.js](utils/possessionSets.js), both shared, so no
  surface can drift from another. Simple mode is deliberately not tagged.
  Missing fields default to `false` / `[]` / `null`, so legacy games need no
  migration.
  - Possessions are created on the first recorded event, so the control appears
    after the pull on a D point and after the first throw on an O point. A set
    tap never materializes a possession — empty possessions carry their own
    undo/cleanup edge cases.
  - The Field control is hidden between points: that's when its row is tightest
    (the O/D pill becomes "Start Point (Offense)") and there is no live
    possession to tag anyway.
  - The pull dialog used to hold a defensive-set picker. Removed 2026-08-09: it
    overflowed the dialog on a phone, and at pull time the coach usually can't
    know yet what set the D will end up running. Tagging once play makes it
    obvious is both easier and more accurate.

- **Labels are snapshots, not references.** `Possession.set` is a plain string
  copied in at tag time. Editing Team Settings → Set Tracking changes only what
  is *offered* next; it never renames, remaps or removes a tag already recorded
  on a possession, and nothing in the codebase reconciles the two. So renaming
  "Zone" to "Zone 3-3-1" leaves every previously tagged possession reading
  "Zone", and the breakdown will show both as separate rows — it groups by the
  strings actually present in the data, not by the team's current lists. A tag
  whose label no longer exists still displays and still aggregates; tapping the
  control clears it to unspecified first, then rejoins the current cycle.

- **Aggregation is per possession, not per point** — the mismatch that shapes
  everything below. `getGameTeamStats().sets` returns records keyed
  `` `${side}:${label}` `` (a label listed under *both* sides stays two rows,
  because the denominators mean different things):

  | Field | Side | Meaning |
  |---|---|---|
  | `possessions` | both | possessions tagged with this set, completed points only |
  | `stops` | D | possessions where we got the disc back instead of being scored on |
  | `breaks` | D | won D-points credited to this set |
  | `scores` | O | possessions that ended in our goal |

- **Two attribution rules worth knowing**, both chosen to avoid crediting a set
  for something it didn't do:
  0. *(Log rendering trap.)* A `Turnover` makes the log emit an **inline**
     "on defense" delimiter and suppress the following possession's own, so
     that inline one has to carry the **next** possession's set tag. Reading it
     off the possession holding the Turnover is what once made mid-point
     defensive sets invisible in the log while offensive ones rendered fine.
  1. A defensive possession counts as a **stop** unless it is the *last*
     possession of a point we lost — that is the one they scored on. A
     defensive possession that ends a point we *won* is a Callahan, so it
     counts as a stop, not a score-on.
  2. A **break** is credited only to the set of the **last defensive
     possession** of a won D-point — the stop we actually converted. Run zone,
     get a stop, turn it over, then get a second stop in man and score, and the
     break goes to man; zone keeps its stop but not the break.

- **One rendering path.** The breakdown rides on the team-stats object, and
  `formatTeamStatsLine` appends it, so both stats screens and all three xlsx
  exports pick it up without call-site changes — they already split that
  string on newlines. Lines are bulleted rather than space-indented because
  `.team-stats-line` is `white-space: pre-line`, which collapses leading
  spaces on screen (they would survive only in the spreadsheet).

- **Silent for everyone else.** Nothing is emitted when no possession carries a
  set, so a team that never opted in sees byte-identical output everywhere.

### Statistics Export (.xlsx)

`utils/xlsxExport.js` builds Excel workbooks via the vendored SheetJS (`vendor/xlsx.mini.min.js`, precached by the service worker for offline use). Three entry points:

| Screen | Workbook layout |
|--------|-----------------|
| Game Summary | One sheet (titled by opponent) |
| Event Roster | "All phases" sheet + one sheet per phase; only attending players; team-stats footer per sheet |
| Team Roster (Edit Roster) | "All games" sheet + one sheet per event the team played + a "Standalone" sheet |

Each sheet is a header + player rows + a Team aggregate row + a breaks/holds footer. Numbers are written as real Excel types (percentages, decimal minutes), and an `!autofilter` scoped to just the header+player rows gives click-to-sort/filter column dropdowns without dragging the title or footer into the sort. Honored by Google Sheets on import.

---

## Sync Strategy

### Full Game Sync (Stateless)

Every sync operation sends the **complete game state**:

- Average game size: ~6 KB (compresses to ~1.2 KB)
- Sync time: ~25-50ms
- Simple, idempotent, easy to debug

```javascript
async function syncGameToServer(gameId, gameData) {
    const response = await fetch(`${API_BASE}/api/games/${gameId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gameData)
    });
    return response.json();
}
```

### Automatic Versioning

Every sync creates a timestamped version file:

1. Save to `versions/{timestamp}.json`
2. Copy to `current.json`
3. (Optional) Git commit for full history

The version backup is **best-effort**: if step 1 fails (e.g. an unwritable /
root-owned `versions/` dir — see the ops rule under Data Directory
Structure), the failure is logged loudly (`VERSION BACKUP FAILED`) but the
sync still succeeds — `current.json` is written and the client gets a normal
200. Only the restore point for that sync is lost. A failure writing
`current.json` itself still fails the sync (that would be real data loss),
and since the app now attaches CORS headers to unhandled 500s (exception
handler in `main.py`), the browser sees a real 500 instead of an opaque
network `TypeError` the sync layer would misread as "offline".

### Offline Support

```
User creates/edits while offline:
1. Save to localStorage immediately
2. Add to sync queue
3. UI works fully offline

When online:
4. Process sync queue
5. POST to server
6. Handle conflicts (last-write-wins)
```

---

## AI Narration

### Overview

A floating microphone button at the bottom of the game screen lets a coach narrate plays out loud ("Alice throws to Bob, deep huck to Carla for the score"). The system extracts structured `Throw` / `Turnover` / `Defense` / score events from speech and applies them to the game state — the same events a coach would otherwise tap in via the Key Play / Score Attribution dialogs.

The architecture is a **two-pass hybrid**, with the fast pass currently configured for **transcription only** (the structured-extraction fast pass is preserved behind a feature flag for future revisit):

- **Fast pass** (during recording): browser streams audio to OpenAI's Realtime API via a WebSocket. The transcript streams back live and is shown in a floating panel above the mic button — the coach sees they're being heard in real time.
- **Slow pass** (on stop): the accumulated transcript is POSTed to `/api/narration/finalize`, which calls Claude Sonnet with a structured prompt. Claude returns a list of `ADD` operations (one per event found), which the frontend applies through the same code paths the manual Key Play dialog uses (`ensurePossessionExists`, stat updates, event log, possession transitions).

### Why this split

We tried doing structured event extraction live during recording (gpt-realtime function calling on streaming audio). It worked in quiet conditions but confabulated events in noisy outdoor conditions — extracting structured output from garbled audio fragments is brittle. Decoupling transcription from event extraction gives Claude the full possession context to reason holistically, with much higher accuracy.

The fast-pass-events code path still exists, gated by `FAST_PASS_EVENTS_ENABLED = false` in `narration/narrationEngine.js`. Tools, prompts, and event appliers are all preserved; flip the flag to re-enable.

### Frontend module layout

```
narration/
├── micButton.js           # Floating FAB. Tap toggles, hold engages temp recording
├── micButton.css          # Button + transcript panel styles (also provisional event styles)
├── eventBus.js            # ~30-LOC pub/sub. Channels: eventAdded, eventAmended,
│                          # eventRetracted, transcriptUpdated, scoreChanged, etc.
├── realtimeSession.js     # OpenAI Realtime WebSocket client. PCM16 capture via
│                          # MediaStream + AudioContext + ScriptProcessorNode.
├── narrationEngine.js     # Orchestrator. Builds the system prompt, opens the
│                          # session, accumulates transcript, runs the slow pass,
│                          # applies returned ops via the same applyThrow/etc.
│                          # functions used by the manual flow.
└── transcriptDisplay.js   # Floating panel that shows the live transcript
                           # (subscribes to transcriptUpdated channel).
```

### Backend endpoints

`ultistats_server/narration.py` exposes two routes mounted under `/api/narration/`:

- **`POST /token`** — receives `{model}`, calls OpenAI's `https://api.openai.com/v1/realtime/sessions` with the server's `OPENAI_API_KEY`, returns the ephemeral `client_secret` to the browser. Lets the browser open a WebSocket without ever seeing the real API key. Auth: any logged-in user.
- **`POST /finalize`** — receives `{game_id, transcript, roster, provisional_events, game_context}`, builds a structured prompt (see below), calls Claude Sonnet via the Anthropic Messages API, parses the response, returns `{operations: [...]}`. Auth: any logged-in user. Falls back to confirming all provisionals if `ANTHROPIC_API_KEY` is unset, so the feature degrades gracefully.

### Operation schema

The slow pass returns a list of operations. Each is one of:

- `{op: "CONFIRM", provisional_id}` — leave a fast-pass event as-is (only relevant when the fast pass is enabled)
- `{op: "RETRACT", provisional_id}` — remove a fast-pass event (coach corrected themselves, mishearing, etc.)
- `{op: "ADD", event}` — emit a new event from the transcript

The ADD `event` object has shape:

```json
{
  "kind": "throw" | "turnover" | "defense" | "opponent_score" | "pull",
  "thrower": "Alice", "receiver": "Bob",
  "huck": true, "break_throw": false, "reset": false, "swing": false,
  "hammer": false, "sky": false, "layout": false, "score": true,
  // turnover-specific:  "throwaway", "drop", "good_defense", "stall"
  // defense-specific:   "defender", "interception", "callahan"
  // pull-specific:      "puller", "flick", "roller", "io", "oi", "brick", "quality"
}
```

Player names must match roster entries exactly. The slow-pass prompt explicitly tells Claude to emit bare names (not `"Alice #7"`) — this was a real bug caught by the test harness on its first run.

**Pulls are gated on a named puller.** `puller` is required, and the prompt says so with an explicit `WRONG: {"kind": "pull"}` example; `applyPull` in `narration/narrationEngine.js` drops a pullerless pull as a second line of defense. The reason is that `showPullDialog()` already fires automatically at every point that starts on defense (`game/pointManagement.js`), so the coach has normally already entered the pull by hand — a narrated pull is only worth recording when it names a puller the dialog wouldn't have captured, and a nameless one is pure duplicate. Live probing confirmed this matters: before the required-puller rule was hardened, Haiku emitted a bare `{"kind": "pull"}` for scene-setting narration like "we pulled it" and "they pull". The prompt rules are pinned in `ultistats_server/test_narration_finalize.py`.

**One pull per point, guarded from both sides.** Two independent paths can record the pull, so each checks `pointHasPull()` (`utils/helpers.js`) before writing and the first one wins: `applyPull` skips a narrated pull when the dialog already recorded one, and `createPullEvent` (`playByPlay/pullDialog.js`) skips the dialog entry when narration got there first, toasting "Pull already recorded from narration" so the coach isn't left wondering where their quality/hang selections went. A one-sided guard is not enough — the slow pass lands seconds after the coach stops talking, so either order is reachable in practice. `pointHasPull` scans all possessions and keys on `event.type === 'Pull'` rather than `instanceof`, because points rebuilt from the server come back through `deserializeEvent`; `tests/unit/pointHasPull.test.mjs` pins both.

**Dropped events say why.** When an applier declines to record an event it returns null, and the coach gets a warning toast. That toast used to read "N couldn't be matched to on-field players" for *every* cause, which was wrong in the case that reached the field: before `kind=pull` existed, a narrated pull came back as `{kind: "throw", thrower: "Inez"}` with no receiver, `applyThrow` requires both, and the coach was told to check a roster that was fine. Appliers now call `dropWith(reason, detail)` before returning null — `'unmatched-name'` (a name we couldn't match, quoted in the message), `'incomplete'` (a required field missing, e.g. "throw with no receiver"), `'duplicate-pull'`, `'unsupported'` — and `summarizeDrops()` in `narration/dropReasons.js` (pure leaf, unit-tested) turns the collected reasons into one clause. Keep the distinction between "the model named someone we don't have" and "the model named nobody": they send the coach to completely different places.

**A narrated pull dismisses the pull dialog.** `applyPull` calls `closePullDialog()` on success. Without it the coach is left staring at a form asking for an event that is already in the log, since the dialog opens itself at point start and nothing else would close it. This is what makes the narrate-the-pull flow hands-free: Start Point → dialog opens → tap mic, speak, stop → a few seconds later the event lands and the dialog closes on its own. Note the mic button is `position: fixed; z-index: 2000` on `document.body` while `.modal` is `z-index: 1000`, which is why it is reachable while the dialog is up.

Terminology: **"reset" is the canonical name** for the short backward pass (2026-07-19 design call) — in the schema, the `Throw.reset_flag` field, log lines, chips, and stats alike. Coaches saying "dump" set the same `reset` field (the prompt says so explicitly), and games stored before the rename carry `dump_flag`, which `deserializeEvent` aliases onto `reset_flag` (the public viewer, which renders raw server JSON, checks both).

The fast-pass `AMEND` operation is intentionally not emitted by the prompt; corrections are always expressed as `RETRACT` + `ADD` pairs for auditability. The frontend keeps a defensive `AMEND` handler (treats it as retract) in case Claude ignores instructions.

### Environment variables

- `OPENAI_API_KEY` — required for the narration feature to work at all (token endpoint)
- `ANTHROPIC_API_KEY` — required for the slow pass to actually emit events (without it, the endpoint returns `{operations: []}`)
- `NARRATION_SLOW_MODEL` — optional override for the Claude model used by the slow pass; defaults to `claude-sonnet-4-5-20250929`

### Cost characteristics

- Fast pass (Realtime API, transcription-intent session): billed by audio
  duration at transcription-model rates — `gpt-4o-mini-transcribe` ~$0.003/min,
  `gpt-4o-transcribe` ~$0.006/min (OpenAI pricing page, verified 2026-07-19; an
  earlier ~$0.06/min figure here was ~20x too high). Worth confirming once
  against the OpenAI usage dashboard.
- Slow pass (Claude Sonnet, ~1-3K tokens per possession): $0.01-0.03 per call —
  now the *majority* of narration spend
- A typical full game (~25 possessions, sporadic narration): roughly $0.35-1 total

See `docs/narration-stt-research-2026-07.md` for the July 2026 STT landscape
research (pricing, latency, on-device options) behind these numbers.

### Test harness

Audio-driven regression suite in `ultistats_server/tests/narration/`. Each scenario is a directory of `(audio.flac, transcript.txt, roster.json, expected.json)` files. The runner:

1. Streams the audio to OpenAI Realtime as a transcription-only session
2. Captures the accumulated transcript
3. Calls `/api/narration/finalize` via `fastapi.testclient.TestClient` (no separate server needed)
4. Compares the resulting operations to expected, computes WER + event precision/recall/F1

`tools/generate_synthetic_audio.py` produces FLAC audio from a text script via OpenAI's TTS API for cheap deterministic scenarios (~$0.002 each). Hand-recorded scenarios go in the same shape and let us measure outdoor / multi-speaker robustness.

Test deps (`websockets`, `soundfile`) are listed in `requirements.txt` under a "Test-only deps" comment.

### Lineup Narration (Lines tab)

A second, independent narration layer lets a coach *speak the next line* instead of tapping checkboxes. It reuses the transcription plumbing but nothing of the in-point event pipeline — separate state machine, separate endpoint — so the two features can evolve without touching each other. Only one can record at a time (they share the realtime-session singleton; each refuses to start while the other is active).

- **Entry point**: the one floating mic FAB, not a button of its own. `narration/micButton.js` holds a target per narration layer and picks between them at press time. The predicate is the **game clock, not the tab** (`isLineupContext()`): **between points → lineup on every tab**, so a solo coach never has to detour to the Line tab to call the next line; **during a point → event narration, except on the Line tab**, where a coach is by definition planning the next line rather than watching the disc. A **non-idle layer always wins over the context**, so a lineup recording stays stoppable through the very point start that would otherwise flip the context under it, and neither layer can start a second session against the shared realtime-session singleton. The same tap-toggle and hold-to-record gestures drive both. Phase colours are shared (micButton.css): lineup's `processing` reuses `.mic-finalizing`, so there is no fifth state. The FAB polls its target every 500ms and `applyTabState()` / `startNextPoint()` refresh it directly, since background tabs throttle the poll hard — but that only keeps the *tooltip* fresh, as both targets render identically while idle and every press reads the target live. The Lines-tab mic button that shipped in build 1105 is gone; `lineupNarration.js` now owns only the inline status strip under the Select Line toolbar.
- **Line-report toast lifetime**: the confirmation toast ("7/7 selected. Added: Kris. Off: Wes") is a whole line plus a miscount flag, so it gets reading time rather than glance time — **3× the 4s default on the Line tab** (where the checkboxes beside it already tell the story) and **6× off it** (where the toast is the only feedback). It's dismissed early the moment the coach visibly moves on — point start (via `startNextPoint` → `lineupNarration.onPointStarted()`), a fresh narration superseding it, or leaving the game screen (`breakside:screen-shown`) — plus the usual manual close/swipe. `lineupNarration` holds the live toast and clears its handle through the toast's own `onDismiss`, so a manual close never leaves a detached node behind.
- **Capture**: `narration/lineupNarration.js` opens the same transcription-only Realtime session, but vocabulary-biases the recognizer toward the **full active roster** rather than the on-field seven — calling a line is precisely about naming bench players.
- **Extraction**: on stop, the transcript is POSTed to **`POST /api/narration/lineup`** (`ultistats_server/narration_lineup.py`) along with the full roster (names, nicknames, jersey numbers), the **expected player count**, the **previous point's lineup**, and the current on-screen selection. Claude returns `{players, unmatched, note}` — the final set of roster names.
- **Tap-equivalent contract** (see `_build_lineup_prompt` / `_derive_players`): the model NEVER outputs a lineup. It returns only the voiced changes — `{"in": [names], "out": [{name, said}]}` — the verbal equivalent of tapping names on the list, and the SERVER derives `players = (current_selection − outs) ∪ ins` by set arithmetic. Picking, completing, or trimming a line is therefore structurally impossible (the Wholesale-then-"3 go in" fill-out bug class is dead: there is no slot for the model to fill). Bare names add; off/sits/replaced-by language removes; "same line"/"run it back" expands to the previous lineup as ins; later statements override earlier ones and retracted changes vanish; asides are ignored; the expected count is toast context only. An empty selection stays empty — there is NO fallback to the previous lineup (Wholesale means Wholesale). Reciting "the line is X, Y, Z" over a non-empty selection unions (9/7 toast) rather than replacing — clear first for a fresh line.
- **Voiced clear-all**: "wholesale" (coaches verb the button name), "everybody comes off", "all players come off", "clear the line", "start fresh" set `clear: true` with the quoted words in `clear_said`; the server honors it only when the quote occurs in the transcript AND matches a collective-clear lexicon (`_CLEAR_LEXICON_RE` — includes the "whole sale" STT split). A verified clear empties the selection before ins apply ("Let's get a wholesale, then put in Kris and Charlie" → exactly those two) and cancels ins spoken before it; the client applies legitimately-empty results only when `voiced_clear`/`voiced_out` justify them, so "nothing heard" still can't wipe.
- **Out-evidence guards**: each `out` entry must quote the coach's removal words (`said`), and the server honors it only if the quote (a) actually occurs in the transcript and (b) references that player by name token, nickname, or jersey number (digits or spoken words, "number five"). This deterministically kills the two small-model failure modes observed in eval: fabricated removal quotes, and "absent from a recited list" treated as removal. Dropped outs are logged. Roster names that embed jersey numbers ("Jamal 23") must be emitted byte-for-byte; the client matcher's normalized tier is the safety net. The reply leads with a `changes` worksheet (`[{out, in}]`, corrected substitutions only) that the model fills before materializing `players` — added for the Haiku slow-pass flip (`NARRATION_SLOW_MODEL=claude-haiku-4-5`, which lineup inherits via its model fallback); it eliminated Haiku's pad-to-expected-count and note/list-contradiction failures, bringing it to parity with Sonnet on the lineup eval matrix at ~half the latency. The `changes` field is advisory — the endpoint returns only `players`/`unmatched`/`note`.
- **Apply**: returned names are re-validated against the roster (`narration/lineupResolve.js`, unit-tested under `tests/unit/`) and applied through selectLine's `applyLineSelection('main', …)` — the same path as the Wholesale/Auto buttons, so pendingNextLine writes, checkbox sync, subtitle, and cloud sync all behave identically. Matching is digits/decoration-tolerant: a unique **normalized** tier (strip digits, `#`, quoted-nickname spans, punctuation) absorbs the model returning cleaned names against number-embedded roster names (the number-embedded-roster bug) — ambiguous normalizations ("Jamal 23" vs "Jamal 40") deliberately don't match. Error or empty results **never** clear the existing selection. Toasts are sideline-short and delta-based — `"5/7 selected. Added: Priya"`, `"7/7 selected. Added: Kris. Off: Wes"`, `"No roster match: \"Zeb\" — selection unchanged"` — with the model's free-text `note` demoted to the console.
- **Permissions**: gated on `canEditSelectLinePanel()` (Line Coach rule), checked both at record start and again at apply time.
- **No graceful no-LLM fallback**: unlike `/finalize`, `/lineup` 503s without `ANTHROPIC_API_KEY` — there is nothing sensible to return without a model. The model defaults to the finalize pass's (`NARRATION_LINEUP_MODEL` overrides, else `NARRATION_SLOW_MODEL`).
- **Debug seam**: `window.lineupNarration._applyResult({...})` drives the apply path from the console/Playwright without mic hardware or an API key.

---

## Users and Authentication

### Overview

Breakside uses **Supabase Auth** for user authentication, providing email/password login with JWT tokens. User accounts enable multi-coach collaboration during games, team-based access control, and spectator viewing.

### Authentication Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Landing   │────▶│  Supabase   │────▶│    PWA      │
│    Page     │     │    Auth     │     │   (JWT)     │
└─────────────┘     └─────────────┘     └─────────────┘
                          │
                          ▼
                    ┌─────────────┐
                    │  FastAPI    │
                    │  (verify)   │
                    └─────────────┘
```

1. User visits landing page (`breakside.pro`)
2. Signs in via Supabase Auth (email/password)
3. Supabase returns JWT access token
4. PWA includes `Authorization: Bearer {token}` on all API calls
5. FastAPI validates JWT signature using Supabase JWT secret

### User Roles

#### Persistent Roles (Team-Level)

| Role | Abilities |
|------|-----------|
| **Admin** | Full system access. Can modify any team, game, player. Can grant/revoke any role. |
| **Coach** | Full access to assigned teams. Can create/edit games, modify rosters, add events. |
| **Viewer** | Read-only access to assigned teams. Can watch games live, view statistics. |

#### Dynamic Roles (Per-Game)

| Role | Abilities |
|------|-----------|
| **Active Coach** | Has write control for play-by-play events. Can modify current lineup between points. Only one per game. |
| **Line Coach** | Can prepare the next lineup during a point. Only one per game. Any Coach can claim this status. |

### Role Assignment

- **Admin**: Manually granted by existing Admin (stored in user profile)
- **Coach**: Granted via single-use invite code (7-day expiry)
- **Viewer**: Granted via multi-use invite link (permanent, revocable)
- **Active Coach**: Claimed by any Coach during a game; requires handoff from current holder
- **Line Coach**: Claimed by any Coach during a game; requires handoff from current holder

### Handoff Protocol

When a Coach requests Active Coach or Line Coach status:

```
1. Requester taps role button in sub-header
2. If role is vacant: Immediate claim, requester gets role
3. If role is occupied: Handoff request created
   - Requester sees "Handoff request sent..." toast (duration = timeout)
   - Holder sees toast with Accept (✓) and Deny (✗) buttons
4. Holder response options:
   - Tap Accept: Immediate transfer
   - Tap Deny: Request rejected, requester notified
   - Swipe toast away: Counts as Accept
   - Do nothing: Auto-accepts after timeout (configurable, default 10s)
5. Resolution:
   - On accept: Role transfers, both parties notified
   - On deny: Request cancelled, requester sees error toast
```

The timeout is configurable via `HANDOFF_EXPIRY_SECONDS` in `controller_storage.py`. The server provides `expiresInSeconds` in API responses so clients can show accurate countdowns despite polling delays.

This protocol also handles connectivity loss—any Coach can take over after the timeout if the current holder loses connection.

### Team Membership Data Model

```json
{
  "team_memberships": [
    {
      "id": "mem_TeamA-1234_user-abc",
      "teamId": "TeamA-1234",
      "userId": "user-abc",
      "role": "coach",
      "invitedBy": "user-xyz",
      "joinedAt": "2025-01-15T10:30:00Z"
    }
  ],
  "user_memberships": {
    "user-abc": [/* membership objects */]
  }
}
```

### Game Controller State

Per-game controller state (in-memory, managed by `controller_storage.py`):

```json
{
  "activeCoach": {
    "userId": "user-abc",
    "displayName": "Alice",
    "claimedAt": "2025-01-15T10:30:00Z",
    "lastPing": "2025-01-15T10:35:00Z"
  },
  "lineCoach": {
    "userId": "user-xyz",
    "displayName": "Bob",
    "claimedAt": "2025-01-15T10:32:00Z",
    "lastPing": "2025-01-15T10:35:00Z"
  },
  "pendingHandoff": {
    "role": "activeCoach",
    "requesterId": "user-xyz",
    "requesterName": "Bob",
    "currentHolderId": "user-abc",
    "requestedAt": "2025-01-15T10:35:30Z",
    "expiresAt": "2025-01-15T10:35:40Z"
  }
}
```

**Connected Coaches Tracking:**

The server separately tracks all coaches actively polling each game, regardless of whether they hold a role. This is stored in-memory via `record_coach_ping()` / `get_connected_coaches()` in `controller_storage.py`.

- Every `POST /ping` records the coach's presence with `{displayName, lastPing}`
- `get_connected_coaches(game_id)` returns a list of `[{userId, displayName}]` for coaches who pinged within `STALE_TIMEOUT_SECONDS` (15s)
- The ping response includes `connectedCoaches` so clients know how many coaches are present
- The GET `/controller` endpoint does NOT return `connectedCoaches` (only POST `/ping` does)
- Note: Viewers do not call the ping endpoint, so they do not appear in connected coaches

**Client-Side Role Button Visibility:**

Role claim buttons (Play-by-Play / Next Line) are hidden when only one coach is polling a game. Once multiple coaches are detected, a **latch** keeps the buttons visible for the session (even if the second coach disconnects). The latch resets when exiting the game screen (`resetMultiCoachDetected()`). This logic lives in `updatePanelsForRole()` in `ui/panelSystem.js`.

**Timeouts:**
- `STALE_CLAIM_SECONDS` (30s): Role auto-releases if holder stops pinging
- `STALE_TIMEOUT_SECONDS` (15s): Coach removed from connected list if no ping
- `HANDOFF_EXPIRY_SECONDS` (10s): Pending handoff auto-accepts if holder doesn't respond

**API Response Enrichment:**
- `expiresInSeconds`: Server-calculated time remaining for pending handoff
- `handoffTimeoutSeconds`: Current timeout setting for client reference
- `connectedCoaches`: List of all coaches actively polling (from ping endpoint only)

### Invite Codes

Invites are 5-character codes (alphabet excludes 0/O/1/I/L; case-insensitive).
Coach invites are single-use with 7-day expiry; viewer invites are multi-use
with 30-day expiry (both revocable). The share URL minted by the API is
`https://www.breakside.pro/join/{code}`.

**How `/join/{code}` resolves** — the canonical join page is
`/landing/join.html?code={code}`; everything else funnels there:

| Origin | Mechanism |
|--------|-----------|
| www/staging (CloudFront→S3) | No `/join/*` route exists, so the S3 404 fallback serves `index.html` — an inline `<head>` shim there redirects `/join/<code>` to the canonical page before the app boots |
| api.breakside.pro (FastAPI) | `routers/static_files.py` 302-redirects to the canonical page |

Do NOT serve join.html directly at `/join/{code}`: the page's relative asset
URLs (join.js, supabaseInit.js, CSS) would resolve under `/join/` and the
`{code}` route would answer them with HTML (this was broken until 2026-07;
`test_invite_redeem.py::TestJoinShortLink` pins the redirect). Note also that
the static origins have no `/api/*` — `landing/join.js` maps breakside
hostnames to `https://api.breakside.pro` itself (mirrors `getApiBaseUrl()`);
same-origin API calls only work when the page is served by the API host.

### Multi-User Polling Strategy

**Controller polling** (via `POST /ping`):

| User Type | Poll Interval | Payload |
|-----------|---------------|---------|
| Coach (holding role) | 2 seconds | Controller state + connected coaches list |
| Coach (no role) | 5 seconds | Controller state + connected coaches list |

**Game state refresh** (via `GET /games/{id}`):

| User Type | Poll Interval | Payload |
|-----------|---------------|---------|
| Line Coach / Viewer | 3 seconds | Full game state |

Coaches poll the ping endpoint to maintain role claims and detect other coaches. The game state refresh runs separately for non-Active-Coach users to sync score/event changes. Handoff requests are detected via controller polling. Future optimization: switch to WebSockets if latency becomes problematic.

### URL Structure

| Path | Purpose |
|------|---------|
| `/` | Landing page (intro, login, download instructions) |
| `/app/` | PWA entry point |
| `/view/{game-hash}` | Game share link → standalone viewer in share mode (no auth) |
| `/join/{code}` | Invite short link → redirects to `/landing/join.html?code={code}` |

### Share Links (public game viewing)

A coach mints a share link from the **Share Game** dialog (in-game hamburger
menu, or the Share button on the game summary). The API returns
`https://www.breakside.pro/view/{hash}` (12-char hex hash; links expire —
1 day to 6 months, revocable from the same dialog). The destination is the
**standalone viewer in share mode**, which every origin serves from its own
copy — so the reader never leaves the host they clicked.

**How `/view/{hash}` resolves** (same funnel pattern as `/join/{code}`, and
like it, a *same-origin* bounce):

| Origin | Mechanism |
|--------|-----------|
| www/staging (CloudFront→S3) | No `/view/*` route exists; the S3 404 fallback serves the PWA `index.html`, whose inline `<head>` shim redirects to **`/viewer/?share={hash}` on the same origin** — the deploy syncs the viewer there (the "Sync viewer to S3" step in `.github/workflows/main.yml`; `deploy-staging.sh` does the same). The viewer's own `getApiBaseUrl()` maps www/staging → `api.breakside.pro` for its data calls |
| api.breakside.pro (FastAPI) | `routers/static_files.py` 302-redirects to `/static/viewer/?share={hash}` (the viewer's path under the API host) |
| localhost (dev) | No `/viewer/` copy is served locally, so the shim hands off to the dev backend's own `/view` route (honoring an `?api=` override). `scripts/dev-server.sh` serves `index.html` for `/join/*` and `/view/*` so both shims are testable locally — production's S3 `ErrorDocument` equivalent |

Do NOT serve the viewer's `index.html` directly at `/view/{hash}` — its
relative asset URLs (viewer.js/viewer.css) would resolve under `/view/` and
break, exactly like the join-page trap (`test_shares.py::TestViewShortLink`
pins the redirect). Those asset paths stay **relative** on purpose (unlike
`landing/join.html`, which 32a51ed made absolute): the same files are served
at two different prefixes — `/static/viewer/` on the API host and `/viewer/`
on S3 — so absolute paths would break one of them.

⚠️ **Viewer-only changes do not reach S3.** The production workflow's
`paths-ignore` includes `ultistats_server/**`, so a commit touching only
`ultistats_server/static/viewer/` never triggers the deploy that syncs
`/viewer/`. The www/staging copies then silently lag the API-hosted one.
Touch a root-level file in the same commit, or run `deploy-staging.sh` /
re-run the workflow manually.

**Share mode in the viewer** (`static/viewer/viewer.js`): all data flows
through the public endpoints only — `GET /api/share/{hash}` (full game +
change stamp) and `GET /api/share/{hash}/poll` (stamp only; the full game is
refetched when the stamp moves; stamp = `current.json` mtime_ns). Browse
tabs/sync chrome are hidden (`body.share-mode`) because the listing
endpoints require auth and come back empty for anonymous visitors. Polling
pauses while the tab is hidden. A share dying mid-view (410) keeps the last
state with an "expired" banner; a dead link on first load gets an error view.
The LIVE badge requires a missing `gameEndTimestamp` AND recent activity
(~30 min) — an abandoned game is not "live".

**Public listing is a separate opt-in.** A share link alone never lists the
game anywhere; `POST /api/games/{id}/share?listed=true` (the dialog's "List
publicly" checkbox) additionally surfaces it in `GET /api/public/games`,
which the landing page's "Happening on Breakside" section
(`landing/publicGames.js`) renders. The section hides itself when no listed
games exist. Only currently-valid shares count; revoking or expiry delists
immediately.

### Client-Side Auth Module

```
auth/
├── config.js         # Supabase URL and anon key
├── auth.js           # Supabase client, session management
└── loginScreen.js    # Login/signup UI component

teams/
└── teamSettings.js   # Team settings, member list, invite management UI
```

Exported via `window.breakside.auth`:
- `initializeAuth()` - Initialize Supabase client
- `isAuthenticated()` - Check if user is logged in
- `getCurrentUser()` - Get current user object
- `getAuthHeaders()` - Get `Authorization: Bearer {token}` header
- `signIn(email, password)` - Sign in
- `signOut()` - Sign out and redirect to landing

---

## Deployment

### Infrastructure

| Component | Details |
|-----------|---------|
| **CloudFront (prod)** | Distribution `E6M9KCXIU9CKD` |
| **CloudFront (staging)** | Distribution `E12N2STN9MM8FA` |
| **S3 Bucket (prod)** | `breakside.pro` (us-east-1) |
| **S3 Bucket (staging)** | `staging.breakside.pro` (us-east-1) |
| **EC2 Instance** | Amazon Linux 2, IP: 3.212.138.180 |
| **SSL (CloudFront)** | ACM certificate |
| **SSL (EC2)** | Let's Encrypt via certbot |

### Configuration Files

| File | Purpose |
|------|---------|
| `/etc/breakside/env` | Environment variables |
| `/etc/systemd/system/breakside.service` | systemd unit |
| `/etc/nginx/conf.d/breakside.conf` | nginx config |
| `/etc/cron.d/certbot` | SSL renewal cron |

### DNS (Pair.com)

| Domain | Type | Value |
|--------|------|-------|
| `breakside.pro` | A | 3.212.138.180 |
| `www.breakside.pro` | CNAME | d17eottm1x91n5.cloudfront.net |
| `staging.breakside.pro` | CNAME | *(CloudFront distribution domain for E12N2STN9MM8FA)* |
| `api.breakside.pro` | A | 3.212.138.180 |

### CI/CD

**Production** — GitHub Actions workflow (`.github/workflows/main.yml`):
1. Triggers on push to `main` branch
2. Stamps the deploy-time build number into the checkout (`increment-version.py stamp` — see *Version stamping* below); nothing is committed or pushed back
3. Syncs PWA files to S3 (`breakside.pro`) using the shared exclude list `scripts/deploy-excludes.txt`
4. Uploads the stamped `version.json` and `service-worker.js` with no-cache headers
5. Syncs viewer to S3
6. Invalidates CloudFront cache (`E6M9KCXIU9CKD`)

**Version stamping** — Build numbers are **never committed**. The committed `version.json` carries the placeholder `build: "dev"` (and `service-worker.js` the cacheName `'build-dev'`); the committed semver `version` string is bumped manually via `python3 increment-version.py major|minor|patch`. At deploy time, both the production workflow and `deploy-staging.sh` run `increment-version.py stamp`, which:
- computes the build number as `git rev-list --count HEAD` (deterministic, monotonic on `main`, no committed state);
- writes it (plus `deployStamp`, and `deployLabel` on staging) into the *deployed* `version.json`;
- rewrites the service-worker `cacheName` to `build-<n>` (staging: `build-<n>-stg-<stamp>`).

The client (`main.js` `checkForAppUpdate`) compares builds and deploy stamps by **inequality**, not ordering, so any newly stamped deploy triggers the update prompt, and the new SW cacheName purges old CacheStorage on activate. Because nothing is committed at deploy time there are no CI bot commits, no pre-commit hook bump, and no cherry-pick caveat — a cherry-picked commit on `main` gets its build number stamped at deploy like any other push.

**S3 exclude list** — `scripts/deploy-excludes.txt` is the single source of truth for what the PWA syncs exclude, shared by production CI and the staging script (backend, data, scripts, tests, docs, dot-directories, gitignored local secrets). Note `aws s3 sync --delete` never deletes bucket objects matching an exclude, so files published before a pattern was added must be removed once with `aws s3 rm`.

**Staging** — Manual deploy via `./scripts/deploy-staging.sh "<short version description>"`:

Always pass a short version description (e.g. `"test audio narration v2"`) so testers can visually verify which build they're running. The deploy:

1. Stamps build number + `deployStamp` + `deployLabel` into temp copies of `version.json`/`service-worker.js` (working tree untouched)
2. Syncs the working directory to `staging.breakside.pro` (same shared exclude list as prod)
3. Uploads the stamped `version.json` and service worker with no-cache headers
4. Syncs viewer to S3
5. Invalidates CloudFront cache (`E12N2STN9MM8FA`)

Staging has a purple header (vs production orange) via `body.staging` CSS class. The deploy stamp lets the PWA detect redeploys without a commit — tap Online/About to check for updates. The label appears in the version toast as `[label]`, making it the easiest way to confirm "am I actually on the build I just deployed?"

**Claude Desktop PATH issue** — Claude Code Desktop strips the shell PATH to a minimal `/usr/bin:/bin:/usr/sbin:/sbin`, so tools like `aws` at `/usr/local/bin` aren't found. This is a [known bug](https://github.com/anthropics/claude-code/issues/3991) — the `env.PATH` key in `settings.json` and shell dotfiles (`.zshenv`, `.zprofile`, `.zshrc`) are all ignored for Bash tool commands. The deploy script works around this by sourcing `~/.zshenv` at the top, which sets the full PATH including `/usr/local/bin` and `/opt/homebrew/bin`. Any new scripts that need tools outside the minimal PATH should do the same: `[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"`.

---

## Quick Reference Commands

### Test account (browser preview)

Claude Code uses a dedicated Supabase account when verifying changes in
the in-IDE browser preview. Email + password live in `test-credentials.local`
(gitignored, never committed). To drive preview against the real backend:

```js
localStorage.setItem('ultistats_api_url', 'https://api.breakside.pro');
location.reload();
// then sign in with the credentials from test-credentials.local
```

To create or rotate the account: sign up at `test@luebke.us`, confirm
the verification email, and update `test-credentials.local`.

### Interactive "user logs in, then Claude proceeds" testing

Some verification needs a *specific* logged-in account (the user's own
teams/games), not the generic test account — e.g. "create a game for team X
and exercise the new flow." Supabase login (especially Google OAuth) can't be
driven headlessly, so use this handoff:

1. **Claude** starts the preview server for the worktree and points it at the
   real backend so the user's teams load:
   ```js
   localStorage.setItem('ultistats_api_url', 'https://api.breakside.pro');
   location.href = '/index.html';   // redirects to /landing/ for login
   ```
2. **Claude** tells the user the preview is ready and asks them to sign in in
   the preview browser window, then say "proceed" (or similar).
3. **User** logs in interactively and gives the go-ahead. *Claude must wait —
   do not poll or auto-continue; the user controls when login is done.*
4. **Claude** resumes: confirm the authenticated state
   (`window.breakside.auth.isAuthenticated()` is `true` and the Select Team
   screen is showing), then drive the app with `preview_*` tools (select the
   named team, start a game, etc.).

Notes:
- The preview browser is the same window the user sees in the IDE, so a login
  they perform there is visible to Claude's subsequent `preview_eval`/snapshot
  calls — the session persists.
- Don't reload or renavigate after the user logs in unless necessary; a reload
  re-runs the auth check (it won't log them out, but avoid surprising them).
- This is for *interactive* verification only. Never ask the user for their
  password or try to type their credentials — they sign in themselves.

### Driving the preview against a local backend (no prod CORS change)

The preview server is served from `http://localhost:<port>`, but the **prod
API's CORS allowlist only contains the real origins** (`www`/`staging.breakside.pro`)
— a localhost preview origin is blocked, so its data calls (list teams, load
games, sync) silently fail and **no teams appear** even though Supabase login
succeeded. Do **not** "fix" this by adding the localhost origin to prod
`ULTISTATS_ALLOWED_ORIGINS` (that's the temp hack TODO.md tracks for removal).
Instead, point the preview at an **isolated local backend**, which runs
auth-disabled and returns `Access-Control-Allow-Origin: *`:

1. **Start an isolated backend** for the worktree (see § Local development
   backends). `--fresh` starts empty; omit it to seed from the main worktree's
   `data/`:
   ```bash
   ./scripts/dev-backend.sh --port 8007 --label <feature> --fresh
   ```
2. **Point the preview frontend at it** — load the app once with the `?api=`
   override (saved to that origin's localStorage; `?api=reset` clears it):
   ```js
   location.href = '/index.html?api=http://localhost:8007';
   ```
   Supabase login still works (auth is independent of the data API), so an
   already-signed-in preview session stays signed in; only data calls re-route.
3. **Create test data and drive the flow.** Because the isolated backend has
   its own data store, the user's *real* cloud teams won't be listed (its
   membership store doesn't link the logged-in user) — so create a throwaway
   team + game in the UI and exercise the feature against that. This is the
   right tool when **Claude needs to drive the app end-to-end itself**
   (create team → start game → …), as opposed to the interactive handoff above
   where the user explores their own real data on **staging** (a real,
   CORS-allowed origin).

Cleanup when done: stop the preview server(s) and `kill` the `dev-backend.sh`
uvicorn process (or just close the terminal running it); the `.dev-data/<label>/`
copy is gitignored and disposable.

### EC2 / API

```bash
# SSH
ssh -i ~/.ssh/your-key.pem ec2-user@3.212.138.180

# Service management
sudo systemctl status breakside
sudo systemctl restart breakside
sudo journalctl -u breakside -f

# Deploy API updates
cd /opt/breakside && sudo git pull && sudo systemctl restart breakside

# Rebuild index
curl -X POST https://api.breakside.pro/api/index/rebuild
```

### S3 / CloudFront

```bash
# Deploy PWA
aws s3 sync . s3://breakside.pro/ \
  --exclude ".git/*" \
  --exclude "ultistats_server/*" \
  --exclude "data/*" \
  --exclude "scripts/*" \
  --exclude "*.py" \
  --exclude "*.md" \
  --exclude ".DS_Store"

# Deploy viewer
aws s3 sync ultistats_server/static/viewer/ s3://breakside.pro/viewer/

# Invalidate cache
aws cloudfront create-invalidation --distribution-id E6M9KCXIU9CKD --paths "/*"
```

---

## Power Management

Phones have to survive a full tournament day, so the app treats "what is
running right now" as an explicit, single-owner decision rather than a
property that emerges from a dozen independent `setInterval` calls.

**Three modules, one rule.**

| Module | Role |
|---|---|
| `utils/powerPolicy.js` | Pure rules. No DOM, no timers, no imports. Answers "which loops should run" and "should the wake lock be held". Unit-tested in `tests/unit/powerPolicy.test.mjs`. |
| `utils/powerManager.js` | The **only** `visibilitychange` listener that decides what may run. Feeds context into the policy and broadcasts the plan. |
| `utils/wakeLockManager.js` | Owns the screen wake lock sentinel. |
| `utils/powerLog.js` | Counts what actually happened, for field measurement. |

**The plan is broadcast, not imported.** `powerManager` dispatches a
`breakside:power-plan` CustomEvent carrying the whole plan; each loop's owning
module listens for its own flag:

```js
document.addEventListener('breakside:power-plan', (e) => {
    if (e.detail.plan.autoSync) startAutoSync(); else stopAutoSync();
});
```

An event rather than a registry because listeners live at every layer —
`store/sync.js` (data) through `ui/` — and a data-layer module cannot import
upward into `utils/` (see § Module Loading). The event carries the entire plan,
not just the delta, so a listener that missed an edge still converges.

Two other modules do listen to `visibilitychange` directly, and both are
deliberate rather than leaks: `game/controllerState.js` runs its sleep/wake
role-recovery there (it relies on `powerManager` being registered first, via
`main.js` import order, so polling is back up before recovery runs), and
`utils/theme.js` re-resolves an `auto` theme that the OS may have flipped while
we were backgrounded. Neither starts or stops a loop — that decision stays with
the plan. Anything that *does* control a loop belongs in `loopPlan()`.

**Adding a new recurring loop:** add its id to `LOOPS` in `powerPolicy.js`, give
it a rule in `loopPlan()`, and have its owner listen for the flag. Do not add a
bare `setInterval` at module scope — three of those existed before this system
and each ran for the entire lifetime of the tab, including on screens where the
thing they updated didn't exist.

### The shared base tick

The plan says *whether* a loop may run; `breakside:power-tick` says *when*. The
four out-of-game polls (`TICK_DRIVEN_LOOPS` in `powerPolicy.js`) don't own
intervals at all — `powerManager` runs one interval and dispatches a tick
carrying the ids that are due:

```js
document.addEventListener('breakside:power-tick', (e) => {
    if (!running || !e.detail.due.includes('autoSync')) return;
    autoSyncOnce();
});
```

This is a battery change, not a correctness one, and the reason is the radio
rather than the CPU. After any request a phone's radio sits in a high-power
state for several seconds before dropping to idle, so the bill tracks *how many
separate times you woke it*, not how many bytes you sent — three requests in one
moment share a tail, three spread over ten seconds pay three. Left to
themselves the four loops installed their intervals whenever their modules
happened to start (sign-in, opening the roster screen, leaving a game), so their
phases scattered.

Two rules in `tickSchedule()` are deliberate and easy to get backwards:

- **The base is the shortest period, not the GCD.** A GCD would be exact, but a
  coach who sets the Cloud refresh interval to 7s would get gcd(7000, 30000) =
  1000 — a 1-second tick, ten times today's timer wakeups, to serve loops that
  wanted 7 and 30 seconds. It self-corrects at the far end too: at a 120s
  refresh the base falls back to the 30s active-game poll, so that notification
  isn't dragged out to two minutes.
- **Multiples round up.** A period that isn't a clean multiple of the base runs
  slightly slower than asked, never faster; the other way would quietly poll the
  API harder than the user's own setting allows.

Due-ness is "at least N ticks since this loop last ran", not `tickIndex % N`.
Both keep same-period loops together, but the modulo form silently *skips* a
loop whenever its multiple lands on a tick the browser threw away — and a
backgrounded phone throttles plenty.

Ticks count from the device's own start epoch, deliberately **not** the wall
clock: aligning every client in the world to :00 and :10 would hand the server a
thundering herd.

The in-game loops are deliberately not on the tick. The 1s display timer sends
nothing, and after the change gate below the only in-game network loop left is
the 2s controller ping — there is nothing for it to align with.

### In-game change gating

The in-game refresh (`game/gameScreenSync.js`) used to `GET /api/games/{id}` —
the whole game, every point and event — every 3 seconds regardless of whether
anything had changed. It now pulls only when a change stamp says the server's
copy moved. `utils/changeStamp.js` holds the comparison; the stamp is
`current.json`'s mtime, the same token the public share poll has always used.

Two sources, and the cheap one is the point:

| Client | Stamp from | Cost while idle |
|---|---|---|
| Coach | `gameStamp` on the 2s controller ping | **nothing** — the request was already being sent |
| Viewer (never pings) | `GET /api/games/{id}/poll` | ~30 bytes vs ~6 KB |

**Unknown means pull.** A null stamp — old server, failed poll, ping not landed
yet — has to mean refetch. That is the only direction in which this can lose
data, and it would fail silently rather than loudly, which is why the rule lives
in one pure module with its own tests.

**The stamp is claimed before the fetch, never after.** A write landing in
between costs one extra refetch next tick; recording the later stamp would mark
a change as seen that was never pulled. For the same reason a refresh that
didn't reach the server gives the stamp back — otherwise one transient failure
strands the client on stale state until some other coach happens to write.

Latency went *down*, not up: the ping fires `breakside:game-stamp-changed` when
its stamp moves and the refresh runs on that event, so an Active Coach sees a
Line Coach's line edit within a ping (≤2s) rather than within a poll (≤3s).
That matters because the `pendingNextLine` merge assumes near-live refresh
(TODO.md § Multi-Coach Line Selection). Both halves — idle silence *and* fast
propagation — are pinned by `tests/scenarios/09-in-game-change-gate.spec.ts`,
together, because either one alone is trivially satisfiable by breaking the
other.

**Resume restores only what was suspended.** Loops that something else stops
deliberately — auto-sync on sign-out, roster polling on navigation — track a
`suspendedByPower` flag, because a plain "plan says true → start" resurrects
them. Loops whose start functions carry their own guards (auth, online, screen
visible) don't need it.

**`stop` is not always the opposite of `start`.** `stopControllerPolling()` also
clears the polling game id and resets every role flag: correct when leaving a
game, destructive for a ten-second app switch. It has a separate
`suspendControllerPolling()` / `resumeControllerPolling()` pair for the power
path. Check for this asymmetry before wiring a loop up.

### Screen wake lock

Held during a game so the display doesn't sleep. It *spends* power; the point is
that it lets a coach dim the screen to near-minimum for a three-game day without
losing the session, and brightness dominates every other term in the budget.
On by default (`power.keepScreenAwake` in Advanced Settings → Battery), with a
☀ indicator in the game header that toggles it.

**The sharp edge:** the browser silently releases a wake lock whenever the page
becomes hidden, and never restores it. An acquire-on-entry implementation
therefore works exactly once and dies at the coach's first app switch. This is
why the wake lock re-evaluates on every power plan instead of tracking whether
it "already has" a lock, and why it lives next to the visibility owner.
Support: Chrome/Edge and Safari 16.4+; a silent no-op elsewhere.

### Measuring

`navigator.getBattery()` does not exist on iOS — the Battery Status API was
never shipped in WebKit and was removed from Firefox — so battery deltas alone
would measure only the Android half of the field. `utils/powerLog.js` therefore
leads with an **activity proxy** that works everywhere: timer wakeups per loop,
API requests per subsystem, and seconds spent visible / in a game / holding a
wake lock / with the mic open. Real battery levels are sampled where available
(session start, each point boundary, game exit) as a cross-check. Read it from
Online/About → "Battery report…", which has a copy button for field reports; it
states explicitly when readings aren't available, so an iPhone report isn't
misread as a bug.

Request classes are chosen so the numbers are readable rather than merely
correct. The role keepalive lives at `/api/games/{id}/ping` but counts as
`controller`, not `games` — classifying it by URL prefix buried the in-game full
game poll inside a bucket three times its size, which is the one number the log
existed to expose. Change-stamp polls get their own `gamePoll` class for the
same reason: ~30 bytes against ~6 KB shouldn't read as "we still poll
constantly". In a game with nothing being recorded, `requests.games` should now
sit near zero while `requests.controller` continues at the ping cadence; if it
doesn't, the change gate isn't working.

### The solo-coach ping backoff

Everything above is about loops the client owns. The controller ping is the
exception: **the server names its cadence**, and the client obeys.

After the in-game change gate landed, the ping was the only in-game network loop
left — and it also became the change channel, since the game's change stamp
rides on the ping response. That makes cadence and change-detection latency the
same number, which is the argument *against* slowing it down. But it only bites
when there is a second coach:

> A coach alone in a game pings 30×/minute to keep a role nobody is contesting
> and to detect changes nobody is making.

So `POST /api/games/{id}/ping` returns `pingInterval`: `PING_INTERVAL_SOLO_MS`
(10s) while the connected-coach count is 1, `PING_INTERVAL_MULTI_MS` (2s)
otherwise. The floor is `STALE_TIMEOUT_SECONDS` (120s), after which the server
frees the role — 10s leaves 12× margin, enough to absorb dropped requests on a
bad sideline connection.

Four things about it are load-bearing:

- **The decision is server-side and atomic with recording the ping.** Split
  "record this coach" from "count the coaches" and the second coach's *first*
  ping is answered from a list it isn't in yet — so the coach who just made the
  game multi-coach is the one told to poll slowly. `record_coach_ping()` does
  both under one lock for exactly this reason.
- **The client obeys the server; the sticky latch is a floor, not an override.**
  `game/controllerState.js` keeps `multiCoachSeen`, and once set it refuses any
  *slower* cadence for the rest of the game — clamping to the fastest the server
  has named rather than to a hardcoded constant. Hardcoding it there would mean
  `BREAKSIDE_PING_INTERVAL_MULTI` silently did nothing on the client, which
  defeats the point of putting cadence server-side. The role-based constants
  remain only as the fallback for a server that says nothing at all. The latch
  is *not* `ui/panelSystem.js`'s `_multiCoachDetected`, which answers "should the
  role buttons show" and can be set by hand from the game menu — a manual button
  reveal is no reason to triple the request rate.
- **Handoff expiry is sized to the holder's cadence, not a constant.** A request
  aimed at a backed-off holder stays open for 2× their recorded interval,
  because a fixed 10s window can elapse entirely inside one of their gaps —
  auto-approving a role away from a coach who was never shown the prompt.
- **One user on two devices is guarded, not supported.** Connected coaches are
  keyed by user id, so two instances of one account collapse to one entry: each
  would be told it was solo, both would back off, and each would then be a
  remote writer the other was slow to see — the one case where backing off is
  actively wrong. The ping carries a per-tab `X-Breakside-Instance` id used
  *only* to detect that, hold both copies fast, and warn. It is deliberately not
  an identity: sessionStorage only, never persisted, never keys connected
  coaches, and absent means "can't tell" rather than "duplicate". See TODO.md.

Two things about the instance header that look like problems and aren't. It
doesn't add a CORS round trip — the ping already carries `Authorization` and a
JSON content type, so it was never a "simple" request and was being preflighted
anyway (and Starlette echoes requested headers rather than returning a literal
`*`, so `allow_headers=["*"]` is still valid alongside `allow_credentials`). And
sessionStorage is per-tab, which is the point: a reload keeps its id, so
refreshing doesn't look like a second device.

The residual false positive is a *relaunch* — a killed PWA or a new tab starts a
new session, so for one liveness window (2.5× the cadence) the departed instance
still looks live and the coach sees one spurious warning. Bounded,
self-resolving, and the safe direction to err: a missed duplicate corrupts data,
a spurious one is a toast.

The cost the backoff buys is discovery latency: a solo coach learns that anyone
else arrived on its next ping, so up to one slow interval late. That bound is
asserted directly in `tests/scenarios/11-solo-ping-backoff.spec.ts`; specs about
*other* multi-coach timing synchronize past it with `waitForMultiCoachSeen()`
rather than racing it.

### Animations

Looping animations are the ones that matter: a one-shot transition is cheap, but
anything running `infinite` keeps the compositor from idling for as long as the
element is on screen. The header timer's danger/negative states pulse a fixed
number of times rather than forever — they're entered once a point runs long or
a game passes its cap and then persist for the rest of the game. A global
`@media (prefers-reduced-motion: reduce)` block in `css/base.css` neutralizes
animation and transition durations app-wide.

Note that `updateTimerDisplay()` removes and re-adds these state classes every
second. That does **not** restart the animation — restarting requires a forced
reflow between the remove and the add, which it doesn't do — so a finite
iteration count really does terminate. Verified empirically; don't "fix" it by
adding a reflow.

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Average game size | 5.85 KB |
| Compressed size | ~1.17 KB |
| Sync time | 25-50ms |
| Index rebuild | ~1 second (hundreds of games) |
| PWA load (cached) | <100ms |
| PWA load (network) | <500ms |

