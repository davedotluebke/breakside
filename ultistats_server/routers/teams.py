"""
Team endpoints: CRUD, members, roster, games, and active-game lookup.
"""
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from ._shared import (
    create_membership,
    delete_membership,
    get_game_current,
    get_optional_user,
    get_team,
    get_team_coaches,
    get_team_games,
    get_team_memberships,
    get_team_players,
    get_user,
    get_user_team_membership,
    get_user_teams,
    is_admin,
    list_teams,
    require_team_access,
    require_team_coach,
    save_team,
    team_exists,
    update_team,
)
from ._shared import delete_team as delete_team_storage
from .games import _enrich_game_with_activity

router = APIRouter()


# =============================================================================
# Team member endpoints
# =============================================================================

@router.get("/api/teams/{team_id}/members")
async def list_team_members(
    team_id: str,
    user: dict = Depends(require_team_access("team_id"))
):
    """
    List all members of a team with their roles.

    Requires: Coach or Viewer access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    memberships = get_team_memberships(team_id)

    # Enrich with user info
    members = []
    for membership in memberships:
        user_info = get_user(membership["userId"])
        members.append({
            "userId": membership["userId"],
            "membershipId": membership["id"],
            "role": membership["role"],
            "joinedAt": membership["joinedAt"],
            "displayName": user_info.get("displayName") if user_info else None,
            "email": user_info.get("email") if user_info else None,
        })

    return {"members": members, "count": len(members)}


@router.delete("/api/teams/{team_id}/members/{target_user_id}")
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

    Requires: Coach access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    # Check if target is a member
    target_membership = get_user_team_membership(target_user_id, team_id)
    if not target_membership:
        raise HTTPException(status_code=404, detail="User is not a member of this team")

    # Last coach protection
    if target_membership["role"] == "coach":
        coaches = get_team_coaches(team_id)
        if len(coaches) == 1 and target_user_id in coaches:
            raise HTTPException(
                status_code=400,
                detail="Cannot remove the last coach. Add another coach first, or delete the team."
            )

    delete_membership(target_membership["id"])

    return {
        "status": "removed",
        "userId": target_user_id,
        "teamId": team_id
    }


# =============================================================================
# Team endpoints
# =============================================================================

@router.post("/api/teams")
async def create_team(
    team_data: Dict[str, Any] = Body(...),
    user: Optional[dict] = Depends(get_optional_user)
):
    """
    Create a new team.

    If 'id' is provided in the body, it will be used (for offline-created teams).
    Otherwise, an ID will be generated from the name.

    If authenticated, the creator automatically becomes a Coach for the team.
    """
    if "name" not in team_data:
        raise HTTPException(status_code=400, detail="Team name is required")

    # Check if client provided an ID (offline creation)
    provided_id = team_data.get('id')

    # If ID was provided and already exists, this is an update/sync
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
            pass  # Membership already exists (shouldn't happen for new teams)

    return {"status": "created", "team_id": team_id, "team": get_team(team_id)}


@router.get("/api/teams")
async def list_teams_endpoint(user: Optional[dict] = Depends(get_optional_user)):
    """
    List all teams.

    Returns only teams the user has access to.
    Anonymous users get an empty list.
    """
    all_teams = list_teams()

    if not user:
        return {"teams": [], "count": 0}

    # Admin sees all
    if is_admin(user["id"]):
        return {"teams": all_teams, "count": len(all_teams)}

    # Filter to accessible teams
    accessible_team_ids = set(get_user_teams(user["id"]))
    filtered = [t for t in all_teams if t.get("id") in accessible_team_ids]

    return {"teams": filtered, "count": len(filtered)}


@router.get("/api/teams/{team_id}")
async def get_team_endpoint(team_id: str, user: dict = Depends(require_team_access("team_id"))):
    """
    Get a team by ID.

    Requires: Coach or Viewer access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    return get_team(team_id)


@router.put("/api/teams/{team_id}")
async def update_team_endpoint(
    team_id: str,
    team_data: Dict[str, Any] = Body(...),
    user: dict = Depends(require_team_coach("team_id"))
):
    """
    Update a team.

    Requires: Coach access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    update_team(team_id, team_data)
    return {"status": "updated", "team_id": team_id, "team": get_team(team_id)}


@router.delete("/api/teams/{team_id}")
async def delete_team_endpoint(team_id: str, user: dict = Depends(require_team_coach("team_id"))):
    """
    Delete a team.

    Requires: Coach access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    delete_team_storage(team_id)
    return {"status": "deleted", "team_id": team_id}


@router.get("/api/teams/{team_id}/players")
async def get_team_players_endpoint(team_id: str, user: dict = Depends(require_team_access("team_id"))):
    """
    Get all players for a team (resolved from playerIds).

    Requires: Coach or Viewer access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    players = get_team_players(team_id)
    return {"team_id": team_id, "players": players, "count": len(players)}


@router.get("/api/teams/{team_id}/games")
async def get_team_games_endpoint(team_id: str, user: dict = Depends(require_team_access("team_id"))):
    """
    Get all games for a team.

    Requires: Coach or Viewer access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    game_ids = get_team_games(team_id)
    return {"team_id": team_id, "game_ids": game_ids, "count": len(game_ids)}


@router.get("/api/teams/{team_id}/active-game")
async def get_team_active_game(team_id: str, user: dict = Depends(require_team_access("team_id"))):
    """
    Get the currently active game for a team.

    A game is considered active if it:
    - Has at least one point
    - Has no gameEndTimestamp
    - Was started within the last 6 hours

    Returns the most recently started active game, or 404 if none.
    Requires: Coach or Viewer access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    game_ids = get_team_games(team_id)
    six_hours_ago = datetime.now().timestamp() - (6 * 60 * 60)

    active_games = []
    for game_id in game_ids:
        try:
            game_data = get_game_current(game_id)
        except FileNotFoundError:
            continue

        # Must have at least one point
        points = game_data.get("points", [])
        if len(points) == 0:
            continue

        # Must not have ended
        if game_data.get("gameEndTimestamp"):
            continue

        # Must have started within 6 hours
        start_ts = game_data.get("gameStartTimestamp")
        if not start_ts:
            continue
        try:
            start_epoch = datetime.fromisoformat(start_ts).timestamp()
            if start_epoch < six_hours_ago:
                continue
        except (ValueError, TypeError):
            continue

        summary = {
            "game_id": game_id,
            "team": game_data.get("team", "Unknown"),
            "teamId": game_data.get("teamId"),
            "opponent": game_data.get("opponent", "Unknown"),
            "game_start_timestamp": start_ts,
            "scores": game_data.get("scores", {}),
            "points_count": len(points),
        }
        _enrich_game_with_activity(summary)
        active_games.append(summary)

    if not active_games:
        raise HTTPException(status_code=404, detail=f"No active game found for team {team_id}")

    # Return the most recently started game
    active_games.sort(key=lambda g: g.get("game_start_timestamp", ""), reverse=True)
    return active_games[0]
