# Breakside: Multi-User Rollout

This document tracks the implementation of multi-user support, enabling coach handoffs and collaborative game tracking.

For deployment info and technical architecture, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Completed Phases

<details>
<summary>✅ Phase 1: Authentication Foundation</summary>

Supabase email/password auth, JWT validation, auth dependencies, user/membership storage, auth API endpoints, frontend login screen, auth headers on all API calls, landing page with auth modal.

See code: `auth/`, `ultistats_server/auth/`, `landing/`
</details>

<details>
<summary>✅ Phase 2: Backend Auth Enforcement</summary>

Protected write endpoints (`sync`, `PUT`, `DELETE`) with role-based auth dependencies. Public read for shared games. Auto-sync polling between browsers.

See `ultistats_server/main.py` auth decorators, `test_auth.py`
</details>

<details>
<summary>✅ Phase 3: Team Membership Management</summary>

Invite system (5-char codes, single-use coach / multi-use viewer), landing page join flow, team settings UI with member list, invite management. Last-coach protection.

See [PHASE3_TEAM_MGMT_PLAN.md](PHASE3_TEAM_MGMT_PLAN.md), `teams/teamSettings.js`, `ultistats_server/storage/invite_storage.py`
</details>

<details>
<summary>✅ Phase 4: Game Controller State</summary>

In-memory controller state with thread-safe management, auto-expire (30s), auto-approve handoffs (5s). Role claiming, handoffs, adaptive polling (2s/5s), sleep/wake recovery.

See [PHASE4_CONTROLLER_PLAN.md](PHASE4_CONTROLLER_PLAN.md), `game/controllerState.js`, `ultistats_server/storage/controller_storage.py`
</details>

<details>
<summary>✅ Phase 5: Multi-User Game Sync (Core)</summary>

Cloud-only team/game UI, Active Coach push / Line Coach pull sync, pending line selections sync with timestamp merge, cloud-first team/game selection redesign, sleep/wake session recovery, active game indicators.

See `store/sync.js`, `teams/teamSelection.js`, `game/controllerState.js`
</details>

<details>
<summary>✅ Phase 6: Handoff UI</summary>

Role buttons with claim/request, handoff toast notifications with countdown, auto-assign roles to first coach, role button display logic (green/orange/grey).

See `game/controllerState.js`, `ui/panelSystem.js`
</details>

<details>
<summary>✅ Phase 6b: In-Game UI Redesign (Panels)</summary>

Replaced screen-based navigation with panel-based layout. All 6 panels implemented:

1. **Header**: Hamburger menu, score display with team identity, game/point timer, cap countdown
2. **Role Buttons**: Claim/handoff buttons for Active Coach and Line Coach
3. **Play-by-Play**: Responsive Simple Mode layout (5 breakpoints), Key Play dialog, Sub Players modal, Pull dialog auto-popup, Game Events modal
4. **Select Next Line**: Player selection table, O/D toggle, Start Point button with feedback colors, role-based access, conflict warning toast, multi-device sync
5. **Game Events**: Modal with Timeout, Half Time, Switch Sides, End Game
6. **Game Log**: Scrollable event history, role-based default states

Panel mechanics: drag-to-resize with shoving, chevron toggle, double-tap full-screen, localStorage persistence.

See `game/gameScreen.js`, `ui/panelSystem.js`, `ui/panelSystem.css`
</details>

---

## Next Up

### 🔄 Phase 6b Step 7: Legacy Cleanup

**Replace navigation pattern:**
- [ ] All `showScreen('beforePointScreen')` during active games → `enterGameScreen()` or panel state update
  - `teamSelection.js` - after "Continue Game"
  - `gameLogic.js` - offense/defense sub players buttons
  - `pointManagement.js` - after point ends
  - `rosterManagement.js` - continue game flow

**Remove Simple Mode toggle and full play-by-play:**
- [ ] Panel UI is now the only in-game mode (replaces Simple Mode)
- [ ] Remove Simple Mode toggle from header
- [ ] Remove full play-by-play event entry screens (to be re-coded later as optional feature)
- [ ] Keep Key Play dialog (already works from panel UI)

**Files to remove or gut:**
- [ ] `game/beforePointScreen.js` - replaced by panel UI
- [ ] `screens/offenseDefenseScreen.js` (if exists) - possession now handled by O/D toggle
- [ ] Parts of `screens/navigation.js` related to in-game screens
- [ ] Legacy CSS for removed screens
- [ ] References to `activePlayersTable` (panel version is authoritative)

**Testing checklist:**
- [ ] Start new game → enters panel UI
- [ ] Continue existing game → enters panel UI
- [ ] Point end → stays in panel UI, updates state
- [ ] Leave Game (hamburger menu) → returns to team list
- [ ] End Game → goes to summary screen
- [ ] All entry/exit paths work correctly

**Final steps:**
- [ ] Update version to 2.0.0
- [ ] Update ARCHITECTURE.md with new panel system
- [ ] Consider keeping legacy code in a git branch for rollback safety

---

### 🔄 Phase 5: Remaining Optimizations

- [ ] API poll endpoint with version check (avoid fetching unchanged data)
- [ ] Role-based polling intervals (Active Coach: push-only, Viewer: 5s)
- [ ] Server-side version tracking for optimized polling
- [ ] Conflict notification toast: "Game updated by another coach"
- [ ] API: `GET /api/teams/{team_id}/active-game` - Get currently active game for a team
  - Returns game ID and basic info if a game is in progress
  - "In progress" = has points, no gameEndTimestamp, started within last 6 hours
- [ ] Auto-join prompt when another coach starts/resumes a game
  - Toast notification: "[Coach] started a game vs [Opponent]. Join?"
  - Tap to enter game screen for that game

---

### 👁️ Phase 7: Viewer Experience

- [ ] PWA: Read-only mode for Viewers
  - Hide event buttons
  - Show "Spectating" badge
  - Live-update as events come in
- [ ] PWA: Join game via URL (`/view/{game-hash}`)
- [ ] Landing page: List recent public games
- [ ] Viewer: Show live score and play-by-play

---

## Backlog

- [ ] **Feature**: When Active Coach ends game, all coaches/viewers navigate to game summary. *(Partially done: wake recovery detects ended game. Still needed: real-time detection while foregrounded — 3-second game state refresh should detect `gameEndTimestamp` and navigate away.)*
- [ ] **To verify**: Test D line vs O line behavior with simultaneous selection. Define desired behavior when e.g. D line is selected but coach is viewing/editing O line.
- [ ] **Feature**: Checkbox in select-next-player table header to uncheck all players.
- [ ] Hide role buttons when only one coach on team or only one coach polling (more room for panels).
- [ ] O/D split panels: O/D button splits "Select Next Line" into two separate panels ("Select Next O Line" / "Select Next D Line").

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
# Deploy PWA to S3 (via GitHub Actions)
git push origin main
# GitHub Actions syncs to S3 and invalidates CloudFront

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
