"""
Index storage for efficient cross-entity queries.
Maintains mappings between players, teams, and games.
The index is stored in a single file and can be rebuilt on demand.
"""
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Set

from ._config import config
from .file_utils import atomic_write_json, entity_lock

INDEX_FILE = config.INDEX_FILE
GAMES_DIR = config.GAMES_DIR
TEAMS_DIR = config.TEAMS_DIR
PLAYERS_DIR = config.PLAYERS_DIR

# Serializes read-modify-write of the cross-entity index file.
_INDEX_LOCK_KEY = "entity-index"


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
    """Save the index to disk atomically."""
    atomic_write_json(INDEX_FILE, index)


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
                player_ids = team_data.get('playerIds') or []
                
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
                # `or {}` — clients may send an explicit null for legacy games
                roster_snapshot = game_data.get('rosterSnapshot') or {}
                for player in roster_snapshot.get('players') or []:
                    if 'id' in player:
                        player_ids.add(player['id'])
                
                # From points (fallback for legacy or additional tracking)
                for point in game_data.get('points') or []:
                    # Check point.players (might be IDs or names)
                    for player_ref in point.get('players') or []:
                        if isinstance(player_ref, str) and '-' in player_ref:
                            # Looks like an ID (has hash suffix)
                            player_ids.add(player_ref)
                    
                    # Check events for player IDs
                    for possession in point.get('possessions') or []:
                        for event in possession.get('events') or []:
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
    with entity_lock(_INDEX_LOCK_KEY):
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

        # `or {}` — clients may send an explicit null for legacy games
        roster_snapshot = game_data.get('rosterSnapshot') or {}
        for player in roster_snapshot.get('players') or []:
            if 'id' in player:
                player_ids.add(player['id'])

        for point in game_data.get('points') or []:
            for player_ref in point.get('players') or []:
                if isinstance(player_ref, str) and '-' in player_ref:
                    player_ids.add(player_ref)

            for possession in point.get('possessions') or []:
                for event in possession.get('events') or []:
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


def _scan_rosters_for_player(player_id: str) -> List[str]:
    """Team IDs whose stored roster contains ``player_id``, read from disk.

    Source of truth, bypassing the index entirely. O(number of teams).
    """
    found: List[str] = []
    if not TEAMS_DIR.exists():
        return found

    for team_file in TEAMS_DIR.glob("*.json"):
        try:
            with open(team_file, 'r') as f:
                team_data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if player_id in (team_data.get('playerIds') or []):
            found.append(team_data.get('id', team_file.stem))

    return found


def get_player_teams_verified(player_id: str) -> List[str]:
    """A player's team IDs, confirming an empty index answer against disk.

    Use this for AUTHORIZATION; ``get_player_teams`` is fine for display.

    ``playerTeams`` is a cache, and a miss is not evidence that a player is
    unrostered. The callers in ``auth/dependencies.py`` treat "no teams" as
    "orphaned player, any Coach may read/edit/delete it", so a stale miss
    fails OPEN. That is not hypothetical: an August 2026 audit of production
    found the index had not been rebuilt in eight months, leaving 298 of 316
    player records — 206 of them on live rosters — reachable by any account
    that created a throwaway team.

    Only a miss pays for the disk scan, so the hot path is unchanged.
    """
    teams = get_player_teams(player_id)
    if teams:
        return teams
    return _scan_rosters_for_player(player_id)


def link_player_to_team(player_id: str, team_id: str) -> None:
    """Record that ``player_id`` belongs to ``team_id``, immediately.

    Player creation and the team sync that adds them to a roster are two
    separate requests. Between them the player exists with no team, and the
    authorization layer reads "no team" as "orphan". Calling this at creation
    closes that window, so a player is never teamless even briefly.

    The next ``update_index_for_team`` reconciles the roster authoritatively,
    so a link written here is corrected if the team sync disagrees.
    """
    with entity_lock(_INDEX_LOCK_KEY):
        index = _load_index()
        if index.get("lastRebuilt") is None:
            rebuild_index()
            index = _load_index()
        teams = index.setdefault("playerTeams", {}).setdefault(player_id, [])
        if team_id not in teams:
            teams.append(team_id)
            _save_index(index)


def replace_player_in_index(player_id: str, tombstone_id: str) -> bool:
    """Swap an erased player's index rows for their tombstone's.

    Called by ``storage.erasure`` after the game documents have been scrubbed,
    and shaped so the index matches what ``rebuild_index`` would now produce:

    - ``gameRoster`` buckets: the tombstone now appears in those games'
      documents, so it takes the player's place rather than vanishing.
    - ``playerGames``: the player's row is renamed to the tombstone's.
    - ``playerTeams``: dropped outright. Erasure removes the player from every
      roster and leaves no tombstone there, so a rebuild would produce no row.

    Idempotent: a second call finds nothing and writes nothing.

    Returns:
        True if the index changed.
    """
    with entity_lock(_INDEX_LOCK_KEY):
        index = _load_index()
        changed = False

        game_roster = index.setdefault("gameRoster", {})
        for game_id, player_ids in game_roster.items():
            if player_id in player_ids:
                game_roster[game_id] = [
                    tombstone_id if pid == player_id else pid for pid in player_ids
                ]
                changed = True

        player_games = index.setdefault("playerGames", {})
        if player_id in player_games:
            games = player_games.pop(player_id)
            existing = player_games.setdefault(tombstone_id, [])
            for game_id in games:
                if game_id not in existing:
                    existing.append(game_id)
            changed = True

        if index.setdefault("playerTeams", {}).pop(player_id, None) is not None:
            changed = True

        if changed:
            _save_index(index)
        return changed


def remove_team_from_index(team_id: str, game_ids: List[str]) -> bool:
    """Drop an erased team and its games from every index bucket.

    ``game_ids`` are the games deleted with the team; their ``gameRoster`` rows
    and their appearances in ``playerGames`` go too. Players themselves are not
    removed — one may still be on another team — they simply lose this team and
    these games.

    Idempotent. Returns True if the index changed.
    """
    doomed = set(game_ids)
    with entity_lock(_INDEX_LOCK_KEY):
        index = _load_index()
        changed = False

        if index.setdefault("teamGames", {}).pop(team_id, None) is not None:
            changed = True

        game_roster = index.setdefault("gameRoster", {})
        for game_id in list(game_roster):
            if game_id in doomed:
                del game_roster[game_id]
                changed = True

        player_games = index.setdefault("playerGames", {})
        for player_id, games in list(player_games.items()):
            kept = [g for g in games if g not in doomed]
            if len(kept) != len(games):
                changed = True
                if kept:
                    player_games[player_id] = kept
                else:
                    del player_games[player_id]

        player_teams = index.setdefault("playerTeams", {})
        for player_id, teams in list(player_teams.items()):
            if team_id in teams:
                teams.remove(team_id)
                changed = True
            if not teams:
                del player_teams[player_id]

        if changed:
            _save_index(index)
        return changed


def update_index_for_team(team_id: str, team_data: dict) -> None:
    """
    Update the index for a specific team (incremental update).

    Reconciles ``playerTeams`` in BOTH directions: players on the roster gain
    the link, and players no longer on it lose it. An add-only update would
    leave a removed player still indexed against this team, which the
    authorization layer reads as continued Coach access to that player.

    Args:
        team_id: The team's ID
        team_data: The team data
    """
    with entity_lock(_INDEX_LOCK_KEY):
        index = _load_index()
        if index.get("lastRebuilt") is None:
            rebuild_index()
            return

        player_ids = set(team_data.get('playerIds') or [])
        player_teams = index.setdefault("playerTeams", {})

        # Link every player currently on the roster.
        for player_id in player_ids:
            teams = player_teams.setdefault(player_id, [])
            if team_id not in teams:
                teams.append(team_id)

        # Unlink players dropped from this roster since the last write.
        for player_id, teams in list(player_teams.items()):
            if player_id in player_ids:
                continue
            if team_id in teams:
                teams.remove(team_id)
            if not teams:
                del player_teams[player_id]

        _save_index(index)

