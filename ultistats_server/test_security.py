"""
Tests for the backend security cluster fixes:

- AUTH_REQUIRED unification (default true) + X-Test-User-Id gating
- Path-traversal validation (validate_id / safe_static_path / static handlers)
- /api/proxy-image SSRF guard + auth requirement
- Player read/list authorization + create-overwrite hole
- Atomic + locked storage writes; version pruning + collision-free timestamps

Run: cd ultistats_server && python -m pytest test_security.py -v
"""
import json
import os
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


# =============================================================================
# Unit tests — pure helpers (no app/config patching needed)
# =============================================================================

class TestValidation:
    def test_validate_id_accepts_real_id_formats(self):
        from validation import is_valid_id
        good = [
            "Alice-7f3a",
            "Bob-Smith-2d9e",
            "2025-11-15_CUDO-Mixed_vs_Alexandria_1763235977720",
            "2025-11-15T10-23-45-123456",
            "2025-11-15T10-23-45_001",
            "X7K2M",
            "abc123",
        ]
        for g in good:
            assert is_valid_id(g), g

    def test_validate_id_rejects_traversal_and_meta(self):
        from validation import is_valid_id
        bad = ["", "..", "../etc", "a/b", "a.b", "a..b", "foo/../bar", "a b", "a%2Fb", "a.json"]
        for b in bad:
            assert not is_valid_id(b), b

    def test_validate_id_raises_http_400(self):
        from fastapi import HTTPException
        from validation import validate_id
        with pytest.raises(HTTPException) as exc:
            validate_id("../secret", "game_id")
        assert exc.value.status_code == 400

    def test_safe_static_path_blocks_escape(self, tmp_path):
        from validation import safe_static_path
        base = tmp_path / "base"
        base.mkdir()
        (base / "ok.txt").write_text("hi")
        secret = tmp_path / "secret.txt"
        secret.write_text("nope")
        # legit file inside base
        assert safe_static_path(base, "ok.txt") == (base / "ok.txt").resolve()
        # escape attempts
        assert safe_static_path(base, "../secret.txt") is None
        assert safe_static_path(base, "sub/../../secret.txt") is None
        # nonexistent
        assert safe_static_path(base, "missing.txt") is None


class TestFileUtils:
    def test_atomic_write_json_roundtrip_no_tmp_left(self, tmp_path):
        from storage.file_utils import atomic_write_json
        target = tmp_path / "x.json"
        atomic_write_json(target, {"a": 1, "b": [1, 2]})
        assert json.loads(target.read_text()) == {"a": 1, "b": [1, 2]}
        # no leftover temp files
        assert list(tmp_path.glob("*.tmp")) == []

    def test_atomic_write_overwrites_completely(self, tmp_path):
        from storage.file_utils import atomic_write_json
        target = tmp_path / "x.json"
        atomic_write_json(target, {"big": "x" * 1000})
        atomic_write_json(target, {"small": 1})
        assert json.loads(target.read_text()) == {"small": 1}

    def test_entity_lock_same_key_same_lock(self):
        from storage.file_utils import entity_lock
        a = entity_lock("k1")
        b = entity_lock("k1")
        c = entity_lock("k2")
        assert a is b
        assert a is not c


class TestConfigAuthRequired:
    def test_default_is_true(self, monkeypatch):
        import config
        monkeypatch.delenv("ULTISTATS_AUTH_REQUIRED", raising=False)
        assert config.auth_required() is True

    def test_explicit_false(self, monkeypatch):
        import config
        monkeypatch.setenv("ULTISTATS_AUTH_REQUIRED", "false")
        assert config.auth_required() is False

    def test_explicit_true(self, monkeypatch):
        import config
        monkeypatch.setenv("ULTISTATS_AUTH_REQUIRED", "true")
        assert config.auth_required() is True


# =============================================================================
# Game version pruning + collision-free timestamps (patches GAMES_DIR)
# =============================================================================

class TestGameVersioning:
    @pytest.fixture
    def games_dir(self, tmp_path, monkeypatch):
        import config
        from storage import game_storage
        d = tmp_path / "games"
        d.mkdir()
        monkeypatch.setattr(config, "GAMES_DIR", d)
        monkeypatch.setattr(game_storage, "GAMES_DIR", d)
        return d

    def test_rapid_saves_do_not_collide(self, games_dir):
        from storage import game_storage
        gid = "Test-Game-aaaa"
        data = {"team": "A", "opponent": "B", "points": []}
        stems = set()
        for _ in range(5):
            vf = game_storage.save_game_version(gid, dict(data))
            stems.add(Path(vf).stem)
        # every save produced a distinct version file
        versions = list((games_dir / gid / "versions").glob("*.json"))
        assert len(stems) == 5
        assert len(versions) == 5

    def test_pruning_caps_recent_and_keeps_daily(self, games_dir):
        from storage import game_storage
        versions_dir = games_dir / "G" / "versions"
        versions_dir.mkdir(parents=True)
        # Seed 3 days of versions, 5 per day
        for day in ("2025-01-01", "2025-01-02", "2025-01-03"):
            for i in range(5):
                (versions_dir / f"{day}T10-00-0{i}.json").write_text("{}")
        # Keep most-recent 3, thin older to one-per-day
        game_storage._prune_versions(versions_dir, max_versions=3)
        remaining = sorted(p.stem for p in versions_dir.glob("*.json"))
        # 3 most-recent (all on day 3) + 1 daily snapshot for day1 and day2
        assert "2025-01-03T10-00-04" in remaining
        assert "2025-01-03T10-00-02" in remaining
        # older days thinned to their last version only
        assert "2025-01-01T10-00-04" in remaining
        assert "2025-01-02T10-00-04" in remaining
        assert "2025-01-01T10-00-00" not in remaining
        # 3 most-recent (day3: 02,03,04) + daily snapshots of the older bucket
        # (day1-04, day2-04, and day3-01 which fell into the older bucket).
        assert remaining == [
            "2025-01-01T10-00-04",
            "2025-01-02T10-00-04",
            "2025-01-03T10-00-01",
            "2025-01-03T10-00-02",
            "2025-01-03T10-00-03",
            "2025-01-03T10-00-04",
        ]

    def test_traversal_game_id_rejected_in_storage(self, games_dir):
        from storage import game_storage
        # game_exists must not escape GAMES_DIR
        assert game_storage.game_exists("../../etc") is False
        with pytest.raises(FileNotFoundError):
            game_storage.get_game_current("../secret")


# =============================================================================
# HTTP tests — temp data dir, real storage, auth via dependency overrides
# =============================================================================

MOCK_COACH = {"id": "coach-a", "email": "coach-a@test", "role": "authenticated"}
MOCK_OUTSIDER = {"id": "outsider", "email": "out@test", "role": "authenticated"}


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """Temp data dir with a team, a player on it, and a coach membership.
    Restores the patched config/storage dirs on teardown."""
    data_dir = tmp_path_factory.mktemp("sec_data")

    import config
    from storage import (
        team_storage, player_storage, membership_storage, index_storage,
    )

    patches = [
        (config, "GAMES_DIR", data_dir / "games"),
        (config, "TEAMS_DIR", data_dir / "teams"),
        (config, "PLAYERS_DIR", data_dir / "players"),
        (config, "USERS_DIR", data_dir / "users"),
        (config, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (config, "SHARES_DIR", data_dir / "shares"),
        (config, "INVITES_DIR", data_dir / "invites"),
        (config, "EVENTS_DIR", data_dir / "events"),
        (config, "INDEX_FILE", data_dir / "index.json"),
        # Dir constants the already-imported storage modules captured.
        (team_storage, "TEAMS_DIR", data_dir / "teams"),
        (player_storage, "PLAYERS_DIR", data_dir / "players"),
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

    # Seed: player on a team, coach membership for coach-a.
    pid = player_storage.save_player({"name": "Rostered Player"})
    tid = team_storage.save_team({"name": "Sec Team", "playerIds": [pid]})
    membership_storage.create_membership(team_id=tid, user_id="coach-a", role="coach")
    index_storage.rebuild_index()

    # A second player with no team (orphan).
    orphan = player_storage.save_player({"name": "Orphan Player"})

    yield {"data_dir": data_dir, "team_id": tid, "player_id": pid, "orphan_id": orphan}

    for mod, name, original in saved:
        setattr(mod, name, original)


@pytest.fixture
def client():
    from main import app
    c = TestClient(app)
    yield c
    app.dependency_overrides.clear()


def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


class TestPlayerReadAuthz:
    def test_member_can_read_player(self, client, seeded):
        _as(MOCK_COACH)
        r = client.get(f"/api/players/{seeded['player_id']}")
        assert r.status_code == 200
        assert r.json()["name"] == "Rostered Player"

    def test_outsider_cannot_read_player(self, client, seeded):
        _as(MOCK_OUTSIDER)
        r = client.get(f"/api/players/{seeded['player_id']}")
        assert r.status_code == 403

    def test_list_players_filtered_to_accessible(self, client, seeded):
        _as(MOCK_COACH)
        r = client.get("/api/players")
        assert r.status_code == 200
        names = [p["name"] for p in r.json()["players"]]
        assert "Rostered Player" in names
        # orphan player not on coach-a's teams → not listed
        assert "Orphan Player" not in names

    def test_outsider_list_is_empty(self, client, seeded):
        _as(MOCK_OUTSIDER)
        r = client.get("/api/players")
        assert r.status_code == 200
        assert r.json()["players"] == []


class TestPlayerOverwriteHole:
    def test_outsider_cannot_overwrite_existing_player(self, client, seeded):
        _as(MOCK_OUTSIDER)
        r = client.post("/api/players", json={
            "id": seeded["player_id"],
            "name": "HIJACKED",
        })
        assert r.status_code == 403
        # The player record is unchanged.
        _as(MOCK_COACH)
        r2 = client.get(f"/api/players/{seeded['player_id']}")
        assert r2.json()["name"] == "Rostered Player"

    def test_coach_can_overwrite_own_player(self, client, seeded):
        _as(MOCK_COACH)
        r = client.post("/api/players", json={
            "id": seeded["player_id"],
            "name": "Renamed By Coach",
        })
        assert r.status_code == 200
        assert r.json()["player"]["name"] == "Renamed By Coach"


class TestProxyImageSSRF:
    def test_requires_auth(self, client, seeded):
        # No override → auth required (default true) → 401
        r = client.post("/api/proxy-image", json={"url": "http://example.com/x.png"})
        assert r.status_code == 401

    @pytest.mark.parametrize("url", [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:8000/api",
        "http://localhost/x.png",
        "http://10.0.0.5/i.png",
        "http://[::1]/x.png",
    ])
    def test_blocks_private_and_metadata(self, client, seeded, url):
        _as(MOCK_COACH)
        r = client.post("/api/proxy-image", json={"url": url})
        assert r.status_code == 400
        assert "not allowed" in r.json()["detail"].lower()

    def test_rejects_non_http_scheme(self, client, seeded):
        _as(MOCK_COACH)
        r = client.post("/api/proxy-image", json={"url": "ftp://x/y"})
        assert r.status_code == 400


class TestStaticTraversal:
    def test_traversal_blocked(self, client, seeded):
        for path in ["/ultistats/game/../../config.py",
                     "/app/../../config.py",
                     "/landing/../../config.py"]:
            r = client.get(path)
            assert r.status_code == 404, path

    def test_legit_static_served(self, client, seeded):
        r = client.get("/ultistats/version.json")
        assert r.status_code == 200
