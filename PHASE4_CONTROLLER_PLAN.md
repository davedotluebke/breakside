# Phase 4: Game Controller State - Implementation Plan

This document details the implementation plan for multi-coach game control, enabling handoffs during live games.

## Overview

Phase 4 enables multiple coaches to collaborate during a game with clear role assignments:
- **Active Coach**: Has write control for play-by-play events and current lineup
- **Line Coach**: Can prepare the next lineup during a point

Only one user can hold each role at a time. Handoffs allow smooth transitions when coaches want to swap responsibilities.

---

## Data Model

### Controller State Structure

Controller state is stored **in-memory** on the server (not persisted to disk). If the server restarts, coaches must reclaim their roles. This is intentional—it ensures stale claims don't persist.

```python
# In-memory structure per game
controller_states = {
    "game-id-1": {
        "activeCoach": {
            "userId": "user-abc",
            "displayName": "Coach Alice",
            "claimedAt": "2025-01-15T10:30:00Z",
            "lastPing": "2025-01-15T10:35:00Z"
        },
        "lineCoach": {
            "userId": "user-xyz",
            "displayName": "Coach Bob",
            "claimedAt": "2025-01-15T10:32:00Z",
            "lastPing": "2025-01-15T10:35:00Z"
        },
        "pendingHandoff": {
            "role": "activeCoach",
            "requesterId": "user-xyz",
            "requesterName": "Coach Bob",
            "currentHolderId": "user-abc",
            "requestedAt": "2025-01-15T10:35:30Z",
            "expiresAt": "2025-01-15T10:35:35Z"
        }
    }
}
```

### Timeouts

| Timeout | Duration | Purpose |
|---------|----------|---------|
| Stale claim | 30 seconds | Auto-release role if no ping received |
| Handoff expiry | 5 seconds | Auto-approve handoff if no response |

---

## Backend Implementation

### 1. New File: `storage/controller_storage.py`

In-memory controller state management:

```python
"""
Game controller state management.

Manages Active Coach and Line Coach roles for live games.
State is in-memory only (intentionally not persisted).
"""
from datetime import datetime, timedelta
from typing import Dict, Optional, Literal
import threading

# In-memory state
_controller_states: Dict[str, dict] = {}
_lock = threading.Lock()

# Timeouts
STALE_TIMEOUT_SECONDS = 30
HANDOFF_EXPIRY_SECONDS = 5

RoleType = Literal["activeCoach", "lineCoach"]


def get_controller_state(game_id: str) -> dict:
    """Get current controller state for a game, cleaning up stale claims."""
    with _lock:
        state = _controller_states.get(game_id, {
            "activeCoach": None,
            "lineCoach": None,
            "pendingHandoff": None
        })
        
        # Clean up stale claims
        now = datetime.now()
        for role in ["activeCoach", "lineCoach"]:
            if state.get(role):
                last_ping = datetime.fromisoformat(state[role]["lastPing"])
                if (now - last_ping).total_seconds() > STALE_TIMEOUT_SECONDS:
                    state[role] = None
        
        # Clean up expired handoffs
        if state.get("pendingHandoff"):
            expires_at = datetime.fromisoformat(state["pendingHandoff"]["expiresAt"])
            if now > expires_at:
                # Auto-approve: transfer the role
                _auto_approve_handoff(game_id, state)
        
        _controller_states[game_id] = state
        return state.copy()


def claim_role(game_id: str, role: RoleType, user_id: str, display_name: str) -> dict:
    """
    Attempt to claim a role.
    
    Returns:
        {"success": True, "state": {...}} if claimed immediately
        {"success": False, "reason": "occupied", "currentHolder": {...}} if handoff needed
    """
    with _lock:
        state = _controller_states.get(game_id, {
            "activeCoach": None,
            "lineCoach": None,
            "pendingHandoff": None
        })
        
        current_holder = state.get(role)
        
        # Check if already held by this user
        if current_holder and current_holder["userId"] == user_id:
            # Refresh ping
            current_holder["lastPing"] = datetime.now().isoformat()
            _controller_states[game_id] = state
            return {"success": True, "state": state.copy()}
        
        # Check if role is vacant (or stale)
        if current_holder:
            last_ping = datetime.fromisoformat(current_holder["lastPing"])
            if (datetime.now() - last_ping).total_seconds() > STALE_TIMEOUT_SECONDS:
                current_holder = None  # Stale, can be claimed
        
        if current_holder is None:
            # Claim immediately
            state[role] = {
                "userId": user_id,
                "displayName": display_name,
                "claimedAt": datetime.now().isoformat(),
                "lastPing": datetime.now().isoformat()
            }
            _controller_states[game_id] = state
            return {"success": True, "state": state.copy()}
        
        # Role is occupied - need handoff
        return {
            "success": False,
            "reason": "occupied",
            "currentHolder": current_holder,
            "state": state.copy()
        }


def request_handoff(game_id: str, role: RoleType, requester_id: str, requester_name: str) -> dict:
    """
    Request a handoff for an occupied role.
    
    Creates a pending handoff that expires in HANDOFF_EXPIRY_SECONDS.
    """
    with _lock:
        state = _controller_states.get(game_id, {
            "activeCoach": None,
            "lineCoach": None,
            "pendingHandoff": None
        })
        
        current_holder = state.get(role)
        if not current_holder:
            return {"success": False, "reason": "role_vacant"}
        
        if current_holder["userId"] == requester_id:
            return {"success": False, "reason": "already_holder"}
        
        # Check for existing pending handoff
        if state.get("pendingHandoff"):
            return {"success": False, "reason": "handoff_pending"}
        
        # Create handoff request
        now = datetime.now()
        state["pendingHandoff"] = {
            "role": role,
            "requesterId": requester_id,
            "requesterName": requester_name,
            "currentHolderId": current_holder["userId"],
            "requestedAt": now.isoformat(),
            "expiresAt": (now + timedelta(seconds=HANDOFF_EXPIRY_SECONDS)).isoformat()
        }
        
        _controller_states[game_id] = state
        return {"success": True, "handoff": state["pendingHandoff"], "state": state.copy()}


def respond_to_handoff(game_id: str, user_id: str, accept: bool) -> dict:
    """
    Respond to a pending handoff request.
    
    Only the current holder can respond.
    """
    with _lock:
        state = _controller_states.get(game_id, {})
        
        handoff = state.get("pendingHandoff")
        if not handoff:
            return {"success": False, "reason": "no_pending_handoff"}
        
        if handoff["currentHolderId"] != user_id:
            return {"success": False, "reason": "not_holder"}
        
        role = handoff["role"]
        requester_id = handoff["requesterId"]
        requester_name = handoff["requesterName"]
        
        # Clear the handoff
        state["pendingHandoff"] = None
        
        if accept:
            # Transfer the role
            state[role] = {
                "userId": requester_id,
                "displayName": requester_name,
                "claimedAt": datetime.now().isoformat(),
                "lastPing": datetime.now().isoformat()
            }
            _controller_states[game_id] = state
            return {"success": True, "accepted": True, "state": state.copy()}
        else:
            # Denied
            _controller_states[game_id] = state
            return {"success": True, "accepted": False, "state": state.copy()}


def release_role(game_id: str, role: RoleType, user_id: str) -> dict:
    """Release a role if held by the specified user."""
    with _lock:
        state = _controller_states.get(game_id, {})
        
        current_holder = state.get(role)
        if not current_holder or current_holder["userId"] != user_id:
            return {"success": False, "reason": "not_holder"}
        
        state[role] = None
        _controller_states[game_id] = state
        return {"success": True, "state": state.copy()}


def ping_role(game_id: str, role: RoleType, user_id: str) -> dict:
    """Update lastPing for a role (keeps the claim alive)."""
    with _lock:
        state = _controller_states.get(game_id, {})
        
        current_holder = state.get(role)
        if not current_holder or current_holder["userId"] != user_id:
            return {"success": False, "reason": "not_holder"}
        
        current_holder["lastPing"] = datetime.now().isoformat()
        _controller_states[game_id] = state
        return {"success": True, "state": state.copy()}


def _auto_approve_handoff(game_id: str, state: dict) -> None:
    """Auto-approve an expired handoff (called within lock)."""
    handoff = state.get("pendingHandoff")
    if not handoff:
        return
    
    role = handoff["role"]
    state[role] = {
        "userId": handoff["requesterId"],
        "displayName": handoff["requesterName"],
        "claimedAt": datetime.now().isoformat(),
        "lastPing": datetime.now().isoformat()
    }
    state["pendingHandoff"] = None


def clear_game_state(game_id: str) -> None:
    """Clear controller state for a game (e.g., when game ends)."""
    with _lock:
        if game_id in _controller_states:
            del _controller_states[game_id]
```

### 2. API Endpoints (add to `main.py`)

```python
# =============================================================================
# Game Controller Endpoints
# =============================================================================

@app.get("/api/games/{game_id}/controller")
async def get_controller_status(
    game_id: str,
    user: dict = Depends(require_game_team_access)
):
    """
    Get current controller state for a game.
    
    Returns active coach, line coach, and any pending handoff.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")
    
    state = get_controller_state(game_id)
    
    # Add "isMe" flags for the current user
    my_role = None
    if state.get("activeCoach") and state["activeCoach"]["userId"] == user["id"]:
        my_role = "activeCoach"
    elif state.get("lineCoach") and state["lineCoach"]["userId"] == user["id"]:
        my_role = "lineCoach"
    
    has_pending_for_me = (
        state.get("pendingHandoff") and 
        state["pendingHandoff"]["currentHolderId"] == user["id"]
    )
    
    return {
        "state": state,
        "myRole": my_role,
        "hasPendingHandoffForMe": has_pending_for_me,
        "serverTime": datetime.now().isoformat()
    }


@app.post("/api/games/{game_id}/claim-active")
async def claim_active_coach(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    Claim the Active Coach role.
    
    If role is vacant, claim immediately.
    If role is occupied, creates a handoff request.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")
    
    # Get user's display name
    local_user = get_user(user["id"])
    display_name = local_user.get("displayName", user.get("email", "Unknown"))
    
    result = claim_role(game_id, "activeCoach", user["id"], display_name)
    
    if result["success"]:
        return {"status": "claimed", "role": "activeCoach", **result}
    
    # Need to request handoff
    handoff_result = request_handoff(game_id, "activeCoach", user["id"], display_name)
    
    if handoff_result["success"]:
        return {"status": "handoff_requested", "role": "activeCoach", **handoff_result}
    
    raise HTTPException(status_code=409, detail=handoff_result.get("reason", "Cannot claim role"))


@app.post("/api/games/{game_id}/claim-line")
async def claim_line_coach(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    Claim the Line Coach role.
    
    If role is vacant, claim immediately.
    If role is occupied, creates a handoff request.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")
    
    local_user = get_user(user["id"])
    display_name = local_user.get("displayName", user.get("email", "Unknown"))
    
    result = claim_role(game_id, "lineCoach", user["id"], display_name)
    
    if result["success"]:
        return {"status": "claimed", "role": "lineCoach", **result}
    
    handoff_result = request_handoff(game_id, "lineCoach", user["id"], display_name)
    
    if handoff_result["success"]:
        return {"status": "handoff_requested", "role": "lineCoach", **handoff_result}
    
    raise HTTPException(status_code=409, detail=handoff_result.get("reason", "Cannot claim role"))


@app.post("/api/games/{game_id}/release")
async def release_controller_role(
    game_id: str,
    role: Literal["activeCoach", "lineCoach"] = Body(..., embed=True),
    user: dict = Depends(require_game_team_coach)
):
    """
    Release a controller role.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")
    
    result = release_role(game_id, role, user["id"])
    
    if result["success"]:
        return {"status": "released", "role": role, **result}
    
    raise HTTPException(status_code=400, detail=result.get("reason", "Cannot release role"))


@app.post("/api/games/{game_id}/handoff-response")
async def respond_handoff(
    game_id: str,
    accept: bool = Body(..., embed=True),
    user: dict = Depends(require_game_team_coach)
):
    """
    Accept or deny a pending handoff request.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")
    
    result = respond_to_handoff(game_id, user["id"], accept)
    
    if result["success"]:
        action = "accepted" if accept else "denied"
        return {"status": action, **result}
    
    raise HTTPException(status_code=400, detail=result.get("reason", "Cannot respond to handoff"))


@app.post("/api/games/{game_id}/ping")
async def ping_controller(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    Ping to keep a controller role alive.
    
    Also returns current game version for sync check.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")
    
    state = get_controller_state(game_id)
    
    # Ping whichever role(s) the user holds
    pinged = []
    if state.get("activeCoach") and state["activeCoach"]["userId"] == user["id"]:
        ping_role(game_id, "activeCoach", user["id"])
        pinged.append("activeCoach")
    if state.get("lineCoach") and state["lineCoach"]["userId"] == user["id"]:
        ping_role(game_id, "lineCoach", user["id"])
        pinged.append("lineCoach")
    
    # Get latest game state for version check
    game = get_game_current(game_id)
    
    return {
        "status": "ok",
        "pinged": pinged,
        "controllerState": get_controller_state(game_id),
        "gameVersion": game.get("syncVersion"),
        "serverTime": datetime.now().isoformat()
    }
```

### 3. Update `storage/__init__.py`

Add exports for controller storage functions:

```python
from storage.controller_storage import (
    get_controller_state,
    claim_role,
    request_handoff,
    respond_to_handoff,
    release_role,
    ping_role,
    clear_game_state,
)
```

---

## Frontend Implementation

### 1. New File: `game/controllerState.js`

```javascript
/*
 * Game Controller State Management
 * Handles Active Coach / Line Coach role claims and handoffs
 */

// Controller state
let controllerState = {
    activeCoach: null,
    lineCoach: null,
    pendingHandoff: null,
    myRole: null,
    lastUpdate: null
};

// Polling configuration
const PING_INTERVAL_ACTIVE = 2000;  // 2 seconds when holding a role
const PING_INTERVAL_IDLE = 5000;    // 5 seconds when not holding a role
let pingIntervalId = null;

/**
 * Get current controller state from server
 */
async function fetchControllerState(gameId) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/controller`);
        if (!response.ok) {
            throw new Error(`Failed to fetch controller state: ${response.statusText}`);
        }
        const data = await response.json();
        updateControllerState(data);
        return data;
    } catch (error) {
        console.error('Error fetching controller state:', error);
        return null;
    }
}

/**
 * Update local controller state and trigger UI updates
 */
function updateControllerState(data) {
    controllerState = {
        activeCoach: data.state?.activeCoach || null,
        lineCoach: data.state?.lineCoach || null,
        pendingHandoff: data.state?.pendingHandoff || null,
        myRole: data.myRole || null,
        hasPendingHandoffForMe: data.hasPendingHandoffForMe || false,
        lastUpdate: new Date()
    };
    
    // Trigger UI update
    if (typeof updateControllerUI === 'function') {
        updateControllerUI(controllerState);
    }
    
    // Handle pending handoff for this user
    if (controllerState.hasPendingHandoffForMe) {
        showHandoffRequestUI(controllerState.pendingHandoff);
    }
}

/**
 * Claim the Active Coach role
 */
async function claimActiveCoach(gameId) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/claim-active`, {
            method: 'POST'
        });
        const data = await response.json();
        
        if (response.ok) {
            if (data.status === 'claimed') {
                showToast('You are now Active Coach');
                updateControllerState({ state: data.state, myRole: 'activeCoach' });
            } else if (data.status === 'handoff_requested') {
                showToast('Handoff request sent...');
                updateControllerState({ state: data.state, myRole: controllerState.myRole });
            }
        } else {
            showToast(`Cannot claim role: ${data.detail || 'Unknown error'}`);
        }
        
        return data;
    } catch (error) {
        console.error('Error claiming active coach:', error);
        showToast('Error claiming role');
        return null;
    }
}

/**
 * Claim the Line Coach role
 */
async function claimLineCoach(gameId) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/claim-line`, {
            method: 'POST'
        });
        const data = await response.json();
        
        if (response.ok) {
            if (data.status === 'claimed') {
                showToast('You are now Line Coach');
                updateControllerState({ state: data.state, myRole: 'lineCoach' });
            } else if (data.status === 'handoff_requested') {
                showToast('Handoff request sent...');
            }
        } else {
            showToast(`Cannot claim role: ${data.detail || 'Unknown error'}`);
        }
        
        return data;
    } catch (error) {
        console.error('Error claiming line coach:', error);
        showToast('Error claiming role');
        return null;
    }
}

/**
 * Release current role
 */
async function releaseRole(gameId, role) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/release`, {
            method: 'POST',
            body: JSON.stringify({ role })
        });
        const data = await response.json();
        
        if (response.ok) {
            showToast(`Released ${role === 'activeCoach' ? 'Active Coach' : 'Line Coach'} role`);
            updateControllerState({ state: data.state, myRole: null });
        }
        
        return data;
    } catch (error) {
        console.error('Error releasing role:', error);
        return null;
    }
}

/**
 * Respond to a handoff request
 */
async function respondToHandoff(gameId, accept) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/handoff-response`, {
            method: 'POST',
            body: JSON.stringify({ accept })
        });
        const data = await response.json();
        
        if (response.ok) {
            if (accept) {
                showToast('Handoff accepted');
            } else {
                showToast('Handoff denied');
            }
            updateControllerState({ state: data.state, myRole: accept ? null : controllerState.myRole });
        }
        
        hideHandoffRequestUI();
        return data;
    } catch (error) {
        console.error('Error responding to handoff:', error);
        return null;
    }
}

/**
 * Ping server to keep role alive
 */
async function pingServer(gameId) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/ping`, {
            method: 'POST'
        });
        
        if (response.ok) {
            const data = await response.json();
            updateControllerState({
                state: data.controllerState,
                myRole: controllerState.myRole,
                hasPendingHandoffForMe: data.controllerState?.pendingHandoff?.currentHolderId === getCurrentUserId()
            });
        }
    } catch (error) {
        console.error('Ping failed:', error);
    }
}

/**
 * Start ping loop for keeping role alive
 */
function startControllerPolling(gameId) {
    if (pingIntervalId) {
        clearInterval(pingIntervalId);
    }
    
    const interval = controllerState.myRole ? PING_INTERVAL_ACTIVE : PING_INTERVAL_IDLE;
    
    pingIntervalId = setInterval(() => {
        pingServer(gameId);
    }, interval);
    
    // Initial ping
    pingServer(gameId);
}

/**
 * Stop polling
 */
function stopControllerPolling() {
    if (pingIntervalId) {
        clearInterval(pingIntervalId);
        pingIntervalId = null;
    }
}

/**
 * Get current user's role
 */
function getMyRole() {
    return controllerState.myRole;
}

/**
 * Check if current user is Active Coach
 */
function isActiveCoach() {
    return controllerState.myRole === 'activeCoach';
}

/**
 * Check if current user is Line Coach
 */
function isLineCoach() {
    return controllerState.myRole === 'lineCoach';
}

/**
 * Check if user can edit play-by-play (Active Coach or no one has claimed)
 */
function canEditPlayByPlay() {
    return controllerState.myRole === 'activeCoach' || !controllerState.activeCoach;
}

/**
 * Check if user can edit lineup (Line Coach, Active Coach, or no one has claimed)
 */
function canEditLineup() {
    return controllerState.myRole === 'lineCoach' || 
           controllerState.myRole === 'activeCoach' || 
           (!controllerState.lineCoach && !controllerState.activeCoach);
}

// Exports
window.controllerState = controllerState;
window.fetchControllerState = fetchControllerState;
window.claimActiveCoach = claimActiveCoach;
window.claimLineCoach = claimLineCoach;
window.releaseRole = releaseRole;
window.respondToHandoff = respondToHandoff;
window.startControllerPolling = startControllerPolling;
window.stopControllerPolling = stopControllerPolling;
window.getMyRole = getMyRole;
window.isActiveCoach = isActiveCoach;
window.isLineCoach = isLineCoach;
window.canEditPlayByPlay = canEditPlayByPlay;
window.canEditLineup = canEditLineup;
```

### 2. Update `index.html`

Add the new controller state module:

```html
<!-- Add after game/gameLogic.js -->
<script src="game/controllerState.js"></script>
```

---

## Testing Plan

### Backend Tests (`test_controller.py`)

1. **Claim vacant role** - Should succeed immediately
2. **Claim occupied role** - Should create handoff request
3. **Accept handoff** - Role should transfer
4. **Deny handoff** - Role should remain with original holder
5. **Auto-expire handoff** - Should auto-transfer after 5 seconds
6. **Stale claim cleanup** - Should release role after 30 seconds without ping
7. **Release role** - Should clear the role
8. **Ping keeps role alive** - Should update lastPing timestamp

### Frontend Tests (Manual)

1. Two browsers with different coaches logged in
2. Coach A claims Active Coach - should succeed
3. Coach B claims Active Coach - should show handoff request to Coach A
4. Coach A accepts - role should transfer to Coach B
5. Repeat with Line Coach role
6. Test timeout: Coach A claims, then closes browser without releasing

---

## File Changes Summary

### New Files
- `ultistats_server/storage/controller_storage.py` - In-memory controller state
- `game/controllerState.js` - Frontend controller state management
- `ultistats_server/test_controller.py` - Backend tests

### Modified Files
- `ultistats_server/storage/__init__.py` - Add controller storage exports
- `ultistats_server/main.py` - Add controller API endpoints
- `index.html` - Include new JS module

---

## Implementation Order

1. ✅ Create this planning document
2. Create `controller_storage.py` (backend storage)
3. Update `storage/__init__.py` (exports)
4. Add API endpoints to `main.py`
5. Create `test_controller.py` and verify backend
6. Create `game/controllerState.js` (frontend)
7. Update `index.html` to include new module
8. Manual testing with two browser sessions
9. Update TODO.md to mark Phase 4 complete

---

## Future Considerations (Phase 5+)

- **UI indicators** for controller roles (Phase 6)
- **Handoff confirmation panel** with countdown (Phase 6)
- **Viewer read-only mode** (Phase 7)
- **WebSocket upgrade** for real-time handoffs (post-rollout)

