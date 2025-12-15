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

---

## Next Up

### 🔄 Phase 2: Backend Auth Enforcement

Enable `AUTH_REQUIRED=true` on EC2 and enforce permissions.

- [ ] Deploy auth-enabled API to EC2
  - Add `SUPABASE_JWT_SECRET` to `/etc/breakside/env`
  - Set `AUTH_REQUIRED=true`
  - Restart service
- [ ] Protect write endpoints with `require_team_coach` dependency
  - `POST /api/games/{game_id}/sync`
  - `POST /api/teams/{team_id}/sync`
  - `POST /api/players/{player_id}/sync`
  - `DELETE` endpoints
- [ ] Allow read endpoints for team members (`require_team_access`)
- [ ] Allow public read for games via share hash (no auth)
- [ ] Test: Unauthenticated requests return 401
- [ ] Test: Wrong team returns 403

### 📋 Phase 3: Team Membership Management

- [ ] API: `POST /api/teams/{team_id}/invite` - Generate invite code
  - Coach invites: single-use, 7-day expiry
  - Viewer invites: multi-use, permanent
- [ ] API: `POST /api/invites/{code}/redeem` - Redeem invite code
- [ ] API: `GET /api/teams/{team_id}/members` - List team members
- [ ] API: `DELETE /api/teams/{team_id}/members/{user_id}` - Remove member
- [ ] API: `DELETE /api/invites/{code}` - Revoke invite
- [ ] Storage: Invite codes with expiry and usage tracking
- [ ] PWA: Team settings screen showing members
- [ ] PWA: Generate/display invite QR code and URL
- [ ] PWA: "Join Team" flow for new users

### 🎮 Phase 4: Game Controller State

- [ ] Data model: Add `controllerState` to game object
  - `activeCoach`: userId, claimedAt, lastPing
  - `lineCoach`: userId, claimedAt, lastPing
  - `pendingHandoff`: role, requesterId, requestedAt, expiresAt
- [ ] API: `GET /api/games/{game_id}/status` - Controller status
- [ ] API: `POST /api/games/{game_id}/claim-active` - Request Active Coach
- [ ] API: `POST /api/games/{game_id}/claim-line` - Request Line Coach
- [ ] API: `POST /api/games/{game_id}/release` - Release role
- [ ] API: `POST /api/games/{game_id}/handoff-response` - Accept/deny
- [ ] Auto-expire stale claims (no ping in 30 seconds)

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

- [ ] Google/Apple OAuth login
- [ ] Player ↔ User account linking
- [ ] Player self-service (edit own stats, profile photo)
- [ ] O-line / D-line presets with auto-promotion
- [ ] "Publish" games to make them searchable/discoverable
- [ ] WebSocket upgrade for real-time sync
- [ ] Git-based backup and version history
- [ ] Rate limiting and abuse prevention

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
# Deploy PWA to S3
aws s3 sync . s3://breakside.pro/ \
  --exclude ".git/*" \
  --exclude "ultistats_server/*" \
  --exclude "data/*" \
  --exclude "*.pyc" \
  --exclude "__pycache__/*" \
  --exclude ".DS_Store" \
  --exclude "*.m4a" \
  --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id E6M9KCXIU9CKD --paths "/*"

# Deploy API to EC2
ssh ec2-user@3.212.138.180
cd /opt/breakside && sudo git pull && sudo systemctl restart breakside
```

### Supabase Dashboard

- Project: https://mfuziqztsfqaqnnxjcrr.supabase.co
- Auth settings: Dashboard → Authentication → Settings
- User management: Dashboard → Authentication → Users
