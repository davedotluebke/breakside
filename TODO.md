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

## Next Up

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

### 🎯 Phase 6: Handoff UI

- [ ] PWA: "Play-by-Play" and "Next Line" buttons in header
  - Green/checkmark when user has that role
  - Click to request role if not held
- [ ] PWA: Handoff confirmation panel
  - Replaces header when handoff requested
  - 5-second countdown with progress bar
  - Confirm/Deny buttons
  - Auto-confirm on timeout
- [ ] PWA: Toast notifications for handoff events
  - "You are now Active Coach"
  - "Line Coach role transferred to [name]"
  - "Your handoff request was denied"
- [ ] PWA: Modal when lineup promoted to current
  - Informs Line Coach their prepared lineup is now active

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
