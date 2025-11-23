"""
Operations for Google Sheets data handling - Ultistats.
"""
from typing import List, Dict, Any, Optional
import time
from datetime import datetime

from ultistats_server.sheets.service import get_sheets_service
from ultistats_server.config import SPREADSHEET_ID


def generate_unique_id() -> str:
    """Generate a unique ID using timestamp and random values."""
    return f"{int(time.time() * 1000)}_{int(time.time() % 1000)}"


def _get_service():
    """Get the sheets service."""
    return get_sheets_service(SPREADSHEET_ID)


def _ensure_sheet_exists(sheet_name: str, headers: List[str]):
    """Ensure a sheet exists with headers. Creates it if it doesn't exist."""
    service = _get_service()
    try:
        sheet_exists = service.sheet_exists(sheet_name)
    except Exception:
        # If we can't check, assume it doesn't exist and try to create
        sheet_exists = False
    
    if not sheet_exists:
        try:
            service.create_sheet(sheet_name)
            # Small delay to ensure sheet is ready
            import time
            time.sleep(0.5)
        except Exception as e:
            # Sheet might already exist, that's OK
            pass
        
        # Add headers - check if sheet already has headers
        try:
            existing = service.get_values(sheet_name)
            if not existing or len(existing) == 0:
                # Sheet is empty, add headers
                service.update_values(f"{sheet_name}!A1", [headers])
        except Exception:
            # If there's an error, try to add headers anyway
            try:
                service.update_values(f"{sheet_name}!A1", [headers])
            except Exception:
                pass  # Headers might already exist


def _initialize_sheets():
    """Initialize required sheets if they don't exist."""
    # Teams sheet: [team_id, team_name, created_at, last_updated]
    _ensure_sheet_exists('Teams', ['team_id', 'team_name', 'created_at', 'last_updated'])
    
    # Players sheet: [player_id, team_id, name, nickname, gender, number, created_at]
    _ensure_sheet_exists('Players', ['player_id', 'team_id', 'name', 'nickname', 'gender', 'number', 'created_at'])
    
    # Games sheet: [game_id, team_id, team_name, opponent_name, starting_position, 
    #               game_start_timestamp, game_end_timestamp, alternate_gender_ratio,
    #               alternate_gender_pulls, starting_gender_ratio, final_score_team,
    #               final_score_opponent, sheet_name]
    _ensure_sheet_exists('Games', [
        'game_id', 'team_id', 'team_name', 'opponent_name', 'starting_position',
        'game_start_timestamp', 'game_end_timestamp', 'alternate_gender_ratio',
        'alternate_gender_pulls', 'starting_gender_ratio', 'final_score_team',
        'final_score_opponent', 'sheet_name'
    ])
    
    # Users sheet: [username, email, full_name, hashed_password, active_games]
    _ensure_sheet_exists('users', ['username', 'email', 'full_name', 'hashed_password', 'active_games'])


# Team operations
def get_teams() -> List[Dict[str, Any]]:
    """Get all teams from the Teams sheet."""
    service = _get_service()
    values = service.get_values('Teams')
    
    if not values or len(values) <= 1:  # Empty or just headers
        return []
    
    # Format: [team_id, team_name, created_at, last_updated]
    teams = []
    for row in values[1:]:  # Skip header row
        if len(row) >= 2:
            teams.append({
                'team_id': row[0],
                'team_name': row[1],
                'created_at': row[2] if len(row) > 2 else None,
                'last_updated': row[3] if len(row) > 3 else None,
            })
    
    return teams


def get_team_by_id(team_id: str) -> Optional[Dict[str, Any]]:
    """Get a team by ID."""
    teams = get_teams()
    for team in teams:
        if team['team_id'] == team_id:
            return team
    return None


def create_team(team_data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new team in the Teams sheet."""
    _initialize_sheets()  # Ensure required sheets exist
    service = _get_service()
    
    # Check if team already exists
    if team_data.get('team_id'):
        existing = get_team_by_id(team_data['team_id'])
        if existing:
            raise ValueError(f"Team with ID {team_data['team_id']} already exists")
    
    # Generate ID if not provided
    team_id = team_data.get('team_id') or generate_unique_id()
    team_name = team_data.get('team_name', '')
    created_at = team_data.get('created_at') or datetime.utcnow().isoformat()
    
    values = [[team_id, team_name, created_at, created_at]]
    service.append_values('Teams', values)
    
    return {
        'team_id': team_id,
        'team_name': team_name,
        'created_at': created_at,
        'last_updated': created_at
    }


def update_team(team_id: str, team_data: Dict[str, Any]) -> Dict[str, Any]:
    """Update a team in the Teams sheet."""
    service = _get_service()
    values = service.get_values('Teams')
    
    row_index = -1
    for i, row in enumerate(values):
        if row and row[0] == team_id:
            row_index = i
            break
    
    if row_index == -1:
        raise ValueError(f"Team {team_id} not found")
    
    # Update the row
    team_name = team_data.get('team_name', values[row_index][1])
    last_updated = datetime.utcnow().isoformat()
    
    update_range = f"Teams!A{row_index+1}:D{row_index+1}"
    update_values = [[team_id, team_name, values[row_index][2] if len(values[row_index]) > 2 else '', last_updated]]
    service.update_values(update_range, update_values)
    
    return {
        'team_id': team_id,
        'team_name': team_name,
        'created_at': values[row_index][2] if len(values[row_index]) > 2 else None,
        'last_updated': last_updated
    }


# Player operations
def get_players(team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get all players, optionally filtered by team_id."""
    service = _get_service()
    values = service.get_values('Players')
    
    if not values or len(values) <= 1:  # Empty or just headers
        return []
    
    # Format: [player_id, team_id, name, nickname, gender, number, created_at]
    players = []
    for row in values[1:]:  # Skip header row
        if len(row) >= 3:
            player_team_id = row[1] if len(row) > 1 else None
            # Filter by team_id if provided
            if team_id and player_team_id != team_id:
                continue
            
            players.append({
                'player_id': row[0],
                'team_id': player_team_id,
                'name': row[2],
                'nickname': row[3] if len(row) > 3 else '',
                'gender': row[4] if len(row) > 4 else 'Unknown',
                'number': row[5] if len(row) > 5 else None,
                'created_at': row[6] if len(row) > 6 else None,
            })
    
    return players


def get_player_by_id(player_id: str) -> Optional[Dict[str, Any]]:
    """Get a player by ID."""
    players = get_players()
    for player in players:
        if player['player_id'] == player_id:
            return player
    return None


def create_player(player_data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new player in the Players sheet."""
    _initialize_sheets()  # Ensure required sheets exist
    service = _get_service()
    
    # Generate ID if not provided
    player_id = player_data.get('player_id') or generate_unique_id()
    team_id = player_data.get('team_id', '')
    name = player_data.get('name', '')
    nickname = player_data.get('nickname', '')
    gender = player_data.get('gender', 'Unknown')
    number = player_data.get('number', '')
    created_at = player_data.get('created_at') or datetime.utcnow().isoformat()
    
    values = [[player_id, team_id, name, nickname, gender, number, created_at]]
    service.append_values('Players', values)
    
    return {
        'player_id': player_id,
        'team_id': team_id,
        'name': name,
        'nickname': nickname,
        'gender': gender,
        'number': number,
        'created_at': created_at
    }


# Game operations
def get_games(team_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get all games, optionally filtered by team_id."""
    service = _get_service()
    values = service.get_values('Games')
    
    if not values or len(values) <= 1:  # Empty or just headers
        return []
    
    # Format: [game_id, team_id, team_name, opponent_name, starting_position, ...]
    games = []
    for row in values[1:]:  # Skip header row
        if len(row) >= 4:
            game_team_id = row[1] if len(row) > 1 else None
            # Filter by team_id if provided
            if team_id and game_team_id != team_id:
                continue
            
            games.append({
                'game_id': row[0],
                'team_id': game_team_id,
                'team_name': row[2] if len(row) > 2 else '',
                'opponent_name': row[3] if len(row) > 3 else '',
                'starting_position': row[4] if len(row) > 4 else '',
                'game_start_timestamp': row[5] if len(row) > 5 else None,
                'game_end_timestamp': row[6] if len(row) > 6 else None,
                'alternate_gender_ratio': row[7] if len(row) > 7 else None,
                'alternate_gender_pulls': row[8] if len(row) > 8 else None,
                'starting_gender_ratio': row[9] if len(row) > 9 else None,
                'final_score_team': row[10] if len(row) > 10 else None,
                'final_score_opponent': row[11] if len(row) > 11 else None,
                'sheet_name': row[12] if len(row) > 12 else None,
            })
    
    return games


def get_game_by_id(game_id: str) -> Optional[Dict[str, Any]]:
    """Get a game by ID."""
    games = get_games()
    for game in games:
        if game['game_id'] == game_id:
            return game
    return None


def create_game(game_data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new game in the Games sheet and create a game tab."""
    _initialize_sheets()  # Ensure required sheets exist
    service = _get_service()
    
    # Generate ID if not provided
    game_id = game_data.get('game_id') or generate_unique_id()
    team_id = game_data.get('team_id', '')
    team_name = game_data.get('team_name', '')
    opponent_name = game_data.get('opponent_name', '')
    starting_position = game_data.get('starting_position', '')
    game_start_timestamp = game_data.get('game_start_timestamp') or datetime.utcnow().isoformat()
    
    # Create sheet name from game data
    sheet_name = game_data.get('sheet_name') or f"{team_name}_vs_{opponent_name}_{game_id[:8]}"
    # Clean sheet name (Google Sheets has restrictions)
    sheet_name = sheet_name.replace('/', '_').replace('\\', '_')[:100]
    
    # Create the game tab
    if not service.sheet_exists(sheet_name):
        service.create_sheet(sheet_name)
    
    # Add game to Games sheet
    values = [[
        game_id,
        team_id,
        team_name,
        opponent_name,
        starting_position,
        game_start_timestamp,
        '',  # game_end_timestamp
        game_data.get('alternate_gender_ratio', ''),
        game_data.get('alternate_gender_pulls', ''),
        game_data.get('starting_gender_ratio', ''),
        '',  # final_score_team
        '',  # final_score_opponent
        sheet_name
    ]]
    service.append_values('Games', values)
    
    return {
        'game_id': game_id,
        'team_id': team_id,
        'team_name': team_name,
        'opponent_name': opponent_name,
        'starting_position': starting_position,
        'game_start_timestamp': game_start_timestamp,
        'sheet_name': sheet_name
    }


def update_game(game_id: str, game_data: Dict[str, Any]) -> Dict[str, Any]:
    """Update a game in the Games sheet."""
    service = _get_service()
    values = service.get_values('Games')
    
    row_index = -1
    for i, row in enumerate(values):
        if row and row[0] == game_id:
            row_index = i
            break
    
    if row_index == -1:
        raise ValueError(f"Game {game_id} not found")
    
    # Update fields
    current_row = values[row_index]
    updated_row = [
        game_id,
        game_data.get('team_id', current_row[1] if len(current_row) > 1 else ''),
        game_data.get('team_name', current_row[2] if len(current_row) > 2 else ''),
        game_data.get('opponent_name', current_row[3] if len(current_row) > 3 else ''),
        game_data.get('starting_position', current_row[4] if len(current_row) > 4 else ''),
        game_data.get('game_start_timestamp', current_row[5] if len(current_row) > 5 else ''),
        game_data.get('game_end_timestamp', current_row[6] if len(current_row) > 6 else ''),
        game_data.get('alternate_gender_ratio', current_row[7] if len(current_row) > 7 else ''),
        game_data.get('alternate_gender_pulls', current_row[8] if len(current_row) > 8 else ''),
        game_data.get('starting_gender_ratio', current_row[9] if len(current_row) > 9 else ''),
        game_data.get('final_score_team', current_row[10] if len(current_row) > 10 else ''),
        game_data.get('final_score_opponent', current_row[11] if len(current_row) > 11 else ''),
        game_data.get('sheet_name', current_row[12] if len(current_row) > 12 else ''),
    ]
    
    update_range = f"Games!A{row_index+1}:M{row_index+1}"
    service.update_values(update_range, [updated_row])
    
    return {
        'game_id': game_id,
        **{k: v for k, v in zip([
            'team_id', 'team_name', 'opponent_name', 'starting_position',
            'game_start_timestamp', 'game_end_timestamp', 'alternate_gender_ratio',
            'alternate_gender_pulls', 'starting_gender_ratio', 'final_score_team',
            'final_score_opponent', 'sheet_name'
        ], updated_row[1:])}
    }


def append_game_event(game_id: str, event_row: List[str]) -> Dict[str, Any]:
    """Append an event row to a game tab."""
    service = _get_service()
    game = get_game_by_id(game_id)
    
    if not game:
        raise ValueError(f"Game {game_id} not found")
    
    sheet_name = game.get('sheet_name')
    if not sheet_name:
        raise ValueError(f"Game {game_id} has no sheet_name")
    
    # Append the event row
    service.append_values(sheet_name, [event_row])
    
    return {'success': True, 'game_id': game_id, 'sheet_name': sheet_name}


def append_game_events_batch(game_id: str, event_rows: List[List[str]]) -> Dict[str, Any]:
    """Append multiple event rows to a game tab (batch operation for efficiency)."""
    service = _get_service()
    game = get_game_by_id(game_id)
    
    if not game:
        raise ValueError(f"Game {game_id} not found")
    
    sheet_name = game.get('sheet_name')
    if not sheet_name:
        raise ValueError(f"Game {game_id} has no sheet_name")
    
    if not event_rows:
        raise ValueError("No event rows provided")
    
    # Append all rows in one batch operation
    service.append_values(sheet_name, event_rows)
    
    return {'success': True, 'game_id': game_id, 'sheet_name': sheet_name, 'rows_appended': len(event_rows)}


def sync_full_game(game_id: str, game_rows: List[List[str]]) -> Dict[str, Any]:
    """
    Full game sync - replace entire game tab with new data.
    Used for handoff scenarios where a user uploads complete game state.
    
    Args:
        game_id: Game ID
        game_rows: Complete list of rows (headers + data) to write to the game tab
    
    Returns:
        Success status
    """
    service = _get_service()
    game = get_game_by_id(game_id)
    
    if not game:
        raise ValueError(f"Game {game_id} not found")
    
    sheet_name = game.get('sheet_name')
    if not sheet_name:
        raise ValueError(f"Game {game_id} has no sheet_name")
    
    if not game_rows:
        raise ValueError("No game rows provided")
    
    # Clear existing data (keep sheet, but clear all rows)
    # Get current row count
    existing_values = service.get_values(sheet_name)
    if existing_values:
        # Delete all existing rows (keep headers if they exist)
        # For simplicity, we'll clear everything and write new data
        # In production, might want to preserve headers
        pass
    
    # Write all rows starting from A1
    # This will overwrite existing data
    service.update_values(f"{sheet_name}!A1", game_rows)
    
    return {'success': True, 'game_id': game_id, 'sheet_name': sheet_name, 'rows_written': len(game_rows)}


def get_game_data(game_id: str) -> List[List[str]]:
    """Get all rows from a game tab."""
    service = _get_service()
    game = get_game_by_id(game_id)
    
    if not game:
        raise ValueError(f"Game {game_id} not found")
    
    sheet_name = game.get('sheet_name')
    if not sheet_name:
        raise ValueError(f"Game {game_id} has no sheet_name")
    
    return service.get_values(sheet_name)


# User operations (reused from license plate game pattern)
def get_users() -> List[Dict[str, Any]]:
    """Get all users from the Google Sheet."""
    _initialize_sheets()  # Ensure required sheets exist
    service = _get_service()
    try:
        values = service.get_values('users')
    except Exception:
        # Sheet might not exist yet, return empty list
        return []
    
    if not values or len(values) <= 1:  # Empty or just headers
        return []
    
    # Format: [username, email, full_name, hashed_password, created_at, active_games]
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
    _initialize_sheets()  # Ensure required sheets exist
    service = _get_service()
    
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
    
    service.append_values('users', values)
    
    return {
        'username': user_data['username'],
        'email': user_data.get('email'),
        'full_name': user_data.get('full_name'),
        'active_games': user_data.get('active_games', [])
    }

