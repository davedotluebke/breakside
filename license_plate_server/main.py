"""
Main FastAPI application for the License Plate Game server.
"""
import os
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from server.auth.routes import router as auth_router
from server.auth.models import User
from server.auth.routes import get_current_user
from server.sheets import operations
from server.websocket.handlers import websocket_endpoint
from server.config import HOST, PORT

# Create FastAPI app
app = FastAPI(
    title="License Plate Game API",
    description="API for the License Plate Game PWA",
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

# Mount static files for serving the PWA
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
        "message": "License Plate Game API Server",
        "version": "1.0.0",
        "status": "running"
    }

# Game endpoints
@app.get("/games")
async def get_all_games(current_user: User = Depends(get_current_user)):
    """Get all games from the database."""
    games = operations.get_games()
    return {"games": games}

@app.post("/games")
async def create_new_game(
    name: str,
    end_date: str = None,
    current_user: User = Depends(get_current_user)
):
    """Create a new game."""
    game = operations.create_game(name, end_date)
    return game

# Sightings endpoints
@app.get("/sightings/{game_id}")
async def get_game_sightings(
    game_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get all sightings for a specific game."""
    sightings = operations.get_sightings(game_id)
    return {"sightings": sightings}

@app.post("/sightings/{game_id}")
async def add_new_sighting(
    game_id: str,
    country: str,
    jurisdiction: str,
    plate_subtype: str = "",
    custom_id: str = "",
    current_user: User = Depends(get_current_user)
):
    """Add a new sighting to a game."""
    # Get the game name
    games = operations.get_games()
    game = next((g for g in games if g['id'] == game_id), None)
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    sighting = operations.add_sighting(
        country=country,
        jurisdiction=jurisdiction,
        game_id=game_id,
        game_name=game['name'],  # Add the game name
        plate_subtype=plate_subtype,
        custom_id=custom_id,
        username=current_user.username
    )
    return sighting

@app.delete("/sightings/{sighting_id}")
async def delete_existing_sighting(
    sighting_id: str,
    current_user: User = Depends(get_current_user)
):
    """Delete a sighting by ID."""
    success = operations.delete_sighting(sighting_id)
    if not success:
        raise HTTPException(status_code=404, detail="Sighting not found")
    return {"message": "Sighting deleted successfully"}

# WebSocket endpoint
@app.websocket("/ws/{game_id}")
async def websocket_game_endpoint(
    websocket: WebSocket,
    game_id: str,
    token: str = Query(...)
):
    """WebSocket endpoint for real-time game updates."""
    await websocket_endpoint(websocket, game_id, token)

# Run the server (for development)
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server.main:app",
        host=HOST,
        port=PORT,
        reload=True
    ) 