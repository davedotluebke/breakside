"""
Game endpoints: sync, retrieval, listing, metadata, deletion, and versions.

Note: All API routes use /api/ prefix to avoid conflicts with PWA static file
serving.
"""
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from ._shared import (
    add_game_to_event,
    delete_game,
    event_exists,
    game_exists,
    get_controller_state,
    get_game_current,
    get_game_version,
    get_optional_user,
    get_recent_activity,
    get_user_teams,
    is_admin,
    list_all_games,
    list_game_versions,
    require_game_team_access,
    require_game_team_coach,
    save_game_version,
    update_game_metadata,
    validate_id,
)

router = APIRouter()


@router.post("/api/games/{game_id}/sync")
async def sync_game(
    game_id: str,
    game_data: Dict[str, Any] = Body(...),
    user: dict = Depends(require_game_team_coach)
):
    """
    Full game sync - replaces entire game state.
    Idempotent: can be called multiple times safely.

    Creates a new version on each sync.

    Requires: Coach access to the game's team.
    """
    # Basic validation
    if not isinstance(game_data, dict):
        raise HTTPException(status_code=400, detail="Invalid game data: must be a dictionary")

    if "team" not in game_data or "opponent" not in game_data:
        raise HTTPException(status_code=400, detail="Invalid game data: missing team or opponent")

    # If game has an eventId, add game to event's gameIds (idempotent)
    event_id = game_data.get('eventId')
    if event_id and event_exists(event_id):
        try:
            add_game_to_event(event_id, game_id)
        except Exception as e:
            # Non-fatal: log but don't fail the sync
            print(f"Warning: could not add game {game_id} to event {event_id}: {e}")

    # Determine whether this writer owns the game's play data. The Active
    # Coach owns points/scores/events; a Line Coach (or any other coach)
    # syncing while someone else holds the Active Coach role may only
    # contribute line selections — their possibly-stale game data must not
    # roll back the Active Coach's recorded play. With no Active Coach claimed
    # (solo coaching), the writer is authoritative.
    authoritative = True
    try:
        active_coach = get_controller_state(game_id).get("activeCoach")
        if active_coach and active_coach.get("userId") != user.get("id"):
            authoritative = False
    except Exception:
        authoritative = True

    # Save with versioning. Run off the event loop: the storage write does
    # fsync'd file I/O (and optional blocking git subprocess calls) that would
    # otherwise stall the whole single-worker server during every sync.
    version_file = await run_in_threadpool(
        save_game_version, game_id, game_data,
        authoritative_game_data=authoritative,
    )
    version_timestamp = Path(version_file).stem

    return {
        "status": "synced",
        "game_id": game_id,
        "version": version_timestamp,
        "timestamp": datetime.now().isoformat()
    }


@router.get("/api/games/{game_id}")
async def get_game(game_id: str, user: dict = Depends(require_game_team_access)):
    """
    Get current game state.

    Requires: Coach or Viewer access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")

    game_data = get_game_current(game_id)
    return game_data


def _enrich_game_with_activity(game: dict) -> None:
    """Enrich a game dict with lastActivity and activeCoaches from controller state."""
    game_id = game.get("game_id")
    if not game_id:
        return

    last_activity, active_coaches = get_recent_activity(game_id)
    game["lastActivity"] = last_activity
    game["activeCoaches"] = active_coaches


@router.get("/api/games")
async def list_games_endpoint(user: Optional[dict] = Depends(get_optional_user)):
    """
    List all games with metadata.

    Returns only games for teams the user has access to.
    Anonymous users get an empty list.

    Includes activity info: lastActivity timestamp and activeCoaches list
    for games with recent controller activity (within 5 minutes).
    """
    all_games = list_all_games()

    if not user:
        return {"games": [], "count": 0}

    # Enrich games with activity info from controller state
    for game in all_games:
        _enrich_game_with_activity(game)

    # Admin sees all
    if is_admin(user["id"]):
        return {"games": all_games, "count": len(all_games)}

    # Filter to accessible teams
    accessible_teams = set(get_user_teams(user["id"]))
    filtered = [g for g in all_games if g.get("teamId") in accessible_teams]

    return {"games": filtered, "count": len(filtered)}


@router.patch("/api/games/{game_id}/phase")
async def patch_game_phase(
    game_id: str,
    body: dict,
    user: dict = Depends(require_game_team_coach)
):
    """
    Update only the `phase` label on a game (retroactive labeling within
    an event). Does not create a new version backup — phase is metadata.

    Body: { "phase": "Day 1" | null }
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    phase = body.get("phase")
    if phase is not None and not isinstance(phase, str):
        raise HTTPException(status_code=400, detail="phase must be a string or null")
    updated = update_game_metadata(game_id, {"phase": phase})
    return {"status": "updated", "game_id": game_id, "phase": updated.get("phase")}


@router.delete("/api/games/{game_id}")
async def delete_game_endpoint(game_id: str, user: dict = Depends(require_game_team_coach)):
    """
    Delete a game and all its versions.

    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")

    deleted = delete_game(game_id)
    if deleted:
        return {"status": "deleted", "game_id": game_id}
    else:
        raise HTTPException(status_code=500, detail="Failed to delete game")


# Version endpoints

@router.get("/api/games/{game_id}/versions")
async def list_versions(game_id: str, user: dict = Depends(require_game_team_access)):
    """
    List all versions of a game.

    Requires: Coach or Viewer access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")

    versions = list_game_versions(game_id)
    return {"game_id": game_id, "versions": versions}


@router.get("/api/games/{game_id}/versions/{timestamp}")
async def get_version(game_id: str, timestamp: str, user: dict = Depends(require_game_team_access)):
    """
    Get specific version of a game.

    Requires: Coach or Viewer access to the game's team.
    """
    validate_id(timestamp, "timestamp")
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")

    try:
        game_data = get_game_version(game_id, timestamp)
        return game_data
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Version {timestamp} not found")


@router.post("/api/games/{game_id}/restore/{timestamp}")
async def restore_version(game_id: str, timestamp: str, user: dict = Depends(require_game_team_coach)):
    """
    Restore game to a specific version.

    Requires: Coach access to the game's team.
    """
    validate_id(timestamp, "timestamp")
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")

    try:
        game_data = get_game_version(game_id, timestamp)
        await run_in_threadpool(save_game_version, game_id, game_data)
        return {"status": "restored", "game_id": game_id, "timestamp": timestamp}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Version {timestamp} not found")
