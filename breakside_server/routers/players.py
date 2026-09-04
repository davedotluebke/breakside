"""
Player endpoints.

Player records are private: reads require membership of a team the player is
on; writes require coach access (see auth.dependencies).
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from ._shared import (
    ErasureBlocked,
    assert_player_edit_access,
    erase_player,
    get_current_user,
    get_optional_user,
    get_player,
    get_player_games,
    get_player_teams,
    get_team,
    get_team_players,
    get_user_teams,
    is_admin,
    is_player_erased,
    link_player_to_team,
    list_players,
    player_exists,
    require_player_edit_access,
    require_player_erase_access,
    require_player_read_access,
    save_player,
    update_player,
    validate_id,
)
from ._shared import delete_player as delete_player_storage

logger = logging.getLogger(__name__)

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

    An optional `teamId` names the team the player is being added to. When
    present the caller must Coach it, and the player is linked to it
    immediately — otherwise the record sits with no team until the separate
    team sync lands, and anything teamless reads as an orphan to the
    authorization layer. Older clients omit it and still work; they fall back
    to `createdBy` scoping.
    """
    if "name" not in player_data:
        raise HTTPException(status_code=400, detail="Player name is required")

    # Check if client provided an ID (offline creation)
    provided_id = player_data.get('id')
    if provided_id:
        validate_id(provided_id, "player id")

    # Erasure guard. store/sync.js re-POSTs whole entities from its offline
    # queue ("POST handles both create and update via ID"), so a device that
    # has not synced since an erasure would recreate the record here — ID,
    # name and all — and nothing would report it. 410 Gone rather than 403:
    # the resource is deliberately and permanently absent, and the client's
    # queue retries a few times and then dead-letters the item (see
    # store/sync.js quarantineSyncItem), which is the behavior we want.
    if provided_id and is_player_erased(provided_id):
        raise HTTPException(
            status_code=410,
            detail="This player was permanently erased and cannot be recreated."
        )

    claimed_team_id = player_data.get('teamId')
    if claimed_team_id:
        validate_id(claimed_team_id, "team id")

    is_update = bool(provided_id and player_exists(provided_id))
    existing = get_player(provided_id) if is_update else None

    # Authorize: overwriting an existing player requires edit access to it;
    # creating a brand-new player requires being a coach of the claimed team
    # (or, with no teamId, of some team).
    assert_player_edit_access(
        user,
        provided_id if is_update else None,
        claimed_team_id=claimed_team_id if not is_update else None,
        created_by=(existing or {}).get("createdBy"),
    )

    if is_update:
        # createdBy is server-owned: never let a body rewrite who created a
        # record, since that is what grants access to a teamless one.
        if existing.get("createdBy"):
            player_data["createdBy"] = existing["createdBy"]
        else:
            player_data.pop("createdBy", None)
        update_player(provided_id, player_data)
        if claimed_team_id:
            link_player_to_team(provided_id, claimed_team_id)
        return {"status": "updated", "player_id": provided_id, "player": get_player(provided_id)}

    player_data["createdBy"] = user["id"]
    player_id = save_player(player_data, provided_id)
    if claimed_team_id:
        link_player_to_team(player_id, claimed_team_id)
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


# =============================================================================
# Erasure — true deletion, as opposed to DELETE above
# =============================================================================
#
# DELETE /api/players/{id} removes the player's own record and nothing else:
# their name stays in every game that referenced them, and because entity IDs
# embed the name (``Alice-7f3a``), so does their identity. These two endpoints
# are the ones that actually erase a person. See storage/erasure.py.


def _erasure_response(result: dict, key: str) -> dict:
    """Shape a storage-layer erasure result for the API.

    ``key`` is "willErase" for a preview and "erased" for the real thing —
    identical contents, so the confirm dialog and the receipt can be rendered
    by the same code, and a user can see that what they were promised is what
    happened.
    """
    return {
        key: result["counts"],
        "warnings": result["warnings"],
        "playerId": result["playerId"],
        "tombstoneId": result["tombstoneId"],
    }


@router.get("/api/players/{player_id}/erase-preview")
async def preview_erase_player(
    player_id: str,
    user: dict = Depends(require_player_erase_access)
):
    """
    Report exactly what erasing this player would destroy. Mutates nothing.

    Runs the identical traversal the erasure runs, with writes disabled, so the
    counts cannot disagree with what follows. Reading every version backup is
    the only way to count them honestly, so this is not a cheap call — measured
    at ~4s against a production-sized corpus (6,800 version files, 370MB), which
    is why it runs off the event loop. The server is single-worker by
    construction (see main.py), so a synchronous call here would stall every
    other request for the duration.

    Requires: Coach access to a team this player is on.
    """
    result = await run_in_threadpool(erase_player, player_id, dry_run=True)
    return _erasure_response(result, "willErase")


@router.post("/api/players/{player_id}/erase")
async def erase_player_endpoint(
    player_id: str,
    user: dict = Depends(require_player_erase_access)
):
    """
    Permanently erase a player. **Irreversible — there is no undo.**

    Deletes the player record and rewrites every reference to them — team
    rosters and lines, tournament-event rosters, each game's current state and
    every one of its version backups — to an opaque tombstone. The person is
    also added to the erasure deny-list so a client that has not synced since
    cannot push them back.

    Idempotent: re-running returns zero counts rather than an error.

    Runs off the event loop: rewriting a player out of a production-sized
    corpus was measured at ~14s (6,800 version files, worst case where the
    player appears in every one), and the server is single-worker.

    Requires: Coach access to a team this player is on.
    """
    try:
        result = await run_in_threadpool(erase_player, player_id)
    except ErasureBlocked as exc:
        # Refused before touching anything, so nothing is half-erased. 409:
        # the request is valid, the server's state (file ownership) is not.
        logger.error("Player erasure refused for %s: %s", player_id, exc)
        raise HTTPException(
            status_code=409,
            detail=(
                "Erasure refused: some stored files are in unwritable "
                "directories, so the player could not be erased everywhere. "
                "Nothing was changed. Fix the directory ownership and retry."
            ),
        )
    logger.info(
        "ERASED player %s -> %s: %s", player_id, result["tombstoneId"],
        result["counts"],
    )
    return _erasure_response(result, "erased")
