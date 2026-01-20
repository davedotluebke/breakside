# Breakside: Multi-User Rollout

This document tracks the implementation of multi-user support, enabling coach handoffs and collaborative game tracking.

For deployment info and technical architecture, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Current Status

### ✅ Phase 1: Authentication Foundation (Complete)

- [x] Set up Supabase project (email/password auth)
- [x] Backend: JWT validation module (`auth/jwt_validation.py`)
- [x] Backend: Auth dependencies (`auth/dependencies.py`)
- [x] Backend: User storage (`storage/user_storage.py`)
- [x] Backend: Membership storage (`storage/membership_storage.py`)
- [x] Backend: Auth API endpoints (`/api/auth/me`, `/api/auth/teams`)
- [x] Frontend: Auth config and client (`auth/config.js`, `auth/auth.js`)
- [x] Frontend: Login screen component (`auth/loginScreen.js`)
- [x] Frontend: Auth headers on all API calls
- [x] Frontend: Sign out button in PWA
- [x] Landing page with Supabase auth modal
- [x] Server routes for `/app/`, `/landing/`, `/view/{hash}`

### ✅ Phase 2: Backend Auth Enforcement (Complete)

- [x] Deploy auth-enabled API to EC2
  - Added `SUPABASE_JWT_SECRET` to `/etc/breakside/env`
  - Restart service
- [x] Protect write endpoints with auth dependencies
  - `POST /api/games/{game_id}/sync` → `require_game_team_coach`
  - `PUT /api/teams/{team_id}` → `require_team_coach`
  - `PUT/DELETE /api/players/{player_id}` → `require_player_edit_access`
  - All `DELETE` endpoints protected
- [x] Allow read endpoints for team members (`require_team_access`)
- [x] Allow public read for games via share hash (`GET /api/share/{hash}`)
- [x] Test: Unauthenticated requests return 401 (test_auth.py)
- [x] Test: Wrong team returns 403 (test_auth.py)
- [x] Auto-sync polling between browsers (10-second interval)
- [x] Player/Team attribute changes sync across devices

### ✅ Phase 3: Team Membership Management (Complete)

See [PHASE3_TEAM_MGMT_PLAN.md](PHASE3_TEAM_MGMT_PLAN.md) for full implementation details.

**Backend:**
- [x] Storage: `invite_storage.py` with 5-char human-friendly codes
- [x] API: `POST /api/teams/{team_id}/invites` - Create invite
  - Coach invites: single-use, 7-day default expiry
  - Viewer invites: multi-use, 30-day default expiry
- [x] API: `GET /api/teams/{team_id}/invites` - List team invites
- [x] API: `GET /api/invites/{code}/info` - Public invite preview
- [x] API: `POST /api/invites/{code}/redeem` - Redeem invite code
- [x] API: `DELETE /api/invites/{invite_id}` - Revoke invite
- [x] API: `GET /api/teams/{team_id}/members` - List team members
- [x] API: `DELETE /api/teams/{team_id}/members/{user_id}` - Remove member
- [x] Last-coach protection (cannot remove only coach)

**Landing Page:**
- [x] `/join/{code}` route with team preview
- [x] Sign in / Sign up integration
- [x] Automatic invite redemption after auth
- [x] Redirect to PWA after joining

**PWA:**
- [x] Team Settings screen (`teams/teamSettings.js`)
- [x] Member list with remove functionality
- [x] Invite creation for coach/viewer roles
- [x] Invite list with copy link and revoke
- [x] "Join a Team" manual code entry
- [x] Name field in signup forms (stored as displayName)
- [x] Clear local data on sign out (prevents data leaking between accounts)
- [x] PWA install prompt after first authentication
- [x] Redirect unauthenticated users to landing page
- [x] Version display on logo tap

---

### ✅ Phase 4: Game Controller State (Complete)

See [PHASE4_CONTROLLER_PLAN.md](PHASE4_CONTROLLER_PLAN.md) for full implementation details.

**Backend:**
- [x] In-memory controller state storage (`controller_storage.py`)
  - Thread-safe state management
  - Auto-expire stale claims (30 seconds without ping)
  - Auto-approve handoffs (5-second timeout)
- [x] API: `GET /api/games/{game_id}/controller` - Controller status
- [x] API: `POST /api/games/{game_id}/claim-active` - Request Active Coach
- [x] API: `POST /api/games/{game_id}/claim-line` - Request Line Coach
- [x] API: `POST /api/games/{game_id}/release` - Release role
- [x] API: `POST /api/games/{game_id}/handoff-response` - Accept/deny
- [x] API: `POST /api/games/{game_id}/ping` - Keep role alive
- [x] Comprehensive test suite (22 tests)

**Frontend:**
- [x] Controller state module (`game/controllerState.js`)
  - Role claiming and handoffs
  - Polling with adaptive intervals (2s active / 5s idle)
  - Permission checks (`canEditPlayByPlay`, `canEditLineup`)
  - UI stubs for Phase 6

---

### ✅ Phase 6: Handoff UI (Complete)

**Role Buttons (Sub-header):**
- [x] "Play-by-Play" and "Next Line" buttons below header
- [x] Role holder name displayed under role label
- [x] Tap to claim/request role
- [x] Role button display logic fixed (see below)

**Handoff Request Flow:**
- [x] Toast notification for requester: "Handoff request sent..."
  - Duration matches server timeout (10s configurable)
  - Auto-dismissed when result arrives
- [x] Toast notification for holder with Accept/Deny buttons
  - Animated countdown on Accept button (vertical drain)
  - Swipe-to-dismiss counts as Accept
  - Auto-accepts on timeout
- [x] Result notifications:
  - Requester sees "You are now [role]" (success) or "Handoff denied" (error)
  - Holder sees "Handoff accepted" or "Handoff denied"

**Server Integration:**
- [x] Server provides `expiresInSeconds` for accurate client countdown
- [x] Client polls for state changes at 2s (active) / 5s (idle)
- [x] Handoff timeout configurable via `HANDOFF_EXPIRY_SECONDS` (server)
- [x] Auto-assign roles to first coach who enters game

**Role Button Display (Fixed):**
- Server auto-assigns both roles to first coach who pings a game
- Client mirrors server state exactly:
  - Green / "You" — only if `roleHolder.userId === myUserId`
  - Orange / `<name>` — if someone else holds the role
  - Grey / "Available" — if role is truly unclaimed (after timeout)
- Role timeout: 30s without ping → role auto-releases (becomes claimable)

**Future optimization:**
- [ ] When only one coach is on the team, OR only one coach is actively polling:
  - Hide role buttons entirely (more room for panels)
  - That coach has full access regardless of server state

---

## Next Up

### 🔄 Phase 6b: In-Game UI Redesign

Replace current screen-based navigation with a **panel-based layout** for all in-game functionality.

**Implementation Strategy:**
- Create new `game/gameScreen.js` with full panel container
- Stub all panels with placeholder content + "Use Old Screen" fallback buttons
- Implement panels one-by-one, removing fallback buttons as each is completed
- Mobile-first design throughout
- This is a new major version (2.0) — no backward compatibility required during development

---

#### Panel Layout (top to bottom)

**1. Header Panel** ✅ (always visible, single line)
- [x] Hamburger menu (left)
- [x] Team logo (tap for version display)
- [x] Score display with team identity (icon OR symbol, tap to toggle)
- [x] Timer display with toggle button
  - **Game clock**: Total elapsed time, or countdown to cap if `roundEndTime` is set
    - Turns red and counts negative when cap reached
    - Cannot be paused
  - **Point timer**: Elapsed time during point (with urgency colors)
    - Pause/resume button for injuries, discussions, etc.
  - Small label below digits: "game" or "point"
- [x] New game fields: `gameDurationMinutes` (default 50), `roundEndTime` (optional override)

**2. Role Buttons Panel** (coaches only, viewers don't see this)
- [x] "Play-by-Play" and "Next Line" role claim buttons
- [x] Same styling as current sub-header implementation
- [ ] Fix display logic per "Role Button Display Fix" section above
- [ ] (Future) Hide panel entirely when single coach — defer until after handoff debugging

**3. "Play-by-Play" Panel** (resizable)
- [ ] Responsive Simple Mode layout:
  - **Minimum size**: Single row with "We Score", "They Score", "Key Play", `...` button
  - **Maximum size**: Full Simple Mode layout with all buttons visible
  - `...` menu reveals: Undo, Sub Players, Timeout
- [ ] **Sub Players** button opens modal dialog for mid-point injury substitutions
  - One-off player selection table (similar to line selection)
- [ ] Pull Dialog auto-popup for Active Coach at start of defensive points
- [ ] Panel states:
  - **Greyed out/disabled**: User is not Active Coach, OR game is between points
  - **Auto-minimize**: When point ends
  - **Auto-maximize**: When point starts, if user is Active Coach
- [ ] Key Play dialog still available for detailed event entry
- [ ] Offense/Defense possession screens deprecated (keep code, remove from main flow)

**4. "Select Next Line" Panel** (resizable)
- [ ] Replaces the separate Before Point Screen concept
- [ ] Panel content:
  - Player selection table (current roster, drag/tap to select)
  - **"Start Point (Offense/Defense)"** button appears when between points
- [ ] Panel states:
  - **Minimized to title bar**: No players selected yet
  - **Minimized to title bar + player names**: Some players selected
  - **Maximized**: Full player selection table visible
- [ ] Auto-behaviors:
  - **Active Coach**: Auto-minimize when point starts, auto-maximize when point ends
  - **Line Coach**: Stays maximized during points (their main job)
  - **Both roles held**: Full access, both panels can be open during point
- [ ] **O/D button** (disabled for Phase 6b, implemented later):
  - Creates second line selection panel
  - Retitles to "Select Next O Line" and "Select Next D Line"
- [ ] **Between points**: Both Active Coach and Line Coach can edit lineup
  - Toast warning about possible conflicts when both are editing
- [ ] **During point**: Only Line Coach can edit (preparing next lineup)

**5. "Game Events" Modal** (accessed from Play-by-Play panel)
- [ ] Triggered by "Game Events" button in Play-by-Play panel (add to `...` menu or dedicated button)
- [ ] Modal popup with buttons: End Game, Time Out, Half Time, Switch Sides
- [ ] **Time Out**: Available during AND between points
- [ ] **End Game, Half Time, Switch Sides**: Only available between points
- [ ] Active Coach only
- [ ] Half Time / Switch Sides just log events (no special behavior for now)

**6. "Game Log" Panel** (resizable, bottom of stack)
- [ ] Game status: Team names, opponent, current score
- [ ] Game event log: Large font, scrollable, full event history
- [ ] Gets remaining vertical space after other panels
- [ ] Default states:
  - **Maximized**: For Viewers (only panel they see besides header)
  - **Maximized**: For Coaches without Active or Line Coach role
  - **Minimized**: For Active/Line Coach (but always accessible)

---

#### Panel Mechanics

- [x] **Resize**: Drag entire title bar up/down (draggable panels only)
  - "Shoving" behavior: dragging into another panel pushes it too
  - Bottom panel clamped to screen edge
- [x] **Chevron button**: Toggle individual panel minimize/expand
- [x] **Double-tap title bar**: Full-screen maximize
  - Minimizes all other resizable panels
  - Double-tap again restores all panels to previous state
  - Smooth 0.25s animated transitions
- [x] **Space allocation**: 
  - Game Log panel (bottom) gets remaining space, snaps to bottom when minimized
- [x] **Persistence**: Panel sizes saved to localStorage (per-client)

---

#### Role-Based Behavior Summary

| Role | Play-by-Play | Select Next Line | Game Events Modal | Game Log |
|------|--------------|------------------|-------------------|----------|
| **Active Coach** | Full access | Edit between points | Full access | Available |
| **Line Coach** | View only | Edit anytime | View only | Available |
| **Both roles** | Full access | Edit anytime | Full access | Available |
| **Coach (no role)** | Disabled | Disabled | Disabled | Maximized |
| **Viewer** | Hidden | Hidden | Hidden | Maximized |

---

---

#### Implementation Order

**Step 1: Panel Container Foundation** ✅
- [x] Create `game/gameScreen.js` with panel container system
- [x] Create `ui/panelSystem.js` for resize/min-max logic
- [x] CSS for mobile-first panel stack with drag handles
- [x] Stub panels with placeholder content (4 panels: Header, Role Buttons, Play-by-Play, Select Line, Game Log)
- [x] Each stub has "Use Old Screen →" button linking to legacy screen
- [x] Wire up as new entry point when game starts
- [x] Draggable title bars for panel resizing (full title bar is drag surface)
- [x] Height-based minimize/maximize (no separate CSS states)
- [x] Game Log panel snaps to bottom when minimized
- [x] Chevron button toggles individual panel min/max
- [x] Double-tap for full-screen maximize with restore
- [x] Smooth animated transitions (0.25s)
- [x] Compact title bars for more content space
- [x] Hide legacy screens when panel UI is active

**Step 2: Header Panel** ✅
- [x] Port existing header (hamburger, logo, score)
- [x] Smart score display with team identity:
  - New optional Team fields: `teamSymbol` (4-char max), `iconUrl` (data URL to PNG)
  - Display shows icon OR symbol (tap to toggle between them)
  - Fallback priority: icon > symbol > short name (≤6 chars) > "Us"/"Them"
  - Opponent uses same large font as team symbol
- [x] Add timer toggle (game clock ↔ point timer)
- [x] Add pause/resume for point timer
- [x] New game fields: `gameDurationMinutes`, `roundEndTime`
- [x] Red negative countdown when cap time exceeded
- [x] Logo tap shows version/build for 3 seconds
- [x] **Team Settings UI**: Team Identity section for setting symbol and icon
  - Server-side image proxy (`POST /api/proxy-image`) to bypass CORS
  - Fetches, resizes to 256×256 max, returns as base64 data URL
  - Icon cached locally for offline use

**Step 3: Role Buttons Panel** ✅
- [x] Port existing role buttons from sub-header
- [x] Ensure handoff flow still works
- [x] Hide legacy role buttons when panel UI is active
- [x] Fix display logic (first coach auto-assigned, mirror server state)
- [ ] (Future) Hide panel for single-coach case

**Step 4: Game Log Panel** ✅
- [x] Game status display (teams, score)
- [x] Large scrollable event log
- [x] Remove "Use Old Screen" button when complete (no stub, real content)

**Step 5: Play-by-Play Panel**
- [x] Responsive Simple Mode layout
  - Full (>500px): Large square buttons, wrapped text, evenly spaced vertically
  - Expanded (350-500px): Wide horizontal buttons stacked vertically
  - Medium-tall (200-350px): Two rows, tall buttons with wrapped text
  - Medium (120-200px): Two rows, shorter buttons with single-line text
  - Compact (<120px): Single row with `...` more button
- [x] We Score / They Score / Key Play buttons (icons hidden, text-only)
- [x] `...` more button expands panel to show action row
- [x] **Game Events modal** (End Game, Timeout, Half Time, Switch Sides)
  - Triggered by Events button in action row
  - **Timeout**: available during AND between points
  - **End Game, Half Time, Switch Sides**: only between points
  - Active Coach only
- [x] Wire up score buttons to existing scoring logic
- [ ] Sub Players modal for mid-point injury subs
- [ ] Pull dialog auto-popup (defensive point start)
- [x] Key Play dialog integration
- [x] Undo functionality
- [x] Auto-resize on point start/end
- [ ] Remove "Use Old Screen" button when complete

**Step 6: Select Next Line Panel**
- [ ] Player selection table (port from Before Point Screen)
- [ ] Start Point (Offense/Defense) button
- [ ] Minimize to title bar / player names / full table
- [ ] Role-based enable/disable (Active vs Line Coach)
- [ ] Conflict warning toast when both coaches edit
- [ ] Auto-resize behaviors
- [ ] Remove "Use Old Screen" button when complete
- [ ] O/D button (disabled placeholder for future)

**Step 7: Cleanup**
- [ ] Remove legacy screen navigation for in-game screens
- [ ] Update version to 2.0.0
- [ ] Update ARCHITECTURE.md with new panel system

---

#### Future: O/D Line Selection (Phase 7+)
- [ ] O/D button splits "Select Next Line" into two panels
- [ ] "Select Next O Line" — prepare offensive lineup
- [ ] "Select Next D Line" — prepare defensive lineup
- [ ] "Start Point" button appears in appropriate panel based on possession

### 🔄 Phase 5: Multi-User Game Sync

**Game State Synchronization:**
- [ ] API: `GET /api/games/{game_id}/poll?since={version}` - Optimized poll
  - Return game state only if version changed
  - Always return controller status
  - Return pending handoff requests
- [ ] PWA: Poll loop with role-based intervals
  - Active/Line Coach: 2 seconds
  - Idle Coach: 3 seconds  
  - Viewer: 5 seconds
- [ ] PWA: Update UI when remote changes detected
- [ ] PWA: Merge lineup changes from other coaches

**Conflict Resolution:**
- [ ] Server tracks game version number (increments on each save)
- [ ] Client sends version number with sync requests
- [ ] Server detects when client has stale data
- [ ] Conflict resolution strategy: latest-wins with notification
  - If server version is newer, return updated state and flag "stale"
  - Client shows toast: "Game updated by another coach" and refreshes
- [ ] Optionally: event-level conflict resolution (merge non-overlapping events)

**Auto-Join Active Games:**
- [ ] API: `GET /api/teams/{team_id}/active-game` - Get currently active game for a team
  - Returns game ID and basic info if a game is in progress
  - "In progress" = has points, no gameEndTimestamp, started within last 6 hours
- [ ] PWA: On team roster screen, show "Join Active Game" button if one exists
- [ ] PWA: Auto-join prompt when another coach starts/resumes a game
  - Toast notification: "[Coach] started a game vs [Opponent]. Join?"
  - Tap to enter game screen for that game
- [ ] Consider WebSocket for instant notifications (future enhancement)

**Improve Game Discovery UI:**
- [ ] Make it easier for coaches to find and join games in progress
  - Clear visual indicator when a game is active for the current team
  - Prominent "Join Game" button on roster screen
  - List of recent/active games accessible from team view
- [ ] Consider dedicated "Active Games" section or tab

### 👁️ Phase 7: Viewer Experience

- [ ] PWA: Read-only mode for Viewers
  - Hide event buttons
  - Show "Spectating" badge
  - Live-update as events come in
- [ ] PWA: Join game via URL (`/view/{game-hash}`)
- [ ] Landing page: List recent public games
- [ ] Viewer: Show live score and play-by-play

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
