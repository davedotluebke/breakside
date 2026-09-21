# Game Flow and Connections

Status: built on branch `game-flow`, on staging, unmerged. Last verified 2026-09-19.

How it works is in ARCHITECTURE.md § Game Flow (Review screen) and § Derived Statistics. This note holds the design calls and the traps.

## Design calls

- **Margin, not two score lines.** A single line of (us − them) reads momentum at a glance; two running-score lines cross and need a legend. The half-plane washes carry the "who is ahead" signal, so the line itself can be neutral.
- **Markers reuse the log's classification.** Break / hold / broken / their hold are the same four readings `classifyPoint` gives the log badges, in the same colour family (`--pbp-blue-ink`, `--pbp-green-ink`, `--pbp-red-ink`). No new vocabulary for the coach to learn.
- **Runs are 2+.** A "1–0 run" is every point, so `biggestRun` is null below two and the headline line is omitted rather than printed as noise. Only the biggest run per side is drawn thick; every run is available on the flow object.
- **Lead changes ignore ties.** 3–3 → 4–3 is not a lead change if the same side led before the tie. Ties are counted separately ("Tied 4 times").
- **Halftime is the first `Other{halftime}` marker.** It lives on the completed point (the log prints it after the score line), so "halftime after point N" is that point's index. A `switchsides` event is a period break in the log's O/D logic but is deliberately *not* drawn as a half: it is a correction, not the half.
- **Connections count a drop against the pair, not the thrower.** The player table leaves a drop out of the thrower's Throws (fault ruling, ARCHITECTURE.md § Derived Statistics). For a pair the useful question is "how often do these two connect", so a drop is an attempt. The two tables therefore can show different denominators for the same player; the column help and the pair tooltip both say why.
- **Six pairs by default.** A full-mode game has 40–60 pairs; the matrix is one tap away for anyone who wants all of them.
- **No sheets on a single-player export.** Both new xlsx sheets name other players; the single-player export exists to avoid exactly that (§ Single-player exports).
- **Collapsed by default, remembered per device.** Game Flow is the deepest dive on the page and starts collapsed (maintainer's call, 2026-09-20); Player Stats and Game Log start open. All three collapse from their headings (`ui/summarySections.js`), and the choice persists in `localStorage.breakside_summary_sections` so the coach who wants the chart every time is not re-opening it every game. Collapsing costs nothing on the chart side: it already drew lazily on width, so a collapsed section simply draws on first open.

## Traps

- **The summary renders while hidden.** `renderGameSummary` builds the DOM and only then calls `showScreen`, so `clientWidth` is 0 at mount time. The chart draws inside a `ResizeObserver` callback, which fires once the screen appears. Anything else that needs a real width on this screen has the same problem.
- **A ResizeObserver only reports at a rendering opportunity.** In an IDE preview pane nobody is looking at, the renderer can go without one for many seconds, and the chart sat empty with the section open and a real width. A real tab always paints, but the screen now calls the view's `redraw()` itself after `showScreen` and when the Game Flow section is opened, so the first draw never waits on the observer. The observer still handles rotation and window resizes. If a probe ever reports "open, width 984, no SVG", check for this before anything else.
- **Storage's sample team collides with fixture names.** With no stored teams, `store/storage.js` builds a "Sample Team" whose roster reuses the canonical fixture names (Alice, Bob, …) under other ids, and `buildPlayerNameResolver` reads a name with two ids as ambiguous. `tests/unit/connections.test.mjs` calls `setCurrentTeam(null)` after importing; a test that resolves names without doing that will see `ambiguous:Alice` keys.
- **SVG colours must be CSS classes.** A `fill="#…"` attribute would not flip with the theme and the token lint would not see it. Everything is `class="gf-…"` with `fill`/`stroke` in `ui/gameFlowChart.css`; the lint treats `fill`/`stroke` as foreground roles, so hairlines use `--ink-faint` / `--ink-dim`, not `--border-*`.
- **`ui/*.css` was not linted.** `scripts/lint-css-tokens.py` listed `ui/panelSystem.css` by name; it now globs the directory. New stylesheets under `ui/` are covered automatically.
- **`scratchpad/` was not in the deploy excludes.** The `.gitignore` note said so; it is now, so a worktree with scratch files can deploy to staging safely.

## Verifying

- `node --test 'tests/unit/*.test.mjs'` — 58 tests across the two flow files, 6 more for the section state in `summarySections.test.mjs`.
- Preview without a backend: load `?testMode=true`, inject a module script that imports `/store/models.js` (`hydrateGame`) and `/teams/gameSummary.js` (`showGameSummaryFromList`) and passes a synthetic game with `{name, id}` player refs, a `rosterSnapshot`, `Other{halftime}` / `Other{timeout, calledBy}` events and `totalPointTime` on the points. Check both themes (`document.documentElement.dataset.theme`) and the phone preset.
- Real serialized games: `./scripts/dev-backend.sh`, seed `test-user` a membership (docs/dev-notes/preview-testing.md), open a completed game's Review from the team list.

## Not built

- Per-half or per-phase connections, and a flow chart for a whole event (the run/lead stats are per game by definition).
- The Copy Game Log (text) clipboard text does not carry the headline lines.
- A docs-site clip; docs.html describes the section in text.
