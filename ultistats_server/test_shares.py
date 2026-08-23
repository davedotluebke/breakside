"""
Tests for the public share-link flow: /view/{hash} routing, the listed flag,
the lightweight share poll, and the public games listing.

The share endpoints existed before 2026-07 but nothing consumed them (no PWA
UI, no /view route, viewer used auth-required endpoints); these tests pin the
end-to-end contract added when sharing was wired up for real:

- POST /api/games/{id}/share mints /view/{hash} URLs and honors ?listed=
- GET  /api/share/{hash} is public and carries a change stamp ("version")
- GET  /api/share/{hash}/poll is the cheap live-poll (stamp only, 410 on
  expiry/revoke so pollers stop)
- GET  /api/public/games lists only valid listed shares, one card per game
- GET  /view/{hash} 302s to /static/viewer/?share={hash} (never serves HTML
  at /view/* — same relative-asset trap as /join/{code})

Run: cd ultistats_server && python -m pytest test_shares.py -v
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
        share_storage, index_storage,
    )

    patches = [
        (config, "DATA_DIR", data_dir),
        (config, "GAMES_DIR", data_dir / "games"),
        (config, "TEAMS_DIR", data_dir / "teams"),
        (config, "PLAYERS_DIR", data_dir / "players"),
        (config, "USERS_DIR", data_dir / "users"),
        (config, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (config, "SHARES_DIR", data_dir / "shares"),
        (config, "INDEX_FILE", data_dir / "index.json"),
        (game_storage, "GAMES_DIR", data_dir / "games"),
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

    for gid, opponent, ended in (
        (GAME_ID, "Rivals", None),
        (GAME_ID_2, "Others", "2026-07-02T20:00:00Z"),
    ):
        game_storage.save_game_version(gid, {
            "id": gid,
            "teamId": team_id,
            "team": "Share Test Team",
            "opponent": opponent,
            "scores": {"team": 3, "opponent": 1},
            "gameStartTimestamp": "2026-07-01T18:00:00Z",
            "gameEndTimestamp": ended,
            "points": [],
        })
    index_storage.rebuild_index()

    yield {"data_dir": data_dir, "team_id": team_id}

    for mod, name, original in saved:
        setattr(mod, name, original)


@pytest.fixture
def client(seeded, monkeypatch):
    monkeypatch.setenv("ULTISTATS_AUTH_REQUIRED", "true")
    from main import app
    c = TestClient(app)
    yield c
    app.dependency_overrides.clear()


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

    def test_listed_flag_round_trips(self, client, seeded):
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


class TestPublicGamesList:
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
    """/view/{hash} must REDIRECT to the viewer, never serve HTML in place —
    serving a document at /view/<hash> would break the viewer's relative
    asset URLs exactly like the /join/{code} trap did."""

    def test_redirects_to_viewer_with_share_param(self, client, seeded):
        r = client.get("/view/a8f3e2b1c9d4", follow_redirects=False)
        assert r.status_code == 302
        assert r.headers["location"] == "/static/viewer/?share=a8f3e2b1c9d4"

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
                "events": [
                    {"type": "Pull", "puller": "Played Player",
                     "pullerId": "Played-1111", "pullerGender": "FMP",
                     "quality": "good", "io_flag": True,
                     "from": [0, 0], "to": [40, 60]},
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
                           "calledBy", "calledByName", "from", "to"):
                assert leaked not in ev, f"{leaked} in {ev}"

    def test_point_level_extras_are_stripped(self, client, seeded):
        game = _shared_game(client, seeded)
        point = game["points"][0]
        assert set(point) == {"players", "winner", "totalPointTime", "possessions"}
        assert "substitutedOutPlayers" not in point

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
