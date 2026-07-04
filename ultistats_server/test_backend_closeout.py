"""
Tests for the F1 backend-closeout fixes (CODE_REVIEW_REPORT.md § 7):

- Event endpoints routed through shared require_* dependencies
  (read/list require team access, writes require team coach)
- require_game_team_coach no longer reads the request body; sync uses
  require_game_sync_coach with a shared parsed body + teamId consistency
- restore_version is a faithful rollback (no pendingNextLine re-merge)
- Fail-fast at startup when auth is required but SUPABASE_JWT_SECRET is unset

Run: cd ultistats_server && python -m pytest test_backend_closeout.py -v
"""
import pytest
from fastapi.testclient import TestClient


MOCK_COACH_A = {"id": "closeout-coach-a", "email": "ca@test", "role": "authenticated"}
MOCK_COACH_B = {"id": "closeout-coach-b", "email": "cb@test", "role": "authenticated"}
MOCK_VIEWER_A = {"id": "closeout-viewer-a", "email": "va@test", "role": "authenticated"}
MOCK_OUTSIDER = {"id": "closeout-outsider", "email": "out@test", "role": "authenticated"}


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """Temp data dir: team A (coach-a + viewer-a), team B (coach-b), an event
    on team A. Restores the patched config/storage dirs on teardown so this
    module doesn't pollute later test files."""
    data_dir = tmp_path_factory.mktemp("closeout_data")

    import config
    from storage import (
        team_storage, player_storage, membership_storage, index_storage,
        game_storage, event_storage,
    )

    patches = [
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

    team_a = team_storage.save_team({"name": "Closeout Team A", "playerIds": []})
    team_b = team_storage.save_team({"name": "Closeout Team B", "playerIds": []})
    membership_storage.create_membership(team_id=team_a, user_id=MOCK_COACH_A["id"], role="coach")
    membership_storage.create_membership(team_id=team_a, user_id=MOCK_VIEWER_A["id"], role="viewer")
    membership_storage.create_membership(team_id=team_b, user_id=MOCK_COACH_B["id"], role="coach")
    index_storage.rebuild_index()

    event_a = event_storage.save_event({"name": "Spring Tourney", "teamId": team_a})

    yield {"data_dir": data_dir, "team_a": team_a, "team_b": team_b, "event_a": event_a}

    for mod, name, original in saved:
        setattr(mod, name, original)


@pytest.fixture
def client(seeded, monkeypatch):
    # Authz tests need auth enforced (the env default); make it explicit so a
    # dev shell with ULTISTATS_AUTH_REQUIRED=false can't flip these tests.
    monkeypatch.setenv("ULTISTATS_AUTH_REQUIRED", "true")
    from main import app
    c = TestClient(app)
    yield c
    app.dependency_overrides.clear()


def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


# =============================================================================
# Event endpoint authorization
# =============================================================================

class TestEventReadAuthz:
    def test_coach_can_read_event(self, client, seeded):
        _as(MOCK_COACH_A)
        r = client.get(f"/api/events/{seeded['event_a']}")
        assert r.status_code == 200
        assert r.json()["name"] == "Spring Tourney"

    def test_viewer_can_read_event(self, client, seeded):
        _as(MOCK_VIEWER_A)
        assert client.get(f"/api/events/{seeded['event_a']}").status_code == 200

    def test_outsider_cannot_read_event(self, client, seeded):
        _as(MOCK_OUTSIDER)
        assert client.get(f"/api/events/{seeded['event_a']}").status_code == 403

    def test_other_teams_coach_cannot_read_event(self, client, seeded):
        _as(MOCK_COACH_B)
        assert client.get(f"/api/events/{seeded['event_a']}").status_code == 403

    def test_missing_event_404(self, client, seeded):
        _as(MOCK_COACH_A)
        assert client.get("/api/events/No-Such-Event-0000").status_code == 404

    def test_team_events_list_requires_team_access(self, client, seeded):
        _as(MOCK_OUTSIDER)
        assert client.get(f"/api/teams/{seeded['team_a']}/events").status_code == 403

    def test_team_events_list_for_member(self, client, seeded):
        _as(MOCK_VIEWER_A)
        r = client.get(f"/api/teams/{seeded['team_a']}/events")
        assert r.status_code == 200
        names = [e["name"] for e in r.json()["events"]]
        assert "Spring Tourney" in names


class TestEventWriteAuthz:
    def test_outsider_cannot_create_event(self, client, seeded):
        _as(MOCK_OUTSIDER)
        r = client.post("/api/events", json={"name": "Evil", "teamId": seeded["team_a"]})
        assert r.status_code == 403

    def test_viewer_cannot_create_event(self, client, seeded):
        _as(MOCK_VIEWER_A)
        r = client.post("/api/events", json={"name": "Nope", "teamId": seeded["team_a"]})
        assert r.status_code == 403

    def test_create_requires_team_id(self, client, seeded):
        _as(MOCK_COACH_A)
        assert client.post("/api/events", json={"name": "No Team"}).status_code == 400

    def test_coach_can_create_update_delete(self, client, seeded):
        _as(MOCK_COACH_A)
        r = client.post("/api/events", json={"name": "Crud Cup", "teamId": seeded["team_a"]})
        assert r.status_code == 200
        eid = r.json()["event_id"]

        r = client.put(f"/api/events/{eid}", json={"name": "Crud Cup 2"})
        assert r.status_code == 200
        assert r.json()["event"]["name"] == "Crud Cup 2"
        # teamId preserved from the stored event
        assert r.json()["event"]["teamId"] == seeded["team_a"]

        assert client.delete(f"/api/events/{eid}").status_code == 200

    def test_update_cannot_move_event_to_other_team(self, client, seeded):
        _as(MOCK_COACH_A)
        r = client.put(
            f"/api/events/{seeded['event_a']}",
            json={"name": "Spring Tourney", "teamId": seeded["team_b"]},
        )
        assert r.status_code == 200
        assert r.json()["event"]["teamId"] == seeded["team_a"]

    def test_outsider_cannot_update_or_delete(self, client, seeded):
        _as(MOCK_OUTSIDER)
        eid = seeded["event_a"]
        assert client.put(f"/api/events/{eid}", json={"name": "X"}).status_code == 403
        assert client.delete(f"/api/events/{eid}").status_code == 403


# =============================================================================
# Game sync teamId validation (require_game_sync_coach)
# =============================================================================

def _game_body(team_id, **extra):
    body = {"team": "Closeout Team A", "opponent": "Rivals", "teamId": team_id}
    body.update(extra)
    return body


class TestGameSyncTeamId:
    def test_new_game_requires_coach_of_claimed_team(self, client, seeded):
        _as(MOCK_COACH_B)  # coach of B claims a game for team A
        r = client.post("/api/games/Closeout-New-0001/sync", json=_game_body(seeded["team_a"]))
        assert r.status_code == 403

    def test_new_game_without_team_id_rejected(self, client, seeded):
        _as(MOCK_COACH_A)
        r = client.post(
            "/api/games/Closeout-New-0002/sync",
            json={"team": "A", "opponent": "B"},
        )
        assert r.status_code == 400

    def test_coach_creates_then_body_team_mismatch_rejected(self, client, seeded):
        _as(MOCK_COACH_A)
        gid = "Closeout-Game-0003"
        r = client.post(f"/api/games/{gid}/sync", json=_game_body(seeded["team_a"]))
        assert r.status_code == 200

        # Re-sync claiming a different team: rejected even for the coach of
        # the stored team (sync must not move a game between teams).
        r = client.post(f"/api/games/{gid}/sync", json=_game_body(seeded["team_b"]))
        assert r.status_code == 403

        # Matching teamId still fine.
        r = client.post(f"/api/games/{gid}/sync", json=_game_body(seeded["team_a"]))
        assert r.status_code == 200

    def test_write_on_missing_game_is_404_not_400(self, client, seeded):
        # require_game_team_coach no longer falls back to the body; a write
        # endpoint on a nonexistent game 404s instead of "must have a teamId".
        _as(MOCK_COACH_A)
        assert client.delete("/api/games/No-Such-Game-0000").status_code == 404


# =============================================================================
# Faithful version restore (no pendingNextLine re-merge)
# =============================================================================

class TestFaithfulRestore:
    def test_restore_does_not_remerge_pending_next_line(self, client, seeded):
        _as(MOCK_COACH_A)
        gid = "Closeout-Restore-0001"

        v1 = _game_body(seeded["team_a"], pendingNextLine={
            "oLine": ["alice"], "oLineModifiedAt": "2026-07-01T10:00:00Z",
        })
        r = client.post(f"/api/games/{gid}/sync", json=v1)
        assert r.status_code == 200
        v1_ts = r.json()["version"]

        v2 = _game_body(seeded["team_a"], pendingNextLine={
            "oLine": ["bob"], "oLineModifiedAt": "2026-07-01T11:00:00Z",
        })
        assert client.post(f"/api/games/{gid}/sync", json=v2).status_code == 200

        # Restore v1: the snapshot must come back verbatim. Under the old
        # merge-on-restore behavior the newer oLineModifiedAt would win and
        # ["bob"] would survive the rollback.
        r = client.post(f"/api/games/{gid}/restore/{v1_ts}")
        assert r.status_code == 200

        game = client.get(f"/api/games/{gid}").json()
        assert game["pendingNextLine"]["oLine"] == ["alice"]

    def test_restore_requires_coach(self, client, seeded):
        _as(MOCK_COACH_A)
        gid = "Closeout-Restore-0002"
        r = client.post(f"/api/games/{gid}/sync", json=_game_body(seeded["team_a"]))
        v_ts = r.json()["version"]

        _as(MOCK_VIEWER_A)
        assert client.post(f"/api/games/{gid}/restore/{v_ts}").status_code == 403


# =============================================================================
# Startup fail-fast when auth is on but the JWT secret is missing
# =============================================================================

class TestAuthConfigFailFast:
    def test_assert_raises_without_secret(self, monkeypatch):
        from auth import jwt_validation
        monkeypatch.delenv("ULTISTATS_AUTH_REQUIRED", raising=False)  # default: true
        monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
        monkeypatch.setattr(jwt_validation, "SUPABASE_JWT_SECRET", "")
        with pytest.raises(RuntimeError, match="SUPABASE_JWT_SECRET"):
            jwt_validation.assert_auth_configured()

    def test_assert_ok_with_secret(self, monkeypatch):
        from auth import jwt_validation
        monkeypatch.delenv("ULTISTATS_AUTH_REQUIRED", raising=False)
        monkeypatch.setenv("SUPABASE_JWT_SECRET", "s3cret")
        jwt_validation.assert_auth_configured()

    def test_assert_ok_when_auth_disabled(self, monkeypatch):
        from auth import jwt_validation
        monkeypatch.setenv("ULTISTATS_AUTH_REQUIRED", "false")
        monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
        monkeypatch.setattr(jwt_validation, "SUPABASE_JWT_SECRET", "")
        jwt_validation.assert_auth_configured()

    def test_app_startup_runs_the_check(self, monkeypatch):
        from auth import jwt_validation
        from main import app
        monkeypatch.delenv("ULTISTATS_AUTH_REQUIRED", raising=False)
        monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
        monkeypatch.setattr(jwt_validation, "SUPABASE_JWT_SECRET", "")
        with pytest.raises(RuntimeError, match="SUPABASE_JWT_SECRET"):
            with TestClient(app):  # context manager runs the lifespan
                pass
