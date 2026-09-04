"""
Event storage using JSON files.
Each event is stored as a separate JSON file: data/events/{event_id}.json

CRUD mechanics live in the shared JsonEntityStore; this module binds it to
EVENTS_DIR and keeps the long-standing public function API.
"""
from typing import List, Optional

from ._config import config
from .entity_store import JsonEntityStore
from .file_utils import entity_lock
from .id_utils import generate_entity_id

EVENTS_DIR = config.EVENTS_DIR


def _event_defaults(event_data: dict) -> None:
    # Ensure required fields
    if 'gameIds' not in event_data:
        event_data['gameIds'] = []
    if 'status' not in event_data:
        event_data['status'] = 'open'
    if 'defaults' not in event_data:
        event_data['defaults'] = {}
    if 'roster' not in event_data:
        event_data['roster'] = {'playerIds': [], 'pickupPlayers': []}


# dir_getter re-reads the module global so tests can patch EVENTS_DIR.
_store = JsonEntityStore(
    kind="Event",
    dir_getter=lambda: EVENTS_DIR,
    sort_key=lambda e: e.get('createdAt', ''),
    sort_reverse=True,
    apply_defaults=_event_defaults,
)


def generate_event_id(name: str) -> str:
    """
    Generate a short, human-readable event ID.
    Format: {sanitized-name}-{4-char-hash}
    """
    return generate_entity_id(name, "event")


def save_event(event_data: dict, event_id: Optional[str] = None) -> str:
    """
    Save an event. If no ID provided, generates one from the name.
    Returns the event ID.
    """
    return _store.save(event_data, event_id)


def get_event(event_id: str) -> dict:
    """Get an event by ID."""
    return _store.get(event_id)


def list_events() -> List[dict]:
    """List all events, newest first."""
    return _store.list()


def update_event(event_id: str, event_data: dict) -> str:
    """Update an existing event."""
    return _store.update(event_id, event_data)


def delete_event(event_id: str) -> bool:
    """Delete an event. Returns True if deleted."""
    return _store.delete(event_id)


def event_exists(event_id: str) -> bool:
    """Check if an event exists."""
    return _store.exists(event_id)


def list_team_events(team_id: str) -> List[dict]:
    """List all events for a specific team."""
    all_events = list_events()
    return [e for e in all_events if e.get('teamId') == team_id]


def add_game_to_event(event_id: str, game_id: str) -> None:
    """Add a game ID to an event's gameIds list (idempotent)."""
    # Serialize so two games syncing into the same event concurrently can't
    # each read the old gameIds and drop one another's addition. Uses the same
    # lock key as update_event (via the store's "event:{id}" convention).
    with entity_lock(f"event:{event_id}"):
        event = get_event(event_id)
        if game_id not in event.get('gameIds', []):
            event.setdefault('gameIds', []).append(game_id)
            save_event(event, event_id)
