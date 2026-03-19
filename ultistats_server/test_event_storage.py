"""
Tests for event storage.

Run with: cd ultistats_server && python -m pytest test_event_storage.py -v
"""
import pytest
import json
import os
from pathlib import Path

_original_env = os.environ.get("ULTISTATS_DATA_DIR")


@pytest.fixture(autouse=True)
def isolate_test_data(tmp_path):
    """Create an isolated data directory for each test."""
    test_data_dir = tmp_path / "test_data"
    test_data_dir.mkdir()

    os.environ["ULTISTATS_DATA_DIR"] = str(test_data_dir)

    import importlib
    import config
    importlib.reload(config)

    from storage import event_storage
    importlib.reload(event_storage)

    yield test_data_dir

    if _original_env:
        os.environ["ULTISTATS_DATA_DIR"] = _original_env
    else:
        os.environ.pop("ULTISTATS_DATA_DIR", None)


class TestEventStorage:

    def test_generate_event_id(self, isolate_test_data):
        from storage.event_storage import generate_event_id
        eid = generate_event_id("Spring League")
        assert eid.startswith("Spring-League-")
        assert len(eid.split("-")[-1]) == 4

    def test_generate_event_id_empty(self, isolate_test_data):
        from storage.event_storage import generate_event_id
        eid = generate_event_id("")
        assert eid.startswith("event-")

    def test_save_and_get(self, isolate_test_data):
        from storage.event_storage import save_event, get_event, event_exists
        event_data = {
            "name": "Summer Tournament",
            "teamId": "team-abc1",
            "status": "open",
            "defaults": {"alternateGenderRatio": "No", "playersPerSide": 7},
            "roster": {"playerIds": ["p1", "p2"], "pickupPlayers": []},
        }
        event_id = save_event(event_data)
        assert event_exists(event_id)

        retrieved = get_event(event_id)
        assert retrieved["name"] == "Summer Tournament"
        assert retrieved["teamId"] == "team-abc1"
        assert retrieved["status"] == "open"
        assert retrieved["gameIds"] == []
        assert "createdAt" in retrieved
        assert "updatedAt" in retrieved

    def test_save_with_id(self, isolate_test_data):
        from storage.event_storage import save_event, get_event
        event_id = save_event({"name": "Test", "teamId": "t1"}, "my-custom-id")
        assert event_id == "my-custom-id"
        assert get_event("my-custom-id")["name"] == "Test"

    def test_list_events(self, isolate_test_data):
        from storage.event_storage import save_event, list_events
        save_event({"name": "Event A", "teamId": "t1"})
        save_event({"name": "Event B", "teamId": "t2"})
        events = list_events()
        assert len(events) == 2

    def test_update_event(self, isolate_test_data):
        from storage.event_storage import save_event, get_event, update_event
        event_id = save_event({"name": "Original", "teamId": "t1"})
        original = get_event(event_id)

        update_event(event_id, {"name": "Updated", "teamId": "t1"})
        updated = get_event(event_id)
        assert updated["name"] == "Updated"
        assert updated["createdAt"] == original["createdAt"]

    def test_update_nonexistent(self, isolate_test_data):
        from storage.event_storage import update_event
        with pytest.raises(FileNotFoundError):
            update_event("nonexistent-id", {"name": "X"})

    def test_delete_event(self, isolate_test_data):
        from storage.event_storage import save_event, delete_event, event_exists
        event_id = save_event({"name": "ToDelete", "teamId": "t1"})
        assert event_exists(event_id)
        assert delete_event(event_id) is True
        assert not event_exists(event_id)

    def test_delete_nonexistent(self, isolate_test_data):
        from storage.event_storage import delete_event
        assert delete_event("nonexistent") is False

    def test_list_team_events(self, isolate_test_data):
        from storage.event_storage import save_event, list_team_events
        save_event({"name": "A", "teamId": "team1"})
        save_event({"name": "B", "teamId": "team1"})
        save_event({"name": "C", "teamId": "team2"})

        team1_events = list_team_events("team1")
        assert len(team1_events) == 2
        assert all(e["teamId"] == "team1" for e in team1_events)

        team2_events = list_team_events("team2")
        assert len(team2_events) == 1

    def test_add_game_to_event(self, isolate_test_data):
        from storage.event_storage import save_event, get_event, add_game_to_event
        event_id = save_event({"name": "E", "teamId": "t1"})
        add_game_to_event(event_id, "game-1")
        assert "game-1" in get_event(event_id)["gameIds"]

        # Idempotent
        add_game_to_event(event_id, "game-1")
        assert get_event(event_id)["gameIds"].count("game-1") == 1

        add_game_to_event(event_id, "game-2")
        assert len(get_event(event_id)["gameIds"]) == 2

    def test_get_nonexistent(self, isolate_test_data):
        from storage.event_storage import get_event
        with pytest.raises(FileNotFoundError):
            get_event("nonexistent-id")

    def test_defaults_filled_in(self, isolate_test_data):
        from storage.event_storage import save_event, get_event
        event_id = save_event({"name": "Minimal", "teamId": "t1"})
        event = get_event(event_id)
        assert event["gameIds"] == []
        assert event["status"] == "open"
        assert event["defaults"] == {}
        assert event["roster"] == {"playerIds": [], "pickupPlayers": []}
