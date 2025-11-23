"""
Test script for API endpoints.

This script tests the REST API endpoints using the requests library.
Run the server first: uvicorn ultistats_server.main:app --reload
"""

import requests
import json
import sys

BASE_URL = "http://localhost:8000"

def test_root():
    """Test root endpoint."""
    print("Testing GET /...")
    response = requests.get(f"{BASE_URL}/")
    print(f"  Status: {response.status_code}")
    print(f"  Response: {response.json()}")
    assert response.status_code == 200
    print("  ✅ Root endpoint works\n")

def test_auth_register():
    """Test user registration."""
    print("Testing POST /auth/register...")
    user_data = {
        "username": "testuser",
        "password": "testpass123",
        "email": "test@example.com",
        "full_name": "Test User"
    }
    response = requests.post(f"{BASE_URL}/auth/register", json=user_data)
    print(f"  Status: {response.status_code}")
    if response.status_code == 200:
        print(f"  Response: {response.json()}")
        print("  ✅ Registration works")
    else:
        print(f"  Response: {response.text}")
        print("  ⚠️  Registration failed (might be expected if user exists)")
    print()

def test_auth_login():
    """Test user login."""
    print("Testing POST /auth/login...")
    login_data = {
        "username": "testuser",
        "password": "testpass123"
    }
    response = requests.post(
        f"{BASE_URL}/auth/login",
        data=login_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    print(f"  Status: {response.status_code}")
    if response.status_code == 200:
        token_data = response.json()
        print(f"  Token received: {token_data.get('access_token', '')[:20]}...")
        print("  ✅ Login works")
        return token_data.get('access_token')
    else:
        print(f"  Response: {response.text}")
        print("  ⚠️  Login failed")
        return None
    print()

def test_teams_endpoint(token: str):
    """Test teams endpoints."""
    headers = {"Authorization": f"Bearer {token}"}
    
    print("Testing GET /teams...")
    response = requests.get(f"{BASE_URL}/teams", headers=headers)
    print(f"  Status: {response.status_code}")
    if response.status_code == 200:
        teams = response.json()
        print(f"  Found {len(teams.get('teams', []))} teams")
        print("  ✅ Get teams works")
    else:
        print(f"  Response: {response.text}")
    print()
    
    print("Testing POST /teams...")
    team_data = {
        "team_name": "Test Team"
    }
    response = requests.post(f"{BASE_URL}/teams", json=team_data, headers=headers)
    print(f"  Status: {response.status_code}")
    if response.status_code == 200:
        team = response.json()
        print(f"  Created team: {team.get('team_name')} (ID: {team.get('team_id')})")
        print("  ✅ Create team works")
        return team.get('team_id')
    else:
        print(f"  Response: {response.text}")
        return None
    print()

def test_players_endpoint(token: str, team_id: str):
    """Test players endpoints."""
    headers = {"Authorization": f"Bearer {token}"}
    
    print(f"Testing GET /teams/{team_id}/players...")
    response = requests.get(f"{BASE_URL}/teams/{team_id}/players", headers=headers)
    print(f"  Status: {response.status_code}")
    if response.status_code == 200:
        players = response.json()
        print(f"  Found {len(players.get('players', []))} players")
        print("  ✅ Get players works")
    else:
        print(f"  Response: {response.text}")
    print()
    
    print(f"Testing POST /teams/{team_id}/players...")
    player_data = {
        "name": "Test Player",
        "nickname": "TP",
        "gender": "MMP",
        "number": "42"
    }
    response = requests.post(f"{BASE_URL}/teams/{team_id}/players", json=player_data, headers=headers)
    print(f"  Status: {response.status_code}")
    if response.status_code == 200:
        player = response.json()
        print(f"  Created player: {player.get('name')} (ID: {player.get('player_id')})")
        print("  ✅ Create player works")
    else:
        print(f"  Response: {response.text}")
    print()

def test_games_endpoint(token: str, team_id: str):
    """Test games endpoints."""
    headers = {"Authorization": f"Bearer {token}"}
    
    print(f"Testing GET /teams/{team_id}/games...")
    response = requests.get(f"{BASE_URL}/teams/{team_id}/games", headers=headers)
    print(f"  Status: {response.status_code}")
    if response.status_code == 200:
        games = response.json()
        print(f"  Found {len(games.get('games', []))} games")
        print("  ✅ Get games works")
    else:
        print(f"  Response: {response.text}")
    print()
    
    print("Testing POST /games...")
    game_data = {
        "team_id": team_id,
        "team_name": "Test Team",
        "opponent_name": "Opponent Team",
        "starting_position": "offense"
    }
    response = requests.post(f"{BASE_URL}/games", json=game_data, headers=headers)
    print(f"  Status: {response.status_code}")
    if response.status_code == 200:
        game = response.json()
        print(f"  Created game: {game.get('team_name')} vs {game.get('opponent_name')} (ID: {game.get('game_id')})")
        print(f"  Sheet name: {game.get('sheet_name')}")
        print("  ✅ Create game works")
        return game.get('game_id')
    else:
        print(f"  Response: {response.text}")
        return None
    print()

def main():
    """Run all tests."""
    print("="*60)
    print("Testing Ultistats API Endpoints")
    print("="*60)
    print("\nMake sure the server is running:")
    print("  uvicorn ultistats_server.main:app --reload\n")
    
    try:
        # Test root (no auth required)
        test_root()
        
        # Test auth
        test_auth_register()
        token = test_auth_login()
        
        if not token:
            print("❌ Cannot continue without authentication token")
            return
        
        # Test teams
        team_id = test_teams_endpoint(token)
        
        if team_id:
            # Test players
            test_players_endpoint(token, team_id)
            
            # Test games
            test_games_endpoint(token, team_id)
        
        print("="*60)
        print("✅ All tests completed!")
        print("="*60)
        
    except requests.exceptions.ConnectionError:
        print("\n❌ Error: Could not connect to server")
        print("Make sure the server is running:")
        print("  uvicorn ultistats_server.main:app --reload")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()

