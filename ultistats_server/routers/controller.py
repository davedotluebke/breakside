"""
Game Controller endpoints (Active Coach / Line Coach roles).
"""
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException

from ._shared import (
    HANDOFF_EXPIRY_SECONDS,
    auto_assign_roles_if_unclaimed,
    claim_role,
    game_exists,
    get_connected_coaches,
    get_controller_state,
    get_user,
    ping_role,
    record_coach_ping,
    release_role,
    request_handoff,
    require_game_team_access,
    require_game_team_coach,
    respond_to_handoff,
)

router = APIRouter()


def _get_handoff_expires_in_seconds(handoff: dict) -> float:
    """
    Calculate remaining seconds until a handoff expires.
    """
    try:
        expires_at = datetime.fromisoformat(handoff["expiresAt"])
        remaining = (expires_at - datetime.now()).total_seconds()
        return round(max(0, remaining), 1)  # Don't return negative
    except (ValueError, KeyError):
        return float(HANDOFF_EXPIRY_SECONDS)  # Fallback


def _enrich_pending_handoff(state: dict) -> dict:
    """
    Add expiresInSeconds to pendingHandoff for accurate client-side countdown.
    Returns a copy of state with the enriched handoff.
    """
    if not state.get("pendingHandoff"):
        return state

    # Calculate remaining seconds until expiry
    remaining = _get_handoff_expires_in_seconds(state["pendingHandoff"])

    # Create enriched copy
    enriched_state = dict(state)
    enriched_state["pendingHandoff"] = dict(state["pendingHandoff"])
    enriched_state["pendingHandoff"]["expiresInSeconds"] = remaining

    return enriched_state


@router.get("/api/games/{game_id}/controller")
async def get_controller_status(
    game_id: str,
    user: dict = Depends(require_game_team_access)
):
    """
    Get current controller state for a game.

    Returns active coach, line coach, and any pending handoff.
    Cleans up stale claims and expired handoffs automatically.

    Requires: Coach or Viewer access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")

    state = get_controller_state(game_id)

    # Enrich pendingHandoff with expiresInSeconds for accurate client countdown
    enriched_state = _enrich_pending_handoff(state)

    # Determine user's role
    my_role = None
    if state.get("activeCoach") and state["activeCoach"]["userId"] == user["id"]:
        my_role = "activeCoach"
    elif state.get("lineCoach") and state["lineCoach"]["userId"] == user["id"]:
        my_role = "lineCoach"

    # Check if there's a pending handoff for this user
    has_pending_for_me = (
        state.get("pendingHandoff") and
        state["pendingHandoff"]["currentHolderId"] == user["id"]
    )

    return {
        "state": enriched_state,
        "myRole": my_role,
        "hasPendingHandoffForMe": has_pending_for_me,
        "handoffTimeoutSeconds": HANDOFF_EXPIRY_SECONDS,
        "serverTime": datetime.now().isoformat()
    }


@router.post("/api/games/{game_id}/claim-active")
async def claim_active_coach(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    Claim the Active Coach role.

    If role is vacant or stale, claim immediately.
    If role is occupied, creates a handoff request (5-second timeout).

    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")

    # Get user's display name
    local_user = get_user(user["id"])
    display_name = local_user.get("displayName") if local_user else user.get("email", "Unknown")

    result = claim_role(game_id, "activeCoach", user["id"], display_name)

    if result["success"]:
        return {"status": "claimed", "role": "activeCoach", **result}

    # Role is occupied - request handoff
    handoff_result = request_handoff(game_id, "activeCoach", user["id"], display_name)

    if handoff_result["success"]:
        # Add expiresInSeconds for client countdown
        if handoff_result.get("handoff"):
            handoff_result["handoff"]["expiresInSeconds"] = _get_handoff_expires_in_seconds(handoff_result["handoff"])
        return {"status": "handoff_requested", "role": "activeCoach", **handoff_result}

    raise HTTPException(
        status_code=409,
        detail=handoff_result.get("reason", "Cannot claim role")
    )


@router.post("/api/games/{game_id}/claim-line")
async def claim_line_coach(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    Claim the Line Coach role.

    If role is vacant or stale, claim immediately.
    If role is occupied, creates a handoff request (5-second timeout).

    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")

    local_user = get_user(user["id"])
    display_name = local_user.get("displayName") if local_user else user.get("email", "Unknown")

    result = claim_role(game_id, "lineCoach", user["id"], display_name)

    if result["success"]:
        return {"status": "claimed", "role": "lineCoach", **result}

    # Role is occupied - request handoff
    handoff_result = request_handoff(game_id, "lineCoach", user["id"], display_name)

    if handoff_result["success"]:
        # Add expiresInSeconds for client countdown
        if handoff_result.get("handoff"):
            handoff_result["handoff"]["expiresInSeconds"] = _get_handoff_expires_in_seconds(handoff_result["handoff"])
        return {"status": "handoff_requested", "role": "lineCoach", **handoff_result}

    raise HTTPException(
        status_code=409,
        detail=handoff_result.get("reason", "Cannot claim role")
    )


@router.post("/api/games/{game_id}/release")
async def release_controller_role(
    game_id: str,
    role: Literal["activeCoach", "lineCoach"] = Body(..., embed=True),
    user: dict = Depends(require_game_team_coach)
):
    """
    Release a controller role.

    Requires: Coach access to the game's team and currently holding the role.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")

    result = release_role(game_id, role, user["id"])

    if result["success"]:
        return {"status": "released", "role": role, **result}

    raise HTTPException(
        status_code=400,
        detail=result.get("reason", "Cannot release role")
    )


@router.post("/api/games/{game_id}/handoff-response")
async def respond_handoff(
    game_id: str,
    accept: bool = Body(..., embed=True),
    user: dict = Depends(require_game_team_coach)
):
    """
    Accept or deny a pending handoff request.

    Only the current role holder can respond.
    If not responded within 5 seconds, the handoff auto-approves.

    Requires: Coach access and being the current holder of the requested role.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")

    result = respond_to_handoff(game_id, user["id"], accept)

    if result["success"]:
        action = "accepted" if accept else "denied"
        return {"status": action, **result}

    raise HTTPException(
        status_code=400,
        detail=result.get("reason", "Cannot respond to handoff")
    )


@router.post("/api/games/{game_id}/ping")
async def ping_controller(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    Ping to keep controller role(s) alive.

    Should be called every 2-5 seconds while holding a role.
    Roles expire after 30 seconds without a ping.

    If BOTH roles are unclaimed, auto-assigns both to this user.
    This makes the first coach to enter a game the default holder.

    Also returns current controller state and pending handoffs.

    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")

    # Get user's display name for potential auto-assignment
    local_user = get_user(user["id"])
    display_name = local_user.get("displayName") if local_user else user.get("email", "Unknown")

    # Auto-assign roles if both are unclaimed (first coach to enter gets both)
    state = auto_assign_roles_if_unclaimed(game_id, user["id"], display_name)

    # Record this coach as connected (even if they hold no role)
    record_coach_ping(game_id, user["id"], display_name)

    # Ping whichever role(s) the user holds
    pinged = []
    if state.get("activeCoach") and state["activeCoach"]["userId"] == user["id"]:
        ping_role(game_id, "activeCoach", user["id"])
        pinged.append("activeCoach")
    if state.get("lineCoach") and state["lineCoach"]["userId"] == user["id"]:
        ping_role(game_id, "lineCoach", user["id"])
        pinged.append("lineCoach")

    # Refresh state after pinging
    state = get_controller_state(game_id)

    # Enrich pendingHandoff with expiresInSeconds for accurate client countdown
    enriched_state = _enrich_pending_handoff(state)

    # Check for pending handoff for this user
    has_pending_for_me = (
        state.get("pendingHandoff") and
        state["pendingHandoff"]["currentHolderId"] == user["id"]
    )

    return {
        "status": "ok",
        "pinged": pinged,
        "controllerState": enriched_state,
        "hasPendingHandoffForMe": has_pending_for_me,
        "handoffTimeoutSeconds": HANDOFF_EXPIRY_SECONDS,
        "connectedCoaches": get_connected_coaches(game_id),
        "serverTime": datetime.now().isoformat()
    }
