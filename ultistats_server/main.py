"""
Main FastAPI application for the Ultistats server.
"""
from fastapi import FastAPI, HTTPException, Body, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import Dict, Any, List
from datetime import datetime

# Import config - handle both relative and absolute imports
try:
    from config import HOST, PORT, DEBUG, ALLOWED_ORIGINS
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
    )
except ImportError:
    # Try absolute import (when running as package)
    from ultistats_server.config import HOST, PORT, DEBUG, ALLOWED_ORIGINS
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
pwa_static_dirs = ["data", "game", "playByPlay", "screens", "teams", "ui", "utils", "images"]

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


# Game endpoints

@app.post("/games/{game_id}/sync")
async def sync_game(game_id: str, game_data: Dict[str, Any] = Body(...)):
    """
    Full game sync - replaces entire game state.
    Idempotent: can be called multiple times safely.
    
    Creates a new version on each sync.
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


@app.get("/games/{game_id}")
async def get_game(game_id: str):
    """Get current game state."""
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    game_data = get_game_current(game_id)
    return game_data


@app.get("/games")
async def list_games():
    """List all games with metadata."""
    games = list_all_games()
    return {"games": games}


@app.delete("/games/{game_id}")
async def delete_game_endpoint(game_id: str):
    """Delete a game and all its versions."""
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    deleted = delete_game(game_id)
    if deleted:
        return {"status": "deleted", "game_id": game_id}
    else:
        raise HTTPException(status_code=500, detail="Failed to delete game")


# Version endpoints

@app.get("/games/{game_id}/versions")
async def list_versions(game_id: str):
    """List all versions of a game."""
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    versions = list_game_versions(game_id)
    return {"game_id": game_id, "versions": versions}


@app.get("/games/{game_id}/versions/{timestamp}")
async def get_version(game_id: str, timestamp: str):
    """Get specific version of a game."""
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    try:
        game_data = get_game_version(game_id, timestamp)
        return game_data
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Version {timestamp} not found")


@app.post("/games/{game_id}/restore/{timestamp}")
async def restore_version(game_id: str, timestamp: str):
    """Restore game to a specific version."""
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    
    try:
        game_data = get_game_version(game_id, timestamp)
        save_game_version(game_id, game_data)
        return {"status": "restored", "game_id": game_id, "timestamp": timestamp}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Version {timestamp} not found")


# =============================================================================
# Player endpoints
# =============================================================================

@app.post("/players")
async def create_player(player_data: Dict[str, Any] = Body(...)):
    """
    Create a new player.
    
    If 'id' is provided in the body, it will be used (for offline-created players).
    Otherwise, an ID will be generated from the name.
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


@app.get("/players")
async def list_players_endpoint():
    """List all players."""
    players = list_players()
    return {"players": players, "count": len(players)}


@app.get("/players/{player_id}")
async def get_player_endpoint(player_id: str):
    """Get a player by ID."""
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
    
    return get_player(player_id)


@app.put("/players/{player_id}")
async def update_player_endpoint(player_id: str, player_data: Dict[str, Any] = Body(...)):
    """Update a player."""
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
    
    update_player(player_id, player_data)
    return {"status": "updated", "player_id": player_id, "player": get_player(player_id)}


@app.delete("/players/{player_id}")
async def delete_player_endpoint(player_id: str):
    """Delete a player."""
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
    
    delete_player_storage(player_id)
    return {"status": "deleted", "player_id": player_id}


@app.get("/players/{player_id}/games")
async def get_player_games_endpoint(player_id: str):
    """Get all games a player has participated in."""
    if not player_exists(player_id):
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found")
    
    game_ids = get_player_games(player_id)
    return {"player_id": player_id, "game_ids": game_ids, "count": len(game_ids)}


@app.get("/players/{player_id}/teams")
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

@app.post("/teams")
async def create_team(team_data: Dict[str, Any] = Body(...)):
    """
    Create a new team.
    
    If 'id' is provided in the body, it will be used (for offline-created teams).
    Otherwise, an ID will be generated from the name.
    """
    if "name" not in team_data:
        raise HTTPException(status_code=400, detail="Team name is required")
    
    # Check if client provided an ID (offline creation)
    provided_id = team_data.get('id')
    
    # If ID was provided and already exists, this is an update/sync
    if provided_id and team_exists(provided_id):
        update_team(provided_id, team_data)
        return {"status": "updated", "team_id": provided_id, "team": get_team(provided_id)}
    
    team_id = save_team(team_data, provided_id)
    return {"status": "created", "team_id": team_id, "team": get_team(team_id)}


@app.get("/teams")
async def list_teams_endpoint():
    """List all teams."""
    teams = list_teams()
    return {"teams": teams, "count": len(teams)}


@app.get("/teams/{team_id}")
async def get_team_endpoint(team_id: str):
    """Get a team by ID."""
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    return get_team(team_id)


@app.put("/teams/{team_id}")
async def update_team_endpoint(team_id: str, team_data: Dict[str, Any] = Body(...)):
    """Update a team."""
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    update_team(team_id, team_data)
    return {"status": "updated", "team_id": team_id, "team": get_team(team_id)}


@app.delete("/teams/{team_id}")
async def delete_team_endpoint(team_id: str):
    """Delete a team."""
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    delete_team_storage(team_id)
    return {"status": "deleted", "team_id": team_id}


@app.get("/teams/{team_id}/players")
async def get_team_players_endpoint(team_id: str):
    """Get all players for a team (resolved from playerIds)."""
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    players = get_team_players(team_id)
    return {"team_id": team_id, "players": players, "count": len(players)}


@app.get("/teams/{team_id}/games")
async def get_team_games_endpoint(team_id: str):
    """Get all games for a team."""
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
    
    game_ids = get_team_games(team_id)
    return {"team_id": team_id, "game_ids": game_ids, "count": len(game_ids)}


# =============================================================================
# Index endpoints
# =============================================================================

@app.post("/index/rebuild")
async def rebuild_index_endpoint():
    """Force rebuild of the index."""
    index = rebuild_index()
    return {
        "status": "rebuilt",
        "lastRebuilt": index.get("lastRebuilt"),
        "playerCount": len(index.get("playerGames", {})),
        "teamCount": len(index.get("teamGames", {})),
        "gameCount": len(index.get("gameRoster", {})),
    }


@app.get("/index/status")
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
