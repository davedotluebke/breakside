"""
JWT validation for Supabase tokens.

Supabase issues JWTs that we validate server-side. The JWT contains:
- sub: The user's UUID (Supabase auth.users.id)
- email: The user's email
- exp: Expiration timestamp
- aud: Audience (should be "authenticated")
- role: Usually "authenticated" for logged-in users

We verify the signature using Supabase's JWT secret.
"""

import jwt
from datetime import datetime, timezone
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

# Import config - handle both relative and absolute imports
try:
    from config import SUPABASE_JWT_SECRET, AUTH_REQUIRED
except ImportError:
    from ultistats_server.config import SUPABASE_JWT_SECRET, AUTH_REQUIRED


# HTTP Bearer token extractor
# auto_error=False means it won't raise an exception if no token is provided
security = HTTPBearer(auto_error=False)


def get_jwt_secret() -> str:
    """Get the JWT secret, re-reading from environment if needed."""
    # Re-read from environment to support testing/runtime changes
    import os
    return os.getenv("SUPABASE_JWT_SECRET", SUPABASE_JWT_SECRET)


def verify_supabase_token(token: str) -> dict:
    """
    Verify a Supabase JWT and return the decoded payload.
    
    Args:
        token: The JWT string (without "Bearer " prefix)
        
    Returns:
        Decoded JWT payload with user info
        
    Raises:
        HTTPException: If token is invalid, expired, or verification fails
    """
    jwt_secret = get_jwt_secret()
    if not jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server authentication not configured (missing SUPABASE_JWT_SECRET)"
        )
    
    try:
        # Decode and verify the JWT
        # Supabase uses HS256 by default
        payload = jwt.decode(
            token,
            jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",  # Supabase sets this for authenticated users
        )
        
        # Extract user info from the token
        user_id = payload.get("sub")
        email = payload.get("email")
        
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token: missing user ID"
            )
        
        return {
            "id": user_id,
            "email": email,
            "role": payload.get("role", "authenticated"),
            "exp": payload.get("exp"),
            "iat": payload.get("iat"),
            # Include any app-specific metadata Supabase might include
            "app_metadata": payload.get("app_metadata", {}),
            "user_metadata": payload.get("user_metadata", {}),
        }
        
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidAudienceError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token audience",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> dict:
    """
    FastAPI dependency that extracts and validates the current user from JWT.
    
    Use this for endpoints that REQUIRE authentication.
    
    Returns:
        Dict with user info: {"id": str, "email": str, "role": str, ...}
        
    Raises:
        HTTPException 401: If no token provided or token is invalid
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    return verify_supabase_token(credentials.credentials)


async def get_optional_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> Optional[dict]:
    """
    FastAPI dependency that extracts user info if a valid token is provided,
    but allows anonymous access.
    
    Use this for endpoints that work for both authenticated and anonymous users,
    but may provide enhanced functionality for authenticated users.
    
    Returns:
        Dict with user info if authenticated, None otherwise
    """
    if credentials is None:
        return None
    
    try:
        return verify_supabase_token(credentials.credentials)
    except HTTPException:
        # Token was provided but invalid - for optional auth, treat as anonymous
        # You could also choose to raise the exception here if you want to
        # reject requests with invalid tokens
        return None

