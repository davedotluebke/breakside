"""Shared pytest configuration for the backend test suite."""

import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "live_llm: calls live LLM APIs (slow, non-deterministic, costs money). "
        "Skipped by default; opt in with NARRATION_LIVE_TESTS=1.",
    )


# Users the narration authorization tests act as. Only NARRATION_COACH holds
# coach membership on the team that owns NARRATION_GAME_ID.
NARRATION_COACH = {"id": "narr-coach", "email": "narr-coach@test", "role": "authenticated"}
NARRATION_OTHER_COACH = {"id": "narr-other", "email": "narr-other@test", "role": "authenticated"}
NARRATION_VIEWER = {"id": "narr-viewer", "email": "narr-viewer@test", "role": "authenticated"}
NARRATION_OUTSIDER = {"id": "narr-outsider", "email": "narr-out@test", "role": "authenticated"}

# The seeded game. Real game ids look like this, and the value has to satisfy
# validate_id() — narration bodies now carry it into a filesystem lookup.
NARRATION_GAME_ID = "2026-08-24_Narration-Team_vs_Other-Team_1"


@pytest.fixture
def narration_data(tmp_path):
    """Isolated data dir seeded for the narration authorization tests.

    Storage modules snapshot their dir constants at import time (see
    ``storage/_config.py``), so patching ``config.*`` alone would let writes
    land in the repo's real ``data/`` — patch both, and restore on teardown.
    Same shape as the fixtures in ``test_api.py`` / ``test_security.py``.

    Seeds the three positions the narration routes have to tell apart:
    a coach of the game's team, a coach of an *unrelated* team, and a viewer
    on the game's team. ``narr-outsider`` is seeded with nothing at all.

    Yields a dict with ``game_id``, ``team_id`` and ``other_team_id``.
    """
    import config
    from storage import (
        game_storage, team_storage, player_storage, user_storage,
        membership_storage, index_storage,
    )

    patches = [
        (config, "DATA_DIR", tmp_path),
        (config, "GAMES_DIR", tmp_path / "games"),
        (config, "TEAMS_DIR", tmp_path / "teams"),
        (config, "PLAYERS_DIR", tmp_path / "players"),
        (config, "USERS_DIR", tmp_path / "users"),
        (config, "MEMBERSHIPS_DIR", tmp_path / "memberships"),
        (config, "INDEX_FILE", tmp_path / "index.json"),
        (game_storage, "GAMES_DIR", tmp_path / "games"),
        (team_storage, "TEAMS_DIR", tmp_path / "teams"),
        (player_storage, "PLAYERS_DIR", tmp_path / "players"),
        (user_storage, "USERS_DIR", tmp_path / "users"),
        (membership_storage, "MEMBERSHIPS_DIR", tmp_path / "memberships"),
        (membership_storage, "INDEX_FILE", tmp_path / "memberships" / "_index.json"),
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

    team_id = team_storage.save_team({"name": "Narration Team"})
    other_team_id = team_storage.save_team({"name": "Other Team"})
    game_id = NARRATION_GAME_ID
    game_storage.save_game_version(game_id, {"id": game_id, "teamId": team_id})

    membership_storage.create_membership(team_id, NARRATION_COACH["id"], "coach")
    membership_storage.create_membership(team_id, NARRATION_VIEWER["id"], "viewer")
    membership_storage.create_membership(other_team_id, NARRATION_OTHER_COACH["id"], "coach")
    index_storage.rebuild_index()

    yield {"game_id": game_id, "team_id": team_id, "other_team_id": other_team_id}

    from main import app
    app.dependency_overrides.clear()
    for mod, name, original in saved:
        setattr(mod, name, original)
