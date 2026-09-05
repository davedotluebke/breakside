# On Deck line

Status: shipped (branch `on-deck-line`, built 2026-06-07, merged; verified live on main 2026-08-10). Code: `game/selectLine.js`, `game/gameScreen.js`, `game/pointManagement.js`, `store/pendingLineLogic.js`, `breakside_server/storage/game_storage.py` (`_LINE_KEYS`).

## What it is

A fourth state on the Select Line O|D toggle (`od → o → d → odOnDeck → od`) so the Line Coach can prepare the line *two points ahead* while the current point is in progress. Motivation from field tests: after setting the Next line the Line Coach had nothing to do and would start points early just to advance the panel. Naming is the baseball metaphor: **Next** is the imminent line (`pendingNextLine`), **On Deck** is the one after.

## The design that landed, and what it replaced

Two rounds of deliberate simplification removed a split view and a "Lineup Ready" latch as over-engineered. The converged shape:

- **One bucket only**, `odOnDeckLine` plus `odOnDeckLineModifiedAt`. Not an O/D/OD mirror. On Deck is side-agnostic: "these seven play the point after Next, O or D."
- **Side-agnostic auto-promotion** in `startNextPoint`: if the bucket is non-empty, `odLine = odOnDeckLine; odLineModifiedAt = now; odOnDeckLine = []`. Three lines, no `determineStartingPosition`, no source juggling. This dodges the whole side-consistency bug class that earlier fixes had chased.
- **One derived, read-only projection column** in the on-deck view: each player's points-played-so-far plus one if they are in the tentative-next set. Pure-derived on each render, so there is no "update the projection but don't overwrite" matrix, which was most of the cost of the heavier design.
- The tentative-next source depends on phase: during a point use `odLine` (the side is unknown until the point ends, and `getEffectiveLineForNextPoint()` presumptively picks the O side mid-point); between points use `getEffectiveLineForNextPoint(game).line`.
- **Priority-1 guard**: `lineCoachViewing` feeds Priority 1 of `getEffectiveLineForNextPoint`. With `'odOnDeck'` in its domain, Priority 1 must skip it, or a non-Next view resolves into a Next bucket.
- No generation marker, no stored first-switch copy, no promotion toast. Empty bucket means "not set" means promotion is a no-op.

The bucket name `odOnDeck` was chosen so the existing `activeType + 'Line'` string-concat selection resolves to it with zero special-casing. That scheme is fragile; an enumerated registry would be cleaner and was deliberately deferred as too broad a change across hot files.

Deferred polish: a synced `lineCoachHorizon` so the Active Coach's label can say "viewing On Deck", and colouring the point+2 header by its deterministic gender ratio.

## Conventions for any new `pendingNextLine` field

- Pair every value with its own `*ModifiedAt` ISO timestamp.
- Extend all of: `merge_pending_next_line` in `breakside_server/storage/game_storage.py`, both read-merge sites in `store/sync.js` (`refreshPendingLineFromCloud` and `refreshGameStateFromCloud`), and serialize/deserialize in `store/storage.js`.
- Add a regression case to `test_storage.py::TestPendingLineMerge`.
- `_LINE_KEYS` is backend code, so a change there needs a backend deploy.

## Invariants of the base it builds on

- `getEffectiveLineForNextPoint(game)` returns `{ source, line }` and `source` is always side-consistent with who scored. Priority: the Line Coach's current view if its timestamp beats every `*ModifiedAt`; then per-axis most-recent edit; then same-side fallback; then last-point safety net.
- `canEditSelectLinePanel` is true iff the current user holds the Line Coach role (solo coaching unrestricted). Not "Active Coach and Line Coach"; that was a wrong earlier draft.
- Lineup Ready is fire-and-forget (toast only). Do not model new signals on the old latch; that code is gone.
- Mid-point Line Coach edits flow live to the Active Coach; the old `!isPointInProgress()` refresh gate is gone.
