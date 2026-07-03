"""
Share link endpoints (public no-auth game viewing).
"""
from fastapi import APIRouter, Depends, HTTPException, Query

from ._shared import (
    create_share_link,
    game_exists,
    get_current_user,
    get_game_current,
    get_share,
    get_share_by_hash,
    get_user_team_role,
    is_admin,
    is_share_valid,
    list_game_shares,
    require_game_team_coach,
    revoke_share,
    validate_id,
)

router = APIRouter()


@router.post("/api/games/{game_id}/share")
async def create_game_share(
    game_id: str,
    expires_days: int = Query(default=7, ge=1, le=365),
    user: dict = Depends(require_game_team_coach)
):
    """
    Create a share link for a game.

    Share links allow public (no-auth) access to view the game.

    Args:
        expires_days: Days until the link expires (1-365, default 7)

    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")

    game = get_game_current(game_id)
    team_id = game.get("teamId")

    if not team_id:
        raise HTTPException(status_code=400, detail="Game has no teamId")

    share = create_share_link(
        game_id=game_id,
        team_id=team_id,
        created_by=user["id"],
        expires_days=expires_days
    )

    return {
        "share": share,
        "url": f"https://www.breakside.pro/share/{share['hash']}"
    }


@router.get("/api/games/{game_id}/shares")
async def list_game_shares_endpoint(
    game_id: str,
    user: dict = Depends(require_game_team_coach)
):
    """
    List all share links for a game.

    Includes both active and revoked links.

    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")

    shares = list_game_shares(game_id)

    # Add validity status to each share
    shares_with_status = []
    for share in shares:
        share_copy = dict(share)
        share_copy["isValid"] = is_share_valid(share)
        shares_with_status.append(share_copy)

    return {"shares": shares_with_status, "count": len(shares_with_status)}


@router.delete("/api/shares/{share_id}")
async def revoke_share_endpoint(
    share_id: str,
    user: dict = Depends(get_current_user)
):
    """
    Revoke a share link.

    Requires: Admin or Coach access to the share's team.
    """
    share = get_share(share_id)
    if not share:
        raise HTTPException(status_code=404, detail="Share link not found")

    # Must be admin or coach of the team
    if not is_admin(user["id"]):
        role = get_user_team_role(user["id"], share["teamId"])
        if role != "coach":
            raise HTTPException(status_code=403, detail="Coach access required")

    revoke_share(share_id, user["id"])
    return {"status": "revoked", "share_id": share_id}


@router.get("/api/share/{hash}")
async def get_game_by_share(hash: str):
    """
    Get a game via a share link.

    This is a public endpoint - no authentication required.
    """
    validate_id(hash, "share hash")
    share = get_share_by_hash(hash)

    if not share:
        raise HTTPException(status_code=404, detail="Share link not found")

    if not is_share_valid(share):
        raise HTTPException(status_code=410, detail="Share link has expired or been revoked")

    if not game_exists(share["gameId"]):
        raise HTTPException(status_code=404, detail="Game not found")

    game = get_game_current(share["gameId"])

    return {
        "game": game,
        "shareInfo": {
            "expiresAt": share["expiresAt"],
            "createdAt": share["createdAt"]
        }
    }
