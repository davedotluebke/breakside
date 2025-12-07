"""
Index storage for efficient cross-entity queries.
Maintains mappings between players, teams, and games.
The index is stored in a single file and can be rebuilt on demand.
"""
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Set

# Import config - handle both relative and absolute imports
try:
    from config import INDEX_FILE, GAMES_DIR, TEAMS_DIR, PLAYERS_DIR
except ImportError:
    try:
        from ultistats_server.config import INDEX_FILE, GAMES_DIR, TEAMS_DIR, PLAYERS_DIR
    except ImportError:
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from config import INDEX_FILE, GAMES_DIR, TEAMS_DIR, PLAYERS_DIR


def _load_index() -> dict:
    """Load the index from disk, or return empty structure if not exists."""
    if INDEX_FILE.exists():
        try:
            with open(INDEX_FILE, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    
    return {
        "lastRebuilt": None,
        "playerGames": {},    # playerId -> [gameId, ...]
        "teamGames": {},      # teamId -> [gameId, ...]
        "gameRoster": {},     # gameId -> [playerId, ...]
        "playerTeams": {},    # playerId -> [teamId, ...]
    }


def _save_index(index: dict) -> None:
    """Save the index to disk."""
    INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(INDEX_FILE, 'w') as f:
        json.dump(index, f, indent=2)


def rebuild_index() -> dict:
    """
    Rebuild the entire index by scanning all entities.
    
    Returns:
        The rebuilt index with stats
    """
    index = {
        "lastRebuilt": datetime.now().isoformat(),
        "playerGames": {},
        "teamGames": {},
        "gameRoster": {},
        "playerTeams": {},
    }
    
    # Build playerTeams from teams
    if TEAMS_DIR.exists():
        for team_file in TEAMS_DIR.glob("*.json"):
            try:
                with open(team_file, 'r') as f:
                    team_data = json.load(f)
                team_id = team_data.get('id', team_file.stem)
                player_ids = team_data.get('playerIds', [])
                
                for player_id in player_ids:
                    if player_id not in index["playerTeams"]:
                        index["playerTeams"][player_id] = []
                    if team_id not in index["playerTeams"][player_id]:
                        index["playerTeams"][player_id].append(team_id)
            except (json.JSONDecodeError, KeyError):
                continue
    
    # Build game-related indexes from games
    if GAMES_DIR.exists():
        for game_dir in GAMES_DIR.iterdir():
            if not game_dir.is_dir():
                continue
            
            current_file = game_dir / "current.json"
            if not current_file.exists():
                continue
            
            try:
                with open(current_file, 'r') as f:
                    game_data = json.load(f)
                
                game_id = game_dir.name
                team_id = game_data.get('teamId')
                
                # Add to teamGames
                if team_id:
                    if team_id not in index["teamGames"]:
                        index["teamGames"][team_id] = []
                    if game_id not in index["teamGames"][team_id]:
                        index["teamGames"][team_id].append(game_id)
                
                # Extract player IDs from rosterSnapshot or points
                player_ids = set()
                
                # From rosterSnapshot (preferred)
                roster_snapshot = game_data.get('rosterSnapshot', {})
                for player in roster_snapshot.get('players', []):
                    if 'id' in player:
                        player_ids.add(player['id'])
                
                # From points (fallback for legacy or additional tracking)
                for point in game_data.get('points', []):
                    # Check point.players (might be IDs or names)
                    for player_ref in point.get('players', []):
                        if isinstance(player_ref, str) and '-' in player_ref:
                            # Looks like an ID (has hash suffix)
                            player_ids.add(player_ref)
                    
                    # Check events for player IDs
                    for possession in point.get('possessions', []):
                        for event in possession.get('events', []):
                            for key in ['throwerId', 'receiverId', 'defenderId', 'pullerId']:
                                if key in event and event[key]:
                                    player_ids.add(event[key])
                
                # Store gameRoster
                index["gameRoster"][game_id] = list(player_ids)
                
                # Update playerGames
                for player_id in player_ids:
                    if player_id not in index["playerGames"]:
                        index["playerGames"][player_id] = []
                    if game_id not in index["playerGames"][player_id]:
                        index["playerGames"][player_id].append(game_id)
                
            except (json.JSONDecodeError, KeyError):
                continue
    
    _save_index(index)
    return index


def get_index() -> dict:
    """
    Get the current index, rebuilding if necessary.
    
    Returns:
        The index dictionary
    """
    index = _load_index()
    if index.get("lastRebuilt") is None:
        index = rebuild_index()
    return index


def get_index_status() -> dict:
    """
    Get status information about the index.
    
    Returns:
        Dictionary with index stats
    """
    index = _load_index()
    return {
        "lastRebuilt": index.get("lastRebuilt"),
        "playerCount": len(index.get("playerGames", {})),
        "teamCount": len(index.get("teamGames", {})),
        "gameCount": len(index.get("gameRoster", {})),
        "indexExists": INDEX_FILE.exists(),
    }


def get_player_games(player_id: str) -> List[str]:
    """
    Get all game IDs for a player.
    
    Args:
        player_id: The player's ID
        
    Returns:
        List of game IDs
    """
    index = get_index()
    return index.get("playerGames", {}).get(player_id, [])


def get_team_games(team_id: str) -> List[str]:
    """
    Get all game IDs for a team.
    
    Args:
        team_id: The team's ID
        
    Returns:
        List of game IDs
    """
    index = get_index()
    return index.get("teamGames", {}).get(team_id, [])


def get_game_players(game_id: str) -> List[str]:
    """
    Get all player IDs for a game.
    
    Args:
        game_id: The game's ID
        
    Returns:
        List of player IDs
    """
    index = get_index()
    return index.get("gameRoster", {}).get(game_id, [])


def get_player_teams(player_id: str) -> List[str]:
    """
    Get all team IDs for a player.
    
    Args:
        player_id: The player's ID
        
    Returns:
        List of team IDs
    """
    index = get_index()
    return index.get("playerTeams", {}).get(player_id, [])


def update_index_for_game(game_id: str, game_data: dict) -> None:
    """
    Update the index for a specific game (incremental update).
    
    Args:
        game_id: The game's ID
        game_data: The game data
    """
    index = _load_index()
    if index.get("lastRebuilt") is None:
        # No index yet, do full rebuild
        rebuild_index()
        return
    
    team_id = game_data.get('teamId')
    
    # Update teamGames
    if team_id:
        if team_id not in index["teamGames"]:
            index["teamGames"][team_id] = []
        if game_id not in index["teamGames"][team_id]:
            index["teamGames"][team_id].append(game_id)
    
    # Extract player IDs
    player_ids = set()
    
    roster_snapshot = game_data.get('rosterSnapshot', {})
    for player in roster_snapshot.get('players', []):
        if 'id' in player:
            player_ids.add(player['id'])
    
    for point in game_data.get('points', []):
        for player_ref in point.get('players', []):
            if isinstance(player_ref, str) and '-' in player_ref:
                player_ids.add(player_ref)
        
        for possession in point.get('possessions', []):
            for event in possession.get('events', []):
                for key in ['throwerId', 'receiverId', 'defenderId', 'pullerId']:
                    if key in event and event[key]:
                        player_ids.add(event[key])
    
    # Update gameRoster
    index["gameRoster"][game_id] = list(player_ids)
    
    # Update playerGames
    for player_id in player_ids:
        if player_id not in index["playerGames"]:
            index["playerGames"][player_id] = []
        if game_id not in index["playerGames"][player_id]:
            index["playerGames"][player_id].append(game_id)
    
    _save_index(index)


def update_index_for_team(team_id: str, team_data: dict) -> None:
    """
    Update the index for a specific team (incremental update).
    
    Args:
        team_id: The team's ID
        team_data: The team data
    """
    index = _load_index()
    if index.get("lastRebuilt") is None:
        rebuild_index()
        return
    
    player_ids = team_data.get('playerIds', [])
    
    # Update playerTeams
    for player_id in player_ids:
        if player_id not in index["playerTeams"]:
            index["playerTeams"][player_id] = []
        if team_id not in index["playerTeams"][player_id]:
            index["playerTeams"][player_id].append(team_id)
    
    _save_index(index)

