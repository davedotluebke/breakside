"""
Operations for Google Sheets data handling.
"""
from typing import List, Dict, Any, Optional, Callable
import time
from datetime import datetime

from server.sheets.service import sheets_service

def generate_unique_id() -> str:
    """Generate a unique ID using timestamp and random values."""
    return f"{int(time.time() * 1000)}_{int(time.time() % 1000)}"

# User operations
def get_users() -> List[Dict[str, Any]]:
    """Get all users from the Google Sheet."""
    values = sheets_service.get_values('users')
    
    if not values or len(values) <= 1:  # Empty or just headers
        return []
    
    # Assuming format: [username, email, full_name, hashed_password, created_at, active_games]
    users = []
    for row in values[1:]:  # Skip header row
        if len(row) >= 4:
            users.append({
                'username': row[0],
                'email': row[1] if len(row) > 1 else None,
                'full_name': row[2] if len(row) > 2 else None,
                'hashed_password': row[3],
                'created_at': row[4] if len(row) > 4 else None,
                'active_games': row[5].split(',') if len(row) > 5 and row[5] else []
            })
    
    return users

def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    """Get a user by username from the Google Sheet."""
    users = get_users()
    for user in users:
        if user['username'] == username:
            return user
    return None

def create_user(user_data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new user in the Google Sheet."""
    # Check if user already exists
    if get_user_by_username(user_data['username']):
        raise ValueError(f"Username {user_data['username']} already exists")
    
    # Format active games as comma-separated string
    active_games_str = ','.join(user_data.get('active_games', []))
    
    values = [[
        user_data['username'],
        user_data.get('email', ''),
        user_data.get('full_name', ''),
        user_data['hashed_password'],
        datetime.utcnow().isoformat(),
        active_games_str
    ]]
    
    result = sheets_service.append_values('users', values)
    
    return {
        'username': user_data['username'],
        'email': user_data.get('email'),
        'full_name': user_data.get('full_name'),
        'active_games': user_data.get('active_games', [])
    }

def update_user(username: str, user_data: Dict[str, Any]) -> Dict[str, Any]:
    """Update a user in the Google Sheet."""
    # Get all users to find the row index
    values = sheets_service.get_values('users')
    
    row_index = -1
    for i, row in enumerate(values):
        if row and row[0] == username:
            row_index = i
            break
    
    if row_index == -1:
        raise ValueError(f"User {username} not found")
    
    # Format active games as comma-separated string
    active_games_str = ','.join(user_data.get('active_games', []))
    
    # Update the row
    update_range = f"users!A{row_index+1}:F{row_index+1}"
    update_values = [[
        username,
        user_data.get('email', ''),
        user_data.get('full_name', ''),
        user_data.get('hashed_password', values[row_index][3]),  # Keep existing password if not provided
        values[row_index][4] if len(values[row_index]) > 4 else datetime.utcnow().isoformat(),
        active_games_str
    ]]
    
    result = sheets_service.update_values(update_range, update_values)
    
    return {
        'username': username,
        'email': user_data.get('email'),
        'full_name': user_data.get('full_name'),
        'active_games': user_data.get('active_games', [])
    }

# Game operations
def get_games() -> List[Dict[str, Any]]:
    """Get all games from the Google Sheet."""
    values = sheets_service.get_values('games')
    
    if not values or len(values) <= 1:  # Empty or just headers
        return []
    
    # Assuming format: [id, name, end_date]
    games = []
    for row in values[1:]:  # Skip header row
        if len(row) >= 3:
            games.append({
                'id': row[0],
                'name': row[1],
                'end_date': row[2] if len(row) > 2 else None
            })
    
    return games

def create_game(name: str, end_date: Optional[str] = None) -> Dict[str, Any]:
    """Create a new game in the Google Sheet."""
    game_id = generate_unique_id()
    
    values = [[game_id, name, end_date or '']]
    result = sheets_service.append_values('games', values)
    
    return {
        'id': game_id,
        'name': name,
        'end_date': end_date
    }

# Sighting operations
def get_sightings(game_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get all sightings, optionally filtered by game ID."""
    values = sheets_service.get_values('sightings')
    
    if not values or len(values) <= 1:  # Empty or just headers
        return []
    
    # Assuming format: [id, timestamp, country, jurisdiction, plate_subtype, custom_id, game_id, game_name, username]
    sightings = []
    for row in values[1:]:  # Skip header row
        if len(row) >= 8:  # Update minimum required columns
            sighting = {
                'id': row[0],
                'timestamp': row[1],
                'country': row[2],
                'jurisdiction': row[3],
                'plate_subtype': row[4] if len(row) > 4 else '',
                'custom_id': row[5] if len(row) > 5 else '',
                'game_id': row[6] if len(row) > 6 else '',
                'game_name': row[7] if len(row) > 7 else '',  
                'username': row[8] if len(row) > 8 else ''
            }
            
            if game_id is None or sighting['game_id'] == game_id:
                sightings.append(sighting)
    
    return sightings

def add_sighting(
    country: str,
    jurisdiction: str,
    game_id: str,
    game_name: str,  # Add game_name parameter
    plate_subtype: str = '',
    custom_id: str = '',
    username: str = ''
) -> Dict[str, Any]:
    """Add a new plate sighting to the Google Sheet."""
    sighting_id = generate_unique_id()
    timestamp = datetime.utcnow().isoformat()
    
    values = [[
        sighting_id, 
        timestamp, 
        country, 
        jurisdiction, 
        plate_subtype, 
        custom_id, 
        game_id,
        game_name,  # Add game_name to the values
        username
    ]]
    
    result = sheets_service.append_values('sightings', values)
    
    return {
        'id': sighting_id,
        'timestamp': timestamp,
        'country': country,
        'jurisdiction': jurisdiction,
        'plate_subtype': plate_subtype,
        'custom_id': custom_id,
        'game_id': game_id,
        'game_name': game_name,  # Add game_name to the return value
        'username': username
    }

def delete_sighting(sighting_id: str) -> bool:
    """Delete a sighting by ID."""
    values = sheets_service.get_values('sightings', 'A:A')
    
    row_index = -1
    for i, row in enumerate(values):
        if row and row[0] == sighting_id:
            row_index = i
            break
    
    if row_index == -1:
        return False
    
    # Delete the row
    sheets_service.delete_row('sightings', row_index)
    return True

# Helper function to get row by ID
def get_row_by_id(sheet_name: str, id_value: str) -> Optional[List[Any]]:
    """Get a row from a sheet by ID (assumes ID is in first column)."""
    values = sheets_service.get_values(sheet_name)
    
    for row in values:
        if row and row[0] == id_value:
            return row
    
    return None 