# Phase 2: Backend Auth Enforcement - Implementation Plan

This document details the implementation plan for Phase 2 of multi-user support in Breakside.

**Related docs:**
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture and deployment
- [TODO.md](TODO.md) - Overall multi-user rollout roadmap

---

## Overview

Phase 2 enables authentication enforcement on the FastAPI backend, protecting write operations and implementing team-based access control.

### Key Outcomes

- ✅ Write endpoints require Coach access to the relevant team
- ✅ Read endpoints require team membership (Coach or Viewer)
- ✅ Public game viewing via revocable share links
- ✅ Unauthenticated requests return 401
- ✅ Unauthorized requests return 403
- ✅ Team creators automatically become Coaches

### Design Decisions

| Decision | Choice |
|----------|--------|
| Team ownership | Creator automatically becomes Coach |
| Player edit permissions | Any Coach of a team with that player on roster |
| Public game sharing | Revocable share links with hash, optional expiry |
| Share link URL format | `https://www.breakside.pro/share/{hash}` |
| Default share expiry | 7 days (configurable 1-365) |
| List endpoints (anonymous) | Return empty list, not 401 |
| Admin bootstrapping | Manual JSON file creation on server |
| Index rebuild | Requires admin access |

---

## Part 1: Fix Auth Dependencies

### 1.1 Fix Path Parameter Access Bug

**File:** `ultistats_server/auth/dependencies.py`

The current `require_team_coach` and `require_team_access` factories use `**path_params`, which doesn't work in FastAPI. Fix by using `Request.path_params`:

```python
from fastapi import Request

def require_team_coach(team_id_param: str = "team_id") -> Callable:
    async def dependency(
        request: Request,
        user: dict = Depends(get_current_user)
    ) -> dict:
        team_id = request.path_params.get(team_id_param)
        if not team_id:
            raise HTTPException(status_code=400, detail=f"Missing: {team_id_param}")
        
        # Admin bypass
        if user_exists(user["id"]):
            user_data = get_user(user["id"])
            if user_data.get("isAdmin", False):
                return user
        
        # Check team membership
        role = get_user_team_role(user["id"], team_id)
        if role != "coach":
            raise HTTPException(status_code=403, detail="Coach access required")
        
        return user
        
    return dependency
```

### 1.2 Create Game-Aware Auth Dependencies

Games reference teams via `teamId` in their data, not in the URL path. Create specialized dependencies:

```python
async def require_game_team_coach(
    request: Request,
    user: dict = Depends(get_current_user)
) -> dict:
    """
    For game write endpoints. Looks up teamId from:
    1. Existing game (if it exists)
    2. Request body (for new games being synced)
    """
    game_id = request.path_params.get("game_id")
    
    # Check existing game first
    if game_exists(game_id):
        game_data = get_game_current(game_id)
        team_id = game_data.get("teamId")
    else:
        # New game - check request body
        body = await request.json()
        team_id = body.get("teamId")
    
    if not team_id:
        raise HTTPException(400, "Game must have teamId")
    
    # Admin bypass
    if is_admin(user["id"]):
        return user
    
    # Verify coach access
    role = get_user_team_role(user["id"], team_id)
    if role != "coach":
        raise HTTPException(403, "Coach access required for this team")
    
    return user


async def require_game_team_access(
    request: Request,
    user: dict = Depends(get_current_user)
) -> dict:
    """
    For game read endpoints. Requires Coach or Viewer access.
    """
    game_id = request.path_params.get("game_id")
    
    if not game_exists(game_id):
        raise HTTPException(404, f"Game {game_id} not found")
    
    game_data = get_game_current(game_id)
    team_id = game_data.get("teamId")
    
    if not team_id:
        raise HTTPException(400, "Game has no teamId")
    
    # Admin bypass
    if is_admin(user["id"]):
        return user
    
    # Verify any team access
    role = get_user_team_role(user["id"], team_id)
    if role is None:
        raise HTTPException(403, "You don't have access to this team")
    
    return user
```

### 1.3 Create Player Auth Dependency

```python
async def require_player_edit_access(
    request: Request,
    user: dict = Depends(get_current_user)
) -> dict:
    """
    Verify user is a Coach of at least one team that has this player.
    """
    player_id = request.path_params.get("player_id")
    
    # Admin bypass
    if is_admin(user["id"]):
        return user
    
    # Get teams this player belongs to (from index)
    player_teams = get_player_teams(player_id)
    
    # Get teams user is a Coach of
    user_memberships = get_user_memberships(user["id"])
    user_coach_teams = [m["teamId"] for m in user_memberships if m["role"] == "coach"]
    
    # Check overlap
    if not set(player_teams) & set(user_coach_teams):
        raise HTTPException(403, "You must be a Coach of a team with this player")
    
    return user
```

### 1.4 Admin Check Helper

```python
def is_admin(user_id: str) -> bool:
    """Check if a user is an admin."""
    if not user_exists(user_id):
        return False
    user_data = get_user(user_id)
    return user_data.get("isAdmin", False)
```

---

## Part 2: Auto-Create Membership on Team Creation

**File:** `ultistats_server/main.py`

Modify `POST /api/teams` to create a Coach membership for the authenticated user:

```python
@app.post("/api/teams")
async def create_team(
    team_data: Dict[str, Any] = Body(...),
    user: Optional[dict] = Depends(get_optional_user)
):
    if "name" not in team_data:
        raise HTTPException(status_code=400, detail="Team name is required")
    
    provided_id = team_data.get('id')
    
    # If ID exists, this is an update/sync
    if provided_id and team_exists(provided_id):
        update_team(provided_id, team_data)
        return {"status": "updated", "team_id": provided_id, "team": get_team(provided_id)}
    
    # Create new team
    team_id = save_team(team_data, provided_id)
    
    # If authenticated, make creator a Coach
    if user:
        try:
            create_membership(
                team_id=team_id,
                user_id=user["id"],
                role="coach",
                invited_by=None  # Creator, not invited
            )
        except ValueError:
            pass  # Membership already exists
    
    return {"status": "created", "team_id": team_id, "team": get_team(team_id)}
```

---

## Part 3: Game Share Links

### 3.1 Data Model

**New file:** `ultistats_server/storage/share_storage.py`

Share link structure:
```json
{
    "id": "share_abc123def456",
    "gameId": "2025-12-07_Sample-Team_vs_Bad-Guys_...",
    "hash": "a8f3e2b1c9d4",
    "teamId": "Sample-Team-7y0n",
    "createdBy": "user-uuid",
    "createdAt": "2025-01-15T10:00:00Z",
    "expiresAt": "2025-01-22T10:00:00Z",
    "revokedAt": null,
    "revokedBy": null
}
```

Index file (`_index.json`) for fast lookups:
```json
{
  "byHash": {
    "a8f3e2b1c9d4": "share_abc123def456"
  },
  "byGame": {
    "game-id-here": ["share_abc123def456"]
  }
}
```

### 3.2 Storage Functions

```python
def create_share_link(
    game_id: str, 
    team_id: str, 
    created_by: str, 
    expires_days: int = 7
) -> dict:
    """Create a new share link for a game."""

def get_share_by_hash(hash: str) -> Optional[dict]:
    """Look up share link by hash."""

def get_share_by_id(share_id: str) -> Optional[dict]:
    """Look up share link by ID."""

def list_game_shares(game_id: str) -> List[dict]:
    """List all share links for a game (including revoked)."""

def revoke_share(share_id: str, revoked_by: str) -> bool:
    """Revoke a share link. Returns True if found and revoked."""

def is_share_valid(share: dict) -> bool:
    """Check if share is not expired and not revoked."""
```

### 3.3 API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/games/{game_id}/share` | Coach | Create share link |
| `GET` | `/api/games/{game_id}/shares` | Coach | List share links |
| `DELETE` | `/api/shares/{share_id}` | Coach/Admin | Revoke share link |
| `GET` | `/api/share/{hash}` | None | Get game via share link |

**Create share link:**
```python
@app.post("/api/games/{game_id}/share")
async def create_game_share(
    game_id: str,
    expires_days: int = Query(default=7, ge=1, le=365),
    user: dict = Depends(require_game_team_coach)
):
    if not game_exists(game_id):
        raise HTTPException(404, f"Game {game_id} not found")
    
    game = get_game_current(game_id)
    share = create_share_link(
        game_id=game_id,
        team_id=game["teamId"],
        created_by=user["id"],
        expires_days=expires_days
    )
    
    return {
        "share": share,
        "url": f"https://www.breakside.pro/share/{share['hash']}"
    }
```

**List share links:**
```python
@app.get("/api/games/{game_id}/shares")
async def list_game_shares_endpoint(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    if not game_exists(game_id):
        raise HTTPException(404, f"Game {game_id} not found")
    
    shares = list_game_shares(game_id)
    return {"shares": shares, "count": len(shares)}
```

**Revoke share link:**
```python
@app.delete("/api/shares/{share_id}")
async def revoke_share_endpoint(
    share_id: str,
    user: dict = Depends(get_current_user)
):
    share = get_share_by_id(share_id)
    if not share:
        raise HTTPException(404, "Share link not found")
    
    # Must be admin or coach of the team
    if not is_admin(user["id"]):
        role = get_user_team_role(user["id"], share["teamId"])
        if role != "coach":
            raise HTTPException(403, "Coach access required")
    
    revoke_share(share_id, user["id"])
    return {"status": "revoked", "share_id": share_id}
```

**Public game access:**
```python
@app.get("/api/share/{hash}")
async def get_game_by_share(hash: str):
    """Public endpoint - no auth required."""
    share = get_share_by_hash(hash)
    
    if not share:
        raise HTTPException(404, "Share link not found")
    
    if not is_share_valid(share):
        raise HTTPException(410, "Share link has expired or been revoked")
    
    if not game_exists(share["gameId"]):
        raise HTTPException(404, "Game not found")
    
    game = get_game_current(share["gameId"])
    return {
        "game": game,
        "shareInfo": {
            "expiresAt": share["expiresAt"],
            "createdAt": share["createdAt"]
        }
    }
```

---

## Part 4: Apply Auth to Existing Endpoints

### 4.1 Write Endpoints (Require Coach)

| Endpoint | Dependency | Notes |
|----------|------------|-------|
| `POST /api/games/{game_id}/sync` | `require_game_team_coach` | Look up teamId from game/body |
| `DELETE /api/games/{game_id}` | `require_game_team_coach` | |
| `POST /api/games/{game_id}/restore/{ts}` | `require_game_team_coach` | |
| `PUT /api/teams/{team_id}` | `require_team_coach` | |
| `DELETE /api/teams/{team_id}` | `require_team_coach` | |
| `POST /api/players` | `get_current_user` | Any authenticated user can create |
| `PUT /api/players/{player_id}` | `require_player_edit_access` | Coach of team with player |
| `DELETE /api/players/{player_id}` | `require_player_edit_access` | |
| `POST /api/index/rebuild` | `require_admin` | |

### 4.2 Read Endpoints (Require Team Access)

| Endpoint | Dependency | Notes |
|----------|------------|-------|
| `GET /api/games/{game_id}` | `require_game_team_access` | |
| `GET /api/games/{game_id}/versions` | `require_game_team_access` | |
| `GET /api/games/{game_id}/versions/{ts}` | `require_game_team_access` | |
| `GET /api/teams/{team_id}` | `require_team_access` | |
| `GET /api/teams/{team_id}/players` | `require_team_access` | |
| `GET /api/teams/{team_id}/games` | `require_team_access` | |

### 4.3 List Endpoints (Filter by Access)

| Endpoint | Behavior |
|----------|----------|
| `GET /api/games` | Return only games for teams user has access to; empty if anonymous |
| `GET /api/teams` | Return only teams user has access to; empty if anonymous |

```python
@app.get("/api/games")
async def list_games(user: Optional[dict] = Depends(get_optional_user)):
    all_games = list_all_games()
    
    if not user:
        return {"games": [], "count": 0}
    
    # Admin sees all
    if is_admin(user["id"]):
        return {"games": all_games, "count": len(all_games)}
    
    # Filter to accessible teams
    accessible_teams = set(get_user_teams(user["id"]))
    filtered = [g for g in all_games if g.get("teamId") in accessible_teams]
    
    return {"games": filtered, "count": len(filtered)}
```

### 4.4 Open Endpoints (No Auth Required)

| Endpoint | Notes |
|----------|-------|
| `GET /health` | Health check |
| `GET /api` | API info |
| `GET /api/share/{hash}` | Public via share link |
| `GET /api/players` | World-readable player list |
| `GET /api/players/{id}` | World-readable player details |
| `GET /api/players/{id}/games` | World-readable |
| `GET /api/players/{id}/teams` | World-readable |

### 4.5 Already Protected

| Endpoint | Notes |
|----------|-------|
| `GET /api/auth/me` | Requires valid JWT |
| `PATCH /api/auth/me` | Requires valid JWT |
| `GET /api/auth/teams` | Requires valid JWT |

---

## Part 5: Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `ultistats_server/auth/dependencies.py` | **Modify** | Fix path param bug, add game/player dependencies |
| `ultistats_server/storage/share_storage.py` | **Create** | Share link CRUD operations |
| `ultistats_server/storage/__init__.py` | **Modify** | Export share functions |
| `ultistats_server/main.py` | **Modify** | Add auth dependencies, add share endpoints |
| `ultistats_server/config.py` | **Modify** | Add `SHARES_DIR` |
| `ultistats_server/test_auth.py` | **Modify** | Add comprehensive auth tests |

---

## Part 6: Testing Plan

### 6.1 Unit Tests

```python
class TestTeamAuth:
    def test_create_team_creates_membership(self):
        """Creating a team makes the creator a Coach."""
        
    def test_update_team_requires_coach(self):
        """PUT /api/teams/{id} returns 403 for non-coach."""
        
    def test_update_team_allows_coach(self):
        """PUT /api/teams/{id} succeeds for coach."""
        
    def test_delete_team_requires_coach(self):
        """DELETE /api/teams/{id} returns 403 for viewer."""


class TestGameAuth:
    def test_sync_game_requires_team_coach(self):
        """POST /api/games/{id}/sync returns 403 for wrong team."""
        
    def test_sync_game_allows_coach(self):
        """POST /api/games/{id}/sync succeeds for team coach."""
        
    def test_get_game_requires_team_access(self):
        """GET /api/games/{id} returns 403 without team access."""
        
    def test_get_game_allows_viewer(self):
        """GET /api/games/{id} succeeds for team viewer."""


class TestShareLinks:
    def test_create_share_requires_coach(self):
        """POST /api/games/{id}/share returns 403 for viewer."""
        
    def test_share_link_provides_access(self):
        """GET /api/share/{hash} returns game without auth."""
        
    def test_expired_share_returns_410(self):
        """Expired share links return 410 Gone."""
        
    def test_revoked_share_returns_410(self):
        """Revoked share links return 410 Gone."""


class TestPlayerAuth:
    def test_edit_player_requires_roster_membership(self):
        """PUT /api/players/{id} returns 403 if player not on user's teams."""
        
    def test_edit_player_allows_coach_with_player(self):
        """PUT /api/players/{id} succeeds if coach of team with player."""


class TestAdminAuth:
    def test_index_rebuild_requires_admin(self):
        """POST /api/index/rebuild returns 403 for non-admin."""
        
    def test_admin_can_access_any_team(self):
        """Admin bypasses team membership checks."""


class TestListEndpoints:
    def test_list_games_anonymous_returns_empty(self):
        """GET /api/games returns empty list for anonymous user."""
        
    def test_list_games_filters_by_access(self):
        """GET /api/games returns only accessible games."""
        
    def test_list_teams_anonymous_returns_empty(self):
        """GET /api/teams returns empty list for anonymous user."""
```

### 6.2 Integration Tests

- [ ] PWA login flow → API calls include token
- [ ] PWA handles 401 → redirects to login
- [ ] PWA handles 403 → shows error message
- [ ] Sync works for authenticated coach
- [ ] Share link URL works without authentication

---

## Part 7: Deployment

### 7.1 Pre-Deployment Checklist

- [ ] All tests pass locally with `AUTH_REQUIRED=true`
- [ ] Legacy CUDO games have `teamId` field
- [ ] Admin user JSON file created on EC2

### 7.2 EC2 Configuration

Add to `/etc/breakside/env`:
```bash
SUPABASE_JWT_SECRET=your-jwt-secret-from-supabase
ULTISTATS_AUTH_REQUIRED=true
```

Get JWT secret from: **Supabase Dashboard → Settings → API → JWT Secret**

### 7.3 Create Admin User

Create `/var/lib/breakside/data/users/{your-supabase-user-id}.json`:
```json
{
  "id": "your-supabase-user-id",
  "email": "you@example.com",
  "displayName": "Your Name",
  "isAdmin": true,
  "createdAt": "2025-01-15T00:00:00Z"
}
```

To find your Supabase user ID:
1. Log in to Breakside via the landing page
2. Check Supabase Dashboard → Authentication → Users
3. Copy the UUID for your email

### 7.4 Deployment Commands

```bash
# SSH to EC2
ssh -i ~/.ssh/your-key.pem ec2-user@3.212.138.180

# Pull latest code
cd /opt/breakside
sudo git pull

# Verify env file has new variables
sudo cat /etc/breakside/env

# Restart service
sudo systemctl restart breakside

# Check logs
sudo journalctl -u breakside -f

# Verify endpoints
curl https://api.breakside.pro/health
curl https://api.breakside.pro/api/auth/me  # Should return 401
```

---

## Part 8: Implementation Order

| Step | Task | Est. Time |
|------|------|-----------|
| 1 | Fix `dependencies.py` - path param bug | 15 min |
| 2 | Add `is_admin` helper to dependencies | 5 min |
| 3 | Add game-aware auth dependencies | 20 min |
| 4 | Add player-edit auth dependency | 15 min |
| 5 | Create `config.py` - add SHARES_DIR | 5 min |
| 6 | Create `share_storage.py` | 45 min |
| 7 | Update `storage/__init__.py` exports | 5 min |
| 8 | Add share endpoints to `main.py` | 30 min |
| 9 | Auto-create membership on team creation | 10 min |
| 10 | Apply auth to write endpoints | 20 min |
| 11 | Apply auth to read endpoints | 15 min |
| 12 | Add admin requirement to index rebuild | 5 min |
| 13 | Filter list endpoints by access | 15 min |
| 14 | Write/update tests | 45 min |
| 15 | Verify legacy CUDO games have teamId | 10 min |
| 16 | Deploy to EC2 | 20 min |

**Total estimated time: ~4.5 hours**

---

## Appendix: Frontend Considerations

The PWA should already handle auth tokens via `auth/auth.js`. Verify:

1. **Token inclusion**: All fetch calls to `/api/*` include `Authorization: Bearer {token}`
2. **401 handling**: Redirect to login page or show "session expired" message
3. **403 handling**: Show "access denied" toast/message
4. **Share links**: `/share/{hash}` route in PWA that calls `GET /api/share/{hash}`

These are verified/implemented as part of integration testing, not in this phase's scope.

