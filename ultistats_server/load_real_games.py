"""
Script to load real game data from teamData.CUDOvSWW2.json into the running server.
"""
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

# Configuration
SERVER_URL = "http://localhost:8000"
SOURCE_FILE = Path.home() / "Downloads" / "teamData.CUDOvSWW2.json"

def load_games():
    if not SOURCE_FILE.exists():
        print(f"❌ Source file not found: {SOURCE_FILE}")
        return

    print(f"Reading games from {SOURCE_FILE}...")
    with open(SOURCE_FILE, 'r') as f:
        data = json.load(f)

    # Handle both list and single object formats
    teams = data if isinstance(data, list) else [data]
    
    total_loaded = 0
    
    for team in teams:
        team_name = team.get('name', 'Unknown Team')
        games = team.get('games', [])
        print(f"\nProcessing team: {team_name}")
        print(f"Found {len(games)} games")

        for i, game in enumerate(games):
            # Create a readable game ID
            # Format: YYYY-MM-DD_Team_vs_Opponent
            try:
                start_time = game.get('gameStartTimestamp', '')
                if start_time:
                    # Parse ISO string to get date part "2024-04-13"
                    # Handle "2024-04-13T14:00:00.000Z" format
                    date_str = start_time.split('T')[0]
                else:
                    date_str = "Unknown-Date"
                
                # Clean names for URL/Filename
                team_slug = game.get('team', 'Team').replace(' ', '-')
                opponent_slug = game.get('opponent', 'Opponent').replace(' ', '-')
                
                # Ensure ID is filesystem safe
                safe_chars = lambda s: "".join(c for c in s if c.isalnum() or c in ('-', '_'))
                game_id = f"{date_str}_{safe_chars(team_slug)}_vs_{safe_chars(opponent_slug)}"
                
                # Add a suffix if multiple games on same day/opponent (unlikely but good practice)
                game_id = f"{game_id}_{i}" 

                print(f"  Uploading Game {i+1}: {game.get('team')} vs {game.get('opponent')}")
                print(f"    -> ID: {game_id}")

                # Prepare request
                url = f"{SERVER_URL}/games/{game_id}/sync"
                headers = {'Content-Type': 'application/json'}
                json_data = json.dumps(game).encode('utf-8')
                
                req = urllib.request.Request(url, data=json_data, headers=headers, method='POST')
                
                with urllib.request.urlopen(req) as response:
                    result = json.loads(response.read().decode())
                    print(f"    ✅ Success! Version: {result.get('version')}")
                    total_loaded += 1

            except urllib.error.URLError as e:
                print(f"    ❌ Connection error: {e}")
                print("       Is the server running on port 8000?")
                return
            except Exception as e:
                print(f"    ❌ Error uploading game: {e}")

    print(f"\n🎉 Finished! Loaded {total_loaded} games.")
    print(f"View them at: {SERVER_URL}/docs")
    print(f"List all games: {SERVER_URL}/games")

if __name__ == "__main__":
    load_games()

