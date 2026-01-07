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
  - Green when user holds that role
  - Light orange when another coach holds it
  - Grey when role is available
  - Tap to claim/request role
- [x] Role holder name displayed under role label

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

**1. Header Panel** (always visible, single line)
- [ ] Hamburger menu (left)
- [ ] Team logo
- [ ] Score display (Us vs Them)
- [ ] Timer display with toggle button
  - **Game clock**: Total elapsed time, or countdown to cap if `roundEndTime` is set
    - Turns red and counts negative when cap reached
    - Cannot be paused
  - **Point timer**: Countdown between points (with urgency colors), elapsed time during point
    - Pause/resume button for injuries, discussions, etc.
    - Auto-unpauses when any play-by-play event is recorded
  - Small label below digits: "game" or "point"
- [ ] New game fields: `gameDurationMinutes` (default 50), `roundEndTime` (optional override)

**2. Role Buttons Panel** (coaches only, viewers don't see this)
- [ ] "Play-by-Play" and "Next Line" role claim buttons
- [ ] Same styling as current sub-header implementation

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
  - **Auto-minimize**: When point ends (unless pinned)
  - **Auto-maximize**: When point starts, if user is Active Coach (unless pinned)
- [ ] Pin button in title bar to lock panel size
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
- [ ] Pin button to lock panel size
- [ ] **O/D button** (disabled for Phase 6b, implemented later):
  - Creates second line selection panel
  - Retitles to "Select Next O Line" and "Select Next D Line"
- [ ] **Between points**: Both Active Coach and Line Coach can edit lineup
  - Toast warning about possible conflicts when both are editing
- [ ] **During point**: Only Line Coach can edit (preparing next lineup)

**5. "Game Events" Panel** (resizable)
- [ ] Buttons: End Game, Time Out, Half Time, Switch Sides
- [ ] Responsive layout:
  - **Minimum**: Single row with some buttons + `...` menu
  - **Maximum**: Two rows (enough for all buttons)
- [ ] Panel states:
  - **Minimized and disabled**: During points
  - **Unminimized and enabled**: Between points, for Active Coach only
- [ ] Half Time / Switch Sides just log events (no special behavior for now)

**6. "Follow" Panel** (resizable, bottom of stack)
- [ ] Game status: Team names, opponent, current score
- [ ] Game event log: Large font, scrollable, full event history
- [ ] Gets remaining vertical space after other panels
- [ ] Default states:
  - **Maximized**: For Viewers (only panel they see besides header)
  - **Maximized**: For Coaches without Active or Line Coach role
  - **Minimized**: For Active/Line Coach (but always accessible)
- [ ] Pin button to lock panel size

---

#### Panel Mechanics

- [ ] **Resize**: Drag handle on left side of title bar
- [ ] **Toggle min/max**: Double-tap title bar
- [ ] **Pin button**: Lock panel to current size (survives auto-resize behaviors)
- [ ] **Space allocation**: 
  - Maximizing a panel minimizes all non-pinned panels
  - Pinned panels keep their size but may shift position
  - Follow panel (bottom) gets whatever space remains
- [ ] **Persistence**: Panel sizes and pin states saved to localStorage (per-client)

---

#### Role-Based Behavior Summary

| Role | Play-by-Play | Select Next Line | Game Events | Follow |
|------|--------------|------------------|-------------|--------|
| **Active Coach** | Full access | Edit between points | Full access | Available |
| **Line Coach** | View only | Edit anytime | View only | Available |
| **Both roles** | Full access | Edit anytime | Full access | Available |
| **Coach (no role)** | Disabled | Disabled | Disabled | Maximized |
| **Viewer** | Hidden | Hidden | Hidden | Maximized |

---

---

#### Implementation Order

**Step 1: Panel Container Foundation**
- [ ] Create `game/gameScreen.js` with panel container system
- [ ] Create `ui/panelSystem.js` for resize/pin/min-max logic
- [ ] CSS for mobile-first panel stack with drag handles
- [ ] Stub all 6 panels with placeholder content
- [ ] Each stub has "Use Old Screen →" button linking to legacy screen
- [ ] Wire up as new entry point when game starts

**Step 2: Header Panel**
- [ ] Port existing header (hamburger, logo, score)
- [ ] Add timer toggle (game clock ↔ point timer)
- [ ] Add pause/resume for point timer
- [ ] New fields: `gameDurationMinutes`, `roundEndTime`
- [ ] Red negative countdown when cap time exceeded

**Step 3: Role Buttons Panel**
- [ ] Port existing role buttons from sub-header
- [ ] Ensure handoff flow still works

**Step 4: Follow Panel**
- [ ] Game status display (teams, score)
- [ ] Large scrollable event log
- [ ] Remove "Use Old Screen" button when complete

**Step 5: Game Events Panel**
- [ ] End Game, Timeout, Half Time, Switch Sides buttons
- [ ] Responsive 1-row/2-row layout with `...` menu
- [ ] Enable/disable based on game state and role
- [ ] Remove "Use Old Screen" button when complete

**Step 6: Play-by-Play Panel**
- [ ] Responsive Simple Mode layout
- [ ] We Score / They Score / Key Play / `...`
- [ ] Sub Players modal for mid-point injury subs
- [ ] Pull dialog auto-popup (defensive point start)
- [ ] Key Play dialog integration
- [ ] Undo functionality
- [ ] Auto-resize on point start/end
- [ ] Remove "Use Old Screen" button when complete

**Step 7: Select Next Line Panel**
- [ ] Player selection table (port from Before Point Screen)
- [ ] Start Point (Offense/Defense) button
- [ ] Minimize to title bar / player names / full table
- [ ] Role-based enable/disable (Active vs Line Coach)
- [ ] Conflict warning toast when both coaches edit
- [ ] Auto-resize behaviors
- [ ] Remove "Use Old Screen" button when complete
- [ ] O/D button (disabled placeholder for future)

**Step 8: Cleanup**
- [ ] Remove legacy screen navigation for in-game screens
- [ ] Update version to 2.0.0
- [ ] Update ARCHITECTURE.md with new panel system

---

#### Future: O/D Line Selection (Phase 7+)
- [ ] O/D button splits "Select Next Line" into two panels
- [ ] "Select Next O Line" — prepare offensive lineup
- [ ] "Select Next D Line" — prepare defensive lineup
- [ ] "Start Point" button appears in appropriate panel based on possession

### 🔄 Phase 5: Multi-User Polling

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
