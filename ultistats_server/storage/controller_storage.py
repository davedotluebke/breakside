"""
Game controller state management.

Manages Active Coach and Line Coach roles for live games.
State is in-memory only (intentionally not persisted).

If the server restarts, coaches must reclaim their roles.
This is by design—ensures stale claims don't persist.
"""
from datetime import datetime, timedelta
from typing import Dict, Optional, Literal, TypedDict
import threading

# =============================================================================
# Type Definitions
# =============================================================================

RoleType = Literal["activeCoach", "lineCoach"]


class RoleHolder(TypedDict):
    userId: str
    displayName: str
    claimedAt: str
    lastPing: str


class PendingHandoff(TypedDict):
    role: RoleType
    requesterId: str
    requesterName: str
    currentHolderId: str
    requestedAt: str
    expiresAt: str


class ControllerState(TypedDict):
    activeCoach: Optional[RoleHolder]
    lineCoach: Optional[RoleHolder]
    pendingHandoff: Optional[PendingHandoff]


# =============================================================================
# Constants
# =============================================================================

# Role expires if no ping received within this time
STALE_TIMEOUT_SECONDS = 30

# Handoff auto-approves after this time (must match client-side HANDOFF_TIMEOUT_SECONDS)
HANDOFF_EXPIRY_SECONDS = 10


# =============================================================================
# In-Memory State
# =============================================================================

_controller_states: Dict[str, ControllerState] = {}
_lock = threading.Lock()


# =============================================================================
# Helper Functions
# =============================================================================

def _get_empty_state() -> ControllerState:
    """Return a new empty controller state."""
    return {
        "activeCoach": None,
        "lineCoach": None,
        "pendingHandoff": None
    }


def _is_stale(role_holder: Optional[RoleHolder]) -> bool:
    """Check if a role holder's claim is stale (no recent ping)."""
    if not role_holder:
        return True
    
    try:
        last_ping = datetime.fromisoformat(role_holder["lastPing"])
        return (datetime.now() - last_ping).total_seconds() > STALE_TIMEOUT_SECONDS
    except (ValueError, KeyError):
        return True


def _is_handoff_expired(handoff: Optional[PendingHandoff]) -> bool:
    """Check if a pending handoff has expired."""
    if not handoff:
        return False
    
    try:
        expires_at = datetime.fromisoformat(handoff["expiresAt"])
        return datetime.now() > expires_at
    except (ValueError, KeyError):
        return False


def _auto_approve_handoff(state: ControllerState) -> None:
    """
    Auto-approve an expired handoff by transferring the role.
    
    Called within lock context.
    """
    handoff = state.get("pendingHandoff")
    if not handoff:
        return
    
    role = handoff["role"]
    now = datetime.now().isoformat()
    
    state[role] = {
        "userId": handoff["requesterId"],
        "displayName": handoff["requesterName"],
        "claimedAt": now,
        "lastPing": now
    }
    state["pendingHandoff"] = None


# =============================================================================
# Public API
# =============================================================================

def get_controller_state(game_id: str) -> ControllerState:
    """
    Get current controller state for a game.
    
    Automatically cleans up:
    - Stale role claims (no ping in 30 seconds)
    - Expired handoff requests (auto-approves after 5 seconds)
    
    Args:
        game_id: The game identifier
        
    Returns:
        Current controller state (copy, safe to modify)
    """
    with _lock:
        state = _controller_states.get(game_id, _get_empty_state())
        
        # Clean up stale claims
        for role in ["activeCoach", "lineCoach"]:
            if _is_stale(state.get(role)):
                state[role] = None
        
        # Handle expired handoffs (auto-approve)
        if _is_handoff_expired(state.get("pendingHandoff")):
            _auto_approve_handoff(state)
        
        _controller_states[game_id] = state
        return dict(state)  # Return a copy


def claim_role(
    game_id: str, 
    role: RoleType, 
    user_id: str, 
    display_name: str
) -> Dict:
    """
    Attempt to claim a controller role.
    
    Args:
        game_id: The game identifier
        role: "activeCoach" or "lineCoach"
        user_id: The requesting user's ID
        display_name: The user's display name
        
    Returns:
        {
            "success": True,
            "state": ControllerState
        }
        or
        {
            "success": False,
            "reason": "occupied",
            "currentHolder": RoleHolder,
            "state": ControllerState
        }
    """
    with _lock:
        state = _controller_states.get(game_id, _get_empty_state())
        
        # Clean stale claims first
        for r in ["activeCoach", "lineCoach"]:
            if _is_stale(state.get(r)):
                state[r] = None
        
        # Handle expired handoffs
        if _is_handoff_expired(state.get("pendingHandoff")):
            _auto_approve_handoff(state)
        
        current_holder = state.get(role)
        now = datetime.now().isoformat()
        
        # Already held by this user - just refresh ping
        if current_holder and current_holder["userId"] == user_id:
            current_holder["lastPing"] = now
            _controller_states[game_id] = state
            return {"success": True, "state": dict(state)}
        
        # Role is vacant (or stale) - claim it
        if current_holder is None:
            state[role] = {
                "userId": user_id,
                "displayName": display_name,
                "claimedAt": now,
                "lastPing": now
            }
            _controller_states[game_id] = state
            return {"success": True, "state": dict(state)}
        
        # Role is occupied - cannot claim directly
        _controller_states[game_id] = state
        return {
            "success": False,
            "reason": "occupied",
            "currentHolder": dict(current_holder),
            "state": dict(state)
        }


def request_handoff(
    game_id: str, 
    role: RoleType, 
    requester_id: str, 
    requester_name: str
) -> Dict:
    """
    Request a handoff for an occupied role.
    
    Creates a pending handoff that expires in HANDOFF_EXPIRY_SECONDS.
    The current holder can accept/deny, or it auto-approves on expiry.
    
    Args:
        game_id: The game identifier
        role: "activeCoach" or "lineCoach"
        requester_id: The requesting user's ID
        requester_name: The requester's display name
        
    Returns:
        {
            "success": True,
            "handoff": PendingHandoff,
            "state": ControllerState
        }
        or
        {
            "success": False,
            "reason": "role_vacant" | "already_holder" | "handoff_pending"
        }
    """
    with _lock:
        state = _controller_states.get(game_id, _get_empty_state())
        
        # Clean stale claims first
        for r in ["activeCoach", "lineCoach"]:
            if _is_stale(state.get(r)):
                state[r] = None
        
        # Handle expired handoffs
        if _is_handoff_expired(state.get("pendingHandoff")):
            _auto_approve_handoff(state)
        
        current_holder = state.get(role)
        
        # Can't request handoff for vacant role
        if not current_holder:
            _controller_states[game_id] = state
            return {"success": False, "reason": "role_vacant"}
        
        # Can't request handoff from yourself
        if current_holder["userId"] == requester_id:
            return {"success": False, "reason": "already_holder"}
        
        # Check for existing pending handoff
        if state.get("pendingHandoff"):
            return {"success": False, "reason": "handoff_pending"}
        
        # Create handoff request
        now = datetime.now()
        handoff: PendingHandoff = {
            "role": role,
            "requesterId": requester_id,
            "requesterName": requester_name,
            "currentHolderId": current_holder["userId"],
            "requestedAt": now.isoformat(),
            "expiresAt": (now + timedelta(seconds=HANDOFF_EXPIRY_SECONDS)).isoformat()
        }
        
        state["pendingHandoff"] = handoff
        _controller_states[game_id] = state
        
        return {
            "success": True,
            "handoff": dict(handoff),
            "state": dict(state)
        }


def respond_to_handoff(
    game_id: str, 
    user_id: str, 
    accept: bool
) -> Dict:
    """
    Respond to a pending handoff request.
    
    Only the current holder can respond.
    
    Args:
        game_id: The game identifier
        user_id: The responding user's ID (must be current holder)
        accept: True to transfer role, False to deny
        
    Returns:
        {
            "success": True,
            "accepted": bool,
            "state": ControllerState
        }
        or
        {
            "success": False,
            "reason": "no_pending_handoff" | "not_holder"
        }
    """
    with _lock:
        state = _controller_states.get(game_id, _get_empty_state())
        
        handoff = state.get("pendingHandoff")
        if not handoff:
            return {"success": False, "reason": "no_pending_handoff"}
        
        if handoff["currentHolderId"] != user_id:
            return {"success": False, "reason": "not_holder"}
        
        role = handoff["role"]
        now = datetime.now().isoformat()
        
        # Clear the handoff request
        state["pendingHandoff"] = None
        
        if accept:
            # Transfer the role
            state[role] = {
                "userId": handoff["requesterId"],
                "displayName": handoff["requesterName"],
                "claimedAt": now,
                "lastPing": now
            }
            _controller_states[game_id] = state
            return {"success": True, "accepted": True, "state": dict(state)}
        else:
            # Denied - role stays with current holder
            _controller_states[game_id] = state
            return {"success": True, "accepted": False, "state": dict(state)}


def release_role(
    game_id: str, 
    role: RoleType, 
    user_id: str
) -> Dict:
    """
    Release a controller role.
    
    Args:
        game_id: The game identifier
        role: "activeCoach" or "lineCoach"
        user_id: The user releasing the role (must be current holder)
        
    Returns:
        {
            "success": True,
            "state": ControllerState
        }
        or
        {
            "success": False,
            "reason": "not_holder"
        }
    """
    with _lock:
        state = _controller_states.get(game_id, _get_empty_state())
        
        current_holder = state.get(role)
        if not current_holder or current_holder["userId"] != user_id:
            return {"success": False, "reason": "not_holder"}
        
        state[role] = None
        
        # Also clear any pending handoff for this role
        handoff = state.get("pendingHandoff")
        if handoff and handoff["role"] == role:
            state["pendingHandoff"] = None
        
        _controller_states[game_id] = state
        return {"success": True, "state": dict(state)}


def ping_role(
    game_id: str, 
    role: RoleType, 
    user_id: str
) -> Dict:
    """
    Update lastPing for a role to keep the claim alive.
    
    Args:
        game_id: The game identifier
        role: "activeCoach" or "lineCoach"
        user_id: The user pinging (must be current holder)
        
    Returns:
        {
            "success": True,
            "state": ControllerState
        }
        or
        {
            "success": False,
            "reason": "not_holder"
        }
    """
    with _lock:
        state = _controller_states.get(game_id, _get_empty_state())
        
        current_holder = state.get(role)
        if not current_holder or current_holder["userId"] != user_id:
            return {"success": False, "reason": "not_holder"}
        
        current_holder["lastPing"] = datetime.now().isoformat()
        _controller_states[game_id] = state
        return {"success": True, "state": dict(state)}


def clear_game_state(game_id: str) -> None:
    """
    Clear controller state for a game.
    
    Call this when a game ends to free memory.
    
    Args:
        game_id: The game identifier
    """
    with _lock:
        if game_id in _controller_states:
            del _controller_states[game_id]


def get_active_games() -> Dict[str, ControllerState]:
    """
    Get all games with active controller state.
    
    Useful for debugging and monitoring.
    
    Returns:
        Dictionary of game_id -> ControllerState
    """
    with _lock:
        return {
            game_id: dict(state) 
            for game_id, state in _controller_states.items()
        }

