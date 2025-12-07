"""
Player storage using JSON files.
Each player is stored as a separate JSON file: data/players/{player_id}.json
"""
import json
import re
import random
import string
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

# Import config - handle both relative and absolute imports
try:
    from config import PLAYERS_DIR
except ImportError:
    try:
        from ultistats_server.config import PLAYERS_DIR
    except ImportError:
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from config import PLAYERS_DIR


def generate_player_id(name: str) -> str:
    """
    Generate a short, human-readable player ID.
    Format: {sanitized-name}-{4-char-hash}
    Example: "Alice-7f3a", "Bob-Smith-2d9e"
    """
    # Sanitize: keep alphanumeric and spaces, convert spaces to hyphens
    safe_name = re.sub(r'[^a-zA-Z0-9\s-]', '', name)
    safe_name = re.sub(r'\s+', '-', safe_name).strip('-')
    safe_name = safe_name[:20]  # Max 20 chars
    safe_name = re.sub(r'-+$', '', safe_name)  # Trim trailing hyphens
    
    if not safe_name:
        safe_name = "player"
    
    # Generate 4-char alphanumeric hash
    chars = string.ascii_lowercase + string.digits
    hash_part = ''.join(random.choice(chars) for _ in range(4))
    
    return f"{safe_name}-{hash_part}"


def _ensure_unique_id(player_id: str) -> str:
    """
    Ensure the player ID is unique. If collision, append extra chars.
    """
    original_id = player_id
    attempt = 0
    while player_exists(player_id):
        attempt += 1
        chars = string.ascii_lowercase + string.digits
        extra = ''.join(random.choice(chars) for _ in range(2))
        player_id = f"{original_id}{extra}"
        if attempt > 10:
            # Extremely unlikely, but prevent infinite loop
            player_id = f"{original_id}-{random.randint(1000, 9999)}"
            break
    return player_id


def save_player(player_data: dict, player_id: Optional[str] = None) -> str:
    """
    Save a player. If no ID provided, generates one from the name.
    
    Args:
        player_data: Player data dictionary (must include 'name')
        player_id: Optional existing player ID (for updates)
        
    Returns:
        The player ID
    """
    PLAYERS_DIR.mkdir(parents=True, exist_ok=True)
    
    if not player_id:
        name = player_data.get('name', 'Unknown')
        player_id = generate_player_id(name)
        player_id = _ensure_unique_id(player_id)
    
    # Strip client-side-only fields
    player_data.pop('_localOnly', None)
    
    # Add metadata
    now = datetime.now().isoformat()
    if 'createdAt' not in player_data:
        player_data['createdAt'] = now
    player_data['updatedAt'] = now
    player_data['id'] = player_id
    
    player_file = PLAYERS_DIR / f"{player_id}.json"
    with open(player_file, 'w') as f:
        json.dump(player_data, f, indent=2)
    
    return player_id


def get_player(player_id: str) -> dict:
    """
    Get a player by ID.
    
    Args:
        player_id: The player's unique ID
        
    Returns:
        Player data dictionary
        
    Raises:
        FileNotFoundError: If player doesn't exist
    """
    player_file = PLAYERS_DIR / f"{player_id}.json"
    if not player_file.exists():
        raise FileNotFoundError(f"Player {player_id} not found")
    
    with open(player_file, 'r') as f:
        return json.load(f)


def list_players() -> List[dict]:
    """
    List all players with their data.
    
    Returns:
        List of player data dictionaries
    """
    players = []
    if not PLAYERS_DIR.exists():
        return players
    
    for player_file in PLAYERS_DIR.glob("*.json"):
        try:
            with open(player_file, 'r') as f:
                player_data = json.load(f)
                players.append(player_data)
        except (json.JSONDecodeError, KeyError):
            # Skip invalid files
            continue
    
    # Sort by name
    players.sort(key=lambda p: p.get('name', '').lower())
    return players


def update_player(player_id: str, player_data: dict) -> str:
    """
    Update an existing player.
    
    Args:
        player_id: The player's unique ID
        player_data: Updated player data
        
    Returns:
        The player ID
        
    Raises:
        FileNotFoundError: If player doesn't exist
    """
    if not player_exists(player_id):
        raise FileNotFoundError(f"Player {player_id} not found")
    
    # Preserve createdAt from existing record
    existing = get_player(player_id)
    player_data['createdAt'] = existing.get('createdAt', datetime.now().isoformat())
    
    return save_player(player_data, player_id)


def delete_player(player_id: str) -> bool:
    """
    Delete a player.
    
    Args:
        player_id: The player's unique ID
        
    Returns:
        True if deleted, False if didn't exist
    """
    player_file = PLAYERS_DIR / f"{player_id}.json"
    if not player_file.exists():
        return False
    
    player_file.unlink()
    return True


def player_exists(player_id: str) -> bool:
    """
    Check if a player exists.
    
    Args:
        player_id: The player's unique ID
        
    Returns:
        True if player exists
    """
    player_file = PLAYERS_DIR / f"{player_id}.json"
    return player_file.exists()

