"""
Integration tests for API endpoints.

Run with: cd ultistats_server && python -m pytest test_api.py -v
"""
import pytest
import json
import tempfile
import shutil
from pathlib import Path
from fastapi.testclient import TestClient

# Create test data directory
_test_data_dir = None


@pytest.fixture(scope="module")
def test_data_dir():
    """Create a temporary data directory for tests."""
    global _test_data_dir
    _test_data_dir = tempfile.mkdtemp(prefix="ultistats_api_test_")
    yield Path(_test_data_dir)
    
    # Cleanup
    if _test_data_dir and Path(_test_data_dir).exists():
        shutil.rmtree(_test_data_dir)


@pytest.fixture(scope="module")
def client(test_data_dir):
    """Create a test client with patched data directory."""
    # Patch config before importing app
    import config
    config.DATA_DIR = test_data_dir
    config.GAMES_DIR = test_data_dir / "games"
    config.TEAMS_DIR = test_data_dir / "teams"
    config.PLAYERS_DIR = test_data_dir / "players"
    config.INDEX_FILE = test_data_dir / "index.json"
    
    # Create directories
    config.GAMES_DIR.mkdir(parents=True, exist_ok=True)
    config.TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    config.PLAYERS_DIR.mkdir(parents=True, exist_ok=True)
    
    from main import app
    return TestClient(app)


# =============================================================================
# Health & Info Endpoints
# =============================================================================

class TestHealthEndpoints:
    """Tests for health and info endpoints."""
    
    def test_health_endpoint(self, client):
        """Test health check returns healthy."""
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "healthy"
    
    def test_api_info_endpoint(self, client):
        """Test API info endpoint."""
        response = client.get("/api")
        assert response.status_code == 200
        data = response.json()
        assert "version" in data
        assert data["status"] == "running"


# =============================================================================
# Player API Tests
# =============================================================================

class TestPlayerAPI:
    """Tests for player API endpoints."""
    
    def test_create_player(self, client):
        """Test POST /players creates a new player."""
        response = client.post("/api/players", json={
            "name": "TestPlayer",
            "gender": "MMP",
            "number": "7"
        })
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "created"
        assert "player_id" in data
        assert data["player"]["name"] == "TestPlayer"
    
    def test_create_player_with_id(self, client):
        """Test creating a player with a specific ID (offline creation)."""
        response = client.post("/api/players", json={
            "id": "OfflinePlayer-abc1",
            "name": "OfflinePlayer",
            "gender": "FMP"
        })
        
        assert response.status_code == 200
        data = response.json()
        assert data["player_id"] == "OfflinePlayer-abc1"
    
    def test_create_player_without_name_fails(self, client):
        """Test that creating a player without a name returns 400."""
        response = client.post("/api/players", json={
            "gender": "MMP"
        })
        
        assert response.status_code == 400
        assert "name" in response.json()["detail"].lower()
    
    def test_get_player(self, client):
        """Test GET /players/{player_id} returns player data."""
        # First create a player
        create_response = client.post("/api/players", json={
            "name": "GetTestPlayer",
            "nickname": "GTP"
        })
        player_id = create_response.json()["player_id"]
        
        # Then get it
        response = client.get(f"/players/{player_id}")
        
        assert response.status_code == 200
        assert response.json()["name"] == "GetTestPlayer"
        assert response.json()["nickname"] == "GTP"
    
    def test_get_player_not_found(self, client):
        """Test that getting a non-existent player returns 404."""
        response = client.get("/players/NonExistent-9999")
        
        assert response.status_code == 404
    
    def test_list_players(self, client):
        """Test GET /players returns list of players."""
        # Create a few players
        client.post("/api/players", json={"name": "ListPlayer1"})
        client.post("/api/players", json={"name": "ListPlayer2"})
        
        response = client.get("/api/players")
        
        assert response.status_code == 200
        data = response.json()
        assert "players" in data
        assert "count" in data
        assert data["count"] >= 2
    
    def test_update_player(self, client):
        """Test PUT /players/{player_id} updates player data."""
        # Create player
        create_response = client.post("/api/players", json={"name": "UpdateMe"})
        player_id = create_response.json()["player_id"]
        
        # Update
        response = client.put(f"/players/{player_id}", json={
            "name": "Updated",
            "number": "42"
        })
        
        assert response.status_code == 200
        assert response.json()["player"]["name"] == "Updated"
        assert response.json()["player"]["number"] == "42"
    
    def test_delete_player(self, client):
        """Test DELETE /players/{player_id} removes player."""
        # Create player
        create_response = client.post("/api/players", json={"name": "DeleteMe"})
        player_id = create_response.json()["player_id"]
        
        # Delete
        response = client.delete(f"/players/{player_id}")
        
        assert response.status_code == 200
        assert response.json()["status"] == "deleted"
        
        # Verify it's gone
        get_response = client.get(f"/players/{player_id}")
        assert get_response.status_code == 404
    
    def test_get_player_games(self, client):
        """Test GET /players/{player_id}/games returns player's games."""
        # Create player
        create_response = client.post("/api/players", json={
            "id": "GamePlayer-test",
            "name": "GamePlayer"
        })
        player_id = create_response.json()["player_id"]
        
        # Create a game with this player
        client.post("/games/test-player-game/sync", json={
            "team": "TestTeam",
            "opponent": "Opponent",
            "teamId": "TestTeam-1234",
            "rosterSnapshot": {
                "players": [{"id": player_id, "name": "GamePlayer"}]
            },
            "points": []
        })
        
        # Rebuild index
        client.post("/index/rebuild")
        
        # Get player's games
        response = client.get(f"/players/{player_id}/games")
        
        assert response.status_code == 200
        data = response.json()
        assert "game_ids" in data
        assert "test-player-game" in data["game_ids"]


# =============================================================================
# Team API Tests
# =============================================================================

class TestTeamAPI:
    """Tests for team API endpoints."""
    
    def test_create_team(self, client):
        """Test POST /teams creates a new team."""
        response = client.post("/api/teams", json={
            "name": "TestTeam",
            "playerIds": []
        })
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "created"
        assert "team_id" in data
        assert data["team"]["name"] == "TestTeam"
    
    def test_create_team_with_id(self, client):
        """Test creating a team with a specific ID (offline creation)."""
        response = client.post("/api/teams", json={
            "id": "OfflineTeam-xyz9",
            "name": "OfflineTeam"
        })
        
        assert response.status_code == 200
        data = response.json()
        assert data["team_id"] == "OfflineTeam-xyz9"
    
    def test_create_team_without_name_fails(self, client):
        """Test that creating a team without a name returns 400."""
        response = client.post("/api/teams", json={
            "playerIds": []
        })
        
        assert response.status_code == 400
        assert "name" in response.json()["detail"].lower()
    
    def test_get_team(self, client):
        """Test GET /teams/{team_id} returns team data."""
        create_response = client.post("/api/teams", json={"name": "GetTestTeam"})
        team_id = create_response.json()["team_id"]
        
        response = client.get(f"/teams/{team_id}")
        
        assert response.status_code == 200
        assert response.json()["name"] == "GetTestTeam"
    
    def test_get_team_not_found(self, client):
        """Test that getting a non-existent team returns 404."""
        response = client.get("/teams/NonExistent-9999")
        
        assert response.status_code == 404
    
    def test_list_teams(self, client):
        """Test GET /teams returns list of teams."""
        client.post("/api/teams", json={"name": "ListTeam1"})
        client.post("/api/teams", json={"name": "ListTeam2"})
        
        response = client.get("/api/teams")
        
        assert response.status_code == 200
        data = response.json()
        assert "teams" in data
        assert "count" in data
        assert data["count"] >= 2
    
    def test_update_team(self, client):
        """Test PUT /teams/{team_id} updates team data."""
        create_response = client.post("/api/teams", json={"name": "UpdateTeam"})
        team_id = create_response.json()["team_id"]
        
        response = client.put(f"/teams/{team_id}", json={
            "name": "UpdatedTeam",
            "playerIds": ["Player-1234"]
        })
        
        assert response.status_code == 200
        assert response.json()["team"]["name"] == "UpdatedTeam"
        assert response.json()["team"]["playerIds"] == ["Player-1234"]
    
    def test_delete_team(self, client):
        """Test DELETE /teams/{team_id} removes team."""
        create_response = client.post("/api/teams", json={"name": "DeleteTeam"})
        team_id = create_response.json()["team_id"]
        
        response = client.delete(f"/teams/{team_id}")
        
        assert response.status_code == 200
        assert response.json()["status"] == "deleted"
        
        get_response = client.get(f"/teams/{team_id}")
        assert get_response.status_code == 404
    
    def test_get_team_players(self, client):
        """Test GET /teams/{team_id}/players returns resolved players."""
        # Create players first
        p1 = client.post("/api/players", json={"id": "TeamP1-test", "name": "Player1"})
        p2 = client.post("/api/players", json={"id": "TeamP2-test", "name": "Player2"})
        
        # Create team with players
        team_response = client.post("/api/teams", json={
            "name": "PlayersTeam",
            "playerIds": ["TeamP1-test", "TeamP2-test"]
        })
        team_id = team_response.json()["team_id"]
        
        # Get team players
        response = client.get(f"/teams/{team_id}/players")
        
        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 2
        names = [p["name"] for p in data["players"]]
        assert "Player1" in names
        assert "Player2" in names
    
    def test_get_team_games(self, client):
        """Test GET /teams/{team_id}/games returns team's games."""
        # Create team
        team_response = client.post("/api/teams", json={
            "id": "GamesTeam-test",
            "name": "GamesTeam"
        })
        team_id = team_response.json()["team_id"]
        
        # Create game for this team
        client.post("/games/team-test-game/sync", json={
            "team": "GamesTeam",
            "opponent": "Opponent",
            "teamId": team_id,
            "points": []
        })
        
        # Rebuild index
        client.post("/index/rebuild")
        
        # Get team's games
        response = client.get(f"/teams/{team_id}/games")
        
        assert response.status_code == 200
        assert "team-test-game" in response.json()["game_ids"]


# =============================================================================
# Game API Tests
# =============================================================================

class TestGameAPI:
    """Tests for game API endpoints."""
    
    def test_sync_game(self, client):
        """Test POST /games/{game_id}/sync creates/updates game."""
        response = client.post("/games/api-test-game/sync", json={
            "team": "TestTeam",
            "opponent": "Opponent",
            "scores": {"team": 0, "opponent": 0},
            "points": []
        })
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "synced"
        assert data["game_id"] == "api-test-game"
        assert "version" in data
    
    def test_sync_game_without_team_fails(self, client):
        """Test that syncing without team returns 400."""
        response = client.post("/games/invalid-game/sync", json={
            "opponent": "Opponent"
        })
        
        assert response.status_code == 400
    
    def test_get_game(self, client):
        """Test GET /games/{game_id} returns game data."""
        # Create game first
        client.post("/games/get-test-game/sync", json={
            "team": "GetTeam",
            "opponent": "GetOpponent",
            "points": []
        })
        
        response = client.get("/games/get-test-game")
        
        assert response.status_code == 200
        assert response.json()["team"] == "GetTeam"
        assert response.json()["opponent"] == "GetOpponent"
    
    def test_get_game_not_found(self, client):
        """Test that getting a non-existent game returns 404."""
        response = client.get("/games/nonexistent-game")
        
        assert response.status_code == 404
    
    def test_list_games(self, client):
        """Test GET /games returns list of games."""
        client.post("/games/list-game-1/sync", json={
            "team": "ListTeam",
            "opponent": "Opp1",
            "points": []
        })
        
        response = client.get("/api/games")
        
        assert response.status_code == 200
        data = response.json()
        assert "games" in data
        assert len(data["games"]) >= 1
    
    def test_delete_game(self, client):
        """Test DELETE /games/{game_id} removes game."""
        client.post("/games/delete-test-game/sync", json={
            "team": "DeleteTeam",
            "opponent": "Opponent",
            "points": []
        })
        
        response = client.delete("/games/delete-test-game")
        
        assert response.status_code == 200
        assert response.json()["status"] == "deleted"
        
        get_response = client.get("/games/delete-test-game")
        assert get_response.status_code == 404
    
    def test_list_game_versions(self, client):
        """Test GET /games/{game_id}/versions returns version list."""
        client.post("/games/version-test-game/sync", json={
            "team": "VersionTeam",
            "opponent": "Opponent",
            "points": []
        })
        
        response = client.get("/games/version-test-game/versions")
        
        assert response.status_code == 200
        data = response.json()
        assert "versions" in data
        assert len(data["versions"]) >= 1
    
    def test_get_specific_version(self, client):
        """Test GET /games/{game_id}/versions/{timestamp} returns specific version."""
        # Create game
        client.post("/games/specific-version-game/sync", json={
            "team": "VersionTeam",
            "opponent": "Opponent",
            "version": 1
        })
        
        # Get version list
        versions_response = client.get("/games/specific-version-game/versions")
        timestamp = versions_response.json()["versions"][0]
        
        # Get specific version
        response = client.get(f"/games/specific-version-game/versions/{timestamp}")
        
        assert response.status_code == 200
        assert response.json()["version"] == 1


# =============================================================================
# Index API Tests
# =============================================================================

class TestIndexAPI:
    """Tests for index API endpoints."""
    
    def test_rebuild_index(self, client):
        """Test POST /index/rebuild rebuilds the index."""
        response = client.post("/index/rebuild")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "rebuilt"
        assert "lastRebuilt" in data
    
    def test_get_index_status(self, client):
        """Test GET /index/status returns index stats."""
        # First rebuild to ensure index exists
        client.post("/index/rebuild")
        
        response = client.get("/index/status")
        
        assert response.status_code == 200
        data = response.json()
        assert "indexExists" in data
        assert "playerCount" in data
        assert "teamCount" in data
        assert "gameCount" in data


# =============================================================================
# Full Integration Workflow Tests
# =============================================================================

class TestAPIWorkflows:
    """Integration tests for complete API workflows."""
    
    def test_full_workflow_create_team_add_players_create_game(self, client):
        """Test complete workflow via API."""
        # 1. Create players
        p1 = client.post("/api/players", json={
            "id": "Workflow-P1",
            "name": "WorkflowPlayer1",
            "gender": "FMP"
        }).json()
        
        p2 = client.post("/api/players", json={
            "id": "Workflow-P2",
            "name": "WorkflowPlayer2",
            "gender": "MMP"
        }).json()
        
        # 2. Create team with players
        team = client.post("/api/teams", json={
            "id": "Workflow-Team",
            "name": "WorkflowTeam",
            "playerIds": [p1["player_id"], p2["player_id"]]
        }).json()
        
        # 3. Create game for the team
        game = client.post("/games/workflow-game/sync", json={
            "team": "WorkflowTeam",
            "opponent": "WorkflowOpponent",
            "teamId": team["team_id"],
            "rosterSnapshot": {
                "players": [
                    {"id": p1["player_id"], "name": "WorkflowPlayer1"},
                    {"id": p2["player_id"], "name": "WorkflowPlayer2"}
                ]
            },
            "points": [
                {
                    "pointNumber": 1,
                    "players": [p1["player_id"], p2["player_id"]]
                }
            ]
        }).json()
        
        # 4. Rebuild index
        client.post("/index/rebuild")
        
        # 5. Verify queries work
        # Player games
        p1_games = client.get(f"/players/{p1['player_id']}/games").json()
        assert "workflow-game" in p1_games["game_ids"]
        
        # Team games
        team_games = client.get(f"/teams/{team['team_id']}/games").json()
        assert "workflow-game" in team_games["game_ids"]
        
        # Team players
        team_players = client.get(f"/teams/{team['team_id']}/players").json()
        assert team_players["count"] == 2
        
        # Get game
        game_data = client.get("/games/workflow-game").json()
        assert game_data["teamId"] == team["team_id"]
    
    def test_offline_creation_sync(self, client):
        """Test offline-created entities sync correctly."""
        # Simulate offline creation with client-generated IDs
        offline_player_id = "Offline-Player-abcd"
        offline_team_id = "Offline-Team-efgh"
        
        # Player created offline, synced later
        player = client.post("/api/players", json={
            "id": offline_player_id,
            "name": "OfflineCreatedPlayer",
            "gender": "MMP"
        }).json()
        
        assert player["player_id"] == offline_player_id
        assert player["status"] == "created"
        
        # Team created offline, synced later
        team = client.post("/api/teams", json={
            "id": offline_team_id,
            "name": "OfflineCreatedTeam",
            "playerIds": [offline_player_id]
        }).json()
        
        assert team["team_id"] == offline_team_id
        assert team["status"] == "created"
        
        # Verify data persisted correctly
        player_data = client.get(f"/players/{offline_player_id}").json()
        assert player_data["name"] == "OfflineCreatedPlayer"
        
        team_data = client.get(f"/teams/{offline_team_id}").json()
        assert team_data["name"] == "OfflineCreatedTeam"
        assert offline_player_id in team_data["playerIds"]
    
    def test_update_existing_via_create_endpoint(self, client):
        """Test that creating with existing ID updates instead."""
        # Create initial
        client.post("/api/players", json={
            "id": "Update-Via-Create",
            "name": "Original"
        })
        
        # Create again with same ID
        response = client.post("/api/players", json={
            "id": "Update-Via-Create",
            "name": "Updated"
        })
        
        assert response.json()["status"] == "updated"
        
        # Verify update
        player = client.get("/players/Update-Via-Create").json()
        assert player["name"] == "Updated"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

