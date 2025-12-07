#!/usr/bin/env python3
"""
Migrate legacy game files to use player IDs instead of names.
Adds teamId, rosterSnapshot, and updates event references.
"""
import json
from pathlib import Path
from datetime import datetime

# Paths
DATA_DIR = Path(__file__).parent.parent / "data"
PLAYERS_DIR = DATA_DIR / "players"
GAMES_DIR = DATA_DIR / "games"
TEAMS_DIR = DATA_DIR / "teams"

# Build name-to-ID mapping from player files
def build_name_to_id_map():
    """Read all player files and build name -> id mapping."""
    name_to_id = {}
    for player_file in PLAYERS_DIR.glob("*.json"):
        with open(player_file, 'r') as f:
            player = json.load(f)
            name_to_id[player['name']] = player['id']
    return name_to_id

# Build full player data for rosterSnapshot
def build_player_data():
    """Read all player files and return dict of id -> player data."""
    players = {}
    for player_file in PLAYERS_DIR.glob("*.json"):
        with open(player_file, 'r') as f:
            player = json.load(f)
            players[player['id']] = {
                'id': player['id'],
                'name': player['name'],
                'nickname': player.get('nickname', ''),
                'number': player.get('number'),
                'gender': player.get('gender', 'Unknown')
            }
    return players

def get_team_id():
    """Get the CUDO Mixed team ID."""
    for team_file in TEAMS_DIR.glob("*.json"):
        with open(team_file, 'r') as f:
            team = json.load(f)
            if "CUDO" in team.get('name', ''):
                return team['id']
    return None

def migrate_game(game_path: Path, name_to_id: dict, player_data: dict, team_id: str):
    """Migrate a single game file."""
    current_file = game_path / "current.json"
    if not current_file.exists():
        print(f"  Skipping {game_path.name} - no current.json")
        return False
    
    with open(current_file, 'r') as f:
        game = json.load(f)
    
    # Check if already migrated
    if game.get('teamId') and game.get('rosterSnapshot'):
        print(f"  Skipping {game_path.name} - already migrated")
        return False
    
    print(f"  Migrating {game_path.name}...")
    
    # Add teamId
    game['teamId'] = team_id
    
    # Build rosterSnapshot from all players who participated
    participating_players = set()
    for point in game.get('points', []):
        for player_name in point.get('players', []):
            if player_name in name_to_id:
                participating_players.add(name_to_id[player_name])
    
    # Also check events for player names
    for point in game.get('points', []):
        for possession in point.get('possessions', []):
            for event in possession.get('events', []):
                for key in ['thrower', 'receiver', 'defender', 'puller']:
                    if key in event and event[key] in name_to_id:
                        participating_players.add(name_to_id[event[key]])
    
    # Create rosterSnapshot
    roster_players = [player_data[pid] for pid in participating_players if pid in player_data]
    roster_players.sort(key=lambda p: p['name'])
    
    game['rosterSnapshot'] = {
        'players': roster_players,
        'capturedAt': datetime.now().isoformat()
    }
    
    # Update points.players to use IDs
    for point in game.get('points', []):
        new_players = []
        for player_name in point.get('players', []):
            if player_name in name_to_id:
                new_players.append(name_to_id[player_name])
            else:
                # Keep name if no mapping (shouldn't happen)
                new_players.append(player_name)
        point['players'] = new_players
    
    # Update events to include IDs alongside names
    for point in game.get('points', []):
        for possession in point.get('possessions', []):
            for event in possession.get('events', []):
                # Add ID fields for player references
                if 'thrower' in event and event['thrower'] in name_to_id:
                    event['throwerId'] = name_to_id[event['thrower']]
                if 'receiver' in event and event['receiver'] in name_to_id:
                    event['receiverId'] = name_to_id[event['receiver']]
                if 'defender' in event and event['defender'] in name_to_id:
                    event['defenderId'] = name_to_id[event['defender']]
                if 'puller' in event and event['puller'] in name_to_id:
                    event['pullerId'] = name_to_id[event['puller']]
    
    # Write back
    with open(current_file, 'w') as f:
        json.dump(game, f, indent=2)
    
    return True

def main():
    print("Building player name -> ID mapping...")
    name_to_id = build_name_to_id_map()
    print(f"  Found {len(name_to_id)} players:")
    for name, pid in sorted(name_to_id.items()):
        print(f"    {name} -> {pid}")
    
    print("\nBuilding player data for rosterSnapshot...")
    player_data = build_player_data()
    
    print("\nGetting team ID...")
    team_id = get_team_id()
    print(f"  Team ID: {team_id}")
    
    if not team_id:
        print("ERROR: Could not find CUDO Mixed team")
        return
    
    print("\nMigrating games...")
    migrated = 0
    for game_dir in GAMES_DIR.iterdir():
        if game_dir.is_dir():
            if migrate_game(game_dir, name_to_id, player_data, team_id):
                migrated += 1
    
    print(f"\nMigrated {migrated} games")
    print("\nDon't forget to rebuild the index: POST /index/rebuild")

if __name__ == "__main__":
    main()

