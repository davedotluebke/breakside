"""
Game storage using JSON files with versioning support.
"""
import json
import os
import subprocess
import threading
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

from .file_utils import atomic_write_json

# Cap retained version backups per game to bound disk growth. The most recent
# MAX_VERSIONS are always kept; older ones are thinned to one-per-day so some
# history survives without unbounded accumulation (a live game synced every
# few seconds for hours otherwise produces thousands of full-state copies).
MAX_VERSIONS = int(os.getenv("BREAKSIDE_MAX_VERSIONS", "200"))


# Serializes the read-merge-write of current.json so two coaches syncing at
# the same instant can't interleave and lose each other's edits.
_SAVE_LOCK = threading.Lock()


def _safe_game_dir(game_id: str) -> Path:
    """Resolve a game's directory and confirm it stays under GAMES_DIR.

    Defense-in-depth against path traversal: the API layer validates IDs
    against ``^[A-Za-z0-9_-]+$``, but this storage helper independently
    rejects any ``game_id`` (or ``timestamp``) that would escape GAMES_DIR,
    so a missed validation upstream still can't read/write outside the games
    tree. Raises FileNotFoundError on escape (treated as "not found").
    """
    base = GAMES_DIR.resolve()
    candidate = (base / game_id).resolve()
    if base != candidate and base not in candidate.parents:
        raise FileNotFoundError(f"Invalid game id: {game_id!r}")
    return candidate

# odOnDeckLine is the side-agnostic "On Deck" line (point-after-next); it
# merges with the same per-axis last-writer-wins rule as the O/D/OD lines.
_LINE_KEYS = ("oLine", "dLine", "odLine", "odOnDeckLine")


def _ts(value) -> float:
    """Coerce a modification marker into a comparable number.

    Handles both ISO-8601 strings (the line *ModifiedAt fields) and epoch
    milliseconds (lineupReadyAt). Missing/invalid markers sort oldest.
    """
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def merge_pending_next_line(existing: Optional[dict], incoming: Optional[dict]) -> Optional[dict]:
    """Merge two pendingNextLine dicts, last-writer-wins per field by timestamp.

    Each of the O / D / O-D lines carries its own *ModifiedAt, so an edit to
    one line type never clobbers a newer edit to another — and a stale writer
    (e.g. the Active Coach re-syncing mid-point with their old line copy) can't
    roll back a newer selection from the Line Coach. Mirrors the client-side
    read merge in store/sync.js so both directions agree.
    """
    if not existing:
        return incoming
    if not incoming:
        return existing

    merged = dict(existing)
    for line_key in _LINE_KEYS:
        mod_key = line_key.replace("Line", "LineModifiedAt")
        if _ts(incoming.get(mod_key)) > _ts(existing.get(mod_key)):
            merged[line_key] = incoming.get(line_key, [])
            merged[mod_key] = incoming.get(mod_key)

    # "Lineup Ready" signal: Line Coach writes, Active Coach reads.
    # Fire-and-forget ping — AC's polling shows a toast when lineupReadyAt
    # advances; no persistent latch beyond that.
    if _ts(incoming.get("lineupReadyAt")) > _ts(existing.get("lineupReadyAt")):
        merged["lineupReadyAt"] = incoming.get("lineupReadyAt")
        merged["lineupReadyBy"] = incoming.get("lineupReadyBy")

    # LC-viewing signal: only the Line Coach writes lineCoachViewing /
    # lineCoachViewingAt (client gates on isLineCoach). The Active Coach
    # reads it to render the "Line Coach: viewing the X line" sub-header.
    # Independent last-writer-wins on lineCoachViewingAt.
    if _ts(incoming.get("lineCoachViewingAt")) > _ts(existing.get("lineCoachViewingAt")):
        merged["lineCoachViewing"] = incoming.get("lineCoachViewing")
        merged["lineCoachViewingAt"] = incoming.get("lineCoachViewingAt")

    # activeType is local UI state; honor the most recent writer's value if set.
    if "activeType" in incoming:
        merged["activeType"] = incoming["activeType"]

    return merged


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


def save_game_version(game_id: str, game_data: dict,
                      authoritative_game_data: bool = True) -> str:
    """
    Save game with versioning.

    Creates a timestamped version file and updates current.json.
    Optionally commits to git if git versioning is enabled.

    Incoming state is merged against the existing current.json so that
    concurrent coaches don't clobber each other:
      - pendingNextLine is always merged per-field by timestamp (see
        merge_pending_next_line) — a stale line copy never reverts a newer one.
      - When authoritative_game_data is False, the caller is a writer who does
        NOT own the game's play data (e.g. a Line Coach syncing while another
        coach holds the Active Coach role). Their points/scores/events are
        ignored and the server's existing game data is preserved; only their
        merged line selections are applied.

    Args:
        game_id: Unique game identifier
        game_data: Complete game data dictionary
        authoritative_game_data: Whether this writer owns the play data

    Returns:
        Path to the version file that was created
    """
    game_dir = _safe_game_dir(game_id)
    game_dir.mkdir(parents=True, exist_ok=True)
    versions_dir = game_dir / "versions"
    versions_dir.mkdir(exist_ok=True)
    current_file = game_dir / "current.json"

    with _SAVE_LOCK:
        existing = None
        if current_file.exists():
            try:
                with open(current_file, 'r') as f:
                    existing = json.load(f)
            except (json.JSONDecodeError, OSError):
                existing = None

        if existing is not None:
            merged_pnl = merge_pending_next_line(
                existing.get("pendingNextLine"), game_data.get("pendingNextLine")
            )
            if authoritative_game_data:
                final_data = dict(game_data)
            else:
                # Preserve the play-data owner's game state; take only lines.
                final_data = dict(existing)
            if merged_pnl is not None:
                final_data["pendingNextLine"] = merged_pnl
        else:
            # First write for this game — nothing to merge against.
            final_data = game_data

        return _write_game_version(game_dir, versions_dir, current_file,
                                   game_id, final_data)


def _prune_versions(versions_dir: Path, max_versions: int = MAX_VERSIONS) -> None:
    """Bound the number of retained version files.

    Keeps the most recent ``max_versions`` files in full; for everything older,
    keeps only the last version of each calendar day (a daily snapshot) and
    deletes the rest. Version stems start with ``YYYY-MM-DDT...`` so the date is
    the first 10 chars and lexical order matches chronological order.
    """
    if max_versions <= 0:
        return
    try:
        files = sorted(versions_dir.glob("*.json"), key=lambda p: p.stem)
    except OSError:
        return
    if len(files) <= max_versions:
        return

    older = files[:-max_versions]  # everything except the most-recent N
    # Among the older files, keep the last one per day (its date prefix).
    keep_per_day = {}
    for f in older:
        day = f.stem[:10]  # YYYY-MM-DD
        keep_per_day[day] = f  # later file for the same day overwrites → last wins
    keep = set(keep_per_day.values())

    for f in older:
        if f not in keep:
            try:
                f.unlink()
            except OSError:
                pass


def _unique_version_file(versions_dir: Path) -> str:
    """Build a collision-free version filename stem.

    Includes microseconds (``%f``) so two syncs in the same wall-clock second
    no longer overwrite each other, and appends an incrementing counter on the
    astronomically-rare same-microsecond collision. Stem stays within
    ``[A-Za-z0-9_-]`` so it round-trips through the ID validator.
    """
    base = datetime.now().strftime("%Y-%m-%dT%H-%M-%S-%f")
    candidate = versions_dir / f"{base}.json"
    counter = 1
    while candidate.exists():
        candidate = versions_dir / f"{base}_{counter:03d}.json"
        counter += 1
    return candidate.stem


def _write_game_version(game_dir: Path, versions_dir: Path, current_file: Path,
                        game_id: str, game_data: dict) -> str:
    """Persist game_data as a new timestamped version + current.json."""
    # Create timestamped, collision-free version
    timestamp = _unique_version_file(versions_dir)
    version_file = versions_dir / f"{timestamp}.json"

    # Write version file and current.json atomically (temp file + os.replace)
    # so a crash/concurrent read never sees a torn JSON file.
    atomic_write_json(version_file, game_data)
    atomic_write_json(current_file, game_data)

    # Prune old version backups to bound disk growth.
    _prune_versions(versions_dir)

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
    current_file = _safe_game_dir(game_id) / "current.json"
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
    versions_dir = (_safe_game_dir(game_id) / "versions").resolve()
    version_file = (versions_dir / f"{timestamp}.json").resolve()
    # Confirm the timestamp didn't escape the versions directory.
    if versions_dir not in version_file.parents:
        raise FileNotFoundError(f"Version {timestamp} not found for game {game_id}")
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


def update_game_metadata(game_id: str, updates: dict) -> dict:
    """
    Update lightweight metadata fields on the current game JSON without
    creating a new version. Intended for retroactive labels (phase, etc.).

    Args:
        game_id: Unique game identifier
        updates: Dict of fields to merge into the current game JSON

    Returns:
        Updated game data dict

    Raises:
        FileNotFoundError: If game doesn't exist
    """
    current_file = _safe_game_dir(game_id) / "current.json"
    if not current_file.exists():
        raise FileNotFoundError(f"Game {game_id} not found")

    # Serialize against save_game_version's read-merge-write of current.json
    # and write atomically so a concurrent sync can't be clobbered or read a
    # torn file.
    with _SAVE_LOCK:
        with open(current_file, 'r') as f:
            game_data = json.load(f)

        game_data.update(updates)

        atomic_write_json(current_file, game_data)

    _update_index_for_game(game_id, game_data)
    return game_data


def game_exists(game_id: str) -> bool:
    """
    Check if a game exists.
    
    Args:
        game_id: Unique game identifier
        
    Returns:
        True if game exists, False otherwise
    """
    try:
        current_file = _safe_game_dir(game_id) / "current.json"
    except FileNotFoundError:
        return False
    return current_file.exists()


def delete_game(game_id: str) -> bool:
    """
    Delete a game and all its versions.
    
    Args:
        game_id: Unique game identifier
        
    Returns:
        True if game was deleted, False if it didn't exist
    """
    try:
        game_dir = _safe_game_dir(game_id)
    except FileNotFoundError:
        return False
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
                "eventId": game_data.get("eventId"),
                "phase": game_data.get("phase"),
            })
        except (json.JSONDecodeError, KeyError):
            # Skip invalid game files
            continue
    
    return games

