"""
Simple API testing script for Ultistats REST API.

This script tests all endpoints step by step.
Run with: python3 test_api_simple.py
"""

import requests
import json
import sys
from typing import Optional

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


def test_register():
    """Test user registration."""
    print_step(1, "Register User")
    data = {
        "username": "testuser",
        "password": "testpass123",
        "email": "test@example.com",
        "full_name": "Test User"
    }
    response = requests.post(f"{BASE_URL}/auth/register", json=data)
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        print("✅ User registered")
        print(json.dumps(response.json(), indent=2))
    else:
        print(f"⚠️  Registration response: {response.text}")
        if "already registered" in response.text.lower():
            print("(User already exists - this is OK)")


def test_login():
    """Test login and get token."""
    global TOKEN
    print_step(2, "Login and Get Token")
    data = {
        "username": "testuser",
        "password": "testpass123"
    }
    response = requests.post(
        f"{BASE_URL}/auth/login",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        token_data = response.json()
        TOKEN = token_data.get('access_token')
        print(f"✅ Token received: {TOKEN[:20]}...")
        return True
    else:
        print(f"❌ Login failed: {response.text}")
        return False


def get_headers():
    """Get request headers with auth token."""
    if not TOKEN:
        raise ValueError("No token available")
    return {"Authorization": f"Bearer {TOKEN}"}


def test_create_team():
    """Test team creation."""
    global TEAM_ID
    print_step(3, "Create Team")
    data = {"team_name": "Test Team"}
    response = requests.post(
        f"{BASE_URL}/teams",
        json=data,
        headers=get_headers()
    )
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        team = response.json()
        TEAM_ID = team.get('team_id')
        print(f"✅ Team created: {team.get('team_name')} (ID: {TEAM_ID})")
        print(json.dumps(team, indent=2))
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def test_list_teams():
    """Test listing teams."""
    print_step(4, "List All Teams")
    response = requests.get(f"{BASE_URL}/teams", headers=get_headers())
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        teams = data.get('teams', [])
        print(f"✅ Found {len(teams)} team(s)")
        for team in teams:
            print(f"  - {team.get('team_name')} (ID: {team.get('team_id')})")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def test_add_players():
    """Test adding players."""
    print_step(5, "Add Players to Team")
    players = [
        {"name": "Alice", "nickname": "Ali", "gender": "FMP", "number": "1"},
        {"name": "Bob", "gender": "MMP", "number": "2"},
        {"name": "Charlie", "gender": "MMP", "number": "3"}
    ]
    
    for player in players:
        response = requests.post(
            f"{BASE_URL}/teams/{TEAM_ID}/players",
            json=player,
            headers=get_headers()
        )
        print(f"Status: {response.status_code} - {player['name']}")
        if response.status_code == 200:
            print(f"  ✅ Added {player['name']}")
        else:
            print(f"  ❌ Failed: {response.text}")


def test_get_players():
    """Test getting team roster."""
    print_step(6, "Get Team Roster")
    response = requests.get(
        f"{BASE_URL}/teams/{TEAM_ID}/players",
        headers=get_headers()
    )
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        players = data.get('players', [])
        print(f"✅ Found {len(players)} player(s)")
        for player in players:
            print(f"  - {player.get('name')} ({player.get('gender')})")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def test_create_game():
    """Test game creation."""
    global GAME_ID
    print_step(7, "Create Game")
    data = {
        "team_id": TEAM_ID,
        "team_name": "Test Team",
        "opponent_name": "Opponent Team",
        "starting_position": "offense"
    }
    response = requests.post(
        f"{BASE_URL}/games",
        json=data,
        headers=get_headers()
    )
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        game = response.json()
        GAME_ID = game.get('game_id')
        print(f"✅ Game created: {game.get('team_name')} vs {game.get('opponent_name')}")
        print(f"   Game ID: {GAME_ID}")
        print(f"   Sheet: {game.get('sheet_name')}")
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def test_add_event():
    """Test adding a single event."""
    print_step(8, "Add Single Event")
    # Event row: 26 columns matching schema
    event_row = [
        "1",                    # Point #
        "",                     # Point Start Time (empty for event row)
        "",                     # Starting Position
        "",                     # Active Players
        "",                     # Point End Time
        "",                     # Point Duration
        "",                     # Point Winner
        "",                     # Score After Point
        "",                     # Pull
        "Alice",                # Thrower
        "Bob",                  # Receiver
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
        print("✅ Event added")
        print(json.dumps(response.json(), indent=2))
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def test_batch_events():
    """Test batch event addition."""
    print_step(9, "Add Batch Events")
    event_rows = [
        [
            "1", "", "", "", "", "", "", "", "",
            "Bob", "Charlie", "break", "", "", "", "", "", "", "", "", "", "", "", "",
            "1", "offensive"
        ],
        [
            "1", "", "", "", "", "", "", "", "",
            "", "", "", "Dave", "interception", "", "", "", "", "", "", "", "", "", "", "",
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
        print(f"✅ Batch events added: {result.get('rows_appended')} rows")
        print(json.dumps(result, indent=2))
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def test_get_game_data():
    """Test getting game data."""
    print_step(10, "Get Game Data")
    response = requests.get(
        f"{BASE_URL}/games/{GAME_ID}/data",
        headers=get_headers()
    )
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        rows = data.get('rows', [])
        print(f"✅ Retrieved {len(rows)} rows")
        print(f"   First few rows:")
        for i, row in enumerate(rows[:5]):
            print(f"   Row {i+1}: {len(row)} columns")
            # Show non-empty columns
            non_empty = [str(val) for val in row if val]
            if non_empty:
                print(f"      {', '.join(non_empty[:5])}...")
        return rows
    else:
        print(f"❌ Failed: {response.text}")
        return None


def test_full_sync():
    """Test full game sync."""
    print_step(11, "Full Game Sync")
    # Get current data first
    response = requests.get(
        f"{BASE_URL}/games/{GAME_ID}/data",
        headers=get_headers()
    )
    if response.status_code != 200:
        print("❌ Cannot get current game data for sync")
        return False
    
    current_data = response.json()
    rows = current_data.get('rows', [])
    
    # Add a test row
    test_row = [
        "1", "", "", "", "", "", "", "", "",
        "Test", "Sync", "test", "", "", "", "", "", "", "", "", "", "", "", "",
        "1", "offensive"
    ]
    rows.append(test_row)
    
    data = {"rows": rows}
    response = requests.post(
        f"{BASE_URL}/games/{GAME_ID}/sync",
        json=data,
        headers=get_headers()
    )
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        result = response.json()
        print(f"✅ Full sync completed: {result.get('rows_written')} rows written")
        print(json.dumps(result, indent=2))
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def test_end_game():
    """Test ending a game."""
    print_step(12, "End Game")
    data = {
        "game_end_timestamp": "2024-01-15T12:00:00",
        "final_score_team": 15,
        "final_score_opponent": 10
    }
    response = requests.post(
        f"{BASE_URL}/games/{GAME_ID}/end",
        json=data,
        headers=get_headers()
    )
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        game = response.json()
        print("✅ Game ended")
        print(f"   Final score: {game.get('final_score_team')}-{game.get('final_score_opponent')}")
        print(json.dumps(game, indent=2))
        return True
    else:
        print(f"❌ Failed: {response.text}")
        return False


def main():
    """Run all tests."""
    print("="*60)
    print("Ultistats REST API Testing")
    print("="*60)
    
    if not check_server():
        sys.exit(1)
    
    try:
        test_register()
        if not test_login():
            print("\n❌ Cannot continue without authentication token")
            sys.exit(1)
        
        if not test_create_team():
            print("\n❌ Cannot continue without team")
            sys.exit(1)
        
        test_list_teams()
        test_add_players()
        test_get_players()
        
        if not test_create_game():
            print("\n❌ Cannot continue without game")
            sys.exit(1)
        
        test_add_event()
        test_batch_events()
        test_get_game_data()
        test_full_sync()
        test_end_game()
        
        print("\n" + "="*60)
        print("✅ All tests completed!")
        print("="*60)
        print(f"\nTest Summary:")
        print(f"  Team ID: {TEAM_ID}")
        print(f"  Game ID: {GAME_ID}")
        print(f"\nCheck Google Sheets to verify data was written:")
        print(f"  https://docs.google.com/spreadsheets/d/1I_mlDRKCEr2djnrm-URaSgIk4yZ_D2NwygMr8TaJ9kw")
        
    except KeyboardInterrupt:
        print("\n\n⚠️  Tests interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Error during testing: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

