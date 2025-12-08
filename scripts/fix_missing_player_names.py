#!/usr/bin/env python3
"""
Script to fix corrupted game data where player names (puller, thrower, receiver, defender)
are missing from events but player IDs (pullerId, throwerId, receiverId, defenderId) are present.

This recovers the player names by looking them up in the game's rosterSnapshot.

Usage:
    python scripts/fix_missing_player_names.py [--dry-run]
"""

import json
import sys
from pathlib import Path
from typing import Dict, Optional

# Path to games directory
GAMES_DIR = Path(__file__).parent.parent / "data" / "games"


def get_player_name_from_roster(roster_snapshot: dict, player_id: str) -> Optional[str]:
    """Look up a player's name from the roster snapshot by their ID."""
    if not roster_snapshot or "players" not in roster_snapshot:
        return None
    
    for player in roster_snapshot["players"]:
        if player.get("id") == player_id:
            return player.get("name")
    
    return None


def fix_event(event: dict, roster_snapshot: dict) -> tuple[dict, int]:
    """
    Fix a single event by recovering missing player names from IDs.
    Returns the fixed event and the count of fixes made.
    """
    fixes = 0
    
    # Map of name field -> id field
    player_fields = [
        ("puller", "pullerId"),
        ("thrower", "throwerId"),
        ("receiver", "receiverId"),
        ("defender", "defenderId"),
    ]
    
    for name_field, id_field in player_fields:
        # Check if name is missing but ID is present
        if id_field in event and name_field not in event:
            player_id = event[id_field]
            player_name = get_player_name_from_roster(roster_snapshot, player_id)
            
            if player_name:
                event[name_field] = player_name
                fixes += 1
                print(f"    Fixed: {name_field} = '{player_name}' (from {id_field} = '{player_id}')")
    
    return event, fixes


def fix_game_file(game_path: Path, dry_run: bool = False) -> int:
    """
    Fix a single game's current.json file.
    Returns the total number of fixes made.
    """
    current_file = game_path / "current.json"
    
    if not current_file.exists():
        return 0
    
    try:
        with open(current_file, 'r') as f:
            game_data = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"  Error reading {current_file}: {e}")
        return 0
    
    roster_snapshot = game_data.get("rosterSnapshot")
    if not roster_snapshot:
        print(f"  No rosterSnapshot in {game_path.name}")
        return 0
    
    total_fixes = 0
    
    # Iterate through all points and possessions
    for point_idx, point in enumerate(game_data.get("points", [])):
        for poss_idx, possession in enumerate(point.get("possessions", [])):
            for event_idx, event in enumerate(possession.get("events", [])):
                _, fixes = fix_event(event, roster_snapshot)
                total_fixes += fixes
    
    if total_fixes > 0 and not dry_run:
        # Write the fixed data back
        with open(current_file, 'w') as f:
            json.dump(game_data, f, indent=2)
        print(f"  Saved {total_fixes} fixes to {current_file}")
    
    return total_fixes


def main():
    dry_run = "--dry-run" in sys.argv
    
    if dry_run:
        print("DRY RUN - no files will be modified\n")
    
    if not GAMES_DIR.exists():
        print(f"Games directory not found: {GAMES_DIR}")
        sys.exit(1)
    
    total_fixes = 0
    games_fixed = 0
    
    for game_dir in sorted(GAMES_DIR.iterdir()):
        if not game_dir.is_dir():
            continue
        
        print(f"Checking {game_dir.name}...")
        fixes = fix_game_file(game_dir, dry_run)
        
        if fixes > 0:
            games_fixed += 1
            total_fixes += fixes
    
    print(f"\n{'Would fix' if dry_run else 'Fixed'} {total_fixes} missing player names in {games_fixed} games")
    
    if dry_run and total_fixes > 0:
        print("\nRun without --dry-run to apply fixes")


if __name__ == "__main__":
    main()

