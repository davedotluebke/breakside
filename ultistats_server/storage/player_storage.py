"""
Player storage using JSON files.
Each player is stored as a separate JSON file: data/players/{player_id}.json

CRUD mechanics live in the shared JsonEntityStore; this module binds it to
PLAYERS_DIR and keeps the long-standing public function API.
"""
from typing import List, Optional

from ._config import config
from .entity_store import JsonEntityStore
from .id_utils import generate_entity_id

PLAYERS_DIR = config.PLAYERS_DIR

# dir_getter re-reads the module global so tests can patch PLAYERS_DIR.
_store = JsonEntityStore(
    kind="Player",
    dir_getter=lambda: PLAYERS_DIR,
    sort_key=lambda p: p.get('name', '').lower(),
    strip_fields=('_localOnly',),
)


def generate_player_id(name: str) -> str:
    """
    Generate a short, human-readable player ID.
    Format: {sanitized-name}-{4-char-hash}
    Example: "Alice-7f3a", "Bob-Smith-2d9e"
    """
    return generate_entity_id(name, "player")


def save_player(player_data: dict, player_id: Optional[str] = None) -> str:
    """
    Save a player. If no ID provided, generates one from the name.

    Args:
        player_data: Player data dictionary (must include 'name')
        player_id: Optional existing player ID (for updates)

    Returns:
        The player ID
    """
    return _store.save(player_data, player_id)


def get_player(player_id: str) -> dict:
    """
    Get a player by ID.

    Raises:
        FileNotFoundError: If player doesn't exist
    """
    return _store.get(player_id)


def list_players() -> List[dict]:
    """List all players with their data, sorted by name."""
    return _store.list()


def update_player(player_id: str, player_data: dict) -> str:
    """
    Update an existing player (preserves createdAt).

    Raises:
        FileNotFoundError: If player doesn't exist
    """
    return _store.update(player_id, player_data)


def delete_player(player_id: str) -> bool:
    """Delete a player. Returns True if deleted, False if didn't exist."""
    return _store.delete(player_id)


def player_exists(player_id: str) -> bool:
    """Check if a player exists."""
    return _store.exists(player_id)
