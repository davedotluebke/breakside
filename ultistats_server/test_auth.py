"""
Tests for authentication module.

Run with: pytest test_auth.py -v
"""

import os
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch
import jwt
from datetime import datetime, timezone, timedelta
import json
import shutil
from pathlib import Path

# Import the app
from main import app

client = TestClient(app)

# Test secret for JWT signing
TEST_SECRET = "test-secret-key-for-testing"

# Test data directory
TEST_DATA_DIR = Path(__file__).parent.parent / "data"


def create_test_token(
    user_id: str = "test-user-123",
    email: str = "test@example.com",
    secret: str = TEST_SECRET,
    expired: bool = False
) -> str:
    """Create a test JWT token."""
    now = datetime.now(timezone.utc)
    exp = now - timedelta(hours=1) if expired else now + timedelta(hours=1)
    
    payload = {
        "sub": user_id,
        "email": email,
        "aud": "authenticated",
        "role": "authenticated",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    
    return jwt.encode(payload, secret, algorithm="HS256")


def auth_headers(user_id: str = "test-user-123", email: str = "test@example.com"):
    """Create authorization headers with a valid token."""
    token = create_test_token(user_id=user_id, email=email)
    return {"Authorization": f"Bearer {token}"}


class TestHealthEndpoint:
    """Test that basic endpoints still work."""
    
    def test_health_check(self):
        """Health check should work without auth."""
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "healthy"
    
    def test_api_info(self):
        """API info should work without auth."""
        response = client.get("/api")
        assert response.status_code == 200
        assert "Ultistats API Server" in response.json()["message"]


class TestAuthMeEndpoint:
    """Test the /api/auth/me endpoint."""
    
    def test_no_token_returns_401(self):
        """Requests without token should get 401."""
        response = client.get("/api/auth/me")
        assert response.status_code == 401
        assert "Authentication required" in response.json()["detail"]
    
    def test_invalid_token_returns_401(self):
        """Invalid token should get 401."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.get(
                "/api/auth/me",
                headers={"Authorization": "Bearer invalid-token"}
            )
            assert response.status_code == 401
    
    def test_valid_token_returns_user(self):
        """Valid token should return user info."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            token = create_test_token()
            response = client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token}"}
            )
            assert response.status_code == 200
            data = response.json()
            assert data["id"] == "test-user-123"
            assert data["email"] == "test@example.com"
    
    def test_expired_token_returns_401(self):
        """Expired token should get 401."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            token = create_test_token(expired=True)
            response = client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token}"}
            )
            assert response.status_code == 401
            assert "expired" in response.json()["detail"].lower()


class TestUserStorage:
    """Test user storage functions."""
    
    def test_user_creation_on_auth(self):
        """User should be created in storage on first auth."""
        from storage.user_storage import get_user, delete_user, user_exists
        
        user_id = "test-storage-user-456"
        
        # Clean up if exists from previous test
        if user_exists(user_id):
            delete_user(user_id)
        
        # User shouldn't exist yet
        assert not user_exists(user_id)
        
        # Authenticate (which creates user)
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            token = create_test_token(user_id=user_id, email="storage@test.com")
            response = client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token}"}
            )
        
        assert response.status_code == 200
        
        # User should now exist
        assert user_exists(user_id)
        user = get_user(user_id)
        assert user["email"] == "storage@test.com"
        
        # Clean up
        delete_user(user_id)


class TestTeamAuth:
    """Test team endpoint authorization."""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        from storage.user_storage import save_user, delete_user, user_exists
        from storage.team_storage import save_team, delete_team, team_exists
        from storage.membership_storage import create_membership, delete_membership, get_user_memberships
        
        self.coach_id = "test-coach-001"
        self.viewer_id = "test-viewer-001"
        self.outsider_id = "test-outsider-001"
        self.team_id = "Test-Auth-Team-abc1"
        
        # Create test users
        for uid in [self.coach_id, self.viewer_id, self.outsider_id]:
            if not user_exists(uid):
                save_user({
                    "id": uid,
                    "email": f"{uid}@test.com",
                    "displayName": uid,
                    "isAdmin": False,
                    "createdAt": datetime.now(timezone.utc).isoformat()
                })
        
        # Create test team
        if not team_exists(self.team_id):
            save_team({"id": self.team_id, "name": "Test Auth Team", "playerIds": []}, self.team_id)
        
        # Create memberships
        for mem in get_user_memberships(self.coach_id):
            if mem["teamId"] == self.team_id:
                delete_membership(mem["id"])
        for mem in get_user_memberships(self.viewer_id):
            if mem["teamId"] == self.team_id:
                delete_membership(mem["id"])
        
        create_membership(self.team_id, self.coach_id, "coach")
        create_membership(self.team_id, self.viewer_id, "viewer")
        
        yield
        
        # Cleanup
        for uid in [self.coach_id, self.viewer_id, self.outsider_id]:
            if user_exists(uid):
                delete_user(uid)
        if team_exists(self.team_id):
            delete_team(self.team_id)
    
    def test_get_team_requires_access(self):
        """GET /api/teams/{id} returns 403 for outsider."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.get(
                f"/api/teams/{self.team_id}",
                headers=auth_headers(self.outsider_id)
            )
            assert response.status_code == 403
    
    def test_get_team_allows_viewer(self):
        """GET /api/teams/{id} succeeds for viewer."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.get(
                f"/api/teams/{self.team_id}",
                headers=auth_headers(self.viewer_id)
            )
            assert response.status_code == 200
    
    def test_get_team_allows_coach(self):
        """GET /api/teams/{id} succeeds for coach."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.get(
                f"/api/teams/{self.team_id}",
                headers=auth_headers(self.coach_id)
            )
            assert response.status_code == 200
    
    def test_update_team_requires_coach(self):
        """PUT /api/teams/{id} returns 403 for viewer."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.put(
                f"/api/teams/{self.team_id}",
                headers=auth_headers(self.viewer_id),
                json={"name": "Updated Name", "playerIds": []}
            )
            assert response.status_code == 403
    
    def test_update_team_allows_coach(self):
        """PUT /api/teams/{id} succeeds for coach."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.put(
                f"/api/teams/{self.team_id}",
                headers=auth_headers(self.coach_id),
                json={"name": "Updated Name", "playerIds": []}
            )
            assert response.status_code == 200
    
    def test_create_team_creates_membership(self):
        """Creating a team makes the creator a Coach."""
        from storage.team_storage import delete_team, team_exists
        from storage.membership_storage import get_user_team_role
        
        new_team_id = "New-Test-Team-xyz9"
        
        # Clean up if exists
        if team_exists(new_team_id):
            delete_team(new_team_id)
        
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.post(
                "/api/teams",
                headers=auth_headers(self.coach_id),
                json={"id": new_team_id, "name": "New Test Team", "playerIds": []}
            )
            assert response.status_code == 200
            
            # Verify membership was created
            role = get_user_team_role(self.coach_id, new_team_id)
            assert role == "coach"
        
        # Clean up
        if team_exists(new_team_id):
            delete_team(new_team_id)
    
    def test_list_teams_filters_by_access(self):
        """GET /api/teams returns only accessible teams."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            # Coach should see the team
            response = client.get(
                "/api/teams",
                headers=auth_headers(self.coach_id)
            )
            assert response.status_code == 200
            team_ids = [t["id"] for t in response.json()["teams"]]
            assert self.team_id in team_ids
            
            # Outsider should not see the team
            response = client.get(
                "/api/teams",
                headers=auth_headers(self.outsider_id)
            )
            assert response.status_code == 200
            team_ids = [t["id"] for t in response.json()["teams"]]
            assert self.team_id not in team_ids
    
    def test_list_teams_anonymous_returns_empty(self):
        """GET /api/teams returns empty list for anonymous user."""
        response = client.get("/api/teams")
        assert response.status_code == 200
        assert response.json()["teams"] == []


class TestGameAuth:
    """Test game endpoint authorization."""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        from storage.user_storage import save_user, delete_user, user_exists
        from storage.team_storage import save_team, delete_team, team_exists
        from storage.game_storage import save_game_version, delete_game, game_exists
        from storage.membership_storage import create_membership, delete_membership, get_user_memberships
        
        self.coach_id = "test-game-coach-001"
        self.viewer_id = "test-game-viewer-001"
        self.outsider_id = "test-game-outsider-001"
        self.team_id = "Test-Game-Team-gm01"
        self.game_id = "2025-01-01_Test-Game-Team_vs_Opponent_test123"
        
        # Create test users
        for uid in [self.coach_id, self.viewer_id, self.outsider_id]:
            if not user_exists(uid):
                save_user({
                    "id": uid,
                    "email": f"{uid}@test.com",
                    "displayName": uid,
                    "isAdmin": False,
                    "createdAt": datetime.now(timezone.utc).isoformat()
                })
        
        # Create test team
        if not team_exists(self.team_id):
            save_team({"id": self.team_id, "name": "Test Game Team", "playerIds": []}, self.team_id)
        
        # Create test game
        if not game_exists(self.game_id):
            save_game_version(self.game_id, {
                "id": self.game_id,
                "teamId": self.team_id,
                "team": "Test Game Team",
                "opponent": "Opponent",
                "scores": {"team": 0, "opponent": 0},
                "points": []
            })
        
        # Create memberships
        for mem in get_user_memberships(self.coach_id):
            if mem["teamId"] == self.team_id:
                delete_membership(mem["id"])
        for mem in get_user_memberships(self.viewer_id):
            if mem["teamId"] == self.team_id:
                delete_membership(mem["id"])
        
        create_membership(self.team_id, self.coach_id, "coach")
        create_membership(self.team_id, self.viewer_id, "viewer")
        
        yield
        
        # Cleanup
        for uid in [self.coach_id, self.viewer_id, self.outsider_id]:
            if user_exists(uid):
                delete_user(uid)
        if team_exists(self.team_id):
            delete_team(self.team_id)
        if game_exists(self.game_id):
            delete_game(self.game_id)
    
    def test_get_game_requires_team_access(self):
        """GET /api/games/{id} returns 403 for outsider."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.get(
                f"/api/games/{self.game_id}",
                headers=auth_headers(self.outsider_id)
            )
            assert response.status_code == 403
    
    def test_get_game_allows_viewer(self):
        """GET /api/games/{id} succeeds for viewer."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.get(
                f"/api/games/{self.game_id}",
                headers=auth_headers(self.viewer_id)
            )
            assert response.status_code == 200
    
    def test_sync_game_requires_coach(self):
        """POST /api/games/{id}/sync returns 403 for viewer."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.post(
                f"/api/games/{self.game_id}/sync",
                headers=auth_headers(self.viewer_id),
                json={
                    "id": self.game_id,
                    "teamId": self.team_id,
                    "team": "Test Game Team",
                    "opponent": "Opponent",
                    "scores": {"team": 1, "opponent": 0},
                    "points": []
                }
            )
            assert response.status_code == 403
    
    def test_sync_game_allows_coach(self):
        """POST /api/games/{id}/sync succeeds for coach."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.post(
                f"/api/games/{self.game_id}/sync",
                headers=auth_headers(self.coach_id),
                json={
                    "id": self.game_id,
                    "teamId": self.team_id,
                    "team": "Test Game Team",
                    "opponent": "Opponent",
                    "scores": {"team": 1, "opponent": 0},
                    "points": []
                }
            )
            assert response.status_code == 200
    
    def test_list_games_filters_by_access(self):
        """GET /api/games returns only accessible games."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            # Coach should see the game
            response = client.get(
                "/api/games",
                headers=auth_headers(self.coach_id)
            )
            assert response.status_code == 200
            game_ids = [g["game_id"] for g in response.json()["games"]]
            assert self.game_id in game_ids
            
            # Outsider should not see the game
            response = client.get(
                "/api/games",
                headers=auth_headers(self.outsider_id)
            )
            assert response.status_code == 200
            game_ids = [g["game_id"] for g in response.json()["games"]]
            assert self.game_id not in game_ids


class TestShareLinks:
    """Test share link functionality."""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        from storage.user_storage import save_user, delete_user, user_exists
        from storage.team_storage import save_team, delete_team, team_exists
        from storage.game_storage import save_game_version, delete_game, game_exists
        from storage.membership_storage import create_membership, delete_membership, get_user_memberships
        from storage.share_storage import list_game_shares, delete_share
        
        self.coach_id = "test-share-coach-001"
        self.viewer_id = "test-share-viewer-001"
        self.team_id = "Test-Share-Team-sh01"
        self.game_id = "2025-01-01_Test-Share-Team_vs_Opponent_share123"
        
        # Create test users
        for uid in [self.coach_id, self.viewer_id]:
            if not user_exists(uid):
                save_user({
                    "id": uid,
                    "email": f"{uid}@test.com",
                    "displayName": uid,
                    "isAdmin": False,
                    "createdAt": datetime.now(timezone.utc).isoformat()
                })
        
        # Create test team
        if not team_exists(self.team_id):
            save_team({"id": self.team_id, "name": "Test Share Team", "playerIds": []}, self.team_id)
        
        # Create test game
        if not game_exists(self.game_id):
            save_game_version(self.game_id, {
                "id": self.game_id,
                "teamId": self.team_id,
                "team": "Test Share Team",
                "opponent": "Opponent",
                "scores": {"team": 0, "opponent": 0},
                "points": []
            })
        
        # Create memberships
        for mem in get_user_memberships(self.coach_id):
            if mem["teamId"] == self.team_id:
                delete_membership(mem["id"])
        for mem in get_user_memberships(self.viewer_id):
            if mem["teamId"] == self.team_id:
                delete_membership(mem["id"])
        
        create_membership(self.team_id, self.coach_id, "coach")
        create_membership(self.team_id, self.viewer_id, "viewer")
        
        # Clean up any existing shares
        for share in list_game_shares(self.game_id):
            delete_share(share["id"])
        
        yield
        
        # Cleanup
        for uid in [self.coach_id, self.viewer_id]:
            if user_exists(uid):
                delete_user(uid)
        if team_exists(self.team_id):
            delete_team(self.team_id)
        if game_exists(self.game_id):
            delete_game(self.game_id)
    
    def test_create_share_requires_coach(self):
        """POST /api/games/{id}/share returns 403 for viewer."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.post(
                f"/api/games/{self.game_id}/share",
                headers=auth_headers(self.viewer_id)
            )
            assert response.status_code == 403
    
    def test_create_share_allows_coach(self):
        """POST /api/games/{id}/share succeeds for coach."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.post(
                f"/api/games/{self.game_id}/share",
                headers=auth_headers(self.coach_id)
            )
            assert response.status_code == 200
            data = response.json()
            assert "share" in data
            assert "url" in data
            assert "hash" in data["share"]
    
    def test_share_link_provides_access(self):
        """GET /api/share/{hash} returns game without auth."""
        from storage.share_storage import create_share_link
        
        # Create a share link directly
        share = create_share_link(
            game_id=self.game_id,
            team_id=self.team_id,
            created_by=self.coach_id,
            expires_days=7
        )
        
        # Access via share link (no auth)
        response = client.get(f"/api/share/{share['hash']}")
        assert response.status_code == 200
        data = response.json()
        assert "game" in data
        assert data["game"]["id"] == self.game_id
    
    def test_invalid_share_returns_404(self):
        """Invalid share hash returns 404."""
        response = client.get("/api/share/nonexistent123")
        assert response.status_code == 404
    
    def test_revoked_share_returns_410(self):
        """Revoked share links return 410 Gone."""
        from storage.share_storage import create_share_link, revoke_share
        
        # Create and revoke a share link
        share = create_share_link(
            game_id=self.game_id,
            team_id=self.team_id,
            created_by=self.coach_id,
            expires_days=7
        )
        revoke_share(share["id"], self.coach_id)
        
        # Try to access
        response = client.get(f"/api/share/{share['hash']}")
        assert response.status_code == 410


class TestAdminAuth:
    """Test admin-only endpoints."""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        from storage.user_storage import save_user, delete_user, user_exists
        
        self.admin_id = "test-admin-001"
        self.regular_id = "test-regular-001"
        
        # Create admin user
        if not user_exists(self.admin_id):
            save_user({
                "id": self.admin_id,
                "email": "admin@test.com",
                "displayName": "Admin",
                "isAdmin": True,
                "createdAt": datetime.now(timezone.utc).isoformat()
            })
        
        # Create regular user
        if not user_exists(self.regular_id):
            save_user({
                "id": self.regular_id,
                "email": "regular@test.com",
                "displayName": "Regular",
                "isAdmin": False,
                "createdAt": datetime.now(timezone.utc).isoformat()
            })
        
        yield
        
        # Cleanup
        for uid in [self.admin_id, self.regular_id]:
            if user_exists(uid):
                delete_user(uid)
    
    def test_index_rebuild_requires_admin(self):
        """POST /api/index/rebuild returns 403 for non-admin."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.post(
                "/api/index/rebuild",
                headers=auth_headers(self.regular_id)
            )
            assert response.status_code == 403
    
    def test_index_rebuild_allows_admin(self):
        """POST /api/index/rebuild succeeds for admin."""
        with patch.dict(os.environ, {"SUPABASE_JWT_SECRET": TEST_SECRET}):
            response = client.post(
                "/api/index/rebuild",
                headers=auth_headers(self.admin_id)
            )
            assert response.status_code == 200
            assert response.json()["status"] == "rebuilt"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
