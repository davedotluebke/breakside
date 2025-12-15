"""
Authorization dependencies for role-based access control.

These dependencies check if the authenticated user has the required
permissions for a given operation.

Usage:
    @app.delete("/api/teams/{team_id}")
    async def delete_team(
        team_id: str,
        user: dict = Depends(get_current_user),
        _: None = Depends(require_team_coach(team_id))
    ):
        ...
"""

from typing import Optional, Callable
from fastapi import Depends, HTTPException, status

from .jwt_validation import get_current_user

# Import storage - handle both relative and absolute imports
try:
    from storage.user_storage import get_user, user_exists
    from storage.membership_storage import get_user_team_role
except ImportError:
    from ultistats_server.storage.user_storage import get_user, user_exists
    from ultistats_server.storage.membership_storage import get_user_team_role


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """
    Dependency that requires the user to be a global admin.
    
    Returns:
        The user dict if they are an admin
        
    Raises:
        HTTPException 403: If user is not an admin
    """
    # Check if user exists in our system and is an admin
    if not user_exists(user["id"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    
    user_data = get_user(user["id"])
    if not user_data.get("isAdmin", False):
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
            user: dict = Depends(get_current_user),
            _: None = Depends(require_team_coach("team_id"))
        ):
            ...
    """
    async def dependency(
        user: dict = Depends(get_current_user),
        **path_params
    ) -> dict:
        team_id = path_params.get(team_id_param)
        if not team_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Missing path parameter: {team_id_param}"
            )
        
        # Admins have coach access to all teams
        if user_exists(user["id"]):
            user_data = get_user(user["id"])
            if user_data.get("isAdmin", False):
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
        user: dict = Depends(get_current_user),
        **path_params
    ) -> dict:
        team_id = path_params.get(team_id_param)
        if not team_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Missing path parameter: {team_id_param}"
            )
        
        # Admins have access to all teams
        if user_exists(user["id"]):
            user_data = get_user(user["id"])
            if user_data.get("isAdmin", False):
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

