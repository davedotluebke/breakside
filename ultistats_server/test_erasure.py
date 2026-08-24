"""
Tests for true erasure of players and teams (storage/erasure.py).

This is destructive, irreversible code whose entire purpose is that a name
stops existing, so the bar is: **grep the whole data directory afterwards.**
Asserting on the fields we remembered to check would pass happily while the
name sat in a version backup — which is exactly the failure mode the feature
exists to prevent.

The fixtures are shaped like real stored documents, verified against the
corpus in ``data/``: IDs of the form ``Name-hash``, a roster snapshot carrying
name/nickname/number/gender, points whose ``players`` lists hold IDs, events
carrying both an ID and a display name, a legacy event with a name and no ID at
all, and — non-negotiably — more than one file under ``versions/``.

Run: cd ultistats_server && python -m pytest test_erasure.py -v
"""
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


COACH = {"id": "erase-coach", "email": "coach@test", "role": "authenticated"}
OTHER_COACH = {"id": "erase-other-coach", "email": "other@test", "role": "authenticated"}
VIEWER = {"id": "erase-viewer", "email": "viewer@test", "role": "authenticated"}
ADMIN = {"id": "erase-admin", "email": "admin@test", "role": "authenticated"}

GAME_ID = "2026-08-24_Erase-Team_vs_Rivals_1756000000000"

# A second game, written directly to disk, whose ONLY trace of the erased
# player is their nickname — no ID, no name, and no entry in the index. It
# exists to prove the byte pre-filter in _iter_candidate_files actually opens
# such a file. If the nickname is not a needle, this game is never read and the
# name survives silently, which is the worst failure this module can have.
LEGACY_GAME_ID = "2019-05-04_Old-Squad_vs_Ancients_1556000000000"

# Deliberately not a substring of the player's name, so a grep for it cannot
# pass by accident. The app renders `nickname || name`, so this is what an
# old ID-less event most likely stored.
ALICE_NICKNAME = "Sparrow"


# =============================================================================
# The assertion that matters: does this string survive anywhere on disk?
# =============================================================================

def _needle_forms(value: str):
    """Both byte forms a string can take in a stored document.

    ``atomic_write_json`` uses ``json.dump`` defaults, i.e.
    ``ensure_ascii=True``, so "José" is written to disk as "Jos\\u00e9". A
    search for the raw UTF-8 bytes alone would sail straight past it and this
    whole test file would report a clean erasure that had not happened.
    """
    raw = value.encode("utf-8")
    forms = {raw}
    forms.add(json.dumps(value)[1:-1].encode("utf-8"))
    return forms


def find_in_tree(root: Path, value: str):
    """Every file under ``root`` whose bytes contain ``value``. Empty == erased."""
    hits = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        try:
            blob = path.read_bytes()
        except OSError:
            continue
        if any(form in blob for form in _needle_forms(value)):
            hits.append(str(path.relative_to(root)))
    return hits


def assert_absent(root: Path, value: str, label: str):
    hits = find_in_tree(root, value)
    assert not hits, f"{label} {value!r} survived erasure in: {hits}"


def snapshot_tree(root: Path):
    """path -> bytes, for proving a preview changed nothing at all."""
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


# =============================================================================
# Fixture: a realistically-shaped data directory
# =============================================================================

def _game_document(team_id, alice, bob, cara):
    """A game shaped like the stored corpus.

    Covers every reference kind the scrub has to handle: roster snapshot,
    point player lists, both substitution lists, a pull (with its inline
    ``pullerGender``), a scoring throw (with ``assist``/``assistId`` — the pair
    the original spec table omitted), a defensive block, a **legacy event
    carrying names and no IDs at all**, and a pendingNextLine holding names.
    """
    return {
        "id": GAME_ID,
        "teamId": team_id,
        "team": "Erase Team",
        "opponent": "Rivals",
        "startingPosition": "offense",
        "scores": {"team": 1, "opponent": 0},
        "gameStartTimestamp": "2026-08-24T10:00:00",
        "gameEndTimestamp": None,
        "alternateGenderRatio": "No",
        "alternateGenderPulls": False,
        "startingGenderRatio": "4/3",
        "lastLineUsed": None,
        "rosterSnapshot": {
            "capturedAt": "2026-08-24T09:59:00",
            "players": [
                {"id": alice["id"], "name": alice["name"],
                 "nickname": ALICE_NICKNAME, "number": "7", "gender": "FMP"},
                {"id": bob["id"], "name": bob["name"], "nickname": "",
                 "number": "12", "gender": "MMP"},
                {"id": cara["id"], "name": cara["name"], "nickname": "",
                 "number": "3", "gender": "FMP"},
            ],
        },
        "pendingNextLine": {
            "oLine": [alice["name"], bob["name"]],
            "dLine": [],
            "odLine": [cara["name"]],
            "odOnDeckLine": [alice["name"]],
            "oLineModifiedAt": "2026-08-24T10:05:00",
            # Scalar fields beside the arrays that carry a bare display name.
            "lineupReadyBy": alice["name"],
            "lineCoachViewing": alice["name"],
        },
        "points": [
            {
                "players": [alice["id"], bob["id"], cara["id"]],
                "substitutedOutPlayers": [alice["id"]],
                "substitutedInPlayers": [cara["id"]],
                "startingPosition": "defense",
                "winner": "team",
                "startTimestamp": "2026-08-24T10:01:00",
                "endTimestamp": "2026-08-24T10:03:00",
                "totalPointTime": 120,
                "lastPauseTime": None,
                "possessions": [
                    {
                        "offensive": False,
                        "modes": ["full"],
                        "set": None,
                        "events": [
                            {"type": "Pull", "puller": alice["name"],
                             "pullerId": alice["id"], "pullerGender": "FMP",
                             "quality": "Good Pull", "io_flag": True},
                            {"type": "Defense", "defender": alice["name"],
                             "defenderId": alice["id"], "layout_flag": True},
                        ],
                    },
                    {
                        "offensive": True,
                        "modes": ["full"],
                        "set": None,
                        "events": [
                            {"type": "Throw", "thrower": bob["name"],
                             "throwerId": bob["id"], "receiver": alice["name"],
                             "receiverId": alice["id"]},
                            {"type": "Throw", "thrower": alice["name"],
                             "throwerId": alice["id"], "receiver": cara["name"],
                             "receiverId": cara["id"], "score_flag": True,
                             "assist": alice["name"], "assistId": alice["id"]},
                            # Legacy: names only, no *Id fields anywhere.
                            {"type": "Throw", "thrower": alice["name"],
                             "receiver": bob["name"], "huck_flag": True},
                            # Legacy again, but storing the NICKNAME — which is
                            # what `nickname || name` rendering makes the
                            # likelier of the two in old data.
                            {"type": "Throw", "thrower": ALICE_NICKNAME,
                             "receiver": bob["name"], "swing_flag": True},
                        ],
                    },
                ],
            },
        ],
    }


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated data dir seeded with a team, three players, a game with
    version backups, a tournament event, and memberships.

    Storage modules snapshot their directory constants at import time (see
    storage/_config.py), so patching ``config`` alone would let every write in
    this file land in the repo's real ``data/``. Patch both.
    """
    import config
    from storage import (
        event_storage, game_storage, index_storage, invite_storage,
        membership_storage, player_storage, share_storage, team_storage,
        tombstones, user_storage,
    )

    for name, value in [
        ("DATA_DIR", tmp_path),
        ("GAMES_DIR", tmp_path / "games"),
        ("TEAMS_DIR", tmp_path / "teams"),
        ("PLAYERS_DIR", tmp_path / "players"),
        ("USERS_DIR", tmp_path / "users"),
        ("MEMBERSHIPS_DIR", tmp_path / "memberships"),
        ("SHARES_DIR", tmp_path / "shares"),
        ("INVITES_DIR", tmp_path / "invites"),
        ("EVENTS_DIR", tmp_path / "events"),
        ("INDEX_FILE", tmp_path / "index.json"),
    ]:
        if name.endswith("_DIR"):
            Path(value).mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(config, name, value)

    monkeypatch.setattr(game_storage, "GAMES_DIR", tmp_path / "games")
    monkeypatch.setattr(team_storage, "TEAMS_DIR", tmp_path / "teams")
    monkeypatch.setattr(player_storage, "PLAYERS_DIR", tmp_path / "players")
    monkeypatch.setattr(event_storage, "EVENTS_DIR", tmp_path / "events")
    monkeypatch.setattr(user_storage, "USERS_DIR", tmp_path / "users")
    monkeypatch.setattr(membership_storage, "MEMBERSHIPS_DIR", tmp_path / "memberships")
    monkeypatch.setattr(membership_storage, "INDEX_FILE", tmp_path / "memberships" / "_index.json")
    monkeypatch.setattr(share_storage, "SHARES_DIR", tmp_path / "shares")
    monkeypatch.setattr(share_storage, "INDEX_FILE", tmp_path / "shares" / "_index.json")
    monkeypatch.setattr(invite_storage, "INVITES_DIR", tmp_path / "invites")
    monkeypatch.setattr(invite_storage, "INDEX_FILE", tmp_path / "invites" / "_index.json")
    monkeypatch.setattr(index_storage, "INDEX_FILE", tmp_path / "index.json")
    monkeypatch.setattr(index_storage, "GAMES_DIR", tmp_path / "games")
    monkeypatch.setattr(index_storage, "TEAMS_DIR", tmp_path / "teams")
    monkeypatch.setattr(index_storage, "PLAYERS_DIR", tmp_path / "players")
    monkeypatch.setattr(tombstones, "ERASED_FILE", tmp_path / "erased.json")

    # Players. "Álvaro Núñez" is deliberately non-ASCII: json.dump escapes it
    # on disk, so it proves the scan's escaped-form needle actually works.
    alice_id = player_storage.save_player(
        {"name": "Álvaro Núñez", "nickname": ALICE_NICKNAME, "number": "7",
         "gender": "FMP", "position": "handler", "defaultLine": "O",
         "createdBy": COACH["id"]}
    )
    bob_id = player_storage.save_player(
        {"name": "Bob Smith", "number": "12", "gender": "MMP"}
    )
    cara_id = player_storage.save_player({"name": "Cara", "number": "3", "gender": "FMP"})
    env_cara_name = "Cara"
    alice = {"id": alice_id, "name": "Álvaro Núñez"}
    bob = {"id": bob_id, "name": "Bob Smith"}
    cara = {"id": cara_id, "name": "Cara"}

    team_id = team_storage.save_team({
        "name": "Erase Team",
        "playerIds": [alice_id, bob_id, cara_id],
        "lines": [
            {"name": "Main O", "players": [alice["name"], bob["name"]],
             "lastUsed": None},
            # Lines are built from displayed text, so one holds the nickname.
            {"name": "Zone D", "players": [ALICE_NICKNAME, env_cara_name],
             "lastUsed": None},
        ],
    })
    # A second team that also rosters Bob, so team erasure has a survivor.
    other_team_id = team_storage.save_team({
        "name": "Other Team", "playerIds": [bob_id], "lines": [],
    })

    event_id = event_storage.save_event({
        "name": "Summer Tourney",
        "teamId": team_id,
        "roster": {
            "playerIds": [alice_id, bob_id],
            "pickupPlayers": [{"id": "Guest-9z9z", "name": "Guest Player",
                               "gender": "MMP", "number": "99"}],
        },
    })

    # Two syncs => current.json plus two files under versions/. The version
    # backups are the point of the whole feature.
    document = _game_document(team_id, alice, bob, cara)
    game_storage.save_game_version(GAME_ID, json.loads(json.dumps(document)))
    document["scores"]["team"] = 2
    game_storage.save_game_version(GAME_ID, json.loads(json.dumps(document)))

    # The nickname-only legacy game. Written directly rather than through
    # save_game_version so its exact bytes are controlled, and given no teamId
    # so team erasure ignores it — which also proves player erasure scans the
    # games on disk rather than trusting the index.
    legacy = {
        "team": "Old Squad", "opponent": "Ancients",
        "gameStartTimestamp": "2019-05-04T10:00:00",
        "points": [{
            "players": [ALICE_NICKNAME, "Someone Else"],
            "winner": "team", "startingPosition": "offense",
            "possessions": [{"offensive": True, "events": [
                {"type": "Throw", "thrower": ALICE_NICKNAME,
                 "receiver": "Someone Else", "score_flag": True},
            ]}],
        }],
    }
    legacy_dir = tmp_path / "games" / LEGACY_GAME_ID
    (legacy_dir / "versions").mkdir(parents=True, exist_ok=True)
    legacy_body = json.dumps(legacy, indent=2)
    (legacy_dir / "current.json").write_text(legacy_body)
    (legacy_dir / "versions" / "2019-05-04T10-30-00-000000.json").write_text(legacy_body)
    for probe in (legacy_dir / "current.json",
                  legacy_dir / "versions" / "2019-05-04T10-30-00-000000.json"):
        blob = probe.read_bytes()
        assert alice_id.encode() not in blob and "Álvaro".encode() not in blob, (
            "the legacy game must trace the player by nickname ALONE"
        )

    membership_storage.create_membership(team_id, COACH["id"], "coach")
    membership_storage.create_membership(team_id, VIEWER["id"], "viewer")
    membership_storage.create_membership(other_team_id, OTHER_COACH["id"], "coach")
    user_storage.save_user({"id": ADMIN["id"], "email": ADMIN["email"], "isAdmin": True})
    index_storage.rebuild_index()

    versions = list((tmp_path / "games" / GAME_ID / "versions").glob("*.json"))
    assert len(versions) == 2, "fixture must exercise more than one version file"

    return {
        "root": tmp_path, "team_id": team_id, "other_team_id": other_team_id,
        "event_id": event_id, "game_id": GAME_ID,
        "legacy_game_id": LEGACY_GAME_ID, "nickname": ALICE_NICKNAME,
        "alice": alice, "bob": bob, "cara": cara,
    }


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


# =============================================================================
# Player erasure — the core guarantee
# =============================================================================

class TestPlayerErasure:

    def test_fixture_actually_contains_the_name_first(self, env):
        """Guard against a vacuous suite: if the fixture never wrote the name,
        every 'it is gone' assertion below would pass for the wrong reason."""
        hits = find_in_tree(env["root"], env["alice"]["name"])
        assert len(hits) >= 4, hits  # player file, team, event, game + versions
        assert any("versions" in h for h in hits), "name must reach a version backup"

    def test_id_and_name_appear_nowhere_afterwards(self, env):
        from storage import erase_player
        alice = env["alice"]

        result = erase_player(alice["id"])

        assert_absent(env["root"], alice["id"], "player id")
        assert_absent(env["root"], alice["name"], "player name")
        assert result["counts"]["players"] == 1

    def test_tombstone_replaces_the_player_in_history(self, env):
        from storage import erase_player, get_game_current, TOMBSTONE_NAME
        alice = env["alice"]

        result = erase_player(alice["id"])
        tombstone = result["tombstoneId"]
        assert tombstone.startswith("Removed-")

        game = get_game_current(env["game_id"])
        entry = next(p for p in game["rosterSnapshot"]["players"]
                     if p["id"] == tombstone)
        assert entry["name"] == TOMBSTONE_NAME

        point = game["points"][0]
        assert tombstone in point["players"]
        # The point still had three players on the field.
        assert len(point["players"]) == 3
        assert point["substitutedOutPlayers"] == [tombstone]

        pull = point["possessions"][0]["events"][0]
        assert pull["pullerId"] == tombstone
        assert pull["puller"] == TOMBSTONE_NAME

    def test_per_person_attributes_are_nulled_not_just_the_name(self, env):
        """A jersey number re-identifies: "Removed Player, #7" on a 15-person
        roster names the person to everyone the share link reached."""
        from storage import erase_player, get_game_current
        alice = env["alice"]

        tombstone = erase_player(alice["id"])["tombstoneId"]

        game = get_game_current(env["game_id"])
        entry = next(p for p in game["rosterSnapshot"]["players"]
                     if p["id"] == tombstone)
        for attribute in ("nickname", "number", "gender"):
            assert entry[attribute] is None, f"{attribute} survived: {entry}"

        # Pull events carry the puller's gender inline, so nulling the roster
        # entry alone would not be enough.
        pull = game["points"][0]["possessions"][0]["events"][0]
        assert pull["pullerGender"] == "Unknown"

    def test_teammates_are_untouched(self, env):
        from storage import erase_player, get_game_current, get_team
        alice, bob, cara = env["alice"], env["bob"], env["cara"]

        erase_player(alice["id"])

        game = get_game_current(env["game_id"])
        roster = {p["id"]: p for p in game["rosterSnapshot"]["players"]}
        assert roster[bob["id"]]["name"] == bob["name"]
        assert roster[bob["id"]]["number"] == "12"
        assert roster[cara["id"]]["name"] == cara["name"]
        assert roster[cara["id"]]["gender"] == "FMP"

        throw = game["points"][0]["possessions"][1]["events"][0]
        assert throw["throwerId"] == bob["id"]
        assert throw["thrower"] == bob["name"]

        team = get_team(env["team_id"])
        assert bob["id"] in team["playerIds"]
        assert cara["id"] in team["playerIds"]
        assert bob["name"] in team["lines"][0]["players"]

    def test_every_version_backup_is_scrubbed(self, env):
        from storage import erase_player, list_game_versions, get_game_version
        alice = env["alice"]

        result = erase_player(alice["id"])
        # Two games: the main one and the nickname-only legacy one, each with
        # its current.json, plus 2 + 1 version backups.
        assert result["counts"]["versions"] == 3
        assert result["counts"]["games"] == 2

        for timestamp in list_game_versions(env["game_id"]):
            blob = json.dumps(get_game_version(env["game_id"], timestamp))
            assert alice["id"] not in blob
            assert alice["name"] not in blob

    def test_legacy_name_only_event_is_scrubbed_and_reported(self, env):
        from storage import erase_player, get_game_current, TOMBSTONE_NAME
        alice = env["alice"]

        result = erase_player(alice["id"])

        legacy = get_game_current(env["game_id"])["points"][0]["possessions"][1]["events"][2]
        assert legacy["thrower"] == TOMBSTONE_NAME
        assert "throwerId" not in legacy
        assert any("matched by name alone" in w for w in result["warnings"])

    def test_the_nickname_is_gone_from_the_whole_tree(self, env):
        """The app renders `nickname || name`, so the nickname is a display
        name and has to be erased as thoroughly as the name itself."""
        from storage import erase_player
        erase_player(env["alice"]["id"])
        assert_absent(env["root"], env["nickname"], "nickname")

    def test_a_file_traced_only_by_nickname_is_opened_and_scrubbed(self, env):
        """The pre-filter must open a file whose sole trace is the nickname.

        This is the silent-miss case: if the nickname is not among the byte
        needles, _iter_candidate_files never reads the file, the structural
        scrub is never given the chance to decide, and the erasure reports
        success while the name sits on disk.
        """
        from storage import erase_player, get_game_current, TOMBSTONE_NAME
        legacy_dir = env["root"] / "games" / env["legacy_game_id"]

        erase_player(env["alice"]["id"])

        legacy = get_game_current(env["legacy_game_id"])
        assert legacy["points"][0]["possessions"][0]["events"][0]["thrower"] == \
            TOMBSTONE_NAME
        assert env["nickname"] not in json.dumps(legacy)
        # The version backup beside it, too.
        version = next((legacy_dir / "versions").glob("*.json"))
        assert env["nickname"].encode() not in version.read_bytes()
        # ...and the teammate in that game is untouched.
        assert "Someone Else" in version.read_text()

    def test_a_nickname_only_legacy_event_is_scrubbed(self, env):
        from storage import erase_player, get_game_current, TOMBSTONE_NAME
        erase_player(env["alice"]["id"])
        event = get_game_current(env["game_id"])["points"][0]["possessions"][1]["events"][3]
        assert event["thrower"] == TOMBSTONE_NAME
        assert event["receiver"] == env["bob"]["name"]

    def test_pending_line_scalar_fields_are_anonymised(self, env):
        """lineupReadyBy and lineCoachViewing hold a bare display name."""
        from storage import erase_player, get_game_current
        erase_player(env["alice"]["id"])
        pending = get_game_current(env["game_id"])["pendingNextLine"]
        assert pending["lineupReadyBy"] is None
        assert pending["lineCoachViewing"] is None

    def test_rosters_and_lines_lose_the_player(self, env):
        from storage import erase_player, get_team, get_event
        alice = env["alice"]

        erase_player(alice["id"])

        team = get_team(env["team_id"])
        assert alice["id"] not in team["playerIds"]
        assert alice["name"] not in team["lines"][0]["players"]
        # The line that named them by nickname loses them too.
        assert team["lines"][1]["players"] == [env["cara"]["name"]]
        # Rosters are membership, not history: no tombstone is left behind.
        assert len(team["playerIds"]) == 2

        event = get_event(env["event_id"])
        assert alice["id"] not in event["roster"]["playerIds"]

    def test_pending_line_entries_are_removed_not_tombstoned(self, env):
        from storage import erase_player, get_game_current
        alice = env["alice"]

        erase_player(alice["id"])

        pending = get_game_current(env["game_id"])["pendingNextLine"]
        assert pending["oLine"] == [env["bob"]["name"]]
        assert pending["odOnDeckLine"] == []

    def test_index_buckets_match_a_rebuild(self, env):
        from storage import erase_player, get_index, rebuild_index
        alice = env["alice"]

        tombstone = erase_player(alice["id"])["tombstoneId"]

        index = get_index()
        assert alice["id"] not in index["playerTeams"]
        assert alice["id"] not in index["playerGames"]
        assert tombstone in index["gameRoster"][env["game_id"]]

        # The index the erasure wrote is the index a rebuild would produce.
        before = {k: v for k, v in get_index().items() if k != "lastRebuilt"}
        rebuild_index()
        after = {k: v for k, v in get_index().items() if k != "lastRebuilt"}
        assert {k: sorted(v) if isinstance(v, list) else v
                for k, v in before["playerGames"].items()} == \
               {k: sorted(v) if isinstance(v, list) else v
                for k, v in after["playerGames"].items()}
        assert sorted(before["gameRoster"][env["game_id"]]) == \
               sorted(after["gameRoster"][env["game_id"]])

    def test_rerun_is_a_no_op_with_zero_counts(self, env):
        from storage import erase_player
        alice = env["alice"]

        erase_player(alice["id"])
        again = erase_player(alice["id"])

        assert again["counts"]["players"] == 0
        assert again["counts"]["games"] == 0
        assert again["counts"]["versions"] == 0
        assert again["counts"]["rosters"] == 0
        assert again["counts"]["events"] == 0

    def test_rerun_reuses_the_same_tombstone(self, env):
        """So a retry after a partial failure can't split one person across two
        tombstone rows in historical stats."""
        from storage import erase_player
        first = erase_player(env["alice"]["id"])["tombstoneId"]
        second = erase_player(env["alice"]["id"])["tombstoneId"]
        assert first == second

    def test_erasing_an_unknown_id_is_not_an_error(self, env):
        from storage import erase_player
        result = erase_player("Nobody-0000")
        assert result["counts"]["players"] == 0


class TestPreviewIsInert:

    def test_preview_mutates_nothing(self, env):
        from storage import erase_player
        before = snapshot_tree(env["root"])

        result = erase_player(env["alice"]["id"], dry_run=True)

        assert snapshot_tree(env["root"]) == before, "dry run wrote to disk"
        assert result["dryRun"] is True

    def test_preview_counts_match_the_erasure(self, env):
        from storage import erase_player
        preview = erase_player(env["alice"]["id"], dry_run=True)
        actual = erase_player(env["alice"]["id"])
        assert preview["counts"] == actual["counts"]


class TestBlockedErasure:

    @pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
    def test_unwritable_versions_dir_refuses_before_touching_anything(self, env):
        from storage import erase_player, ErasureBlocked
        versions = env["root"] / "games" / env["game_id"] / "versions"
        before = snapshot_tree(env["root"])
        versions.chmod(0o500)  # readable, not writable
        try:
            with pytest.raises(ErasureBlocked):
                erase_player(env["alice"]["id"])
        finally:
            versions.chmod(0o700)

        assert snapshot_tree(env["root"]) == before, (
            "a refused erasure must leave the tree byte-identical"
        )


# =============================================================================
# Team erasure
# =============================================================================

class TestTeamErasure:

    def test_cascade_deletes_games_and_reports_orphans(self, env):
        from storage import erase_team, team_exists, game_exists, event_exists
        result = erase_team(env["team_id"])

        assert result["counts"]["teams"] == 1
        assert result["counts"]["games"] == 1
        assert result["counts"]["versions"] == 2
        assert result["counts"]["events"] == 1
        assert result["counts"]["memberships"] == 2
        assert not team_exists(env["team_id"])
        assert not game_exists(env["game_id"])
        assert not event_exists(env["event_id"])

    def test_players_survive_by_default_and_orphans_are_reported(self, env):
        from storage import erase_team, player_exists
        result = erase_team(env["team_id"])

        # Álvaro and Cara are on no other team; Bob is on Other Team.
        assert set(result["orphanedPlayerIds"]) == {env["alice"]["id"], env["cara"]["id"]}
        assert player_exists(env["alice"]["id"])
        assert player_exists(env["bob"]["id"])
        assert any("orphans 2 player" in w for w in result["warnings"])

    def test_opting_in_erases_the_orphans_and_spares_the_survivor(self, env):
        from storage import erase_team, player_exists
        result = erase_team(env["team_id"], erase_orphaned_players=True)

        assert result["counts"]["players"] == 2
        assert not player_exists(env["alice"]["id"])
        assert not player_exists(env["cara"]["id"])
        assert player_exists(env["bob"]["id"]), "a player on another team must survive"
        assert_absent(env["root"], env["alice"]["name"], "orphan name")
        # Including out of a game this team never owned, traced only by nickname.
        assert_absent(env["root"], env["nickname"], "orphan nickname")

    def test_the_other_team_is_untouched(self, env):
        from storage import erase_team, get_team
        erase_team(env["team_id"])
        other = get_team(env["other_team_id"])
        assert other["playerIds"] == [env["bob"]["id"]]

    def test_preview_mutates_nothing(self, env):
        from storage import erase_team
        before = snapshot_tree(env["root"])
        preview = erase_team(env["team_id"], dry_run=True)
        assert snapshot_tree(env["root"]) == before
        assert preview["counts"]["games"] == 1

    def test_rerun_is_a_no_op_with_zero_counts(self, env):
        from storage import erase_team
        erase_team(env["team_id"])
        again = erase_team(env["team_id"])
        assert again["counts"]["teams"] == 0
        assert again["counts"]["games"] == 0
        assert again["counts"]["memberships"] == 0

    def test_index_drops_the_team_and_its_games(self, env):
        from storage import erase_team, get_index
        erase_team(env["team_id"])
        index = get_index()
        assert env["team_id"] not in index["teamGames"]
        assert env["game_id"] not in index["gameRoster"]
        assert env["team_id"] not in index["playerTeams"].get(env["bob"]["id"], [])


# =============================================================================
# Durability: a stale offline client must not undo an erasure
# =============================================================================

class TestErasureIsDurable:

    def test_recreating_an_erased_player_is_refused(self, env, client):
        from storage import erase_player
        alice = env["alice"]
        erase_player(alice["id"])

        _as(COACH)
        response = client.post("/api/players", json={
            "id": alice["id"], "name": alice["name"], "teamId": env["team_id"],
        })
        assert response.status_code == 410
        assert_absent(env["root"], alice["name"], "resurrected name")

    def test_team_sync_strips_the_erased_player_but_keeps_the_rest(self, env, client):
        from storage import erase_player, get_team
        alice, bob = env["alice"], env["bob"]
        erase_player(alice["id"])

        _as(COACH)
        # A phone that hasn't synced since the erasure pushes its cached roster.
        response = client.post("/api/teams", json={
            "id": env["team_id"], "name": "Erase Team",
            "playerIds": [alice["id"], bob["id"], env["cara"]["id"]],
            "lines": [{"name": "Main O", "players": [alice["name"], bob["name"]]}],
        })
        assert response.status_code == 200

        team = get_team(env["team_id"])
        assert alice["id"] not in team["playerIds"]
        assert bob["id"] in team["playerIds"], "the legitimate part of the update stands"
        assert alice["name"] not in team["lines"][0]["players"]
        assert_absent(env["root"], alice["name"], "resurrected name")

    def test_game_sync_scrubs_a_cached_pre_erasure_game(self, env, client):
        from storage import erase_player, get_game_current
        alice = env["alice"]
        cached = _game_document(env["team_id"], alice, env["bob"], env["cara"])
        erase_player(alice["id"])

        _as(COACH)
        response = client.post(f"/api/games/{env['game_id']}/sync", json=cached)
        assert response.status_code == 200

        stored = json.dumps(get_game_current(env["game_id"]))
        assert alice["id"] not in stored
        assert alice["name"] not in stored
        # And not into the fresh version backup this sync just wrote, either.
        assert_absent(env["root"], alice["name"], "resurrected name")
        assert_absent(env["root"], alice["id"], "resurrected id")

    def test_recreating_an_erased_team_is_refused(self, env, client):
        from storage import erase_team
        erase_team(env["team_id"])

        _as(ADMIN)
        response = client.post("/api/teams", json={
            "id": env["team_id"], "name": "Erase Team", "playerIds": [],
        })
        assert response.status_code == 410

    def test_denylist_stores_no_plaintext_id_or_name(self, env):
        """The deny-list must not become a tidy list of the names just erased."""
        from storage import erase_player
        alice = env["alice"]
        erase_player(alice["id"])

        blob = (env["root"] / "erased.json").read_bytes()
        for form in _needle_forms(alice["id"]) | _needle_forms(alice["name"]):
            assert form not in blob


# =============================================================================
# Authorization
# =============================================================================

class TestErasureAuthorization:

    def test_coach_of_the_team_may_erase(self, env, client):
        _as(COACH)
        response = client.post(f"/api/players/{env['alice']['id']}/erase")
        assert response.status_code == 200
        body = response.json()
        assert body["erased"]["players"] == 1
        assert body["tombstoneId"].startswith("Removed-")

    def test_viewer_cannot_erase_a_player(self, env, client):
        _as(VIEWER)
        response = client.post(f"/api/players/{env['alice']['id']}/erase")
        assert response.status_code == 403
        assert_absent(env["root"], "Removed-", "tombstone from a refused erasure")

    def test_coach_of_a_different_team_cannot_erase_a_player(self, env, client):
        _as(OTHER_COACH)
        response = client.post(f"/api/players/{env['alice']['id']}/erase")
        assert response.status_code == 403

    def test_viewer_cannot_preview_a_player_erasure(self, env, client):
        _as(VIEWER)
        assert client.get(
            f"/api/players/{env['alice']['id']}/erase-preview"
        ).status_code == 403

    def test_viewer_cannot_erase_a_team(self, env, client):
        from storage import team_exists
        _as(VIEWER)
        assert client.post(f"/api/teams/{env['team_id']}/erase").status_code == 403
        assert team_exists(env["team_id"])

    def test_coach_of_a_different_team_cannot_erase_a_team(self, env, client):
        _as(OTHER_COACH)
        assert client.post(f"/api/teams/{env['team_id']}/erase").status_code == 403

    def test_preview_endpoint_writes_nothing(self, env, client):
        _as(COACH)
        before = snapshot_tree(env["root"])
        response = client.get(f"/api/players/{env['alice']['id']}/erase-preview")
        assert response.status_code == 200
        assert response.json()["willErase"]["versions"] == 3
        assert snapshot_tree(env["root"]) == before

    def test_erase_endpoint_is_idempotent_for_the_same_coach(self, env, client):
        _as(COACH)
        assert client.post(f"/api/players/{env['alice']['id']}/erase").status_code == 200
        again = client.post(f"/api/players/{env['alice']['id']}/erase")
        assert again.status_code == 200
        assert again.json()["erased"]["players"] == 0

    def test_team_erase_endpoint_is_idempotent_for_an_admin(self, env, client):
        _as(ADMIN)
        assert client.post(f"/api/teams/{env['team_id']}/erase").status_code == 200
        again = client.post(f"/api/teams/{env['team_id']}/erase")
        assert again.status_code == 200
        assert again.json()["erased"]["teams"] == 0


# =============================================================================
# Scrubber unit tests — the traversal itself, no I/O
# =============================================================================

class TestScrubberPrecision:

    def test_a_present_non_matching_id_protects_a_shared_display_name(self):
        """Two players called "Alex". Erasing one must not blank the other."""
        from storage import PlayerScrubber
        scrubber = PlayerScrubber("Alex-1111", "Alex", "Removed-aaaa1111")
        event = {"type": "Throw", "thrower": "Alex", "throwerId": "Alex-2222"}
        assert scrubber.scrub_event(event) is False
        assert event["thrower"] == "Alex"
        assert scrubber.name_only_matches == 0

    def test_a_name_with_no_id_is_matched_and_counted(self):
        from storage import PlayerScrubber, TOMBSTONE_NAME
        scrubber = PlayerScrubber("Alex-1111", "Alex", "Removed-aaaa1111")
        event = {"type": "Throw", "thrower": "Alex"}
        assert scrubber.scrub_event(event) is True
        assert event["thrower"] == TOMBSTONE_NAME
        assert scrubber.name_only_matches == 1

    def test_an_empty_name_never_matches(self):
        """Otherwise every blank field in the corpus would look like the player."""
        from storage import PlayerScrubber
        scrubber = PlayerScrubber("Ghost-1111", "", "Removed-bbbb2222")
        event = {"type": "Throw", "thrower": "", "receiver": "Bob"}
        assert scrubber.scrub_event(event) is False
        assert event["thrower"] == ""

    def test_assist_fields_are_rewritten(self):
        from storage import PlayerScrubber, TOMBSTONE_NAME
        scrubber = PlayerScrubber("Alex-1111", "Alex", "Removed-cccc3333")
        event = {"type": "Throw", "thrower": "Bo", "throwerId": "Bo-9999",
                 "assist": "Alex", "assistId": "Alex-1111", "score_flag": True}
        assert scrubber.scrub_event(event) is True
        assert event["assistId"] == "Removed-cccc3333"
        assert event["assist"] == TOMBSTONE_NAME

    def test_unchanged_documents_report_no_change(self):
        from storage import PlayerScrubber
        scrubber = PlayerScrubber("Nobody-0000", "Nobody", "Removed-dddd4444")
        game = {"points": [{"players": ["Bob-1234"], "possessions": []}]}
        assert scrubber.scrub_game(game) is False


class TestPreviewSymmetry:

    def test_team_preview_counts_orphans_only_when_they_will_be_erased(self, env, client):
        _as(COACH)
        default = client.get(f"/api/teams/{env['team_id']}/erase-preview").json()
        assert default["willErase"]["players"] == 0
        assert len(default["orphanedPlayerIds"]) == 2

        opted_in = client.get(
            f"/api/teams/{env['team_id']}/erase-preview",
            params={"erase_orphaned_players": "true"},
        ).json()
        assert opted_in["willErase"]["players"] == 2

    def test_team_preview_counts_match_the_erasure(self, env, client):
        _as(COACH)
        preview = client.get(
            f"/api/teams/{env['team_id']}/erase-preview",
            params={"erase_orphaned_players": "true"},
        ).json()
        actual = client.post(
            f"/api/teams/{env['team_id']}/erase",
            params={"erase_orphaned_players": "true"},
        ).json()
        assert preview["willErase"] == actual["erased"]


class TestTombstoneMinting:

    def test_minted_ids_carry_no_name_and_do_not_repeat(self):
        from storage import mint_tombstone_id
        from storage.erasure import TOMBSTONE_RE
        minted = {mint_tombstone_id() for _ in range(200)}
        assert len(minted) == 200, "tombstones must not collide in normal use"
        assert all(TOMBSTONE_RE.match(t) for t in minted)

    def test_a_caller_supplied_tombstone_must_look_like_one(self, env):
        """The retry parameter must not double as a way to inject an arbitrary
        string into every stored document."""
        from storage import erase_player
        with pytest.raises(ValueError):
            erase_player(env["alice"]["id"], tombstone_id="../../etc/passwd")

    def test_a_valid_supplied_tombstone_is_used(self, env):
        from storage import erase_player, get_game_current
        result = erase_player(env["alice"]["id"], tombstone_id="Removed-abcd1234")
        assert result["tombstoneId"] == "Removed-abcd1234"
        roster = get_game_current(env["game_id"])["rosterSnapshot"]["players"]
        assert any(p["id"] == "Removed-abcd1234" for p in roster)


class TestNicknameMatching:
    """The nickname is a display name, not decoration.

    Both the PWA (helpers.js formatPlayerName) and the viewer
    (viewer.js resolvePlayerName) render ``nickname || name``, so a stored
    display field holds the NICKNAME whenever the player has one — which makes
    an ID-less legacy reference more likely to carry the nickname than the name.
    """

    def test_the_nickname_is_a_byte_needle(self):
        """Not just a matcher: a needle. Omit it and _iter_candidate_files
        never opens a file whose only trace is the nickname."""
        from storage import PlayerScrubber
        scrubber = PlayerScrubber("Persephone-7f3a", "Persephone",
                                  "Removed-aaaa1111", player_nickname="Seph")
        needles = {n.decode() for n in scrubber.needles()}
        assert "Seph" in needles
        assert "Persephone" in needles
        assert "Persephone-7f3a" in needles

    def test_a_nickname_only_legacy_event_is_matched(self):
        from storage import PlayerScrubber, TOMBSTONE_NAME
        scrubber = PlayerScrubber("Persephone-7f3a", "Persephone",
                                  "Removed-aaaa1111", player_nickname="Seph")
        event = {"type": "Throw", "thrower": "Seph"}
        assert scrubber.scrub_event(event) is True
        assert event["thrower"] == TOMBSTONE_NAME
        assert scrubber.name_only_matches == 1

    def test_the_id_gate_still_protects_a_same_nicknamed_teammate(self):
        from storage import PlayerScrubber
        scrubber = PlayerScrubber("Persephone-7f3a", "Persephone",
                                  "Removed-aaaa1111", player_nickname="Seph")
        event = {"type": "Throw", "thrower": "Seph", "throwerId": "Sephora-2222"}
        assert scrubber.scrub_event(event) is False
        assert event["thrower"] == "Seph"
        assert scrubber.name_only_matches == 0

    def test_an_id_less_roster_entry_is_matched_by_nickname(self):
        from storage import PlayerScrubber, TOMBSTONE_NAME
        scrubber = PlayerScrubber("Persephone-7f3a", "Persephone",
                                  "Removed-aaaa1111", player_nickname="Seph")
        snapshot = {"players": [{"name": "P.", "nickname": "Seph", "number": "4"}]}
        assert scrubber.scrub_roster_snapshot(snapshot) is True
        entry = snapshot["players"][0]
        assert entry["name"] == TOMBSTONE_NAME
        assert entry["nickname"] is None and entry["number"] is None

    def test_an_empty_nickname_never_matches(self):
        from storage import PlayerScrubber
        scrubber = PlayerScrubber("Ghost-1111", "Ghost", "Removed-bbbb2222",
                                  player_nickname="")
        event = {"type": "Throw", "thrower": "", "receiver": "Bob"}
        assert scrubber.scrub_event(event) is False

    def test_a_stale_client_cannot_resurrect_via_the_nickname(self, env, client):
        """The deny-list has to recognise a nickname-only inbound reference."""
        from storage import erase_player, get_game_current
        alice = env["alice"]
        cached = {
            "team": "Erase Team", "opponent": "Rivals", "teamId": env["team_id"],
            "points": [{"players": [env["nickname"]], "winner": "team",
                        "startingPosition": "offense",
                        "possessions": [{"offensive": True, "events": [
                            {"type": "Throw", "thrower": env["nickname"],
                             "receiver": env["bob"]["name"]}]}]}],
        }
        erase_player(alice["id"])

        _as(COACH)
        response = client.post(f"/api/games/{env['game_id']}/sync", json=cached)
        assert response.status_code == 200

        stored = json.dumps(get_game_current(env["game_id"]))
        assert env["nickname"] not in stored
        assert_absent(env["root"], env["nickname"], "resurrected nickname")


class TestPendingScalarFields:

    def test_an_unrelated_value_is_left_alone(self):
        """lineCoachViewing normally holds a line type, not a name."""
        from storage import PlayerScrubber
        scrubber = PlayerScrubber("Alex-1111", "Alex", "Removed-cccc3333")
        pending = {"lineCoachViewing": "od", "lineupReadyBy": "Jordan"}
        game = {"pendingNextLine": dict(pending)}
        assert scrubber.scrub_game(game) is False
        assert game["pendingNextLine"] == pending

    def test_the_scalar_match_is_not_counted_as_a_teammate_collision(self):
        """These hold COACH identity, so they must not inflate the warning
        about a same-named teammate being caught."""
        from storage import PlayerScrubber
        scrubber = PlayerScrubber("Alex-1111", "Alex", "Removed-cccc3333")
        game = {"pendingNextLine": {"lineupReadyBy": "Alex"}}
        assert scrubber.scrub_game(game) is True
        assert game["pendingNextLine"]["lineupReadyBy"] is None
        assert scrubber.name_only_matches == 0
