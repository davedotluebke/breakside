"""
Test REST API with real game data from teamData.json.

This script:
1. Loads real game data from teamData.json
2. Converts and serializes it to Google Sheets format
3. Creates a game via REST API
4. Syncs the full game data
5. Verifies the data was written correctly
"""

import requests
import json
import sys
from pathlib import Path
from typing import Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from test_real_game import load_team_data, convert_game_for_serialization, list_games
from sheets.serialization import serialize_game_to_sheet_rows

BASE_URL = "http://localhost:8000"
TOKEN: Optional[str] = None
TEAM_ID: Optional[str] = None
GAME_ID: Optional[str] = None


def print_step(step_num: int, description: str):
    """Print a test step header."""
    print(f"\n{'='*60}")
    print(f"Step {step_num}: {description}")
    print(f"{'='*60}")


def check_server():
    """Check if server is running."""
    try:
        response = requests.get(f"{BASE_URL}/", timeout=2)
        if response.status_code == 200:
            print("✅ Server is running")
            return True
    except requests.exceptions.ConnectionError:
        print("❌ Server is not running!")
        print("Start it with: DEBUG=True uvicorn ultistats_server.main:app --reload")
        return False
    return False


def login_or_register():
    """Login or register test user."""
    global TOKEN
    
    # Try to login first
    data = {
        "username": "testuser",
        "password": "testpass123"
    }
    response = requests.post(
        f"{BASE_URL}/auth/login",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    if response.status_code == 200:
        TOKEN = response.json().get('access_token')
        print("✅ Logged in with existing user")
        return True
    
    # If login fails, register
    print("⚠️  Login failed, trying to register...")
    data = {
        "username": "testuser",
        "password": "testpass123",
        "email": "test@example.com",
        "full_name": "Test User"
    }
    response = requests.post(f"{BASE_URL}/auth/register", json=data)
    if response.status_code == 200:
        print("✅ User registered")
        # Now login
        data = {
            "username": "testuser",
            "password": "testpass123"
        }
        response = requests.post(
            f"{BASE_URL}/auth/login",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        if response.status_code == 200:
            TOKEN = response.json().get('access_token')
            print("✅ Logged in after registration")
            return True
        else:
            print(f"❌ Login failed after registration: {response.status_code} - {response.text}")
            return False
    else:
        print(f"❌ Registration failed: {response.status_code} - {response.text}")
        return False


def get_headers():
    """Get request headers with auth token."""
    if not TOKEN:
        raise ValueError("No token available")
    return {"Authorization": f"Bearer {TOKEN}"}


def create_or_get_team(team_name: str):
    """Create a team or get existing one."""
    global TEAM_ID
    
    # Try to get existing teams
    response = requests.get(f"{BASE_URL}/teams", headers=get_headers())
    if response.status_code == 200:
        teams = response.json().get('teams', [])
        for team in teams:
            if team.get('team_name') == team_name:
                TEAM_ID = team.get('team_id')
                print(f"✅ Using existing team: {team_name} (ID: {TEAM_ID})")
                return True
    
    # Create new team
    data = {"team_name": team_name}
    response = requests.post(f"{BASE_URL}/teams", json=data, headers=get_headers())
    if response.status_code == 200:
        team = response.json()
        TEAM_ID = team.get('team_id')
        print(f"✅ Created team: {team_name} (ID: {TEAM_ID})")
        return True
    else:
        print(f"❌ Failed to create team: {response.text}")
        return False


def sync_players(team_data: dict):
    """Sync players from team data to the API."""
    print_step(0, "Syncing Players")
    roster = team_data.get('teamRoster', [])
    print(f"Found {len(roster)} players in roster")
    
    synced = 0
    for player in roster:
        player_data = {
            "name": player.get('name', ''),
            "nickname": player.get('nickname', ''),
            "gender": player.get('gender', ''),
            "number": str(player.get('number', ''))
        }
        
        response = requests.post(
            f"{BASE_URL}/teams/{TEAM_ID}/players",
            json=player_data,
            headers=get_headers()
        )
        if response.status_code == 200:
            synced += 1
        else:
            # Player might already exist, that's OK
            pass
    
    print(f"✅ Synced {synced} players")
    return True


def test_real_game(json_path: str, team_index: int = 0, game_index: int = 0):
    """Test REST API with a real game."""
    print("="*60)
    print("Testing REST API with Real Game Data")
    print("="*60)
    
    if not check_server():
        sys.exit(1)
    
    if not login_or_register():
        print("❌ Cannot continue without authentication")
        sys.exit(1)
    
    # Load team data
    print_step(1, "Loading Real Game Data")
    print(f"Loading from: {json_path}")
    teams_data = load_team_data(json_path)
    
    if not teams_data or team_index >= len(teams_data):
        print(f"❌ Invalid team index {team_index}")
        sys.exit(1)
    
    team_data = teams_data[team_index]
    team_name = team_data.get('name', 'Unknown Team')
    games = team_data.get('games', [])
    
    if not games or game_index >= len(games):
        print(f"❌ Invalid game index {game_index}")
        sys.exit(1)
    
    game = games[game_index]
    opponent = game.get('opponent', 'Unknown Opponent')
    
    print(f"📊 Team: {team_name}")
    print(f"🎮 Game: {team_name} vs {opponent}")
    print(f"   Points: {len(game.get('points', []))}")
    print(f"   Score: {game.get('scores', {}).get('team', 0)}-{game.get('scores', {}).get('opponent', 0)}")
    
    # Count events
    total_events = 0
    for point in game.get('points', []):
        for possession in point.get('possessions', []):
            total_events += len(possession.get('events', []))
    print(f"   Total events: {total_events}")
    
    # Create or get team
    print_step(2, "Create/Get Team")
    if not create_or_get_team(team_name):
        sys.exit(1)
    
    # Sync players
    sync_players(team_data)
    
    # Convert and serialize game
    print_step(3, "Convert and Serialize Game")
    print("Converting game format...")
    converted_game = convert_game_for_serialization(game)
    
    print("Serializing to Google Sheets format...")
    rows = serialize_game_to_sheet_rows(converted_game)
    print(f"✅ Serialized to {len(rows)} rows")
    print(f"   Header rows: 3")
    print(f"   Data rows: {len(rows) - 3}")
    
    # Create game via API
    print_step(4, "Create Game via REST API")
    game_data = {
        "team_id": TEAM_ID,
        "team_name": team_name,
        "opponent_name": opponent,
        "starting_position": game.get('startingPosition', 'offense')
    }
    
    headers = get_headers()
    print(f"Debug: Using token {TOKEN[:20] if TOKEN else 'None'}...")
    response = requests.post(
        f"{BASE_URL}/games",
        json=game_data,
        headers=headers
    )
    
    if response.status_code != 200:
        print(f"❌ Failed to create game: {response.text}")
        sys.exit(1)
    
    game_response = response.json()
    GAME_ID = game_response.get('game_id')
    sheet_name = game_response.get('sheet_name')
    print(f"✅ Game created: {GAME_ID}")
    print(f"   Sheet: {sheet_name}")
    
    # Sync full game data
    print_step(5, "Sync Full Game Data")
    print(f"Syncing {len(rows)} rows to game sheet...")
    
    sync_data = {"rows": rows}
    response = requests.post(
        f"{BASE_URL}/games/{GAME_ID}/sync",
        json=sync_data,
        headers=get_headers()
    )
    
    if response.status_code != 200:
        print(f"❌ Failed to sync game data: {response.text}")
        sys.exit(1)
    
    sync_result = response.json()
    rows_written = sync_result.get('rows_written', 0)
    print(f"✅ Full sync completed: {rows_written} rows written")
    
    # Verify data
    print_step(6, "Verify Synced Data")
    response = requests.get(
        f"{BASE_URL}/games/{GAME_ID}/data",
        headers=get_headers()
    )
    
    if response.status_code == 200:
        data = response.json()
        retrieved_rows = data.get('rows', [])
        print(f"✅ Retrieved {len(retrieved_rows)} rows from API")
        
        if len(retrieved_rows) == len(rows):
            print("✅ Row count matches!")
        else:
            print(f"⚠️  Row count mismatch: expected {len(rows)}, got {len(retrieved_rows)}")
        
        # Show first few rows
        print(f"\n📄 First 3 rows preview:")
        for i, row in enumerate(retrieved_rows[:3]):
            non_empty = [str(val) for val in row if val]
            print(f"   Row {i+1}: {len(row)} columns, {len(non_empty)} non-empty")
            if non_empty:
                print(f"      {', '.join(non_empty[:5])}...")
    else:
        print(f"⚠️  Could not verify data: {response.text}")
    
    # End game if it has end timestamp
    if game.get('gameEndTimestamp'):
        print_step(7, "End Game")
        end_data = {
            "game_end_timestamp": game.get('gameEndTimestamp'),
            "final_score_team": game.get('scores', {}).get('team', 0),
            "final_score_opponent": game.get('scores', {}).get('opponent', 0)
        }
        
        response = requests.post(
            f"{BASE_URL}/games/{GAME_ID}/end",
            json=end_data,
            headers=get_headers()
        )
        
        if response.status_code == 200:
            print("✅ Game ended successfully")
        else:
            print(f"⚠️  Could not end game: {response.text}")
    
    print("\n" + "="*60)
    print("✅ Real Game Test Completed!")
    print("="*60)
    print(f"\nTest Summary:")
    print(f"  Team: {team_name}")
    print(f"  Game: vs {opponent}")
    print(f"  Game ID: {GAME_ID}")
    print(f"  Sheet: {sheet_name}")
    print(f"  Rows synced: {rows_written}")
    print(f"\nCheck Google Sheets to verify:")
    print(f"  https://docs.google.com/spreadsheets/d/1I_mlDRKCEr2djnrm-URaSgIk4yZ_D2NwygMr8TaJ9kw")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 test_real_game_api.py <teamData.json> [team_index] [game_index]")
        print("\nExample:")
        print("  python3 test_real_game_api.py ~/Downloads/teamData.json")
        print("  python3 test_real_game_api.py ~/Downloads/teamData.json 0 0")
        print("\nTo list all games:")
        print("  python3 test_real_game_api.py ~/Downloads/teamData.json --list")
        sys.exit(1)
    
    json_path = sys.argv[1]
    
    if '--list' in sys.argv:
        list_games(json_path)
        sys.exit(0)
    
    team_index = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    game_index = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    
    test_real_game(json_path, team_index, game_index)

