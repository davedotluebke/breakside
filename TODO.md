# Breakside Roadmap

This document tracks active work, near-term improvements, and the longer-term backlog. The original framing was a "Multi-user rollout" plan; multi-user shipped, so the scope is now broader.

For deployment info and technical architecture, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

Sections, in roughly priority order:

- **Active** — what's being worked on right now
- **Near Term** — small/medium items queued behind active work
- **Backlog** — solid ideas, not yet scheduled
- **Future Enhancements** — bigger asks, deferred until after current themes stabilize

---

## Active

### ⚠️ Temp ops cleanup — remove localhost from prod CORS

Added `http://localhost:3002` (and possibly `:3001`/`:3000`) to `ULTISTATS_ALLOWED_ORIGINS`
in `/etc/breakside/env` on EC2 so the localhost-only Claude preview could hit the prod API
while building the **Field tab** (`field-position` branch). Low risk (auth is a Bearer JWT in
`localStorage`, not reachable cross-origin), but remove it once Field-tab dev wraps up:

- [ ] `ssh ec2-user@3.212.138.180`; edit `/etc/breakside/env`, drop the `http://localhost:*`
      origin(s) from `ULTISTATS_ALLOWED_ORIGINS`; `sudo systemctl restart breakside`
- [ ] Also revert the `field-tab-phase0` staging deploy when done (redeploy whatever should
      live on staging), and remove the `field-app` entry from `.claude/launch.json`

### AI Narration

MVP shipped. Coach speaks naturally; the system extracts structured game events. See **AI Narration** in [ARCHITECTURE.md](ARCHITECTURE.md) for the full design. Active work going forward is the post-MVP improvements list below.

---

## Near Term

### ES-module migration follow-ups (from task E1, 2026-07-03)

The frontend is now native ES modules (branch `es-modules`). Cleanups the
migration surfaced but deliberately did not do (behavior-preserving rule):

- [ ] **Consolidate authFetch onto the 401-retry variant.** auth/auth.js's
      401-refresh-retry `authFetch` had been dead code since store/sync.js's
      simpler same-named global overwrote it at load time; the migration
      deleted the dead copy to preserve runtime behavior. The retry logic was
      the better implementation (B2 work) — port it into `store/sync.js`'s
      `authFetch` deliberately, with the test-mode guard intact.
- [ ] **Delete dead code found during conversion** (zero consumers, kept
      unexported): `teams/teamList.js` `selectTeam`/`populateCloudGames`/
      `deleteCloudGame`/`importCloudGame`/`triggerManualSync`/`pullDataFromCloud`/
      `showSetServerDialog`, `teams/rosterManagement.js`
      `updateGameSummaryRosterDisplay`/`removeGameStatsFromRoster`,
      `game/gameScreenEvents.js` `endGameConfirm` references (function defined
      nowhere), `ui/activePlayersDisplay.js` guarded calls to
      `updateGenderRatioDisplay`/`checkPlayerCount` (defined nowhere).
- [ ] **Countdown timer display**: `game/pointManagement.js`'s
      `updateTimerDisplay(seconds)` (targeting `#timerDisplay`) had been
      shadowed by `game/gameTimer.js`'s zero-arg version since gameTimer was
      introduced — its countdown ticks never updated `#timerDisplay`. The
      migration preserved that (deleted the shadowed copy). Decide whether the
      `#countdownTimer` UI is dead and remove it, or fix it to render again.

### Backend test suite: fix or retire the stale test_api/test_auth failures

`pytest ultistats_server/` is not green and hasn't been for a while — ~48 pre-existing
failures, none caught by the D3 refactor (failure set is identical before/after; verified
against a recorded baseline). Two distinct problems:

- [ ] `test_api.py` (~20 failures even standalone): tests still call **unprefixed paths**
      (`/players/{id}`, `/teams/{id}`, …) from before the `/api/` prefix; those now fall
      through to the PWA static catch-all and 404. Either update the paths to `/api/...`
      and re-assert, or delete the cases that `test_security.py` already covers better.
- [ ] `test_auth.py` + `test_existing_data.py` (fail only in the full-suite run, pass
      standalone): cross-test interference — module-level `from main import app` snapshots
      config/data dirs at collection time, so whichever test file patches `config` first
      wins. Isolate with per-module fixtures (like `test_security.py` does) or run against
      a tmp data dir via `ULTISTATS_DATA_DIR`.
- [ ] `tests/narration/test_scenarios.py`: live-LLM calls, inherently flaky (1–2 scenarios
      flip per run). Consider marking them `@pytest.mark.narration` and excluding from the
      default run so "pytest green" is meaningful again.

### Multi-user rollout — final items

The multi-user push is mostly done. A few items linger:

- [ ] PWA: Join game via URL (`/view/{game-hash}`)
- [ ] Landing page: List recent public games
- [ ] Viewer: Show live score and play-by-play
- [ ] "Clear pending" button in connection info dialog when sync queue has stuck items

### Multi-user rollout — completed (historical)

<details>
<summary>Phase 5: optimizations</summary>

- [x] API poll endpoint with version check (avoid fetching unchanged data)
- [x] Role-based polling intervals (Active Coach: push-only, Viewer: 5s)
- [x] Server-side version tracking for optimized polling
- [x] Conflict notification toast: "Game updated by another coach"
- [x] API: `GET /api/teams/{team_id}/active-game`
- [x] Auto-join prompt when another coach starts/resumes a game

</details>

<details>
<summary>Phase 7: viewer experience</summary>

- [x] PWA: Read-only mode for Viewers (hide event buttons, "Spectating" badge, live updates)

</details>

---

## Multi-Coach Line Selection: Intent Rule & LC-Viewing Label — ✅ SHIPPED

> **Status: implemented and merged to main (May 2026).** Server-side
> sync fix landed earlier in `9fadda1`; the client-side intent rule,
> LC-viewing label, dual-role greying, and live mid-point refresh landed
> via the `intent-rule-lc-label` branch, then were simplified by
> `simplify-line-selection` (split view removed; Lineup Ready reduced to
> a fire-and-forget ping). Both merged together.
>
> **What's live now** (so a future on-deck/"next next line" session has the
> current shape, not the original design):
> - `getEffectiveLineForNextPoint` picks the next line with the **side
>   fixed by who-scored** (never flipped). Priority: (1) LC's current
>   view (`lineCoachViewing`) if newer than every `*ModifiedAt` — `'od'`
>   → odLine, else the determined side's line; (2) per-axis most-recent
>   edit; (3) same-side fallback; (4) last-point safety net.
> - **LC-viewing label** on the AC's panel ("Line Coach: viewing the X
>   line") via synced `lineCoachViewing` / `lineCoachViewingAt`.
> - **Greying:** line panel editable iff the current user holds the Line
>   Coach role (solo coaching unrestricted). O|D toggle stays interactive
>   even when greyed.
> - **Lineup Ready** is a fire-and-forget ping (toast on both ends); no
>   persistent badge, no latch, no `lineupReadyMode`. Visible only to a
>   pure LC.
> - The `!isPointInProgress()` refresh gate is gone — the AC sees LC
>   edits + the viewing label live during a point.
> - **Split view removed.** `activeType` is `'o' | 'd' | 'od'` only.
>
> **Conventions for new `pendingNextLine` fields** (e.g. on-deck): pair
> each value field with its own `*ModifiedAt`/`*At` timestamp and extend
> `merge_pending_next_line` in `ultistats_server/storage/game_storage.py`
> (+ the read-merge in `store/sync.js` and serialize/deserialize in
> `store/storage.js`) to resolve it last-writer-wins. Apply the same
> role-based greying to any new line-selection surface.

<details>
<summary>Original design notes (superseded — kept for history)</summary>

### Context

The Line Coach (LC) plans the next line; the Active Coach (AC) records play. Today the AC has no clear signal of what the LC is currently doing, and the auto-pick rule for the "intended next line" is per-axis only (compares `oLine` vs `odLine` for an O-point, `dLine` vs `odLine` for a D-point), with no explicit "I'm done — use this" override. Field testing surfaced that the AC has to manually toggle views to discover whether the LC has prepared a separate O / D line, and the LC can't directly express the intent "use separate lines" vs "use the combined line."

### Goals

- The AC always knows what the LC is currently doing without having to ask, without forcing the AC's own view to mirror the LC's.
- The "intended next line" at point-end follows a clear rule that honors both the LC's most recent action and an explicit "Lineup Ready" intent signal.
- Solo coaching behavior is unchanged — these rules only activate when two coaches hold distinct roles.

### Design

1. **LC-viewing label, not view-following.** The AC's line panel header shows a small sub-line — e.g. `"Line Coach: viewing the D line"` — whenever the LC's view differs from the AC's local view. The AC's view is never auto-switched between points (except at point-end via the intent rule below). This replaces an earlier "AC view follows LC view" design that introduced a follow / manual-override state machine; the label gives the same information without coercion and naturally collapses to silence when nobody uses anything but O/D.

2. **Label is hidden in three cases:**
   - The AC's local view already matches the LC's view (no signal to convey).
   - No LC role is currently claimed.
   - The AC and LC are the same user (solo / dual-role).

3. **Viewing vs. editing distinction.** If the LC has edited any line in the last ~10s, the label reads `"Line Coach: editing the D line"`. Otherwise `"Line Coach: viewing the D line"`. The editing variant is a stronger nudge for the AC to look. The `*ModifiedAt` timestamps already on each line make this free.

4. **Intent rule (corrected) for point-end auto-switch.** When a point ends, `autoSelectActiveTypeForNextPoint` picks which line the AC's panel jumps to. Rule, in priority order:
   1. **Lineup Ready latch.** If the LC pressed Lineup Ready since the last point ended, use the line type they were viewing when they pressed it (new field `lineupReadyMode`). Strongest signal — explicit "I'm done, this is the line."
   2. **Most recent edit, per axis.** For an upcoming O-point, compare `oLineModifiedAt` vs `odLineModifiedAt`; for a D-point, compare `dLineModifiedAt` vs `odLineModifiedAt`. Newer non-empty side wins. (This is the current code — per-axis comparison is intentional and stays.)
   3. **Empty-axis fallback.** If the choice above is empty, fall through: typed-for-axis (non-empty) → `odLine` (non-empty) → whatever's non-empty → empty.

   Rejected alternative: a "global separate-intent" rule (any edit to *either* of `oLine`/`dLine` means the LC intends separate lines regardless of which axis was touched). That surfaces empty rosters when the LC only prepared one side — e.g. prepping D for the next defense point shouldn't make the AC see an empty O line if the team scores instead.

5. **Lineup Ready latch lifecycle.**
   - **Set** when the LC presses the Lineup Ready button. Records `lineupReadyAt`, `lineupReadyBy`, and (new) `lineupReadyMode` ∈ `'o' | 'd' | 'od'` capturing the LC's view at press time.
   - **Cleared** by: (a) the LC editing any line (the edit supersedes), (b) the LC pressing Lineup Ready again from a different view (new latch overwrites), (c) the next point starting (current behavior, already in `startNextPoint`).

6. **Greying / read-only rules for the line panel.**
   - **Editable** iff the current user holds the Line Coach role. Editing is always tied to the LC role; the AC observes via the LC-viewing label.
   - Concretely:
     - **Two users, AC ≠ LC** → LC user edits; AC user observes (greyed).
     - **Dual-role** (same user holds both, e.g. coming out of `auto_assign_roles_if_unclaimed`) → editable (holds LC).
     - **LC vacant while AC is claimed** → AC sees the panel greyed until they explicitly claim LC (single tap). Handles "LC went AFK" cleanly: AC claims LC, edits, optionally releases.
   - Solo coaching (no multi-coach detection) is unchanged — no role enforcement, panel always editable.
   - The O|D toggle stays interactive in the greyed state — viewing different line types is independent of editability.
   - **Historical note:** an earlier draft of this design said "editable iff `isActiveCoach && isLineCoach`" (i.e. dual-role only). That was a misstatement — it would have prevented the LC from editing in the most common multi-coach case (AC ≠ LC), which is the very situation the LC role exists for. The rule above is the corrected version.

7. **Drop the `!isPointInProgress()` refresh gate.** With the server-side merge from `9fadda1`, it's safe to pull `pendingNextLine` during a live point too. This lets the LC-viewing label and any line edits update live for the AC instead of waiting for the next between-points window. The gate exists at [`game/gameScreen.js:5397`](game/gameScreen.js#L5397) — remove the `!isPointInProgress()` condition around `refreshPendingLineFromCloud`.

### Data model additions

In `Game.pendingNextLine` ([store/models.js](store/models.js)) and the server-side payload. The server's `merge_pending_next_line` in [ultistats_server/storage/game_storage.py](ultistats_server/storage/game_storage.py) already preserves unknown keys, but it needs to be extended to merge the new timestamp-keyed fields the same way it handles `oLine` / `dLine` / `odLine`:

```
lineCoachViewing:     'o' | 'd' | 'od' | 'split' | null   // LC writes their activeType
lineCoachViewingAt:   ISO timestamp                       // merge key — most recent writer wins
lineupReadyMode:      'o' | 'd' | 'od' | null             // alongside existing lineupReadyAt/By
```

**Convention for any new fields** (including any added by the on-deck feature): pair each value field with a `*ModifiedAt` ISO timestamp, and extend `merge_pending_next_line` to compare timestamps. That keeps the multi-coach sync robust for free.

### Implementation pointers

- **LC writes `lineCoachViewing`** wherever they change `activeType` — currently `enterSplitMode`, `exitSplitMode`, and the O|D toggle handler in [game/gameScreen.js](game/gameScreen.js). Gate on `isLineCoach` so the AC's local activeType never leaks into the synced field.
- **AC reads `lineCoachViewing`** in the panel header render path (alongside `updateSelectLineSubtitle`). Render the label per #1–#3 above.
- **Greying logic** lives in `canEditSelectLinePanel` ([game/gameScreen.js](game/gameScreen.js)). Today: editable when "Line Coach OR Active Coach OR both roles unclaimed." Replace with: editable iff the current user holds the Line Coach role (`state.isLineCoach`) in multi-coach mode; always editable in solo. Update `updateSelectLinePanelState` to surface the new condition in the read-only overlay. The `.panel-selectLine.readonly .select-line-od-toggle` CSS rule in [ui/panelSystem.css](ui/panelSystem.css) needs to be removed so the O|D toggle stays interactive in the greyed state.
- **Intent rule corrections** go in `getEffectiveLineForNextPoint` at [game/gameScreen.js:4164](game/gameScreen.js#L4164). Add the Lineup Ready latch check before the timestamp comparison; add the empty-axis fallback after.
- **Lineup Ready cleared on line edit** — augment `handleSplitCheckboxChange`, `savePanelSelectionsToPendingNextLine`, and `saveSplitPanelSelections` to clear `lineupReadyAt`/`lineupReadyMode` when the LC modifies any line.
- **Refresh-gate removal** at [game/gameScreen.js:5397](game/gameScreen.js#L5397).

### Out of scope (deliberately)

- **Tap-to-switch on the label** (one-tap mirror of the LC's view). Easy to add later if coaches ask; start informational only.
- **Spectator / viewer behavior** stays unchanged — they continue to see the AC's view.
- **The "AC view follows LC view" design** discussed earlier (with manual-override breaking the follow until point-end + a "resume sync" affordance) is **rejected** in favor of the simpler label-based approach.

</details>

---

## AI Narration — improvements

Improvements deferred from the initial implementation (see Active section above for the architecture summary).

### ⚠️ Known issue — narration reported broken on staging (2026-07-04)
- [ ] **Deep dive needed.** User report from staging testing on 2026-07-04: "Audio narration seems broken, at least on staging" — symptoms not yet characterized (no transcript? no events applied? session fails to open?). Deliberately documented-only for now; deserves its own focused session. Starting points when investigating: reproduce on staging with devtools open (mic button → console + network for the `/v1/realtime/client_secrets` mint and the WebSocket), check whether the recent switch to the dedicated transcription session (`?intent=transcription`) is involved, and remember staging talks to the production API — server-side narration env/config (`ultistats_server/narration.py`, OpenAI key) applies. The Advanced Settings knobs (model, VAD, noise reduction) are available for isolating variables.

### Quality / accuracy
- [x] **Remove vocabulary-mapping dead code from slow-pass prompt.** A/B test across the test corpus (commit `e24098e`) showed `NARRATION_VOCAB_GUIDANCE=off` (no explicit jargon→flag map) outperformed `=on` by +0.082 mean F1 with no regressions. Deleted the `vocab_section` branch in `_build_finalize_prompt`, the `NARRATION_VOCAB_GUIDANCE` env var, and the structurally-identical "Event-to-function mapping" block in the dead `buildInstructions()` in `narration/narrationEngine.js`.
- [ ] **Improve transcription accuracy**
  - [x] Switch to OpenAI's dedicated **Realtime transcription session** (`?intent=transcription` + `session.type=transcription` minted via `/v1/realtime/client_secrets`). No LLM in the loop, no `response.*` events, kills the "Transcription complete." ack-text spam, cheaper (no output-token billing). Legacy conversational path still reachable via `NARRATION_USE_LEGACY_SESSIONS=1` env var or `mode: 'conversation'` (used when fast-pass is re-enabled).
  - [x] Adopt `semantic_vad` (eagerness `medium` by default — keeps multi-clause narrations like "Alice throws — short pass to Bob — score" together rather than fragmenting on every breath) and `noise_reduction: near_field`.
  - [x] **Advanced Settings UI** (header menu → Advanced Settings) exposes the per-device narration knobs without devtools: VAD eagerness, noise reduction, transcription model (mini ↔ `gpt-4o-transcribe`), vocabulary hint (biases ASR toward roster names + ultimate jargon via the transcription `prompt` field), force-English, and browser audio constraints (echo cancellation / noise suppression / auto-gain — AGC defaults on but can be turned off to test wind handling). Stored in `localStorage` via `settings/advancedSettings.js`; legacy `window.NARRATION_*` globals still win as dev overrides. Also added a Sync group with the cloud refresh interval (applies on reload).
  - [ ] **Field-test `gpt-4o-transcribe` vs mini** — now a one-tap toggle in Advanced Settings. Measure accuracy/cost on the corpus + real audio and decide whether to flip the default.
  - [ ] **Measure the vocabulary hint's effect** — A/B the new transcription `prompt` biasing (names + jargon) against off, on the corpus. Watch for the failure mode where biasing toward a term makes the recognizer over-produce it.
  - [ ] Stronger client-side noise suppression / windscreen mic recommendation in coach docs
- [ ] **Outdoor / multi-speaker robustness**
  - Field-test transcript word error rate against wind, crowd, and bystander voices
  - Now that transcription is decoupled from event extraction, this is a focused, measurable problem
- [ ] **Possession-boundary handling**
  - Current slow-pass prompt is told only the starting offense/defense state; doesn't explicitly handle multi-possession narrations
  - May need prompt strengthening or a more structured event-stream format to track team-side flips

### Coverage
- [ ] **Add `record_pull` to the slow-pass schema**
  - Currently if a coach narrates a pull (e.g. "Alice flicks an OI pull, brick"), it's ignored
  - Easy add: extend the event schema in `ultistats_server/narration.py` and add an applier in `narration/narrationEngine.js`
- [ ] **Re-evaluate streaming events (fast pass)**
  - Currently disabled via `FAST_PASS_EVENTS_ENABLED = false` in `narrationEngine.js`
  - All code is preserved — flip the flag to re-enable
  - Worth revisiting when we have a story for noisy-environment confidence (e.g. confidence-gating, transcript-stability checks)
  - **Before turning back on**: the "Event-to-function mapping" section in the dead `buildInstructions()` was already dropped along with the slow-pass vocab map (same failure modes). Still worth A/B'ing whether the per-property `description` fields on the tool definitions (e.g. `huck: "A long/deep throw"`) are pulling weight or are just a stealth vocab map.

### New voice-driven flows

Today the mic only narrates plays *during* a point. Two adjacent flows would extend voice control into the moments around each point:

- [ ] **Speech-driven point start (incl. pull recording)**
  - Tap mic on the pre-point screen and speak: "Alice, Bob, Carol, Dan, Eve, Frank, Grace — Bob hucks a flick OI pull, brick" → app selects those 7 players, transitions to in-point, and records the pull with puller + flags in one shot.
  - Requires the `record_pull` schema gap to be closed first (see Coverage above) so the pull leg of this flow has somewhere to land.
  - Touch points: `narration/narrationEngine.js` (new pre-point intent + applier), new pull schema in `ultistats_server/narration.py`, `pointManagement.js` (programmatic line-select + start-point hook), `game/gameScreen.js` (mic surfaced on Line tab when between points).
  - Open question: one mic-tap or two? Single tap that handles "line + pull" feels natural orally but mixes two state transitions; safer to gate the pull narration behind the line being confirmed first.

- [ ] **Speech-driven line selection (oral roll-call)**
  - On the Line tab between points: tap mic, read names ("Alice, Bob, Carol, Dan, Eve, Frank, Grace"), stop. App ticks the matching checkboxes. Pairs well with **Wholesale** (clear all → speak the seven).
  - Player-name resolution already exists in `narrationEngine.js` (`resolvePlayerName`) including nickname/jersey-number matching; extract it into a shared helper.
  - Touch points: `narration/narrationEngine.js` (new "name list" intent that maps transcript → player IDs without going through the slow-pass event extractor), `game/playerSelection.js` (programmatic checkbox toggle), gateway in `panelTableContainer{,O,D}` UI.
  - Edge cases: ambiguous names ("Cyrus" vs "Sirius"), name + jersey number disambiguation ("Alice number seven"), partial lines ("just sub Frank for Dan"), interaction with multi-coach Line Coach role enforcement.

### UX
- [ ] **Transcript panel UI polish**
  - Fade older text so most recent stays prominent
  - Highlight player names as they're recognized (would need light-weight name detection client-side)
  - Optionally show a "this will become events when you stop" hint

### Test suite

The audio-driven test harness is implemented in `ultistats_server/tests/narration/`. Skeleton works end-to-end. Scenarios `001`–`003` are the original baseline; `004`–`020` were scaffolded in a corpus-expansion pass (transcript + roster + expected committed; `audio.flac` to be generated via `tools/generate_synthetic_audio.py`). Real-audio variants (`004b`, `008b`, `015b`, `021`) are scaffolded for hand-recording.

Corpus structure:

| Theme | Scenarios |
|---|---|
| Baseline | 001 single throw • 002 multi-throw possession • 003 drop + interception + score |
| Self-correction | 004 name correction • 005 event-type downgrade (huck → throwaway) • 006 score → drop in endzone |
| Possession flips | 007 D-line layout block → score • 008 multi-flip yo-yo • 009 stall + opp score |
| End-of-point | 010 Callahan • 011 opp-score-only |
| Ultimate jargon | 012 reset/swing/IO • 013 hammer + sky combo • 014 footblock + bookends |
| Side commentary | 015 mid-narration coach chatter • 016 coach uncertainty |
| Numbers | 017 jersey-number-only references |
| Long form | 018 multi-possession spanning a point boundary |
| Alt roster (nicknames + phonetic + name=vocab) | 019 nickname recognition • 020 phonetic similarity + name "Sky" |
| Real audio (hand-record) | 004b name correction outdoor • 008b yo-yo outdoor • 015b commentary outdoor • 021 adversarial / coach-on-tilt |

Remaining work:

- [ ] **Generate audio for 004–020** via `tools/generate_synthetic_audio.py` (~$0.04 total at TTS rates)
- [ ] **Hand-record 004b / 008b / 015b / 021** in noisy outdoor conditions; same expected.json, different audio.flac. Built-in regression for outdoor robustness.
- [ ] **Schema gap: opponent unforced turnover.** Several scenarios above (007, 008, 014) gloss over what happens when the opponent throws it away to us — the narration schema in `ultistats_server/narration.py` has no event for "they turnover". The Full-PBP requirements doc models this as `Defense{unforcedError, defender=null}`. Decide whether to add it to the narration schema or handle implicitly via the next throw being from us.
- [ ] **Schema gap: `record_pull`.** Multiple scenarios start with "they pull" / "we pull" — currently dropped on the floor. Adding `kind: "pull"` (with `puller`, `out_of_bounds?`, `brick?`, `landed_in_endzone?`) would let those narrations carry their first event.
- [ ] **Noise injection** — mix in wind/crowd samples to simulate field conditions, run the same scenarios at varying SNR.
- [ ] **CI integration** — run on PRs that touch `narration/` or `ultistats_server/narration.py`. Fail on metric regression beyond a threshold. Cost note: ~$0.10 per scenario per run.

---

## Backlog

- [ ] **Code health: fold duplicated game-screen helpers** (deferred from the `gameScreen.js` split, D1). When `game/gameScreen.js` was split into `gameScreenPanels/Events/Timer/selectLine/gameScreenSync.js`, the split was kept a pure verbatim move for verifiability, so three already-identified, behavior-identical duplications were left in place. Fold them when convenient: `endGameFlow()` (the near-identical `handleEndGame` in `gameScreenEvents.js` vs `handleGameEventEndGame`), `installPollInterval()` (the clear-interval / `setInterval(ping)` idiom repeated ~3× across `controllerState.js`), and `stopPointTimerInto(point)` (the "add elapsed to `totalPointTime`, null `startTimestamp`" block duplicated in both score handlers in `gameScreenEvents.js`). Purely mechanical; do behind the e2e suite.
- [ ] **Code health: `ui/activePlayersDisplay.js`'s sticky active-players table is dead code** (found during the `teams/` refactor, D2). `updateActivePlayersList` / `createActivePlayersTable` / `makeColumnsSticky` target `#activePlayersTable` / `#tableContainer`, but neither element exists anywhere in `index.html` — the whole codepath is unreachable from any live screen. The live in-game "before point" table is `game/selectLine.js`'s panel-based system (`#panelActivePlayersTable`; its sticky styling is the id-scoped `.active-*` rules in `ui/panelSystem.css` plus the `makePanelColumnsSticky()` width-sync). Either delete the dead table code in `activePlayersDisplay.js`, or confirm there's a reason it's still there and wire it up. If deleting, the *unscoped* `.active-*` rules in `css/tables.css` (formerly main.css) can be pruned — but carefully, not wholesale: they're shared, not dead. `.active-checkbox-column` (text-align/padding) styles the live team-roster table's checkbox cells (`teams/rosterManagement.js`), and `.active-time-column`'s `font-style: italic` styles the live Line-tab time cells. Only the `position: sticky`/background/box-shadow/border/z-index declarations added for the dead table are safe to drop from the unscoped rules; the `#rosterTable`-scoped and `#panelActivePlayersTable`-scoped sticky rules serve live tables and must stay.
- [ ] **Code health: merge the duplicated game-log renderers** (noted 2026-07-05 while fixing between-points log ordering). Three near-copies walk points→possessions→events and print the same line format: `summarizeGame()` in `game/gameLogic.js` (feeds both the event-log textarea and the Log tab via `gameScreenSync.updateGameLogEvents`), `renderGameSummaryEventLog()` in `teams/gameSummary.js` (parameterized copy, adds point-classification badges), and the public viewer's per-point renderer (`ultistats_server/static/viewer/viewer.js`, card layout — structurally different but re-implements event walking/summarizing). Any format change must be made in at least the first two (e.g. the `betweenPoints` deferral landed twice on 2026-07-05; the Turnover possession-boundary logic exists only in `summarizeGame`, so the post-game summary already renders slightly differently). Extract one shared, parameterized renderer for the two frontend copies (`utils/`?); decide separately whether the viewer should consume it or stay bespoke.
- [ ] **Major refactor (someday, probably not soon): point lifecycle — create the next Point the moment the last one ends.** Technically a new point begins when the previous one ends (that's when between-point timeouts, switch sides, halftime happen), but the code creates a `Point` only at Start Point (`pointManagement.startNextPoint`) because its roster and starting position aren't knowable earlier — the line hasn't been picked and an intervening switch-sides can still flip O/D. Today between-point events therefore attach to the *completed* point's last possession, flagged `betweenPoints: true`, and the log renderers re-order them after the score lines — a display-level fix that works fine. Moving to always-materialized points would mean: placeholder Points with null players/startingPosition that `startNextPoint` fills in; reworking `isPointInProgress()` (its `possessions.length` fallback would misfire on a placeholder holding a timeout); auditing every `getLatestPoint()` consumer (~16 files: undo — including the empty-point double-tap backout — stats, narration, timers, all PBP surfaces) for "real point or placeholder?"; suppressing the phantom per-point column in the Line-tab table and the empty `Point N roster:` header in the log; end-game cleanup of a trailing placeholder; and sync back-compat (older clients and the deployed viewer would render the placeholder as a real point). Sized on 2026-07-05 as days of work with regression risk across the core game flow, versus the shipped render-order fix; revisit only if between-point *timing* data (e.g. actual time between points, timeout durations) becomes a feature goal.
- [ ] **Low-power / reduced-motion mode** (long-term). A toggle (and/or honoring the OS `prefers-reduced-motion`) that disables non-essential animations to save battery during long sideline sessions. One-shot transitions (e.g. the Field tab's 5s possession-change fade) are cheap, but *continuous/looping* animations and per-frame JS (`requestAnimationFrame`/`setInterval`) keep the GPU/CPU from idling and do drain battery — so the rule of thumb is: avoid always-running animations, and let this mode strip any that exist. Audit current usage (e.g. pull hangtime `setInterval`, any CSS loops) when implementing. Noted while building the Field tab.
- [ ] **Rare / administrative events** (long-term). Capture uncommon events that don't fit the main offense/defense/pull flows: offsides on the pull (O or D), cards (yellow / blue / red), and similar officiating/administrative calls. Likely surfaces via the "⋯ more" overflow on the Field/Full tabs (and the existing Game Events modal). Will need new event model support + summarize/serialization, and a decision on whether they affect possession (most don't). Noted while building the Field tab; out of scope for that effort.
- [x] **Feature**: When Active Coach ends game, all coaches/viewers navigate to game summary. *(Wake recovery + foreground 3-second refresh both detect `gameEndTimestamp` and navigate away.)*
- [x] O/D line view persistence between points (combined O/D stays; separate O/D auto-switches based on who scored; split preserved).
- [x] **Feature**: Line selection mode toggle (Manual / Wholesale / Auto) *(later superseded — the cycling mode toggle was replaced by one-shot Wholesale/Auto buttons on `line-selection-rework`; see "Wholesale/Auto icon UI redesign" under Future Enhancements → Line Selection.)*
  - Tappable text element in each player-selection table header that cycles through three states:
    - **Manual** (default): Whatever the user has checked. This is the normal behavior today.
    - **Wholesale**: All players unchecked (clean slate for building a line from scratch).
    - **Auto**: App suggests a lineup — picks players with fewest points played while respecting the game's gender ratio rules. Falls back gracefully when available players can't meet the ratio.
  - Tap cycles: Manual → Wholesale → Auto → Manual.
  - Toggling away from Manual saves the current checked set as a snapshot. Toggling back to Manual restores that snapshot.
  - Any manual checkbox change while in Wholesale or Auto immediately returns to Manual state, and the modified set becomes the new snapshot.
  - Resets to Manual at the start of each new point.
  - Present in all three player-selection contexts: main Select Next Line panel, O/D split panels, and injury substitution dialog.
- [x] Hide role buttons when only one coach on team or only one coach polling (more room for panels).
- [x] O/D split panels: O/D button splits "Select Next Line" into two separate panels ("Select Next O Line" / "Select Next D Line").
- [x] **Bug**: Line panel checkboxes are editable by non-Line-Coach in multi-coach games
  - Fixed in `canEditSelectLinePanel` (`game/gameScreen.js`): early-allow now checks the `_multiCoachDetected` latch (exposed via `window.isMultiCoachDetected`) instead of "no role claimed yet", so once a second coach has been seen this session the panel requires holding Line Coach (during point) or Line/Active Coach (between points). The existing `updateSelectLinePanelState` plumbing handles the rest — checkboxes get `disabled=true`, the `.readonly` class greys out the Manual/Wholesale/Auto toggle and the lines/OD buttons, and the "View Only" overlay appears. `cycleSelectionMode` was already gated by `canEditSelectLinePanel`. The injury-sub dialog is gated upstream by Active Coach (`canEditPlayByPlayPanel`) so no changes were needed there.
- [x] **Stats & Analytics** (breaks/holds, hockey assists, event phases, .xlsx export). Shipped together:
  - **Breaks / clean+dirty holds.** `classifyPoint` + `getGameTeamStats` / `getEventTeamStats` in `utils/eventStats.js`; per-point badges in the game log; per-game and per-event summary line; reported per D-point *and* per D-possession.
  - **Hockey assists + huck hockey assists** in `accumulateGameStats` (thrower of the pass before the assist); HA / Huck HA columns on both stats tables.
  - **Event phases.** `TournamentEvent.phases` + `Game.phase`; phases editor + auto-label-by-day in the event settings dialog; inline per-game phase picker; `PATCH /api/games/{id}/phase` (metadata-only); phase-filtered event stats; phase grouping in the event games list.
  - **Stats-screen polish.** Long-press column-header help modal (`utils/statsHelp.js`); two-line team-stats summary; points-played team total; sticky header row + sticky leftmost columns on both tables.
  - **Excel (.xlsx) export** replacing CSV on game summary, event roster (phase tabs), and team roster (event tabs); SheetJS vendored in `vendor/`; scoped AutoFilter for click-to-sort; real number/percent/time cell types. See `utils/xlsxExport.js`.

- [ ] **Analytics**: Honor per-point / per-possession recording-mode flags (`Point.modes` / `Possession.modes`)
  - **What exists now.** Every `Point` and `Possession` records which PBP recording modes were active during it, as a deduped array of `'simple'` / `'full'` / `'field'`. A possession's `modes` is stamped when an event is actually *recorded* into it (`Possession.addEvent` in `store/models.js`, reading `window.getCurrentMode()` from `ui/panelSystem.js`; the pull stamps itself in `playByPlay/pullDialog.js`) — NOT on creation or tab switches, so merely browsing/mis-tapping tabs leaves no trace. `Point.getModes()` derives the point's union from its possessions. Serialized/deserialized in `store/storage.js` and `store/sync.js`; legacy games (and points/possessions with no recorded events) have an empty `modes` array. The backend stores them as opaque JSON — no schema changes needed.
  - **Why.** These tell analytics how completely each point/possession was tracked, so stats can be included, excluded, or caveated:
    - `'simple'` present on a point ⇒ the coach likely *didn't* capture every throw; per-throw stats (completions, touches, hockey assists, etc.) for that point are unreliable. Only PT and goals/assists should be trusted.
    - `'field'` for the *entirety* of a possession (`modes` === `['field']`) ⇒ we have accurate location data for every throw in it; safe to feed into spatial/field analytics.
    - `'full'` ⇒ every throw recorded but without (reliable) location data.
    - Mixed arrays (e.g. `['simple','field']`) ⇒ mode changed mid-point/possession; treat the lower-fidelity floor as the trust level.
  - **TODO.** Update the stats computations (`utils/eventStats.js` — `accumulateGameStats`, `classifyPoint`, `getGameTeamStats`/`getEventTeamStats`) and the `.xlsx` export (`utils/xlsxExport.js`) to read `modes` and exclude/flag low-fidelity points & possessions accordingly. Decide on UI: a per-point badge or a footnote on the stats screen indicating which rows are mode-limited. Handle empty-`modes` legacy games (treat as unknown — probably "include but flag", matching how pre-existing tournament data is kept elsewhere).

- [ ] **Refinement**: Hockey assists as an explicit judgment call (not auto-derived)
  - **Problem with current behavior.** Today a hockey assist is awarded automatically to whoever threw the pass *before* the scoring pass (`accumulateGameStats` in `utils/eventStats.js` walks back through the possession). But like hockey / other sports that track pre-assists, a hockey assist is really a judgment call — was the goal *notably enabled* by that prior pass, or was it just the previous touch? Auto-derivation over-counts (every dump-swing-score gets one) and can't be recorded at all in Simple mode where the prior pass usually isn't entered.
  - **Proposed model.** Make the hockey assist an explicit attribution captured in the Score Attribution dialog (`playByPlay/scoreAttribution.js`), alongside the existing goal + assist pickers:
    - Add a "Hockey assist" control: a player dropdown.
    - **Full mode**: pre-select the thrower of the recorded pass-before-the-assist (the current auto-derivation result) but leave it editable — and allow clearing it to "no hockey assist."
    - **Simple mode**: default the dropdown to a placeholder like "Select HA passer" (the prior pass usually wasn't recorded, so there's nothing to pre-fill); coach picks from the roster or leaves it unset.
  - **Storage.** Record the chosen HA player on the scoring `Throw` event (e.g. `hockeyAssistId` / `hockeyAssist` name) rather than re-deriving it. Honor the huck case: a separate flag (or derive huck-HA from whether the recorded HA pass was a huck — only possible in Full mode where that pass exists).
  - **Stat computation.** `accumulateGameStats` reads the explicit HA attribution instead of walking the possession. **Backwards compat:** games played before this change have no explicit field — decide whether to (a) fall back to the existing auto-derivation for those, or (b) show them as having no HA. Leaning toward (a) so the tournament data already collected keeps its (approximate) HA numbers.
  - **Touch points:** `playByPlay/scoreAttribution.js` (dialog UI + new picker), `store/models.js` (Throw field), `store/storage.js` (serialize/deserialize the field), `utils/eventStats.js` (read explicit field, fall back to derivation), and the AI narration path (`narration/narrationEngine.js` + `ultistats_server/narration.py`) if we want narrated scores to capture HA too.

- [ ] **Feature**: Per-possession defensive/offensive set flag (zone tracking, etc.)
  - Tag each possession with the set being played (zone, ho-stack, vert-stack, force-middle, junk…). Primary v1 use case is marking which defensive possessions were played in zone, so that "breaks while running zone" type splits become possible later. Must stay invisible for teams that don't opt in.
  - **Data model**:
    - `Team.setsEnabled: boolean` (default `false`) — team-level opt-in.
    - `Team.sets: { offensive: string[], defensive: string[] }` — team-configurable label lists.
    - `Possession.set: string | null` — single label per possession; null = unspecified.
  - **Serialization** (`store/storage.js`): round-trip `setsEnabled` + `sets` in `serializeTeam`/`deserializeTeams`; round-trip `set` on each possession in `serializeGame`/`deserializeGame`. `Possession` constructor takes optional `set = null`. Server payloads are schema-loose, so no API changes.
  - **Backwards compat**: missing fields default to `false` / `[]` / `null`; UI hidden everywhere unless `setsEnabled` is on.
  - **UI surfaces** (all guarded by `team.setsEnabled === true`):
    1. **Team settings opt-in** (`teams/teamSettings.js`): toggle + two editable lists (offensive sets, defensive sets).
    2. **Defensive picker — pull dialog** (`playByPlay/pullDialog.js`): `<select>` populated from `currentTeam.sets.defensive`, only rendered if enabled and non-empty. Thread chosen value through `ensurePossessionExists(false)` (currently at `playByPlay/keyPlayDialog.js:607`).
    3. **Offensive picker — Full PBP modifier strip** (`playByPlay/fullPbp.js`): small cycling chip on the modifier-chips row; taps advance through `[null, ...currentTeam.sets.offensive]` and write to the current possession. Skip Simple mode for v1.
    4. **Display in event log** (`ui/eventLogDisplay.js` and game summary log): prepend possession blocks with `[Zone]` etc. when `possession.set` is set.
    5. **Aggregation hook** (later): `getGameTeamStats(game, {set})` / `getEventTeamStats(event, {set})` so set composes with the existing phase filter — "breaks while running zone: 4 of 7".
  - **Undo**: set lives on the possession itself, so existing undo handling needs no changes.
  - **Ship order**: schema + serialization → team settings opt-in → defensive picker (zone use case) → offensive chip → event-log display → aggregation filters.
  - **Cross-cutting**: bump `cacheName` in `service-worker.js` on any deploy touching CSS or top-level files; add a round-trip test for `setsEnabled`/`sets` in the server test suite.

- [ ] **Extension**: Richer modifier flags on `Turnover` events
  - The Full PBP "Last turnover was a:" panel currently exposes only `huck` and `good D` because those are the only orthogonal flags on the `Turnover` model today. To support "threw it away while attempting a *break* / *hammer* / *dump*" (and `sky` / `layout` for drops, e.g. receiver tried to layout but missed), add `break_flag`, `hammer_flag`, `dump_flag`, `sky_flag`, `layout_flag` to the `Turnover` constructor in `store/models.js` and surface them in `summarize()`.
  - Touch points: `store/models.js` (constructor + summarize), `playByPlay/fullPbp.js` (extend `TURNOVER_MODIFIERS`), `ultistats_server/narration.py` slow-pass schema (add fields to the turnover event spec), `narration/narrationEngine.js` `applyTurnover` (forward the flags), and possibly `teams/gameSummary.js` if CSV columns enumerate flags.
  - Backwards compat: existing serialized turnovers without these flags should default false on load — no migration needed.
- [ ] **Feature**: Undo across point boundaries
  - Today the global Undo (`undoEvent` in `gameLogic.js`) handles in-point events and rolls back possessions/scores within the current point, but there's no UI affordance to undo *backwards* across a point boundary (e.g. "the previous point's last event was actually wrong"). Once a point ends, its events are effectively read-only from the UI even though they're still in the data model.
  - Two interaction ideas — **either could be the v1**, or both can ship together:
    1. Extend the existing `Undo` button so when the current point has no events, it walks back into the previous point's last event. Confirm-prompt before crossing the boundary.
    2. **"Undo to this row" in Log view.** Long-press (or context-menu / kebab) on any event row in the Game Log to expose `Undo to here`. Tapping it pops every event after that row, restoring scores / possession state / point structure. Confirm-prompt with a count if more than 3–4 events would be removed: "This will undo 7 events, including the end of point 4. Continue?"
  - Touch points: `gameLogic.js` (extend `undoEvent` to optionally cross point boundaries; new `undoToEvent(eventRef)` helper), `ui/eventLogDisplay.js` (long-press handler, confirm modal), score/possession rollback already exists for in-point undo and would extend naturally. Watch for: stat re-derivation, narration provisional events that may be tied to specific possessions, and `moveToNextPoint` side effects (timer, sync) that need to be reversed when popping a "Point ended" event.

- [ ] **Bug**: `point.startTimestamp` is null at score time despite being set at point start
  - **Symptom**: `gameLogic.js` logs `Warning: point.startTimestamp is null; setting to now` during `updateScore()`, then sets it to the current time (score time, not point start time).
  - **Root cause (suspected)**: `pointManagement.js:78` sets `point.startTimestamp = new Date()` immediately after pushing the point to `game.points`. However, `saveAllTeamsData()` serializes the game to localStorage as JSON shortly after. When the game object is later read back (via sync cycle, cloud refresh, or localStorage reload), the `Date` object may not survive deserialization — JSON.stringify converts Dates to ISO strings, but the deserializer may not reconvert them, or the in-memory game reference may get replaced by a freshly deserialized copy that lost the Date.
  - **Impact**: Any code comparing `point.startTimestamp` to other timestamps during the point gets the wrong value. The `transitionToBetweenPoints()` "reset to ending line" logic used `pointStartTime` to decide whether the pending line was modified during the point — but since `pointStartTime` was actually score time, modifications made during the point appeared to be "before" the point started, causing them to be overwritten. (Worked around in the line-selection-mode branch by also checking `lineSelectionModes.main`.)
  - **Where to look**: `pointManagement.js` (startNextPoint), `store/storage.js` (serialization), `store/sync.js` (syncGameToCloud / refreshPendingLineFromCloud / refreshGameStateFromCloud), `store/models.js` (Point constructor / serialization). Check whether the in-memory `game` object gets replaced by a deserialized copy after sync, and whether Date fields survive the round-trip.

---

## Future Enhancements

Bigger asks, deferred until current themes settle.

### User & Auth
- [ ] User profile settings (update display name)
- [x] Google OAuth login
- [ ] Apple OAuth login
- [ ] Custom SMTP for Supabase emails (branded sender)
- [ ] **Brand the OAuth consent screen (before going wide).** Google sign-in
      currently shows the raw Supabase project domain
      (`mfuziqztsfqaqnnxjcrr.supabase.co`), surfaced as a "Will appear as…" note
      on the landing-page auth modal (`landing/index.html` `.google-note`). Needs a
      custom auth domain (e.g. `auth.breakside.pro`), which requires the paid
      Supabase tier. Once configured, drop the apologetic `.google-note` line.

### Team Management
- [ ] QR code generation for invites
- [ ] Role change (promote viewer to coach)
- [ ] Invite via email (send directly from app)
- [ ] Bulk invite (upload CSV of emails)
- [ ] Team admin role (separate from coach)
- [ ] Invite analytics dashboard

### Player Features
- [ ] Player ↔ User account linking
- [ ] Player self-service (edit own stats, profile photo)
- [ ] O-line / D-line presets with auto-promotion
- [ ] Refactor player references to use ID instead of name
  - Currently `Point.players`, `pendingNextLine`, etc. store player names
  - Using `player.id` (e.g., "Alice-7f3a") would handle duplicate names
  - Requires updating all `includes(playerName)` checks, serialization, data migration

### Infrastructure
- [ ] WebSocket upgrade for real-time sync
- [ ] Rate limiting and abuse prevention
- [ ] "Publish" games to make them searchable/discoverable
- [ ] Git-based backup and version history
- [ ] **e2e tests: stop hardcoding ports 3099/8100.** `tests/playwright.config.ts` pins the frontend/backend ports, and with Playwright's `reuseExistingServer` two worktrees (or parallel sessions) running the suite at once will reuse each other's leftover dev servers — so tests silently hit another branch's code (this masked, then unmasked, the `cachedEventStats` fix during investigation). Derive the ports per worktree (e.g. hash the repo path, or read an env var the dev-server script also honors) so concurrent runs are isolated. Same shared-port issue applies to `scripts/dev-server.sh`.

### Battery

Field reports: phones don't last a full day of 3–4 games. Battery sinks ranked by suspected impact (no instrumentation yet — confirm before optimizing):

1. **Screen-on time for hours** — by far the dominant drain. CPU, radio, and display all stay warm any time the screen is lit.
2. **In-game polling for non-Active-Coach roles** — Line Coach / Viewer poll the game state on a short cadence even when nothing has changed. Active Coach is push-only, so this only hits the secondary devices.
3. **Audio pipeline while mic is active** — `ScriptProcessorNode` resampling + base64 PCM frames over WebSocket every ~170ms. Modest when running, zero when idle. Worth measuring before changing anything; AudioWorklet may be more efficient than the deprecated ScriptProcessor we use now.
4. **Light HTTP polling between games** — what the Advanced Settings "Cloud refresh interval" controls. Almost certainly noise compared to (1) and (2), but exposing it means a power-user can dial it down.

Higher-leverage interventions, in roughly priority order:

- [ ] **Screen Wake Lock API + brightness guidance**
  - Acquire a wake lock during active game so the OS keeps the screen on even at very low brightness — coaches can then dim aggressively (the dominant battery saver) without their session dying.
  - Show a small "screen lock active" indicator + an explicit unlock affordance for when the user wants to pocket the phone.
  - Falls back gracefully on browsers that don't support the API.

- [ ] **Pause polling when tab is backgrounded / phone is pocketed**
  - The Page Visibility API hook already exists for wake recovery — extend it to suspend all setInterval polling loops while `document.visibilityState === 'hidden'`.
  - Resume + immediate-refresh on visibility change.
  - Risk: a backgrounded Line Coach misses an Active Coach handoff. Acceptable — wake recovery already handles re-sync on resume.

- [ ] **Audit Full PBP for persistent repaints / animations**
  - Long-running CSS animations and frequent DOM mutation force the compositor to stay active. Audit for: animated icons that never stop, the mini-log auto-scroll on each event, gradient/box-shadow that triggers full-layer repaints.

- [ ] **AudioWorklet migration for the narration mic path**
  - `ScriptProcessorNode` runs on the main thread and is deprecated; AudioWorklet runs on the audio thread and is the documented modern replacement. Should reduce per-frame CPU + main-thread jank during narration.
  - Bundled with the speech-driven flows when those land (less churn to do it once).

- [ ] **WebSockets for non-Active-Coach in-game sync** — see `### Infrastructure` above
  - Less polling overhead on the secondary devices. Modest savings; only worth it after (1) and (2) above are shipped.

- [ ] **Instrument before you optimize**
  - Add a lightweight battery-impact log: timestamp + `navigator.getBattery()` snapshots at session start, point boundaries, and game end. Even rough deltas across 2–3 games would tell us which intervention matters before we build it.

### Line Selection
- [x] Auto fill algorithm (priority-ordered) — shipped on `auto-line`
  - `computeAutoLine` / `buildAutoLineStats` in [game/gameScreen.js](game/gameScreen.js). Auto only *fills empty slots* up to the field count (7 for 7v7, 5 for 5v5, …); already-checked players are kept, and a full line fills nothing. Wholesale clears so Auto can repopulate from scratch.
  - Strict decreasing priority: (1) satisfy the active gender ratio's per-gender targets; (2) prefer players **not on the last point**; (3) prefer **less time played**, bucketed into **quintiles** (equal-time players share a bucket) so "about the same time" is one equivalence class; within a quintile tiebreak by (4) **fewer points played**, then (5) **longest current bench streak** (out the most points in a row).
  - All metrics are **current-game** scope. Time = `getPlayerGameTime`; roster = `getActiveRoster()` (event-aware, includes pickups).
- [ ] Handlers / cutters with per-line minimums
  - Add a position field to player records (handler / cutter / hybrid) and let the coach set a **minimum number of each** per line; Auto treats those minimums as constraints alongside the gender ratio (gender first, then position minimums), filling the rest by the priority order above.
  - Also: O-line / D-line preference per player to bias Auto by point type.
- [ ] AI/stats-driven "moneyball" auto-subbing
  - Use accumulated game/event stats (and/or an AI model) to pick players who **play well together** and suggest matchup-aware lines, beyond simple fatigue/rotation balancing.
- [ ] Reward-workhorses tiebreak (optional)
  - A deeper tiebreak that, all else equal, can prefer players with more total points played — deferred; current final tiebreak is name for determinism.
- [x] Wholesale/Auto icon UI redesign — shipped on `line-selection-rework`
  - Replaced the cycling Manual/Wholesale/Auto text toggle with two one-shot actions: **Wholesale** (clear) and **Auto** (fill empty slots). No persistent "mode" — selection is always manual.
  - Empty-checkbox icon for Wholesale, now living in a **table controls header row** (over the checkbox column); a lightning-bolt icon for **Auto** in the toolbar. The Game/Event time toggle also moved into that header row.
  - Snapshot/double-tap-restore was dropped along with modes (no longer meaningful — Auto augments the current selection rather than replacing it, and Wholesale is a deliberate one-shot clear).
  - Also added the **Combined / Separate** planning-mode control (per-game, synced): Combined = Next + On Deck; Separate = distinct O/D lines. See README and ARCHITECTURE § *Combined vs Separate line planning*.
- [ ] "Suggest lineups every point" toggle in pre-game/roster screen (auto mode as default each point)

### UI/UX
- [ ] Comprehensive UI redesign
- [ ] Dark mode support
- [x] **Compact / roomy density toggle for Full PBP**
  - Inline icon button in the Full PBP header (between mode pill and Undo) toggles between "roomy" (default — build-207 numbers: min-height 48, margin 6, name padding 8/10, action padding 7/10) and "compact" (build-206: min-height 40, margin 4, name padding 6/8, action padding 5/10).
  - Persisted per-device in localStorage as `breakside_full_pbp_density`, applied as a `density-compact` class on `.panel-playByPlayFull`.
  - Mini-log absorbs the resulting slack either way (`.full-pbp-log-reserve` is `flex: 1 1 auto`).

---

## Quick Reference

### Testing Auth Locally

```bash
# Start server with auth disabled (default)
cd ultistats_server && python3 main.py

# Test with auth enabled
AUTH_REQUIRED=true SUPABASE_JWT_SECRET=your-secret python3 main.py

# Run auth tests
pytest test_auth.py -v
```

### Deploy Commands

```bash
# Local dev server
./scripts/dev-server.sh            # serves on http://localhost:3000

# Deploy to staging (working directory, no commit needed)
# ALWAYS pass a short version description as the argument — it's written
# into version.json as `deployLabel` and shown in the staging Online/About
# overlay so you and other testers can visually confirm which build is
# live (especially useful when rapidly iterating).
./scripts/deploy-staging.sh "test audio narration v2"

# Deploy PWA to production (via GitHub Actions)
git push origin main

# Force PWA cache refresh
# Edit service-worker.js: increment cacheName (e.g., 'v8' → 'v9')

# Deploy API to EC2
ssh ec2-user@3.212.138.180
cd /opt/breakside && sudo git pull && sudo systemctl restart breakside
```

### Supabase Dashboard

- Project: https://mfuziqztsfqaqnnxjcrr.supabase.co
- Auth settings: Dashboard → Authentication → Settings
- User management: Dashboard → Authentication → Users
- **Important:** Set Site URL to `https://www.breakside.pro` for email redirects

### Backend: CORS headers on unhandled 500s (from staging shakedown, 2026-07-03)

- [ ] An unhandled exception in FastAPI returns a bare 500 **without CORS
      headers** (Starlette's ServerErrorMiddleware sits outside CORSMiddleware),
      so browsers block the response and fetch rejects with a TypeError
      ("Load failed" on Safari) — the client can't tell a server bug from a
      network drop. Add an exception handler / middleware ordering fix so
      error responses carry CORS headers. Confirmed in the wild 2026-07-03:
      a PermissionError 500 on game sync surfaced in Safari as "Load failed"
      with no status code, costing three diagnosis round-trips.
- [ ] **Version-backup write failure shouldn't 500 the whole sync.** The
      2026-07-03 staging incident was a root-owned `versions/` dir under one
      old game in `/var/lib/breakside/data/games/` (PermissionError in
      `atomic_write_json`) failing every sync of that game. Consider: log
      loudly + still accept the game state (or return a structured error),
      and add a startup ownership/writability check over the data tree.
