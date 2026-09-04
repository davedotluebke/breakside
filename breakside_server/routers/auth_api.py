"""
Authentication endpoints: current-user info, profile updates, sync check,
the user's teams, and self-service account deletion.
"""
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from ._shared import (
    create_or_update_user,
    get_current_user,
    get_player,
    get_team,
    get_user_memberships,
    import_server_module,
)
from ._shared import update_user as update_user_storage

# Policy for the two deletion routes below. Kept out of the router so the
# ordering rules and the sole-coach decision are testable without HTTP.
account_deletion = import_server_module("account_deletion")

router = APIRouter()


@router.get("/api/auth/me")
async def get_current_user_info(user: dict = Depends(get_current_user)):
    """
    Get the current authenticated user's info.

    This endpoint validates the JWT and returns user information.
    It also syncs the user to our local storage if they don't exist yet.
    """
    # Sync user to our local storage (creates if doesn't exist)
    local_user = create_or_update_user(
        user_id=user["id"],
        email=user["email"],
        display_name=user.get("user_metadata", {}).get("full_name")
    )

    # Get their team memberships
    memberships = get_user_memberships(user["id"])

    return {
        "id": local_user["id"],
        "email": local_user["email"],
        "displayName": local_user["displayName"],
        "isAdmin": local_user.get("isAdmin", False),
        "createdAt": local_user["createdAt"],
        "memberships": memberships,
    }


@router.patch("/api/auth/me")
async def update_current_user(
    updates: Dict[str, Any] = Body(...),
    user: dict = Depends(get_current_user)
):
    """
    Update the current user's profile.

    Allowed fields: displayName
    """
    # Only allow updating certain fields
    allowed_fields = {"displayName"}
    filtered_updates = {k: v for k, v in updates.items() if k in allowed_fields}

    if not filtered_updates:
        raise HTTPException(
            status_code=400,
            detail=f"No valid fields to update. Allowed: {allowed_fields}"
        )

    updated_user = update_user_storage(user["id"], filtered_updates)
    if not updated_user:
        raise HTTPException(status_code=404, detail="User not found")

    return {
        "status": "updated",
        "user": {
            "id": updated_user["id"],
            "email": updated_user["email"],
            "displayName": updated_user["displayName"],
        }
    }


@router.get("/api/auth/me/delete-preview")
async def preview_account_deletion(user: dict = Depends(get_current_user)):
    """
    What deleting this account would destroy. Mutates nothing.

    Self only — like every route in this pair, the user id comes from the
    validated JWT and there is no path or body parameter that could name
    somebody else.

    Returns the shared preview shape (``willErase`` + ``warnings``) plus the
    fields the confirm dialog needs: ``blockingTeams`` (teams this user is the
    last coach of that other people still belong to — deletion refuses until
    those are handed over) and ``teamsToErase`` (teams this account is the
    only member of, which the cascade destroys once confirmed).
    """
    return account_deletion.plan_account_deletion(user["id"])


@router.delete("/api/auth/me")
async def delete_current_user(
    confirm_erase_teams: bool = Query(
        False,
        description=(
            "Set once the user has seen the preview and accepted that teams "
            "they are the only member of will be permanently erased."
        ),
    ),
    user: dict = Depends(get_current_user),
):
    """
    Permanently delete the current user's account. Irreversible, no undo.

    Self only. Order of operations and the failure rule live in
    ``account_deletion`` — in short, the Supabase auth identity is deleted
    first and any failure there aborts before a single local file is touched,
    so a user can never end up with their data gone and a login that still
    works.
    """
    try:
        result = await account_deletion.execute_account_deletion(
            user["id"], confirm_erase_teams=confirm_erase_teams
        )
    except account_deletion.TeamHandoverRequired as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "team_handover_required",
                "message": str(exc),
                "teams": exc.teams,
            },
        )
    except account_deletion.TeamCascadeNotConfirmed as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "team_cascade_not_confirmed",
                "message": str(exc),
                "teams": exc.teams,
            },
        )
    except account_deletion.AuthIdentityDeletionFailed as exc:
        # 503 = this deployment cannot delete Supabase accounts at all;
        # 502 = the call was made and the auth service refused or was
        # unreachable. Either way nothing local was deleted, which the
        # message says out loud so the client does not sign the user out.
        raise HTTPException(
            status_code=503 if not exc.configured else 502,
            detail={
                "reason": "auth_identity_deletion_failed",
                "message": str(exc),
                "deletedAnything": False,
            },
        )

    return {"status": "deleted", **result}


@router.get("/api/auth/sync-check")
async def get_sync_status(user: dict = Depends(get_current_user)):
    """
    Lightweight endpoint to check if there are updates to sync.

    Returns summary info (counts and latest timestamps) that client can
    compare with local state to decide whether to do a full sync.
    """
    memberships = get_user_memberships(user["id"])

    team_count = 0
    latest_team_update = None
    latest_player_update = None
    total_player_count = 0

    for membership in memberships:
        try:
            team = get_team(membership["teamId"])
            team_count += 1

            # Track latest team update
            team_updated = team.get("updatedAt")
            if team_updated:
                if latest_team_update is None or team_updated > latest_team_update:
                    latest_team_update = team_updated

            # Count players and check their update times
            player_ids = team.get("playerIds", [])
            total_player_count += len(player_ids)

            # Check player update timestamps
            for player_id in player_ids:
                try:
                    player = get_player(player_id)
                    player_updated = player.get("updatedAt")
                    if player_updated:
                        if latest_player_update is None or player_updated > latest_player_update:
                            latest_player_update = player_updated
                except (FileNotFoundError, KeyError):
                    continue

        except (FileNotFoundError, KeyError):
            continue

    # Combine latest updates
    latest_update = latest_team_update
    if latest_player_update:
        if latest_update is None or latest_player_update > latest_update:
            latest_update = latest_player_update

    return {
        "teamCount": team_count,
        "playerCount": total_player_count,
        "latestTeamUpdate": latest_team_update,
        "latestPlayerUpdate": latest_player_update,
        "latestUpdate": latest_update,
        "serverTime": datetime.now().isoformat(),
    }


@router.get("/api/auth/teams")
async def get_user_teams_endpoint(user: dict = Depends(get_current_user)):
    """
    Get all teams the current user has access to.

    Returns teams with the user's role for each.
    """
    memberships = get_user_memberships(user["id"])

    teams_with_roles = []
    for membership in memberships:
        try:
            team = get_team(membership["teamId"])
            teams_with_roles.append({
                "team": team,
                "role": membership["role"],
                "joinedAt": membership["joinedAt"],
            })
        except (FileNotFoundError, KeyError):
            # Team may have been deleted
            continue

    return {
        "teams": teams_with_roles,
        "count": len(teams_with_roles)
    }
