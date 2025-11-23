"""
Test serialization on all games in a teamData.json file.

This script loads a teamData.json file and tests serialization
of every game, reporting any errors or issues.
"""

import json
import sys
from pathlib import Path
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from sheets.serialization import serialize_game_to_sheet_rows, get_column_headers
from test_real_game import load_team_data, convert_game_for_serialization


def test_all_games(json_path: str):
    """
    Test serialization for all games in the JSON file.
    
    Args:
        json_path: Path to teamData.json file
    
    Returns:
        Tuple of (success_count, total_count, errors)
    """
    print(f"Loading team data from: {json_path}\n")
    teams_data = load_team_data(json_path)
    
    if not teams_data:
        print("❌ No teams found in JSON file")
        return (0, 0, [])
    
    all_errors = []
    total_games = 0
    success_count = 0
    
    for team_idx, team in enumerate(teams_data):
        team_name = team.get('name', f'Team {team_idx}')
        games = team.get('games', [])
        
        print(f"{'='*60}")
        print(f"Team {team_idx + 1}: {team_name}")
        print(f"{'='*60}")
        print(f"  Players: {len(team.get('teamRoster', []))}")
        print(f"  Games: {len(games)}\n")
        
        for game_idx, game in enumerate(games):
            total_games += 1
            game_name = f"{game.get('team', '')} vs {game.get('opponent', '')}"
            points_count = len(game.get('points', []))
            scores = game.get('scores', {})
            team_score = scores.get('team', 0)
            opp_score = scores.get('opponent', 0)
            
            # Count events
            total_events = 0
            for point in game.get('points', []):
                for possession in point.get('possessions', []):
                    total_events += len(possession.get('events', []))
            
            print(f"  Game {game_idx + 1}: {game_name}")
            print(f"    Points: {points_count}, Score: {team_score}-{opp_score}, Events: {total_events}")
            
            try:
                # Convert game to format expected by serialization
                converted_game = convert_game_for_serialization(game)
                
                # Serialize to sheet rows
                rows = serialize_game_to_sheet_rows(converted_game)
                
                # Validate
                if len(rows) < 3:
                    raise ValueError(f"Not enough rows: {len(rows)} (need at least 3 for headers)")
                
                # Check header row
                headers = get_column_headers()
                if rows[1] != headers:
                    raise ValueError("Header row doesn't match expected headers")
                
                # Check row lengths
                expected_length = len(headers)
                inconsistent_rows = []
                for i, row in enumerate(rows):
                    if len(row) != expected_length:
                        inconsistent_rows.append((i, len(row), expected_length))
                
                if inconsistent_rows:
                    raise ValueError(f"Row length inconsistencies: {inconsistent_rows}")
                
                # Check for data rows
                data_rows = len(rows) - 3
                if data_rows == 0:
                    print(f"    ⚠️  Warning: No data rows (only headers)")
                
                # Success!
                print(f"    ✅ Success: {len(rows)} rows ({data_rows} data rows)")
                success_count += 1
                
            except Exception as e:
                error_msg = f"Team {team_idx}, Game {game_idx}: {str(e)}"
                print(f"    ❌ Error: {error_msg}")
                all_errors.append({
                    'team_idx': team_idx,
                    'team_name': team_name,
                    'game_idx': game_idx,
                    'game_name': game_name,
                    'error': str(e),
                    'traceback': None
                })
                import traceback
                all_errors[-1]['traceback'] = traceback.format_exc()
            
            print()
    
    return (success_count, total_games, all_errors)


def print_summary(success_count, total_games, errors):
    """Print summary of test results."""
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"Total games tested: {total_games}")
    print(f"Successful: {success_count}")
    print(f"Failed: {len(errors)}")
    print(f"Success rate: {success_count/total_games*100:.1f}%" if total_games > 0 else "N/A")
    
    if errors:
        print(f"\n{'='*60}")
        print("ERRORS")
        print(f"{'='*60}")
        for i, error in enumerate(errors, 1):
            print(f"\nError {i}:")
            print(f"  Team: {error['team_name']} (index {error['team_idx']})")
            print(f"  Game: {error['game_name']} (index {error['game_idx']})")
            print(f"  Error: {error['error']}")
            if error['traceback']:
                print(f"  Traceback:\n{error['traceback']}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 test_all_games.py <teamData.json>")
        print("\nExample:")
        print("  python3 test_all_games.py ~/Downloads/teamData.TeamDvTeamE.json")
        sys.exit(1)
    
    json_path = sys.argv[1]
    
    success_count, total_games, errors = test_all_games(json_path)
    print_summary(success_count, total_games, errors)
    
    # Exit with error code if any failures
    sys.exit(1 if errors else 0)

