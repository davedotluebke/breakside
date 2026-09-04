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
import logging
from datetime import datetime, timezone
from typing import Optional, Set, Tuple
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

logger = logging.getLogger(__name__)

# Import config - handle both relative and absolute imports
try:
    from config import SUPABASE_JWT_SECRET, auth_required
except ImportError:
    from breakside_server.config import SUPABASE_JWT_SECRET, auth_required


# HTTP Bearer token extractor
# auto_error=False means it won't raise an exception if no token is provided
security = HTTPBearer(auto_error=False)


def get_jwt_secret() -> str:
    """Get the JWT secret, re-reading from environment if needed."""
    # Re-read from environment to support testing/runtime changes
    import os
    return os.getenv("SUPABASE_JWT_SECRET", SUPABASE_JWT_SECRET)


def assert_auth_configured() -> None:
    """Fail fast at startup if auth is required but no JWT secret is set.

    Without this, a misconfigured server boots fine and then 500s on every
    authenticated request (get_jwt_secret is read per-request). Called from
    the app lifespan in main.py, so uvicorn refuses to start — and systemd
    marks the unit failed — instead of serving a broken API.

    Raises:
        RuntimeError: If auth_required() and SUPABASE_JWT_SECRET is empty.
    """
    if auth_required() and not get_jwt_secret():
        raise RuntimeError(
            "SUPABASE_JWT_SECRET is not set but auth is required "
            "(BREAKSIDE_AUTH_REQUIRED defaults to true) — no request could "
            "ever authenticate. Set SUPABASE_JWT_SECRET, or explicitly set "
            "BREAKSIDE_AUTH_REQUIRED=false for a local/dev server."
        )


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


# (user_id, email) pairs already mirrored into local storage this process
# lifetime. Without it every authenticated request — including the 2-second
# poll loop of a live game — would take the user entity lock and read a file.
# Keyed on the email too, so a Supabase-side address change still re-syncs.
# A restart just means one upsert per active user.
_synced_users: Set[Tuple[str, str]] = set()


def _mirror_user_record(payload: dict) -> None:
    """Ensure the authenticated user has a local record, best-effort.

    Supabase owns identity; ``data/users/`` is our mirror of it, and it is what
    ``is_admin()`` and the team-members endpoint read. Nothing used to populate
    it except ``GET /api/auth/me`` — so a user who signed up and went straight
    to creating a team or redeeming an invite never got a record, while their
    membership referenced them anyway. An August 2026 audit found 13 such
    users, including coaches on live teams, whose entries in
    ``GET /api/teams/{team_id}/members`` therefore rendered with a null email.

    Deliberately swallows storage errors: the caller is already authenticated,
    and a full disk or a permissions problem must not escalate into a total
    auth outage. Worst case the mirror stays stale, which is the status quo.
    """
    user_id = payload.get("id")
    email = payload.get("email")
    if not user_id:
        return

    key = (user_id, email or "")
    if key in _synced_users:
        return

    try:
        # Imported lazily so this module stays importable during early startup
        # (main.py pulls in assert_auth_configured before the routers load).
        try:
            from storage.user_storage import create_or_update_user
        except ImportError:
            from breakside_server.storage.user_storage import create_or_update_user

        create_or_update_user(
            user_id,
            email or f"{user_id}@unknown.invalid",
            (payload.get("user_metadata") or {}).get("full_name"),
        )
        _synced_users.add(key)
    except Exception:
        logger.warning("Could not mirror user record for %s", user_id, exc_info=True)


async def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> dict:
    """
    FastAPI dependency that extracts and validates the current user from JWT.

    Use this for endpoints that REQUIRE authentication.

    The ``X-Test-User-Id`` impersonation header is honored ONLY when auth is
    disabled (``auth_required()`` is False — i.e. local dev/agent servers that
    explicitly set ``BREAKSIDE_AUTH_REQUIRED=false``). Whenever auth is
    required (the production default) the header is ignored and a valid JWT is
    mandatory, so a caller can never become an arbitrary user by sending it.

    Returns:
        Dict with user info: {"id": str, "email": str, "role": str, ...}

    Raises:
        HTTPException 401: If no token provided or token is invalid
    """
    if not auth_required():
        # Auth disabled (local dev only): use X-Test-User-Id header or a
        # default so multi-coach tests can impersonate distinct users.
        test_user_id = request.headers.get("x-test-user-id", "test-user")
        return {
            "id": test_user_id,
            "email": f"{test_user_id}@breakside.test",
            "role": "authenticated",
        }

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = verify_supabase_token(credentials.credentials)
    _mirror_user_record(payload)
    return payload


async def get_optional_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> Optional[dict]:
    """
    FastAPI dependency that extracts user info if a valid token is provided,
    but allows anonymous access.

    Use this for endpoints that work for both authenticated and anonymous users,
    but may provide enhanced functionality for authenticated users.

    When auth is disabled (local dev / agent servers), mirrors
    ``get_current_user``'s synthetic test user (``X-Test-User-Id`` or
    "test-user") — otherwise optional-user endpoints like the games/teams
    lists treat every dev request as anonymous and return empty lists,
    while the rest of the API sees the test user. Ignored whenever auth is
    required, so this can never widen production access.

    Returns:
        Dict with user info if authenticated, None otherwise
    """
    if not auth_required():
        test_user_id = request.headers.get("x-test-user-id", "test-user")
        return {
            "id": test_user_id,
            "email": f"{test_user_id}@breakside.test",
            "role": "authenticated",
        }

    if credentials is None:
        return None
    
    try:
        payload = verify_supabase_token(credentials.credentials)
    except HTTPException:
        # Token was provided but invalid - for optional auth, treat as anonymous
        # You could also choose to raise the exception here if you want to
        # reject requests with invalid tokens
        return None

    _mirror_user_record(payload)
    return payload

