"""
Step-by-step REST API test with real game data.
Each step can be verified manually in Google Sheets.
"""

import requests
import json
import sys
import time
from pathlib import Path
from typing import Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from test_real_game import load_team_data, convert_game_for_serialization
from sheets.serialization import serialize_game_to_sheet_rows

BASE_URL = "http://localhost:8000"
TOKEN: Optional[str] = None
TEAM_ID: Optional[str] = None
GAME_ID: Optional[str] = None

# Use timestamp-based username to avoid conflicts
TEST_USERNAME = f"testuser_{int(time.time())}"


def print_step(step_num: int, description: str):
    """Print a test step header."""
    print(f"\n{'='*70}")
    print(f"STEP {step_num}: {description}")
    print(f"{'='*70}")


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


def step1_register_and_login():
    """Step 1: Register a new user and login."""
    global TOKEN
    print_step(1, "Register User and Login")
    
    # Try login first (user might already exist)
    print("Attempting login first...")
    login_data = {
        "username": TEST_USERNAME,
        "password": "testpass123"
    }
    response = requests.post(
        f"{BASE_URL}/auth/login",
        data=login_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    if response.status_code == 200:
        TOKEN = response.json().get('access_token')
        print(f"  ✅ Login successful (user already exists)")
        print(f"  Token: {TOKEN[:30]}...")
        return True
    
    # If login fails, register
    print("Login failed, registering new user...")
    register_data = {
        "username": TEST_USERNAME,
        "password": "testpass123",
        "email": "test@example.com",
        "full_name": "Test User"
    }
    response = requests.post(f"{BASE_URL}/auth/register", json=register_data)
    print(f"  Register status: {response.status_code}")
    print(f"  Response: {response.text[:200]}")
    if response.status_code == 200:
        print(f"  ✅ User registered: {response.json().get('username')}")
        # Longer delay to ensure user is written to Google Sheets
        print("  Waiting for user to be written to sheet...")
        time.sleep(2)
    elif response.status_code == 400 and "already registered" in response.text.lower():
        print(f"  ⚠️  User already exists, trying login again...")
        # User exists, try login one more time
        response = requests.post(
            f"{BASE_URL}/auth/login",
            data=login_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        if response.status_code == 200:
            TOKEN = response.json().get('access_token')
            print(f"  ✅ Login successful after registration check")
            print(f"  Token: {TOKEN[:30]}...")
            return True
    else:
        print(f"  ❌ Registration failed: {response.status_code} - {response.text}")
        return False
    
    # Login after registration - retry a few times with delays
    print("\nLogging in after registration...")
    for attempt in range(3):
        response = requests.post(
            f"{BASE_URL}/auth/login",
            data=login_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        print(f"  Login attempt {attempt + 1} status: {response.status_code}")
        if response.status_code == 200:
            TOKEN = response.json().get('access_token')
            print(f"  ✅ Login successful")
            print(f"  Token: {TOKEN[:30]}...")
            return True
        elif attempt < 2:
            print(f"  ⚠️  Login failed, waiting and retrying...")
            time.sleep(1)
    
    print(f"  ❌ Login failed after 3 attempts: {response.text}")
    return False


def get_headers():
    """Get request headers with auth token."""
    global TOKEN
    if not TOKEN:
        # Try to login again
        print("⚠️  Token missing, re-authenticating...")
        login_data = {
            "username": TEST_USERNAME,
            "password": "testpass123"
        }
        response = requests.post(
            f"{BASE_URL}/auth/login",
            data=login_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        if response.status_code == 200:
            TOKEN = response.json().get('access_token')
            print("✅ Re-authenticated")
        else:
            raise ValueError(f"Could not authenticate: {response.text}")
    return {"Authorization": f"Bearer {TOKEN}"}


def step2_create_team(team_name: str):
    """Step 2: Create a team."""
    global TEAM_ID
    print_step(2, f"Create Team: {team_name}")
    
    team_data = {"team_name": team_name}
    response = requests.post(
        f"{BASE_URL}/teams",
        json=team_data,
        headers=get_headers()
    )
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        team = response.json()
        TEAM_ID = team.get('team_id')
        print(f"✅ Team created:")
        print(f"   Team ID: {TEAM_ID}")
        print(f"   Team Name: {team.get('team_name')}")
        print(f"\n📋 Verify in Google Sheets:")
        print(f"   Check 'Teams' sheet - should see team '{team_name}'")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def step3_add_players(team_data: dict):
    """Step 3: Add players to the team."""
    print_step(3, "Add Players to Team")
    
    roster = team_data.get('teamRoster', [])
    print(f"Found {len(roster)} players in roster")
    
    added = []
    headers = get_headers()
    print(f"Debug: Using token {TOKEN[:30] if TOKEN else 'None'}...")
    
    for i, player in enumerate(roster[:5], 1):  # Add first 5 players for testing
        player_data = {
            "name": player.get('name', ''),
            "nickname": player.get('nickname', ''),
            "gender": player.get('gender', ''),
            "number": str(player.get('number', ''))
        }
        
        # Refresh headers each time to ensure token is current
        headers = get_headers()
        response = requests.post(
            f"{BASE_URL}/teams/{TEAM_ID}/players",
            json=player_data,
            headers=headers
        )
        
        if response.status_code == 200:
            added.append(player.get('name', 'Unknown'))
            print(f"  ✅ Added player {i}: {player.get('name')} ({player.get('gender')})")
        else:
            print(f"  ⚠️  Player {i} ({player.get('name')}): {response.status_code} - {response.text[:100]}")
            # If auth fails, try to refresh token
            if response.status_code == 401:
                print(f"  ⚠️  Auth failed, refreshing token...")
                time.sleep(0.5)
                headers = get_headers()  # This will re-authenticate if needed
    
    print(f"\n✅ Added {len(added)} players")
    print(f"\n📋 Verify in Google Sheets:")
    print(f"   Check 'Players' sheet - should see {len(added)} players for team {TEAM_ID}")
    
    return True


def step4_create_game(team_name: str, game: dict):
    """Step 4: Create a game."""
    global GAME_ID, TOKEN
    print_step(4, "Create Game")
    
    opponent = game.get('opponent', 'Unknown Opponent')
    print(f"Game: {team_name} vs {opponent}")
    
    game_data = {
        "team_id": TEAM_ID,
        "team_name": team_name,
        "opponent_name": opponent,
        "starting_position": game.get('startingPosition', 'offense')
    }
    
    # Refresh token before game creation to ensure it's valid
    print("Refreshing token before game creation...")
    login_data = {
        "username": TEST_USERNAME,
        "password": "testpass123"
    }
    response = requests.post(
        f"{BASE_URL}/auth/login",
        data=login_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    if response.status_code == 200:
        TOKEN = response.json().get('access_token')
        print(f"✅ Token refreshed: {TOKEN[:30]}...")
    else:
        print(f"⚠️  Token refresh failed: {response.status_code}")
    
    headers = get_headers()
    print(f"Debug: Using token {TOKEN[:30] if TOKEN else 'None'}...")
    
    # Add small delay before game creation
    time.sleep(0.5)
    
    response = requests.post(
        f"{BASE_URL}/games",
        json=game_data,
        headers=headers
    )
    
    print(f"Status: {response.status_code}")
    if response.status_code == 401:
        # Try refreshing token and retry one more time
        print("⚠️  Auth failed, refreshing token and retrying...")
        time.sleep(1)
        response = requests.post(
            f"{BASE_URL}/auth/login",
            data=login_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        if response.status_code == 200:
            TOKEN = response.json().get('access_token')
            headers = {"Authorization": f"Bearer {TOKEN}"}
            response = requests.post(
                f"{BASE_URL}/games",
                json=game_data,
                headers=headers
            )
            print(f"Retry status: {response.status_code}")
    
    if response.status_code == 200:
        game_response = response.json()
        GAME_ID = game_response.get('game_id')
        sheet_name = game_response.get('sheet_name')
        print(f"✅ Game created:")
        print(f"   Game ID: {GAME_ID}")
        print(f"   Sheet Name: {sheet_name}")
        print(f"\n📋 Verify in Google Sheets:")
        print(f"   1. Check 'Games' sheet - should see game entry")
        print(f"   2. Check for new sheet tab: '{sheet_name}'")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def step5_add_single_event():
    """Step 5: Add a single event."""
    print_step(5, "Add Single Event")
    
    # Create a simple test event
    event_row = [
        "1",                    # Point #
        "",                     # Point Start Time
        "",                     # Starting Position
        "",                     # Active Players
        "",                     # Point End Time
        "",                     # Point Duration
        "",                     # Point Winner
        "",                     # Score After Point
        "",                     # Pull
        "Test Player",          # Thrower
        "Test Receiver",        # Receiver
        "huck",                 # Throw Modifiers
        "",                     # Defender
        "",                     # Defense Modifiers
        "",                     # Turnover Type
        "",                     # Turnover Player
        "",                     # Turnover Modifiers
        "",                     # Violation Type
        "",                     # Violation Player
        "",                     # Timeout
        "",                     # Injury Sub
        "",                     # Time Cap
        "",                     # Side Switch
        "",                     # Halftime
        "1",                    # Possession #
        "offensive"             # Possession Type
    ]
    
    data = {"row": event_row}
    response = requests.post(
        f"{BASE_URL}/games/{GAME_ID}/events",
        json=data,
        headers=get_headers()
    )
    
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        print(f"✅ Single event added")
        print(f"\n📋 Verify in Google Sheets:")
        print(f"   Check game sheet '{GAME_ID}' - should see event row added")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def step6_add_batch_events():
    """Step 6: Add batch events."""
    print_step(6, "Add Batch Events")
    
    event_rows = [
        [
            "1", "", "", "", "", "", "", "", "",
            "Player A", "Player B", "break", "", "", "", "", "", "", "", "", "", "", "", "",
            "1", "offensive"
        ],
        [
            "1", "", "", "", "", "", "", "", "",
            "", "", "", "Player C", "interception", "", "", "", "", "", "", "", "", "", "", "",
            "1", "defensive"
        ]
    ]
    
    data = {"rows": event_rows}
    response = requests.post(
        f"{BASE_URL}/games/{GAME_ID}/events/batch",
        json=data,
        headers=get_headers()
    )
    
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        result = response.json()
        rows_appended = result.get('rows_appended', 0)
        print(f"✅ Batch events added: {rows_appended} rows")
        print(f"\n📋 Verify in Google Sheets:")
        print(f"   Check game sheet - should see {rows_appended} more event rows")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def step7_get_game_data():
    """Step 7: Get game data."""
    print_step(7, "Get Game Data")
    
    response = requests.get(
        f"{BASE_URL}/games/{GAME_ID}/data",
        headers=get_headers()
    )
    
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        rows = data.get('rows', [])
        print(f"✅ Retrieved {len(rows)} rows")
        print(f"\n📋 Current game data:")
        print(f"   Total rows: {len(rows)}")
        if rows:
            print(f"   First row: {rows[0][:5]}...")
            print(f"   Last row: {rows[-1][:5]}...")
        return rows
    else:
        print(f"❌ Failed: {response.text}")
        return None


def step8_full_sync(game_rows: list):
    """Step 8: Full game sync with real data."""
    print_step(8, "Full Game Sync (Real Game Data)")
    
    print(f"Syncing {len(game_rows)} rows...")
    
    sync_data = {"rows": game_rows}
    response = requests.post(
        f"{BASE_URL}/games/{GAME_ID}/sync",
        json=sync_data,
        headers=get_headers()
    )
    
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        result = response.json()
        rows_written = result.get('rows_written', 0)
        print(f"✅ Full sync completed: {rows_written} rows written")
        print(f"\n📋 Verify in Google Sheets:")
        print(f"   Check game sheet - should have {rows_written} total rows")
        print(f"   Should include headers and all game data")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def step9_end_game(game: dict):
    """Step 9: End the game."""
    print_step(9, "End Game")
    
    scores = game.get('scores', {})
    end_data = {
        "game_end_timestamp": game.get('gameEndTimestamp', ''),
        "final_score_team": scores.get('team', 0),
        "final_score_opponent": scores.get('opponent', 0)
    }
    
    response = requests.post(
        f"{BASE_URL}/games/{GAME_ID}/end",
        json=end_data,
        headers=get_headers()
    )
    
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        game_response = response.json()
        print(f"✅ Game ended")
        print(f"   Final Score: {game_response.get('final_score_team')}-{game_response.get('final_score_opponent')}")
        print(f"\n📋 Verify in Google Sheets:")
        print(f"   Check 'Games' sheet - final scores should be updated")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def main():
    """Run step-by-step test."""
    if len(sys.argv) < 4:
        print("Usage: python3 test_step_by_step.py <teamData.json> <team_index> <game_index>")
        print("\nExample:")
        print("  python3 test_step_by_step.py ~/Downloads/teamData.TeamDvTeamE.json 0 3")
        sys.exit(1)
    
    json_path = sys.argv[1]
    team_index = int(sys.argv[2])
    game_index = int(sys.argv[3])
    
    print("="*70)
    print("STEP-BY-STEP REST API TEST WITH REAL GAME DATA")
    print("="*70)
    print(f"\nFile: {json_path}")
    print(f"Team Index: {team_index}")
    print(f"Game Index: {game_index}")
    
    if not check_server():
        sys.exit(1)
    
    # Load game data
    print("\nLoading game data...")
    teams_data = load_team_data(json_path)
    if not teams_data or team_index >= len(teams_data):
        print(f"❌ Invalid team index")
        sys.exit(1)
    
    team_data = teams_data[team_index]
    team_name = team_data.get('name', 'Unknown Team')
    games = team_data.get('games', [])
    
    if not games or game_index >= len(games):
        print(f"❌ Invalid game index")
        sys.exit(1)
    
    game = games[game_index]
    opponent = game.get('opponent', 'Unknown')
    points = len(game.get('points', []))
    scores = game.get('scores', {})
    
    print(f"\n📊 Game Details:")
    print(f"   Team: {team_name}")
    print(f"   Opponent: {opponent}")
    print(f"   Points: {points}")
    print(f"   Score: {scores.get('team', 0)}-{scores.get('opponent', 0)}")
    
    # Run steps
    if not step1_register_and_login():
        sys.exit(1)
    
    if not step2_create_team(team_name):
        sys.exit(1)
    
    if not step3_add_players(team_data):
        sys.exit(1)
    
    if not step4_create_game(team_name, game):
        sys.exit(1)
    
    if not step5_add_single_event():
        sys.exit(1)
    
    if not step6_add_batch_events():
        sys.exit(1)
    
    current_rows = step7_get_game_data()
    
    # Convert and serialize real game data
    print("\n" + "="*70)
    print("Preparing real game data for sync...")
    print("="*70)
    converted_game = convert_game_for_serialization(game)
    serialized_rows = serialize_game_to_sheet_rows(converted_game)
    print(f"✅ Serialized real game to {len(serialized_rows)} rows")
    
    if not step8_full_sync(serialized_rows):
        sys.exit(1)
    
    if game.get('gameEndTimestamp'):
        if not step9_end_game(game):
            sys.exit(1)
    
    print("\n" + "="*70)
    print("✅ ALL STEPS COMPLETED!")
    print("="*70)
    print(f"\nSummary:")
    print(f"  Team ID: {TEAM_ID}")
    print(f"  Game ID: {GAME_ID}")
    print(f"\n📋 Manual Verification:")
    print(f"  Check Google Sheets:")
    print(f"    https://docs.google.com/spreadsheets/d/1I_mlDRKCEr2djnrm-URaSgIk4yZ_D2NwygMr8TaJ9kw")
    print(f"\n  Verify:")
    print(f"    1. 'Teams' sheet has team '{team_name}'")
    print(f"    2. 'Players' sheet has players for team")
    print(f"    3. 'Games' sheet has game entry")
    print(f"    4. Game sheet tab exists with all data")


if __name__ == "__main__":
    main()

