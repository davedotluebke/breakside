"""
Share link endpoints (public no-auth game viewing).

The public share URL is https://www.breakside.pro/view/{hash} — see
ARCHITECTURE.md § Share Links for how that path resolves on each origin
(S3 shim redirect on www/staging, 302 in static_files.py on the API host,
landing at /static/viewer/?share={hash}).
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from ._shared import (
    create_share_link,
    game_exists,
    get_current_user,
    get_game_current,
    get_game_current_mtime_ns,
    get_share,
    get_share_by_hash,
    get_user_team_role,
    is_admin,
    is_share_valid,
    list_all_shares,
    list_game_shares,
    require_game_team_coach,
    revoke_share,
    validate_id,
)

router = APIRouter()


def _share_url(hash: str) -> str:
    """Canonical public URL for a share hash."""
    return f"https://www.breakside.pro/view/{hash}"


def _get_valid_share_or_raise(hash: str) -> dict:
    """Resolve a share hash to a valid share, raising 404/410 like the
    public game endpoint does (shared by /api/share/{hash} and its poll)."""
    validate_id(hash, "share hash")
    share = get_share_by_hash(hash)

    if not share:
        raise HTTPException(status_code=404, detail="Share link not found")

    if not is_share_valid(share):
        raise HTTPException(status_code=410, detail="Share link has expired or been revoked")

    return share


@router.post("/api/games/{game_id}/share")
async def create_game_share(
    game_id: str,
    expires_days: int = Query(default=7, ge=1, le=365),
    listed: bool = Query(default=False),
    user: dict = Depends(require_game_team_coach)
):
    """
    Create a share link for a game.

    Share links allow public (no-auth) access to view the game.

    Args:
        expires_days: Days until the link expires (1-365, default 7)
        listed: Also list the game publicly on the landing page
                (default False — a share link alone stays unlisted)

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
        expires_days=expires_days,
        listed=listed
    )

    return {
        "share": share,
        "url": _share_url(share["hash"])
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

    # Add validity status + canonical URL to each share
    shares_with_status = []
    for share in shares:
        share_copy = dict(share)
        share_copy["isValid"] = is_share_valid(share)
        share_copy["url"] = _share_url(share["hash"])
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
    share = _get_valid_share_or_raise(hash)

    if not game_exists(share["gameId"]):
        raise HTTPException(status_code=404, detail="Game not found")

    game = get_game_current(share["gameId"])
    stamp = get_game_current_mtime_ns(share["gameId"])

    return {
        "game": game,
        # Change stamp matching /api/share/{hash}/poll, so a viewer can seed
        # its poll loop from the initial fetch without an extra request.
        "version": str(stamp) if stamp is not None else None,
        "shareInfo": {
            "expiresAt": share["expiresAt"],
            "createdAt": share["createdAt"]
        }
    }


@router.get("/api/share/{hash}/poll")
async def poll_game_by_share(hash: str):
    """
    Lightweight change poll for a shared game (public, no auth).

    Returns only a change stamp — the viewer refetches the full game via
    GET /api/share/{hash} when the stamp differs from the one it holds.
    Keeps the every-few-seconds live-viewer poll from shipping the whole
    game JSON each time. 410 once the share expires or is revoked, so
    pollers can stop.
    """
    share = _get_valid_share_or_raise(hash)

    stamp = get_game_current_mtime_ns(share["gameId"])
    if stamp is None:
        raise HTTPException(status_code=404, detail="Game not found")

    return {"version": str(stamp)}


@router.get("/api/public/games")
async def list_public_games(limit: int = Query(default=20, ge=1, le=100)):
    """
    Games opted into public listing (public, no auth) — the landing page's
    "recent public games" section.

    Only games with a currently-valid share link created with listed=true
    appear. Returns lightweight cards (names, score, status) sorted by most
    recent game activity, plus the share hash to build the viewer URL.
    """
    listed_shares = [
        s for s in list_all_shares()
        if s.get("listed") and is_share_valid(s)
    ]

    # One card per game. list_all_shares is newest-first, so the hash people
    # get from the landing page is the newest listed share for that game.
    cards = {}
    for share in listed_shares:
        game_id = share["gameId"]
        if game_id in cards:
            continue

        mtime_ns = get_game_current_mtime_ns(game_id)
        if mtime_ns is None:
            continue  # game deleted out from under the share

        try:
            game = get_game_current(game_id)
        except (FileNotFoundError, ValueError):
            continue

        scores = game.get("scores") or {}
        cards[game_id] = {
            "hash": share["hash"],
            "url": _share_url(share["hash"]),
            "team": game.get("team", "Unknown"),
            "opponent": game.get("opponent", "Unknown"),
            "scores": {
                "team": scores.get("team", 0),
                "opponent": scores.get("opponent", 0),
            },
            "gameStartTimestamp": game.get("gameStartTimestamp"),
            "inProgress": not game.get("gameEndTimestamp"),
            "updatedAt": datetime.fromtimestamp(
                mtime_ns / 1e9, tz=timezone.utc
            ).isoformat().replace("+00:00", "Z"),
        }

    games = sorted(cards.values(), key=lambda c: c["updatedAt"], reverse=True)[:limit]
    return {"games": games, "count": len(games)}
