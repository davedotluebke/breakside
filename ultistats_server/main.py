"""
Main FastAPI application for the Ultistats server.
"""
from fastapi import FastAPI, HTTPException, Body, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Dict, Any, List
from datetime import datetime

# Import config - handle both relative and absolute imports
try:
    from config import HOST, PORT, DEBUG, ALLOWED_ORIGINS
    from storage import (
        save_game_version,
        get_game_current,
        get_game_version,
        list_game_versions,
        game_exists,
        delete_game,
        list_all_games,
    )
except ImportError:
    # Try absolute import (when running as package)
    from ultistats_server.config import HOST, PORT, DEBUG, ALLOWED_ORIGINS
    from ultistats_server.storage import (
        save_game_version,
        get_game_current,
        get_game_version,
        list_game_versions,
        game_exists,
        delete_game,
        list_all_games,
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

# Root endpoint
@app.get("/")
async def root():
    """Root endpoint that returns API information."""
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="debug" if DEBUG else "info")
