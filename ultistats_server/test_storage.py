"""
Unit tests for storage functions (player, team, game, index).

Run with: cd ultistats_server && python -m pytest test_storage.py -v
"""
import pytest
import json
import tempfile
import shutil
import os
from pathlib import Path
from datetime import datetime

# Set up isolated test directory BEFORE importing any modules
_original_env = os.environ.get("ULTISTATS_DATA_DIR")


@pytest.fixture(autouse=True)
def isolate_test_data(tmp_path):
    """Create an isolated data directory for each test."""
    test_data_dir = tmp_path / "test_data"
    test_data_dir.mkdir()
    
    # Set environment variable
    os.environ["ULTISTATS_DATA_DIR"] = str(test_data_dir)
    
    # Force reimport of config to pick up new env var
    import importlib
    import config
    importlib.reload(config)
    
    # Reload storage modules to pick up new config
    from storage import player_storage, team_storage, game_storage, index_storage
    importlib.reload(player_storage)
    importlib.reload(team_storage)
    importlib.reload(game_storage)
    importlib.reload(index_storage)
    
    yield test_data_dir
    
    # Restore original env
    if _original_env:
        os.environ["ULTISTATS_DATA_DIR"] = _original_env
    else:
        os.environ.pop("ULTISTATS_DATA_DIR", None)


# =============================================================================
# Player Storage Tests
# =============================================================================

class TestPlayerStorage:
    """Tests for player_storage.py functions."""
    
    def test_generate_player_id_format(self, isolate_test_data):
        """Test that player IDs follow the expected format."""
        from storage.player_storage import generate_player_id
        
        player_id = generate_player_id("Alice")
        
        # Should be Name-XXXX format
        parts = player_id.rsplit('-', 1)
        assert len(parts) == 2
        assert parts[0] == "Alice"
        assert len(parts[1]) == 4
        assert parts[1].isalnum()
    
    def test_generate_player_id_sanitizes_name(self, isolate_test_data):
        """Test that special characters are removed from name."""
        from storage.player_storage import generate_player_id
        
        player_id = generate_player_id("Bob O'Sullivan")
        
        # Should remove special chars
        assert "'" not in player_id
        parts = player_id.rsplit('-', 1)
        assert parts[0] == "Bob-OSullivan"
    
    def test_generate_player_id_handles_spaces(self, isolate_test_data):
        """Test that spaces are converted to hyphens."""
        from storage.player_storage import generate_player_id
        
        player_id = generate_player_id("Mary Jane Watson")
        
        parts = player_id.rsplit('-', 1)
        assert parts[0] == "Mary-Jane-Watson"
    
    def test_generate_player_id_truncates_long_names(self, isolate_test_data):
        """Test that very long names are truncated."""
        from storage.player_storage import generate_player_id
        
        long_name = "A" * 50
        player_id = generate_player_id(long_name)
        
        parts = player_id.rsplit('-', 1)
        assert len(parts[0]) <= 20
    
    def test_save_player_creates_file(self, isolate_test_data):
        """Test saving a player creates a JSON file."""
        from storage.player_storage import save_player, player_exists
        import config
        
        player_data = {
            "name": "TestPlayer",
            "gender": "MMP",
            "number": "7"
        }
        
        player_id = save_player(player_data)
        
        assert player_exists(player_id)
        assert (config.PLAYERS_DIR / f"{player_id}.json").exists()
    
    def test_save_player_with_provided_id(self, isolate_test_data):
        """Test saving a player with a specific ID."""
        from storage.player_storage import save_player, get_player
        
        player_data = {
            "name": "TestPlayer",
            "gender": "FMP"
        }
        
        player_id = save_player(player_data, "Custom-ID-1234")
        
        assert player_id == "Custom-ID-1234"
        player = get_player(player_id)
        assert player["name"] == "TestPlayer"
        assert player["id"] == "Custom-ID-1234"
    
    def test_save_player_adds_timestamps(self, isolate_test_data):
        """Test that save_player adds createdAt and updatedAt."""
        from storage.player_storage import save_player, get_player
        
        player_data = {"name": "TimePlayer"}
        player_id = save_player(player_data)
        
        player = get_player(player_id)
        assert "createdAt" in player
        assert "updatedAt" in player
    
    def test_get_player_returns_data(self, isolate_test_data):
        """Test retrieving a saved player."""
        from storage.player_storage import save_player, get_player
        
        player_data = {
            "name": "GetPlayer",
            "nickname": "GP",
            "number": "99"
        }
        
        player_id = save_player(player_data)
        retrieved = get_player(player_id)
        
        assert retrieved["name"] == "GetPlayer"
        assert retrieved["nickname"] == "GP"
        assert retrieved["number"] == "99"
    
    def test_get_player_not_found_raises(self, isolate_test_data):
        """Test that getting a non-existent player raises FileNotFoundError."""
        from storage.player_storage import get_player
        
        with pytest.raises(FileNotFoundError):
            get_player("NonExistent-1234")
    
    def test_list_players_returns_all(self, isolate_test_data):
        """Test listing all players."""
        from storage.player_storage import save_player, list_players
        
        save_player({"name": "Alice"})
        save_player({"name": "Bob"})
        save_player({"name": "Charlie"})
        
        players = list_players()
        
        assert len(players) == 3
        names = [p["name"] for p in players]
        assert "Alice" in names
        assert "Bob" in names
        assert "Charlie" in names
    
    def test_list_players_sorted_by_name(self, isolate_test_data):
        """Test that list_players returns players sorted by name."""
        from storage.player_storage import save_player, list_players
        
        save_player({"name": "Zara"})
        save_player({"name": "Alice"})
        save_player({"name": "Mike"})
        
        players = list_players()
        names = [p["name"] for p in players]
        
        assert names == ["Alice", "Mike", "Zara"]
    
    def test_update_player_modifies_data(self, isolate_test_data):
        """Test updating an existing player."""
        from storage.player_storage import save_player, update_player, get_player
        
        player_id = save_player({"name": "Original"})
        update_player(player_id, {"name": "Updated", "number": "42"})
        
        player = get_player(player_id)
        assert player["name"] == "Updated"
        assert player["number"] == "42"
    
    def test_update_player_preserves_created_at(self, isolate_test_data):
        """Test that update_player preserves the original createdAt."""
        from storage.player_storage import save_player, update_player, get_player
        import time
        
        player_id = save_player({"name": "Original"})
        original = get_player(player_id)
        original_created = original["createdAt"]
        
        time.sleep(0.01)  # Small delay
        update_player(player_id, {"name": "Updated"})
        
        updated = get_player(player_id)
        assert updated["createdAt"] == original_created
        assert updated["updatedAt"] != original_created
    
    def test_delete_player_removes_file(self, isolate_test_data):
        """Test deleting a player."""
        from storage.player_storage import save_player, delete_player, player_exists
        
        player_id = save_player({"name": "ToDelete"})
        assert player_exists(player_id)
        
        result = delete_player(player_id)
        
        assert result is True
        assert not player_exists(player_id)
    
    def test_delete_player_nonexistent_returns_false(self, isolate_test_data):
        """Test deleting a non-existent player returns False."""
        from storage.player_storage import delete_player
        
        result = delete_player("NonExistent-1234")
        assert result is False


# =============================================================================
# Team Storage Tests
# =============================================================================

class TestTeamStorage:
    """Tests for team_storage.py functions."""
    
    def test_generate_team_id_format(self, isolate_test_data):
        """Test that team IDs follow the expected format."""
        from storage.team_storage import generate_team_id
        
        team_id = generate_team_id("Thunder")
        
        parts = team_id.rsplit('-', 1)
        assert len(parts) == 2
        assert parts[0] == "Thunder"
        assert len(parts[1]) == 4
    
    def test_save_team_creates_file(self, isolate_test_data):
        """Test saving a team creates a JSON file."""
        from storage.team_storage import save_team, team_exists
        import config
        
        team_data = {"name": "TestTeam"}
        team_id = save_team(team_data)
        
        assert team_exists(team_id)
        assert (config.TEAMS_DIR / f"{team_id}.json").exists()
    
    def test_save_team_initializes_player_ids(self, isolate_test_data):
        """Test that save_team initializes playerIds as empty list."""
        from storage.team_storage import save_team, get_team
        
        team_id = save_team({"name": "EmptyTeam"})
        team = get_team(team_id)
        
        assert "playerIds" in team
        assert team["playerIds"] == []
    
    def test_save_team_with_player_ids(self, isolate_test_data):
        """Test saving a team with player IDs."""
        from storage.team_storage import save_team, get_team
        
        team_data = {
            "name": "FullTeam",
            "playerIds": ["Player1-abcd", "Player2-efgh"]
        }
        team_id = save_team(team_data)
        
        team = get_team(team_id)
        assert team["playerIds"] == ["Player1-abcd", "Player2-efgh"]
    
    def test_get_team_returns_data(self, isolate_test_data):
        """Test retrieving a saved team."""
        from storage.team_storage import save_team, get_team
        
        team_id = save_team({"name": "GetTeam"})
        team = get_team(team_id)
        
        assert team["name"] == "GetTeam"
        assert team["id"] == team_id
    
    def test_get_team_not_found_raises(self, isolate_test_data):
        """Test that getting a non-existent team raises FileNotFoundError."""
        from storage.team_storage import get_team
        
        with pytest.raises(FileNotFoundError):
            get_team("NonExistent-1234")
    
    def test_list_teams_returns_all(self, isolate_test_data):
        """Test listing all teams."""
        from storage.team_storage import save_team, list_teams
        
        save_team({"name": "TeamA"})
        save_team({"name": "TeamB"})
        
        teams = list_teams()
        
        assert len(teams) == 2
        names = [t["name"] for t in teams]
        assert "TeamA" in names
        assert "TeamB" in names
    
    def test_update_team_modifies_data(self, isolate_test_data):
        """Test updating an existing team."""
        from storage.team_storage import save_team, update_team, get_team
        
        team_id = save_team({"name": "Original"})
        update_team(team_id, {"name": "Updated", "playerIds": ["Player-1234"]})
        
        team = get_team(team_id)
        assert team["name"] == "Updated"
        assert team["playerIds"] == ["Player-1234"]
    
    def test_delete_team_removes_file(self, isolate_test_data):
        """Test deleting a team."""
        from storage.team_storage import save_team, delete_team, team_exists
        
        team_id = save_team({"name": "ToDelete"})
        assert team_exists(team_id)
        
        result = delete_team(team_id)
        
        assert result is True
        assert not team_exists(team_id)
    
    def test_get_team_players_resolves_ids(self, isolate_test_data):
        """Test that get_team_players resolves player IDs to player data."""
        from storage.player_storage import save_player
        from storage.team_storage import save_team, get_team_players
        
        # Create players first
        p1_id = save_player({"name": "Player1"}, "Player1-test")
        p2_id = save_player({"name": "Player2"}, "Player2-test")
        
        # Create team with player IDs
        team_id = save_team({
            "name": "FullTeam",
            "playerIds": [p1_id, p2_id]
        })
        
        players = get_team_players(team_id)
        
        assert len(players) == 2
        names = [p["name"] for p in players]
        assert "Player1" in names
        assert "Player2" in names
    
    def test_get_team_players_skips_missing_players(self, isolate_test_data):
        """Test that get_team_players skips players that don't exist."""
        from storage.player_storage import save_player
        from storage.team_storage import save_team, get_team_players
        
        # Create one player
        p1_id = save_player({"name": "ExistingPlayer"}, "Existing-test")
        
        # Create team with existing and non-existing player IDs
        team_id = save_team({
            "name": "MixedTeam",
            "playerIds": [p1_id, "Missing-1234"]
        })
        
        players = get_team_players(team_id)
        
        assert len(players) == 1
        assert players[0]["name"] == "ExistingPlayer"


# =============================================================================
# Game Storage Tests
# =============================================================================

class TestGameStorage:
    """Tests for game_storage.py functions."""
    
    def test_save_game_creates_directory_structure(self, isolate_test_data):
        """Test that saving a game creates proper directory structure."""
        from storage.game_storage import save_game_version, game_exists
        import config
        
        game_id = "test-game-001"
        game_data = {
            "team": "TestTeam",
            "opponent": "Opponent",
            "points": []
        }
        
        save_game_version(game_id, game_data)
        
        assert game_exists(game_id)
        assert (config.GAMES_DIR / game_id / "current.json").exists()
        assert (config.GAMES_DIR / game_id / "versions").is_dir()
    
    def test_save_game_creates_version_file(self, isolate_test_data):
        """Test that saving a game creates a timestamped version file."""
        from storage.game_storage import save_game_version, list_game_versions
        
        game_id = "test-game-002"
        game_data = {"team": "Team", "opponent": "Opp", "points": []}
        
        save_game_version(game_id, game_data)
        
        versions = list_game_versions(game_id)
        assert len(versions) == 1
        # Version should be timestamp format
        assert "T" in versions[0]
    
    def test_save_game_creates_multiple_versions(self, isolate_test_data):
        """Test that multiple saves create multiple versions."""
        from storage.game_storage import save_game_version, list_game_versions
        import time
        
        game_id = "test-game-003"
        game_data = {"team": "Team", "opponent": "Opp", "points": []}
        
        save_game_version(game_id, game_data)
        time.sleep(1.1)  # Ensure different timestamp
        game_data["scores"] = {"team": 1, "opponent": 0}
        save_game_version(game_id, game_data)
        
        versions = list_game_versions(game_id)
        assert len(versions) == 2
    
    def test_get_game_current_returns_latest(self, isolate_test_data):
        """Test that get_game_current returns the latest version."""
        from storage.game_storage import save_game_version, get_game_current
        import time
        
        game_id = "test-game-004"
        
        save_game_version(game_id, {"team": "Team", "opponent": "Opp", "version": 1})
        time.sleep(1.1)
        save_game_version(game_id, {"team": "Team", "opponent": "Opp", "version": 2})
        
        current = get_game_current(game_id)
        assert current["version"] == 2
    
    def test_get_game_version_returns_specific(self, isolate_test_data):
        """Test getting a specific version of a game."""
        from storage.game_storage import save_game_version, get_game_version, list_game_versions
        import time
        
        game_id = "test-game-005"
        
        save_game_version(game_id, {"team": "Team", "opponent": "Opp", "version": 1})
        time.sleep(1.1)
        save_game_version(game_id, {"team": "Team", "opponent": "Opp", "version": 2})
        
        versions = list_game_versions(game_id)
        old_version = versions[-1]  # List is newest first
        
        old_data = get_game_version(game_id, old_version)
        assert old_data["version"] == 1
    
    def test_delete_game_removes_directory(self, isolate_test_data):
        """Test that delete_game removes the entire game directory."""
        from storage.game_storage import save_game_version, delete_game, game_exists
        import config
        
        game_id = "test-game-006"
        save_game_version(game_id, {"team": "Team", "opponent": "Opp"})
        
        assert game_exists(game_id)
        result = delete_game(game_id)
        
        assert result is True
        assert not game_exists(game_id)
        assert not (config.GAMES_DIR / game_id).exists()
    
    def test_list_all_games_returns_metadata(self, isolate_test_data):
        """Test that list_all_games returns game metadata."""
        from storage.game_storage import save_game_version, list_all_games
        
        save_game_version("game-a", {
            "team": "TeamA",
            "opponent": "OpponentA",
            "teamId": "TeamA-1234",
            "scores": {"team": 5, "opponent": 3},
            "points": [{"num": 1}, {"num": 2}]
        })
        
        games = list_all_games()
        
        assert len(games) == 1
        game = games[0]
        assert game["game_id"] == "game-a"
        assert game["team"] == "TeamA"
        assert game["opponent"] == "OpponentA"
        assert game["teamId"] == "TeamA-1234"
        assert game["points_count"] == 2


# =============================================================================
# Index Storage Tests
# =============================================================================

class TestIndexStorage:
    """Tests for index_storage.py functions."""
    
    def test_rebuild_index_creates_file(self, isolate_test_data):
        """Test that rebuild_index creates index.json."""
        from storage.index_storage import rebuild_index
        import config
        
        rebuild_index()
        
        assert config.INDEX_FILE.exists()
    
    def test_rebuild_index_indexes_teams(self, isolate_test_data):
        """Test that rebuild_index indexes team-player relationships."""
        from storage.team_storage import save_team
        from storage.index_storage import rebuild_index, get_player_teams
        
        save_team({
            "name": "IndexTeam",
            "playerIds": ["Player1-test", "Player2-test"]
        }, "IndexTeam-test")
        
        rebuild_index()
        
        teams = get_player_teams("Player1-test")
        assert "IndexTeam-test" in teams
    
    def test_rebuild_index_indexes_games(self, isolate_test_data):
        """Test that rebuild_index indexes game relationships."""
        from storage.game_storage import save_game_version
        from storage.index_storage import rebuild_index, get_team_games, get_game_players
        
        save_game_version("test-game-idx", {
            "team": "IndexTeam",
            "opponent": "Opp",
            "teamId": "IndexTeam-test",
            "rosterSnapshot": {
                "players": [
                    {"id": "Player1-test", "name": "Player1"},
                    {"id": "Player2-test", "name": "Player2"}
                ]
            },
            "points": []
        })
        
        rebuild_index()
        
        team_games = get_team_games("IndexTeam-test")
        assert "test-game-idx" in team_games
        
        game_players = get_game_players("test-game-idx")
        assert "Player1-test" in game_players
        assert "Player2-test" in game_players
    
    def test_get_player_games_returns_all_games(self, isolate_test_data):
        """Test that get_player_games returns all games for a player."""
        from storage.game_storage import save_game_version
        from storage.index_storage import rebuild_index, get_player_games
        
        # Create two games with the same player
        for i in range(2):
            save_game_version(f"player-game-{i}", {
                "team": "Team",
                "opponent": "Opp",
                "teamId": "Team-test",
                "rosterSnapshot": {
                    "players": [{"id": "SharedPlayer-test", "name": "Shared"}]
                },
                "points": []
            })
        
        rebuild_index()
        
        games = get_player_games("SharedPlayer-test")
        assert len(games) == 2
        assert "player-game-0" in games
        assert "player-game-1" in games
    
    def test_get_index_status_returns_counts(self, isolate_test_data):
        """Test that get_index_status returns correct counts."""
        from storage.team_storage import save_team
        from storage.game_storage import save_game_version
        from storage.index_storage import rebuild_index, get_index_status
        
        save_team({"name": "StatusTeam", "playerIds": ["P1-test", "P2-test"]}, "StatusTeam-test")
        save_game_version("status-game", {
            "team": "StatusTeam",
            "opponent": "Opp",
            "teamId": "StatusTeam-test",
            "rosterSnapshot": {"players": [{"id": "P1-test"}]},
            "points": []
        })
        
        rebuild_index()
        status = get_index_status()
        
        assert status["indexExists"] is True
        assert status["teamCount"] >= 1
        assert status["gameCount"] >= 1
        assert "lastRebuilt" in status
    
    def test_update_index_for_game_incremental(self, isolate_test_data):
        """Test incremental index update for a game."""
        from storage.index_storage import rebuild_index, update_index_for_game, get_team_games
        
        # First, build initial empty index
        rebuild_index()
        
        # Simulate adding a game
        update_index_for_game("new-game", {
            "teamId": "NewTeam-test",
            "rosterSnapshot": {"players": [{"id": "NewPlayer-test"}]},
            "points": []
        })
        
        team_games = get_team_games("NewTeam-test")
        assert "new-game" in team_games
    
    def test_update_index_for_team_incremental(self, isolate_test_data):
        """Test incremental index update for a team."""
        from storage.index_storage import rebuild_index, update_index_for_team, get_player_teams
        
        # First, build initial empty index
        rebuild_index()
        
        # Simulate adding a team
        update_index_for_team("NewTeam-test", {
            "playerIds": ["NewPlayer-test"]
        })
        
        player_teams = get_player_teams("NewPlayer-test")
        assert "NewTeam-test" in player_teams


# =============================================================================
# Integration Tests - Full Workflow
# =============================================================================

class TestFullWorkflow:
    """Integration tests for complete workflows."""
    
    def test_create_team_with_players_and_game(self, isolate_test_data):
        """Test complete workflow: create players, team, then game."""
        from storage.player_storage import save_player
        from storage.team_storage import save_team, get_team_players
        from storage.game_storage import save_game_version, get_game_current
        from storage.index_storage import rebuild_index, get_player_games, get_team_games
        
        # 1. Create players
        p1_id = save_player({"name": "Alice", "gender": "FMP"}, "Alice-test")
        p2_id = save_player({"name": "Bob", "gender": "MMP"}, "Bob-test")
        
        # 2. Create team with players
        team_id = save_team({
            "name": "TestTeam",
            "playerIds": [p1_id, p2_id]
        }, "TestTeam-test")
        
        # 3. Create game with roster snapshot
        game_id = "2024-01-15_TestTeam_vs_Opponent_123"
        save_game_version(game_id, {
            "team": "TestTeam",
            "opponent": "Opponent",
            "teamId": team_id,
            "rosterSnapshot": {
                "players": [
                    {"id": p1_id, "name": "Alice"},
                    {"id": p2_id, "name": "Bob"}
                ]
            },
            "points": []
        })
        
        # 4. Verify team players
        team_players = get_team_players(team_id)
        assert len(team_players) == 2
        
        # 5. Rebuild index and verify queries
        rebuild_index()
        
        alice_games = get_player_games(p1_id)
        assert game_id in alice_games
        
        team_games = get_team_games(team_id)
        assert game_id in team_games
        
        # 6. Verify game data
        game = get_game_current(game_id)
        assert game["teamId"] == team_id
        assert len(game["rosterSnapshot"]["players"]) == 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
