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

# Import the app
from main import app

client = TestClient(app)

# Test secret for JWT signing
TEST_SECRET = "test-secret-key-for-testing"


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

