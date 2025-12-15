"""
Authentication module for Breakside.

Uses Supabase for authentication. JWTs issued by Supabase are validated
server-side to identify users.

Usage:
    from auth import get_current_user, get_optional_user, require_admin
    
    @app.get("/api/protected")
    async def protected_endpoint(user: dict = Depends(get_current_user)):
        return {"user_id": user["id"], "email": user["email"]}
    
    @app.get("/api/public-with-user-info")
    async def public_endpoint(user: dict | None = Depends(get_optional_user)):
        if user:
            return {"message": f"Hello {user['email']}"}
        return {"message": "Hello anonymous"}
"""

from .jwt_validation import (
    get_current_user,
    get_optional_user,
    verify_supabase_token,
)

from .dependencies import (
    require_admin,
    require_team_coach,
    require_team_access,
)

__all__ = [
    "get_current_user",
    "get_optional_user", 
    "verify_supabase_token",
    "require_admin",
    "require_team_coach",
    "require_team_access",
]

