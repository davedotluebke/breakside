"""
End-to-end tests for admin_group_games.py.

Each test runs the CLI as a subprocess against an isolated ULTISTATS_DATA_DIR,
so it exercises the real entry point (argparse + storage writes + index) in a
clean process — the same way it'll run on the server.

Run with: cd ultistats_server && python -m pytest test_admin_group_games.py -v
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).parent
SCRIPT = SERVER_DIR / "admin_group_games.py"


def run(data_dir: Path, *cli_args):
    env = dict(os.environ, ULTISTATS_DATA_DIR=str(data_dir))
    return subprocess.run(
        [sys.executable, str(SCRIPT), *cli_args],
        cwd=str(SERVER_DIR), env=env,
        capture_output=True, text=True,
    )


def make_team(data_dir: Path, team_id: str, name: str, player_ids=None):
    (data_dir / "teams").mkdir(parents=True, exist_ok=True)
    (data_dir / "teams" / f"{team_id}.json").write_text(json.dumps({
        "id": team_id, "name": name, "playerIds": player_ids or [],
    }))


def make_game(data_dir: Path, game_id: str, team_id: str, opponent: str,
              start: str, event_id=None):
    gdir = data_dir / "games" / game_id
    (gdir / "versions").mkdir(parents=True, exist_ok=True)
    (gdir / "current.json").write_text(json.dumps({
        "team": "T", "teamId": team_id, "opponent": opponent,
        "eventId": event_id, "phase": None,
        "gameStartTimestamp": start,
        "scores": {"team": 15, "opponent": 10},
        "rosterSnapshot": {"players": [{"id": "Alice-1111"}, {"id": "Bob-2222"}]},
        "points": [],
    }))


def read_game_event(data_dir: Path, game_id: str):
    d = json.loads((data_dir / "games" / game_id / "current.json").read_text())
    return d.get("eventId")


def only_event(data_dir: Path):
    files = list((data_dir / "events").glob("*.json"))
    assert len(files) == 1, f"expected 1 event, found {len(files)}"
    return json.loads(files[0].read_text())


@pytest.fixture
def data(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    make_team(d, "Flickers-abcd", "Flickers",
              player_ids=["Alice-1111", "Bob-2222"])
    make_team(d, "Offline-Test-9999", "Offline Test")  # no team playerIds
    make_game(d, "g1", "Flickers-abcd", "Sharks", "2026-06-19T18:00:00.000Z")
    make_game(d, "g2", "Flickers-abcd", "Bears", "2026-06-19T20:00:00.000Z")
    make_game(d, "other", "Offline-Test-9999", "Nobody", "2026-06-19T12:00:00.000Z")
    return d


def test_teams_and_games_listing(data):
    r = run(data, "teams")
    assert r.returncode == 0, r.stderr
    assert "Flickers" in r.stdout and "Offline Test" in r.stdout

    r = run(data, "games", "--team", "Flickers")
    assert r.returncode == 0, r.stderr
    assert "g1" in r.stdout and "g2" in r.stdout
    assert "Nobody" not in r.stdout  # other team's game not shown


def test_dry_run_writes_nothing(data):
    r = run(data, "group", "--team", "Flickers",
            "--event", "Summer League - June 19", "--games", "g1", "g2")
    assert r.returncode == 0, r.stderr
    assert "WILL BE CREATED" in r.stdout
    assert "Dry run" in r.stdout
    assert read_game_event(data, "g1") is None
    assert not list((data / "events").glob("*.json"))


def test_group_creates_event_and_links(data):
    r = run(data, "group", "--team", "Flickers",
            "--event", "Summer League - June 19",
            "--phase", "Pool Play", "--games", "g1", "g2", "--yes")
    assert r.returncode == 0, r.stderr

    ev = only_event(data)
    assert ev["name"] == "Summer League - June 19"
    assert ev["teamId"] == "Flickers-abcd"
    assert set(ev["gameIds"]) == {"g1", "g2"}
    assert ev["phases"] == ["Pool Play"]
    # Roster seeded from team.playerIds so the in-game Lines table renders.
    assert ev["roster"]["playerIds"] == ["Alice-1111", "Bob-2222"]
    assert read_game_event(data, "g1") == ev["id"]
    assert read_game_event(data, "g2") == ev["id"]

    # Index reflects the team's games.
    idx = json.loads((data / "index.json").read_text())
    assert set(idx["teamGames"]["Flickers-abcd"]) == {"g1", "g2"}


def test_roster_falls_back_to_game_snapshot(data):
    # Offline Test has no team.playerIds; roster should come from the linked
    # game's rosterSnapshot players (Alice-1111, Bob-2222).
    r = run(data, "group", "--team", "Offline Test", "--event", "OT Combo",
            "--games", "other", "--yes")
    assert r.returncode == 0, r.stderr
    ev = only_event(data)
    assert set(ev["roster"]["playerIds"]) == {"Alice-1111", "Bob-2222"}


def test_group_is_idempotent(data):
    a = ["group", "--team", "Flickers", "--event", "SL", "--games", "g1", "g2", "--yes"]
    r1 = run(data, *a)
    assert r1.returncode == 0, r1.stderr
    eid = only_event(data)["id"]
    # Re-run reusing same event by id; should not create a second event or dup.
    r2 = run(data, "group", "--team", "Flickers", "--event", "SL",
             "--event-id", eid, "--games", "g1", "g2", "--yes")
    assert r2.returncode == 0, r2.stderr
    ev = only_event(data)
    assert ev["gameIds"] == ["g1", "g2"]


def test_refuses_cross_team_game(data):
    r = run(data, "group", "--team", "Flickers", "--event", "SL",
            "--games", "g1", "other", "--yes")
    assert r.returncode != 0
    assert "belongs to team" in r.stderr
    assert not list((data / "events").glob("*.json"))  # nothing created


def test_conflict_requires_force(data):
    run(data, "group", "--team", "Flickers", "--event", "First",
        "--games", "g1", "--yes")
    eid = only_event(data)["id"]
    # g1 now in "First"; try to put it in a new event without --force.
    r = run(data, "group", "--team", "Flickers", "--event", "Second",
            "--games", "g1", "--yes")
    assert r.returncode != 0
    assert "already in a different event" in r.stderr

    # With --force it moves.
    r = run(data, "group", "--team", "Flickers", "--event", "Second",
            "--games", "g1", "--force", "--yes")
    assert r.returncode == 0, r.stderr
    assert read_game_event(data, "g1") != eid


def test_unlink_and_delete(data):
    run(data, "group", "--team", "Flickers", "--event", "SL",
        "--games", "g1", "g2", "--yes")
    eid = only_event(data)["id"]
    r = run(data, "unlink", "--event", eid, "--all", "--delete-event", "--yes")
    assert r.returncode == 0, r.stderr
    assert read_game_event(data, "g1") is None
    assert read_game_event(data, "g2") is None
    assert not list((data / "events").glob("*.json"))
