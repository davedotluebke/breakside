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

# Import storage - handle both relative and absolute imports
try:
    from storage.user_storage import get_user, user_exists
    from storage.membership_storage import get_user_team_role, get_user_memberships
    from storage.game_storage import game_exists, get_game_current
    from storage.index_storage import get_player_teams
except ImportError:
    from ultistats_server.storage.user_storage import get_user, user_exists
    from ultistats_server.storage.membership_storage import get_user_team_role, get_user_memberships
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
    
    Returns:
        The user dict if authorized
        
    Raises:
        HTTPException 400: If game has no teamId
        HTTPException 403: If user is not a coach for the team
    """
    game_id = request.path_params.get("game_id")
    
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
    
    Returns:
        The user dict if authorized
        
    Raises:
        HTTPException 404: If game doesn't exist
        HTTPException 400: If game has no teamId
        HTTPException 403: If user doesn't have team access
    """
    game_id = request.path_params.get("game_id")
    
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
        HTTPException 400: If player_id is missing
        HTTPException 403: If user is not a coach of any team with this player
    """
    player_id = request.path_params.get("player_id")
    
    if not player_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing player_id"
        )
    
    # Admin bypass
    if is_admin(user["id"]):
        return user
    
    # Get teams this player belongs to (from index)
    player_teams = set(get_player_teams(player_id))
    
    if not player_teams:
        # Player isn't on any team - allow edit by any coach
        # (This handles orphaned players or newly created ones)
        user_memberships = get_user_memberships(user["id"])
        if any(m["role"] == "coach" for m in user_memberships):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Coach access required to edit players"
        )
    
    # Get teams user is a Coach of
    user_memberships = get_user_memberships(user["id"])
    user_coach_teams = set(m["teamId"] for m in user_memberships if m["role"] == "coach")
    
    # Check for overlap
    if not player_teams & user_coach_teams:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You must be a Coach of a team with this player"
        )
    
    return user
