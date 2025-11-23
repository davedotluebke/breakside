"""
Test serialization with real game data from teamData.json.

This script loads a real teamData.json file and tests serialization
of actual games with all their complexity.
"""

import json
import sys
from pathlib import Path
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from sheets.serialization import serialize_game_to_sheet_rows, get_column_headers


def load_team_data(json_path: str):
    """
    Load team data from JSON file.
    
    Handles both formats:
    - Array of teams: [{team1}, {team2}, ...]
    - Single team object: {team}
    """
    with open(json_path, 'r') as f:
        data = json.load(f)
    
    # If it's a single team object, wrap it in a list
    if isinstance(data, dict):
        return [data]
    
    # If it's already a list, return as-is
    return data


def convert_event_for_serialization(event):
    """
    Convert event from JSON format to format expected by serialization.
    
    Events in JSON have player names as strings, but serialization
    expects them as dicts with 'name' key or strings.
    """
    converted = event.copy()
    
    # Convert player name strings to dicts with 'name' key
    for player_field in ['thrower', 'receiver', 'defender', 'puller']:
        if player_field in converted and isinstance(converted[player_field], str):
            if converted[player_field]:  # Not empty string
                converted[player_field] = {'name': converted[player_field]}
            else:
                converted[player_field] = None
    
    return converted


def convert_point_for_serialization(point, game_scores_before, game_scores_after):
    """
    Convert point from JSON format to format expected by serialization.
    
    - Convert timestamp strings to datetime objects
    - Convert player name strings in players array
    - Convert events to expected format
    """
    converted = point.copy()
    
    # Convert timestamps
    if converted.get('startTimestamp'):
        converted['startTimestamp'] = datetime.fromisoformat(converted['startTimestamp'].replace('Z', '+00:00'))
    if converted.get('endTimestamp'):
        converted['endTimestamp'] = datetime.fromisoformat(converted['endTimestamp'].replace('Z', '+00:00'))
    
    # Convert players array (player names as strings)
    if 'players' in converted and isinstance(converted['players'], list):
        # Keep as list of strings - serialization handles this
        pass
    
    # Convert possessions and events
    if 'possessions' in converted:
        converted['possessions'] = [
            {
                'offensive': p.get('offensive', True),
                'events': [convert_event_for_serialization(e) for e in p.get('events', [])]
            }
            for p in converted['possessions']
        ]
    
    return converted


def convert_game_for_serialization(game):
    """
    Convert game from JSON format to format expected by serialization.
    
    - Convert timestamp strings to datetime objects
    - Track scores as we process points
    """
    converted = game.copy()
    
    # Convert timestamps
    if converted.get('gameStartTimestamp'):
        converted['gameStartTimestamp'] = datetime.fromisoformat(
            converted['gameStartTimestamp'].replace('Z', '+00:00')
        )
    if converted.get('gameEndTimestamp'):
        converted['gameEndTimestamp'] = datetime.fromisoformat(
            converted['gameEndTimestamp'].replace('Z', '+00:00')
        )
    
    # Ensure scores dict exists
    if 'scores' not in converted:
        converted['scores'] = {'team': 0, 'opponent': 0}
    
    # Convert points
    if 'points' in converted:
        current_scores = converted['scores'].copy()
        converted_points = []
        
        for point in converted['points']:
            scores_before = current_scores.copy()
            converted_point = convert_point_for_serialization(point, scores_before, current_scores)
            converted_points.append(converted_point)
            
            # Update scores after point
            winner = converted_point.get('winner', '')
            if winner == 'team':
                current_scores['team'] = current_scores.get('team', 0) + 1
            elif winner == 'opponent':
                current_scores['opponent'] = current_scores.get('opponent', 0) + 1
        
        converted['points'] = converted_points
        converted['scores'] = current_scores
    
    return converted


def test_real_game_serialization(json_path: str, team_index: int = 0, game_index: int = 0):
    """
    Test serialization with a real game from teamData.json.
    
    Args:
        json_path: Path to teamData.json file
        team_index: Index of team to use (default 0)
        game_index: Index of game to serialize (default 0)
    """
    print(f"Loading team data from: {json_path}")
    teams_data = load_team_data(json_path)
    
    if not teams_data:
        print("❌ No teams found in JSON file")
        return False
    
    if team_index >= len(teams_data):
        print(f"❌ Team index {team_index} out of range (found {len(teams_data)} teams)")
        return False
    
    team = teams_data[team_index]
    print(f"\n📊 Team: {team.get('name', 'Unknown')}")
    print(f"   Games: {len(team.get('games', []))}")
    print(f"   Players: {len(team.get('teamRoster', []))}")
    
    games = team.get('games', [])
    if not games:
        print("❌ No games found for this team")
        return False
    
    if game_index >= len(games):
        print(f"❌ Game index {game_index} out of range (found {len(games)} games)")
        return False
    
    game = games[game_index]
    print(f"\n🎮 Game {game_index + 1}: {game.get('team', '')} vs {game.get('opponent', '')}")
    print(f"   Points: {len(game.get('points', []))}")
    print(f"   Score: {game.get('scores', {}).get('team', 0)}-{game.get('scores', {}).get('opponent', 0)}")
    
    # Count events
    total_events = 0
    for point in game.get('points', []):
        for possession in point.get('possessions', []):
            total_events += len(possession.get('events', []))
    print(f"   Total events: {total_events}")
    
    # Convert game to format expected by serialization
    print("\n🔄 Converting game format...")
    converted_game = convert_game_for_serialization(game)
    
    # Serialize to sheet rows
    print("📝 Serializing to Google Sheets format...")
    try:
        rows = serialize_game_to_sheet_rows(converted_game)
        print(f"✅ Successfully serialized to {len(rows)} rows")
        
        # Print summary
        print(f"\n📋 Sheet Summary:")
        print(f"   Header rows: 3")
        print(f"   Data rows: {len(rows) - 3}")
        print(f"   Total rows: {len(rows)}")
        
        # Show first few rows
        print(f"\n📄 First 5 rows preview:")
        headers = get_column_headers()
        for i, row in enumerate(rows[:5]):
            if i == 0:
                print(f"   Row {i+1} (Game metadata): {row[0]}")
            elif i == 1:
                print(f"   Row {i+1} (Headers): {', '.join(headers[:5])}...")
            else:
                # Show non-empty columns
                non_empty = [f"{headers[j]}:{row[j]}" for j in range(len(row)) if row[j]]
                print(f"   Row {i+1}: {', '.join(non_empty[:5])}...")
        
        # Validate row structure
        print(f"\n🔍 Validation:")
        if len(rows) < 3:
            print("   ❌ Not enough rows (need at least 3 for headers)")
            return False
        
        # Check header rows
        if rows[1] != headers:
            print("   ⚠️  Header row doesn't match expected headers")
        else:
            print("   ✅ Header row matches expected format")
        
        # Check that we have data rows
        if len(rows) == 3:
            print("   ⚠️  No data rows found (only headers)")
        else:
            print(f"   ✅ Found {len(rows) - 3} data rows")
        
        # Check row lengths
        all_same_length = all(len(row) == len(rows[0]) for row in rows)
        if all_same_length:
            print(f"   ✅ All rows have consistent length ({len(rows[0])} columns)")
        else:
            print("   ⚠️  Row lengths are inconsistent")
        
        return True
        
    except Exception as e:
        print(f"❌ Error during serialization: {e}")
        import traceback
        traceback.print_exc()
        return False


def list_games(json_path: str):
    """List all teams and games in the JSON file."""
    teams_data = load_team_data(json_path)
    
    print(f"Found {len(teams_data)} team(s):\n")
    
    for team_idx, team in enumerate(teams_data):
        print(f"Team {team_idx}: {team.get('name', 'Unknown')}")
        games = team.get('games', [])
        print(f"  Games: {len(games)}")
        
        for game_idx, game in enumerate(games):
            points = len(game.get('points', []))
            scores = game.get('scores', {})
            team_score = scores.get('team', 0)
            opp_score = scores.get('opponent', 0)
            opponent = game.get('opponent', 'Unknown')
            
            # Count events
            total_events = 0
            for point in game.get('points', []):
                for possession in point.get('possessions', []):
                    total_events += len(possession.get('events', []))
            
            print(f"    [{team_idx},{game_idx}] vs {opponent}: {team_score}-{opp_score} ({points} points, {total_events} events)")
        print()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 test_real_game.py <teamData.json> [team_index] [game_index]")
        print("\nExample:")
        print("  python3 test_real_game.py ../teamData.json")
        print("  python3 test_real_game.py ../teamData.json 0 0")
        print("\nTo list all games:")
        print("  python3 test_real_game.py ../teamData.json --list")
        sys.exit(1)
    
    json_path = sys.argv[1]
    
    if '--list' in sys.argv:
        list_games(json_path)
        sys.exit(0)
    
    team_index = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    game_index = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    
    success = test_real_game_serialization(json_path, team_index, game_index)
    sys.exit(0 if success else 1)

