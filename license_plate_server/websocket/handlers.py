"""
WebSocket handlers for real-time communication.
"""
import json
from typing import List, Dict, Any, Optional
import asyncio
from datetime import datetime

from fastapi import WebSocket, WebSocketDisconnect, Depends, HTTPException, status
from jose import JWTError, jwt

from server.auth.routes import get_current_user
from server.auth.models import User, TokenData
from server.sheets import operations
from server.config import SECRET_KEY, JWT_ALGORITHM

# Store active connections
class ConnectionManager:
    def __init__(self):
        # Map of game_id -> list of websocket connections
        self.active_connections: Dict[str, List[WebSocket]] = {}
        # Map of websocket -> user info
        self.user_connections: Dict[WebSocket, User] = {}
    
    async def connect(self, websocket: WebSocket, game_id: str, user: User):
        await websocket.accept()
        if game_id not in self.active_connections:
            self.active_connections[game_id] = []
        self.active_connections[game_id].append(websocket)
        self.user_connections[websocket] = user
        
        # Add this game to user's active games if not already there
        if game_id not in user.active_games:
            user.active_games.append(game_id)
    
    def disconnect(self, websocket: WebSocket, game_id: str):
        if game_id in self.active_connections:
            if websocket in self.active_connections[game_id]:
                self.active_connections[game_id].remove(websocket)
                
                # Clean up empty game lists
                if not self.active_connections[game_id]:
                    del self.active_connections[game_id]
        
        if websocket in self.user_connections:
            del self.user_connections[websocket]
    
    async def send_personal_message(self, message: Dict[str, Any], websocket: WebSocket):
        await websocket.send_text(json.dumps(message))
    
    async def broadcast(self, message: Dict[str, Any], game_id: str):
        if game_id in self.active_connections:
            for connection in self.active_connections[game_id]:
                await connection.send_text(json.dumps(message))
    
    def get_active_users(self, game_id: str) -> List[User]:
        users = []
        if game_id in self.active_connections:
            for connection in self.active_connections[game_id]:
                if connection in self.user_connections:
                    users.append(self.user_connections[connection])
        return users

    async def handle_message(self, websocket: WebSocket, message: Dict[str, Any]):
        """Handle incoming WebSocket messages."""
        try:
            if message['type'] == 'add_sighting':
                # Get the game name
                games = operations.get_games()
                game = next((g for g in games if g['id'] == message['data']['game_id']), None)
                if not game:
                    await self.send_personal_message({
                        'type': 'error',
                        'data': {'message': 'Game not found'}
                    }, websocket)
                    return
                
                # Add the sighting with game name
                sighting = operations.add_sighting(
                    country=message['data']['country'],
                    jurisdiction=message['data']['jurisdiction'],
                    game_id=message['data']['game_id'],
                    game_name=game['name'],
                    plate_subtype=message['data'].get('plate_subtype', ''),
                    custom_id=message['data'].get('custom_id', ''),
                    username=self.user_connections[websocket].username
                )
                
                # Broadcast the new sighting to all connected clients
                await self.broadcast({
                    'type': 'new_sighting',
                    'data': sighting
                }, message['data']['game_id'])
                
            elif message['type'] == 'delete_sighting':
                sighting_id = message["data"]["id"]
                success = operations.delete_sighting(sighting_id)
                
                if success:
                    # Get the game_id from the sighting
                    sightings = operations.get_sightings()
                    sighting = next((s for s in sightings if s['id'] == sighting_id), None)
                    if sighting:
                        # Broadcast the deletion to all connected clients with full sighting data
                        await self.broadcast({
                            "type": "sighting_deleted",
                            "data": sighting
                        }, sighting['game_id'])
                else:
                    # Send error message back to the client
                    await self.send_personal_message({
                        "type": "error",
                        "data": {"message": f"Sighting with ID {sighting_id} not found"}
                    }, websocket)
            
            elif message['type'] == 'get_sightings':
                # Get sightings for the requested game
                game_id = message['data']['game_id']
                sightings = operations.get_sightings(game_id)
                
                # Send the sightings data back to the requesting client
                await self.send_personal_message({
                    'type': 'init',
                    'data': {
                        'sightings': sightings
                    }
                }, websocket)
            
            elif message["type"] == "ping":
                # Respond to ping messages to keep the connection alive
                await self.send_personal_message({
                    "type": "pong",
                    "data": {"timestamp": datetime.utcnow().isoformat()}
                }, websocket)
    
        except WebSocketDisconnect:
            # Get the game_id from the user's active games
            user = self.user_connections.get(websocket)
            if user and user.active_games:
                game_id = user.active_games[0]  # Use the first active game
                self.disconnect(websocket, game_id)
                await self.broadcast({
                    "type": "user_left",
                    "data": {
                        "username": user.username,
                        "timestamp": datetime.utcnow().isoformat()
                    }
                }, game_id)
        except Exception as e:
            print(f"WebSocket error: {e}")
            # Get the game_id from the user's active games
            user = self.user_connections.get(websocket)
            if user and user.active_games:
                game_id = user.active_games[0]  # Use the first active game
                self.disconnect(websocket, game_id)

# Create connection manager instance
manager = ConnectionManager()

# WebSocket authentication
async def get_user_from_token(token: str) -> Optional[User]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            return None
        token_data = TokenData(username=username)
        
        # In a real implementation, fetch user from database
        # This is a simplified version
        return User(id=username, username=username, active_games=[])
    except JWTError:
        return None

# Handle WebSocket connection
async def websocket_endpoint(websocket: WebSocket, game_id: str, token: str):
    user = await get_user_from_token(token)
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    
    await manager.connect(websocket, game_id, user)
    
    # Send initial sightings data
    initial_sightings = operations.get_sightings(game_id)
    await manager.send_personal_message({
        "type": "init",
        "data": {
            "sightings": initial_sightings
        }
    }, websocket)
    
    # Notify others that a user has joined
    await manager.broadcast({
        "type": "user_joined",
        "data": {
            "username": user.username,
            "timestamp": datetime.utcnow().isoformat()
        }
    }, game_id)
    
    try:
        while True:
            # Wait for messages from the client
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # Process different message types
            await manager.handle_message(websocket, message)
    
    except WebSocketDisconnect:
        manager.disconnect(websocket, game_id)
        await manager.broadcast({
            "type": "user_left",
            "data": {
                "username": user.username,
                "timestamp": datetime.utcnow().isoformat()
            }
        }, game_id)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket, game_id) 