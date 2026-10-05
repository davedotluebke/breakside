"""
Share link endpoints (public no-auth game and event viewing).

The public share URL is https://www.breakside.pro/view/{hash} — see
ARCHITECTURE.md § Share Links for how that path resolves on each origin
(the PWA's head shim boots a guest session from /?share={hash} on
www/staging; static_files.py 302s to the canonical URL on the API host).

A hash opens either one game or one event (storage/share_storage.py
``share_kind``). The URL shape is the same for both; GET /api/share/{hash}
answers with a ``game`` or an ``event`` and the guest renders whichever it
got. An event share reaches each of the event's games through
GET /api/share/{hash}/games/{game_id}, which serves the same public
projection a game share does.
"""
import hashlib
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from ._shared import (
    auth_required,
    create_event_share_link,
    create_share_link,
    event_exists,
    game_exists,
    get_current_user,
    get_event,
    get_event_mtime_ns,
    get_game_current,
    get_game_current_mtime_ns,
    get_share,
    get_share_by_hash,
    get_team,
    get_user_team_role,
    is_admin,
    is_share_valid,
    list_all_shares,
    list_event_shares,
    list_game_shares,
    public_listing_enabled,
    require_event_team_coach,
    require_game_team_coach,
    revoke_share,
    share_kind,
    validate_id,
)

router = APIRouter()


def share_url(hash: str) -> str:
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
                (default False — a share link alone stays unlisted).
                Ignored while public listing is disabled (the default;
                see ``config.public_listing_enabled``): the link is still
                created, just never listed.

    Requires: Coach access to the game's team.
    """
    if not game_exists(game_id):
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")

    # Coerce rather than reject: a PWA still running a cached build with the
    # "List publicly" checkbox should get a working (unlisted) link, not an
    # error, and nothing an anonymous visitor can reach ever reads the flag.
    if listed and not public_listing_enabled():
        listed = False

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
        "url": share_url(share["hash"])
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

    listing_on = public_listing_enabled()
    shares_with_status = [_share_with_status(s, listing_on) for s in shares]
    return {"shares": shares_with_status, "count": len(shares_with_status)}


def _share_with_status(share: dict, listing_on: bool) -> dict:
    """A share as the coach's dialog lists it: validity and canonical URL added."""
    share_copy = dict(share)
    share_copy["isValid"] = is_share_valid(share)
    share_copy["url"] = share_url(share["hash"])
    # Report the *effective* state: a share minted while listing was on
    # keeps listed=true on disk, but it is not on any public list now.
    share_copy["listed"] = bool(share.get("listed")) and listing_on
    return share_copy


@router.post("/api/events/{event_id}/share")
async def create_event_share(
    event_id: str,
    expires_days: int = Query(default=31, ge=1, le=365),
    user: dict = Depends(require_event_team_coach)
):
    """
    Create a share link for an event: the event's stats, and every game the
    event lists — including games added after the link was made.

    Args:
        expires_days: Days until the link expires (1-365, default 31: an
            event is reviewed in the weeks after it, not the days)

    Requires: Coach access to the event's team.
    """
    if not event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")

    event = get_event(event_id)
    team_id = event.get("teamId")
    if not team_id:
        raise HTTPException(status_code=400, detail="Event has no teamId")

    share = create_event_share_link(
        event_id=event_id,
        team_id=team_id,
        created_by=user["id"],
        expires_days=expires_days,
    )
    return {"share": share, "url": share_url(share["hash"])}


@router.get("/api/events/{event_id}/shares")
async def list_event_shares_endpoint(
    event_id: str,
    user: dict = Depends(require_event_team_coach)
):
    """
    List all share links for an event, active and revoked.

    Requires: Coach access to the event's team.
    """
    if not event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")

    listing_on = public_listing_enabled()
    shares = [_share_with_status(s, listing_on) for s in list_event_shares(event_id)]
    return {"shares": shares, "count": len(shares)}


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

    # Must be admin or coach of the team. Skipped when auth is disabled,
    # matching the require_* dependencies (local dev backends run with
    # BREAKSIDE_AUTH_REQUIRED=false and no memberships for the test user).
    if auth_required() and not is_admin(user["id"]):
        role = get_user_team_role(user["id"], share["teamId"])
        if role != "coach":
            raise HTTPException(status_code=403, detail="Coach access required")

    revoke_share(share_id, user["id"])
    return {"status": "revoked", "share_id": share_id}


# =============================================================================
# Public game projection
# =============================================================================
#
# GET /api/share/{hash} is unauthenticated: anyone holding a forwarded link
# gets this payload. It used to return the stored game document verbatim,
# which published a great deal more than the viewer renders — per-player
# gender markers (``rosterSnapshot[].gender``, and ``pullerGender`` on every
# pull event), jersey numbers, the free-text event ``description`` that the
# app auto-fills as "Sub: <names> in for <names>", ``calledByName``, the whole
# roster including players who never took the field, and ``pendingNextLine``
# (the line a coach has queued but not yet called, plus their display name).
# Ultimate rosters routinely include minors, so this is personal data about
# identifiable people who are not users of the app and never agreed to it.
#
# These are ALLOWLISTS on purpose, not denylists. ``pendingNextLine`` became
# public simply by being added to the game model later — nobody decided to
# publish it. A field that is not named below cannot leak no matter what gets
# added upstream, and ``test_shares.py`` pins the exact key set so a future
# addition fails a test instead of quietly shipping.
#
# ``/api/public/games`` already builds an explicit card this way; this brings
# the full-game endpoint in line with it.

_PUBLIC_GAME_FIELDS = (
    "team", "opponent", "scores", "gameStartTimestamp", "gameEndTimestamp",
)
# startingPosition / the timestamps / startedAt feed the viewer's replay
# (docs/replay-viewer-plan.md): who pulled, when each play happened, how
# long a point took. None of it names a person.
_PUBLIC_POINT_FIELDS = (
    "players", "winner", "totalPointTime", "startingPosition",
    "startTimestamp", "endTimestamp",
)
_PUBLIC_POSSESSION_FIELDS = ("offensive", "set", "startedAt")
_PUBLIC_ROSTER_FIELDS = ("id", "name", "nickname")

# Named event fields. The *Id variants stay because the viewer falls back to
# them when the display name is absent, and they cost nothing in privacy
# terms: an id is ``{sanitized-name}-{hash}``, so it carries the same name the
# adjacent ``thrower``/``receiver``/``defender``/``puller`` field already does.
# Boolean ``*_flag`` keys are carried through separately (see below) — they are
# what the play-by-play is made of. ``from``/``to`` (field positions),
# ``at`` (epoch ms) and ``hang`` (pull hang time) are what the viewer's
# replay animates — a spot on the pitch and a clock, not personal data.
# Everything else is dropped, which is what removes ``description``,
# ``calledBy``/``calledByName`` and ``pullerGender``.
_PUBLIC_EVENT_FIELDS = (
    "type", "quality",
    "thrower", "receiver", "defender", "puller",
    "throwerId", "receiverId", "defenderId", "pullerId",
    "from", "to", "at", "hang",
)


def _public_event(event: dict) -> dict:
    out = {k: event[k] for k in _PUBLIC_EVENT_FIELDS if k in event}
    # Every play-by-play qualifier is a boolean flag; requiring the bool type
    # keeps this from becoming a hole if a future "<something>_flag" arrives
    # holding a string or an object.
    out.update({
        k: v for k, v in event.items()
        if k.endswith("_flag") and isinstance(v, bool)
    })
    return out


def _public_possession(possession: dict) -> dict:
    out = {k: possession[k] for k in _PUBLIC_POSSESSION_FIELDS if k in possession}
    out["events"] = [_public_event(e) for e in (possession.get("events") or [])]
    return out


def _public_point(point: dict) -> dict:
    out = {k: point[k] for k in _PUBLIC_POINT_FIELDS if k in point}
    out["possessions"] = [
        _public_possession(p) for p in (point.get("possessions") or [])
    ]
    return out


def _referenced_player_keys(points: list) -> set:
    """Every player id or name the play-by-play actually mentions.

    Used to keep bench players who never appeared in this game out of a public
    payload entirely. Points reference players by id in current games and by
    name in older ones, so both spellings are collected.
    """
    seen = set()
    for point in points or []:
        for p in point.get("players") or []:
            if p:
                seen.add(p)
        for possession in point.get("possessions") or []:
            for event in possession.get("events") or []:
                for field in ("thrower", "receiver", "defender", "puller",
                              "throwerId", "receiverId", "defenderId", "pullerId"):
                    value = event.get(field)
                    if value:
                        seen.add(value)
    return seen


def _public_game_view(game: dict) -> dict:
    """Project a stored game down to what an anonymous share visitor may see."""
    points = game.get("points") or []

    view = {k: game[k] for k in _PUBLIC_GAME_FIELDS if k in game}
    view["points"] = [_public_point(p) for p in points]

    # Only emit rosterSnapshot when the stored game has one, so a legacy game
    # without it still reads as legacy to the viewer.
    if isinstance(game.get("rosterSnapshot"), dict):
        referenced = _referenced_player_keys(points)
        view["rosterSnapshot"] = {
            "players": [
                {k: p[k] for k in _PUBLIC_ROSTER_FIELDS if k in p}
                for p in (game["rosterSnapshot"].get("players") or [])
                if referenced & {p.get("id"), p.get("name"), p.get("nickname")}
            ]
        }

    return view


# Stats levels a team may hold its viewers to (Team Settings → Viewer Stats).
# A share guest is a viewer too, so the level travels with the share payload
# and the PWA applies it (utils/statsAudience.js). Team policy, not game data:
# it sits beside ``game`` rather than inside the allowlisted projection.
_RESTRICTABLE_STATS_LEVELS = ("fun",)


def _viewer_stats_level(team_id):
    """The team's viewer stats restriction, or None (no team, no setting)."""
    if not team_id:
        return None
    try:
        level = get_team(team_id).get("viewerStatsLevel")
    except FileNotFoundError:
        return None
    return level if level in _RESTRICTABLE_STATS_LEVELS else None


# =============================================================================
# Public event projection
# =============================================================================
#
# An event share publishes the event's name and phase list, and one card per
# game: the two team names, the score and the timing — what a tournament's
# public schedule board shows. The card carries the game's id because it is
# the key the guest fetches the game by (GET /api/share/{hash}/games/{id});
# an id is "{date}_{team}_vs_{opponent}_{hash}", nothing the card doesn't
# already say. Per-player data comes only through the per-game endpoint,
# which applies the same allowlist as a game share.

# "Tournament" to keep clear of _PUBLIC_EVENT_FIELDS above, which is the
# allowlist for play-by-play events.
_PUBLIC_TOURNAMENT_FIELDS = ("name", "phases", "status")


def _public_tournament_view(event: dict) -> dict:
    view = {k: event[k] for k in _PUBLIC_TOURNAMENT_FIELDS if k in event}
    view.setdefault("phases", [])
    return view


def _event_game_cards(event: dict) -> list:
    """One public card per game the event lists, chronological.

    A game that no longer exists is skipped rather than failing the whole
    payload: the event's gameIds are kept by the server on game delete, but
    a half-finished delete or a restore can leave a dangling id.
    """
    cards = []
    for game_id in event.get("gameIds") or []:
        stamp = get_game_current_mtime_ns(game_id)
        if stamp is None:
            continue
        try:
            game = get_game_current(game_id)
        except (FileNotFoundError, ValueError):
            continue
        scores = game.get("scores") or {}
        cards.append({
            "id": game_id,
            "phase": game.get("phase"),
            "team": game.get("team", "Unknown"),
            "opponent": game.get("opponent", "Unknown"),
            "scores": {
                "team": scores.get("team", 0),
                "opponent": scores.get("opponent", 0),
            },
            "gameStartTimestamp": game.get("gameStartTimestamp"),
            "gameEndTimestamp": game.get("gameEndTimestamp"),
            # Per-game change stamp (= that game's poll version), so a guest
            # refetches only the games that moved when the event stamp does.
            "version": str(stamp),
            "updatedAt": datetime.fromtimestamp(
                stamp / 1e9, tz=timezone.utc
            ).isoformat().replace("+00:00", "Z"),
        })
    cards.sort(key=lambda c: (c["gameStartTimestamp"] is None, c["gameStartTimestamp"] or "", c["id"]))
    return cards


def _event_version(event_id: str, cards: list) -> str:
    """Change stamp for a shared event: moves when the event document or any
    listed game changes, or a game joins or leaves the event."""
    parts = [str(get_event_mtime_ns(event_id))]
    parts.extend(f"{c['id']}:{c['version']}" for c in cards)
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _shared_event_or_raise(share: dict) -> dict:
    """The event an event share opens, or 404 when it has been deleted."""
    event_id = share.get("eventId")
    if not event_id or not event_exists(event_id):
        raise HTTPException(status_code=404, detail="Event not found")
    return get_event(event_id)


def _shared_event_game_or_raise(share: dict, game_id: str) -> dict:
    """A game reachable through an event share: it must be one the event
    lists *now* (so a game removed from the event drops off the link) and
    still exist. 404 either way — a guest cannot tell the two apart, and
    should not be able to probe which game ids exist."""
    validate_id(game_id, "game_id")
    event = _shared_event_or_raise(share)
    if game_id not in (event.get("gameIds") or []) or not game_exists(game_id):
        raise HTTPException(status_code=404, detail="Game not found")
    return get_game_current(game_id)


def _share_info(share: dict) -> dict:
    return {"expiresAt": share["expiresAt"], "createdAt": share["createdAt"]}


def _public_game_payload(share: dict, game_id: str, game: dict) -> dict:
    stamp = get_game_current_mtime_ns(game_id)
    return {
        "game": _public_game_view(game),
        # Change stamp matching the poll endpoint, so a viewer can seed its
        # poll loop from the initial fetch without an extra request.
        "version": str(stamp) if stamp is not None else None,
        "viewerStatsLevel": _viewer_stats_level(game.get("teamId")),
        "shareInfo": _share_info(share),
    }


@router.get("/api/share/{hash}")
async def get_game_by_share(hash: str):
    """
    Get what a share link opens: one game, or one event.

    This is a public endpoint - no authentication required, so the game is
    projected through ``_public_game_view`` rather than returned as stored,
    and an event through ``_public_tournament_view`` plus a card per game.
    """
    share = _get_valid_share_or_raise(hash)

    if share_kind(share) == "event":
        event = _shared_event_or_raise(share)
        cards = _event_game_cards(event)
        return {
            "event": _public_tournament_view(event),
            "games": cards,
            "version": _event_version(share["eventId"], cards),
            "viewerStatsLevel": _viewer_stats_level(event.get("teamId")),
            "shareInfo": _share_info(share),
        }

    if not game_exists(share["gameId"]):
        raise HTTPException(status_code=404, detail="Game not found")

    return _public_game_payload(share, share["gameId"], get_game_current(share["gameId"]))


@router.get("/api/share/{hash}/poll")
async def poll_game_by_share(hash: str):
    """
    Lightweight change poll for a shared game or event (public, no auth).

    Returns only a change stamp — the viewer refetches the full payload via
    GET /api/share/{hash} when the stamp differs from the one it holds.
    Keeps the every-few-seconds live-viewer poll from shipping the whole
    game JSON each time. 410 once the share expires or is revoked, so
    pollers can stop.
    """
    share = _get_valid_share_or_raise(hash)

    if share_kind(share) == "event":
        event = _shared_event_or_raise(share)
        return {"version": _event_version(share["eventId"], _event_game_cards(event))}

    stamp = get_game_current_mtime_ns(share["gameId"])
    if stamp is None:
        raise HTTPException(status_code=404, detail="Game not found")

    return {"version": str(stamp)}


@router.get("/api/share/{hash}/games/{game_id}")
async def get_event_share_game(hash: str, game_id: str):
    """
    One of a shared event's games (public, no auth): the same projection a
    game share serves. 404 for a hash that opens a single game, for a game
    the event does not list, and for a deleted game.
    """
    share = _get_valid_share_or_raise(hash)
    if share_kind(share) != "event":
        raise HTTPException(status_code=404, detail="Game not found")
    game = _shared_event_game_or_raise(share, game_id)
    return _public_game_payload(share, game_id, game)


@router.get("/api/share/{hash}/games/{game_id}/poll")
async def poll_event_share_game(hash: str, game_id: str):
    """Change stamp for one of a shared event's games (public, no auth)."""
    share = _get_valid_share_or_raise(hash)
    if share_kind(share) != "event":
        raise HTTPException(status_code=404, detail="Game not found")
    _shared_event_game_or_raise(share, game_id)
    stamp = get_game_current_mtime_ns(game_id)
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

    404 while public listing is disabled (the default — see
    ``config.public_listing_enabled`` for why). The landing page's consumer
    treats any non-2xx as "no games" and stays hidden.
    """
    if not public_listing_enabled():
        raise HTTPException(status_code=404, detail="Public game listing is disabled")

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
            "url": share_url(share["hash"]),
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
