"""
Player endpoints.

Player records are private: reads require membership of a team the player is
on; writes require coach access (see auth.dependencies).
"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from ._shared import (
    assert_player_edit_access,
    get_current_user,
    get_optional_user,
    get_player,
    get_player_games,
    get_player_teams,
    get_team,
    get_team_players,
    get_user_teams,
    is_admin,
    list_players,
    player_exists,
    require_player_edit_access,
    require_player_read_access,
    save_player,
    update_player,
    validate_id,
)
from ._shared import delete_player as delete_player_storage

router = APIRouter()


@router.post("/api/players")
async def create_player(
    player_data: Dict[str, Any] = Body(...),
    user: dict = Depends(get_current_user)
):
    """
    Create a new player.

    If 'id' is provided in the body, it will be used (for offline-created players).
    Otherwise, an ID will be generated from the name.

    Requires: Coach access. Supplying an existing player's `id` overwrites
    that player, so the caller must be a Coach of a team that player is on
    (closing the hole where any authed user could overwrite any player).
    """
    if "name" not in player_data:
        raise HTTPException(status_code=400, detail="Player name is required")

    # Check if client provided an ID (offline creation)
    provided_id = player_data.get('id')
    if provided_id:
        validate_id(provided_id, "player id")

    # Authorize: overwriting an existing player requires edit access to it;
    # creating a brand-new player requires being a coach of some team.
    assert_player_edit_access(
        user,
        provided_id if (provided_id and player_exists(provided_id)) else None,
    )

    # If ID was provided and already exists, this is an update/sync
    if provided_id and player_exists(provided_id):
        update_player(provided_id, player_data)
        return {"status": "updated", "player_id": provided_id, "player": get_player(provided_id)}

    player_id = save_player(player_data, provided_id)
    return {"status": "created", "player_id": player_id, "player": get_player(player_id)}


@router.get("/api/players")
async def list_players_endpoint(user: Optional[dict] = Depends(get_optional_user)):
    """
    List players visible to the caller.

    Player records are private: returns only players on teams the user has
    access to. Admins see all; anonymous callers get an empty list.
    """
    if not user:
        return {"players": [], "count": 0}

    if is_admin(user["id"]):
        players = list_players()
        return {"players": players, "count": len(players)}

    # Union of rosters across teams the user is a member of (coach or viewer).
    seen: Dict[str, dict] = {}
    for team_id in get_user_teams(user["id"]):
        try:
            for player in get_team_players(team_id):
                pid = player.get("id")
                if pid:
                    seen[pid] = player
        except FileNotFoundError:
            continue

    players = sorted(seen.values(), key=lambda p: p.get("name", "").lower())
    return {"players": players, "count": len(players)}


@router.get("/api/players/{player_id}")
async def get_player_endpoint(player_id: str, user: dict = Depends(require_player_read_access)):
    """
    Get a player by ID.

    Requires: membership (coach or viewer) of a team the player is on.
    """
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")

    return get_player(player_id)


@router.put("/api/players/{player_id}")
async def update_player_endpoint(
    player_id: str,
    player_data: Dict[str, Any] = Body(...),
    user: dict = Depends(require_player_edit_access)
):
    """
    Update a player.

    Requires: Coach access to a team that has this player on the roster.
    """
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")

    update_player(player_id, player_data)
    return {"status": "updated", "player_id": player_id, "player": get_player(player_id)}


@router.delete("/api/players/{player_id}")
async def delete_player_endpoint(player_id: str, user: dict = Depends(require_player_edit_access)):
    """
    Delete a player.

    Requires: Coach access to a team that has this player on the roster.
    """
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")

    delete_player_storage(player_id)
    return {"status": "deleted", "player_id": player_id}


@router.get("/api/players/{player_id}/games")
async def get_player_games_endpoint(player_id: str, user: dict = Depends(require_player_read_access)):
    """
    Get all games a player has participated in.

    Requires: membership (coach or viewer) of a team the player is on.
    """
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")

    game_ids = get_player_games(player_id)
    return {"player_id": player_id, "game_ids": game_ids, "count": len(game_ids)}


@router.get("/api/players/{player_id}/teams")
async def get_player_teams_endpoint(player_id: str, user: dict = Depends(require_player_read_access)):
    """
    Get all teams a player belongs to.

    Requires: membership (coach or viewer) of a team the player is on.
    """
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")

    team_ids = get_player_teams(player_id)

    # Resolve team IDs to team data
    teams_data = []
    for team_id in team_ids:
        try:
            team = get_team(team_id)
            teams_data.append(team)
        except FileNotFoundError:
            continue

    return {"player_id": player_id, "teams": teams_data, "count": len(teams_data)}
