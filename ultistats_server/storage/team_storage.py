"""
Team storage using JSON files.
Each team is stored as a separate JSON file: data/teams/{team_id}.json
"""
import json
import re
import random
import string
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

# Import config and player storage - handle both relative and absolute imports
try:
    from config import TEAMS_DIR
    from storage.player_storage import get_player, player_exists
except ImportError:
    try:
        from ultistats_server.config import TEAMS_DIR
        from ultistats_server.storage.player_storage import get_player, player_exists
    except ImportError:
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from config import TEAMS_DIR
        from storage.player_storage import get_player, player_exists


def generate_team_id(name: str) -> str:
    """
    Generate a short, human-readable team ID.
    Format: {sanitized-name}-{4-char-hash}
    Example: "Sample-Team-b2c4", "Thunder-a1f3"
    """
    # Sanitize: keep alphanumeric and spaces, convert spaces to hyphens
    safe_name = re.sub(r'[^a-zA-Z0-9\s-]', '', name)
    safe_name = re.sub(r'\s+', '-', safe_name).strip('-')
    safe_name = safe_name[:20]  # Max 20 chars
    safe_name = re.sub(r'-+$', '', safe_name)  # Trim trailing hyphens
    
    if not safe_name:
        safe_name = "team"
    
    # Generate 4-char alphanumeric hash
    chars = string.ascii_lowercase + string.digits
    hash_part = ''.join(random.choice(chars) for _ in range(4))
    
    return f"{safe_name}-{hash_part}"


def _ensure_unique_id(team_id: str) -> str:
    """
    Ensure the team ID is unique. If collision, append extra chars.
    """
    original_id = team_id
    attempt = 0
    while team_exists(team_id):
        attempt += 1
        chars = string.ascii_lowercase + string.digits
        extra = ''.join(random.choice(chars) for _ in range(2))
        team_id = f"{original_id}{extra}"
        if attempt > 10:
            # Extremely unlikely, but prevent infinite loop
            team_id = f"{original_id}-{random.randint(1000, 9999)}"
            break
    return team_id


def save_team(team_data: dict, team_id: Optional[str] = None) -> str:
    """
    Save a team. If no ID provided, generates one from the name.
    
    Args:
        team_data: Team data dictionary (must include 'name')
        team_id: Optional existing team ID (for updates)
        
    Returns:
        The team ID
    """
    TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    
    if not team_id:
        name = team_data.get('name', 'Unknown')
        team_id = generate_team_id(name)
        team_id = _ensure_unique_id(team_id)
    
    # Strip client-side-only fields
    team_data.pop('_localOnly', None)
    
    # Add metadata
    now = datetime.now().isoformat()
    if 'createdAt' not in team_data:
        team_data['createdAt'] = now
    team_data['updatedAt'] = now
    team_data['id'] = team_id
    
    # Ensure playerIds is a list
    if 'playerIds' not in team_data:
        team_data['playerIds'] = []
    
    team_file = TEAMS_DIR / f"{team_id}.json"
    with open(team_file, 'w') as f:
        json.dump(team_data, f, indent=2)
    
    return team_id


def get_team(team_id: str) -> dict:
    """
    Get a team by ID.
    
    Args:
        team_id: The team's unique ID
        
    Returns:
        Team data dictionary
        
    Raises:
        FileNotFoundError: If team doesn't exist
    """
    team_file = TEAMS_DIR / f"{team_id}.json"
    if not team_file.exists():
        raise FileNotFoundError(f"Team {team_id} not found")
    
    with open(team_file, 'r') as f:
        return json.load(f)


def list_teams() -> List[dict]:
    """
    List all teams with their data.
    
    Returns:
        List of team data dictionaries
    """
    teams = []
    if not TEAMS_DIR.exists():
        return teams
    
    for team_file in TEAMS_DIR.glob("*.json"):
        try:
            with open(team_file, 'r') as f:
                team_data = json.load(f)
                teams.append(team_data)
        except (json.JSONDecodeError, KeyError):
            # Skip invalid files
            continue
    
    # Sort by name
    teams.sort(key=lambda t: t.get('name', '').lower())
    return teams


def update_team(team_id: str, team_data: dict) -> str:
    """
    Update an existing team.
    
    Args:
        team_id: The team's unique ID
        team_data: Updated team data
        
    Returns:
        The team ID
        
    Raises:
        FileNotFoundError: If team doesn't exist
    """
    if not team_exists(team_id):
        raise FileNotFoundError(f"Team {team_id} not found")
    
    # Preserve createdAt from existing record
    existing = get_team(team_id)
    team_data['createdAt'] = existing.get('createdAt', datetime.now().isoformat())
    
    return save_team(team_data, team_id)


def delete_team(team_id: str) -> bool:
    """
    Delete a team.
    
    Args:
        team_id: The team's unique ID
        
    Returns:
        True if deleted, False if didn't exist
    """
    team_file = TEAMS_DIR / f"{team_id}.json"
    if not team_file.exists():
        return False
    
    team_file.unlink()
    return True


def team_exists(team_id: str) -> bool:
    """
    Check if a team exists.
    
    Args:
        team_id: The team's unique ID
        
    Returns:
        True if team exists
    """
    team_file = TEAMS_DIR / f"{team_id}.json"
    return team_file.exists()


def get_team_players(team_id: str) -> List[dict]:
    """
    Get all players for a team (resolved from playerIds).
    
    Args:
        team_id: The team's unique ID
        
    Returns:
        List of player data dictionaries
        
    Raises:
        FileNotFoundError: If team doesn't exist
    """
    team = get_team(team_id)
    player_ids = team.get('playerIds', [])
    
    players = []
    for player_id in player_ids:
        try:
            player = get_player(player_id)
            players.append(player)
        except FileNotFoundError:
            # Player was deleted, skip
            continue
    
    return players

