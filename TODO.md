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

- [ ] PWA: Read-only mode for Viewers
  - Hide event buttons
  - Show "Spectating" badge
  - Live-update as events come in
- [ ] PWA: Join game via URL (`/view/{game-hash}`)
- [ ] Landing page: List recent public games
- [ ] Viewer: Show live score and play-by-play

---

## Backlog

- [x] **Feature**: When Active Coach ends game, all coaches/viewers navigate to game summary. *(Wake recovery + foreground 3-second refresh both detect `gameEndTimestamp` and navigate away.)*
- [ ] **To verify**: Test D line vs O line behavior with simultaneous selection. Define desired behavior when e.g. D line is selected but coach is viewing/editing O line.
- [ ] **Feature**: Checkbox in select-next-player table header to uncheck all players.
- [x] Hide role buttons when only one coach on team or only one coach polling (more room for panels).
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
