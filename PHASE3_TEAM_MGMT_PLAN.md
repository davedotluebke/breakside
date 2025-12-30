# Phase 3: Team Membership Management - Implementation Plan

This document details the implementation plan for Phase 3 of multi-user support in Breakside.

**Related docs:**
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture and deployment
- [TODO.md](TODO.md) - Overall multi-user rollout roadmap
- [PHASE2_AUTH_PLAN.md](PHASE2_AUTH_PLAN.md) - Previous phase (auth enforcement)

---

## Overview

Phase 3 enables coaches to invite others to their teams and manage team membership. This includes generating invite codes, redeeming invites via a landing page flow, and a new Team Settings UI in the PWA.

### Key Outcomes

- Coaches can generate invite codes for other coaches or viewers
- Invite codes are short and easy to type/share verbally
- Landing page handles invite redemption with team preview
- PWA has "Enter Invite Code" for manual code entry
- New Team Settings screen shows members and invites
- Coaches can remove other members (with last-coach protection)

### Design Decisions

| Decision | Choice |
|----------|--------|
| Invite code format | 5 characters, human-friendly alphabet |
| Coach invites | Single-use, 7-day default expiry (1-365 configurable) |
| Viewer invites | Multi-use, 30-day default expiry (configurable) |
| Invite URL structure | `https://www.breakside.pro/join/{code}` |
| Redemption flow | Landing page (not PWA) handles URL-based redemption |
| PWA code entry | Team Settings → "Join a Team" → Enter code manually |
| Member removal | Any coach can remove any member (including other coaches) |
| Last coach protection | Cannot remove yourself if you're the only coach |
| QR codes | Deferred to future phase |

---

## Part 1: Invite Code Data Model

### 1.1 Invite Code Format

Use a 5-character code with a human-friendly alphabet that avoids confusing characters:

```
Alphabet: 23456789ABCDEFGHJKLMNPQRSTUVWXYZ (32 characters)
Excluded: 0, O, 1, I, L (easily confused)
```

Examples: `X7K2M`, `3NQRT`, `VWC8H`

With 32^5 = ~33 million combinations and short expiration windows, collisions are not a concern.

### 1.2 Invite Data Structure

**New file:** `ultistats_server/storage/invite_storage.py`

```json
{
  "id": "inv_abc123def456",
  "code": "X7K2M",
  "teamId": "Sample-Team-b2c4",
  "role": "coach",
  "createdBy": "user-uuid",
  "createdAt": "2025-01-15T10:00:00Z",
  "expiresAt": "2025-01-22T10:00:00Z",
  "maxUses": 1,
  "uses": 0,
  "usedBy": [
    {"userId": "user-xyz", "usedAt": "2025-01-16T14:30:00Z"}
  ],
  "revokedAt": null,
  "revokedBy": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Internal ID (`inv_` prefix + 12 hex chars) |
| `code` | string | 6-char human-readable code for sharing |
| `teamId` | string | Team this invite is for |
| `role` | string | `"coach"` or `"viewer"` |
| `createdBy` | string | User ID who created the invite |
| `createdAt` | string | ISO timestamp |
| `expiresAt` | string \| null | ISO timestamp (default: 7 days for coach, 30 days for viewer) |
| `maxUses` | number \| null | Max redemptions, null = unlimited |
| `uses` | number | Current redemption count |
| `usedBy` | array | List of {userId, usedAt} for audit trail |
| `revokedAt` | string \| null | ISO timestamp if revoked |
| `revokedBy` | string \| null | User ID who revoked |

### 1.3 Invite Index Structure

**File:** `data/invites/_index.json`

```json
{
  "byCode": {
    "X7K2MP": "inv_abc123def456"
  },
  "byTeam": {
    "Sample-Team-b2c4": ["inv_abc123def456", "inv_def789ghi012"]
  }
}
```

### 1.4 Storage Functions

```python
def generate_invite_code() -> str:
    """Generate a 6-character human-friendly code."""

def create_invite(
    team_id: str,
    role: Literal["coach", "viewer"],
    created_by: str,
    expires_days: Optional[int] = None,
    max_uses: Optional[int] = None
) -> dict:
    """
    Create a new invite.
    
    For coach invites: max_uses defaults to 1, expires_days defaults to 7
    For viewer invites: max_uses defaults to None (unlimited), expires_days defaults to 30
    """

def get_invite(invite_id: str) -> Optional[dict]:
    """Get invite by internal ID."""

def get_invite_by_code(code: str) -> Optional[dict]:
    """Look up invite by shareable code (case-insensitive)."""

def list_team_invites(team_id: str) -> List[dict]:
    """List all invites for a team (including expired/revoked)."""

def is_invite_valid(invite: dict) -> bool:
    """Check if invite is not expired, not revoked, and not at max uses."""

def redeem_invite(code: str, user_id: str) -> dict:
    """
    Redeem an invite code.
    
    Returns: {"success": True, "membership": {...}} or {"success": False, "error": "..."}
    
    Side effects:
    - Creates membership for user on team
    - Increments uses count
    - Adds to usedBy array
    """

def revoke_invite(invite_id: str, revoked_by: str) -> bool:
    """Revoke an invite. Returns True if found and revoked."""

def rebuild_invite_index() -> dict:
    """Rebuild index from invite files."""
```

---

## Part 2: API Endpoints

### 2.1 Invite Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/teams/{team_id}/invites` | Coach | Create invite |
| `GET` | `/api/teams/{team_id}/invites` | Coach | List team invites |
| `DELETE` | `/api/invites/{invite_id}` | Coach | Revoke invite |

### 2.2 Invite Redemption

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/invites/{code}/info` | None | Get invite info (team name, role) for preview |
| `POST` | `/api/invites/{code}/redeem` | User | Redeem invite code |

### 2.3 Member Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/teams/{team_id}/members` | Team access | List team members |
| `DELETE` | `/api/teams/{team_id}/members/{user_id}` | Coach | Remove member |
| `PATCH` | `/api/teams/{team_id}/members/{user_id}` | Coach | Update member role |

### 2.4 Endpoint Implementations

#### Create Invite

```python
@app.post("/api/teams/{team_id}/invites")
async def create_team_invite(
    team_id: str,
    role: Literal["coach", "viewer"] = Body(...),
    expires_days: Optional[int] = Body(default=None, ge=1, le=365),
    user: dict = Depends(require_team_coach("team_id"))
):
    """
    Create an invite code for a team.
    
    Coach invites: single-use, default 7-day expiry
    Viewer invites: unlimited uses, default 30-day expiry
    """
    if not team_exists(team_id):
        raise HTTPException(404, f"Team {team_id} not found")
    
    # Set defaults based on role
    max_uses = 1 if role == "coach" else None
    default_expiry = 7 if role == "coach" else 30
    
    invite = create_invite(
        team_id=team_id,
        role=role,
        created_by=user["id"],
        expires_days=expires_days if expires_days is not None else default_expiry,
        max_uses=max_uses
    )
    
    return {
        "invite": invite,
        "url": f"https://www.breakside.pro/join/{invite['code']}",
        "code": invite["code"]  # Easy to copy
    }
```

#### Get Invite Info (Public Preview)

```python
@app.get("/api/invites/{code}/info")
async def get_invite_info(code: str):
    """
    Get public info about an invite (for landing page preview).
    
    Returns team name and role, but not internal details.
    No auth required.
    """
    invite = get_invite_by_code(code.upper())
    
    if not invite:
        raise HTTPException(404, "Invite not found")
    
    if not is_invite_valid(invite):
        reason = "expired" if invite.get("expiresAt") else "no longer valid"
        raise HTTPException(410, f"This invite has {reason}")
    
    team = get_team(invite["teamId"])
    if not team:
        raise HTTPException(404, "Team not found")
    
    # Get inviter's display name
    inviter = get_user(invite["createdBy"])
    inviter_name = inviter.get("displayName", "A coach") if inviter else "A coach"
    
    return {
        "teamName": team["name"],
        "role": invite["role"],
        "invitedBy": inviter_name,
        "expiresAt": invite.get("expiresAt")
    }
```

#### Redeem Invite

```python
@app.post("/api/invites/{code}/redeem")
async def redeem_invite_endpoint(
    code: str,
    user: dict = Depends(get_current_user)
):
    """
    Redeem an invite code.
    
    Creates a team membership for the authenticated user.
    """
    result = redeem_invite(code.upper(), user["id"])
    
    if not result["success"]:
        status_map = {
            "not_found": 404,
            "expired": 410,
            "revoked": 410,
            "max_uses": 410,
            "already_member": 409,
        }
        status = status_map.get(result.get("reason"), 400)
        raise HTTPException(status, result["error"])
    
    return {
        "status": "joined",
        "membership": result["membership"],
        "team": get_team(result["membership"]["teamId"])
    }
```

#### List Team Members

```python
@app.get("/api/teams/{team_id}/members")
async def list_team_members(
    team_id: str,
    user: dict = Depends(require_team_access("team_id"))
):
    """
    List all members of a team with their roles.
    """
    if not team_exists(team_id):
        raise HTTPException(404, f"Team {team_id} not found")
    
    memberships = get_team_memberships(team_id)
    
    # Enrich with user info
    members = []
    for membership in memberships:
        user_info = get_user(membership["userId"])
        members.append({
            "userId": membership["userId"],
            "role": membership["role"],
            "joinedAt": membership["joinedAt"],
            "displayName": user_info.get("displayName") if user_info else None,
            "email": user_info.get("email") if user_info else None,
        })
    
    return {"members": members, "count": len(members)}
```

#### Remove Member

```python
@app.delete("/api/teams/{team_id}/members/{target_user_id}")
async def remove_team_member(
    team_id: str,
    target_user_id: str,
    user: dict = Depends(require_team_coach("team_id"))
):
    """
    Remove a member from the team.
    
    Rules:
    - Any coach can remove any member
    - Coaches can remove themselves (unless they're the last coach)
    """
    if not team_exists(team_id):
        raise HTTPException(404, f"Team {team_id} not found")
    
    # Check if target is a member
    target_membership = get_user_team_membership(target_user_id, team_id)
    if not target_membership:
        raise HTTPException(404, "User is not a member of this team")
    
    # Last coach protection
    if target_membership["role"] == "coach":
        coaches = get_team_coaches(team_id)
        if len(coaches) == 1 and target_user_id in coaches:
            raise HTTPException(
                400, 
                "Cannot remove the last coach. Add another coach first, or delete the team."
            )
    
    delete_membership(target_membership["id"])
    
    return {
        "status": "removed",
        "userId": target_user_id,
        "teamId": team_id
    }
```

---

## Part 3: Landing Page Flow

### 3.1 Route Structure

| Path | Handler | Description |
|------|---------|-------------|
| `/join/{code}` | `landing/join.html` or SPA route | Invite redemption page |

### 3.2 Join Page UI Flow

```
┌────────────────────────────────────────────────────────────┐
│                        Breakside                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│     ┌──────────────────────────────────────────────────┐   │
│     │                                                  │   │
│     │     You've been invited to join                  │   │
│     │                                                  │   │
│     │     ┌────────────────────────────────────┐       │   │
│     │     │  🏆  Sample Team                   │       │   │
│     │     │      as a Coach                    │       │   │
│     │     │                                    │       │   │
│     │     │  Invited by: Dave L.               │       │   │
│     │     │  Expires: Jan 22, 2025             │       │   │
│     │     └────────────────────────────────────┘       │   │
│     │                                                  │   │
│     │  ┌──────────────────────────────────────────┐    │   │
│     │  │  Already have an account?                │    │   │
│     │  │  [        Sign In         ]              │    │   │
│     │  │                                          │    │   │
│     │  │  New to Breakside?                       │    │   │
│     │  │  [        Sign Up         ]              │    │   │
│     │  └──────────────────────────────────────────┘    │   │
│     │                                                  │   │
│     └──────────────────────────────────────────────────┘   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 3.3 Join Page Flow

```javascript
// landing/join.js (pseudocode)

async function initJoinPage() {
    const code = getCodeFromURL();  // Extract from /join/{code}
    
    if (!code) {
        showError("No invite code provided");
        return;
    }
    
    // Step 1: Fetch invite preview
    try {
        const info = await fetch(`/api/invites/${code}/info`).then(r => {
            if (!r.ok) throw new Error(r.status === 404 ? "Invite not found" : "Invite expired");
            return r.json();
        });
        
        showInvitePreview(info);  // Display team name, role, inviter
        
    } catch (error) {
        showError(error.message);
        return;
    }
    
    // Step 2: Check if already logged in
    if (isAuthenticated()) {
        showRedeemButton();  // Skip login, show "Join Team" button
    } else {
        showAuthOptions();   // Sign In / Sign Up buttons
    }
}

async function handleSignIn() {
    // Use Supabase auth modal
    await supabase.auth.signInWithPassword({ email, password });
    // On success, proceed to redeem
    await redeemInvite();
}

async function handleSignUp() {
    // Use Supabase auth modal for signup
    await supabase.auth.signUp({ email, password });
    // On success, proceed to redeem
    await redeemInvite();
}

async function redeemInvite() {
    const code = getCodeFromURL();
    
    try {
        const result = await fetch(`/api/invites/${code}/redeem`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            }
        }).then(r => {
            if (!r.ok) throw new Error("Could not join team");
            return r.json();
        });
        
        showSuccess(`You've joined ${result.team.name}!`);
        
        // Redirect to PWA after brief delay
        setTimeout(() => {
            window.location.href = '/app/';
        }, 1500);
        
    } catch (error) {
        showError(error.message);
    }
}
```

### 3.4 Error States

| State | Message | Action |
|-------|---------|--------|
| Invalid code | "Invite not found" | Link to home page |
| Expired | "This invite has expired" | "Request a new invite from your coach" |
| Already used | "This invite has already been used" | Same as expired |
| Already member | "You're already on this team!" | Link to open PWA |
| Network error | "Could not load invite. Check your connection." | Retry button |

---

## Part 4: PWA UI Components

### 4.1 New Screen: Team Settings

**Location:** New file `teams/teamSettings.js`

**Entry Point:** Button in roster management header or team actions menu

#### Screen Layout

```
┌────────────────────────────────────────────────────────────┐
│  ← Back                 Team Settings                       │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  TEAM NAME                                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Sample Team                                    [Edit] │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  MEMBERS (3)                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 👑 Dave L.              coach              [Remove]  │  │
│  │    dave@example.com                                  │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │ 🎯 Sarah K.             coach              [Remove]  │  │
│  │    sarah@example.com                                 │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │ 👁️ Mike T.              viewer             [Remove]  │  │
│  │    mike@example.com                                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ACTIVE INVITES (1)                                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Viewer invite          expires Jan 22      [Revoke]  │  │
│  │ Code: X7K2M                                [Copy]    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌────────────────────┐  ┌────────────────────┐           │
│  │  + Invite Coach    │  │  + Invite Viewer   │           │
│  └────────────────────┘  └────────────────────┘           │
│                                                            │
│  ─────────────────────────────────────────────────────────│
│                                                            │
│  JOIN A TEAM                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Enter code: [______] [Join]                         │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 4.2 Invite Creation Dialog

```
┌────────────────────────────────────────────────────────────┐
│                    Create Coach Invite                      │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  This invite can be used once to join as a coach.          │
│                                                            │
│  Expires in: [7 days ▼]                                    │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │                                                    │    │
│  │  [  Cancel  ]            [  Create Invite  ]       │    │
│  │                                                    │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

After creation:

```
┌────────────────────────────────────────────────────────────┐
│                     Invite Created!                         │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Share this code with your new coach:                      │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │                      X7K2M                          │    │
│  │              (tap to copy)                         │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  Or share this link:                                       │
│  ┌────────────────────────────────────────────────────┐    │
│  │  https://www.breakside.pro/join/X7K2M       [Copy] │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  Expires: January 22, 2025                                 │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │                     [  Done  ]                     │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 4.3 Join Team Dialog (Manual Code Entry)

```
┌────────────────────────────────────────────────────────────┐
│                       Join a Team                           │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Enter the 5-character invite code:                        │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │               [X] [7] [K] [2] [M]                  │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │                                                    │    │
│  │  [  Cancel  ]                  [  Join  ]          │    │
│  │                                                    │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

After successful entry, show confirmation:

```
┌────────────────────────────────────────────────────────────┐
│                     Join "Sample Team"?                     │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  You'll join as a: Coach                                   │
│  Invited by: Dave L.                                       │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │                                                    │    │
│  │  [  Cancel  ]               [  Join Team  ]        │    │
│  │                                                    │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 4.4 Remove Member Confirmation

```
┌────────────────────────────────────────────────────────────┐
│                    Remove Member?                           │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Remove Sarah K. from Sample Team?                         │
│                                                            │
│  They will lose access to all team data and games.         │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │                                                    │    │
│  │  [  Cancel  ]                 [  Remove  ]         │    │
│  │                                                    │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## Part 5: Files to Create/Modify

### 5.1 Backend (Python)

| File | Action | Description |
|------|--------|-------------|
| `ultistats_server/storage/invite_storage.py` | **Create** | Invite CRUD operations and code generation |
| `ultistats_server/storage/__init__.py` | **Modify** | Export invite functions |
| `ultistats_server/config.py` | **Modify** | Add `INVITES_DIR` |
| `ultistats_server/main.py` | **Modify** | Add invite and member endpoints |
| `ultistats_server/test_invites.py` | **Create** | Test invite functionality |

### 5.2 Landing Page

| File | Action | Description |
|------|--------|-------------|
| `landing/join.html` | **Create** | Join page HTML |
| `landing/join.js` | **Create** | Join page logic |
| `landing/join.css` | **Create** | Join page styles |
| `landing/index.html` | **Modify** | Add route for `/join/` if using SPA |

### 5.3 PWA Frontend

| File | Action | Description |
|------|--------|-------------|
| `teams/teamSettings.js` | **Create** | Team settings screen |
| `teams/teamSettings.css` | **Create** | Team settings styles |
| `index.html` | **Modify** | Add team settings screen HTML structure |
| `main.css` | **Modify** | Add settings-related styles |
| `teams/rosterManagement.js` | **Modify** | Add button to access Team Settings |

### 5.4 Data Directories

| Path | Action | Description |
|------|--------|-------------|
| `data/invites/` | **Create** | Invite storage directory |
| `data/invites/_index.json` | **Create** | Invite lookup index |

---

## Part 6: Implementation Order

| Step | Task | Est. Time | Dependencies |
|------|------|-----------|--------------|
| 1 | Create `invite_storage.py` with code generation | 45 min | None |
| 2 | Update `config.py` with `INVITES_DIR` | 5 min | None |
| 3 | Update `storage/__init__.py` exports | 5 min | Step 1 |
| 4 | Add invite endpoints to `main.py` | 45 min | Steps 1-3 |
| 5 | Add member management endpoints to `main.py` | 30 min | None |
| 6 | Write `test_invites.py` | 30 min | Steps 1-5 |
| 7 | Create landing page `/join/` route | 1 hr | Steps 4 |
| 8 | Create PWA Team Settings screen (HTML/CSS) | 1 hr | None |
| 9 | Implement Team Settings member list | 45 min | Step 5 |
| 10 | Implement invite creation in PWA | 45 min | Steps 4, 8 |
| 11 | Implement invite list/revoke in PWA | 30 min | Steps 4, 8 |
| 12 | Implement "Join Team" code entry in PWA | 30 min | Steps 4, 8 |
| 13 | Add Team Settings access from roster screen | 15 min | Step 8 |
| 14 | End-to-end testing | 45 min | All |
| 15 | Deploy to EC2 | 20 min | All |

**Total estimated time: ~8 hours**

---

## Part 7: Testing Plan

### 7.1 Unit Tests

```python
class TestInviteStorage:
    def test_generate_code_format(self):
        """Code is 6 chars from valid alphabet."""
    
    def test_generate_code_uniqueness(self):
        """Codes don't collide over many iterations."""
    
    def test_create_coach_invite_defaults(self):
        """Coach invite defaults to single-use."""
    
    def test_create_viewer_invite_defaults(self):
        """Viewer invite defaults to unlimited uses."""
    
    def test_get_by_code_case_insensitive(self):
        """x7k2mp matches X7K2MP."""


class TestInviteEndpoints:
    def test_create_invite_requires_coach(self):
        """POST /api/teams/{id}/invites returns 403 for viewer."""
    
    def test_get_invite_info_no_auth(self):
        """GET /api/invites/{code}/info works without auth."""
    
    def test_redeem_requires_auth(self):
        """POST /api/invites/{code}/redeem returns 401 without token."""
    
    def test_redeem_creates_membership(self):
        """Successful redemption creates team membership."""
    
    def test_redeem_expired_returns_410(self):
        """Expired invites return 410 Gone."""
    
    def test_redeem_max_uses_returns_410(self):
        """Used single-use invite returns 410."""
    
    def test_redeem_already_member_returns_409(self):
        """Already a member returns 409 Conflict."""


class TestMemberEndpoints:
    def test_list_members_requires_team_access(self):
        """GET /api/teams/{id}/members requires membership."""
    
    def test_remove_member_requires_coach(self):
        """DELETE /api/teams/{id}/members/{uid} requires coach."""
    
    def test_cannot_remove_last_coach(self):
        """Removing the only coach returns 400."""
    
    def test_coach_can_remove_self_if_not_last(self):
        """Coach can leave if another coach exists."""
```

### 7.2 Integration Tests

- [ ] Landing page loads invite preview correctly
- [ ] Landing page shows appropriate error for expired invite
- [ ] Sign up → redeem flow works
- [ ] Sign in → redeem flow works
- [ ] PWA Team Settings shows current members
- [ ] PWA invite creation shows code
- [ ] PWA "Join Team" code entry works
- [ ] Member removal updates list immediately
- [ ] Invite revocation invalidates code

---

## Part 8: Security Considerations

### 8.1 Rate Limiting (Future)

Invite code brute-forcing is unlikely given:
- 32^6 = 1 billion possible codes
- 7-day default expiration
- Codes are random, not sequential

But for defense in depth, consider adding rate limiting:
- Max 10 failed redemption attempts per IP per hour
- Max 100 invite info lookups per IP per hour

### 8.2 Code Entropy

5-character codes with 32-character alphabet = ~25 bits of entropy (~33 million combinations). This is sufficient for short-lived invite codes but not for long-term secrets.

### 8.3 Audit Trail

The `usedBy` array provides an audit trail of who used each invite and when. This is useful for:
- Debugging "I can't join" issues
- Identifying abuse of multi-use codes
- Understanding team growth patterns

---

## Part 9: Deployment Checklist

### 9.1 Pre-Deployment

- [ ] All unit tests pass
- [ ] Integration tests pass locally
- [ ] Landing page `/join/` route works
- [ ] PWA Team Settings screen works
- [ ] Invite creation and redemption work end-to-end

### 9.2 EC2 Deployment

```bash
# SSH to EC2
ssh -i ~/.ssh/your-key.pem ec2-user@3.212.138.180

# Pull latest code
cd /opt/breakside
sudo git pull

# Create invites directory
sudo mkdir -p /var/lib/breakside/data/invites
sudo chown -R breakside:breakside /var/lib/breakside/data/invites

# Restart service
sudo systemctl restart breakside

# Verify
curl https://api.breakside.pro/health
```

### 9.3 S3/CloudFront Deployment (Landing Page)

```bash
# Deploy landing page updates
aws s3 sync landing/ s3://breakside.pro/landing/ --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id E6M9KCXIU9CKD --paths "/landing/*" "/join/*"
```

---

## Part 10: Future Enhancements

These are explicitly deferred from Phase 3:

- [ ] QR code generation for invites
- [ ] Role change (promote viewer to coach)
- [ ] Invite via email (send directly from app)
- [ ] Bulk invite (upload CSV of emails)
- [ ] Team admin role (separate from coach)
- [ ] Invite analytics dashboard
- [ ] Player ↔ User account linking
- [ ] Rate-limited invite redemption (see 8.1 above)

---

## Appendix A: API Request/Response Examples

### Create Coach Invite

**Request:**
```http
POST /api/teams/Sample-Team-b2c4/invites
Authorization: Bearer {jwt}
Content-Type: application/json

{
  "role": "coach",
  "expires_days": 7
}
```

**Response:**
```json
{
  "invite": {
    "id": "inv_abc123def456",
    "code": "X7K2M",
    "teamId": "Sample-Team-b2c4",
    "role": "coach",
    "createdBy": "user-123",
    "createdAt": "2025-01-15T10:00:00Z",
    "expiresAt": "2025-01-22T10:00:00Z",
    "maxUses": 1,
    "uses": 0
  },
  "url": "https://www.breakside.pro/join/X7K2M",
  "code": "X7K2M"
}
```

### Get Invite Info (Public)

**Request:**
```http
GET /api/invites/X7K2M/info
```

**Response:**
```json
{
  "teamName": "Sample Team",
  "role": "coach",
  "invitedBy": "Dave L.",
  "expiresAt": "2025-01-22T10:00:00Z"
}
```

### Redeem Invite

**Request:**
```http
POST /api/invites/X7K2M/redeem
Authorization: Bearer {jwt}
```

**Response:**
```json
{
  "status": "joined",
  "membership": {
    "id": "mem_def456ghi789",
    "teamId": "Sample-Team-b2c4",
    "userId": "user-456",
    "role": "coach",
    "invitedBy": "user-123",
    "joinedAt": "2025-01-16T14:30:00Z"
  },
  "team": {
    "id": "Sample-Team-b2c4",
    "name": "Sample Team",
    "playerIds": ["Alice-7f3a", "Bob-2d9e"]
  }
}
```

### List Team Members

**Request:**
```http
GET /api/teams/Sample-Team-b2c4/members
Authorization: Bearer {jwt}
```

**Response:**
```json
{
  "members": [
    {
      "userId": "user-123",
      "role": "coach",
      "joinedAt": "2025-01-10T09:00:00Z",
      "displayName": "Dave L.",
      "email": "dave@example.com"
    },
    {
      "userId": "user-456",
      "role": "coach",
      "joinedAt": "2025-01-16T14:30:00Z",
      "displayName": "Sarah K.",
      "email": "sarah@example.com"
    }
  ],
  "count": 2
}
```

### Remove Member

**Request:**
```http
DELETE /api/teams/Sample-Team-b2c4/members/user-456
Authorization: Bearer {jwt}
```

**Response:**
```json
{
  "status": "removed",
  "userId": "user-456",
  "teamId": "Sample-Team-b2c4"
}
```

---

## Appendix B: Invite Code Generation

```python
import secrets
import string

# Human-friendly alphabet (no 0/O/1/I/L)
INVITE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
INVITE_CODE_LENGTH = 5

def generate_invite_code() -> str:
    """
    Generate a 5-character human-friendly invite code.
    
    Uses a 32-character alphabet, giving 32^5 ≈ 33 million possible codes.
    Codes are case-insensitive but generated uppercase.
    """
    return ''.join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_CODE_LENGTH))
```

Lookup should normalize to uppercase:

```python
def get_invite_by_code(code: str) -> Optional[dict]:
    """Look up invite by code (case-insensitive)."""
    normalized = code.upper().strip()
    # ... lookup logic
```

