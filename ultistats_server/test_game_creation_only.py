"""
Test game creation step specifically, using existing team.
Run after steps 1-3 have completed successfully.
"""

import requests
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

BASE_URL = "http://localhost:8000"

def main():
    # Use existing testuser or create new one
    username = "testuser"
    password = "testpass123"
    
    print("="*70)
    print("TESTING GAME CREATION")
    print("="*70)
    
    # Login
    print("\n1. Logging in...")
    login_data = {"username": username, "password": password}
    response = requests.post(
        f"{BASE_URL}/auth/login",
        data=login_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    
    if response.status_code != 200:
        print(f"❌ Login failed: {response.status_code} - {response.text}")
        print("\nTrying to register...")
        register_data = {
            "username": username,
            "password": password,
            "email": "test@example.com",
            "full_name": "Test User"
        }
        response = requests.post(f"{BASE_URL}/auth/register", json=register_data)
        print(f"Register: {response.status_code}")
        if response.status_code == 200:
            import time
            time.sleep(2)
            response = requests.post(
                f"{BASE_URL}/auth/login",
                data=login_data,
                headers={"Content-Type": "application/x-www-form-urlencoded"}
            )
    
    if response.status_code != 200:
        print(f"❌ Cannot login: {response.text}")
        return
    
    token = response.json().get('access_token')
    headers = {"Authorization": f"Bearer {token}"}
    print(f"✅ Logged in, token: {token[:30]}...")
    
    # Get existing team
    print("\n2. Getting teams...")
    response = requests.get(f"{BASE_URL}/teams", headers=headers)
    if response.status_code != 200:
        print(f"❌ Failed to get teams: {response.text}")
        return
    
    teams = response.json().get('teams', [])
    if not teams:
        print("❌ No teams found. Please create a team first.")
        return
    
    team = teams[0]  # Use first team
    team_id = team.get('team_id')
    team_name = team.get('team_name')
    print(f"✅ Found team: {team_name} (ID: {team_id})")
    
    # Create game
    print("\n3. Creating game...")
    game_data = {
        "team_id": team_id,
        "team_name": team_name,
        "opponent_name": "Team-G 2",
        "starting_position": "offense"
    }
    
    print(f"   Game data: {json.dumps(game_data, indent=2)}")
    response = requests.post(
        f"{BASE_URL}/games",
        json=game_data,
        headers=headers
    )
    
    print(f"\n   Status: {response.status_code}")
    if response.status_code == 200:
        game = response.json()
        print(f"✅ Game created successfully!")
        print(f"   Game ID: {game.get('game_id')}")
        print(f"   Sheet Name: {game.get('sheet_name')}")
        print(f"\n📋 Verify in Google Sheets:")
        print(f"   1. Check 'Games' sheet - should see new game entry")
        print(f"   2. Check for new sheet tab: '{game.get('sheet_name')}'")
    else:
        print(f"❌ Failed: {response.text}")

if __name__ == "__main__":
    main()

