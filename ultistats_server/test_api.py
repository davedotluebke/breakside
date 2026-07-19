"""
Integration tests for API endpoints.

All data-plane routes live under the /api/ prefix (see routers/) — the
tests hit those exact paths. Only /health and the /api info endpoint are
unprefixed specials.

Run with: cd ultistats_server && python -m pytest test_api.py -v
"""
import pytest
import json
from fastapi.testclient import TestClient

MOCK_USER = {"id": "test-admin-user", "email": "admin@test.com", "role": "authenticated"}


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    """TestClient against an isolated temp data dir, with mock admin auth.

    Storage modules capture their dir constants at import time
    (``GAMES_DIR = config.GAMES_DIR`` — see storage/_config.py), so patching
    ``config.*`` alone does nothing once they're loaded: writes would land in
    the repo's real ``data/`` directory. Patch both config and each storage
    module's captured global, and restore everything (including
    ``app.dependency_overrides``) on teardown so later test modules see
    pristine state.
    """
    data_dir = tmp_path_factory.mktemp("api_test_data")

    import config
    from storage import (
        game_storage, team_storage, player_storage, user_storage,
        membership_storage, share_storage, invite_storage, index_storage,
    )

    patches = [
        (config, "DATA_DIR", data_dir),
        (config, "GAMES_DIR", data_dir / "games"),
        (config, "TEAMS_DIR", data_dir / "teams"),
        (config, "PLAYERS_DIR", data_dir / "players"),
        (config, "USERS_DIR", data_dir / "users"),
        (config, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (config, "SHARES_DIR", data_dir / "shares"),
        (config, "INVITES_DIR", data_dir / "invites"),
        (config, "INDEX_FILE", data_dir / "index.json"),
        (game_storage, "GAMES_DIR", data_dir / "games"),
        (team_storage, "TEAMS_DIR", data_dir / "teams"),
        (player_storage, "PLAYERS_DIR", data_dir / "players"),
        (user_storage, "USERS_DIR", data_dir / "users"),
        (membership_storage, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (membership_storage, "INDEX_FILE", data_dir / "memberships" / "_index.json"),
        (share_storage, "SHARES_DIR", data_dir / "shares"),
        (share_storage, "INDEX_FILE", data_dir / "shares" / "_index.json"),
        (invite_storage, "INVITES_DIR", data_dir / "invites"),
        (invite_storage, "INDEX_FILE", data_dir / "invites" / "_index.json"),
        (index_storage, "INDEX_FILE", data_dir / "index.json"),
        (index_storage, "GAMES_DIR", data_dir / "games"),
        (index_storage, "TEAMS_DIR", data_dir / "teams"),
        (index_storage, "PLAYERS_DIR", data_dir / "players"),
    ]
    saved = [(mod, name, getattr(mod, name)) for mod, name, _ in patches]
    for mod, name, value in patches:
        if name.endswith("_DIR"):
            value.mkdir(parents=True, exist_ok=True)
        setattr(mod, name, value)

    # Create admin user in storage so is_admin() returns True
    user_file = data_dir / "users" / f"{MOCK_USER['id']}.json"
    with open(user_file, 'w') as f:
        json.dump({"id": MOCK_USER["id"], "email": MOCK_USER["email"], "isAdmin": True}, f)

    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user

    # Override auth to return mock admin user
    app.dependency_overrides[get_current_user] = lambda: MOCK_USER
    app.dependency_overrides[get_optional_user] = lambda: MOCK_USER

    yield TestClient(app)

    app.dependency_overrides.clear()
    for mod, name, original in saved:
        setattr(mod, name, original)


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
        """Test POST /api/players creates a new player."""
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
        """Test GET /api/players/{player_id} returns player data."""
        # First create a player
        create_response = client.post("/api/players", json={
            "name": "GetTestPlayer",
            "nickname": "GTP"
        })
        player_id = create_response.json()["player_id"]
        
        # Then get it
        response = client.get(f"/api/players/{player_id}")
        
        assert response.status_code == 200
        assert response.json()["name"] == "GetTestPlayer"
        assert response.json()["nickname"] == "GTP"
    
    def test_get_player_not_found(self, client):
        """Test that getting a non-existent player returns 404."""
        response = client.get("/api/players/NonExistent-9999")
        
        assert response.status_code == 404
    
    def test_list_players(self, client):
        """Test GET /api/players returns list of players."""
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
        """Test PUT /api/players/{player_id} updates player data."""
        # Create player
        create_response = client.post("/api/players", json={"name": "UpdateMe"})
        player_id = create_response.json()["player_id"]
        
        # Update
        response = client.put(f"/api/players/{player_id}", json={
            "name": "Updated",
            "number": "42"
        })
        
        assert response.status_code == 200
        assert response.json()["player"]["name"] == "Updated"
        assert response.json()["player"]["number"] == "42"
    
    def test_delete_player(self, client):
        """Test DELETE /api/players/{player_id} removes player."""
        # Create player
        create_response = client.post("/api/players", json={"name": "DeleteMe"})
        player_id = create_response.json()["player_id"]
        
        # Delete
        response = client.delete(f"/api/players/{player_id}")
        
        assert response.status_code == 200
        assert response.json()["status"] == "deleted"
        
        # Verify it's gone
        get_response = client.get(f"/api/players/{player_id}")
        assert get_response.status_code == 404
    
    def test_get_player_games(self, client):
        """Test GET /api/players/{player_id}/games returns player's games."""
        # Create player
        create_response = client.post("/api/players", json={
            "id": "GamePlayer-test",
            "name": "GamePlayer"
        })
        player_id = create_response.json()["player_id"]
        
        # Create a game with this player
        client.post("/api/games/test-player-game/sync", json={
            "team": "TestTeam",
            "opponent": "Opponent",
            "teamId": "TestTeam-1234",
            "rosterSnapshot": {
                "players": [{"id": player_id, "name": "GamePlayer"}]
            },
            "points": []
        })
        
        # Rebuild index
        client.post("/api/index/rebuild")
        
        # Get player's games
        response = client.get(f"/api/players/{player_id}/games")
        
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
        """Test POST /api/teams creates a new team."""
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
        """Test GET /api/teams/{team_id} returns team data."""
        create_response = client.post("/api/teams", json={"name": "GetTestTeam"})
        team_id = create_response.json()["team_id"]
        
        response = client.get(f"/api/teams/{team_id}")
        
        assert response.status_code == 200
        assert response.json()["name"] == "GetTestTeam"
    
    def test_get_team_not_found(self, client):
        """Test that getting a non-existent team returns 404."""
        response = client.get("/api/teams/NonExistent-9999")
        
        assert response.status_code == 404
    
    def test_list_teams(self, client):
        """Test GET /api/teams returns list of teams."""
        client.post("/api/teams", json={"name": "ListTeam1"})
        client.post("/api/teams", json={"name": "ListTeam2"})
        
        response = client.get("/api/teams")
        
        assert response.status_code == 200
        data = response.json()
        assert "teams" in data
        assert "count" in data
        assert data["count"] >= 2
    
    def test_update_team(self, client):
        """Test PUT /api/teams/{team_id} updates team data."""
        create_response = client.post("/api/teams", json={"name": "UpdateTeam"})
        team_id = create_response.json()["team_id"]
        
        response = client.put(f"/api/teams/{team_id}", json={
            "name": "UpdatedTeam",
            "playerIds": ["Player-1234"]
        })
        
        assert response.status_code == 200
        assert response.json()["team"]["name"] == "UpdatedTeam"
        assert response.json()["team"]["playerIds"] == ["Player-1234"]
    
    def test_delete_team(self, client):
        """Test DELETE /api/teams/{team_id} removes team."""
        create_response = client.post("/api/teams", json={"name": "DeleteTeam"})
        team_id = create_response.json()["team_id"]
        
        response = client.delete(f"/api/teams/{team_id}")
        
        assert response.status_code == 200
        assert response.json()["status"] == "deleted"
        
        get_response = client.get(f"/api/teams/{team_id}")
        assert get_response.status_code == 404
    
    def test_get_team_players(self, client):
        """Test GET /api/teams/{team_id}/players returns resolved players."""
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
        response = client.get(f"/api/teams/{team_id}/players")
        
        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 2
        names = [p["name"] for p in data["players"]]
        assert "Player1" in names
        assert "Player2" in names
    
    def test_get_team_active_game_no_games(self, client):
        """Test GET /api/teams/{team_id}/active-game returns 404 when no games exist."""
        team_response = client.post("/api/teams", json={
            "id": "NoGames-Team",
            "name": "NoGamesTeam"
        })
        team_id = team_response.json()["team_id"]
        client.post("/api/index/rebuild")

        response = client.get(f"/api/teams/{team_id}/active-game")
        assert response.status_code == 404

    def test_get_team_active_game_ended_game(self, client):
        """Test GET /api/teams/{team_id}/active-game returns 404 when game has ended."""
        from datetime import datetime
        team_response = client.post("/api/teams", json={
            "id": "EndedGame-Team",
            "name": "EndedGameTeam"
        })
        team_id = team_response.json()["team_id"]
        now = datetime.now().isoformat()

        client.post("/api/games/ended-game-test/sync", json={
            "team": "EndedGameTeam",
            "opponent": "Opponent",
            "teamId": team_id,
            "gameStartTimestamp": now,
            "gameEndTimestamp": now,
            "points": [{"pointNumber": 1}]
        })
        client.post("/api/index/rebuild")

        response = client.get(f"/api/teams/{team_id}/active-game")
        assert response.status_code == 404

    def test_get_team_active_game_success(self, client):
        """Test GET /api/teams/{team_id}/active-game returns active game."""
        from datetime import datetime
        team_response = client.post("/api/teams", json={
            "id": "ActiveGame-Team",
            "name": "ActiveGameTeam"
        })
        team_id = team_response.json()["team_id"]
        now = datetime.now().isoformat()

        client.post("/api/games/active-game-test/sync", json={
            "team": "ActiveGameTeam",
            "opponent": "ActiveOpponent",
            "teamId": team_id,
            "gameStartTimestamp": now,
            "scores": {"team": 3, "opponent": 2},
            "points": [{"pointNumber": 1}, {"pointNumber": 2}]
        })
        client.post("/api/index/rebuild")

        response = client.get(f"/api/teams/{team_id}/active-game")
        assert response.status_code == 200
        data = response.json()
        assert data["game_id"] == "active-game-test"
        assert data["opponent"] == "ActiveOpponent"
        assert data["points_count"] == 2
        assert data["scores"] == {"team": 3, "opponent": 2}
        assert "activeCoaches" in data
        assert "lastActivity" in data

    def test_get_team_active_game_old_game(self, client):
        """Test GET /api/teams/{team_id}/active-game returns 404 for game older than 6 hours."""
        team_response = client.post("/api/teams", json={
            "id": "OldGame-Team",
            "name": "OldGameTeam"
        })
        team_id = team_response.json()["team_id"]
        old_ts = "2020-01-01T00:00:00"

        client.post("/api/games/old-game-test/sync", json={
            "team": "OldGameTeam",
            "opponent": "Opponent",
            "teamId": team_id,
            "gameStartTimestamp": old_ts,
            "points": [{"pointNumber": 1}]
        })
        client.post("/api/index/rebuild")

        response = client.get(f"/api/teams/{team_id}/active-game")
        assert response.status_code == 404

    def test_get_team_active_game_no_points(self, client):
        """Test GET /api/teams/{team_id}/active-game returns 404 when game has no points."""
        from datetime import datetime
        team_response = client.post("/api/teams", json={
            "id": "NoPoints-Team",
            "name": "NoPointsTeam"
        })
        team_id = team_response.json()["team_id"]
        now = datetime.now().isoformat()

        client.post("/api/games/no-points-game-test/sync", json={
            "team": "NoPointsTeam",
            "opponent": "Opponent",
            "teamId": team_id,
            "gameStartTimestamp": now,
            "points": []
        })
        client.post("/api/index/rebuild")

        response = client.get(f"/api/teams/{team_id}/active-game")
        assert response.status_code == 404

    def test_get_team_active_game_team_not_found(self, client):
        """Test GET /api/teams/{team_id}/active-game returns 404 for nonexistent team."""
        response = client.get("/api/teams/nonexistent-team-xyz/active-game")
        assert response.status_code == 404

    def test_get_team_games(self, client):
        """Test GET /api/teams/{team_id}/games returns team's games."""
        # Create team
        team_response = client.post("/api/teams", json={
            "id": "GamesTeam-test",
            "name": "GamesTeam"
        })
        team_id = team_response.json()["team_id"]
        
        # Create game for this team
        client.post("/api/games/team-test-game/sync", json={
            "team": "GamesTeam",
            "opponent": "Opponent",
            "teamId": team_id,
            "points": []
        })
        
        # Rebuild index
        client.post("/api/index/rebuild")
        
        # Get team's games
        response = client.get(f"/api/teams/{team_id}/games")
        
        assert response.status_code == 200
        assert "team-test-game" in response.json()["game_ids"]


# =============================================================================
# Game API Tests
# =============================================================================

class TestGameAPI:
    """Tests for game API endpoints."""
    
    def test_sync_game(self, client):
        """Test POST /api/games/{game_id}/sync creates/updates game."""
        response = client.post("/api/games/api-test-game/sync", json={
            "team": "TestTeam",
            "teamId": "SyncTeam-0001",
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
        """Test that syncing without team/teamId returns 400."""
        response = client.post("/api/games/invalid-game/sync", json={
            "opponent": "Opponent"
        })
        
        assert response.status_code == 400
    
    def test_get_game(self, client):
        """Test GET /api/games/{game_id} returns game data."""
        # Create game first
        client.post("/api/games/get-test-game/sync", json={
            "team": "GetTeam",
            "teamId": "GetTeam-0001",
            "opponent": "GetOpponent",
            "points": []
        })
        
        response = client.get("/api/games/get-test-game")
        
        assert response.status_code == 200
        assert response.json()["team"] == "GetTeam"
        assert response.json()["opponent"] == "GetOpponent"
    
    def test_get_game_not_found(self, client):
        """Test that getting a non-existent game returns 404."""
        response = client.get("/api/games/nonexistent-game")
        
        assert response.status_code == 404
    
    def test_list_games(self, client):
        """Test GET /api/games returns list of games."""
        client.post("/api/games/list-game-1/sync", json={
            "team": "ListTeam",
            "teamId": "ListTeam-0001",
            "opponent": "Opp1",
            "points": []
        })
        
        response = client.get("/api/games")
        
        assert response.status_code == 200
        data = response.json()
        assert "games" in data
        assert len(data["games"]) >= 1
    
    def test_delete_game(self, client):
        """Test DELETE /api/games/{game_id} removes game."""
        client.post("/api/games/delete-test-game/sync", json={
            "team": "DeleteTeam",
            "teamId": "DeleteTeam-0001",
            "opponent": "Opponent",
            "points": []
        })
        
        response = client.delete("/api/games/delete-test-game")
        
        assert response.status_code == 200
        assert response.json()["status"] == "deleted"
        
        get_response = client.get("/api/games/delete-test-game")
        assert get_response.status_code == 404
    
    def test_list_game_versions(self, client):
        """Test GET /api/games/{game_id}/versions returns version list."""
        client.post("/api/games/version-test-game/sync", json={
            "team": "VersionTeam",
            "teamId": "VersionTeam-0001",
            "opponent": "Opponent",
            "points": []
        })
        
        response = client.get("/api/games/version-test-game/versions")
        
        assert response.status_code == 200
        data = response.json()
        assert "versions" in data
        assert len(data["versions"]) >= 1
    
    def test_get_specific_version(self, client):
        """Test GET /api/games/{game_id}/versions/{timestamp} returns specific version."""
        # Create game
        client.post("/api/games/specific-version-game/sync", json={
            "team": "VersionTeam",
            "teamId": "VersionTeam-0001",
            "opponent": "Opponent",
            "version": 1
        })
        
        # Get version list
        versions_response = client.get("/api/games/specific-version-game/versions")
        timestamp = versions_response.json()["versions"][0]
        
        # Get specific version
        response = client.get(f"/api/games/specific-version-game/versions/{timestamp}")
        
        assert response.status_code == 200
        assert response.json()["version"] == 1


# =============================================================================
# Index API Tests
# =============================================================================

class TestIndexAPI:
    """Tests for index API endpoints."""
    
    def test_rebuild_index(self, client):
        """Test POST /api/index/rebuild rebuilds the index."""
        response = client.post("/api/index/rebuild")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "rebuilt"
        assert "lastRebuilt" in data
    
    def test_get_index_status(self, client):
        """Test GET /api/index/status returns index stats."""
        # First rebuild to ensure index exists
        client.post("/api/index/rebuild")
        
        response = client.get("/api/index/status")
        
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
        game = client.post("/api/games/workflow-game/sync", json={
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
        client.post("/api/index/rebuild")
        
        # 5. Verify queries work
        # Player games
        p1_games = client.get(f"/api/players/{p1['player_id']}/games").json()
        assert "workflow-game" in p1_games["game_ids"]
        
        # Team games
        team_games = client.get(f"/api/teams/{team['team_id']}/games").json()
        assert "workflow-game" in team_games["game_ids"]
        
        # Team players
        team_players = client.get(f"/api/teams/{team['team_id']}/players").json()
        assert team_players["count"] == 2
        
        # Get game
        game_data = client.get("/api/games/workflow-game").json()
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
        player_data = client.get(f"/api/players/{offline_player_id}").json()
        assert player_data["name"] == "OfflineCreatedPlayer"
        
        team_data = client.get(f"/api/teams/{offline_team_id}").json()
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
        player = client.get("/api/players/Update-Via-Create").json()
        assert player["name"] == "Updated"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

