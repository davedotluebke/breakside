# Phase 4: Game Controller State - Implementation Complete

This document details the implementation of multi-coach game control, enabling handoffs during live games.

## Status: ✅ Complete

Implemented and tested on 2025-12-30.

---

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

### File: `ultistats_server/storage/controller_storage.py`

In-memory controller state management with thread-safe locking:

**Key Functions:**
- `get_controller_state(game_id)` - Get state, auto-clean stale claims
- `claim_role(game_id, role, user_id, display_name)` - Attempt to claim a role
- `request_handoff(game_id, role, requester_id, requester_name)` - Request handoff for occupied role
- `respond_to_handoff(game_id, user_id, accept)` - Accept/deny pending handoff
- `release_role(game_id, role, user_id)` - Voluntarily release a role
- `ping_role(game_id, role, user_id)` - Keep claim alive
- `clear_game_state(game_id)` - Clear state when game ends
- `get_active_games()` - List all games with active controller state

### API Endpoints (in `main.py`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/games/{game_id}/controller` | GET | Get controller state |
| `/api/games/{game_id}/claim-active` | POST | Claim Active Coach role |
| `/api/games/{game_id}/claim-line` | POST | Claim Line Coach role |
| `/api/games/{game_id}/release` | POST | Release a role |
| `/api/games/{game_id}/handoff-response` | POST | Accept/deny handoff |
| `/api/games/{game_id}/ping` | POST | Keep role alive |

### Tests: `ultistats_server/test_controller.py`

22 comprehensive tests covering:
- Claiming vacant/occupied roles
- Handoff request/accept/deny flow
- Auto-expire stale claims
- Auto-approve expired handoffs
- Multiple games independence

---

## Frontend Implementation

### File: `game/controllerState.js`

Controller state management with automatic polling:

**State:**
```javascript
let controllerState = {
    activeCoach: null,      // { userId, displayName, claimedAt, lastPing }
    lineCoach: null,        // { userId, displayName, claimedAt, lastPing }
    pendingHandoff: null,   // { role, requesterId, requesterName, ... }
    myRole: null,           // 'activeCoach' | 'lineCoach' | null
    hasPendingHandoffForMe: false,
    lastUpdate: null
};
```

**Exported Functions:**
- `claimActiveCoach(gameId)` - Claim Active Coach role
- `claimLineCoach(gameId)` - Claim Line Coach role
- `releaseControllerRole(gameId, role)` - Release a role
- `respondToHandoff(gameId, accept)` - Accept/deny handoff
- `startControllerPolling(gameId)` - Start polling for a game
- `stopControllerPolling()` - Stop polling
- `isControllerPollingActive()` - Check if polling is running
- `getPollingGameId()` - Get current polling game ID
- `isActiveCoach()` - Check if user is Active Coach
- `isLineCoach()` - Check if user is Line Coach
- `canEditPlayByPlay()` - Permission check for events
- `canEditLineup()` - Permission check for lineup
- `getControllerState()` - Get current state
- `getMyControllerRole()` - Get user's role

### Polling Integration: `screens/navigation.js`

Centralized polling management in `showScreen()`:

```javascript
// Screens where controller polling should be active
const activeGameScreenIds = [
    'beforePointScreen',
    'offensePlayByPlayScreen',
    'defensePlayByPlayScreen',
    'simpleModeScreen'
];

// Screens where controller polling should stop
const nonGameScreenIds = [
    'selectTeamScreen',
    'teamRosterScreen',
    'teamSettingsScreen',
    'gameSummaryScreen'
];
```

**Benefits of centralized approach:**
1. Self-healing - polling auto-restarts on screen transition
2. Single point of maintenance
3. Easy to extend with new screens

---

## Testing

### Console Commands for Manual Testing

```javascript
// Check polling status
isControllerPollingActive()

// Check your role
isActiveCoach()
isLineCoach()
getMyControllerRole()

// Get full state
getControllerState()

// Claim roles (requires game ID)
claimActiveCoach(currentGame().id)
claimLineCoach(currentGame().id)

// Release role
releaseControllerRole(currentGame().id, 'activeCoach')

// Respond to handoff (when someone requests your role)
respondToHandoff(currentGame().id, true)   // Accept
respondToHandoff(currentGame().id, false)  // Deny
```

### Test Scenarios

1. **Claim vacant role** - Navigate to game, claim role, verify `isActiveCoach()` returns true
2. **Handoff flow** - Two browsers, one claims, other requests, first accepts/denies
3. **Auto-approve** - Request handoff, wait 5 seconds, role transfers automatically
4. **Stale claim** - Claim role, stop polling, wait 30 seconds, role becomes available

---

## File Summary

### New Files
- `ultistats_server/storage/controller_storage.py` - In-memory state management
- `ultistats_server/test_controller.py` - 22 backend tests
- `game/controllerState.js` - Frontend state and polling

### Modified Files
- `ultistats_server/storage/__init__.py` - Export controller functions
- `ultistats_server/main.py` - Add 6 API endpoints
- `screens/navigation.js` - Centralized polling management
- `index.html` - Include controllerState.js

---

## Future Work (Phase 6)

The controller state infrastructure is complete. Phase 6 will add:

- **Header buttons** showing "Play-by-Play" and "Next Line" roles
- **Handoff countdown panel** with Accept/Deny buttons
- **Toast notifications** for role changes
- Visual indicators (green checkmark when holding a role)

Currently, all interaction is via browser console. Phase 6 makes it user-facing.
