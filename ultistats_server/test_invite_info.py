"""
Tests for GET /api/invites/{code}/info already-a-member handling (F3):
the endpoint stays public, but an authenticated caller who is already on
the invite's team gets 409 so the join page can show its already-member
state up front instead of only discovering it at redeem time.

Run: cd ultistats_server && python -m pytest test_invite_info.py -v
"""
import pytest
from fastapi.testclient import TestClient


MOCK_MEMBER = {"id": "inviteinfo-member", "email": "m@test", "role": "authenticated"}
MOCK_NONMEMBER = {"id": "inviteinfo-outsider", "email": "o@test", "role": "authenticated"}


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """Temp data dir with one team, one coach member, and a viewer invite.
    Restores patched config/storage dirs on teardown."""
    data_dir = tmp_path_factory.mktemp("invite_info_data")

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

    team_id = team_storage.save_team({"name": "Invite Info Team", "playerIds": []})
    membership_storage.create_membership(
        team_id=team_id, user_id=MOCK_MEMBER["id"], role="coach")
    index_storage.rebuild_index()

    invite = invite_storage.create_invite(
        team_id=team_id, role="viewer", created_by=MOCK_MEMBER["id"], expires_days=30)

    yield {"data_dir": data_dir, "team_id": team_id, "code": invite["code"]}

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
    from auth.jwt_validation import get_optional_user
    app.dependency_overrides[get_optional_user] = lambda: user


class TestInviteInfoAlreadyMember:
    def test_anonymous_gets_info(self, client, seeded):
        _as(None)
        r = client.get(f"/api/invites/{seeded['code']}/info")
        assert r.status_code == 200
        assert r.json()["teamName"] == "Invite Info Team"
        assert r.json()["role"] == "viewer"

    def test_non_member_gets_info(self, client, seeded):
        _as(MOCK_NONMEMBER)
        r = client.get(f"/api/invites/{seeded['code']}/info")
        assert r.status_code == 200
        assert r.json()["teamName"] == "Invite Info Team"

    def test_member_gets_409(self, client, seeded):
        _as(MOCK_MEMBER)
        r = client.get(f"/api/invites/{seeded['code']}/info")
        assert r.status_code == 409
        assert "already a member" in r.json()["detail"].lower()

    def test_unknown_code_still_404(self, client, seeded):
        _as(MOCK_MEMBER)
        assert client.get("/api/invites/ZZZZZZZZ/info").status_code == 404
