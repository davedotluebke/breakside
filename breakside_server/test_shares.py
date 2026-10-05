"""
Tests for the public share-link flow: /view/{hash} routing, the listed flag,
the lightweight share poll, and the public games listing.

The share endpoints existed before 2026-07 but nothing consumed them (no PWA
UI, no /view route, viewer used auth-required endpoints); these tests pin the
end-to-end contract added when sharing was wired up for real:

- POST /api/games/{id}/share mints /view/{hash} URLs and honors ?listed=
  only while public listing is enabled (BREAKSIDE_PUBLIC_LISTING=true; the
  default is off, and then ?listed= is ignored and /api/public/games is 404)
- GET  /api/share/{hash} is public and carries a change stamp ("version")
- GET  /api/share/{hash}/poll is the cheap live-poll (stamp only, 410 on
  expiry/revoke so pollers stop)
- GET  /api/public/games lists only valid listed shares, one card per game
- GET  /view/{hash} 302s to the canonical www share URL (the PWA renders
  share links as a guest session; this host serves no copy of the app)
- Event shares (2026-10): POST /api/events/{id}/share mints the same kind of
  URL; GET /api/share/{hash} then answers with the event + a card per game,
  and GET /api/share/{hash}/games/{game_id} serves each listed game through
  the game projection. A game the event does not list is 404 through it.

Run: cd breakside_server && python -m pytest test_shares.py -v
"""
import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient


COACH = {"id": "share-coach", "email": "coach@test", "role": "authenticated"}
VIEWER = {"id": "share-viewer", "email": "viewer@test", "role": "authenticated"}

GAME_ID = "2026-07-01_Share-Test-Team_vs_Rivals_sh4re"
GAME_ID_2 = "2026-07-02_Share-Test-Team_vs_Others_sh4r2"


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """Temp data dir with one team (COACH is coach) and two games.
    Restores patched config/storage dirs on teardown."""
    data_dir = tmp_path_factory.mktemp("share_test_data")

    import config
    from storage import (
        game_storage, team_storage, player_storage, membership_storage,
        share_storage, index_storage, event_storage,
    )

    patches = [
        (config, "DATA_DIR", data_dir),
        (config, "GAMES_DIR", data_dir / "games"),
        (config, "TEAMS_DIR", data_dir / "teams"),
        (config, "PLAYERS_DIR", data_dir / "players"),
        (config, "USERS_DIR", data_dir / "users"),
        (config, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (config, "SHARES_DIR", data_dir / "shares"),
        (config, "EVENTS_DIR", data_dir / "events"),
        (config, "INDEX_FILE", data_dir / "index.json"),
        (game_storage, "GAMES_DIR", data_dir / "games"),
        (event_storage, "EVENTS_DIR", data_dir / "events"),
        (team_storage, "TEAMS_DIR", data_dir / "teams"),
        (player_storage, "PLAYERS_DIR", data_dir / "players"),
        (membership_storage, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (membership_storage, "INDEX_FILE", data_dir / "memberships" / "_index.json"),
        (share_storage, "SHARES_DIR", data_dir / "shares"),
        (share_storage, "INDEX_FILE", data_dir / "shares" / "_index.json"),
        (index_storage, "INDEX_FILE", data_dir / "index.json"),
        (index_storage, "GAMES_DIR", data_dir / "games"),
        (index_storage, "TEAMS_DIR", data_dir / "teams"),
        (index_storage, "PLAYERS_DIR", data_dir / "players"),
    ]
    saved = [(mod, name, getattr(mod, name)) for mod, name, _ in patches]
    for mod, name, value in patches:
        if name.endswith("_DIR"):
            value.mkdir(parents=True, exist_ok=True)
        setattr(mod, name, value)

    team_id = team_storage.save_team({"name": "Share Test Team", "playerIds": []})
    membership_storage.create_membership(
        team_id=team_id, user_id=COACH["id"], role="coach")
    membership_storage.create_membership(
        team_id=team_id, user_id=VIEWER["id"], role="viewer")

    for gid, opponent, started, ended, phase in (
        (GAME_ID, "Rivals", "2026-07-01T18:00:00Z", None, "Pool"),
        (GAME_ID_2, "Others", "2026-07-02T18:00:00Z", "2026-07-02T20:00:00Z", "Bracket"),
    ):
        game_storage.save_game_version(gid, {
            "id": gid,
            "teamId": team_id,
            "team": "Share Test Team",
            "opponent": opponent,
            "scores": {"team": 3, "opponent": 1},
            "gameStartTimestamp": started,
            "gameEndTimestamp": ended,
            "phase": phase,
            "points": [],
        })
    index_storage.rebuild_index()

    # Both games in one event (the second is listed first, so the public
    # cards' chronological order is something the test can observe).
    event_id = event_storage.save_event({
        "name": "Fall Classic",
        "teamId": team_id,
        "gameIds": [GAME_ID_2, GAME_ID],
        "phases": ["Pool", "Bracket"],
        "roster": {"playerIds": ["Secret-0001"], "pickupPlayers": []},
        "defaults": {"playersPerSide": 7},
    })

    yield {"data_dir": data_dir, "team_id": team_id, "event_id": event_id}

    for mod, name, original in saved:
        setattr(mod, name, original)


@pytest.fixture
def client(seeded, monkeypatch):
    monkeypatch.setenv("BREAKSIDE_AUTH_REQUIRED", "true")
    from main import app
    c = TestClient(app)
    yield c
    app.dependency_overrides.clear()


@pytest.fixture
def listing_on(monkeypatch):
    """Turn the (default-off) public listing on for one test."""
    monkeypatch.setenv("BREAKSIDE_PUBLIC_LISTING", "true")


@pytest.fixture(autouse=True)
def clean_shares(seeded):
    """Each test starts with no shares on the books."""
    from storage import share_storage
    yield
    for share in share_storage.list_all_shares():
        share_storage.delete_share(share["id"])


def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


def _anon():
    """Drop any auth override so the request runs as a true anonymous."""
    from main import app
    app.dependency_overrides.clear()


def _mint(game_id=GAME_ID, listed=False, **kwargs):
    from storage import share_storage
    from storage.team_storage import list_teams  # noqa: F401 (import guard)
    return share_storage.create_share_link(
        game_id=game_id, team_id="Share-Test-Team", created_by=COACH["id"],
        listed=listed, **kwargs)


def _mint_event(event_id, team_id="Share-Test-Team", **kwargs):
    from storage import share_storage
    return share_storage.create_event_share_link(
        event_id=event_id, team_id=team_id, created_by=COACH["id"], **kwargs)


def _expire(share):
    from storage import share_storage
    from storage.file_utils import atomic_write_json
    share["expiresAt"] = (
        datetime.now(timezone.utc) - timedelta(days=1)
    ).isoformat().replace("+00:00", "Z")
    atomic_write_json(share_storage._share_file(share["id"]), share)


class TestCreateShare:
    def test_mints_view_url_and_defaults_unlisted(self, client, seeded):
        _as(COACH)
        r = client.post(f"/api/games/{GAME_ID}/share")
        assert r.status_code == 200
        body = r.json()
        assert body["url"] == f"https://www.breakside.pro/view/{body['share']['hash']}"
        assert body["share"]["listed"] is False

    def test_listed_flag_round_trips(self, client, seeded, listing_on):
        _as(COACH)
        r = client.post(f"/api/games/{GAME_ID}/share?listed=true")
        assert r.status_code == 200
        assert r.json()["share"]["listed"] is True

    def test_viewer_cannot_create(self, client, seeded):
        _as(VIEWER)
        assert client.post(f"/api/games/{GAME_ID}/share").status_code == 403

    def test_share_list_includes_urls(self, client, seeded):
        _mint()
        _as(COACH)
        r = client.get(f"/api/games/{GAME_ID}/shares")
        assert r.status_code == 200
        share = r.json()["shares"][0]
        assert share["url"] == f"https://www.breakside.pro/view/{share['hash']}"
        assert share["isValid"] is True


class TestPublicShareFetch:
    def test_anonymous_fetch_returns_game_and_stamp(self, client, seeded):
        share = _mint()
        _anon()
        r = client.get(f"/api/share/{share['hash']}")
        assert r.status_code == 200
        body = r.json()
        assert body["game"]["opponent"] == "Rivals"
        assert body["shareInfo"]["expiresAt"] == share["expiresAt"]
        assert body["version"]  # change stamp seeds the poll loop

    def test_viewer_stats_level_follows_the_team_setting(self, client, seeded):
        from storage import team_storage
        team_id = seeded["team_id"]
        share = _mint()
        _anon()
        assert client.get(f"/api/share/{share['hash']}").json()["viewerStatsLevel"] is None
        team = team_storage.get_team(team_id)
        try:
            team_storage.update_team(team_id, {**team, "viewerStatsLevel": "fun"})
            assert client.get(f"/api/share/{share['hash']}").json()["viewerStatsLevel"] == "fun"
            # Only known levels pass through.
            team_storage.update_team(team_id, {**team, "viewerStatsLevel": "<script>"})
            assert client.get(f"/api/share/{share['hash']}").json()["viewerStatsLevel"] is None
        finally:
            team_storage.update_team(team_id, team)

    def test_unknown_hash_404(self, client, seeded):
        _anon()
        assert client.get("/api/share/deadbeef0000").status_code == 404

    def test_expired_share_410(self, client, seeded):
        share = _mint()
        _expire(share)
        _anon()
        assert client.get(f"/api/share/{share['hash']}").status_code == 410

    def test_revoked_share_410(self, client, seeded):
        from storage import share_storage
        share = _mint()
        share_storage.revoke_share(share["id"], COACH["id"])
        _anon()
        assert client.get(f"/api/share/{share['hash']}").status_code == 410


class TestSharePoll:
    def test_poll_returns_stamp_matching_full_fetch(self, client, seeded):
        share = _mint()
        _anon()
        full = client.get(f"/api/share/{share['hash']}").json()
        poll = client.get(f"/api/share/{share['hash']}/poll")
        assert poll.status_code == 200
        assert poll.json()["version"] == full["version"]

    def test_stamp_changes_when_game_changes(self, client, seeded):
        from storage import game_storage
        share = _mint()
        _anon()
        before = client.get(f"/api/share/{share['hash']}/poll").json()["version"]

        # Deterministic change: bump current.json's mtime explicitly rather
        # than racing filesystem timestamp resolution with a re-save.
        current = game_storage.GAMES_DIR / GAME_ID / "current.json"
        st = current.stat()
        os.utime(current, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))

        after = client.get(f"/api/share/{share['hash']}/poll").json()["version"]
        assert after != before

    def test_poll_410_when_share_dies(self, client, seeded):
        """Pollers rely on 410 to stop a dead viewer loop."""
        from storage import share_storage
        share = _mint()
        _anon()
        assert client.get(f"/api/share/{share['hash']}/poll").status_code == 200
        share_storage.revoke_share(share["id"], COACH["id"])
        assert client.get(f"/api/share/{share['hash']}/poll").status_code == 410


class TestPublicListingDisabled:
    """The default. Public listing is off unless BREAKSIDE_PUBLIC_LISTING=true
    (config.public_listing_enabled explains why); production never sets it.
    Share links themselves are untouched."""

    def test_public_games_endpoint_is_404(self, client, seeded):
        _mint(listed=True)  # a listed share on disk still lists nothing
        _anon()
        assert client.get("/api/public/games").status_code == 404

    def test_listed_param_is_ignored_not_rejected(self, client, seeded):
        # A cached PWA build that still sends ?listed=true must get a
        # working link, just an unlisted one.
        _as(COACH)
        r = client.post(f"/api/games/{GAME_ID}/share?listed=true")
        assert r.status_code == 200
        body = r.json()
        assert body["share"]["listed"] is False
        assert body["url"].startswith("https://www.breakside.pro/view/")

    def test_share_list_reports_effective_listed_state(self, client, seeded):
        # Minted while listing was on: listed=true on disk, but not public now.
        share = _mint(listed=True)
        _as(COACH)
        r = client.get(f"/api/games/{GAME_ID}/shares")
        assert r.status_code == 200
        [row] = r.json()["shares"]
        assert row["hash"] == share["hash"]
        assert row["listed"] is False
        assert row["isValid"] is True  # the link itself still works

    def test_share_links_still_work(self, client, seeded):
        share = _mint(listed=True)
        _anon()
        assert client.get(f"/api/share/{share['hash']}").status_code == 200


@pytest.mark.usefixtures("listing_on")
class TestPublicGamesList:
    def test_share_list_reports_listed_when_enabled(self, client, seeded):
        _mint(listed=True)
        _as(COACH)
        [row] = client.get(f"/api/games/{GAME_ID}/shares").json()["shares"]
        assert row["listed"] is True

    def test_empty_when_nothing_listed(self, client, seeded):
        _mint(listed=False)  # a private share link is NOT a public listing
        _anon()
        r = client.get("/api/public/games")
        assert r.status_code == 200
        assert r.json() == {"games": [], "count": 0}

    def test_listed_share_appears_with_card_fields(self, client, seeded):
        share = _mint(listed=True)
        _anon()
        r = client.get("/api/public/games")
        assert r.status_code == 200
        games = r.json()["games"]
        assert len(games) == 1
        card = games[0]
        assert card["hash"] == share["hash"]
        assert card["url"] == f"https://www.breakside.pro/view/{share['hash']}"
        assert card["team"] == "Share Test Team"
        assert card["opponent"] == "Rivals"
        assert card["scores"] == {"team": 3, "opponent": 1}
        assert card["inProgress"] is True  # no gameEndTimestamp
        assert card["updatedAt"]

    def test_finished_game_not_in_progress(self, client, seeded):
        _mint(game_id=GAME_ID_2, listed=True)
        _anon()
        card = client.get("/api/public/games").json()["games"][0]
        assert card["opponent"] == "Others"
        assert card["inProgress"] is False

    def test_expired_or_revoked_listed_shares_drop_out(self, client, seeded):
        from storage import share_storage
        expired = _mint(listed=True)
        _expire(expired)
        revoked = _mint(game_id=GAME_ID_2, listed=True)
        share_storage.revoke_share(revoked["id"], COACH["id"])
        _anon()
        assert client.get("/api/public/games").json()["count"] == 0

    def test_one_card_per_game_newest_share_wins(self, client, seeded):
        older = _mint(listed=True)
        # Force distinct createdAt ordering (same-instant mints tie otherwise).
        from storage import share_storage
        from storage.file_utils import atomic_write_json
        older["createdAt"] = "2026-01-01T00:00:00Z"
        atomic_write_json(share_storage._share_file(older["id"]), older)
        newer = _mint(listed=True)
        _anon()
        games = client.get("/api/public/games").json()["games"]
        assert len(games) == 1
        assert games[0]["hash"] == newer["hash"]

    def test_respects_limit(self, client, seeded):
        _mint(listed=True)
        _mint(game_id=GAME_ID_2, listed=True)
        _anon()
        r = client.get("/api/public/games?limit=1")
        assert r.json()["count"] == 1


class TestViewShortLink:
    """/view/{hash} on the API host must REDIRECT to the canonical share URL
    (the PWA on www renders share links as a guest session), never serve
    HTML in place — this host has no copy of the app at that path."""

    def test_redirects_to_canonical_share_url(self, client, seeded):
        r = client.get("/view/a8f3e2b1c9d4", follow_redirects=False)
        assert r.status_code == 302
        assert r.headers["location"] == "https://www.breakside.pro/view/a8f3e2b1c9d4"

    def test_asset_like_paths_rejected(self, client, seeded):
        for path in ("/view/viewer.js", "/view/viewer.css"):
            assert client.get(path, follow_redirects=False).status_code == 404, path

    def test_redirect_resolves_even_for_unknown_hash(self, client, seeded):
        # The redirect is routing, not validation — the viewer itself shows
        # the not-found/expired state from the API's 404/410.
        r = client.get("/view/ffffffffffff", follow_redirects=False)
        assert r.status_code == 302


# =============================================================================
# Public game projection
# =============================================================================

RICH_GAME_ID = "2026-07-03_Share-Test-Team_vs_Privacy_pr1v"


def _seed_rich_game(seeded):
    """A game carrying every field the raw document used to leak publicly."""
    from storage import game_storage
    game_storage.save_game_version(RICH_GAME_ID, {
        "id": RICH_GAME_ID,
        "teamId": seeded["team_id"],
        "eventId": "tournament-xyz",
        "phase": "pool-play",
        "team": "Share Test Team",
        "opponent": "Privacy FC",
        "scores": {"team": 1, "opponent": 0},
        "gameStartTimestamp": "2026-07-03T18:00:00Z",
        "gameEndTimestamp": None,
        "startingPosition": "offense",
        "alternateGenderRatio": True,
        "startingGenderRatio": "4-3",
        "lastLineUsed": ["Played-1111"],
        # The line the coach has queued but not yet called, plus who set it.
        "pendingNextLine": {
            "oLine": ["Played-1111", "Benched-2222"],
            "lineupReadyBy": "Coach Real Name",
            "lineCoachViewing": "Coach Real Name",
        },
        "rosterSnapshot": {"players": [
            {"id": "Played-1111", "name": "Played Player", "nickname": "Pip",
             "number": 7, "gender": "FMP", "position": "handler",
             "defaultLine": "O"},
            # Never appears in the play-by-play — should not be published at all.
            {"id": "Benched-2222", "name": "Benched Player", "nickname": "Benchy",
             "number": 99, "gender": "MMP"},
        ]},
        "points": [{
            "players": ["Played-1111"],
            "winner": "team",
            "totalPointTime": 42000,
            "startTimestamp": "2026-07-03T18:01:00Z",
            "endTimestamp": "2026-07-03T18:01:42Z",
            "lastPauseTime": 1234,
            "startingPosition": "offense",
            "substitutedOutPlayers": ["Benched-2222"],
            "possessions": [{
                "offensive": True,
                "set": "vert stack",
                "startedAt": 1751565660000,
                "events": [
                    {"type": "Pull", "puller": "Played Player",
                     "pullerId": "Played-1111", "pullerGender": "FMP",
                     "quality": "good", "io_flag": True, "hang": 1500,
                     "at": 1751565660000,
                     "from": {"x": 0, "y": 0.5}, "to": {"x": 0.8, "y": 0.4}},
                    {"type": "Throw", "thrower": "Played Player",
                     "throwerId": "Played-1111", "receiver": "Played Player",
                     "receiverId": "Played-1111", "score_flag": True,
                     "huck_flag": False},
                    {"type": "Other", "injury_flag": True,
                     "description": "Sub: Played Player in for Benched Player",
                     "calledBy": "coach-uid", "calledByName": "Coach Real Name"},
                ],
            }],
        }],
    })


def _shared_game(client, seeded):
    _seed_rich_game(seeded)
    share = _mint(game_id=RICH_GAME_ID)
    _anon()
    r = client.get(f"/api/share/{share['hash']}")
    assert r.status_code == 200
    return r.json()["game"]


class TestPublicGameProjection:
    """GET /api/share/{hash} is anonymous — it must publish only what the
    viewer renders, not the stored document."""

    def test_top_level_keys_are_exactly_the_allowlist(self, client, seeded):
        game = _shared_game(client, seeded)
        assert set(game) == {
            "team", "opponent", "scores",
            "gameStartTimestamp", "gameEndTimestamp",
            "points", "rosterSnapshot",
        }

    def test_internal_and_coaching_fields_are_gone(self, client, seeded):
        game = _shared_game(client, seeded)
        for leaked in ("pendingNextLine", "teamId", "id", "eventId", "phase",
                       "lastLineUsed", "startingGenderRatio",
                       "alternateGenderRatio", "startingPosition"):
            assert leaked not in game, leaked

    def test_roster_drops_gender_jersey_and_coaching_metadata(self, client, seeded):
        game = _shared_game(client, seeded)
        players = game["rosterSnapshot"]["players"]
        assert players, "the player who appeared should still be published"
        for p in players:
            assert set(p) <= {"id", "name", "nickname"}, p
            for leaked in ("gender", "number", "position", "defaultLine"):
                assert leaked not in p, leaked

    def test_players_who_never_appeared_are_not_published(self, client, seeded):
        game = _shared_game(client, seeded)
        names = {p.get("name") for p in game["rosterSnapshot"]["players"]}
        assert "Played Player" in names
        assert "Benched Player" not in names

    def test_event_pii_is_stripped(self, client, seeded):
        game = _shared_game(client, seeded)
        events = game["points"][0]["possessions"][0]["events"]
        for ev in events:
            for leaked in ("pullerGender", "description",
                           "calledBy", "calledByName"):
                assert leaked not in ev, f"{leaked} in {ev}"

    def test_replay_fields_are_published(self, client, seeded):
        """The viewer's replay (docs/replay-viewer-plan.md) animates field
        positions and real timing — a spot on the pitch and a clock, not
        personal data — so those survive the projection."""
        game = _shared_game(client, seeded)
        point = game["points"][0]
        assert point["startingPosition"] == "offense"
        assert point["startTimestamp"] == "2026-07-03T18:01:00Z"
        assert point["endTimestamp"] == "2026-07-03T18:01:42Z"
        possession = point["possessions"][0]
        assert possession["startedAt"] == 1751565660000
        pull = possession["events"][0]
        assert pull["from"] == {"x": 0, "y": 0.5}
        assert pull["to"] == {"x": 0.8, "y": 0.4}
        assert pull["at"] == 1751565660000
        assert pull["hang"] == 1500

    def test_point_level_extras_are_stripped(self, client, seeded):
        game = _shared_game(client, seeded)
        point = game["points"][0]
        assert set(point) == {"players", "winner", "totalPointTime", "possessions",
                              "startingPosition", "startTimestamp", "endTimestamp"}
        assert "substitutedOutPlayers" not in point
        assert "lastPauseTime" not in point

    def test_the_viewer_still_gets_what_it_renders(self, client, seeded):
        """The projection must not break the play-by-play."""
        game = _shared_game(client, seeded)
        assert game["team"] == "Share Test Team"
        assert game["opponent"] == "Privacy FC"
        assert game["scores"] == {"team": 1, "opponent": 0}

        point = game["points"][0]
        assert point["winner"] == "team"
        assert point["totalPointTime"] == 42000
        assert point["players"] == ["Played-1111"]

        possession = point["possessions"][0]
        assert possession["offensive"] is True
        assert possession["set"] == "vert stack"

        pull, throw, other = possession["events"]
        assert pull["type"] == "Pull"
        assert pull["puller"] == "Played Player"
        assert pull["quality"] == "good"
        assert pull["io_flag"] is True          # boolean flags survive
        assert throw["score_flag"] is True
        assert throw["huck_flag"] is False      # False is kept, not dropped
        assert throw["receiver"] == "Played Player"
        # The injury event still renders as play-by-play; only the naming goes.
        assert other["injury_flag"] is True

        # Name lookup still resolves: the id the point references is published.
        roster_ids = {p["id"] for p in game["rosterSnapshot"]["players"]}
        assert "Played-1111" in roster_ids

    def test_non_boolean_flag_lookalike_is_not_carried(self, client, seeded):
        """`*_flag` is carried by pattern, so pin the isinstance guard."""
        from routers.shares import _public_event
        out = _public_event({"type": "Other", "note_flag": {"nested": "object"},
                             "real_flag": True})
        assert out == {"type": "Other", "real_flag": True}

    def test_legacy_game_without_roster_snapshot_stays_legacy(self, client, seeded):
        from routers.shares import _public_game_view
        view = _public_game_view({"team": "A", "opponent": "B", "points": []})
        assert "rosterSnapshot" not in view


# =============================================================================
# Event shares
# =============================================================================

GAME_CARD_KEYS = {
    "id", "phase", "team", "opponent", "scores",
    "gameStartTimestamp", "gameEndTimestamp", "version", "updatedAt",
}


class TestEventShares:
    """One link for a whole event: the event's stats page plus every game the
    event lists, reached through the same public projection a game share
    uses."""

    def test_coach_mints_an_event_link(self, client, seeded):
        _as(COACH)
        r = client.post(f"/api/events/{seeded['event_id']}/share")
        assert r.status_code == 200
        body = r.json()
        assert body["url"] == f"https://www.breakside.pro/view/{body['share']['hash']}"
        assert body["share"]["kind"] == "event"
        assert body["share"]["eventId"] == seeded["event_id"]
        assert "gameId" not in body["share"]
        assert body["share"]["listed"] is False

    def test_event_links_default_to_a_month(self, client, seeded):
        _as(COACH)
        share = client.post(f"/api/events/{seeded['event_id']}/share").json()["share"]
        created = datetime.fromisoformat(share["createdAt"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(share["expiresAt"].replace("Z", "+00:00"))
        assert (expires - created).days == 31

    def test_viewer_cannot_create_an_event_link(self, client, seeded):
        _as(VIEWER)
        assert client.post(f"/api/events/{seeded['event_id']}/share").status_code == 403

    def test_unknown_event_404(self, client, seeded):
        _as(COACH)
        assert client.post("/api/events/No-Such-Event-0000/share").status_code == 404

    def test_event_share_list_carries_urls_and_validity(self, client, seeded):
        from storage import share_storage
        share = _mint_event(seeded["event_id"])
        revoked = _mint_event(seeded["event_id"])
        share_storage.revoke_share(revoked["id"], COACH["id"])
        _as(COACH)
        r = client.get(f"/api/events/{seeded['event_id']}/shares")
        assert r.status_code == 200
        rows = {s["id"]: s for s in r.json()["shares"]}
        assert rows[share["id"]]["isValid"] is True
        assert rows[share["id"]]["url"] == f"https://www.breakside.pro/view/{share['hash']}"
        assert rows[revoked["id"]]["isValid"] is False
        # Event shares never appear in a game's list, and vice versa.
        assert all(s["kind"] == "event" for s in rows.values())
        assert client.get(f"/api/games/{GAME_ID}/shares").json()["count"] == 0

    def test_public_event_payload_is_the_allowlist(self, client, seeded):
        share = _mint_event(seeded["event_id"])
        _anon()
        r = client.get(f"/api/share/{share['hash']}")
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"event", "games", "version", "viewerStatsLevel", "shareInfo"}
        # The event document's roster, defaults and ids stay private.
        assert body["event"] == {"name": "Fall Classic", "phases": ["Pool", "Bracket"], "status": "open"}
        assert body["shareInfo"]["expiresAt"] == share["expiresAt"]
        assert body["version"]
        cards = body["games"]
        assert [c["id"] for c in cards] == [GAME_ID, GAME_ID_2], "chronological, not gameIds order"
        for card in cards:
            assert set(card) == GAME_CARD_KEYS, card
        assert cards[0]["phase"] == "Pool"
        assert cards[0]["scores"] == {"team": 3, "opponent": 1}
        assert cards[0]["gameEndTimestamp"] is None
        assert cards[1]["gameEndTimestamp"] == "2026-07-02T20:00:00Z"

    def test_games_endpoint_serves_the_game_projection(self, client, seeded):
        share = _mint_event(seeded["event_id"])
        _anon()
        r = client.get(f"/api/share/{share['hash']}/games/{GAME_ID}")
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"game", "version", "viewerStatsLevel", "shareInfo"}
        # Exactly what a game share publishes — same allowlist, same keys.
        assert set(body["game"]) == {
            "team", "opponent", "scores", "gameStartTimestamp", "gameEndTimestamp", "points",
        }
        assert body["game"]["opponent"] == "Rivals"
        # The per-game stamp is the one the event's card carries.
        card = next(c for c in client.get(f"/api/share/{share['hash']}").json()["games"] if c["id"] == GAME_ID)
        assert body["version"] == card["version"]
        poll = client.get(f"/api/share/{share['hash']}/games/{GAME_ID}/poll")
        assert poll.status_code == 200 and poll.json()["version"] == body["version"]

    def test_games_endpoint_refuses_games_outside_the_event(self, client, seeded):
        """The event link is a key to the event's games only: a game of the
        same team that is not in the event, a game that never existed, and a
        malformed id all read as not found."""
        _seed_rich_game(seeded)   # same team, not in the event
        share = _mint_event(seeded["event_id"])
        _anon()
        for game_id in (RICH_GAME_ID, "2026-01-01_Nope_vs_Nope_0000", "..%2F..%2Fetc"):
            r = client.get(f"/api/share/{share['hash']}/games/{game_id}")
            assert r.status_code in (400, 404), game_id
            assert client.get(f"/api/share/{share['hash']}/games/{game_id}/poll").status_code in (400, 404)

    def test_games_endpoint_is_not_a_back_door_for_game_links(self, client, seeded):
        """A single-game hash opens its one game and nothing else."""
        share = _mint()   # a GAME share on GAME_ID
        _anon()
        assert client.get(f"/api/share/{share['hash']}/games/{GAME_ID}").status_code == 404
        assert client.get(f"/api/share/{share['hash']}/games/{GAME_ID_2}").status_code == 404
        # ...and it still answers with a game, not an event.
        body = client.get(f"/api/share/{share['hash']}").json()
        assert "game" in body and "event" not in body

    def test_game_removed_from_the_event_drops_off_the_link(self, client, seeded):
        from storage import event_storage
        share = _mint_event(seeded["event_id"])
        _anon()
        event_storage.remove_game_from_event(seeded["event_id"], GAME_ID_2)
        try:
            cards = client.get(f"/api/share/{share['hash']}").json()["games"]
            assert [c["id"] for c in cards] == [GAME_ID]
            assert client.get(f"/api/share/{share['hash']}/games/{GAME_ID_2}").status_code == 404
        finally:
            event_storage.add_game_to_event(seeded["event_id"], GAME_ID_2)
        # Added back: reachable again without a new link.
        assert client.get(f"/api/share/{share['hash']}/games/{GAME_ID_2}").status_code == 200

    def test_event_poll_moves_when_a_game_or_the_event_changes(self, client, seeded):
        from storage import game_storage, event_storage
        share = _mint_event(seeded["event_id"])
        _anon()
        full = client.get(f"/api/share/{share['hash']}").json()
        v0 = client.get(f"/api/share/{share['hash']}/poll").json()["version"]
        assert v0 == full["version"]

        # A game changed (deterministic: bump its stamp, as the game poll test does).
        current = game_storage.GAMES_DIR / GAME_ID_2 / "current.json"
        st = current.stat()
        os.utime(current, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
        v1 = client.get(f"/api/share/{share['hash']}/poll").json()["version"]
        assert v1 != v0

        # The event document changed (a rename, a phase added).
        event_file = event_storage.EVENTS_DIR / f"{seeded['event_id']}.json"
        st = event_file.stat()
        os.utime(event_file, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
        v2 = client.get(f"/api/share/{share['hash']}/poll").json()["version"]
        assert v2 not in (v0, v1)

        # Unchanged since: stable.
        assert client.get(f"/api/share/{share['hash']}/poll").json()["version"] == v2

    def test_every_event_endpoint_dies_with_the_share(self, client, seeded):
        from storage import share_storage
        share = _mint_event(seeded["event_id"])
        _anon()
        share_storage.revoke_share(share["id"], COACH["id"])
        for path in ("", "/poll", f"/games/{GAME_ID}", f"/games/{GAME_ID}/poll"):
            assert client.get(f"/api/share/{share['hash']}{path}").status_code == 410, path

        expired = _mint_event(seeded["event_id"])
        _expire(expired)
        assert client.get(f"/api/share/{expired['hash']}").status_code == 410

    def test_deleted_event_reads_as_not_found(self, client, seeded):
        from storage import event_storage
        doomed = event_storage.save_event({
            "name": "Gone Tourney", "teamId": seeded["team_id"], "gameIds": [GAME_ID],
        })
        share = _mint_event(doomed)
        _anon()
        assert client.get(f"/api/share/{share['hash']}").status_code == 200
        event_storage.delete_event(doomed)
        assert client.get(f"/api/share/{share['hash']}").status_code == 404
        assert client.get(f"/api/share/{share['hash']}/games/{GAME_ID}").status_code == 404

    def test_viewer_stats_level_rides_on_the_event_payload(self, client, seeded):
        from storage import team_storage
        team_id = seeded["team_id"]
        share = _mint_event(seeded["event_id"])
        _anon()
        assert client.get(f"/api/share/{share['hash']}").json()["viewerStatsLevel"] is None
        team = team_storage.get_team(team_id)
        try:
            team_storage.update_team(team_id, {**team, "viewerStatsLevel": "fun"})
            assert client.get(f"/api/share/{share['hash']}").json()["viewerStatsLevel"] == "fun"
            assert client.get(f"/api/share/{share['hash']}/games/{GAME_ID}").json()["viewerStatsLevel"] == "fun"
        finally:
            team_storage.update_team(team_id, team)

    def test_revoke_endpoint_covers_event_shares(self, client, seeded):
        # The real team id: revoke checks the caller's role on share.teamId.
        share = _mint_event(seeded["event_id"], team_id=seeded["team_id"])
        _as(VIEWER)
        assert client.delete(f"/api/shares/{share['id']}").status_code == 403
        _as(COACH)
        assert client.delete(f"/api/shares/{share['id']}").status_code == 200
        _anon()
        assert client.get(f"/api/share/{share['hash']}").status_code == 410


class TestShareStorageCompat:
    """Links and index files written before event shares existed keep working."""

    def test_legacy_share_without_kind_is_a_game_share(self):
        from storage import share_storage
        assert share_storage.share_kind({"gameId": "g", "hash": "h"}) == "game"
        assert share_storage.share_kind({"kind": "event", "eventId": "e", "hash": "h"}) == "event"

    def test_index_without_byevent_bucket_accepts_an_event_share(self, seeded):
        from storage import share_storage
        from storage.file_utils import atomic_write_json
        index = share_storage._index.load()
        index.pop("byEvent", None)
        atomic_write_json(share_storage.INDEX_FILE, index)

        share = _mint_event(seeded["event_id"])
        assert [s["id"] for s in share_storage.list_event_shares(seeded["event_id"])] == [share["id"]]
        assert share_storage.get_share_by_hash(share["hash"])["id"] == share["id"]
        # And the rebuilt index agrees.
        rebuilt = share_storage.rebuild_share_index()
        assert rebuilt["byEvent"][seeded["event_id"]] == [share["id"]]
        assert share["id"] not in sum(rebuilt["byGame"].values(), [])
