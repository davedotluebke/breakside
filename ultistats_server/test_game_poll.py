"""
Tests for authenticated in-game change detection.

The in-game refresh loop used to pull the whole game every 3 seconds whether
or not anything had changed. These endpoints are what let it stop:

- POST /api/games/{id}/ping carries `gameStamp` — coaches already call this
  every 2s for role keepalive, so change detection rides along for free and
  the separate full-game poll goes away entirely.
- GET  /api/games/{id}/poll returns the same stamp on its own, for in-game
  clients that hold no controller session and never ping (viewers).

Both use the same stamp as the public share poll's `version`, so every live
path in the app detects change identically.

Run: cd ultistats_server && python -m pytest test_game_poll.py -v
"""
import os

import pytest
from fastapi.testclient import TestClient


COACH = {"id": "poll-coach", "email": "coach@test", "role": "authenticated"}
VIEWER = {"id": "poll-viewer", "email": "viewer@test", "role": "authenticated"}
OUTSIDER = {"id": "poll-outsider", "email": "nobody@test", "role": "authenticated"}

GAME_ID = "2026-08-01_Poll-Test-Team_vs_Rivals_p0ll"


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """Temp data dir with one team (COACH coaches, VIEWER watches) and a game."""
    data_dir = tmp_path_factory.mktemp("game_poll_test_data")

    import config
    from storage import (
        game_storage, team_storage, player_storage, membership_storage,
        index_storage,
    )

    patches = [
        (config, "DATA_DIR", data_dir),
        (config, "GAMES_DIR", data_dir / "games"),
        (config, "TEAMS_DIR", data_dir / "teams"),
        (config, "PLAYERS_DIR", data_dir / "players"),
        (config, "USERS_DIR", data_dir / "users"),
        (config, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (config, "INDEX_FILE", data_dir / "index.json"),
        (game_storage, "GAMES_DIR", data_dir / "games"),
        (team_storage, "TEAMS_DIR", data_dir / "teams"),
        (player_storage, "PLAYERS_DIR", data_dir / "players"),
        (membership_storage, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (membership_storage, "INDEX_FILE", data_dir / "memberships" / "_index.json"),
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

    team_id = team_storage.save_team({"name": "Poll Test Team", "playerIds": []})
    membership_storage.create_membership(
        team_id=team_id, user_id=COACH["id"], role="coach")
    membership_storage.create_membership(
        team_id=team_id, user_id=VIEWER["id"], role="viewer")

    game_storage.save_game_version(GAME_ID, {
        "id": GAME_ID,
        "teamId": team_id,
        "team": "Poll Test Team",
        "opponent": "Rivals",
        "scores": {"team": 3, "opponent": 1},
        "gameStartTimestamp": "2026-08-01T18:00:00Z",
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
def clear_controller_state():
    """Roles are in-memory and process-wide; don't leak them between tests.

    Connected coaches too: they decide ping cadence, so a leftover coach makes
    the next test's game look contested.
    """
    from storage.controller_storage import (
        _controller_states, _connected_coaches, _lock,
    )
    with _lock:
        _controller_states.clear()
        _connected_coaches.clear()
    yield
    with _lock:
        _controller_states.clear()
        _connected_coaches.clear()


def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


def _touch_game():
    """Bump current.json's mtime deterministically, rather than racing the
    filesystem's timestamp resolution with a re-save."""
    from storage import game_storage
    current = game_storage.GAMES_DIR / GAME_ID / "current.json"
    st = current.stat()
    os.utime(current, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


class TestGamePoll:
    def test_poll_returns_a_stamp(self, client, seeded):
        _as(COACH)
        r = client.get(f"/api/games/{GAME_ID}/poll")
        assert r.status_code == 200
        assert r.json()["version"]

    def test_stamp_is_stable_while_nothing_changes(self, client, seeded):
        """The whole point: repeated polls of an idle game agree, so the
        client never refetches."""
        _as(COACH)
        first = client.get(f"/api/games/{GAME_ID}/poll").json()["version"]
        second = client.get(f"/api/games/{GAME_ID}/poll").json()["version"]
        assert first == second

    def test_stamp_changes_when_the_game_changes(self, client, seeded):
        _as(COACH)
        before = client.get(f"/api/games/{GAME_ID}/poll").json()["version"]
        _touch_game()
        after = client.get(f"/api/games/{GAME_ID}/poll").json()["version"]
        assert after != before

    def test_viewers_can_poll(self, client, seeded):
        """Viewers never ping, so this route is their only cheap stamp."""
        _as(VIEWER)
        assert client.get(f"/api/games/{GAME_ID}/poll").status_code == 200

    def test_outsiders_cannot_poll(self, client, seeded):
        _as(OUTSIDER)
        assert client.get(f"/api/games/{GAME_ID}/poll").status_code in (403, 404)

    def test_unknown_game_404s(self, client, seeded):
        _as(COACH)
        assert client.get("/api/games/no-such-game/poll").status_code == 404


class TestPingCarriesStamp:
    def test_ping_includes_game_stamp(self, client, seeded):
        _as(COACH)
        r = client.post(f"/api/games/{GAME_ID}/ping")
        assert r.status_code == 200
        assert r.json()["gameStamp"]

    def test_ping_stamp_matches_the_poll_route(self, client, seeded):
        """Both sides must agree, or a client that seeds from one and compares
        against the other refetches forever."""
        _as(COACH)
        ping = client.post(f"/api/games/{GAME_ID}/ping").json()["gameStamp"]
        poll = client.get(f"/api/games/{GAME_ID}/poll").json()["version"]
        assert ping == poll

    def test_ping_stamp_is_stable_across_pings(self, client, seeded):
        """Pinging must not itself look like a change — a ping writes only
        in-memory controller state, never current.json."""
        _as(COACH)
        first = client.post(f"/api/games/{GAME_ID}/ping").json()["gameStamp"]
        second = client.post(f"/api/games/{GAME_ID}/ping").json()["gameStamp"]
        assert first == second

    def test_ping_stamp_follows_a_game_write(self, client, seeded):
        _as(COACH)
        before = client.post(f"/api/games/{GAME_ID}/ping").json()["gameStamp"]
        _touch_game()
        after = client.post(f"/api/games/{GAME_ID}/ping").json()["gameStamp"]
        assert after != before

    def test_another_coachs_sync_moves_the_stamp(self, client, seeded):
        """The behavior the in-game loop actually depends on: a write by a
        *different* coach must be visible to this coach's next ping."""
        from storage import game_storage

        _as(COACH)
        before = client.post(f"/api/games/{GAME_ID}/ping").json()["gameStamp"]

        game = game_storage.get_game_current(GAME_ID)
        game["pendingNextLine"] = {
            "players": ["Alice-7f3a"],
            "updatedAt": "2026-08-01T18:05:00Z",
        }
        game_storage.save_game_version(GAME_ID, game)

        after = client.post(f"/api/games/{GAME_ID}/ping").json()["gameStamp"]
        assert after != before


class TestPingNamesTheCadence:
    """The ping response is what tells a client how often to ping.

    Storage-level cadence rules are covered in test_controller.py; these pin
    the HTTP surface — the field names a client reads, and the instance header
    that storage can't see on its own.
    """

    def test_solo_coach_is_told_to_back_off(self, client, seeded):
        from storage.controller_storage import PING_INTERVAL_SOLO_MS

        _as(COACH)
        body = client.post(f"/api/games/{GAME_ID}/ping").json()
        assert body["pingInterval"] == PING_INTERVAL_SOLO_MS

    def test_no_instance_header_is_not_a_duplicate(self, client, seeded):
        """Old clients send no header; they must not trip the warning."""
        _as(COACH)
        client.post(f"/api/games/{GAME_ID}/ping")
        body = client.post(f"/api/games/{GAME_ID}/ping").json()
        assert body["duplicateInstance"] is False

    def test_one_instance_pinging_repeatedly_is_not_a_duplicate(self, client, seeded):
        _as(COACH)
        headers = {"X-Breakside-Instance": "inst-phone"}
        client.post(f"/api/games/{GAME_ID}/ping", headers=headers)
        body = client.post(f"/api/games/{GAME_ID}/ping", headers=headers).json()
        assert body["duplicateInstance"] is False

    def test_second_instance_of_one_account_is_flagged_and_kept_fast(
        self, client, seeded
    ):
        """The case the solo backoff would otherwise get wrong: one user in two
        places looks solo (coaches are keyed by user id), so both would back off
        while each was in fact a remote writer for the other."""
        from storage.controller_storage import PING_INTERVAL_MULTI_MS

        _as(COACH)
        client.post(
            f"/api/games/{GAME_ID}/ping", headers={"X-Breakside-Instance": "inst-phone"}
        )
        body = client.post(
            f"/api/games/{GAME_ID}/ping", headers={"X-Breakside-Instance": "inst-tablet"}
        ).json()

        assert body["duplicateInstance"] is True
        assert body["pingInterval"] == PING_INTERVAL_MULTI_MS
