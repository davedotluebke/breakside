"""
Tests for self-service account deletion (erasure spec § C).

Covers GET /api/auth/me/delete-preview and DELETE /api/auth/me:

- unauthenticated is rejected; there is no way to name another user
- the preview mutates nothing
- a Supabase admin failure aborts BEFORE anything local is touched
- the sole-coach split: blocked when others are on the team, cascaded only
  behind an explicit confirmation when the account is the team's only member
- after a successful delete the user cannot be resolved and no membership,
  invite, game or version file survives

The Supabase admin API is NEVER called for real. Every test either patches
``account_deletion.delete_supabase_auth_user`` outright or clears the config so
the "not configured" branch fires without touching the network.

Run: cd breakside_server && python -m pytest test_account_deletion.py -v
"""
import os

import pytest
from fastapi.testclient import TestClient


SOLO = {"id": "acct-solo", "email": "solo@test", "role": "authenticated"}
SHARED_COACH = {"id": "acct-shared-coach", "email": "shared@test", "role": "authenticated"}
CO_COACH = {"id": "acct-co-coach", "email": "co@test", "role": "authenticated"}
VIEWER = {"id": "acct-viewer", "email": "viewer@test", "role": "authenticated"}
OUTSIDER = {"id": "acct-outsider", "email": "out@test", "role": "authenticated"}

SOLO_GAME = "2026-08-01_Solo-Team_vs_Rivals_s0l0"
SHARED_GAME = "2026-08-02_Shared-Team_vs_Rivals_5h4r"
CO_GAME = "2026-08-03_Co-Team_vs_Rivals_c0c0"


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture
def seeded(tmp_path, monkeypatch):
    """Function-scoped isolated data dir. Deletion is destructive, so no test
    may inherit another's leftovers.

    Storage modules snapshot their dir constants at import time, so both
    ``config`` and each module's captured global are patched (same shape as
    conftest.py's ``narration_data`` and test_shares.py's ``seeded``).

    Seeds four positions the sole-coach logic has to tell apart:

    * ``Solo Team``   — SOLO is the only member. Cascade candidate.
    * ``Shared Team`` — SHARED_COACH is the only coach, VIEWER is also a
                        member. Blocks deletion.
    * ``Co Team``     — SHARED_COACH and CO_COACH both coach it. Survives.
    * SOLO also holds a viewer membership on ``Co Team`` so the
      "membership goes, team carries on" path is exercised too.
    """
    import config
    from storage import (
        game_storage, team_storage, player_storage, user_storage,
        membership_storage, share_storage, invite_storage, event_storage,
        index_storage,
    )

    patches = [
        (config, "DATA_DIR", tmp_path),
        (config, "GAMES_DIR", tmp_path / "games"),
        (config, "TEAMS_DIR", tmp_path / "teams"),
        (config, "PLAYERS_DIR", tmp_path / "players"),
        (config, "USERS_DIR", tmp_path / "users"),
        (config, "MEMBERSHIPS_DIR", tmp_path / "memberships"),
        (config, "SHARES_DIR", tmp_path / "shares"),
        (config, "INVITES_DIR", tmp_path / "invites"),
        (config, "EVENTS_DIR", tmp_path / "events"),
        (config, "INDEX_FILE", tmp_path / "index.json"),
        (game_storage, "GAMES_DIR", tmp_path / "games"),
        (team_storage, "TEAMS_DIR", tmp_path / "teams"),
        (player_storage, "PLAYERS_DIR", tmp_path / "players"),
        (user_storage, "USERS_DIR", tmp_path / "users"),
        (membership_storage, "MEMBERSHIPS_DIR", tmp_path / "memberships"),
        (membership_storage, "INDEX_FILE", tmp_path / "memberships" / "_index.json"),
        (share_storage, "SHARES_DIR", tmp_path / "shares"),
        (share_storage, "INDEX_FILE", tmp_path / "shares" / "_index.json"),
        (invite_storage, "INVITES_DIR", tmp_path / "invites"),
        (invite_storage, "INDEX_FILE", tmp_path / "invites" / "_index.json"),
        (event_storage, "EVENTS_DIR", tmp_path / "events"),
        (index_storage, "INDEX_FILE", tmp_path / "index.json"),
        (index_storage, "GAMES_DIR", tmp_path / "games"),
        (index_storage, "TEAMS_DIR", tmp_path / "teams"),
        (index_storage, "PLAYERS_DIR", tmp_path / "players"),
    ]
    saved = [(mod, name, getattr(mod, name)) for mod, name, _ in patches]
    for mod, name, value in patches:
        if name.endswith("_DIR"):
            value.mkdir(parents=True, exist_ok=True)
        setattr(mod, name, value)

    monkeypatch.setenv("BREAKSIDE_AUTH_REQUIRED", "true")

    # --- players (names live in the ids, which is the whole point of § A) ---
    solo_player = player_storage.save_player({"name": "Solo Only Player"})
    shared_player = player_storage.save_player({"name": "Shared Player"})

    solo_team = team_storage.save_team(
        {"name": "Solo Team", "playerIds": [solo_player]})
    shared_team = team_storage.save_team(
        {"name": "Shared Team", "playerIds": [shared_player]})
    co_team = team_storage.save_team({"name": "Co Team", "playerIds": []})

    for user in (SOLO, SHARED_COACH, CO_COACH, VIEWER, OUTSIDER):
        user_storage.create_or_update_user(user["id"], user["email"])

    membership_storage.create_membership(solo_team, SOLO["id"], "coach")
    membership_storage.create_membership(shared_team, SHARED_COACH["id"], "coach")
    membership_storage.create_membership(shared_team, VIEWER["id"], "viewer")
    membership_storage.create_membership(co_team, SHARED_COACH["id"], "coach")
    # invited_by points at SOLO so the scrub of *other people's* records has
    # something to redact.
    membership_storage.create_membership(
        co_team, CO_COACH["id"], "coach", invited_by=SOLO["id"])
    membership_storage.create_membership(co_team, SOLO["id"], "viewer")

    for game_id, team_id, name in (
        (SOLO_GAME, solo_team, "Solo Team"),
        (SHARED_GAME, shared_team, "Shared Team"),
        (CO_GAME, co_team, "Co Team"),
    ):
        game_storage.save_game_version(game_id, {
            "id": game_id, "teamId": team_id, "team": name,
            "opponent": "Rivals", "points": [],
        })
        # A second write mints a version backup — the spec's "at least one
        # version file" requirement, and what a cascade must take with it.
        game_storage.save_game_version(game_id, {
            "id": game_id, "teamId": team_id, "team": name,
            "opponent": "Rivals", "points": [{"players": []}],
        })

    event_storage.save_event({"name": "Solo Tourney", "teamId": solo_team})
    invite_storage.create_invite(solo_team, "viewer", SOLO["id"])
    invite_storage.create_invite(co_team, "viewer", SOLO["id"])
    share_storage.create_share_link(CO_GAME, co_team, SOLO["id"])
    index_storage.rebuild_index()

    yield {
        "data_dir": tmp_path,
        "solo_team": solo_team,
        "shared_team": shared_team,
        "co_team": co_team,
        "solo_player": solo_player,
        "shared_player": shared_player,
    }

    from main import app
    app.dependency_overrides.clear()
    for mod, name, original in saved:
        setattr(mod, name, original)


@pytest.fixture
def client(seeded):
    from main import app
    c = TestClient(app)
    yield c
    app.dependency_overrides.clear()


@pytest.fixture
def no_supabase_calls(monkeypatch):
    """Make a real Supabase admin call impossible for the whole test.

    Belt and braces on top of patching ``delete_supabase_auth_user``: if a code
    path ever reached httpx, this turns it into a loud failure instead of a
    request against a live project with the service key in the environment.
    """
    import httpx

    def _explode(*args, **kwargs):
        raise AssertionError("a test tried to make a real HTTP call")

    monkeypatch.setattr(httpx.AsyncClient, "request", _explode)
    monkeypatch.setattr(httpx.AsyncClient, "delete", _explode)


def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


def _allow_auth_delete(monkeypatch, recorder=None):
    """Stub the Supabase admin call with a success. Never touches the network."""
    import account_deletion

    async def _fake(user_id):
        if recorder is not None:
            recorder.append(user_id)

    monkeypatch.setattr(account_deletion, "delete_supabase_auth_user", _fake)


def _snapshot(data_dir):
    """Every file under the data dir, with contents. Used to prove no mutation."""
    return {
        str(p.relative_to(data_dir)): p.read_bytes()
        for p in sorted(data_dir.rglob("*")) if p.is_file()
    }


# =============================================================================
# Authorization
# =============================================================================

class TestSelfOnly:
    def test_preview_requires_auth(self, client):
        assert client.get("/api/auth/me/delete-preview").status_code == 401

    def test_delete_requires_auth(self, client):
        assert client.delete("/api/auth/me").status_code == 401

    def test_delete_ignores_a_body_naming_someone_else(
        self, client, seeded, monkeypatch, no_supabase_calls
    ):
        """There is no target-user parameter, so a body claiming one is inert.

        The route deletes whoever the JWT says, and nothing else — this pins
        that a hand-rolled request cannot redirect it at another account.
        """
        from storage import user_storage

        recorder = []
        _allow_auth_delete(monkeypatch, recorder)
        _as(SOLO)
        response = client.request(
            "DELETE", "/api/auth/me?confirm_erase_teams=true",
            json={"userId": OUTSIDER["id"], "id": OUTSIDER["id"]},
        )

        assert response.status_code == 200, response.text
        assert recorder == [SOLO["id"]]
        assert user_storage.get_user(OUTSIDER["id"]) is not None
        assert user_storage.get_user(SOLO["id"]) is None

    def test_no_route_accepts_a_user_id_path_parameter(self):
        """A belt-and-braces guard against someone adding one later."""
        from main import app
        paths = {getattr(r, "path", "") for r in app.routes}
        assert "/api/auth/me/delete-preview" in paths
        assert not any(
            p.startswith("/api/auth/") and "{" in p for p in paths
        ), "auth routes must never take a path parameter"


# =============================================================================
# Preview
# =============================================================================

class TestPreview:
    def test_preview_mutates_nothing(self, client, seeded, no_supabase_calls):
        before = _snapshot(seeded["data_dir"])
        _as(SOLO)
        assert client.get("/api/auth/me/delete-preview").status_code == 200
        assert _snapshot(seeded["data_dir"]) == before

    def test_preview_counts_the_solo_cascade(self, client, seeded):
        _as(SOLO)
        body = client.get("/api/auth/me/delete-preview").json()

        will = body["willErase"]
        assert will["teams"] == 1
        assert will["games"] == 1
        assert will["versions"] >= 1, "version backups must be counted"
        assert will["events"] == 1
        # Solo Team's invite (cascaded) + the one SOLO minted on Co Team.
        assert will["invites"] == 2
        # Solo Team's own membership + the viewer membership on Co Team.
        assert will["memberships"] == 2

        assert body["canDelete"] is True
        assert body["requiresTeamCascadeConfirmation"] is True
        assert [t["teamId"] for t in body["teamsToErase"]] == [seeded["solo_team"]]

    def test_preview_warns_about_orphaned_players_and_live_shares(self, client, seeded):
        _as(SOLO)
        warnings = " ".join(client.get("/api/auth/me/delete-preview").json()["warnings"])
        assert "player record" in warnings
        assert "share link" in warnings

    def test_preview_excludes_records_the_cascade_will_delete(self, seeded):
        """The redaction warning must not promise anything about doomed data.

        At preview time the solo team's own share and invite are still on disk
        and still name the user, so an unfiltered dry run counts them — and
        then tells a solo coach with no surviving teams that their ID will be
        replaced on "teams that continue without you". It won't; those files
        are about to be deleted outright.
        """
        import account_deletion

        before = _snapshot(seeded["data_dir"])
        everything = account_deletion._scrub_user_references(
            SOLO["id"], "", dry_run=True)
        survivors = account_deletion._scrub_user_references(
            SOLO["id"], "", dry_run=True, skip_team_ids=[seeded["solo_team"]])

        assert everything > survivors
        assert _snapshot(seeded["data_dir"]) == before, "a dry run must not write"

    def test_preview_blocks_the_sole_coach_of_a_shared_team(self, client, seeded):
        _as(SHARED_COACH)
        body = client.get("/api/auth/me/delete-preview").json()

        assert body["canDelete"] is False
        assert [t["teamId"] for t in body["blockingTeams"]] == [seeded["shared_team"]]
        assert body["blockingTeams"][0]["otherMemberCount"] == 1
        # Co Team has another coach, so it is neither blocking nor erased.
        assert body["teamsToErase"] == []
        assert "Shared Team" in " ".join(body["blockers"])

    def test_preview_for_a_user_with_nothing(self, client, seeded, no_supabase_calls):
        _as(OUTSIDER)
        body = client.get("/api/auth/me/delete-preview").json()
        assert body["canDelete"] is True
        assert body["requiresTeamCascadeConfirmation"] is False
        assert body["willErase"] == {
            "players": 0, "teams": 0, "games": 0, "versions": 0,
            "events": 0, "memberships": 0, "shares": 0, "invites": 0,
        }


# =============================================================================
# Supabase failure must abort before anything local is touched
# =============================================================================

class TestAuthIdentityFailure:
    def test_missing_service_key_deletes_nothing(
        self, client, seeded, monkeypatch, no_supabase_calls
    ):
        import config
        monkeypatch.setattr(config, "SUPABASE_SERVICE_KEY", "")
        monkeypatch.setattr(config, "SUPABASE_URL", "https://example.invalid")

        before = _snapshot(seeded["data_dir"])
        _as(SOLO)
        response = client.request(
            "DELETE", "/api/auth/me?confirm_erase_teams=true")

        assert response.status_code == 503
        assert response.json()["detail"]["deletedAnything"] is False
        assert _snapshot(seeded["data_dir"]) == before

    def test_admin_api_error_deletes_nothing(
        self, client, seeded, monkeypatch, no_supabase_calls
    ):
        """The user file and the memberships must both still be there."""
        import account_deletion
        from storage import membership_storage, user_storage

        async def _fail(user_id):
            raise account_deletion.AuthIdentityDeletionFailed("boom")

        monkeypatch.setattr(account_deletion, "delete_supabase_auth_user", _fail)

        before = _snapshot(seeded["data_dir"])
        _as(SOLO)
        response = client.request(
            "DELETE", "/api/auth/me?confirm_erase_teams=true")

        assert response.status_code == 502
        assert user_storage.get_user(SOLO["id"]) is not None
        assert len(membership_storage.get_user_memberships(SOLO["id"])) == 2
        assert _snapshot(seeded["data_dir"]) == before

    def test_unconfigured_server_reports_not_configured(self, seeded, monkeypatch):
        """The 503-vs-502 distinction comes from this flag, not the status."""
        import asyncio

        import account_deletion
        import config

        monkeypatch.setattr(config, "SUPABASE_SERVICE_KEY", "")
        with pytest.raises(account_deletion.AuthIdentityDeletionFailed) as exc:
            asyncio.run(account_deletion.delete_supabase_auth_user("whoever"))
        assert exc.value.configured is False


# =============================================================================
# The sole-coach decision
# =============================================================================

class TestSoleCoach:
    def test_sole_coach_of_a_shared_team_is_refused(
        self, client, seeded, monkeypatch, no_supabase_calls
    ):
        """Deleting must neither orphan nor destroy a team others still use.

        409 with the offending team named, and — crucially — the refusal
        happens before the Supabase call, so the account is fully intact.
        """
        recorder = []
        _allow_auth_delete(monkeypatch, recorder)

        before = _snapshot(seeded["data_dir"])
        _as(SHARED_COACH)
        response = client.request(
            "DELETE", "/api/auth/me?confirm_erase_teams=true")

        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["reason"] == "team_handover_required"
        assert [t["teamId"] for t in detail["teams"]] == [seeded["shared_team"]]
        assert recorder == [], "must not touch the auth identity when refusing"
        assert _snapshot(seeded["data_dir"]) == before

    def test_handing_over_coaching_unblocks_the_delete(
        self, client, seeded, monkeypatch, no_supabase_calls
    ):
        """The remedy the error message points at actually works."""
        from storage import membership_storage

        _allow_auth_delete(monkeypatch)

        viewer_membership = membership_storage.get_user_team_membership(
            VIEWER["id"], seeded["shared_team"])
        membership_storage.update_membership_role(viewer_membership["id"], "coach")

        _as(SHARED_COACH)
        response = client.request("DELETE", "/api/auth/me")

        assert response.status_code == 200, response.text
        # Shared Team keeps its games — the promoted coach still has them.
        from storage import game_storage
        assert game_storage.game_exists(SHARED_GAME)

    def test_cascade_requires_explicit_confirmation(
        self, client, seeded, monkeypatch, no_supabase_calls
    ):
        recorder = []
        _allow_auth_delete(monkeypatch, recorder)

        before = _snapshot(seeded["data_dir"])
        _as(SOLO)
        response = client.request("DELETE", "/api/auth/me")

        assert response.status_code == 409
        assert response.json()["detail"]["reason"] == "team_cascade_not_confirmed"
        assert recorder == []
        assert _snapshot(seeded["data_dir"]) == before

    def test_confirmed_cascade_erases_the_sole_member_team(
        self, client, seeded, monkeypatch, no_supabase_calls
    ):
        from storage import event_storage, game_storage, team_storage

        _allow_auth_delete(monkeypatch)
        _as(SOLO)
        response = client.request(
            "DELETE", "/api/auth/me?confirm_erase_teams=true")

        assert response.status_code == 200, response.text
        assert response.json()["erased"]["teams"] == 1

        assert not team_storage.team_exists(seeded["solo_team"])
        assert not game_storage.game_exists(SOLO_GAME)
        assert not (seeded["data_dir"] / "games" / SOLO_GAME).exists(), \
            "the game directory, versions/ included, must be gone"
        assert event_storage.list_team_events(seeded["solo_team"]) == []

        # A team this user merely viewed is untouched.
        assert team_storage.team_exists(seeded["co_team"])
        assert game_storage.game_exists(CO_GAME)

    def test_cascade_leaves_other_peoples_teams_alone(
        self, client, seeded, monkeypatch, no_supabase_calls
    ):
        from storage import game_storage, membership_storage, team_storage

        _allow_auth_delete(monkeypatch)
        _as(SOLO)
        client.request("DELETE", "/api/auth/me?confirm_erase_teams=true")

        assert team_storage.team_exists(seeded["shared_team"])
        assert game_storage.game_exists(SHARED_GAME)
        assert len(membership_storage.get_team_memberships(seeded["co_team"])) == 2


# =============================================================================
# What survives a successful delete
# =============================================================================

class TestAfterDeletion:
    @pytest.fixture(autouse=True)
    def _deleted(self, client, seeded, monkeypatch, no_supabase_calls):
        _allow_auth_delete(monkeypatch)
        _as(SOLO)
        self.response = client.request(
            "DELETE", "/api/auth/me?confirm_erase_teams=true")
        assert self.response.status_code == 200, self.response.text

    def test_user_cannot_be_resolved(self, seeded):
        from storage import user_storage
        assert user_storage.get_user(SOLO["id"]) is None
        assert user_storage.user_exists(SOLO["id"]) is False
        assert SOLO["id"] not in [u["id"] for u in user_storage.list_users()]
        assert self.response.json()["userRecordDeleted"] is True

    def test_every_membership_is_gone(self, seeded):
        from storage import membership_storage
        assert membership_storage.get_user_memberships(SOLO["id"]) == []
        assert membership_storage.get_user_teams(SOLO["id"]) == []
        index = membership_storage._index.load()
        assert SOLO["id"] not in index.get("byUser", {})

    def test_invites_minted_by_the_user_are_gone(self, seeded):
        from storage import invite_storage
        remaining = invite_storage.list_team_invites(seeded["co_team"])
        assert [i for i in remaining if i["createdBy"] == SOLO["id"]] == []

    def test_the_user_id_appears_nowhere_on_disk(self, seeded):
        """The strongest available assertion for § C: nothing references them.

        Deliberately a grep of the whole serialized tree rather than a list of
        known files — a reference we forgot to clean is exactly the failure
        mode this feature exists to prevent.
        """
        hits = [
            str(p.relative_to(seeded["data_dir"]))
            for p in seeded["data_dir"].rglob("*")
            if p.is_file() and SOLO["id"].encode() in p.read_bytes()
        ]
        assert hits == [], f"deleted user id still referenced in {hits}"

    def test_surviving_share_stays_live_but_anonymous(self, seeded):
        """Other people's data is redacted, never destroyed.

        A share the deleted user created on a team that carries on is still
        being watched by that team's parents; revoking it would be collateral
        damage. The reference to the deleted account goes instead.
        """
        from storage import share_storage

        shares = share_storage.list_game_shares(CO_GAME)
        assert len(shares) == 1
        share = shares[0]
        assert share_storage.is_share_valid(share), "must not be revoked"
        assert share["createdBy"] != SOLO["id"]
        assert share["createdBy"].startswith("deleted-user-")

    def test_another_users_membership_is_kept_but_redacted(self, seeded):
        from storage import membership_storage

        membership = membership_storage.get_user_team_membership(
            CO_COACH["id"], seeded["co_team"])
        assert membership is not None, "must not delete somebody else's membership"
        assert membership["invitedBy"] != SOLO["id"]
        assert membership["invitedBy"].startswith("deleted-user-")

    def test_scrub_count_is_reported(self):
        assert self.response.json()["referencesScrubbed"] >= 2

    def test_index_has_no_dangling_entries_for_the_erased_team(self, seeded):
        from storage import index_storage
        index = index_storage.get_index()
        assert seeded["solo_team"] not in index.get("teamGames", {})
        assert SOLO_GAME not in index.get("gameRoster", {})
        assert seeded["solo_player"] not in index.get("playerTeams", {})

    def test_deleting_again_is_idempotent(self, client, seeded, monkeypatch):
        """A retry must be a no-op, not a 500 (spec § Non-negotiables)."""
        _allow_auth_delete(monkeypatch)
        _as(SOLO)
        again = client.request("DELETE", "/api/auth/me?confirm_erase_teams=true")
        assert again.status_code == 200, again.text
        assert again.json()["erased"] == {
            "players": 0, "teams": 0, "games": 0, "versions": 0,
            "events": 0, "memberships": 0, "shares": 0, "invites": 0,
        }
        assert again.json()["userRecordDeleted"] is False


# =============================================================================
# The § B seam
# =============================================================================

class TestTeamEraserSeam:
    def test_a_registered_eraser_replaces_the_fallback(self, seeded):
        """Spec § B can take over the cascade without touching this module."""
        import account_deletion

        calls = []

        def fake_eraser(team_id, *, dry_run=False):
            calls.append((team_id, dry_run))
            counts = {k: 0 for k in account_deletion.COUNT_KEYS}
            counts["teams"] = 1
            return counts

        original = account_deletion.get_team_eraser()
        account_deletion.set_team_eraser(fake_eraser)
        try:
            plan = account_deletion.plan_account_deletion(SOLO["id"])
            assert calls == [(seeded["solo_team"], True)]
            assert plan["willErase"]["teams"] == 1
        finally:
            account_deletion.set_team_eraser(
                None if original is account_deletion._fallback_erase_team else original
            )
