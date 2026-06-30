"""
Authorization dependencies for role-based access control.

These dependencies check if the authenticated user has the required
permissions for a given operation.

Usage:
    @app.delete("/api/teams/{team_id}")
    async def delete_team(
        team_id: str,
        user: dict = Depends(require_team_coach("team_id"))
    ):
        ...
"""

from typing import Optional, Callable
from fastapi import Depends, HTTPException, status, Request

from .jwt_validation import get_current_user, get_optional_user

# Single source of truth for whether auth is enforced (defaults true).
try:
    from config import auth_required
    from validation import validate_id
except ImportError:
    from ultistats_server.config import auth_required
    from ultistats_server.validation import validate_id

# Import storage - handle both relative and absolute imports
try:
    from storage.user_storage import get_user, user_exists
    from storage.membership_storage import get_user_team_role, get_user_memberships, get_user_teams
    from storage.game_storage import game_exists, get_game_current
    from storage.index_storage import get_player_teams
except ImportError:
    from ultistats_server.storage.user_storage import get_user, user_exists
    from ultistats_server.storage.membership_storage import get_user_team_role, get_user_memberships, get_user_teams
    from ultistats_server.storage.game_storage import game_exists, get_game_current
    from ultistats_server.storage.index_storage import get_player_teams


def is_admin(user_id: str) -> bool:
    """
    Check if a user is a global admin.
    
    Args:
        user_id: The user's ID
        
    Returns:
        True if the user exists and is an admin, False otherwise
    """
    if not user_exists(user_id):
        return False
    user_data = get_user(user_id)
    return user_data.get("isAdmin", False)


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """
    Dependency that requires the user to be a global admin.
    
    Returns:
        The user dict if they are an admin
        
    Raises:
        HTTPException 403: If user is not an admin
    """
    if not is_admin(user["id"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    
    return user


def require_team_coach(team_id_param: str = "team_id") -> Callable:
    """
    Factory that creates a dependency requiring coach access to a team.
    
    Args:
        team_id_param: Name of the path parameter containing the team ID
        
    Returns:
        A dependency function
        
    Usage:
        @app.post("/api/teams/{team_id}/games")
        async def create_game(
            team_id: str,
            user: dict = Depends(require_team_coach("team_id"))
        ):
            ...
    """
    async def dependency(
        request: Request,
        user: dict = Depends(get_current_user)
    ) -> dict:
        team_id = request.path_params.get(team_id_param)
        if not team_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Missing path parameter: {team_id_param}"
            )
        validate_id(team_id, "team_id")

        # Admins have coach access to all teams
        if is_admin(user["id"]):
                return user

        # Check team membership
        role = get_user_team_role(user["id"], team_id)
        if role != "coach":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Coach access required for this team"
            )
        
        return user
    
    return dependency


def require_team_access(team_id_param: str = "team_id") -> Callable:
    """
    Factory that creates a dependency requiring any access to a team
    (coach or viewer).
    
    Args:
        team_id_param: Name of the path parameter containing the team ID
        
    Returns:
        A dependency function
    """
    async def dependency(
        request: Request,
        user: dict = Depends(get_current_user)
    ) -> dict:
        team_id = request.path_params.get(team_id_param)
        if not team_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Missing path parameter: {team_id_param}"
            )
        validate_id(team_id, "team_id")

        # Admins have access to all teams
        if is_admin(user["id"]):
                return user

        # Check team membership (any role grants access)
        role = get_user_team_role(user["id"], team_id)
        if role is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to this team"
            )
        
        return user
    
    return dependency


async def require_game_team_coach(
    request: Request,
    user: dict = Depends(get_current_user)
) -> dict:
    """
    Dependency for game write endpoints.

    Looks up the teamId from:
    1. The existing game (if it exists)
    2. The request body (for new games being synced)

    Then verifies the user is a Coach for that team.
    When AUTH_REQUIRED is false, skips the membership check.

    Returns:
        The user dict if authorized

    Raises:
        HTTPException 400: If game has no teamId
        HTTPException 403: If user is not a coach for the team
    """
    # Validate before the auth short-circuit so traversal is rejected even
    # when auth is disabled for local dev.
    game_id = request.path_params.get("game_id")
    if game_id is not None:
        validate_id(game_id, "game_id")

    if not auth_required():
        return user

    team_id = None

    # Check existing game first
    if game_id and game_exists(game_id):
        game_data = get_game_current(game_id)
        team_id = game_data.get("teamId")

    # If no team_id from existing game, check request body
    if not team_id:
        try:
            body = await request.json()
            team_id = body.get("teamId")
        except Exception:
            pass  # Body might not be JSON or might not have teamId

    if not team_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Game must have a teamId"
        )

    # Admin bypass
    if is_admin(user["id"]):
        return user

    # Verify coach access to this team
    role = get_user_team_role(user["id"], team_id)
    if role != "coach":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Coach access required for this team"
        )

    return user


async def require_game_team_access(
    request: Request,
    user: dict = Depends(get_current_user)
) -> dict:
    """
    Dependency for game read endpoints.

    Requires Coach or Viewer access to the game's team.
    When AUTH_REQUIRED is false, skips the membership check.

    Returns:
        The user dict if authorized

    Raises:
        HTTPException 404: If game doesn't exist
        HTTPException 400: If game has no teamId
        HTTPException 403: If user doesn't have team access
    """
    game_id = request.path_params.get("game_id")
    if game_id is not None:
        validate_id(game_id, "game_id")

    if not auth_required():
        return user

    if not game_id or not game_exists(game_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Game {game_id} not found"
        )

    game_data = get_game_current(game_id)
    team_id = game_data.get("teamId")

    if not team_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Game has no teamId"
        )

    # Admin bypass
    if is_admin(user["id"]):
        return user

    # Verify any team access
    role = get_user_team_role(user["id"], team_id)
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have access to this team"
        )

    return user


def assert_player_edit_access(user: dict, player_id: Optional[str]) -> None:
    """Raise HTTP 403 unless ``user`` may create/edit/delete ``player_id``.

    Authorization model: the user must be a Coach of a team that has this
    player on its roster. A player not on any team yet (orphan / brand-new,
    including ``player_id is None`` for a fresh create) is editable by any
    Coach. Admins always pass.

    Shared by ``require_player_edit_access`` (PUT/DELETE, player_id from path)
    and the ``POST /api/players`` create/overwrite handler (id from the body).
    """
    if is_admin(user["id"]):
        return

    user_coach_teams = set(
        m["teamId"] for m in get_user_memberships(user["id"]) if m["role"] == "coach"
    )

    player_teams = set(get_player_teams(player_id)) if player_id else set()

    if not player_teams:
        # Orphaned / brand-new player: any coach may create or edit it.
        if user_coach_teams:
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Coach access required to edit players"
        )

    if not (player_teams & user_coach_teams):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a Coach of a team with this player"
        )


async def require_player_edit_access(
    request: Request,
    user: dict = Depends(get_current_user)
) -> dict:
    """
    Dependency for player edit/delete endpoints.

    Verifies the user is a Coach of at least one team that has this player
    on their roster.

    Returns:
        The user dict if authorized

    Raises:
        HTTPException 400: If player_id is missing/invalid
        HTTPException 403: If user is not a coach of any team with this player
    """
    player_id = request.path_params.get("player_id")

    if not player_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing player_id"
        )
    validate_id(player_id, "player_id")

    assert_player_edit_access(user, player_id)
    return user


async def require_player_read_access(
    request: Request,
    user: dict = Depends(get_current_user)
) -> dict:
    """
    Dependency for player read endpoints.

    Player records are private. A player is visible only to members
    (coaches OR viewers) of a team the player belongs to — which covers both
    "coaches of the player's team" and "viewers invited to a game" featuring
    that player (game viewers hold a viewer membership on the team). Admins
    see all.

    This is the read-side complement to ``require_player_edit_access`` and
    closes the gap where any caller could read any player's data.

    Returns:
        The user dict if authorized

    Raises:
        HTTPException 400: If player_id is missing/invalid
        HTTPException 403: If the user shares no team with this player
    """
    player_id = request.path_params.get("player_id")

    if not player_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing player_id"
        )
    validate_id(player_id, "player_id")

    # Admin bypass
    if is_admin(user["id"]):
        return user

    player_teams = set(get_player_teams(player_id))

    if not player_teams:
        # Orphaned / newly-created player not yet on any roster. Mirror the
        # edit-access fallback: any coach may read it (so a coach who just
        # created a player can read it back before the team sync lands).
        user_memberships = get_user_memberships(user["id"])
        if any(m["role"] == "coach" for m in user_memberships):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have access to this player"
        )

    user_teams = set(get_user_teams(user["id"]))
    if not (player_teams & user_teams):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have access to this player"
        )

    return user
