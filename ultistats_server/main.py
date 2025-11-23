"""
Main FastAPI application for the Ultistats server.
"""
import os
from fastapi import FastAPI, Depends, HTTPException, WebSocket, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import List, Dict, Any, Optional

from ultistats_server.auth.routes import router as auth_router
from ultistats_server.auth.models import User
from ultistats_server.auth.routes import get_current_user
from ultistats_server.sheets import operations
from ultistats_server.config import HOST, PORT

# Create FastAPI app
app = FastAPI(
    title="Ultistats API",
    description="API for the Ultistats PWA - Ultimate Frisbee Statistics Tracker",
    version="1.0.0"
)

# CORS middleware to allow cross-origin requests from the PWA
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Specify actual origins in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files for serving the PWA (if needed)
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

# Include routers
app.include_router(
    auth_router,
    prefix="/auth",
    tags=["authentication"]
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

# Team endpoints
@app.get("/teams", response_model=Dict[str, List[Dict[str, Any]]])
async def get_all_teams(current_user: User = Depends(get_current_user)):
    """Get all teams."""
    teams = operations.get_teams()
    return {"teams": teams}

@app.post("/teams", response_model=Dict[str, Any])
async def create_team(
    team_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """Create a new team."""
    try:
        team = operations.create_team(team_data)
        return team
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/teams/{team_id}", response_model=Dict[str, Any])
async def get_team(
    team_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get a team by ID."""
    team = operations.get_team_by_id(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return team

@app.put("/teams/{team_id}", response_model=Dict[str, Any])
async def update_team(
    team_id: str,
    team_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """Update a team."""
    try:
        team = operations.update_team(team_id, team_data)
        return team
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

# Player endpoints
@app.get("/teams/{team_id}/players", response_model=Dict[str, List[Dict[str, Any]]])
async def get_team_players(
    team_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get all players for a team."""
    players = operations.get_players(team_id)
    return {"players": players}

@app.post("/teams/{team_id}/players", response_model=Dict[str, Any])
async def create_player(
    team_id: str,
    player_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """Add a player to a team."""
    # Ensure team_id matches
    player_data['team_id'] = team_id
    try:
        player = operations.create_player(player_data)
        return player
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/players/{player_id}", response_model=Dict[str, Any])
async def get_player(
    player_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get a player by ID."""
    player = operations.get_player_by_id(player_id)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    return player

# Game endpoints
@app.get("/teams/{team_id}/games", response_model=Dict[str, List[Dict[str, Any]]])
async def get_team_games(
    team_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get all games for a team."""
    games = operations.get_games(team_id)
    return {"games": games}

@app.post("/games", response_model=Dict[str, Any])
async def create_game(
    game_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """Create a new game (creates tab)."""
    try:
        game = operations.create_game(game_data)
        return game
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating game: {str(e)}")

@app.get("/games/{game_id}", response_model=Dict[str, Any])
async def get_game(
    game_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get game metadata."""
    game = operations.get_game_by_id(game_id)
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    return game

@app.get("/games/{game_id}/data", response_model=Dict[str, Any])
async def get_game_data(
    game_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get all play-by-play data from a game tab."""
    try:
        rows = operations.get_game_data(game_id)
        return {"game_id": game_id, "rows": rows}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/games/{game_id}/events", response_model=Dict[str, Any])
async def append_game_event(
    game_id: str,
    event_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """Append an event row to a game tab (async, non-blocking)."""
    try:
        # event_data should contain 'row' key with list of column values
        event_row = event_data.get('row', [])
        if not event_row:
            raise HTTPException(status_code=400, detail="Event row data required")
        
        result = operations.append_game_event(game_id, event_row)
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/games/{game_id}/events/batch", response_model=Dict[str, Any])
async def append_game_events_batch(
    game_id: str,
    events_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """Batch append multiple event rows to a game tab (more efficient than individual calls)."""
    try:
        # events_data should contain 'rows' key with list of event rows
        event_rows = events_data.get('rows', [])
        if not event_rows:
            raise HTTPException(status_code=400, detail="Event rows data required")
        
        result = operations.append_game_events_batch(game_id, event_rows)
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/games/{game_id}/points/{point_id}/end", response_model=Dict[str, Any])
async def end_point(
    game_id: str,
    point_id: str,
    point_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """Mark a point as ended (update point end row)."""
    try:
        # This will append a point end row to the game tab
        # point_data should contain 'row' key with point end row data
        point_row = point_data.get('row', [])
        if not point_row:
            raise HTTPException(status_code=400, detail="Point end row data required")
        
        result = operations.append_game_event(game_id, point_row)
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/games/{game_id}/end", response_model=Dict[str, Any])
async def end_game(
    game_id: str,
    game_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """End a game (update game metadata with final scores)."""
    try:
        game = operations.update_game(game_id, game_data)
        return game
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/games/{game_id}/sync", response_model=Dict[str, Any])
async def sync_full_game(
    game_id: str,
    sync_data: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """
    Full game sync - upload complete game state for handoff scenarios.
    
    This endpoint allows a client to upload the complete game state (all rows)
    to sync with the server. Useful when:
    - Handing off tracking to another user
    - Recovering from sync issues
    - Initial sync after offline period
    """
    try:
        # sync_data should contain 'rows' key with complete list of game rows
        game_rows = sync_data.get('rows', [])
        if not game_rows:
            raise HTTPException(status_code=400, detail="Game rows data required")
        
        result = operations.sync_full_game(game_id, game_rows)
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

# Run the server (for development)
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "ultistats_server.main:app",
        host=HOST,
        port=PORT,
        reload=True
    )

