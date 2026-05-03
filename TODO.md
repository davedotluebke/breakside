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

### AI Narration

MVP shipped. Coach speaks naturally; the system extracts structured game events. See **AI Narration** in [ARCHITECTURE.md](ARCHITECTURE.md) for the full design. Active work going forward is the post-MVP improvements list below.

---

## Near Term

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

## AI Narration — improvements

Improvements deferred from the initial implementation (see Active section above for the architecture summary).

### Quality / accuracy
- [x] **Remove vocabulary-mapping dead code from slow-pass prompt.** A/B test across the test corpus (commit `e24098e`) showed `NARRATION_VOCAB_GUIDANCE=off` (no explicit jargon→flag map) outperformed `=on` by +0.082 mean F1 with no regressions. Deleted the `vocab_section` branch in `_build_finalize_prompt`, the `NARRATION_VOCAB_GUIDANCE` env var, and the structurally-identical "Event-to-function mapping" block in the dead `buildInstructions()` in `narration/narrationEngine.js`.
- [ ] **Improve transcription accuracy**
  - Try `gpt-4o-transcribe` (more accurate than the `mini` variant currently used)
  - Investigate OpenAI's dedicated **Realtime transcription session** type — pure ASR, no LLM in the loop. Should be more accurate for our use case AND would silence the "Transcription complete." text spam from gpt-realtime emitting acknowledgments despite the don't-respond prompt.
  - Stronger client-side noise suppression / windscreen mic recommendation in coach docs
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

- [x] **Feature**: When Active Coach ends game, all coaches/viewers navigate to game summary. *(Wake recovery + foreground 3-second refresh both detect `gameEndTimestamp` and navigate away.)*
- [x] O/D line view persistence between points (combined O/D stays; separate O/D auto-switches based on who scored; split preserved).
- [x] **Feature**: Line selection mode toggle (Manual / Wholesale / Auto)
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
- [ ] **Bug**: Line panel checkboxes are editable by non-Line-Coach in multi-coach games
  - When two or more coaches are connected and the current user does not hold the Line Coach role, the player-selection checkboxes on the Line tab (and the panel in All view) should be disabled and visually greyed out — instead they're fully interactive. The single-coach case is fine: when only one coach is present, role enforcement is bypassed by design (the role-claim buttons themselves are hidden via `_multiCoachDetected` latch).
  - **Where to look**: `panelTableContainer` and `panelTableContainer{O,D}` in `game/gameScreen.js`; the existing `panelReadonlyOverlay` is only applied for the Viewer role. Need to extend disable logic to "multi-coach detected AND not Line Coach AND not Active Coach".
  - **Edge cases to think through**: coach loses Line Coach role mid-edit (commit or discard pending checkbox changes?); interaction with the Manual / Wholesale / Auto mode toggle (also needs to be disabled); injury-sub dialog table.
- [ ] **Extension**: Richer modifier flags on `Turnover` events
  - The Full PBP "Last turnover was a:" panel currently exposes only `huck` and `good D` because those are the only orthogonal flags on the `Turnover` model today. To support "threw it away while attempting a *break* / *hammer* / *dump*" (and `sky` / `layout` for drops, e.g. receiver tried to layout but missed), add `break_flag`, `hammer_flag`, `dump_flag`, `sky_flag`, `layout_flag` to the `Turnover` constructor in `store/models.js` and surface them in `summarize()`.
  - Touch points: `store/models.js` (constructor + summarize), `playByPlay/fullPbp.js` (extend `TURNOVER_MODIFIERS`), `ultistats_server/narration.py` slow-pass schema (add fields to the turnover event spec), `narration/narrationEngine.js` `applyTurnover` (forward the flags), and possibly `teams/gameSummary.js` if CSV columns enumerate flags.
  - Backwards compat: existing serialized turnovers without these flags should default false on load — no migration needed.
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

### Line Selection
- [ ] Smarter auto-lineup tiebreaking
  - Break ties (same points played) by preferring players who have sat out for more consecutive points
  - Then break remaining ties by preferring players with more total points played (reward workhorses)
- [ ] Player position and line preference in roster
  - Add position field to player records: handler, cutter, hybrid
  - Add O-line / D-line preference per player
  - Auto-lineup uses these to build balanced lines
- [ ] AI/stats-driven lineup suggestions
  - Use game stats and/or AI to pick players that play well together
- [ ] Wholesale/Auto icon UI redesign
  - Replace cycling text toggle with two separate icons in the toolbar, far left
  - Empty checkbox icon for Wholesale (clear all)
  - AI sparkle icon for Auto (suggest lineup)
  - Double-tapping either icon without making manual changes restores the snapshot (the players that were checked before wholesale cleared or auto filled)
- [ ] "Suggest lineups every point" toggle in pre-game/roster screen (auto mode as default each point)

### UI/UX
- [ ] Comprehensive UI redesign
- [ ] Dark mode support
- [ ] **Compact / roomy density toggle for Full PBP**
  - User preference (in Settings or inline gear) to swap between two sets of player-row sizing values: a "compact" preset (current build-206 numbers — min-height 40, margin 4, name padding 6/8, action padding 5/10, "…" 5/8) and a "roomy" preset (build-207 numbers — min-height 48, margin 6, name padding 8/10, action padding 7/10, "…" 7/8).
  - Persist the choice per-user in localStorage, applied as a CSS class on `.panel-playByPlayFull` (e.g. `density-compact` / `density-roomy`).
  - Default depends on whichever shipped value the user picked first; both presets already proven to fit 8 rows on phone height because the mini-log flexes to absorb the leftover slack (`flex: 1 1 auto` with a 110px floor).

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
