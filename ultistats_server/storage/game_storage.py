"""
Game storage using JSON files with versioning support.
"""
import json
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
import shutil

from pathlib import Path
import sys

# Import config - handle both relative and absolute imports
try:
    from config import GAMES_DIR, ENABLE_GIT_VERSIONING
except ImportError:
    # Try absolute import (when running as package)
    try:
        from ultistats_server.config import GAMES_DIR, ENABLE_GIT_VERSIONING
    except ImportError:
        # Fallback: add parent to path
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from config import GAMES_DIR, ENABLE_GIT_VERSIONING


def _update_index_for_game(game_id: str, game_data: dict) -> None:
    """Update the index for this game. Imported lazily to avoid circular imports."""
    try:
        from storage.index_storage import update_index_for_game
        update_index_for_game(game_id, game_data)
    except ImportError:
        try:
            from ultistats_server.storage.index_storage import update_index_for_game
            update_index_for_game(game_id, game_data)
        except ImportError:
            # Index storage not available, skip
            pass


def save_game_version(game_id: str, game_data: dict) -> str:
    """
    Save game with versioning.
    
    Creates a timestamped version file and updates current.json.
    Optionally commits to git if git versioning is enabled.
    
    Args:
        game_id: Unique game identifier
        game_data: Complete game data dictionary
        
    Returns:
        Path to the version file that was created
    """
    game_dir = GAMES_DIR / game_id
    game_dir.mkdir(parents=True, exist_ok=True)
    versions_dir = game_dir / "versions"
    versions_dir.mkdir(exist_ok=True)
    
    # Create timestamped version
    timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    version_file = versions_dir / f"{timestamp}.json"
    
    # Write version file
    with open(version_file, 'w') as f:
        json.dump(game_data, f, indent=2)
    
    # Update current.json
    current_file = game_dir / "current.json"
    shutil.copy(version_file, current_file)
    
    # Optional: Git commit
    if ENABLE_GIT_VERSIONING:
        git_dir = game_dir / ".git"
        if git_dir.exists():
            # Add files
            subprocess.run(
                ["git", "-C", str(game_dir), "add", "versions/", "current.json"],
                check=False,
                capture_output=True
            )
            # Commit
            subprocess.run(
                ["git", "-C", str(game_dir), "commit", "-m", f"Sync at {timestamp}"],
                check=False,
                capture_output=True
            )
        else:
            # Initialize git repo if it doesn't exist
            subprocess.run(
                ["git", "-C", str(game_dir), "init"],
                check=False,
                capture_output=True
            )
            # Create .gitignore
            gitignore_file = game_dir / ".gitignore"
            if not gitignore_file.exists():
                with open(gitignore_file, 'w') as f:
                    f.write("__pycache__/\n*.pyc\n")
            # Add and commit
            subprocess.run(
                ["git", "-C", str(game_dir), "add", "."],
                check=False,
                capture_output=True
            )
            subprocess.run(
                ["git", "-C", str(game_dir), "commit", "-m", f"Initial commit at {timestamp}"],
                check=False,
                capture_output=True
            )
    
    # Update the index
    _update_index_for_game(game_id, game_data)
    
    return str(version_file)


def get_game_current(game_id: str) -> dict:
    """
    Get current version of game.
    
    Args:
        game_id: Unique game identifier
        
    Returns:
        Game data dictionary
        
    Raises:
        FileNotFoundError: If game doesn't exist
    """
    current_file = GAMES_DIR / game_id / "current.json"
    if not current_file.exists():
        raise FileNotFoundError(f"Game {game_id} not found")
    
    with open(current_file, 'r') as f:
        return json.load(f)


def get_game_version(game_id: str, timestamp: str) -> dict:
    """
    Get specific version of game.
    
    Args:
        game_id: Unique game identifier
        timestamp: Version timestamp (format: YYYY-MM-DDTHH-MM-SS)
        
    Returns:
        Game data dictionary
        
    Raises:
        FileNotFoundError: If version doesn't exist
    """
    version_file = GAMES_DIR / game_id / "versions" / f"{timestamp}.json"
    if not version_file.exists():
        raise FileNotFoundError(f"Version {timestamp} not found for game {game_id}")
    
    with open(version_file, 'r') as f:
        return json.load(f)


def list_game_versions(game_id: str) -> List[str]:
    """
    List all versions of a game.
    
    Args:
        game_id: Unique game identifier
        
    Returns:
        List of version timestamps (newest first)
    """
    versions_dir = GAMES_DIR / game_id / "versions"
    if not versions_dir.exists():
        return []
    
    versions = sorted([f.stem for f in versions_dir.glob("*.json")], reverse=True)
    return versions


def game_exists(game_id: str) -> bool:
    """
    Check if a game exists.
    
    Args:
        game_id: Unique game identifier
        
    Returns:
        True if game exists, False otherwise
    """
    current_file = GAMES_DIR / game_id / "current.json"
    return current_file.exists()


def delete_game(game_id: str) -> bool:
    """
    Delete a game and all its versions.
    
    Args:
        game_id: Unique game identifier
        
    Returns:
        True if game was deleted, False if it didn't exist
    """
    game_dir = GAMES_DIR / game_id
    if not game_dir.exists():
        return False
    
    shutil.rmtree(game_dir)
    return True


def list_all_games() -> List[Dict[str, any]]:
    """
    List all games with metadata.
    
    Returns:
        List of dictionaries with game_id and metadata
    """
    games = []
    for game_dir in GAMES_DIR.iterdir():
        if not game_dir.is_dir():
            continue
        
        current_file = game_dir / "current.json"
        if not current_file.exists():
            continue
        
        try:
            with open(current_file, 'r') as f:
                game_data = json.load(f)
            
            # Extract metadata
            games.append({
                "game_id": game_dir.name,
                "team": game_data.get("team", "Unknown"),
                "teamId": game_data.get("teamId"),
                "opponent": game_data.get("opponent", "Unknown"),
                "game_start_timestamp": game_data.get("gameStartTimestamp"),
                "game_end_timestamp": game_data.get("gameEndTimestamp"),
                "scores": game_data.get("scores", {}),
                "points_count": len(game_data.get("points", [])),
            })
        except (json.JSONDecodeError, KeyError):
            # Skip invalid game files
            continue
    
    return games

