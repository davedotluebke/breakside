"""
Team storage using JSON files.
Each team is stored as a separate JSON file: data/teams/{team_id}.json

CRUD mechanics live in the shared JsonEntityStore; this module binds it to
TEAMS_DIR and keeps the long-standing public function API.
"""
from typing import List, Optional

from ._config import config
from .entity_store import JsonEntityStore
from .id_utils import generate_entity_id
from .player_storage import get_player

TEAMS_DIR = config.TEAMS_DIR


def _team_defaults(team_data: dict) -> None:
    # Ensure playerIds is a list
    if 'playerIds' not in team_data:
        team_data['playerIds'] = []


# dir_getter re-reads the module global so tests can patch TEAMS_DIR.
_store = JsonEntityStore(
    kind="Team",
    dir_getter=lambda: TEAMS_DIR,
    sort_key=lambda t: t.get('name', '').lower(),
    strip_fields=('_localOnly',),
    apply_defaults=_team_defaults,
)


def generate_team_id(name: str) -> str:
    """
    Generate a short, human-readable team ID.
    Format: {sanitized-name}-{4-char-hash}
    Example: "Sample-Team-b2c4", "Thunder-a1f3"
    """
    return generate_entity_id(name, "team")


def save_team(team_data: dict, team_id: Optional[str] = None) -> str:
    """
    Save a team. If no ID provided, generates one from the name.

    Args:
        team_data: Team data dictionary (must include 'name')
        team_id: Optional existing team ID (for updates)

    Returns:
        The team ID
    """
    return _store.save(team_data, team_id)


def get_team(team_id: str) -> dict:
    """
    Get a team by ID.

    Raises:
        FileNotFoundError: If team doesn't exist
    """
    return _store.get(team_id)


def list_teams() -> List[dict]:
    """List all teams with their data, sorted by name."""
    return _store.list()


def update_team(team_id: str, team_data: dict) -> str:
    """
    Update an existing team (preserves createdAt).

    Raises:
        FileNotFoundError: If team doesn't exist
    """
    return _store.update(team_id, team_data)


def delete_team(team_id: str) -> bool:
    """Delete a team. Returns True if deleted, False if didn't exist."""
    return _store.delete(team_id)


def team_exists(team_id: str) -> bool:
    """Check if a team exists."""
    return _store.exists(team_id)


def get_team_players(team_id: str) -> List[dict]:
    """
    Get all players for a team (resolved from playerIds).

    Args:
        team_id: The team's unique ID

    Returns:
        List of player data dictionaries

    Raises:
        FileNotFoundError: If team doesn't exist
    """
    team = get_team(team_id)
    player_ids = team.get('playerIds', [])

    players = []
    for player_id in player_ids:
        try:
            player = get_player(player_id)
            players.append(player)
        except FileNotFoundError:
            # Player was deleted, skip
            continue

    return players
