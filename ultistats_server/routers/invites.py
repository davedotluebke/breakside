"""
Invite endpoints (team join codes).
"""
from typing import Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from ._shared import (
    create_invite,
    get_current_user,
    get_invite,
    get_invite_by_code,
    get_invite_validity_reason,
    get_team,
    get_user,
    get_user_team_role,
    is_admin,
    is_invite_valid,
    list_team_invites,
    redeem_invite,
    require_team_coach,
    team_exists,
    validate_id,
)
from ._shared import revoke_invite as revoke_invite_storage

router = APIRouter()


@router.post("/api/teams/{team_id}/invites")
async def create_team_invite(
    team_id: str,
    role: Literal["coach", "viewer"] = Body(...),
    expires_days: Optional[int] = Body(default=None, ge=1, le=365),
    user: dict = Depends(require_team_coach("team_id"))
):
    """
    Create an invite code for a team.

    Coach invites: single-use, default 7-day expiry
    Viewer invites: unlimited uses, default 30-day expiry

    Requires: Coach access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    # Set defaults based on role
    default_expiry = 7 if role == "coach" else 30

    invite = create_invite(
        team_id=team_id,
        role=role,
        created_by=user["id"],
        expires_days=expires_days if expires_days is not None else default_expiry,
    )

    return {
        "invite": invite,
        "url": f"https://www.breakside.pro/join/{invite['code']}",
        "code": invite["code"]
    }


@router.get("/api/teams/{team_id}/invites")
async def list_team_invites_endpoint(
    team_id: str,
    user: dict = Depends(require_team_coach("team_id"))
):
    """
    List all invites for a team (including expired/revoked).

    Requires: Coach access to the team.
    """
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    invites = list_team_invites(team_id)

    # Add validity status to each invite
    invites_with_status = []
    for invite in invites:
        invite_copy = dict(invite)
        invite_copy["isValid"] = is_invite_valid(invite)
        invite_copy["invalidReason"] = get_invite_validity_reason(invite)
        invites_with_status.append(invite_copy)

    return {"invites": invites_with_status, "count": len(invites_with_status)}


@router.get("/api/invites/{code}/info")
async def get_invite_info(code: str):
    """
    Get public info about an invite (for landing page preview).

    Returns team name and role, but not internal details.
    No auth required.
    """
    validate_id(code, "invite code")
    invite = get_invite_by_code(code.upper())

    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")

    if not is_invite_valid(invite):
        reason = get_invite_validity_reason(invite)
        error_messages = {
            "revoked": "This invite has been revoked",
            "expired": "This invite has expired",
            "max_uses": "This invite has already been used",
        }
        raise HTTPException(
            status_code=410,
            detail=error_messages.get(reason, "This invite is no longer valid")
        )

    try:
        team = get_team(invite["teamId"])
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Team not found")

    # Get inviter's display name
    try:
        inviter = get_user(invite["createdBy"])
        inviter_name = inviter.get("displayName", "A coach") if inviter else "A coach"
    except (FileNotFoundError, KeyError):
        inviter_name = "A coach"

    return {
        "teamName": team["name"],
        "role": invite["role"],
        "invitedBy": inviter_name,
        "expiresAt": invite.get("expiresAt")
    }


@router.post("/api/invites/{code}/redeem")
async def redeem_invite_endpoint(
    code: str,
    user: dict = Depends(get_current_user)
):
    """
    Redeem an invite code.

    Creates a team membership for the authenticated user.
    """
    validate_id(code, "invite code")
    result = redeem_invite(code.upper(), user["id"])

    if not result["success"]:
        status_map = {
            "not_found": 404,
            "expired": 410,
            "revoked": 410,
            "max_uses": 410,
            "already_member": 409,
            "membership_error": 400,
        }
        status = status_map.get(result.get("reason"), 400)
        raise HTTPException(status_code=status, detail=result["error"])

    team = get_team(result["membership"]["teamId"])

    return {
        "status": "joined",
        "membership": result["membership"],
        "team": team
    }


@router.delete("/api/invites/{invite_id}")
async def revoke_invite_endpoint(
    invite_id: str,
    user: dict = Depends(get_current_user)
):
    """
    Revoke an invite.

    Requires: Admin or Coach access to the invite's team.
    """
    invite = get_invite(invite_id)
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")

    # Must be admin or coach of the team
    if not is_admin(user["id"]):
        role = get_user_team_role(user["id"], invite["teamId"])
        if role != "coach":
            raise HTTPException(status_code=403, detail="Coach access required")

    revoke_invite_storage(invite_id, user["id"])
    return {"status": "revoked", "invite_id": invite_id}
