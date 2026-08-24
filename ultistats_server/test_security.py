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
            "2025-11-15_Team-D_vs_Team-F_1763235977720",
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
        from storage import game_storage, index_storage
        d = tmp_path / "games"
        d.mkdir()
        monkeypatch.setattr(config, "GAMES_DIR", d)
        monkeypatch.setattr(game_storage, "GAMES_DIR", d)
        # save_game_version also updates the search index — keep that in
        # the tmp dir instead of the real data/index.json.
        monkeypatch.setattr(config, "INDEX_FILE", tmp_path / "index.json")
        monkeypatch.setattr(index_storage, "INDEX_FILE", tmp_path / "index.json")
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


class TestTeamOverwriteHole:
    """POST /api/teams was anonymous AND skipped validate_id on the body's `id`.

    Because the id came from the body it was never path-normalized, so `../`
    escaped TEAMS_DIR: writing `data/users/<uuid>.json` with `isAdmin: true`
    granted global admin to any caller, with no credentials at all.
    """

    def test_anonymous_cannot_overwrite_team(self, client, seeded):
        # No _as() override -> real dependency -> auth required (default true).
        r = client.post("/api/teams", json={"id": seeded["team_id"], "name": "HIJACKED"})
        assert r.status_code == 401
        _as(MOCK_COACH)
        assert client.get(f"/api/teams/{seeded['team_id']}").json()["name"] == "Sec Team"

    def test_anonymous_cannot_plant_admin_user_via_traversal(self, client, seeded):
        victim = "attacker-uuid"
        r = client.post("/api/teams", json={
            "id": f"../users/{victim}",
            "name": "x",
            "isAdmin": True,
        })
        assert r.status_code == 401
        assert not (seeded["data_dir"] / "users" / f"{victim}.json").exists()

    def test_authenticated_traversal_id_is_rejected(self, client, seeded):
        _as(MOCK_OUTSIDER)
        victim = "escalated-uuid"
        r = client.post("/api/teams", json={
            "id": f"../users/{victim}",
            "name": "x",
            "isAdmin": True,
        })
        assert r.status_code == 400
        assert not (seeded["data_dir"] / "users" / f"{victim}.json").exists()

    def test_non_string_id_is_a_clean_400(self, client, seeded):
        _as(MOCK_OUTSIDER)
        r = client.post("/api/teams", json={"id": 123, "name": "x"})
        assert r.status_code == 400

    def test_outsider_cannot_overwrite_existing_team(self, client, seeded):
        _as(MOCK_OUTSIDER)
        r = client.post("/api/teams", json={"id": seeded["team_id"], "name": "HIJACKED"})
        assert r.status_code == 403
        # Team document — including its roster — is untouched.
        _as(MOCK_COACH)
        team = client.get(f"/api/teams/{seeded['team_id']}").json()
        assert team["name"] == "Sec Team"
        assert team["playerIds"] == [seeded["player_id"]]

    def test_coach_can_still_upsert_own_team(self, client, seeded):
        """The offline-sync path (POST doubling as update) must keep working."""
        _as(MOCK_COACH)
        r = client.post("/api/teams", json={
            "id": seeded["team_id"],
            "name": "Renamed By Coach",
            "playerIds": [seeded["player_id"]],
        })
        assert r.status_code == 200
        assert r.json()["team"]["name"] == "Renamed By Coach"
        # Restore so later tests see the seeded name.
        client.post("/api/teams", json={
            "id": seeded["team_id"],
            "name": "Sec Team",
            "playerIds": [seeded["player_id"]],
        })

    def test_creating_a_new_team_makes_creator_coach(self, client, seeded):
        _as(MOCK_OUTSIDER)
        r = client.post("/api/teams", json={"name": "Outsider Own Team"})
        assert r.status_code == 200
        new_id = r.json()["team_id"]
        # Creator got coach access; the seeded team is still off-limits to them.
        assert client.get(f"/api/teams/{new_id}").status_code == 200
        assert client.get(f"/api/teams/{seeded['team_id']}").status_code == 403


class TestEntityStoreContainment:
    """Storage-layer backstop: JsonEntityStore must refuse an escaping id even
    if an API-layer validate_id is ever missed again."""

    @pytest.fixture
    def store(self, tmp_path):
        from storage.entity_store import JsonEntityStore
        d = tmp_path / "things"
        d.mkdir()
        return JsonEntityStore(kind="Thing", dir_getter=lambda: d,
                               sort_key=lambda t: t.get("name", "")), tmp_path

    @pytest.mark.parametrize("bad_id", [
        "../escape", "../../escape", "sub/nested", "/absolute",
        "_index", "_anything", 123, None,
    ])
    def test_file_rejects_unsafe_ids(self, store, bad_id):
        s, _ = store
        with pytest.raises(ValueError):
            s._file(bad_id)

    def test_exists_reports_unsafe_id_as_absent(self, store):
        s, _ = store
        assert s.exists("../escape") is False
        assert s.exists("_index") is False

    def test_save_cannot_write_outside_the_store_dir(self, store):
        s, tmp_path = store
        with pytest.raises(ValueError):
            s.save({"name": "pwn", "isAdmin": True}, "../../pwned")
        assert not (tmp_path / "pwned.json").exists()
        assert not (tmp_path.parent / "pwned.json").exists()

    def test_normal_ids_still_work(self, store):
        s, _ = store
        eid = s.save({"name": "Fine"}, "Team-ab12")
        assert eid == "Team-ab12"
        assert s.exists("Team-ab12")
        assert s.get("Team-ab12")["name"] == "Fine"


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


# =============================================================================
# Player-team index: authorization must not fail open on a stale cache
# =============================================================================

class TestPlayerTeamIndexAuthorization:
    """Regression tests for the 2026-08 stale-index finding.

    ``playerTeams`` is a cache, and ``auth/dependencies.py`` reads "player has
    no teams" as "orphaned player — any Coach may read/edit/delete it". So a
    cache MISS fails OPEN. In production the index had gone eight months
    without a rebuild and 298 of 316 player records (206 of them on live
    rosters) were reachable by any account that created a throwaway team.

    The authorization path therefore uses ``get_player_teams_verified``, which
    confirms an empty index answer against the team rosters on disk.
    """

    @pytest.fixture
    def index_env(self, tmp_path, monkeypatch):
        from storage import index_storage
        teams_dir = tmp_path / "teams"
        teams_dir.mkdir()
        index_file = tmp_path / "index.json"
        monkeypatch.setattr(index_storage, "TEAMS_DIR", teams_dir)
        monkeypatch.setattr(index_storage, "INDEX_FILE", index_file)
        return teams_dir, index_file

    @staticmethod
    def _write_team(teams_dir, team_id, player_ids):
        (teams_dir / f"{team_id}.json").write_text(
            json.dumps({"id": team_id, "name": team_id, "playerIds": player_ids})
        )

    @staticmethod
    def _write_index(index_file, player_teams):
        index_file.write_text(json.dumps({
            "lastRebuilt": "2025-01-01T00:00:00",
            "playerGames": {}, "teamGames": {}, "gameRoster": {},
            "playerTeams": player_teams,
        }))

    def test_stale_index_miss_does_not_read_as_orphan(self, index_env):
        """The regression: a rostered player absent from the index."""
        teams_dir, index_file = index_env
        from storage import index_storage

        self._write_team(teams_dir, "Team-aaaa", ["Alice-1111"])
        self._write_index(index_file, {})  # stale — nothing indexed

        # The raw cache read is what failed open...
        assert index_storage.get_player_teams("Alice-1111") == []
        # ...the authorization read must not.
        assert index_storage.get_player_teams_verified("Alice-1111") == ["Team-aaaa"]

    def test_genuinely_unrostered_player_resolves_empty(self, index_env):
        teams_dir, index_file = index_env
        from storage import index_storage

        self._write_team(teams_dir, "Team-aaaa", ["Alice-1111"])
        self._write_index(index_file, {})

        assert index_storage.get_player_teams_verified("Nobody-9999") == []

    def test_index_hit_does_not_need_the_roster_scan(self, index_env):
        """A fresh index answers without touching disk — no team files exist."""
        teams_dir, index_file = index_env
        from storage import index_storage

        self._write_index(index_file, {"Alice-1111": ["Team-aaaa"]})

        assert index_storage.get_player_teams_verified("Alice-1111") == ["Team-aaaa"]

    def test_update_index_for_team_adds_and_removes_links(self, index_env):
        teams_dir, index_file = index_env
        from storage import index_storage

        self._write_index(index_file, {})
        index_storage.update_index_for_team(
            "Team-aaaa", {"id": "Team-aaaa", "playerIds": ["Alice-1111", "Bob-2222"]}
        )
        assert index_storage.get_player_teams("Alice-1111") == ["Team-aaaa"]
        assert index_storage.get_player_teams("Bob-2222") == ["Team-aaaa"]

        # Bob is dropped from the roster: an add-only update would leave his
        # link behind, which authorization reads as continued Coach access.
        index_storage.update_index_for_team(
            "Team-aaaa", {"id": "Team-aaaa", "playerIds": ["Alice-1111"]}
        )
        assert index_storage.get_player_teams("Alice-1111") == ["Team-aaaa"]
        assert index_storage.get_player_teams("Bob-2222") == []

    def test_removal_preserves_memberships_on_other_teams(self, index_env):
        teams_dir, index_file = index_env
        from storage import index_storage

        self._write_index(index_file, {"Alice-1111": ["Team-aaaa", "Team-bbbb"]})
        index_storage.update_index_for_team("Team-aaaa", {"id": "Team-aaaa", "playerIds": []})

        assert index_storage.get_player_teams("Alice-1111") == ["Team-bbbb"]

    def test_saving_a_team_keeps_the_index_current(self, tmp_path, monkeypatch):
        """save_team/update_team must refresh playerTeams, not wait for a rebuild."""
        from storage import index_storage, team_storage

        teams_dir = tmp_path / "teams"
        teams_dir.mkdir()
        index_file = tmp_path / "index.json"
        monkeypatch.setattr(index_storage, "TEAMS_DIR", teams_dir)
        monkeypatch.setattr(index_storage, "INDEX_FILE", index_file)
        monkeypatch.setattr(team_storage, "TEAMS_DIR", teams_dir)
        self._write_index(index_file, {})

        team_id = team_storage.save_team(
            {"name": "Test Team", "playerIds": ["Alice-1111"]}, "Team-aaaa"
        )
        assert index_storage.get_player_teams("Alice-1111") == [team_id]

        team_storage.update_team(team_id, {"name": "Test Team", "playerIds": []})
        assert index_storage.get_player_teams("Alice-1111") == []
