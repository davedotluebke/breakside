# Breakside: Multi-User Rollout

This document tracks the implementation of multi-user support, enabling coach handoffs and collaborative game tracking.

For deployment info and technical architecture, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Next Up

### Phase 5: Remaining Optimizations

- [x] API poll endpoint with version check (avoid fetching unchanged data)
- [x] Role-based polling intervals (Active Coach: push-only, Viewer: 5s)
- [x] Server-side version tracking for optimized polling
- [x] Conflict notification toast: "Game updated by another coach"
- [x] API: `GET /api/teams/{team_id}/active-game` - Get currently active game for a team
  - Returns game ID and basic info if a game is in progress
  - "In progress" = has points, no gameEndTimestamp, started within last 6 hours
- [x] Auto-join prompt when another coach starts/resumes a game
  - Toast notification: "[Coach] started a game vs [Opponent]. Join?"
  - Tap to enter game screen for that game

---

### Phase 7: Viewer Experience

- [x] PWA: Read-only mode for Viewers
  - Hide event buttons
  - Show "Spectating" badge
  - Live-update as events come in
- [ ] PWA: Join game via URL (`/view/{game-hash}`)
- [ ] Landing page: List recent public games
- [ ] Viewer: Show live score and play-by-play

---

## AI Narration (Post-MVP)

The narration feature is on the `claude/pensive-edison` branch with a transcription-only fast pass + Claude Sonnet slow pass. Items below are improvements deferred from the initial implementation.

- [ ] **Improve transcription accuracy**
  - Try `gpt-4o-transcribe` (more accurate than the `mini` variant currently used)
  - Investigate OpenAI's dedicated **Realtime transcription session** type — pure ASR, no LLM in the loop. Should be more accurate for our use case AND would silence the "Transcription complete." text spam from gpt-realtime emitting acknowledgments despite the don't-respond prompt.
  - Stronger client-side noise suppression / windscreen mic recommendation in coach docs
- [ ] **Outdoor / multi-speaker robustness**
  - Field-test transcript word error rate against wind, crowd, and bystander voices
  - Now that transcription is decoupled from event extraction, this is a focused, measurable problem
- [ ] **Add `record_pull` to the slow-pass schema**
  - Currently if a coach narrates a pull (e.g. "Alice flicks an OI pull, brick"), it's ignored
  - Easy add: extend the event schema in `ultistats_server/narration.py` and add an applier in `narration/narrationEngine.js`
- [ ] **Transcript panel UI polish**
  - Fade older text so most recent stays prominent
  - Highlight player names as they're recognized (would need light-weight name detection client-side)
  - Optionally show a "this will become events when you stop" hint
- [ ] **Re-evaluate streaming events (fast pass)**
  - Currently disabled via `FAST_PASS_EVENTS_ENABLED = false` in `narrationEngine.js`
  - All code is preserved — flip the flag to re-enable
  - Worth revisiting when we have a story for noisy-environment confidence (e.g. confidence-gating, transcript-stability checks)
- [ ] **Possession-boundary handling**
  - Current slow-pass prompt is told only the starting offense/defense state; doesn't explicitly handle multi-possession narrations
  - May need prompt strengthening or a more structured event-stream format to track team-side flips
- [ ] **Audio-driven test suite** — see separate section below
- [ ] **Merge to main once stable on staging**

## Audio-Driven Test Suite (AI Narration)

Goal: a regression / evaluation harness that takes audio inputs with expected event outputs and reports accuracy. Lets us safely tune prompts, swap models, and measure outdoor robustness without manual ear-testing.

- [ ] **Test runner skeleton** (Python) that:
  - Reads test scenarios from a directory of `(audio.wav, expected.json)` pairs
  - Streams the audio to OpenAI Realtime API server-to-server (no browser needed)
  - Captures the transcript
  - Calls `/api/narration/finalize` with the transcript + a fixed roster
  - Compares the resulting operations to expected, computes metrics
- [ ] **Initial test corpus** (~10 scenarios): single throw, multi-throw possession, score, turnover types (throwaway/drop/stall), defense (interception/layout D), self-correction, possession boundary, opponent score, Callahan
- [ ] **Synthetic audio generation** via TTS (OpenAI `tts-1` or similar) for cheap deterministic tests
- [ ] **Real-game audio corpus** — coach hand-records ~5 narrations during real games, hand-labels expected events. Smaller but higher signal than synthetic.
- [ ] **Noise injection** — mix in wind/crowd samples to simulate field conditions, run the same scenarios at varying SNR
- [ ] **Metrics**: transcript WER, event-set precision/recall (match on type + player + flags), player-resolution accuracy, ordering preservation
- [ ] **CI integration** — run on PRs that touch `narration/` or `ultistats_server/narration.py`. Fail on metric regression beyond a threshold.

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
- [ ] "Clear pending" button in connection info dialog when sync queue has stuck items.
- [ ] **Bug**: `point.startTimestamp` is null at score time despite being set at point start
  - **Symptom**: `gameLogic.js` logs `Warning: point.startTimestamp is null; setting to now` during `updateScore()`, then sets it to the current time (score time, not point start time).
  - **Root cause (suspected)**: `pointManagement.js:78` sets `point.startTimestamp = new Date()` immediately after pushing the point to `game.points`. However, `saveAllTeamsData()` serializes the game to localStorage as JSON shortly after. When the game object is later read back (via sync cycle, cloud refresh, or localStorage reload), the `Date` object may not survive deserialization — JSON.stringify converts Dates to ISO strings, but the deserializer may not reconvert them, or the in-memory game reference may get replaced by a freshly deserialized copy that lost the Date.
  - **Impact**: Any code comparing `point.startTimestamp` to other timestamps during the point gets the wrong value. The `transitionToBetweenPoints()` "reset to ending line" logic used `pointStartTime` to decide whether the pending line was modified during the point — but since `pointStartTime` was actually score time, modifications made during the point appeared to be "before" the point started, causing them to be overwritten. (Worked around in the line-selection-mode branch by also checking `lineSelectionModes.main`.)
  - **Where to look**: `pointManagement.js` (startNextPoint), `store/storage.js` (serialization), `store/sync.js` (syncGameToCloud / refreshPendingLineFromCloud / refreshGameStateFromCloud), `store/models.js` (Point constructor / serialization). Check whether the in-memory `game` object gets replaced by a deserialized copy after sync, and whether Date fields survive the round-trip.

---

## Future Enhancements (Post-Rollout)

These are deferred until multi-user basics are stable:

### User & Auth
- [ ] User profile settings (update display name)
- [ ] Google/Apple OAuth login
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
./scripts/deploy-staging.sh

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
