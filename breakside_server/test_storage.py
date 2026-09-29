"""
Unit tests for storage functions (player, team, game, index).

Run with: cd breakside_server && python -m pytest test_storage.py -v
"""
import pytest
import json
import tempfile
import shutil
import os
from pathlib import Path
from datetime import datetime

# Set up isolated test directory BEFORE importing any modules
_original_env = os.environ.get("BREAKSIDE_DATA_DIR")


@pytest.fixture(autouse=True)
def isolate_test_data(tmp_path):
    """Create an isolated data directory for each test."""
    test_data_dir = tmp_path / "test_data"
    test_data_dir.mkdir()
    
    # Set environment variable
    os.environ["BREAKSIDE_DATA_DIR"] = str(test_data_dir)
    
    # Force reimport of config to pick up new env var
    import importlib
    import config
    importlib.reload(config)
    
    # Reload storage modules to pick up new config.
    #
    # ORDER MATTERS: index_storage snapshots INDEX_FILE/TEAMS_DIR/etc. at
    # import time, and team_storage/game_storage bind update_index_for_* BY
    # VALUE at import time. Reloading index_storage last would leave those two
    # holding the pre-reload function, which still writes the REAL
    # data/index.json — tests then silently mutate the developer's data dir.
    # Reload the dependency first, then its dependents.
    from storage import player_storage, team_storage, game_storage, index_storage
    importlib.reload(index_storage)
    importlib.reload(player_storage)
    importlib.reload(team_storage)
    importlib.reload(game_storage)
    
    yield test_data_dir

    # Restore original env
    if _original_env:
        os.environ["BREAKSIDE_DATA_DIR"] = _original_env
    else:
        os.environ.pop("BREAKSIDE_DATA_DIR", None)

    # Reload again so config/storage module state points back at the default
    # data dir instead of this test's (soon to be pruned) tmp_path. Without
    # this, module globals stay aimed at a dead directory for every test
    # module that runs after this one.
    importlib.reload(config)
    importlib.reload(player_storage)
    importlib.reload(team_storage)
    importlib.reload(game_storage)
    importlib.reload(index_storage)


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
        
        save_player({"name": "Zoe"})
        save_player({"name": "Alice"})
        save_player({"name": "Mia"})
        
        players = list_players()
        names = [p["name"] for p in players]
        
        assert names == ["Alice", "Mia", "Zoe"]
    
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

    def test_field_position_event_fields_round_trip(self, isolate_test_data):
        """Field-tab spatial event fields survive a save -> load round trip.

        The server stores game JSON verbatim (schemaless dict), so the
        canonical (l,w) locations, assist attribution, pull hang/brick, and
        Defense location added for the Field tab must come back unchanged.
        Guards against a future schema/model tightening that would silently
        drop unknown event keys.
        """
        from storage.game_storage import save_game_version, get_game_current

        game_id = "test-game-field-pos"
        game_data = {
            "team": "Team", "opponent": "Opp",
            "points": [{
                "players": ["Alice", "Bob"],
                "startingPosition": "defense",
                "possessions": [{
                    "offensive": False,
                    "events": [
                        {"type": "Pull", "puller": "Alice", "pullerId": "alice-1",
                         "from": {"l": 25, "w": 20}, "to": {"l": 78, "w": 9},
                         "hang": 4200, "brick_flag": False},
                        {"type": "Defense", "defender": "Bob", "defenderId": "bob-1",
                         "block_flag": True, "to": {"l": 60, "w": 31}},
                    ],
                }, {
                    "offensive": True,
                    "events": [
                        {"type": "Throw", "thrower": "Bob", "throwerId": "bob-1",
                         "receiver": "Alice", "receiverId": "alice-1",
                         "score_flag": True, "assist": "Bob", "assistId": "bob-1",
                         "from": {"l": 60, "w": 31}, "to": {"l": 110, "w": 20}},
                    ],
                }],
            }],
        }
        save_game_version(game_id, game_data)

        current = get_game_current(game_id)
        possessions = current["points"][0]["possessions"]
        pull = possessions[0]["events"][0]
        defense = possessions[0]["events"][1]
        throw = possessions[1]["events"][0]

        assert pull["from"] == {"l": 25, "w": 20}
        assert pull["to"] == {"l": 78, "w": 9}
        assert pull["hang"] == 4200
        assert pull["brick_flag"] is False
        assert defense["to"] == {"l": 60, "w": 31}
        assert throw["from"] == {"l": 60, "w": 31}
        assert throw["to"] == {"l": 110, "w": 20}
        # Assist serialized as name + id (not a dumped Player object)
        assert throw["assist"] == "Bob"
        assert throw["assistId"] == "bob-1"

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
        # Ordinary games carry the scrimmage fields as null, so the client
        # can group on them without checking for presence.
        assert game["scrimmageId"] is None
        assert game["scrimmageSquad"] is None
        assert game["scrimmageName"] is None

    def test_list_all_games_carries_scrimmage_fields(self, isolate_test_data):
        """A scrimmage's two squad-games list with the fields that link them."""
        from storage.game_storage import save_game_version, list_all_games

        for squad, team, opponent in (("X", "Dark", "Light"), ("Y", "Light", "Dark")):
            save_game_version(f"2026-09-27_{team}_vs_{opponent}_1", {
                "team": team,
                "opponent": opponent,
                "teamId": "TeamA-1234",
                "scrimmageId": "Scrimmage-2026-09-27-ab12",
                "scrimmageSquad": squad,
                "scrimmageName": "Tuesday practice",
                "points": [],
            })

        games = sorted(list_all_games(), key=lambda g: g["scrimmageSquad"])

        assert [g["scrimmageSquad"] for g in games] == ["X", "Y"]
        assert {g["scrimmageId"] for g in games} == {"Scrimmage-2026-09-27-ab12"}
        assert {g["scrimmageName"] for g in games} == {"Tuesday practice"}
        assert [(g["team"], g["opponent"]) for g in games] == [("Dark", "Light"), ("Light", "Dark")]


# =============================================================================
# pendingNextLine Merge Tests
# =============================================================================

class TestMergePendingNextLine:
    """Tests for merge_pending_next_line (server-side sync merge)."""

    def test_newer_line_wins(self, isolate_test_data):
        """A line group with a newer *ModifiedAt replaces the stored one."""
        from storage.game_storage import merge_pending_next_line

        existing = {"oLine": ["A"], "oLineModifiedAt": 1000}
        incoming = {"oLine": ["B", "C"], "oLineModifiedAt": 2000}
        merged = merge_pending_next_line(existing, incoming)
        assert merged["oLine"] == ["B", "C"]
        assert merged["oLineModifiedAt"] == 2000

    def test_stale_line_does_not_revert(self, isolate_test_data):
        """A line group with an older *ModifiedAt keeps the stored value."""
        from storage.game_storage import merge_pending_next_line

        existing = {"oLine": ["A"], "oLineModifiedAt": 2000}
        incoming = {"oLine": ["B"], "oLineModifiedAt": 1000}
        merged = merge_pending_next_line(existing, incoming)
        assert merged["oLine"] == ["A"]
        assert merged["oLineModifiedAt"] == 2000

    def test_newer_use_separate_lines_flip_wins(self, isolate_test_data):
        """Regression: a newer Combined/Separate mode flip must propagate.

        Previously useSeparateLines was missing from the merge entirely, so
        a sync carrying a newer flip was silently reverted to the stored
        value (the client-side merge in store/sync.js does honor it).
        """
        from storage.game_storage import merge_pending_next_line

        existing = {"useSeparateLines": True, "useSeparateLinesAt": 1000}
        incoming = {"useSeparateLines": False, "useSeparateLinesAt": 2000}
        merged = merge_pending_next_line(existing, incoming)
        assert merged["useSeparateLines"] is False
        assert merged["useSeparateLinesAt"] == 2000

    def test_stale_use_separate_lines_does_not_revert(self, isolate_test_data):
        """An older mode flip must not roll back the stored newer one."""
        from storage.game_storage import merge_pending_next_line

        existing = {"useSeparateLines": False, "useSeparateLinesAt": 2000}
        incoming = {"useSeparateLines": True, "useSeparateLinesAt": 1000}
        merged = merge_pending_next_line(existing, incoming)
        assert merged["useSeparateLines"] is False
        assert merged["useSeparateLinesAt"] == 2000

    def test_use_separate_lines_missing_timestamps_no_change(self, isolate_test_data):
        """Absent useSeparateLinesAt on both sides leaves the stored value."""
        from storage.game_storage import merge_pending_next_line

        existing = {"useSeparateLines": True}
        incoming = {"useSeparateLines": False}
        merged = merge_pending_next_line(existing, incoming)
        assert merged["useSeparateLines"] is True


# =============================================================================
# Squad definition merge (intrasquad scrimmages)
# =============================================================================

class TestSquadDefinitionMerge:
    """The squad of a scrimmage half is its rosterSnapshot, versioned by
    capturedAt; a squad edit is PATCHed in by a coach who is usually not in
    the game, and must survive the Active Coach's next full sync."""

    T0 = "2026-09-29T18:00:00.000Z"
    T1 = "2026-09-29T18:10:00.000Z"

    def _snapshot(self, names, captured_at):
        return {"players": [{"id": f"{n}-0001", "name": n} for n in names],
                "capturedAt": captured_at}

    def _half(self, names, captured_at, **fields):
        base = {"team": "Dark", "opponent": "Light", "teamId": "Team-0001",
                "scrimmageId": "Scrimmage-2026-09-29-ab12", "scrimmageSquad": "X",
                "scrimmageName": None,
                "scores": {"team": 3, "opponent": 2}, "points": [{"i": i} for i in range(5)],
                "rosterSnapshot": self._snapshot(names, captured_at)}
        base.update(fields)
        return base

    def test_authoritative_sync_with_a_stale_snapshot_keeps_the_newer_squad(self, isolate_test_data):
        """The Active Coach syncs the copy their phone held; another coach's
        squad edit (newer capturedAt, patched in meanwhile) stays — with the
        names it was saved with — while the play data is theirs."""
        from storage.game_storage import save_game_version, get_game_current, update_squad_definition

        gid = "squad-merge-001"
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0))
        update_squad_definition(gid, {
            "rosterSnapshot": self._snapshot(["Alice", "Bob", "Eve"], self.T1),
            "team": "Red", "opponent": "Blue", "scrimmageName": "Tuesday",
        })
        # The AC records a point and syncs, still holding the T0 squad.
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0,
                                          scores={"team": 4, "opponent": 2},
                                          points=[{"i": i} for i in range(6)]))

        cur = get_game_current(gid)
        assert [p["name"] for p in cur["rosterSnapshot"]["players"]] == ["Alice", "Bob", "Eve"]
        assert cur["rosterSnapshot"]["capturedAt"] == self.T1
        assert (cur["team"], cur["opponent"], cur["scrimmageName"]) == ("Red", "Blue", "Tuesday")
        assert cur["scores"] == {"team": 4, "opponent": 2}
        assert len(cur["points"]) == 6

    def test_authoritative_sync_with_the_same_stamp_is_the_writers_copy(self, isolate_test_data):
        """Equal stamps: the writer's own snapshot stands (a player added
        mid-game by the Active Coach rides their sync as it always has)."""
        from storage.game_storage import save_game_version, get_game_current

        gid = "squad-merge-002"
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0))
        save_game_version(gid, self._half(["Alice", "Bob", "Zoe"], self.T0))

        assert [p["name"] for p in get_game_current(gid)["rosterSnapshot"]["players"]] == ["Alice", "Bob", "Zoe"]

    def test_non_authoritative_sync_carries_a_newer_squad_but_no_play_data(self, isolate_test_data):
        """A Line Coach who edited the squads offline: their sync applies the
        newer squad definition and nothing else of theirs."""
        from storage.game_storage import save_game_version, get_game_current

        gid = "squad-merge-003"
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0))
        save_game_version(gid, self._half(["Alice", "Eve"], self.T1, team="Red", opponent="Blue",
                                          scores={"team": 0, "opponent": 0}, points=[]),
                          authoritative_game_data=False)

        cur = get_game_current(gid)
        assert [p["name"] for p in cur["rosterSnapshot"]["players"]] == ["Alice", "Eve"]
        assert (cur["team"], cur["opponent"]) == ("Red", "Blue")
        assert cur["scores"] == {"team": 3, "opponent": 2}
        assert len(cur["points"]) == 5

    def test_non_authoritative_sync_with_a_stale_snapshot_changes_nothing(self, isolate_test_data):
        from storage.game_storage import save_game_version, get_game_current

        gid = "squad-merge-004"
        save_game_version(gid, self._half(["Alice", "Eve"], self.T1, team="Red", opponent="Blue"))
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0),
                          authoritative_game_data=False)

        cur = get_game_current(gid)
        assert [p["name"] for p in cur["rosterSnapshot"]["players"]] == ["Alice", "Eve"]
        assert (cur["team"], cur["opponent"]) == ("Red", "Blue")

    def test_a_real_game_keeps_a_newer_snapshot_but_never_its_names(self, isolate_test_data):
        """Outside a scrimmage the rule is inert in practice (a real game's
        snapshot is never rewritten); should a newer one ever land, team and
        opponent are not the snapshot's to carry."""
        from storage.game_storage import save_game_version, get_game_current

        gid = "squad-merge-005"
        save_game_version(gid, self._half(["Alice"], self.T1, scrimmageId=None, scrimmageSquad=None,
                                          team="Us", opponent="Them"))
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0, scrimmageId=None, scrimmageSquad=None,
                                          team="Us renamed", opponent="Them"))

        cur = get_game_current(gid)
        assert [p["name"] for p in cur["rosterSnapshot"]["players"]] == ["Alice"]
        assert cur["team"] == "Us renamed"

    def test_unstamped_snapshots_leave_the_writer_in_charge(self, isolate_test_data):
        from storage.game_storage import save_game_version, get_game_current

        gid = "squad-merge-006"
        first = self._half(["Alice"], self.T1)
        del first["rosterSnapshot"]["capturedAt"]
        save_game_version(gid, first)
        save_game_version(gid, self._half(["Bob"], self.T0))
        assert [p["name"] for p in get_game_current(gid)["rosterSnapshot"]["players"]] == ["Bob"]

        save_game_version(gid, dict(self._half(["Eve"], self.T0), rosterSnapshot=None))
        assert get_game_current(gid)["rosterSnapshot"] is None

    def test_restore_writes_the_snapshot_verbatim(self, isolate_test_data):
        """merge_pending_lines=False is a faithful rollback: no squad merge."""
        from storage.game_storage import save_game_version, get_game_current

        gid = "squad-merge-007"
        save_game_version(gid, self._half(["Alice", "Eve"], self.T1))
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0), merge_pending_lines=False)
        assert [p["name"] for p in get_game_current(gid)["rosterSnapshot"]["players"]] == ["Alice", "Bob"]

    def test_update_squad_definition_bumps_a_stamp_that_is_not_newer(self, isolate_test_data):
        """A PATCH stamped at or before the stored snapshot (a phone whose
        clock runs behind) lands with a stamp just past the stored one, so the
        merge above cannot put the old squad back; the caller gets the stored
        definition, stamp included."""
        from storage.game_storage import save_game_version, get_game_current, update_squad_definition

        gid = "squad-patch-001"
        save_game_version(gid, self._half(["Alice", "Bob"], self.T1))
        stored = update_squad_definition(gid, {
            "rosterSnapshot": self._snapshot(["Alice", "Eve"], self.T0),
        })

        cur = get_game_current(gid)
        assert [p["name"] for p in cur["rosterSnapshot"]["players"]] == ["Alice", "Eve"]
        assert cur["rosterSnapshot"]["capturedAt"] == "2026-09-29T18:10:00.001Z"
        assert stored["rosterSnapshot"] == cur["rosterSnapshot"]
        assert (stored["team"], stored["opponent"], stored["scrimmageName"]) == ("Dark", "Light", None)
        # No version backup: metadata, like /phase.
        assert len(list((isolate_test_data / "games" / gid / "versions").glob("*.json"))) == 1

    def test_update_squad_definition_keeps_a_newer_stamp_as_sent(self, isolate_test_data):
        from storage.game_storage import save_game_version, update_squad_definition

        gid = "squad-patch-002"
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0))
        stored = update_squad_definition(gid, {"rosterSnapshot": self._snapshot(["Alice"], self.T1),
                                               "scrimmageName": "Tuesday"})
        assert stored["rosterSnapshot"]["capturedAt"] == self.T1
        assert stored["scrimmageName"] == "Tuesday"

    def test_update_squad_definition_reindexes_the_players(self, isolate_test_data):
        """The player index (get_player_games) follows the new squad."""
        from storage.game_storage import save_game_version, update_squad_definition
        from storage.index_storage import rebuild_index, get_player_games

        gid = "squad-patch-003"
        save_game_version(gid, self._half(["Alice", "Bob"], self.T0))
        rebuild_index()
        update_squad_definition(gid, {"rosterSnapshot": self._snapshot(["Alice", "Eve"], self.T1)})
        assert gid in get_player_games("Eve-0001")

    def test_update_squad_definition_unknown_game(self, isolate_test_data):
        from storage.game_storage import update_squad_definition
        with pytest.raises(FileNotFoundError):
            update_squad_definition("no-such-game", {"scrimmageName": "x"})


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
    
    def test_update_index_for_game_null_roster_snapshot(self, isolate_test_data):
        """Regression: clients may send rosterSnapshot: null for legacy games.

        This used to raise AttributeError ('NoneType' has no attribute 'get')
        and 500 the sync endpoint. Player IDs should still be extracted from
        points as the fallback.
        """
        from storage.index_storage import (
            rebuild_index, update_index_for_game, get_team_games, get_game_players
        )

        rebuild_index()

        update_index_for_game("null-roster-game", {
            "teamId": "NullTeam-test",
            "rosterSnapshot": None,
            "points": [{
                "players": ["PointPlayer-test"],
                "possessions": [{"events": [{"throwerId": "Thrower-test"}]}]
            }]
        })

        assert "null-roster-game" in get_team_games("NullTeam-test")
        game_players = get_game_players("null-roster-game")
        assert "PointPlayer-test" in game_players
        assert "Thrower-test" in game_players

    def test_update_index_for_game_null_nested_fields(self, isolate_test_data):
        """Regression: explicit nulls for points/players/possessions/events must not crash."""
        from storage.index_storage import rebuild_index, update_index_for_game, get_team_games

        rebuild_index()

        update_index_for_game("null-fields-game", {
            "teamId": "NullFieldsTeam-test",
            "rosterSnapshot": {"players": None},
            "points": [
                {"players": None, "possessions": None},
                {"players": [], "possessions": [{"events": None}]},
            ]
        })
        update_index_for_game("null-points-game", {
            "teamId": "NullFieldsTeam-test",
            "rosterSnapshot": None,
            "points": None
        })

        team_games = get_team_games("NullFieldsTeam-test")
        assert "null-fields-game" in team_games
        assert "null-points-game" in team_games

    def test_rebuild_index_null_roster_snapshot(self, isolate_test_data):
        """Regression: a stored game with rosterSnapshot: null must not break rebuild."""
        from storage.game_storage import save_game_version
        from storage.index_storage import rebuild_index, get_team_games, get_game_players

        save_game_version("null-roster-rebuild", {
            "team": "NullTeam",
            "opponent": "Opp",
            "teamId": "NullTeam-test",
            "rosterSnapshot": None,
            "points": [{
                "players": ["PointPlayer-test"],
                "possessions": None
            }]
        })

        rebuild_index()

        assert "null-roster-rebuild" in get_team_games("NullTeam-test")
        assert "PointPlayer-test" in get_game_players("null-roster-rebuild")

    def test_update_index_for_team_null_player_ids(self, isolate_test_data):
        """Regression: playerIds: null must not crash the team index update."""
        from storage.index_storage import rebuild_index, update_index_for_team

        rebuild_index()

        # Should simply be a no-op, not raise
        update_index_for_team("NullPlayersTeam-test", {"playerIds": None})

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


# =============================================================================
# Multi-Coach Sync Merge Tests
# =============================================================================

class TestPendingLineMerge:
    """Regression tests for the field-merge that protects concurrent coaches
    from clobbering each other's line / game-data edits.
    """

    def _pnl(self, **fields):
        """Build a pendingNextLine dict with the standard empty defaults."""
        base = {"oLine": [], "dLine": [], "odLine": [], "odOnDeckLine": [],
                "oLineModifiedAt": None, "dLineModifiedAt": None,
                "odLineModifiedAt": None, "odOnDeckLineModifiedAt": None}
        base.update(fields)
        return base

    def test_per_field_merge_keeps_newer_line_edit(self, isolate_test_data):
        """A stale full-sync (older oLineModifiedAt) must NOT clobber a newer
        oLine edit already on the server — the bug a Line Coach hit when the
        Active Coach kept syncing mid-point with their old line snapshot.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-line-001"
        # Server already has the Line Coach's freshly-prepared O line.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    oLine=["A", "B", "C", "D", "E", "F", "X"],
                                    oLineModifiedAt="2026-05-24T18:01:00.000Z")})
        # Active Coach now syncs with their stale (empty) oLine copy.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl()})

        pnl = get_game_current(gid)["pendingNextLine"]
        assert pnl["oLine"] == ["A", "B", "C", "D", "E", "F", "X"]
        assert pnl["oLineModifiedAt"] == "2026-05-24T18:01:00.000Z"

    def test_on_deck_line_not_clobbered_by_stale_sync(self, isolate_test_data):
        """The On Deck line (odOnDeckLine) merges per-axis like the others: a
        stale full-sync must not clobber a newer On Deck edit on the server.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-ondeck-001"
        # Line Coach has prepared the point-after-next On Deck line.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    odOnDeckLine=["A", "B", "C", "D", "E", "F", "X"],
                                    odOnDeckLineModifiedAt="2026-05-24T18:01:00.000Z")})
        # Active Coach syncs with their stale (empty) On Deck copy.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl()})

        pnl = get_game_current(gid)["pendingNextLine"]
        assert pnl["odOnDeckLine"] == ["A", "B", "C", "D", "E", "F", "X"]
        assert pnl["odOnDeckLineModifiedAt"] == "2026-05-24T18:01:00.000Z"

    def test_on_deck_line_merges_independently_of_other_axes(self, isolate_test_data):
        """An On Deck edit and a separate odLine edit don't overwrite each
        other — each axis carries its own timestamp.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-ondeck-002"
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    odLine=["O1"],
                                    odLineModifiedAt="2026-05-24T18:00:00.000Z")})
        # Newer On Deck edit; odLine edit is older and must be preserved.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    odOnDeckLine=["N1"],
                                    odOnDeckLineModifiedAt="2026-05-24T18:05:00.000Z")})

        pnl = get_game_current(gid)["pendingNextLine"]
        assert pnl["odOnDeckLine"] == ["N1"]
        assert pnl["odLine"] == ["O1"]

    def test_per_field_merge_takes_newer_line_edit(self, isolate_test_data):
        """The mirror case: an incoming line edit newer than the server's must
        be applied.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-line-002"
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    oLine=["A"],
                                    oLineModifiedAt="2026-05-24T18:00:00.000Z")})
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    oLine=["B"],
                                    oLineModifiedAt="2026-05-24T18:02:00.000Z")})

        pnl = get_game_current(gid)["pendingNextLine"]
        assert pnl["oLine"] == ["B"]

    def test_o_d_and_od_lines_merge_independently(self, isolate_test_data):
        """O / D / O-D lines have independent timestamps; an edit to one must
        not regress the others.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-line-003"
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    oLine=["O1"], oLineModifiedAt="2026-05-24T18:00:00.000Z",
                                    dLine=["D1"], dLineModifiedAt="2026-05-24T18:00:00.000Z",
                                    odLine=["OD1"], odLineModifiedAt="2026-05-24T18:00:00.000Z")})
        # Edit only D line; O and OD lines are absent (None timestamps).
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    dLine=["D2"], dLineModifiedAt="2026-05-24T18:05:00.000Z")})

        pnl = get_game_current(gid)["pendingNextLine"]
        assert pnl["dLine"] == ["D2"]
        assert pnl["oLine"] == ["O1"]
        assert pnl["odLine"] == ["OD1"]

    def test_non_authoritative_writer_preserves_game_data(self, isolate_test_data):
        """A non-authoritative writer (e.g. a Line Coach) must NOT roll back
        the play data — only their line edits land.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-auth-001"
        # Active Coach has recorded 9 points / 6-3.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "scores": {"team": 6, "opponent": 3},
                                "points": [{"i": i} for i in range(9)],
                                "pendingNextLine": self._pnl()})
        # Line Coach syncs a stale 8-point / 5-3 snapshot WITH a line edit.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "scores": {"team": 5, "opponent": 3},
                                "points": [{"i": i} for i in range(8)],
                                "pendingNextLine": self._pnl(
                                    dLine=["A", "B", "C", "D", "E", "F", "G"],
                                    dLineModifiedAt="2026-05-24T18:05:00.000Z")},
                           authoritative_game_data=False)

        cur = get_game_current(gid)
        assert cur["scores"] == {"team": 6, "opponent": 3}
        assert len(cur["points"]) == 9
        # Line edit still propagated.
        assert cur["pendingNextLine"]["dLine"] == ["A", "B", "C", "D", "E", "F", "G"]

    def test_authoritative_writer_can_reduce_points(self, isolate_test_data):
        """The authoritative writer (Active Coach) must be able to legitimately
        reduce point count — undo must not be blocked.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-auth-002"
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "scores": {"team": 6, "opponent": 3},
                                "points": [{"i": i} for i in range(9)]})
        # Authoritative undo: 9 -> 8 points.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "scores": {"team": 5, "opponent": 3},
                                "points": [{"i": i} for i in range(8)]},
                           authoritative_game_data=True)

        cur = get_game_current(gid)
        assert cur["scores"] == {"team": 5, "opponent": 3}
        assert len(cur["points"]) == 8

    # ---------------------------------------------------------------------
    # LC-viewing signal (lineCoachViewing / lineCoachViewingAt). Drives
    # Priority 1 of the Intent Rule and the AC's "Line Coach: viewing the
    # X line" sub-label.
    # ---------------------------------------------------------------------

    def test_line_coach_viewing_merges_independently(self, isolate_test_data):
        """lineCoachViewing has its own timestamp and merges independently
        of the line-edit and Lineup Ready timestamps.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-viewing-001"
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    lineCoachViewing="o",
                                    lineCoachViewingAt="2026-05-24T18:00:00.000Z")})
        # LC switches view; newer lineCoachViewingAt wins.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    lineCoachViewing="d",
                                    lineCoachViewingAt="2026-05-24T18:05:00.000Z")})

        pnl = get_game_current(gid)["pendingNextLine"]
        assert pnl["lineCoachViewing"] == "d"
        assert pnl["lineCoachViewingAt"] == "2026-05-24T18:05:00.000Z"

    def test_stale_line_coach_viewing_does_not_clobber(self, isolate_test_data):
        """A stale lineCoachViewing write (e.g. an out-of-order sync from a
        device with a slow connection) must NOT roll back a newer view value.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-viewing-002"
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    lineCoachViewing="od",
                                    lineCoachViewingAt="2026-05-24T18:05:00.000Z")})
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    lineCoachViewing="d",
                                    lineCoachViewingAt="2026-05-24T18:00:00.000Z")})

        pnl = get_game_current(gid)["pendingNextLine"]
        assert pnl["lineCoachViewing"] == "od"
        assert pnl["lineCoachViewingAt"] == "2026-05-24T18:05:00.000Z"

    def test_viewing_and_ready_merge_independently(self, isolate_test_data):
        """lineCoachViewingAt and lineupReadyAt have separate timestamps;
        advancing one must not affect the other.
        """
        from storage.game_storage import save_game_version, get_game_current

        gid = "merge-viewing-003"
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    lineupReadyAt=1716576060000,
                                    lineupReadyBy="Coach A",
                                    lineCoachViewing="d",
                                    lineCoachViewingAt="2026-05-24T18:00:00.000Z")})
        # LC switches view to "o" but does NOT re-press Ready.
        save_game_version(gid, {"team": "T", "opponent": "O",
                                "pendingNextLine": self._pnl(
                                    lineCoachViewing="o",
                                    lineCoachViewingAt="2026-05-24T18:05:00.000Z")})

        pnl = get_game_current(gid)["pendingNextLine"]
        # Viewing advanced.
        assert pnl["lineCoachViewing"] == "o"
        # Ready ping unchanged.
        assert pnl["lineupReadyAt"] == 1716576060000
        assert pnl["lineupReadyBy"] == "Coach A"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


class TestGameEndMerge:
    """An end, once recorded, sticks (_adopt_game_end): the team card's End
    Scrimmage stamps a game the tracking coach is still syncing, and a Line
    Coach's End Game rides a sync the merge otherwise ignores."""

    def _game(self, **fields):
        base = {"team": "Dark", "opponent": "Light", "teamId": "Team-0001",
                "scores": {"team": 3, "opponent": 2}, "points": [{"i": i} for i in range(5)]}
        base.update(fields)
        return base

    def test_end_game_stamps_once_and_keeps_the_first_stamp(self, isolate_test_data):
        from storage.game_storage import save_game_version, get_game_current, end_game, list_game_versions

        gid = "end-merge-001"
        save_game_version(gid, self._game())
        assert end_game(gid, "2026-09-28T20:15:00.000Z") == "2026-09-28T20:15:00.000Z"
        assert end_game(gid, "2026-09-28T20:15:09.000Z") == "2026-09-28T20:15:00.000Z"
        assert get_game_current(gid)["gameEndTimestamp"] == "2026-09-28T20:15:00.000Z"
        assert len(list_game_versions(gid)) == 1     # metadata: no backup written

    def test_end_game_on_a_missing_game_raises(self, isolate_test_data):
        from storage.game_storage import end_game
        with pytest.raises(FileNotFoundError):
            end_game("no-such-game", "2026-09-28T20:15:00.000Z")

    def test_authoritative_sync_without_the_end_keeps_it(self, isolate_test_data):
        from storage.game_storage import save_game_version, get_game_current, end_game

        gid = "end-merge-002"
        save_game_version(gid, self._game())
        end_game(gid, "2026-09-28T20:15:00.000Z")
        save_game_version(gid, self._game(gameEndTimestamp=None, scores={"team": 4, "opponent": 2}))

        cur = get_game_current(gid)
        assert cur["gameEndTimestamp"] == "2026-09-28T20:15:00.000Z"
        assert cur["scores"] == {"team": 4, "opponent": 2}

    def test_a_writers_own_end_stands_and_an_earlier_one_is_not_overridden(self, isolate_test_data):
        from storage.game_storage import save_game_version, get_game_current

        gid = "end-merge-003"
        save_game_version(gid, self._game())
        save_game_version(gid, self._game(gameEndTimestamp="2026-09-28T20:30:00.000Z"))
        assert get_game_current(gid)["gameEndTimestamp"] == "2026-09-28T20:30:00.000Z"
        # An authoritative writer carrying a different stamp keeps its own:
        # the rule only fills a missing one.
        save_game_version(gid, self._game(gameEndTimestamp="2026-09-28T20:31:00.000Z"))
        assert get_game_current(gid)["gameEndTimestamp"] == "2026-09-28T20:31:00.000Z"

    def test_non_authoritative_sync_carries_an_end_but_no_play_data(self, isolate_test_data):
        from storage.game_storage import save_game_version, get_game_current

        gid = "end-merge-004"
        save_game_version(gid, self._game())
        save_game_version(gid, self._game(gameEndTimestamp="2026-09-28T20:40:00.000Z",
                                          scores={"team": 0, "opponent": 0}, points=[]),
                          authoritative_game_data=False)

        cur = get_game_current(gid)
        assert cur["gameEndTimestamp"] == "2026-09-28T20:40:00.000Z"
        assert cur["scores"] == {"team": 3, "opponent": 2}
        assert len(cur["points"]) == 5

    def test_a_restore_is_verbatim(self, isolate_test_data):
        """merge_pending_lines=False (version restore) writes the snapshot as
        it was, ended or not — a rollback must be faithful."""
        from storage.game_storage import save_game_version, get_game_current, end_game

        gid = "end-merge-005"
        save_game_version(gid, self._game())
        end_game(gid, "2026-09-28T20:15:00.000Z")
        save_game_version(gid, self._game(), merge_pending_lines=False)
        assert get_game_current(gid).get("gameEndTimestamp") is None
