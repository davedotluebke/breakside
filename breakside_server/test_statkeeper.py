"""
Tests for the Stat Keeper membership role.

A stat keeper records games for a team — starts, tracks and ends them, and
holds the Active/Line Coach controller roles — but administers nothing: no
roster or settings edits, no invites, no member removal, no email addresses,
no mailing lists, no share links, no deleting or restoring games. The role
exists so a sidelined player or a parent can keep stats on a scrimmage
without being handed the coaches' contact lists.

The checks below are the matrix that defines the role: what a stat keeper
can do that a viewer cannot, and what a coach can do that a stat keeper
cannot. They drive the real auth dependencies against real storage in a
temp data dir.

Run: cd breakside_server && python -m pytest test_statkeeper.py -v
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient


COACH = {"id": "sk-coach", "email": "coach@test", "role": "authenticated"}
KEEPER = {"id": "sk-keeper", "email": "keeper@test", "role": "authenticated"}
VIEWER = {"id": "sk-viewer", "email": "viewer@test", "role": "authenticated"}
OUTSIDER = {"id": "sk-outsider", "email": "out@test", "role": "authenticated"}
OTHER_COACH = {"id": "sk-other-coach", "email": "other@test", "role": "authenticated"}
JOINER = {"id": "sk-joiner", "email": "joiner@test", "role": "authenticated"}

GAME_ID = "2026-10-30_Keeper-Test-Team_vs_Rivals_k33p"


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    """Temp data dir with one team (coach, stat keeper and viewer members)
    and one game in progress. Restores patched config/storage dirs on
    teardown."""
    data_dir = tmp_path_factory.mktemp("statkeeper_data")

    import config
    from storage import (
        game_storage, team_storage, player_storage, membership_storage,
        share_storage, index_storage, event_storage, invite_storage,
        user_storage,
    )

    patches = [
        (config, "DATA_DIR", data_dir),
        (config, "GAMES_DIR", data_dir / "games"),
        (config, "TEAMS_DIR", data_dir / "teams"),
        (config, "PLAYERS_DIR", data_dir / "players"),
        (config, "USERS_DIR", data_dir / "users"),
        (config, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (config, "SHARES_DIR", data_dir / "shares"),
        (config, "INVITES_DIR", data_dir / "invites"),
        (config, "EVENTS_DIR", data_dir / "events"),
        (config, "INDEX_FILE", data_dir / "index.json"),
        (game_storage, "GAMES_DIR", data_dir / "games"),
        (event_storage, "EVENTS_DIR", data_dir / "events"),
        (team_storage, "TEAMS_DIR", data_dir / "teams"),
        (player_storage, "PLAYERS_DIR", data_dir / "players"),
        (user_storage, "USERS_DIR", data_dir / "users"),
        (membership_storage, "MEMBERSHIPS_DIR", data_dir / "memberships"),
        (membership_storage, "INDEX_FILE", data_dir / "memberships" / "_index.json"),
        (share_storage, "SHARES_DIR", data_dir / "shares"),
        (share_storage, "INDEX_FILE", data_dir / "shares" / "_index.json"),
        (invite_storage, "INVITES_DIR", data_dir / "invites"),
        (invite_storage, "INDEX_FILE", data_dir / "invites" / "_index.json"),
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

    for u, name in ((COACH, "Coach C"), (KEEPER, "Keeper K"), (VIEWER, "Viewer V")):
        user_storage.save_user({"id": u["id"], "email": u["email"], "displayName": name})

    pid = player_storage.save_player({"name": "Rostered Player"})
    team_id = team_storage.save_team({"name": "Keeper Test Team", "playerIds": [pid]})
    membership_storage.create_membership(team_id=team_id, user_id=COACH["id"], role="coach")
    membership_storage.create_membership(team_id=team_id, user_id=KEEPER["id"], role="statkeeper")
    membership_storage.create_membership(team_id=team_id, user_id=VIEWER["id"], role="viewer")

    game_storage.save_game_version(GAME_ID, _game_doc(team_id))
    index_storage.rebuild_index()

    yield {"data_dir": data_dir, "team_id": team_id, "player_id": pid}

    for mod, name, original in saved:
        setattr(mod, name, original)


def _game_doc(team_id, **overrides):
    doc = {
        "id": GAME_ID,
        "teamId": team_id,
        "team": "Keeper Test Team",
        "opponent": "Rivals",
        "scores": {"team": 2, "opponent": 1},
        "gameStartTimestamp": "2026-10-30T18:00:00Z",
        "gameEndTimestamp": None,
        "points": [],
    }
    doc.update(overrides)
    return doc


@pytest.fixture
def client(seeded, monkeypatch):
    monkeypatch.setenv("BREAKSIDE_AUTH_REQUIRED", "true")
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
# The role itself
# =============================================================================

class TestRoleDefinition:
    def test_statkeeper_is_a_recorder_and_viewer_is_not(self):
        from storage.membership_storage import GAME_RECORDER_ROLES, ROLES
        assert set(ROLES) == {"coach", "statkeeper", "viewer"}
        assert GAME_RECORDER_ROLES == {"coach", "statkeeper"}

    def test_membership_round_trips(self, seeded):
        from storage.membership_storage import get_user_team_role, get_team_stat_keepers, get_team_coaches
        assert get_user_team_role(KEEPER["id"], seeded["team_id"]) == "statkeeper"
        assert get_team_stat_keepers(seeded["team_id"]) == [KEEPER["id"]]
        # A stat keeper is not a coach: last-coach protection, account-deletion
        # handover and the mail directory all key off this list.
        assert KEEPER["id"] not in get_team_coaches(seeded["team_id"])


# =============================================================================
# What a stat keeper CAN do: everything it takes to record a game
# =============================================================================

class TestStatKeeperRecordsGames:
    def test_syncs_an_existing_game(self, client, seeded):
        _as(KEEPER)
        r = client.post(f"/api/games/{GAME_ID}/sync",
                        json=_game_doc(seeded["team_id"], scores={"team": 3, "opponent": 1}))
        assert r.status_code == 200
        assert r.json()["status"] == "synced"

    def test_starts_a_new_game(self, client, seeded):
        """Sync is the create path too: a stat keeper can start a game, not
        only continue one a coach opened."""
        from storage import game_storage
        new_id = "2026-10-31_Keeper-Test-Team_vs_Others_n3w1"
        _as(KEEPER)
        r = client.post(f"/api/games/{new_id}/sync",
                        json=_game_doc(seeded["team_id"], id=new_id, opponent="Others"))
        assert r.status_code == 200
        assert game_storage.get_game_current(new_id)["teamId"] == seeded["team_id"]

    def test_cannot_start_a_game_for_a_team_they_do_not_record(self, client, seeded):
        from storage import team_storage, membership_storage
        other = team_storage.save_team({"name": "Other Team", "playerIds": []})
        membership_storage.create_membership(team_id=other, user_id=OTHER_COACH["id"], role="coach")
        _as(KEEPER)
        r = client.post("/api/games/2026-10-31_Other-Team_vs_X_oth3r/sync",
                        json=_game_doc(other, id="x", team="Other Team"))
        assert r.status_code == 403

    def test_ends_the_game_through_sync(self, client, seeded):
        _as(KEEPER)
        ended = _game_doc(seeded["team_id"], gameEndTimestamp="2026-10-30T20:00:00Z")
        assert client.post(f"/api/games/{GAME_ID}/sync", json=ended).status_code == 200
        from storage import game_storage
        assert game_storage.get_game_current(GAME_ID)["gameEndTimestamp"] == "2026-10-30T20:00:00Z"
        # Put it back in progress for the controller tests.
        client.post(f"/api/games/{GAME_ID}/sync", json=_game_doc(seeded["team_id"]))

    def test_holds_the_controller_roles(self, client, seeded):
        from storage.controller_storage import clear_game_state
        clear_game_state(GAME_ID)
        _as(KEEPER)
        r = client.post(f"/api/games/{GAME_ID}/ping", json={})
        assert r.status_code == 200
        # First one in gets both roles, exactly as a solo coach does.
        from storage.controller_storage import get_controller_state
        state = get_controller_state(GAME_ID)
        assert state["activeCoach"]["userId"] == KEEPER["id"]
        assert state["lineCoach"]["userId"] == KEEPER["id"]
        assert client.post(f"/api/games/{GAME_ID}/release", json={"role": "lineCoach"}).status_code == 200
        assert client.post(f"/api/games/{GAME_ID}/claim-line").status_code == 200
        assert client.post(f"/api/games/{GAME_ID}/claim-active").status_code == 200
        assert client.get(f"/api/games/{GAME_ID}/controller").status_code == 200
        clear_game_state(GAME_ID)

    def test_reads_what_a_viewer_reads(self, client, seeded):
        _as(KEEPER)
        tid = seeded["team_id"]
        assert client.get(f"/api/teams/{tid}").status_code == 200
        assert client.get(f"/api/teams/{tid}/players").status_code == 200
        assert client.get(f"/api/teams/{tid}/games").status_code == 200
        # 404 means "no active game", which is still a pass through the gate
        # (an outsider gets 403 before the lookup).
        assert client.get(f"/api/teams/{tid}/active-game").status_code in (200, 404)
        assert client.get(f"/api/games/{GAME_ID}").status_code == 200
        assert client.get(f"/api/games/{GAME_ID}/poll").status_code == 200
        assert client.get(f"/api/games/{GAME_ID}/versions").status_code == 200
        assert client.get(f"/api/players/{seeded['player_id']}").status_code == 200

    def test_narration_token_gate_admits_recorders_only(self, seeded, monkeypatch):
        """POST /api/narration/token spends the operator's OpenAI budget, so
        it asks whether the caller records for any team at all."""
        monkeypatch.setenv("BREAKSIDE_AUTH_REQUIRED", "true")
        from auth.dependencies import require_any_recorder

        async def allowed(user):
            try:
                await require_any_recorder(user)
                return True
            except HTTPException as exc:
                assert exc.status_code == 403
                return False

        assert asyncio.run(allowed(COACH)) is True
        assert asyncio.run(allowed(KEEPER)) is True
        assert asyncio.run(allowed(VIEWER)) is False
        assert asyncio.run(allowed(OUTSIDER)) is False


# =============================================================================
# What a stat keeper CANNOT do: anything administrative
# =============================================================================

class TestStatKeeperIsNotACoach:
    """Each endpoint here is one a coach passes. The 403 is the whole point of
    the role: recording a game must not hand out the team's administration or
    its members' contact details."""

    def test_no_invites(self, client, seeded):
        _as(KEEPER)
        tid = seeded["team_id"]
        assert client.post(f"/api/teams/{tid}/invites", json={"role": "viewer"}).status_code == 403
        assert client.get(f"/api/teams/{tid}/invites").status_code == 403

    def test_no_member_removal(self, client, seeded):
        _as(KEEPER)
        r = client.delete(f"/api/teams/{seeded['team_id']}/members/{VIEWER['id']}")
        assert r.status_code == 403

    def test_no_member_email_addresses(self, client, seeded):
        """The members list is readable (a stat keeper can see who else is on
        the team), but other members' addresses are withheld as for a viewer.
        Their own is still there."""
        _as(KEEPER)
        r = client.get(f"/api/teams/{seeded['team_id']}/members")
        assert r.status_code == 200
        rows = {m["userId"]: m for m in r.json()["members"]}
        assert "email" not in rows[COACH["id"]]
        assert "email" not in rows[VIEWER["id"]]
        assert COACH["email"] not in r.text
        assert rows[KEEPER["id"]]["email"] == KEEPER["email"]
        assert rows[KEEPER["id"]]["role"] == "statkeeper"

    def test_no_mailing_lists(self, client, seeded):
        _as(KEEPER)
        tid = seeded["team_id"]
        assert client.get(f"/api/teams/{tid}/mail").status_code == 403
        assert client.post(f"/api/teams/{tid}/mail", json={"slug": "keepers"}).status_code == 403

    def test_no_team_edits(self, client, seeded):
        _as(KEEPER)
        tid = seeded["team_id"]
        assert client.put(f"/api/teams/{tid}", json={"name": "Renamed"}).status_code == 403
        assert client.delete(f"/api/teams/{tid}").status_code == 403
        # The offline-sync upsert of an existing team is the same door.
        assert client.post("/api/teams", json={"id": tid, "name": "Renamed"}).status_code == 403

    def test_no_roster_edits(self, client, seeded):
        _as(KEEPER)
        pid = seeded["player_id"]
        assert client.post("/api/players", json={"name": "New Player"}).status_code == 403
        assert client.put(f"/api/players/{pid}", json={"name": "Renamed"}).status_code == 403
        assert client.delete(f"/api/players/{pid}").status_code == 403

    def test_no_events(self, client, seeded):
        _as(KEEPER)
        r = client.post("/api/events", json={"name": "Fall Classic", "teamId": seeded["team_id"]})
        assert r.status_code == 403

    def test_no_game_administration(self, client, seeded):
        """Delete, restore, the team-list metadata patches: a coach's calls."""
        _as(KEEPER)
        assert client.delete(f"/api/games/{GAME_ID}").status_code == 403
        assert client.post(f"/api/games/{GAME_ID}/restore/2026-10-30T18-00-00").status_code == 403
        assert client.patch(f"/api/games/{GAME_ID}/phase", json={"phase": "Pool"}).status_code == 403
        assert client.patch(f"/api/games/{GAME_ID}/end", json={}).status_code == 403
        assert client.patch(f"/api/games/{GAME_ID}/scrimmage", json={"team": "A"}).status_code == 403

    def test_no_share_links(self, client, seeded):
        _as(KEEPER)
        assert client.post(f"/api/games/{GAME_ID}/share").status_code == 403
        assert client.get(f"/api/games/{GAME_ID}/shares").status_code == 403

    def test_the_403_names_the_role_that_was_needed(self, client, seeded):
        _as(KEEPER)
        r = client.delete(f"/api/games/{GAME_ID}")
        assert r.json()["detail"] == "Coach access required for this team"
        _as(VIEWER)
        r = client.post(f"/api/games/{GAME_ID}/claim-active")
        assert r.json()["detail"] == "Coach or stat keeper access required for this team"


# =============================================================================
# A viewer is still read-only
# =============================================================================

class TestViewerStillReadOnly:
    def test_viewer_cannot_sync_or_hold_roles(self, client, seeded):
        _as(VIEWER)
        assert client.post(f"/api/games/{GAME_ID}/sync",
                           json=_game_doc(seeded["team_id"])).status_code == 403
        assert client.post(f"/api/games/{GAME_ID}/ping", json={}).status_code == 403
        assert client.post(f"/api/games/{GAME_ID}/claim-active").status_code == 403
        assert client.post(f"/api/games/{GAME_ID}/claim-line").status_code == 403

    def test_outsider_cannot_sync(self, client, seeded):
        _as(OUTSIDER)
        assert client.post(f"/api/games/{GAME_ID}/sync",
                           json=_game_doc(seeded["team_id"])).status_code == 403


# =============================================================================
# Invites
# =============================================================================

class TestStatKeeperInvites:
    def test_coach_mints_a_single_use_week_long_invite(self, client, seeded):
        _as(COACH)
        r = client.post(f"/api/teams/{seeded['team_id']}/invites", json={"role": "statkeeper"})
        assert r.status_code == 200
        invite = r.json()["invite"]
        assert invite["role"] == "statkeeper"
        # Write access to games is handed out like a coach invite: one use,
        # a week — not like the open-ended viewer link.
        assert invite["maxUses"] == 1
        expires = datetime.fromisoformat(invite["expiresAt"].replace("Z", "+00:00"))
        assert timedelta(days=6, hours=23) < expires - datetime.now(timezone.utc) <= timedelta(days=7)

    def test_storage_defaults_match(self, seeded):
        from storage.invite_storage import create_invite
        inv = create_invite(team_id=seeded["team_id"], role="statkeeper", created_by=COACH["id"])
        assert inv["maxUses"] == 1
        assert inv["expiresAt"] is not None

    def test_info_and_redeem_make_a_statkeeper(self, client, seeded):
        from storage.membership_storage import get_user_team_role
        _as(COACH)
        code = client.post(f"/api/teams/{seeded['team_id']}/invites",
                           json={"role": "statkeeper"}).json()["code"]
        _as(JOINER)
        info = client.get(f"/api/invites/{code}/info")
        assert info.status_code == 200
        assert info.json()["role"] == "statkeeper"
        r = client.post(f"/api/invites/{code}/redeem")
        assert r.status_code == 200
        assert r.json()["membership"]["role"] == "statkeeper"
        assert get_user_team_role(JOINER["id"], seeded["team_id"]) == "statkeeper"
        # Single use, like a coach invite.
        _as(OUTSIDER)
        assert client.post(f"/api/invites/{code}/redeem").status_code == 410

    def test_unknown_role_is_rejected(self, client, seeded):
        _as(COACH)
        r = client.post(f"/api/teams/{seeded['team_id']}/invites", json={"role": "scorekeeper"})
        assert r.status_code == 422
