"""
Tests for the invite redemption lifecycle and the /join short-link route.

POST /api/invites/{code}/redeem had no coverage before the 2026-07-22 invite-
URL fix; these pin the full lifecycle (single-use coach invites, already-
member, revoked/expired/unknown codes, case-insensitivity, multi-use viewer
invites) plus the /join/{code} redirect that replaced direct join.html serving
(serving the page at /join/<code> broke its own relative asset URLs).

Run: cd ultistats_server && python -m pytest test_invite_redeem.py -v
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient


OWNER = {"id": "redeem-owner", "email": "owner@test", "role": "authenticated"}
JOINER_A = {"id": "redeem-joiner-a", "email": "a@test", "role": "authenticated"}
JOINER_B = {"id": "redeem-joiner-b", "email": "b@test", "role": "authenticated"}
VIEWER_1 = {"id": "redeem-viewer-1", "email": "v1@test", "role": "authenticated"}
VIEWER_2 = {"id": "redeem-viewer-2", "email": "v2@test", "role": "authenticated"}


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """Temp data dir with one team whose coach is OWNER.
    Restores patched config/storage dirs on teardown."""
    data_dir = tmp_path_factory.mktemp("invite_redeem_data")

    import config
    from storage import (
        team_storage, player_storage, membership_storage, index_storage,
        invite_storage,
    )

    patches = [
        (config, "TEAMS_DIR", data_dir / "teams"),
        (config, "PLAYERS_DIR", data_dir / "players"),
        (config, "USERS_DIR", data_dir / "users"),
        (config, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (config, "INVITES_DIR", data_dir / "invites"),
        (config, "INDEX_FILE", data_dir / "index.json"),
        (team_storage, "TEAMS_DIR", data_dir / "teams"),
        (player_storage, "PLAYERS_DIR", data_dir / "players"),
        (membership_storage, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (membership_storage, "INDEX_FILE", data_dir / "memberships" / "_index.json"),
        (invite_storage, "INVITES_DIR", data_dir / "invites"),
        (invite_storage, "INDEX_FILE", data_dir / "invites" / "_index.json"),
        (index_storage, "INDEX_FILE", data_dir / "index.json"),
        (index_storage, "TEAMS_DIR", data_dir / "teams"),
        (index_storage, "PLAYERS_DIR", data_dir / "players"),
    ]
    saved = [(mod, name, getattr(mod, name)) for mod, name, _ in patches]
    for mod, name, value in patches:
        if name.endswith("_DIR"):
            value.mkdir(parents=True, exist_ok=True)
        setattr(mod, name, value)

    team_id = team_storage.save_team({"name": "Redeem Test Team", "playerIds": []})
    membership_storage.create_membership(
        team_id=team_id, user_id=OWNER["id"], role="coach")
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


def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


def _mint(seeded, role="coach", **kwargs):
    from storage import invite_storage
    return invite_storage.create_invite(
        team_id=seeded["team_id"], role=role, created_by=OWNER["id"], **kwargs)


class TestCreateInviteUrl:
    def test_coach_invite_minted_with_short_url(self, client, seeded):
        _as(OWNER)
        r = client.post(f"/api/teams/{seeded['team_id']}/invites",
                        json={"role": "coach"})
        assert r.status_code == 200
        body = r.json()
        assert body["url"] == f"https://www.breakside.pro/join/{body['code']}"
        assert len(body["code"]) == 5
        assert body["invite"]["maxUses"] == 1  # coach invites are single-use


class TestRedeem:
    def test_redeem_creates_coach_membership(self, client, seeded):
        from storage.membership_storage import get_user_team_role
        invite = _mint(seeded)
        _as(JOINER_A)
        r = client.post(f"/api/invites/{invite['code']}/redeem")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "joined"
        assert body["membership"]["role"] == "coach"
        assert body["team"]["name"] == "Redeem Test Team"
        assert get_user_team_role(JOINER_A["id"], seeded["team_id"]) == "coach"

    def test_single_use_invite_rejects_second_redeem(self, client, seeded):
        invite = _mint(seeded)
        _as(JOINER_B)
        assert client.post(f"/api/invites/{invite['code']}/redeem").status_code == 200
        _as(VIEWER_1)
        r = client.post(f"/api/invites/{invite['code']}/redeem")
        assert r.status_code == 410
        assert "already been used" in r.json()["detail"]

    def test_existing_member_gets_409(self, client, seeded):
        invite = _mint(seeded)
        _as(OWNER)
        r = client.post(f"/api/invites/{invite['code']}/redeem")
        assert r.status_code == 409
        assert "already a member" in r.json()["detail"].lower()

    def test_unknown_code_404(self, client, seeded):
        _as(JOINER_A)
        assert client.post("/api/invites/QQQQQ/redeem").status_code == 404

    def test_code_is_case_insensitive(self, client, seeded):
        from storage.membership_storage import get_user_team_membership
        invite = _mint(seeded)
        # Fresh user so the redeem isn't rejected as already-member.
        joiner = {"id": "redeem-lowercase", "email": "lc@test", "role": "authenticated"}
        _as(joiner)
        r = client.post(f"/api/invites/{invite['code'].lower()}/redeem")
        assert r.status_code == 200
        assert get_user_team_membership(joiner["id"], seeded["team_id"]) is not None

    def test_revoked_invite_410(self, client, seeded):
        from storage import invite_storage
        invite = _mint(seeded)
        invite_storage.revoke_invite(invite["id"], OWNER["id"])
        _as(VIEWER_1)
        r = client.post(f"/api/invites/{invite['code']}/redeem")
        assert r.status_code == 410
        assert "revoked" in r.json()["detail"]

    def test_expired_invite_410(self, client, seeded):
        from storage import invite_storage
        from storage.file_utils import atomic_write_json
        invite = _mint(seeded)
        invite["expiresAt"] = (
            datetime.now(timezone.utc) - timedelta(days=1)
        ).isoformat().replace("+00:00", "Z")
        atomic_write_json(invite_storage._invite_file(invite["id"]), invite)
        _as(VIEWER_1)
        r = client.post(f"/api/invites/{invite['code']}/redeem")
        assert r.status_code == 410
        assert "expired" in r.json()["detail"]

    def test_viewer_invite_is_multi_use(self, client, seeded):
        from storage import invite_storage
        invite = _mint(seeded, role="viewer")
        for user in (VIEWER_1, VIEWER_2):
            _as(user)
            r = client.post(f"/api/invites/{invite['code']}/redeem")
            assert r.status_code == 200
            assert r.json()["membership"]["role"] == "viewer"
        assert invite_storage.is_invite_valid(
            invite_storage.get_invite(invite["id"]))


class TestJoinShortLink:
    """/join/{code} must REDIRECT to the canonical join page, never serve it.

    Serving join.html at /join/<code> made the page's relative asset URLs
    (join.js etc.) resolve under /join/, where this same route answered them
    with HTML — a dead page. The redirect is the regression guard.
    """

    def test_redirects_to_canonical_join_page(self, client, seeded):
        r = client.get("/join/ABC12", follow_redirects=False)
        assert r.status_code == 302
        assert r.headers["location"] == "/landing/join.html?code=ABC12"

    def test_asset_like_paths_are_not_answered_with_html(self, client, seeded):
        # join.js / landing.css style requests must not get a document back.
        for path in ("/join/join.js", "/join/landing.css", "/join/supabaseInit.js"):
            r = client.get(path, follow_redirects=False)
            assert r.status_code == 404, path

    def test_canonical_join_page_serves_html(self, client, seeded):
        r = client.get("/landing/join.html")
        assert r.status_code == 200
        assert "You've been invited" in r.text
