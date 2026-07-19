"""
Tests for the G2 backend hardening (CODE_REVIEW_REPORT.md §8), both fixes
root-caused during the 2026-07-03 staging incident:

1. Unhandled 500s carry CORS headers. An unhandled exception bypasses
   CORSMiddleware (ServerErrorMiddleware sits outside it), so the bare 500
   used to reach the browser without CORS headers; fetch() rejected with an
   opaque TypeError and the client sync layer misread a server bug as being
   offline. main.py now registers an Exception handler that returns 500 JSON
   with headers mirroring the CORSMiddleware config (wildcard vs explicit
   origins, credentials mode, cookie-echo). Normal HTTPExceptions must be
   unaffected (they already pass through the middleware).

2. A version-backup write failure (root-owned/unwritable versions/ dir) must
   degrade gracefully: log loudly, still write current.json, sync returns
   success. Plus a startup writability check on the data dir
   (storage.file_utils.assert_data_dir_writable, run from the app lifespan).

Run: python3 -m pytest ultistats_server/test_error_handling.py -v
"""
import json
import os
import stat

import pytest
from fastapi.testclient import TestClient


MOCK_COACH = {"id": "errh-coach", "email": "errh-coach@test", "role": "authenticated"}

PROD_ORIGIN = "https://www.breakside.pro"
STAGING_ORIGIN = "https://staging.breakside.pro"
EVIL_ORIGIN = "https://evil.example"

requires_nonroot = pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="permission-based tests are meaningless when running as root",
)


def _make_unwritable(path):
    os.chmod(path, 0o555)


def _make_writable(path):
    os.chmod(path, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """Temp data dir with one team and one coach membership. Restores the
    patched config/storage dirs on teardown so this module doesn't pollute
    later test files (same pattern as test_backend_closeout.py)."""
    data_dir = tmp_path_factory.mktemp("errh_data")

    import config
    from storage import (
        team_storage, player_storage, membership_storage, index_storage,
        game_storage, event_storage,
    )

    patches = [
        (config, "DATA_DIR", data_dir),
        (config, "GAMES_DIR", data_dir / "games"),
        (config, "TEAMS_DIR", data_dir / "teams"),
        (config, "PLAYERS_DIR", data_dir / "players"),
        (config, "USERS_DIR", data_dir / "users"),
        (config, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (config, "EVENTS_DIR", data_dir / "events"),
        (config, "INDEX_FILE", data_dir / "index.json"),
        (game_storage, "GAMES_DIR", data_dir / "games"),
        (team_storage, "TEAMS_DIR", data_dir / "teams"),
        (player_storage, "PLAYERS_DIR", data_dir / "players"),
        (event_storage, "EVENTS_DIR", data_dir / "events"),
        (membership_storage, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (membership_storage, "INDEX_FILE", data_dir / "memberships" / "_index.json"),
        (index_storage, "INDEX_FILE", data_dir / "index.json"),
        (index_storage, "TEAMS_DIR", data_dir / "teams"),
        (index_storage, "PLAYERS_DIR", data_dir / "players"),
        (index_storage, "GAMES_DIR", data_dir / "games"),
    ]
    saved = [(mod, name, getattr(mod, name)) for mod, name, _ in patches]
    for mod, name, value in patches:
        if name.endswith("_DIR"):
            value.mkdir(parents=True, exist_ok=True)
        setattr(mod, name, value)

    team_id = team_storage.save_team({"name": "ErrHandling Team", "playerIds": []})
    membership_storage.create_membership(
        team_id=team_id, user_id=MOCK_COACH["id"], role="coach")
    index_storage.rebuild_index()

    yield {"data_dir": data_dir, "team_id": team_id}

    for mod, name, original in saved:
        setattr(mod, name, original)


@pytest.fixture
def client(seeded, monkeypatch):
    # Auth enforced (the env default), made explicit so a dev shell with
    # ULTISTATS_AUTH_REQUIRED=false can't flip these tests.
    monkeypatch.setenv("ULTISTATS_AUTH_REQUIRED", "true")
    from main import app
    # raise_server_exceptions=False: ServerErrorMiddleware re-raises after
    # sending the handler's response; we want to see the response.
    c = TestClient(app, raise_server_exceptions=False)
    yield c
    app.dependency_overrides.clear()


def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


def _game_body(seeded, **extra):
    body = {"team": "ErrHandling Team", "opponent": "Rivals",
            "teamId": seeded["team_id"]}
    body.update(extra)
    return body


@pytest.fixture
def boom_on_sync(monkeypatch):
    """Make the sync endpoint's save raise the incident's exact exception
    class (PermissionError), AFTER auth/validation passed — i.e. a genuine
    unhandled 500 inside the handler."""
    import routers

    def _boom(*args, **kwargs):
        raise PermissionError(13, "Permission denied", "/data/games/x/versions/y.json")

    monkeypatch.setattr(routers.games, "save_game_version", _boom)


def _sync_expect_500(client, seeded, headers):
    r = client.post(
        "/api/games/ErrH-Boom-0001/sync",
        json=_game_body(seeded),
        headers=headers,
    )
    assert r.status_code == 500
    assert r.json() == {"detail": "Internal server error"}
    return r


# =============================================================================
# 1a. Unhandled 500s carry CORS headers (exception handler + origin mirroring)
# =============================================================================

class TestCorsOnUnhandled500:
    def test_wildcard_mode_returns_star(self, client, seeded, boom_on_sync, monkeypatch):
        import main
        monkeypatch.setattr(main, "ALLOWED_ORIGINS", ["*"])
        _as(MOCK_COACH)
        r = _sync_expect_500(client, seeded, {"Origin": PROD_ORIGIN})
        assert r.headers.get("access-control-allow-origin") == "*"
        assert r.headers.get("access-control-allow-credentials") == "true"

    def test_wildcard_mode_with_cookie_echoes_origin(self, client, seeded, boom_on_sync, monkeypatch):
        # Credentialed (cookie-bearing) requests must get the explicit origin,
        # not "*" — browsers reject "*" combined with credentials. Mirrors
        # CORSMiddleware's has_cookie special case.
        import main
        monkeypatch.setattr(main, "ALLOWED_ORIGINS", ["*"])
        _as(MOCK_COACH)
        r = _sync_expect_500(
            client, seeded, {"Origin": PROD_ORIGIN, "Cookie": "sb=1"})
        assert r.headers.get("access-control-allow-origin") == PROD_ORIGIN
        assert "Origin" in r.headers.get("vary", "")
        assert r.headers.get("access-control-allow-credentials") == "true"

    def test_explicit_mode_allowed_origin_echoed(self, client, seeded, boom_on_sync, monkeypatch):
        # Production config shape: explicit origin allowlist.
        import main
        monkeypatch.setattr(main, "ALLOWED_ORIGINS", [PROD_ORIGIN, STAGING_ORIGIN])
        _as(MOCK_COACH)
        r = _sync_expect_500(client, seeded, {"Origin": STAGING_ORIGIN})
        assert r.headers.get("access-control-allow-origin") == STAGING_ORIGIN
        assert "Origin" in r.headers.get("vary", "")
        assert r.headers.get("access-control-allow-credentials") == "true"

    def test_explicit_mode_disallowed_origin_gets_no_allow_origin(self, client, seeded, boom_on_sync, monkeypatch):
        # A disallowed origin must NOT be echoed — same as the middleware:
        # the 500 goes out without Allow-Origin and the browser blocks it.
        import main
        monkeypatch.setattr(main, "ALLOWED_ORIGINS", [PROD_ORIGIN, STAGING_ORIGIN])
        _as(MOCK_COACH)
        r = _sync_expect_500(client, seeded, {"Origin": EVIL_ORIGIN})
        assert "access-control-allow-origin" not in r.headers

    def test_non_cors_request_gets_no_cors_headers(self, client, seeded, boom_on_sync, monkeypatch):
        # No Origin header -> not a CORS request -> the middleware would not
        # have touched it; the handler must not either.
        import main
        monkeypatch.setattr(main, "ALLOWED_ORIGINS", ["*"])
        _as(MOCK_COACH)
        r = _sync_expect_500(client, seeded, {})
        assert "access-control-allow-origin" not in r.headers
        assert "access-control-allow-credentials" not in r.headers

    def test_unhandled_error_is_logged_with_request_context(self, client, seeded, boom_on_sync, caplog):
        _as(MOCK_COACH)
        with caplog.at_level("ERROR"):
            _sync_expect_500(client, seeded, {"Origin": PROD_ORIGIN})
        assert any(
            "Unhandled exception" in rec.message and "/sync" in rec.message
            for rec in caplog.records
        )


# =============================================================================
# 1b. Normal (handled) responses are unaffected — still get CORS from the
#     middleware itself.
# =============================================================================

class TestHandledResponsesStillGetMiddlewareCors:
    # The live middleware was configured from the env at import time
    # (wildcard by default), so assert Allow-Origin is present rather than
    # pinning its exact value.

    def test_http_exception_404_still_has_cors(self, client, seeded):
        _as(MOCK_COACH)
        r = client.get("/api/games/No-Such-Game-0000",
                       headers={"Origin": PROD_ORIGIN})
        assert r.status_code == 404
        assert r.headers.get("access-control-allow-origin") in ("*", PROD_ORIGIN)

    def test_http_exception_400_still_has_cors(self, client, seeded):
        _as(MOCK_COACH)
        # Missing team/opponent -> explicit HTTPException 400 in the handler.
        r = client.post("/api/games/ErrH-Bad-0001/sync",
                        json={"teamId": seeded["team_id"]},
                        headers={"Origin": PROD_ORIGIN})
        assert r.status_code == 400
        assert r.headers.get("access-control-allow-origin") in ("*", PROD_ORIGIN)

    def test_success_response_still_has_cors(self, client, seeded):
        r = client.get("/health", headers={"Origin": PROD_ORIGIN})
        assert r.status_code == 200
        assert r.headers.get("access-control-allow-origin") in ("*", PROD_ORIGIN)


# =============================================================================
# 2. Version-backup write failure degrades instead of failing the sync
# =============================================================================

@requires_nonroot
class TestBackupFailureDegrades:
    def test_backup_failure_storage_level(self, seeded, caplog):
        from storage import game_storage

        game_id = "ErrH-Storage-0001"
        v1 = {"team": "T", "opponent": "O", "score": 1, "teamId": seeded["team_id"]}
        v2 = {"team": "T", "opponent": "O", "score": 2, "teamId": seeded["team_id"]}

        game_storage.save_game_version(game_id, v1)
        game_dir = seeded["data_dir"] / "games" / game_id
        versions_dir = game_dir / "versions"
        n_versions_before = len(list(versions_dir.glob("*.json")))
        assert n_versions_before == 1

        _make_unwritable(versions_dir)
        try:
            with caplog.at_level("ERROR"):
                returned = game_storage.save_game_version(game_id, v2)
        finally:
            _make_writable(versions_dir)

        # The sync's own state WAS saved...
        with open(game_dir / "current.json") as f:
            assert json.load(f)["score"] == 2
        # ...no backup was written...
        assert len(list(versions_dir.glob("*.json"))) == n_versions_before
        # ...the returned path is the (nonexistent) intended backup...
        assert returned.endswith(".json")
        assert not os.path.exists(returned)
        # ...and the failure was logged loudly.
        assert any("VERSION BACKUP FAILED" in rec.message for rec in caplog.records)
        assert any(game_id in rec.message for rec in caplog.records)

    def test_backup_failure_sync_endpoint_returns_200(self, client, seeded):
        _as(MOCK_COACH)
        game_id = "ErrH-Sync-0001"

        r = client.post(f"/api/games/{game_id}/sync",
                        json=_game_body(seeded, score=1))
        assert r.status_code == 200

        versions_dir = seeded["data_dir"] / "games" / game_id / "versions"
        _make_unwritable(versions_dir)
        try:
            r = client.post(f"/api/games/{game_id}/sync",
                            json=_game_body(seeded, score=2))
        finally:
            _make_writable(versions_dir)

        # The incident behavior was a 500 here (PermissionError on the
        # backup write); the sync must now succeed.
        assert r.status_code == 200
        assert r.json()["status"] == "synced"
        game = client.get(f"/api/games/{game_id}").json()
        assert game["score"] == 2

    def test_healthy_sync_still_writes_backups(self, client, seeded):
        # Guard against the degrade path accidentally becoming "never back up".
        _as(MOCK_COACH)
        game_id = "ErrH-Healthy-0001"
        client.post(f"/api/games/{game_id}/sync", json=_game_body(seeded, score=1))
        client.post(f"/api/games/{game_id}/sync", json=_game_body(seeded, score=2))
        versions_dir = seeded["data_dir"] / "games" / game_id / "versions"
        assert len(list(versions_dir.glob("*.json"))) == 2

    def test_unwritable_game_dir_still_fails_sync(self, client, seeded):
        # Sanity check on the degrade boundary: when current.json itself
        # cannot be written (whole game dir unwritable), the sync MUST still
        # fail — that failure is real data loss, not a lost restore point.
        # And thanks to fix 1, the 500 now carries CORS headers.
        _as(MOCK_COACH)
        game_id = "ErrH-Hard-0001"
        r = client.post(f"/api/games/{game_id}/sync",
                        json=_game_body(seeded, score=1))
        assert r.status_code == 200

        game_dir = seeded["data_dir"] / "games" / game_id
        _make_unwritable(game_dir)
        try:
            r = client.post(f"/api/games/{game_id}/sync",
                            json=_game_body(seeded, score=2),
                            headers={"Origin": PROD_ORIGIN})
        finally:
            _make_writable(game_dir)

        assert r.status_code == 500
        assert "access-control-allow-origin" in r.headers


# =============================================================================
# 3. Startup writability check (assert_data_dir_writable + lifespan wiring)
# =============================================================================

class TestStartupWritabilityCheck:
    def test_writable_data_dir_passes(self, tmp_path, monkeypatch):
        import config
        from storage.file_utils import assert_data_dir_writable
        monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
        assert_data_dir_writable()  # must not raise; also creates the dir
        assert (tmp_path / "data").is_dir()

    @requires_nonroot
    def test_unwritable_data_dir_raises(self, tmp_path, monkeypatch):
        import config
        from storage.file_utils import assert_data_dir_writable
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        _make_unwritable(data_dir)
        monkeypatch.setattr(config, "DATA_DIR", data_dir)
        try:
            with pytest.raises(RuntimeError, match="not writable"):
                assert_data_dir_writable()
        finally:
            _make_writable(data_dir)

    @requires_nonroot
    def test_nested_unwritable_dir_logs_but_does_not_block(self, tmp_path, monkeypatch, caplog):
        # The incident shape: one root-owned versions/ dir under one old
        # game. Startup must NOT be blocked (backups degrade now), but the
        # problem must be named loudly in the log.
        import config
        from storage.file_utils import assert_data_dir_writable
        data_dir = tmp_path / "data"
        versions = data_dir / "games" / "old-game-0001" / "versions"
        versions.mkdir(parents=True)
        _make_unwritable(versions)
        monkeypatch.setattr(config, "DATA_DIR", data_dir)
        try:
            with caplog.at_level("ERROR"):
                assert_data_dir_writable()  # no raise
        finally:
            _make_writable(versions)
        assert any(
            "unwritable" in rec.message.lower() and "old-game-0001" in rec.message
            for rec in caplog.records
        )

    @requires_nonroot
    def test_app_lifespan_runs_the_check(self, tmp_path, monkeypatch):
        # Same wiring proof as test_backend_closeout's auth fail-fast test:
        # `with TestClient(app)` runs the lifespan. Auth check passes (auth
        # disabled), then the data-dir check must refuse startup.
        import config
        from main import app
        monkeypatch.setenv("ULTISTATS_AUTH_REQUIRED", "false")
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        _make_unwritable(data_dir)
        monkeypatch.setattr(config, "DATA_DIR", data_dir)
        try:
            with pytest.raises(RuntimeError, match="not writable"):
                with TestClient(app):
                    pass
        finally:
            _make_writable(data_dir)

    def test_app_lifespan_boots_with_writable_dir(self, tmp_path, monkeypatch):
        import config
        from main import app
        monkeypatch.setenv("ULTISTATS_AUTH_REQUIRED", "false")
        monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
        with TestClient(app):
            pass  # lifespan ran both startup checks without raising
