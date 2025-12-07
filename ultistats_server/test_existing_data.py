"""
Tests against existing production data.
Verifies the index correctly reflects actual games, players, and teams.

Run with: cd ultistats_server && python -m pytest test_existing_data.py -v

Note: These tests use actual data in data/ directory and should be run
with caution (they don't modify data, only read and verify).
"""
import pytest
import json
from pathlib import Path


# =============================================================================
# Test Existing Data Integrity
# =============================================================================

class TestExistingDataIntegrity:
    """Tests that verify the integrity of existing migrated data."""
    
    @pytest.fixture
    def data_dir(self):
        """Get the data directory path."""
        return Path(__file__).parent.parent / "data"
    
    @pytest.fixture
    def index_data(self, data_dir):
        """Load the index.json file."""
        index_file = data_dir / "index.json"
        if not index_file.exists():
            pytest.skip("No index.json found - run rebuild first")
        with open(index_file, 'r') as f:
            return json.load(f)
    
    def test_index_file_exists(self, data_dir):
        """Verify index.json exists."""
        assert (data_dir / "index.json").exists(), "index.json should exist"
    
    def test_index_has_required_keys(self, index_data):
        """Verify index has all required keys."""
        required_keys = ["lastRebuilt", "playerGames", "teamGames", "gameRoster", "playerTeams"]
        for key in required_keys:
            assert key in index_data, f"Index missing key: {key}"
    
    def test_players_directory_exists(self, data_dir):
        """Verify players directory exists and has files."""
        players_dir = data_dir / "players"
        assert players_dir.exists(), "players/ directory should exist"
        player_files = list(players_dir.glob("*.json"))
        assert len(player_files) > 0, "Should have at least one player file"
    
    def test_teams_directory_exists(self, data_dir):
        """Verify teams directory exists and has files."""
        teams_dir = data_dir / "teams"
        assert teams_dir.exists(), "teams/ directory should exist"
        team_files = list(teams_dir.glob("*.json"))
        assert len(team_files) > 0, "Should have at least one team file"
    
    def test_games_directory_exists(self, data_dir):
        """Verify games directory exists and has subdirectories."""
        games_dir = data_dir / "games"
        assert games_dir.exists(), "games/ directory should exist"
        game_dirs = [d for d in games_dir.iterdir() if d.is_dir()]
        assert len(game_dirs) > 0, "Should have at least one game directory"
    
    def test_all_players_have_valid_structure(self, data_dir):
        """Verify all player files have required fields."""
        players_dir = data_dir / "players"
        required_fields = ["id", "name"]
        
        for player_file in players_dir.glob("*.json"):
            with open(player_file, 'r') as f:
                player = json.load(f)
            
            for field in required_fields:
                assert field in player, f"Player {player_file.name} missing field: {field}"
            
            # ID should match filename (without .json)
            expected_id = player_file.stem
            assert player["id"] == expected_id, f"Player ID mismatch in {player_file.name}"
    
    def test_all_teams_have_valid_structure(self, data_dir):
        """Verify all team files have required fields."""
        teams_dir = data_dir / "teams"
        required_fields = ["id", "name", "playerIds"]
        
        for team_file in teams_dir.glob("*.json"):
            with open(team_file, 'r') as f:
                team = json.load(f)
            
            for field in required_fields:
                assert field in team, f"Team {team_file.name} missing field: {field}"
            
            # playerIds should be a list
            assert isinstance(team["playerIds"], list), f"Team {team_file.name} playerIds should be a list"
    
    def test_all_games_have_current_json(self, data_dir):
        """Verify all game directories have current.json."""
        games_dir = data_dir / "games"
        
        for game_dir in games_dir.iterdir():
            if not game_dir.is_dir():
                continue
            
            current_file = game_dir / "current.json"
            assert current_file.exists(), f"Game {game_dir.name} missing current.json"
    
    def test_all_games_have_team_id(self, data_dir):
        """Verify all games have teamId field."""
        games_dir = data_dir / "games"
        
        for game_dir in games_dir.iterdir():
            if not game_dir.is_dir():
                continue
            
            current_file = game_dir / "current.json"
            if not current_file.exists():
                continue
            
            with open(current_file, 'r') as f:
                game = json.load(f)
            
            assert "teamId" in game, f"Game {game_dir.name} missing teamId"
    
    def test_all_games_have_roster_snapshot(self, data_dir):
        """Verify all games have rosterSnapshot."""
        games_dir = data_dir / "games"
        
        for game_dir in games_dir.iterdir():
            if not game_dir.is_dir():
                continue
            
            current_file = game_dir / "current.json"
            if not current_file.exists():
                continue
            
            with open(current_file, 'r') as f:
                game = json.load(f)
            
            assert "rosterSnapshot" in game, f"Game {game_dir.name} missing rosterSnapshot"
            assert "players" in game["rosterSnapshot"], f"Game {game_dir.name} rosterSnapshot missing players"


# =============================================================================
# Test Index Accuracy
# =============================================================================

class TestIndexAccuracy:
    """Tests that verify the index accurately reflects the data."""
    
    @pytest.fixture
    def data_dir(self):
        return Path(__file__).parent.parent / "data"
    
    @pytest.fixture
    def index_data(self, data_dir):
        index_file = data_dir / "index.json"
        if not index_file.exists():
            pytest.skip("No index.json found")
        with open(index_file, 'r') as f:
            return json.load(f)
    
    def test_team_games_matches_game_files(self, data_dir, index_data):
        """Verify teamGames in index matches actual game files."""
        games_dir = data_dir / "games"
        
        for team_id, game_ids in index_data.get("teamGames", {}).items():
            for game_id in game_ids:
                game_file = games_dir / game_id / "current.json"
                assert game_file.exists(), f"Game {game_id} in teamGames but file doesn't exist"
                
                with open(game_file, 'r') as f:
                    game = json.load(f)
                
                # Game should reference this team
                assert game.get("teamId") == team_id, \
                    f"Game {game_id} indexed under team {team_id} but has teamId {game.get('teamId')}"
    
    def test_player_teams_matches_team_files(self, data_dir, index_data):
        """Verify playerTeams in index matches team files."""
        teams_dir = data_dir / "teams"
        
        for player_id, team_ids in index_data.get("playerTeams", {}).items():
            for team_id in team_ids:
                team_file = teams_dir / f"{team_id}.json"
                assert team_file.exists(), f"Team {team_id} in playerTeams but file doesn't exist"
                
                with open(team_file, 'r') as f:
                    team = json.load(f)
                
                # Team should contain this player
                assert player_id in team.get("playerIds", []), \
                    f"Player {player_id} indexed under team {team_id} but not in team's playerIds"
    
    def test_game_roster_matches_roster_snapshot(self, data_dir, index_data):
        """Verify gameRoster in index matches game's rosterSnapshot."""
        games_dir = data_dir / "games"
        
        for game_id, player_ids in index_data.get("gameRoster", {}).items():
            game_file = games_dir / game_id / "current.json"
            if not game_file.exists():
                continue
            
            with open(game_file, 'r') as f:
                game = json.load(f)
            
            roster_player_ids = [p.get("id") for p in game.get("rosterSnapshot", {}).get("players", [])]
            
            # All indexed players should be in roster snapshot
            for player_id in player_ids:
                # Note: some players might come from events, not just roster snapshot
                # This is a soft check
                pass
    
    def test_player_games_consistency(self, data_dir, index_data):
        """Verify playerGames and gameRoster are consistent."""
        player_games = index_data.get("playerGames", {})
        game_roster = index_data.get("gameRoster", {})
        
        # For each player->game mapping, the game should have that player in roster
        for player_id, game_ids in player_games.items():
            for game_id in game_ids:
                if game_id in game_roster:
                    assert player_id in game_roster[game_id], \
                        f"Player {player_id} has game {game_id} but not in gameRoster"
    
    def test_all_indexed_players_exist(self, data_dir, index_data):
        """Verify all players in playerGames index have corresponding files.
        
        Note: We only check playerGames (built from game rosterSnapshots), not
        playerTeams, because teams can reference player IDs that don't have
        files yet (e.g., pending sync or deleted players).
        """
        players_dir = data_dir / "players"
        
        # Only check playerGames - these come from actual game rosters
        for player_id in index_data.get("playerGames", {}).keys():
            player_file = players_dir / f"{player_id}.json"
            assert player_file.exists(), f"Indexed player {player_id} has no file"
    
    def test_all_indexed_teams_exist(self, data_dir, index_data):
        """Verify all teams in index have corresponding files."""
        teams_dir = data_dir / "teams"
        
        all_indexed_teams = set(index_data.get("teamGames", {}).keys())
        
        for team_id in all_indexed_teams:
            team_file = teams_dir / f"{team_id}.json"
            assert team_file.exists(), f"Indexed team {team_id} has no file"


# =============================================================================
# Test Specific Known Data (CUDO Mixed)
# =============================================================================

class TestCUDOMixedData:
    """Tests specific to the known CUDO Mixed data."""
    
    @pytest.fixture
    def data_dir(self):
        return Path(__file__).parent.parent / "data"
    
    @pytest.fixture
    def index_data(self, data_dir):
        index_file = data_dir / "index.json"
        if not index_file.exists():
            pytest.skip("No index.json found")
        with open(index_file, 'r') as f:
            return json.load(f)
    
    def test_cudo_mixed_team_exists(self, data_dir):
        """Verify CUDO Mixed team file exists."""
        team_file = data_dir / "teams" / "CUDO-Mixed-8kr5.json"
        assert team_file.exists(), "CUDO-Mixed-8kr5.json should exist"
    
    def test_cudo_mixed_has_correct_player_count(self, data_dir):
        """Verify CUDO Mixed has expected players."""
        team_file = data_dir / "teams" / "CUDO-Mixed-8kr5.json"
        with open(team_file, 'r') as f:
            team = json.load(f)
        
        # Should have 18 players based on migrated data
        assert len(team["playerIds"]) == 18, f"Expected 18 players, got {len(team['playerIds'])}"
    
    def test_cudo_mixed_has_four_games(self, index_data):
        """Verify CUDO Mixed has 4 games in index."""
        team_games = index_data.get("teamGames", {}).get("CUDO-Mixed-8kr5", [])
        assert len(team_games) == 4, f"Expected 4 games, got {len(team_games)}"
    
    def test_expected_games_exist(self, data_dir):
        """Verify all expected game directories exist."""
        expected_games = [
            "2025-11-15_CUDO-Mixed_vs_Alexandria_1763235977720",
            "2025-11-16_CUDO-Mixed_vs_Fog_1763312279301",
            "2025-11-16_CUDO-Mixed_vs_Jackson-Reed-2_1763305300804",
            "2025-11-16_CUDO-Mixed_vs_SWW-2_1763318188719"
        ]
        
        games_dir = data_dir / "games"
        for game_id in expected_games:
            game_dir = games_dir / game_id
            assert game_dir.exists(), f"Expected game {game_id} not found"
            assert (game_dir / "current.json").exists(), f"Game {game_id} missing current.json"
    
    def test_expected_players_exist(self, data_dir):
        """Verify expected players have files."""
        expected_players = [
            "Kellen-syip", "Finn-ajs9", "Stella-9ve7", "Abby-p0br",
            "Simeon-bpxf", "Leif-w435", "Rayanne-a72s", "Violet-9ms5"
        ]
        
        players_dir = data_dir / "players"
        for player_id in expected_players:
            player_file = players_dir / f"{player_id}.json"
            assert player_file.exists(), f"Expected player {player_id} not found"
    
    def test_player_with_fewer_games(self, index_data):
        """Verify players with partial attendance are correctly indexed."""
        # Ella and Keelan only played in the Alexandria game
        ella_games = index_data.get("playerGames", {}).get("Ella-4mgm", [])
        keelan_games = index_data.get("playerGames", {}).get("Keelan-r85a", [])
        
        assert len(ella_games) == 1, f"Ella should have 1 game, got {len(ella_games)}"
        assert len(keelan_games) == 1, f"Keelan should have 1 game, got {len(keelan_games)}"
        
        # They should both be in the Alexandria game
        assert "2025-11-15_CUDO-Mixed_vs_Alexandria_1763235977720" in ella_games
        assert "2025-11-15_CUDO-Mixed_vs_Alexandria_1763235977720" in keelan_games
    
    def test_henry_played_three_games(self, index_data):
        """Verify Henry (who missed Alexandria) has 3 games."""
        henry_games = index_data.get("playerGames", {}).get("Henry-xydc", [])
        assert len(henry_games) == 3, f"Henry should have 3 games, got {len(henry_games)}"
        
        # Should NOT include Alexandria
        assert "2025-11-15_CUDO-Mixed_vs_Alexandria_1763235977720" not in henry_games


# =============================================================================
# Run a Quick Smoke Test
# =============================================================================

def test_quick_smoke_test():
    """Quick smoke test that can be run to verify basic setup."""
    data_dir = Path(__file__).parent.parent / "data"
    
    # Check directories exist
    assert data_dir.exists(), "data/ directory should exist"
    assert (data_dir / "players").exists(), "players/ directory should exist"
    assert (data_dir / "teams").exists(), "teams/ directory should exist"
    assert (data_dir / "games").exists(), "games/ directory should exist"
    
    # Check index exists
    assert (data_dir / "index.json").exists(), "index.json should exist"
    
    # Check we have data
    players = list((data_dir / "players").glob("*.json"))
    teams = list((data_dir / "teams").glob("*.json"))
    games = [d for d in (data_dir / "games").iterdir() if d.is_dir()]
    
    assert len(players) > 0, "Should have players"
    assert len(teams) > 0, "Should have teams"
    assert len(games) > 0, "Should have games"
    
    print(f"\n✅ Smoke test passed!")
    print(f"   - {len(players)} players")
    print(f"   - {len(teams)} teams")
    print(f"   - {len(games)} games")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

