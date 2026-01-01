"""
Main FastAPI application for the Ultistats server.
"""
from fastapi import FastAPI, HTTPException, Body, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import Dict, Any, List, Optional, Literal
from datetime import datetime

# Import config - handle both relative and absolute imports
try:
    from config import HOST, PORT, DEBUG, ALLOWED_ORIGINS, AUTH_REQUIRED
    from storage import (
        # Game storage
        save_game_version,
        get_game_current,
        get_game_version,
        list_game_versions,
        game_exists,
        delete_game,
        list_all_games,
        # Player storage
        save_player,
        get_player,
        list_players,
        update_player,
        delete_player as delete_player_storage,
        player_exists,
        # Team storage
        save_team,
        get_team,
        list_teams,
        update_team,
        delete_team as delete_team_storage,
        team_exists,
        get_team_players,
        # Index storage
        rebuild_index,
        get_index_status,
        get_player_games,
        get_team_games,
        # User storage
        get_user,
        create_or_update_user,
        update_user as update_user_storage,
        list_users,
        # Membership storage
        get_user_memberships,
        get_team_memberships,
        get_user_team_role,
        get_user_teams,
        create_membership,
        # Share storage
        get_share,
        get_share_by_hash,
        is_share_valid,
        create_share_link,
        list_game_shares,
        revoke_share,
        # Invite storage
        get_invite,
        get_invite_by_code,
        is_invite_valid,
        get_invite_validity_reason,
        create_invite,
        list_team_invites,
        redeem_invite,
        revoke_invite as revoke_invite_storage,
        # Membership storage (additional)
        delete_membership,
        get_user_team_membership,
        get_team_coaches,
        # Controller storage (in-memory)
        get_controller_state,
        claim_role,
        request_handoff,
        respond_to_handoff,
        release_role,
        ping_role,
        clear_game_state,
        HANDOFF_EXPIRY_SECONDS,
    )
    from auth import (
        get_current_user,
        get_optional_user,
        is_admin,
        require_admin,
        require_team_coach,
        require_team_access,
        require_game_team_coach,
        require_game_team_access,
        require_player_edit_access,
    )
except ImportError:
    # Try absolute import (when running as package)
    from ultistats_server.config import HOST, PORT, DEBUG, ALLOWED_ORIGINS, AUTH_REQUIRED
    from ultistats_server.storage import (
        # Game storage
        save_game_version,
        get_game_current,
        get_game_version,
        list_game_versions,
        game_exists,
        delete_game,
        list_all_games,
        # Player storage
        save_player,
        get_player,
        list_players,
        update_player,
        delete_player as delete_player_storage,
        player_exists,
        # Team storage
        save_team,
        get_team,
        list_teams,
        update_team,
        delete_team as delete_team_storage,
        team_exists,
        get_team_players,
        # Index storage
        rebuild_index,
        get_index_status,
        get_player_games,
        get_team_games,
        # User storage
        get_user,
        create_or_update_user,
        update_user as update_user_storage,
        list_users,
        # Membership storage
        get_user_memberships,
        get_team_memberships,
        get_user_team_role,
        get_user_teams,
        create_membership,
        # Share storage
        get_share,
        get_share_by_hash,
        is_share_valid,
        create_share_link,
        list_game_shares,
        revoke_share,
        # Invite storage
        get_invite,
        get_invite_by_code,
        is_invite_valid,
        get_invite_validity_reason,
        create_invite,
        list_team_invites,
        redeem_invite,
        revoke_invite as revoke_invite_storage,
        # Membership storage (additional)
        delete_membership,
        get_user_team_membership,
        get_team_coaches,
        # Controller storage (in-memory)
        get_controller_state,
        claim_role,
        request_handoff,
        respond_to_handoff,
        release_role,
        ping_role,
        clear_game_state,
        HANDOFF_EXPIRY_SECONDS,
    )
    from ultistats_server.auth import (
        get_current_user,
        get_optional_user,
        is_admin,
        require_admin,
        require_team_coach,
        require_team_access,
        require_game_team_coach,
        require_game_team_access,
        require_player_edit_access,
    )

# Create FastAPI app
app = FastAPI(
    title="Ultistats API",
    description="API for the Ultistats PWA - Ultimate Frisbee Statistics Tracker",
    version="1.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files (viewer, etc.) - html=True enables serving index.html for directories
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir), html=True), name="static")

# Mount PWA files from parent directory (the main ultistats app)
pwa_dir = Path(__file__).parent.parent
pwa_static_files = ["main.css", "main.js", "manifest.json", "service-worker.js", "version.json"]
pwa_static_dirs = ["data", "game", "playByPlay", "screens", "teams", "ui", "utils", "images", "auth", "landing", "store"]

# Landing page directory
landing_dir = pwa_dir / "landing"

@app.get("/")
async def root():
    """Serve the PWA index.html at root (redirects to /ultistats/ for PWA compatibility)"""
    index_file = pwa_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    return {
        "message": "Ultistats API Server",
        "version": "1.0.0",
        "status": "running"
    }

# =============================================================================
# PWA app routes (primary PWA access point)
# =============================================================================

@app.get("/app/")
@app.get("/app/index.html")
async def app_page():
    """Serve the PWA at /app/ (main entry point for the app)."""
    index_file = pwa_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    raise HTTPException(status_code=404, detail="PWA not found")


@app.get("/app/{filename:path}")
async def serve_app_file(filename: str):
    """Serve PWA files under /app/ path."""
    file_path = pwa_dir / filename
    
    # Check if it's a known static file or in a known directory
    first_part = filename.split('/')[0] if '/' in filename else filename
    
    if first_part in pwa_static_files or first_part in pwa_static_dirs:
        if file_path.exists() and file_path.is_file():
            # Determine media type
            suffix = file_path.suffix.lower()
            media_types = {
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.json': 'application/json',
                '.html': 'text/html',
                '.png': 'image/png',
                '.ico': 'image/x-icon',
                '.webmanifest': 'application/manifest+json',
            }
            media_type = media_types.get(suffix, 'application/octet-stream')
            return FileResponse(file_path, media_type=media_type)
    
    raise HTTPException(status_code=404, detail="File not found")


# =============================================================================
# Landing page routes
# =============================================================================

# =============================================================================
# Join page route (invite redemption)
# =============================================================================

@app.get("/join/{code}")
async def join_page(code: str):
    """
    Serve the join page for invite redemption.
    
    The code is passed via URL path and read by the JavaScript.
    """
    join_file = landing_dir / "join.html"
    if join_file.exists():
        return FileResponse(join_file, media_type="text/html")
    raise HTTPException(status_code=404, detail="Join page not found")


@app.get("/landing/")
@app.get("/landing/index.html")
async def landing_page():
    """Serve the landing page with login UI."""
    index_file = landing_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    raise HTTPException(status_code=404, detail="Landing page not found")


@app.get("/landing/{filename:path}")
async def serve_landing_file(filename: str):
    """Serve landing page static files."""
    file_path = landing_dir / filename
    
    if file_path.exists() and file_path.is_file():
        suffix = file_path.suffix.lower()
        media_types = {
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.html': 'text/html',
            '.png': 'image/png',
            '.ico': 'image/x-icon',
        }
        media_type = media_types.get(suffix, 'application/octet-stream')
        return FileResponse(file_path, media_type=media_type)
    
    raise HTTPException(status_code=404, detail="File not found")


# =============================================================================
# Viewer redirect (user-friendly URL)
# =============================================================================

@app.get("/viewer/")
@app.get("/viewer")
async def viewer_redirect():
    """Redirect /viewer/ to the static viewer."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/static/viewer/", status_code=302)


# =============================================================================
# PWA routes under /ultistats/ (matches production path and manifest.json)
# =============================================================================

@app.get("/ultistats/")
@app.get("/ultistats/index.html")
async def ultistats_root():
    """Serve the PWA index.html under /ultistats/ path (for PWA install)"""
    index_file = pwa_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    raise HTTPException(status_code=404, detail="index.html not found")

@app.get("/ultistats/{filename:path}")
async def serve_ultistats_file(filename: str):
    """Serve PWA files under /ultistats/ path."""
    file_path = pwa_dir / filename
    
    # Check if it's a known static file or in a known directory
    first_part = filename.split('/')[0] if '/' in filename else filename
    
    if first_part in pwa_static_files or first_part in pwa_static_dirs:
        if file_path.exists() and file_path.is_file():
            # Determine media type
            suffix = file_path.suffix.lower()
            media_types = {
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.json': 'application/json',
                '.html': 'text/html',
                '.png': 'image/png',
                '.ico': 'image/x-icon',
                '.webmanifest': 'application/manifest+json',
            }
            media_type = media_types.get(suffix, 'application/octet-stream')
            return FileResponse(file_path, media_type=media_type)
    
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/api")
async def api_info():
    """API information endpoint."""
    return {
        "message": "Ultistats API Server",
        "version": "1.0.0",
        "status": "running"
    }

# Health check
@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy"}


# =============================================================================
# Authentication endpoints
# =============================================================================

@app.get("/api/auth/me")
async def get_current_user_info(user: dict = Depends(get_current_user)):
    """
    Get the current authenticated user's info.
    
    This endpoint validates the JWT and returns user information.
    It also syncs the user to our local storage if they don't exist yet.
    """
    # Sync user to our local storage (creates if doesn't exist)
    local_user = create_or_update_user(
        user_id=user["id"],
        email=user["email"],
        display_name=user.get("user_metadata", {}).get("full_name")
    )
    
    # Get their team memberships
    memberships = get_user_memberships(user["id"])
    
    return {
        "id": local_user["id"],
        "email": local_user["email"],
        "displayName": local_user["displayName"],
        "isAdmin": local_user.get("isAdmin", False),
        "createdAt": local_user["createdAt"],
        "memberships": memberships,
    }


@app.patch("/api/auth/me")
async def update_current_user(
    updates: Dict[str, Any] = Body(...),
    user: dict = Depends(get_current_user)
):
    """
    Update the current user's profile.
    
    Allowed fields: displayName
    """
    # Only allow updating certain fields
    allowed_fields = {"displayName"}
    filtered_updates = {k: v for k, v in updates.items() if k in allowed_fields}
    
    if not filtered_updates:
        raise HTTPException(
            status_code=400,
            detail=f"No valid fields to update. Allowed: {allowed_fields}"
        )
    
    updated_user = update_user_storage(user["id"], filtered_updates)
    if not updated_user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return {
        "status": "updated",
        "user": {
            "id": updated_user["id"],
            "email": updated_user["email"],
            "displayName": updated_user["displayName"],
        }
    }


@app.get("/api/auth/sync-check")
async def get_sync_status(user: dict = Depends(get_current_user)):
    """
    Lightweight endpoint to check if there are updates to sync.
    
    Returns summary info (counts and latest timestamps) that client can
    compare with local state to decide whether to do a full sync.
    """
    memberships = get_user_memberships(user["id"])
    
    team_count = 0
    latest_team_update = None
    latest_player_update = None
    total_player_count = 0
    
    for membership in memberships:
        try:
            team = get_team(membership["teamId"])
            team_count += 1
            
            # Track latest team update
            team_updated = team.get("updatedAt")
            if team_updated:
                if latest_team_update is None or team_updated > latest_team_update:
                    latest_team_update = team_updated
            
            # Count players and check their update times
            player_ids = team.get("playerIds", [])
            total_player_count += len(player_ids)
            
            # Check player update timestamps
            for player_id in player_ids:
                try:
                    player = get_player(player_id)
                    player_updated = player.get("updatedAt")
                    if player_updated:
                        if latest_player_update is None or player_updated > latest_player_update:
                            latest_player_update = player_updated
                except (FileNotFoundError, KeyError):
                    continue
            
        except (FileNotFoundError, KeyError):
            continue
    
    # Combine latest updates
    latest_update = latest_team_update
    if latest_player_update:
        if latest_update is None or latest_player_update > latest_update:
            latest_update = latest_player_update
    
    return {
        "teamCount": team_count,
        "playerCount": total_player_count,
        "latestTeamUpdate": latest_team_update,
        "latestPlayerUpdate": latest_player_update,
        "latestUpdate": latest_update,
        "serverTime": datetime.now().isoformat(),
    }


@app.get("/api/auth/teams")
async def get_user_teams_endpoint(user: dict = Depends(get_current_user)):
    """
    Get all teams the current user has access to.
    
    Returns teams with the user's role for each.
    """
    memberships = get_user_memberships(user["id"])
    
    teams_with_roles = []
    for membership in memberships:
        try:
            team = get_team(membership["teamId"])
            teams_with_roles.append({
                "team": team,
                "role": membership["role"],
                "joinedAt": membership["joinedAt"],
            })
        except (FileNotFoundError, KeyError):
            # Team may have been deleted
            continue
    
    return {
        "teams": teams_with_roles,
        "count": len(teams_with_roles)
    }


# =============================================================================
# Game endpoints
# Note: All API routes use /api/ prefix to avoid conflicts with PWA static file serving

@app.post("/api/games/{game_id}/sync")
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
    
    # Save with versioning
    version_file = save_game_version(game_id, game_data)
    version_timestamp = Path(version_file).stem
    
    return {
        "status": "synced",
        "game_id": game_id,
        "version": version_timestamp,
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/games/{game_id}")
async def get_game(game_id: str, user: dict = Depends(require_game_team_access)):
    """
    Get current game state.
    
    Requires: Coach or Viewer access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    game_data = get_game_current(game_id)
    return game_data


@app.get("/api/games")
async def list_games_endpoint(user: Optional[dict] = Depends(get_optional_user)):
    """
    List all games with metadata.
    
    Returns only games for teams the user has access to.
    Anonymous users get an empty list.
    """
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


@app.delete("/api/games/{game_id}")
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

@app.get("/api/games/{game_id}/versions")
async def list_versions(game_id: str, user: dict = Depends(require_game_team_access)):
    """
    List all versions of a game.
    
    Requires: Coach or Viewer access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    versions = list_game_versions(game_id)
    return {"game_id": game_id, "versions": versions}


@app.get("/api/games/{game_id}/versions/{timestamp}")
async def get_version(game_id: str, timestamp: str, user: dict = Depends(require_game_team_access)):
    """
    Get specific version of a game.
    
    Requires: Coach or Viewer access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    try:
        game_data = get_game_version(game_id, timestamp)
        return game_data
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Version {timestamp} not found")


@app.post("/api/games/{game_id}/restore/{timestamp}")
async def restore_version(game_id: str, timestamp: str, user: dict = Depends(require_game_team_coach)):
    """
    Restore game to a specific version.
    
    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    try:
        game_data = get_game_version(game_id, timestamp)
        save_game_version(game_id, game_data)
        return {"status": "restored", "game_id": game_id, "timestamp": timestamp}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Version {timestamp} not found")


# =============================================================================
# Game Controller Endpoints (Active Coach / Line Coach)
# =============================================================================

def _enrich_pending_handoff(state: dict) -> dict:
    """
    Add expiresInSeconds to pendingHandoff for accurate client-side countdown.
    Returns a copy of state with the enriched handoff.
    """
    if not state.get("pendingHandoff"):
        return state
    
    # Calculate remaining seconds until expiry
    try:
        expires_at = datetime.fromisoformat(state["pendingHandoff"]["expiresAt"])
        remaining = (expires_at - datetime.now()).total_seconds()
        remaining = max(0, remaining)  # Don't return negative
    except (ValueError, KeyError):
        remaining = HANDOFF_EXPIRY_SECONDS  # Fallback
    
    # Create enriched copy
    enriched_state = dict(state)
    enriched_state["pendingHandoff"] = dict(state["pendingHandoff"])
    enriched_state["pendingHandoff"]["expiresInSeconds"] = round(remaining, 1)
    
    return enriched_state


@app.get("/api/games/{game_id}/controller")
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


@app.post("/api/games/{game_id}/claim-active")
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


@app.post("/api/games/{game_id}/claim-line")
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


@app.post("/api/games/{game_id}/release")
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


@app.post("/api/games/{game_id}/handoff-response")
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


@app.post("/api/games/{game_id}/ping")
async def ping_controller(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    Ping to keep controller role(s) alive.
    
    Should be called every 2-5 seconds while holding a role.
    Roles expire after 30 seconds without a ping.
    
    Also returns current controller state and pending handoffs.
    
    Requires: Coach access to the game's team.
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
        "serverTime": datetime.now().isoformat()
    }


# =============================================================================
# Share link endpoints
# =============================================================================

@app.post("/api/games/{game_id}/share")
async def create_game_share(
    game_id: str,
    expires_days: int = Query(default=7, ge=1, le=365),
    user: dict = Depends(require_game_team_coach)
):
    """
    Create a share link for a game.
    
    Share links allow public (no-auth) access to view the game.
    
    Args:
        expires_days: Days until the link expires (1-365, default 7)
    
    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    game = get_game_current(game_id)
    team_id = game.get("teamId")
    
    if not team_id:
        raise HTTPException(status_code=400, detail="Game has no teamId")
    
    share = create_share_link(
        game_id=game_id,
        team_id=team_id,
        created_by=user["id"],
        expires_days=expires_days
    )
    
    return {
        "share": share,
        "url": f"https://www.breakside.pro/share/{share['hash']}"
    }


@app.get("/api/games/{game_id}/shares")
async def list_game_shares_endpoint(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    List all share links for a game.
    
    Includes both active and revoked links.
    
    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    shares = list_game_shares(game_id)
    
    # Add validity status to each share
    shares_with_status = []
    for share in shares:
        share_copy = dict(share)
        share_copy["isValid"] = is_share_valid(share)
        shares_with_status.append(share_copy)
    
    return {"shares": shares_with_status, "count": len(shares_with_status)}


@app.delete("/api/shares/{share_id}")
async def revoke_share_endpoint(
    share_id: str,
    user: dict = Depends(get_current_user)
):
    """
    Revoke a share link.
    
    Requires: Admin or Coach access to the share's team.
    """
    share = get_share(share_id)
    if not share:
        raise HTTPException(status_code=404, detail="Share link not found")
    
    # Must be admin or coach of the team
    if not is_admin(user["id"]):
        role = get_user_team_role(user["id"], share["teamId"])
        if role != "coach":
            raise HTTPException(status_code=403, detail="Coach access required")
    
    revoke_share(share_id, user["id"])
    return {"status": "revoked", "share_id": share_id}


@app.get("/api/share/{hash}")
async def get_game_by_share(hash: str):
    """
    Get a game via a share link.
    
    This is a public endpoint - no authentication required.
    """
    share = get_share_by_hash(hash)
    
    if not share:
        raise HTTPException(status_code=404, detail="Share link not found")
    
    if not is_share_valid(share):
        raise HTTPException(status_code=410, detail="Share link has expired or been revoked")
    
    if not game_exists(share["gameId"]):
        raise HTTPException(status_code=404, detail="Game not found")
    
    game = get_game_current(share["gameId"])
    
    return {
        "game": game,
        "shareInfo": {
            "expiresAt": share["expiresAt"],
            "createdAt": share["createdAt"]
        }
    }


# =============================================================================
# Invite endpoints
# =============================================================================

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
    
    Requires: Coach access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    # Set defaults based on role
    default_expiry = 7 if role == "coach" else 30
    
    invite = create_invite(
        team_id=team_id,
        role=role,
        created_by=user["id"],
        expires_days=expires_days if expires_days is not None else default_expiry,
    )
    
    return {
        "invite": invite,
        "url": f"https://www.breakside.pro/join/{invite['code']}",
        "code": invite["code"]
    }


@app.get("/api/teams/{team_id}/invites")
async def list_team_invites_endpoint(
    team_id: str,
    user: dict = Depends(require_team_coach("team_id"))
):
    """
    List all invites for a team (including expired/revoked).
    
    Requires: Coach access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    invites = list_team_invites(team_id)
    
    # Add validity status to each invite
    invites_with_status = []
    for invite in invites:
        invite_copy = dict(invite)
        invite_copy["isValid"] = is_invite_valid(invite)
        invite_copy["invalidReason"] = get_invite_validity_reason(invite)
        invites_with_status.append(invite_copy)
    
    return {"invites": invites_with_status, "count": len(invites_with_status)}


@app.get("/api/invites/{code}/info")
async def get_invite_info(code: str):
    """
    Get public info about an invite (for landing page preview).
    
    Returns team name and role, but not internal details.
    No auth required.
    """
    invite = get_invite_by_code(code.upper())
    
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")
    
    if not is_invite_valid(invite):
        reason = get_invite_validity_reason(invite)
        error_messages = {
            "revoked": "This invite has been revoked",
            "expired": "This invite has expired",
            "max_uses": "This invite has already been used",
        }
        raise HTTPException(
            status_code=410, 
            detail=error_messages.get(reason, "This invite is no longer valid")
        )
    
    try:
        team = get_team(invite["teamId"])
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Team not found")
    
    # Get inviter's display name
    try:
        inviter = get_user(invite["createdBy"])
        inviter_name = inviter.get("displayName", "A coach") if inviter else "A coach"
    except (FileNotFoundError, KeyError):
        inviter_name = "A coach"
    
    return {
        "teamName": team["name"],
        "role": invite["role"],
        "invitedBy": inviter_name,
        "expiresAt": invite.get("expiresAt")
    }


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
            "membership_error": 400,
        }
        status = status_map.get(result.get("reason"), 400)
        raise HTTPException(status_code=status, detail=result["error"])
    
    team = get_team(result["membership"]["teamId"])
    
    return {
        "status": "joined",
        "membership": result["membership"],
        "team": team
    }


@app.delete("/api/invites/{invite_id}")
async def revoke_invite_endpoint(
    invite_id: str,
    user: dict = Depends(get_current_user)
):
    """
    Revoke an invite.
    
    Requires: Admin or Coach access to the invite's team.
    """
    invite = get_invite(invite_id)
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")
    
    # Must be admin or coach of the team
    if not is_admin(user["id"]):
        role = get_user_team_role(user["id"], invite["teamId"])
        if role != "coach":
            raise HTTPException(status_code=403, detail="Coach access required")
    
    revoke_invite_storage(invite_id, user["id"])
    return {"status": "revoked", "invite_id": invite_id}


# =============================================================================
# Team member endpoints
# =============================================================================

@app.get("/api/teams/{team_id}/members")
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
# Player endpoints
# =============================================================================

@app.post("/api/players")
async def create_player(
    player_data: Dict[str, Any] = Body(...),
    user: dict = Depends(get_current_user)
):
    """
    Create a new player.
    
    If 'id' is provided in the body, it will be used (for offline-created players).
    Otherwise, an ID will be generated from the name.
    
    Requires: Any authenticated user can create players.
    """
    if "name" not in player_data:
        raise HTTPException(status_code=400, detail="Player name is required")
    
    # Check if client provided an ID (offline creation)
    provided_id = player_data.get('id')
    
    # If ID was provided and already exists, this is an update/sync
    if provided_id and player_exists(provided_id):
        update_player(provided_id, player_data)
        return {"status": "updated", "player_id": provided_id, "player": get_player(provided_id)}
    
    player_id = save_player(player_data, provided_id)
    return {"status": "created", "player_id": player_id, "player": get_player(player_id)}


@app.get("/api/players")
async def list_players_endpoint():
    """List all players."""
    players = list_players()
    return {"players": players, "count": len(players)}


@app.get("/api/players/{player_id}")
async def get_player_endpoint(player_id: str):
    """Get a player by ID."""
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
    
    return get_player(player_id)


@app.put("/api/players/{player_id}")
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


@app.delete("/api/players/{player_id}")
async def delete_player_endpoint(player_id: str, user: dict = Depends(require_player_edit_access)):
    """
    Delete a player.
    
    Requires: Coach access to a team that has this player on the roster.
    """
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
    
    delete_player_storage(player_id)
    return {"status": "deleted", "player_id": player_id}


@app.get("/api/players/{player_id}/games")
async def get_player_games_endpoint(player_id: str):
    """Get all games a player has participated in."""
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
    
    game_ids = get_player_games(player_id)
    return {"player_id": player_id, "game_ids": game_ids, "count": len(game_ids)}


@app.get("/api/players/{player_id}/teams")
async def get_player_teams_endpoint(player_id: str):
    """Get all teams a player belongs to."""
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
    
    # Import here to avoid circular imports
    try:
        from storage.index_storage import get_player_teams
    except ImportError:
        from ultistats_server.storage.index_storage import get_player_teams
    
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
# Team endpoints
# =============================================================================

@app.post("/api/teams")
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


@app.get("/api/teams")
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


@app.get("/api/teams/{team_id}")
async def get_team_endpoint(team_id: str, user: dict = Depends(require_team_access("team_id"))):
    """
    Get a team by ID.
    
    Requires: Coach or Viewer access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    return get_team(team_id)


@app.put("/api/teams/{team_id}")
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


@app.delete("/api/teams/{team_id}")
async def delete_team_endpoint(team_id: str, user: dict = Depends(require_team_coach("team_id"))):
    """
    Delete a team.
    
    Requires: Coach access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    delete_team_storage(team_id)
    return {"status": "deleted", "team_id": team_id}


@app.get("/api/teams/{team_id}/players")
async def get_team_players_endpoint(team_id: str, user: dict = Depends(require_team_access("team_id"))):
    """
    Get all players for a team (resolved from playerIds).
    
    Requires: Coach or Viewer access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    players = get_team_players(team_id)
    return {"team_id": team_id, "players": players, "count": len(players)}


@app.get("/api/teams/{team_id}/games")
async def get_team_games_endpoint(team_id: str, user: dict = Depends(require_team_access("team_id"))):
    """
    Get all games for a team.
    
    Requires: Coach or Viewer access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    game_ids = get_team_games(team_id)
    return {"team_id": team_id, "game_ids": game_ids, "count": len(game_ids)}


# =============================================================================
# Index endpoints
# =============================================================================

@app.post("/api/index/rebuild")
async def rebuild_index_endpoint(user: dict = Depends(require_admin)):
    """
    Force rebuild of the index.
    
    Requires: Admin access.
    """
    index = rebuild_index()
    return {
        "status": "rebuilt",
        "lastRebuilt": index.get("lastRebuilt"),
        "playerCount": len(index.get("playerGames", {})),
        "teamCount": len(index.get("teamGames", {})),
        "gameCount": len(index.get("gameRoster", {})),
    }


@app.get("/api/index/status")
async def get_index_status_endpoint():
    """Get index status and statistics."""
    return get_index_status()


# PWA file serving - MUST be last to avoid catching API routes
@app.get("/{filename:path}")
async def serve_pwa_file(filename: str):
    """Serve PWA files from parent directory."""
    # Security: only serve known files/directories
    file_path = pwa_dir / filename
    
    # Check if it's a known static file or in a known directory
    first_part = filename.split('/')[0] if '/' in filename else filename
    
    if first_part in pwa_static_files or first_part in pwa_static_dirs:
        if file_path.exists() and file_path.is_file():
            # Determine media type
            suffix = file_path.suffix.lower()
            media_types = {
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.json': 'application/json',
                '.html': 'text/html',
                '.png': 'image/png',
                '.ico': 'image/x-icon',
                '.webmanifest': 'application/manifest+json',
            }
            media_type = media_types.get(suffix, 'application/octet-stream')
            return FileResponse(file_path, media_type=media_type)
    
    raise HTTPException(status_code=404, detail="File not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="debug" if DEBUG else "info")
