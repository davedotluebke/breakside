# Replay Viewer — implementation plan

The Log tab grows a field diagram on top: player icons appear where the events
put them, the disc moves from spot to spot, and a transport bar plays the game
back — live (following the tail as events sync in) or as a replay of a past
game or point. Later a commentator (AI text-to-speech) narrates the same stream.

Interactive mockup (canonical interaction spec, like `mockups/field-position/`
was for the Field tab): **`mockups/replay-viewer/index.html`**. Run it with
`cd mockups/replay-viewer && python3 -m http.server 4174`.

Design decisions below were settled with Dave on 2026-09-03; the "Why" notes
record the reasoning so later sessions don't relitigate them.

**Status (2026-09-04):** steps 1–7 are **merged to main** (merge `4bd3400`)
after two field-test rounds on staging; ARCHITECTURE.md § Replay viewer is the
code-level map. Step 8 (editing v1) is **built on branch `replay-edit`**,
preview-verified, and awaiting a staging field test before merge — see
"Step 8 status and handoff" at the end of this document. The later items
(share-viewer port, sliding split, commentator, insert/delete) remain open.

## Decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | **Add `at` (epoch ms) to every event**, plus `startedAt` on possessions. Never synthesize timing for older data: an event without `at` is played *play-after-play* (fires as soon as the previous animation finishes). | Real pacing needs real timestamps; guessed spacing would look authoritative and isn't. |
| 2 | **Players appear only where an event places them.** A player's label appears the first time an event locates them and fades/drops with that event's marker. *(A roster strip above the field was tried and removed 2026-09-04: it rarely fit without compacting, and the log already lists the line at every point.)* | Only the thrower and receiver (defender, puller) of each event are ever located. Anything else would be invented. |
| 3 | **Reuse the Field tab's rendering**: field drawing, marker/arrow placement, and the fade-out of older events as new ones land. | One field, one look, one set of geometry bugs. |
| 4 | **Priority**: (a) in-game Log tab, (b) post-game Game Summary, (c) later, the public share viewer. | Coaches first; parents once the leaf module is stable. |
| 5 | **Log tab looks almost unchanged when a game has no field placements.** The field collapses; the log keeps its current format. | Most existing games were recorded in Simple/Full mode. |
| 6 | **"Live" = follow the tail.** New events animate as they sync in. Scrubbing back drops to 1× and shows a "Go live" pill. | That's what a coach on the sideline (or a parent) wants from "live". |
| 7 | **Speed slider stops: Live · 1× · 2× · 4× · Speedy.** Speedy (renamed from "Play after play" 2026-09-04) is 4× animation with no dead time at all. Live is only offered while the game is in progress. | One control; no mode toggles fighting each other. |
| 8 | **Dead time is capped**: 4 s between plays within a point, 8 s between points, by default. Both are Advanced Settings with an **Off** choice. No "skip dead time" button in the UI. | Real-time replay of a 90-minute game is never what anyone wants at 1×. |
| 9 | **Orientation is the user's pick**: landscape field with the strip above it (default), or portrait field with the strip down the side. Both reuse the Field tab layouts. The Log tab itself stays portrait-only on the phone (no auto-rotate). | Landscape leaves far more room for the log on a phone; some people think in portrait. |
| 10 | **Points without location data collapse the field** to maximize log space. Later: a sliding-panel split like the All tab, with the field auto-rotating as its panel shrinks. | Don't spend half the screen on an empty pitch. |
| 11 | **Editing v1 = location, players, modifiers.** Changing a receiver asks whether to change the next thrower to match, or to insert two Unknown Player passes to get the disc to the now-mismatched thrower. Inserting/deleting events is a distant TODO. | Covers what coaches actually fix after a point; the hard cases (stats recount, undo stack) wait. |
| 12 | **Commentator design**: events stand on their own; each prompt carries the text already spoken so phrasing and cadence stay natural. In play-after-play mode the next event waits for the audio to finish. | Prior narration is the cheapest, most reliable context signal. |

## What exists today (verified 2026-09-03)

- **Locations** live on `Throw`/`Turnover`/`Pull` (`from`, `to`) and `Defense`
  (`to`) as normalized `{x, y}` — see ARCHITECTURE.md § Field PBP spatial
  coordinate frame. Only the Field tab writes them.
- **No event timestamps.** `Point` has `startTimestamp`/`endTimestamp` (and
  `startTimestamp` doubles as the running-timer segment marker, so it is
  nulled on pause — never read it as "when the point began"). `Game` has
  `gameStartTimestamp` (set at construction) and `gameEndTimestamp` (set by
  End Game in `game/gameScreenEvents.js`).
- **Event creation chokepoint**: `Possession.addEvent()` in `store/models.js`
  — every PBP surface (Simple, Full, Field, narration appliers) funnels
  through `playByPlay/pbpPossession.js` into it. One bypass: the pull dialog
  `unshift`s its `Pull` directly (`playByPlay/pullDialog.js`, "unshift bypasses
  Possession.addEvent").
- **Serialization** (`store/storage.js`): `serializeEvent` writes every own
  property that differs from a default instance; `deserializeEvent` copies
  every key back. A new field with a `null` default round-trips with no
  further work. The server stores raw JSON (no schema), and the public viewer
  ignores unknown fields.
- **Game log** text/HTML comes from one place, `utils/gameLogRenderer.js`
  (pure leaf, unit-tested), consumed by the in-game Log tab
  (`game/gameScreenSync.js updateGameLogEvents`), the clipboard summary, and
  the post-game summary (`teams/gameSummary.js renderGameSummaryEventLog`).
- **Log tab** = the `follow` panel (`TAB_PANELS.log` in `ui/panelSystem.js`);
  its content is `createGameLogContent()` in `game/gameScreenPanels.js`, a
  single `#gameLogEvents` div. The same panel is the "Follow" panel in the
  All tab.
- **Field tab** (`playByPlay/fieldPbp.js`, 1.9k lines, one IIFE with private
  state `S`) owns geometry, `pct()/toField()`, `fieldHTML()`, the
  arrows/markers/disc layer with its fade-cohort machinery
  (`segCurStart`/`fadeCohorts`/`computeSegments`), `playerRailHTML()` +
  `chipHTML()`, marker drag (`moveMarker`/`finishMarkerDrag`/
  `reclassifyThrow`), and the portrait/landscape layouts in `fieldPbp.css`.
  It does **not** draw player icons on the field today — only chips in the
  rail and event markers on the pitch.
- **Live updates** reach the game screen via `breakside:game-stamp-changed`
  (listener in `game/gameScreenSync.js`) and locally recorded events via
  `logEvent()` → `updateGameLogEvents()`. The narration event bus
  (`narration/eventBus.js`) already defines `eventAdded` / `eventAmended` /
  `eventRetracted` channels.
- **Modifier editing** exists for the last event in the Full tab
  (`THROW_MODIFIERS` etc. + `handleModifierChange` in `playByPlay/fullPbp.js`,
  `findLastEditableEvent` in `pbpPossession`). Player-stat counters are
  applied per point (`game/pointStats.js applyPointPlayerStats` /
  `revertPointPlayerStats`).

## Architecture

```
store/models.js            Event.at, Possession.startedAt   (data)
utils/gameLogRenderer.js   buildGameLogEntries()            (pure leaf; text + HTML derive from it)
playByPlay/replayEngine.js timeline + clock rules            (pure leaf, node-tested)
playByPlay/replayController.js  timers, follow-live, edit gate (DOM-free; fake-timer tests)
playByPlay/fieldRender.js  field + markers + fades + actors  (extracted from fieldPbp.js)
playByPlay/replayView.js   Log-tab / summary mount: field, strip, transport, log wiring
playByPlay/replayEdit.js   v1 edit sheet (location, players, modifiers)
settings/advancedSettings.js  Replay group: caps, orientation
```

Dependency flow stays Data → Utils → Features → UI. `replayEngine` and
`gameLogRenderer` take a plain game-shaped object (no `currentGame()` globals)
so the same code can later ship to the share viewer, which can't import PWA
modules.

### 1. Timestamps (data)

- `Event` base: `this.at = null` (epoch ms). `Possession.addEvent()` stamps
  `event.at = event.at ?? Date.now()` — the `??` keeps narration's own
  timestamps if it ever supplies them. The pull-dialog `unshift` stamps the
  same way (make it call a shared `stampEvent()` helper so the two can't drift).
- `Possession`: `this.startedAt = null`, stamped in the constructor by the
  callers that create a possession on a possession change (`pbpPossession`'s
  ensure/flip paths, `keyPlayDialog ensurePossessionExists`). This is what
  gives "— Rivals on offense —" lines a time when there is no event (They
  turnover / They score have no event today).
- Game start/end: `gameStartTimestamp` is creation time, not first pull. Add
  nothing new; the replay's game clock is the first point's first `at`. Verify
  `gameEndTimestamp` survives sync merges (`store/sync.js` copies it in two
  places — good).
- Merge safety: the server's `merge_pending_next_line` only touches
  `pendingNextLine`; events are replaced wholesale on sync, so `at` needs no
  server change. Confirm with a round-trip in `breakside_server/test_api.py`.
- Tests: extend `tests/unit/setsSerialization.test.mjs`-style round-trip for
  `at`/`startedAt`; a pytest that a game with `at` on events survives a sync.
- Ship this **first**, alone — every field test after it collects real pacing
  data.

### 2. Game log as structured entries (utils)

`buildGameLogText` becomes a thin wrapper over a new
`buildGameLogEntries(game, options)` returning

```js
{ kind: 'roster'|'pull'|'possession'|'event'|'score'|'note',
  text, pointIdx, possIdx, eventIdx, event|null, at|null, side:'us'|'opp'|null }
```

`renderGameLogHTML` emits the same lines as today plus `data-entry="<i>"` on
each line. The existing renderer tests pin the text output byte-for-byte, so
this is a safe refactor. Timing for entries with no event: `roster` →
`point.startTimestamp` **only if the point has no events with `at`**
(otherwise the first event's `at`, since `startTimestamp` is pause-mutated);
`possession` → `possession.startedAt`; `score` → `point.endTimestamp`.

### 3. Replay engine (pure)

```js
createReplayEngine(game, { capWithinMs: 4000, capBetweenMs: 8000, speed: 1|2|4|'pap'|'live' })
  .entries            // from buildGameLogEntries
  .fieldStateAt(i)    // { players: {name → {x,y}|null}, disc, who, arrows, spots, pointIdx }
  .delayBefore(i, lastAnimMs)  // ms to wait before firing entry i
  .hasLocations(pointIdx)      // drives the collapse rule
```

Delay rule, in order: `live` → `lastAnimMs`; `pap` or either neighbour lacks
`at` → `lastAnimMs + 600`; otherwise `max(min(Δat, cap) / speed, lastAnimMs)`
where `cap` is `capBetweenMs` when entry `i` is a `roster` line, else
`capWithinMs`, and `Off` means no cap.

Field state derivation (the same rule the mockup uses): a `Throw` places the
thrower at `from` and the receiver at `to`; a `Turnover` places the thrower
at `from` and the disc at `to` in opponent hands; a `Defense` places the
defender at `to`; a `Pull` places the puller at `from` and the disc at `to` in
opponent hands. A `roster` entry resets everyone to the strip. `fieldStateAt`
is O(n) from the point start, which is fine (points have tens of events);
memoize per point if scrubbing ever feels slow.

Tests (`tests/unit/replayEngine.test.mjs`): the delay table above, mixed
timed/untimed points, cap = Off, live, the collapse rule, and field-state
derivation for each event type including "receiver of the last throw is the
holder".

### 4. Replay controller (DOM-free)

Owns `setTimeout`, the playhead index, follow-live state, and the unseen
counter. Subscribes to `breakside:game-stamp-changed` and the narration bus's
`eventAdded`/`eventRetracted`, rebuilds entries, and diffs by count: following
→ step through the new entries with animation; not following → bump unseen
and surface the "Go live" pill. Undo (`eventRetracted`) that removes entries
behind the playhead clamps the playhead. Emits:

- `entry` `{ index, entry, saidSoFar }` — the narration hook. Subscribers may
  return a promise; in `pap` mode the controller awaits it (with a ceiling)
  before scheduling the next entry. `saidSoFar` is the list of texts already
  emitted this session, for the commentator's prompt.
- `field` `{ state, animMs }` — for the renderer.
- `transport` `{ playing, speed, follow, unseen, editable }` — for the bar.

Tested with fake timers (`node:test` + `mock.timers`).

### 5. Field renderer extraction (the risky refactor)

Move out of `fieldPbp.js` into `playByPlay/fieldRender.js`, parametrized by a
`view` object instead of the module's `S`:

- geometry: `W/PLAYING/EZ/L/RZ`, `refreshGeometry`, `toNorm/fromNorm`,
  `pct/toField/clampLoc`, `inAttackEZ`;
- static layers: `fieldHTML` (lines, endzones, labels, attack arrow);
- event layer: arrows, markers, disc, `arrowColor/markerStyle`, and the fade
  cohorts — made **per instance** (`createFadeTracker()`) since module-level
  `segCurStart/fadeCohorts` would be shared by the Field tab and the replay;
- **new actor layer**: player icons at the positions `fieldStateAt` reports,
  using `chipHTML`'s number/name rules; CSS transitions on `left/top` with a
  per-render `--fp-dur`. The Field tab doesn't enable this layer (yet);
- `chipHTML` and the `.fp-rail` / `.fp-sidebar` layouts for the strip.

`fieldPbp.js` keeps everything interactive (armed/pending state, taps, drag,
pull stopwatch, pickers) and calls the shared module. Do it as a **pure
refactor commit** with no behavior change: run the Field-mode e2e
(`tests/scenarios/06-field-throw-classification.spec.ts`), deploy to staging,
and compare screenshots of a recorded point before and after. Flips
(`flipAD`/`flipHA`) stay render-time; the replay uses a fixed attack-up /
attack-right orientation for its own view.

Playing backwards through the fade tracker: the existing "boundary moved
backwards (undo)" branch already drops cohorts that overlap the solid window,
so stepping back just re-solidifies — no new state.

### 6. Log tab integration (`replayView.js`)

Mount above `#gameLogEvents` inside the `follow` panel, only when the Log tab
is the active single tab (the All-tab "Follow" panel is unchanged in v1):

- **Stage**: strip + field in the user's orientation (Advanced Settings
  `replay.orientation`, plus a rotate button on the transport bar). Landscape:
  strip above, field 110:40 full width. Portrait: strip down the side, field
  height-capped to about half the panel. Collapsed to a one-line banner
  ("No field positions in this point") when `hasLocations(pointIdx)` is false
  for the point under the playhead; hidden entirely, along with the transport
  bar, when the whole game has no located events — the Log tab then renders
  exactly as today.
- **Transport bar**: ⏮ prev · ▶/⏸ · ⏭ next · slider (Live · 1× · 2× · 4× ·
  Play after play) · Edit · rotate. Live is disabled (slider starts at 1×)
  once `gameEndTimestamp` is set.
- **Timeline**: one bar per point coloured by winner (in-progress = accent),
  tap to seek. The mockup shows it; cheap and worth keeping.
- **Log**: the existing HTML with `data-entry` lines; current line
  highlighted, lines past the playhead dimmed, tap to seek. Auto-scroll
  within the log container only (the mockup's first bug was `scrollIntoView`
  scrolling the page).
- Panel-visible checks: `isGameScreenVisible()` and `activeTab === 'log'`
  gate timers; stop the clock when the tab or screen goes away (the
  Field tab's `onTabShown` pattern).
- Settings, new group **Replay** in `settings/advancedSettings.js`:
  `replay.capWithinMs` (select: Off/2/4/8/15 s, default 4), `replay.capBetweenMs`
  (select: Off/4/8/15/30 s, default 8), `replay.orientation`
  (landscape/portrait, default landscape). Selects rather than a slider keep
  to the existing settings UI types and still carry Off.

### 7. Post-game summary

`teams/gameSummary.js renderGameSummaryEventLog(game)` mounts the same
`replayView` with the summary's game object (no `currentGame()`), Live
disabled. The share viewer port comes after this and reuses
`replayEngine` + `fieldRender` verbatim (they're leaves); the viewer's bespoke
log renderer gains `data-entry` the same way.

### 8. Editing v1 (`replayEdit.js`)

*Built 2026-09-04 on `replay-edit`; the "as built" notes are in the status
section at the end. Two deviations from the sketch below: the modifier
tables and geometry rules moved to a new pure leaf `playByPlay/eventAmend.js`
(node-tested) rather than into `pbpPossession`, and a spot that enters or
leaves the endzone does **not** offer to flip `score_flag` in v1.*

Paused only. Gate: in a live game `window.canEditPlayByPlay()` (Active Coach);
for a finished game, the same team-edit rights the summary uses. Every edit
goes through a new `pbpPossession.amendEvent(event, patch)` which publishes
`eventAmended` on the narration bus, saves, and syncs — one chokepoint for
undo/stats later.

- **Location**: drag the disc or the holder icon → same math as the Field
  tab's `moveMarker` → `reclassifyThrow` (huck/swing flags re-derive; the
  auto-score rule applies when a spot enters/leaves the endzone — confirm
  before flipping `score_flag`).
- **Players**: tap a line → sheet with thrower/receiver (defender, puller)
  chips from the point roster + Unknown. Changing a receiver whose next event
  has a different thrower opens a confirm: *Change next thrower to X* /
  *Insert two Unknown Player passes* (Throw X→Unknown, Throw Unknown→Y, both
  `inferred_flag`, no locations) / Cancel.
- **Modifiers**: the Full tab's `THROW_/TURNOVER_/DEFENSE_MODIFIERS` tables
  move to `pbpPossession` so both surfaces share them.
- **Stats**: a score whose thrower/receiver changes must revert and re-apply
  that point's player counters (`revertPointPlayerStats` → edit →
  `applyPointPlayerStats`); the summary tables recompute from events anyway.
- Distant TODO: insert/delete events (undo-stack and possession-boundary
  implications), editing the opponent's events.

### 9. Commentator hook (future, designed now)

`replayController` emits `entry` with `{ text, saidSoFar, entry }`. The
commentator module subscribes, prompts the model with the event text plus
`saidSoFar`, plays the audio, and returns a promise; in play-after-play mode
the controller waits for it (capped, so a stuck TTS never freezes replay).
Nothing else in the replay needs to know audio exists.

## Sequencing and estimates

| Step | Branch | Size | Notes |
|------|--------|------|-------|
| 1 Timestamps | `event-timestamps` | S | Ship first; backend restart not needed (no server change). |
| 2 Log entries refactor | `gamelog-entries` | S | Pure leaf; existing tests pin output. |
| 3+4 Engine + controller | `replay-engine` | M | Fully unit-tested before any UI. |
| 5 Field renderer extraction | `field-render-extract` | M–L | Highest regression risk; staging + screenshot compare. Independent of 3+4 — can run in a parallel session. |
| 6 Log tab integration + settings | `replay-log-tab` | M | Depends on 2–5. |
| 7 Post-game summary | `replay-summary` | S | |
| 8 Editing v1 | `replay-edit` | M | |
| Later | | | Share-viewer port; sliding-panel split with auto-rotate; commentator; insert/delete. |

## Open items to confirm while building

- Whether edits to a **finished** game already sync today (the summary screen
  has no edit paths now); if not, step 8 needs the save+sync path for
  non-current games.
- `gameStartTimestamp` for games created long before the first pull
  (pre-created for a tournament) — the replay clock ignores it, but the
  summary's duration stat may want the first `at` instead.
- Narration-applied events: whether to prefer the transcript's own timing for
  `at` (the model could return offsets) or the apply time. Apply time is the
  v1 answer; the `??` in `stampEvent` leaves the door open.

## Step 8 status and handoff — written 2026-09-04

Editing v1 is built on branch `replay-edit`. Verified in the in-IDE
preview against a fresh local backend on both mount sites (Log tab live
game, post-game summary). First staging field test (Dave, 2026-09-04)
found three things, all fixed and re-verified in the preview: the chip
strip didn't scroll on a phone (now wraps — `.fp-chip`'s `touch-action:
none` was the cause) and double-tap selected page text (`user-select:
none` on the sheet); a thrower change now gets the mirror confirm of the
receiver one (previous receiver, or the interceptor across the possession
boundary); and the gate is **any coach**, not the Active Coach role.
Second staging round (Dave, 2026-09-04): staging looked good; two
follow-ups landed — "Move spot" became per-player **Move thrower** (the
release point, cascading back into the previous catch / interception
spot) and **Move receiver** (the catch point, cascading into the next
release), and the ✎ is simply **hidden for viewers** rather than refused.
Third staging round pending; not merged.

### What shipped

- `playByPlay/eventAmend.js` — pure leaf (tests/unit/eventAmend.test.mjs,
  8 tests): modifier tables (moved out of fullPbp), `classifyThrowGeometry`
  (moved out of fieldPbp; both tabs now call it), `applyEventPatch`
  (players / `to` with cascade to the next `from` + reclassify / `*_flag`;
  `score_flag` refused; `from` cascades back via `holderSourceOf`),
  `receiverChainConflict` / `throwerChainConflict`
  (`holderSourceOf` looks back across one possession boundary for an
  interception), `insertUnknownBridge` / `insertUnknownBridgeBefore`,
  `adjustPlayerCounters`.
- `pbpPossession.amendEvent(evt, patch, {game, chain, source})` — the
  chokepoint: applies, reconciles the chain (`'retarget'` | `'bridge'`),
  moves the live counters, `logEvent`, publishes `eventAmended` (one per
  mutated event; `eventAdded` for the two bridge passes), saves, and
  **queues `syncGameToCloud(game)` itself when the game is not the current
  one** — `saveAllTeamsData` only syncs the current game, which answered
  the open item about finished games (they did not sync before).
- `playByPlay/replayEdit.js` + the ✎ button in `replayView.js` and the
  `rv-edit*` CSS. Mount sites pass `canEdit` / `editDeniedMessage` /
  `onEdited`: `game/gameScreenSync.js` (`updateGameLogEvents`) and
  `teams/gameSummary.js` (re-renders lines + both stats tables in place —
  the view is NOT remounted, so the playhead survives). Both gate on
  `!isViewer()`.
- `window.showControllerToast` is a new window survivor (controllerState).

### Preview-verified behaviours (2026-09-04)

Flag toggle re-renders the line; receiver change → inline confirm →
*retarget* rewrote the next thrower (and its later huck flag survived);
*bridge* inserted the two "(inferred) … Unknown Player" lines and the
playhead followed the edited play; armed spot drag moved the disc live,
the throw reclassified reset → huck on release; Play closed the sheet; the
summary mounted with Live disabled and the ✎ visible; each write hit
`POST /api/games/<id>/sync` on the dev backend.

### Not done / next

- **Staging field test on a phone** (the sheet is untested on iOS Safari:
  chip row horizontal scroll, `touch-action: none` on the armed pitch, the
  confirm row wrapping). Then merge; keep the branch.
- **Endzone ↔ `score_flag`**: moving a spot into / out of the attacking
  endzone leaves `score_flag` alone (deliberate — a goal change moves the
  score, `point.winner`, and the point boundary). If wanted, it belongs in
  a confirm that routes through the score-attribution flow, not `amendEvent`.
- **Non-current-game sync is verified by reading, not by test**: the
  preview edited the current game on the summary. A stored older game's
  edit should be checked once on staging (edit → reload → still there).
- Turnover / Defense "who" rows only appear when the event has that
  player; opponent plays and `Other`/`Violation` lines show "can't be
  edited here". Assist is not editable in v1.
- Preview gotcha seen this round: seconds after seeding events through
  the module script, the live game was replaced by the server's stale copy
  (the sync-replacement trap in memory *project_preview_game_testing*) and
  the seeded events vanished. Seed and drive the sheet in the SAME
  javascript call.
- Distant: insert / delete events; undo of an amendment (the bus carries
  `previousEvent`, nothing consumes it yet).

### Preview test recipe additions (beyond steps 1–7's recipe below)

- Use `ST.currentTeam.games[...]`, not `ST.teams[0]` — a sample team sits
  at index 0 with no games, and `showGameSummaryFromList(undefined)`
  silently no-ops.
- `javascript_tool` runs in an isolated world but shares the DOM: driving
  the sheet by `.click()` on `.rv-editbtn` / `.fp-chip[data-pname]` /
  `.rv-mod[data-prop]` / `[data-chain]` and dispatching `PointerEvent`s on
  `.rv-field` works. **No `await sleep()` while the pane is hidden** —
  timers stall and the tool times out (the clicks still land). Amendments
  are synchronous; read the DOM right after.
- The pull dialog re-opens on every render; `#pullDialog{display:none
  !important}` in an injected `<style>` keeps screenshots clean.

## Handoff notes from steps 1–7 (still accurate)

Everything below is what a fresh session needs beyond the code and ARCHITECTURE.md.

### Where things are

- `playByPlay/replayView.js` — the only DOM code. `mountReplayView(cfg)` is
  called from `game/gameScreenSync.js` (`ensureReplayView`, Log tab, live)
  and `teams/gameSummary.js` (`renderGameSummaryEventLog`, stored games).
  The view keeps `controller`, `engine`, `root`; `drawField(index, state,
  animate)` renders one playhead position; `redraw()` re-renders the current
  one. The controller already has `setEditing(on)` (refused while playing)
  and a `transport` snapshot field `editing` — nothing renders it yet.
- `playByPlay/replayEngine.js` — `fieldStateAt(i)` gives `players`,
  `holder`, `disc`; `entries[i].event` is the live event object (same
  identity as in `game.points[..].possessions[..].events[..]`), with
  `pointIdx/possIdx/eventIdx`.
- `playByPlay/fieldRender.js` — `toField(view, fx, fy)` + `clampLoc` +
  `toNorm` turn a tap/drag on the pitch into a stored `{x, y}`; the Field
  tab's `moveMarker` / `finishMarkerDrag` / `reclassifyThrow` in
  `playByPlay/fieldPbp.js` are the reference for a location edit (huck /
  swing flags re-derive from geometry; a `to` entering the attacking endzone
  is the auto-score rule — confirm before flipping `score_flag`).
- Modifier tables: `THROW_MODIFIERS` / `TURNOVER_MODIFIERS` /
  `DEFENSE_MODIFIERS` and `handleModifierChange` live in
  `playByPlay/fullPbp.js`; `findLastEditableEvent` in `pbpPossession`. Plan
  step 8 says to move the tables to `pbpPossession` so both surfaces share
  them.
- Player-stat counters: `game/pointStats.js` `revertPointPlayerStats` /
  `applyPointPlayerStats` — a score whose thrower/receiver changes must
  revert + re-apply that point.
- Narration bus: `narration/eventBus.js` has an `eventAmended` channel
  (payload `{event, source, previousEvent}`) that nothing publishes yet —
  the natural chokepoint for `pbpPossession.amendEvent(event, patch)`.
- Save + sync after an edit: `saveAllTeamsData()` from `store/storage.js`
  (that is what every PBP surface calls). **Unverified:** whether edits to a
  *finished* game (summary screen) sync — the summary has no edit paths
  today. Check `store/sync.js` for how a non-current game is pushed before
  building on it.
- Gate: `window.canEditPlayByPlay()` (Active Coach) for live games.

### Log-line ↔ event mapping

Lines carry `data-entry="<i>"`; `engine.entries[i]` is the entry; the
engine and the log MUST be built with the same options
(`gameLogEntryOptions()` in `game/gameLogic.js`, or the summary's option
object) or indices drift. After an edit, call the view's `onLogUpdated()`
(it rebuilds the engine and re-marks lines) — the Log tab does this itself
whenever `updateGameLogEvents()` re-renders.

### Test recipe that worked (preview, no chip-dragging)

1. `./scripts/dev-backend.sh --port 8010 --label replay --fresh`, add a
   launch.json entry serving the worktree on its own port (absolute script
   path — see memory *project_preview_worktree_launch_json*), open
   `?api=http://localhost:8010&testMode=true`.
2. Create a team + 7 players through the UI (ids `newTeamNameInput`,
   `saveNewTeamBtn`, `showRosterBtn`, `newPlayerInput`,
   `newPlayerNumberInput`, `addFMPPlayerBtn`, `backToStartGameBtn`,
   `opponentNameInput`, `startGameOnDBtn`), tick all boxes in
   `#panelActivePlayersTable`, click `#pbpStartPointBtn`, dismiss
   `#pullDialogClose`.
3. Seed located events from a main-world `<script type="module">` (the
   javascript tool runs in an isolated world):
   `import { pbpPossession } from '/playByPlay/pbpPossession.js'` and call
   `createPull / createDefense / createThrow(P('Bob'), P('Carol'), {from, to,
   reset:true})` with `P = getPlayerFromName` from `/utils/helpers.js`.
   Side effect: the pull dialog re-opens on every render because its
   Proceed was never pressed — harmless, dismiss it.
4. Log tab: `#headerSegControl button[data-tab="log"]`; the view is
   `.rv-root` inside `.game-log-content`. Summary:
   `GS.showGameSummaryFromList(game)` from `/teams/gameSummary.js` with a
   game from `ST.teams` (`/store/storage.js`).
5. The hidden Browser pane returns black screenshots and never fires
   ResizeObserver / rAF; pin an element `position:fixed; top:0` to
   screenshot it, and verify layout with `getBoundingClientRect` probes.

### Field-test lessons (all fixed, don't regress)

- Never use theme tokens for anything drawn ON the pitch — it is always
  green; dark mode made white-on-white labels.
- iOS Safari: size the pitch by **width** (`width` + `aspect-ratio`,
  `height: auto`); height-driven sizing with a % max-width collapsed to zero
  width, and flex `stretch` beat `aspect-ratio` — the field is
  `align-self: flex-start`.
- Font Awesome comes from a CDN; on a weak signal the transport buttons went
  blank. The replay bar's icons are inline SVG now — keep it that way.
- `touch-action: none` + no text selection on the slider and timeline, or a
  drag scrolls the page.
- A pre-merge-commit hook runs the Playwright suite when merging into main;
  a flaky run leaves the merge staged ("Not committing merge") — `git commit
  --no-edit` re-runs it.
