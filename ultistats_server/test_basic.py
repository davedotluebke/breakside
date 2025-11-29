"""
Basic test script to verify JSON backend storage works.
"""
import json
from pathlib import Path
from storage import game_storage

# Sample game data
sample_game = {
    "team": "CUDO Mixed",
    "opponent": "Test Opponent",
    "startingPosition": "offense",
    "scores": {
        "team": 0,
        "opponent": 0
    },
    "points": [],
    "gameStartTimestamp": "2024-01-15T10:00:00Z",
    "gameEndTimestamp": None,
    "alternateGenderRatio": "No",
    "alternateGenderPulls": False,
    "startingGenderRatio": None
}

def test_basic_storage():
    """Test basic storage operations."""
    print("Testing JSON backend storage...")
    
    game_id = "test-game-001"
    
    # Test save
    print(f"1. Saving game {game_id}...")
    version_file = game_storage.save_game_version(game_id, sample_game)
    print(f"   ✓ Saved to: {version_file}")
    
    # Test get current
    print(f"2. Retrieving current game...")
    retrieved = game_storage.get_game_current(game_id)
    assert retrieved["team"] == sample_game["team"]
    print(f"   ✓ Retrieved game: {retrieved['team']} vs {retrieved['opponent']}")
    
    # Test list versions
    print(f"3. Listing versions...")
    versions = game_storage.list_game_versions(game_id)
    print(f"   ✓ Found {len(versions)} version(s)")
    
    # Test get specific version
    if versions:
        print(f"4. Retrieving version {versions[0]}...")
        version_data = game_storage.get_game_version(game_id, versions[0])
        assert version_data["team"] == sample_game["team"]
        print(f"   ✓ Retrieved version successfully")
    
    # Test update (save again)
    sample_game["scores"]["team"] = 1
    print(f"5. Updating game (team scored)...")
    game_storage.save_game_version(game_id, sample_game)
    updated = game_storage.get_game_current(game_id)
    assert updated["scores"]["team"] == 1
    print(f"   ✓ Updated successfully: {updated['scores']}")
    
    # Test list all games
    print(f"6. Listing all games...")
    all_games = game_storage.list_all_games()
    print(f"   ✓ Found {len(all_games)} game(s)")
    
    # Cleanup
    print(f"7. Cleaning up test game...")
    game_storage.delete_game(game_id)
    print(f"   ✓ Deleted test game")
    
    print("\n✅ All tests passed!")

if __name__ == "__main__":
    test_basic_storage()

