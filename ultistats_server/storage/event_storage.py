"""
Event storage using JSON files.
Each event is stored as a separate JSON file: data/events/{event_id}.json
"""
import json
import re
import random
import string
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

try:
    from config import EVENTS_DIR
except ImportError:
    try:
        from ultistats_server.config import EVENTS_DIR
    except ImportError:
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from config import EVENTS_DIR


def generate_event_id(name: str) -> str:
    """
    Generate a short, human-readable event ID.
    Format: {sanitized-name}-{4-char-hash}
    """
    safe_name = re.sub(r'[^a-zA-Z0-9\s-]', '', name)
    safe_name = re.sub(r'\s+', '-', safe_name).strip('-')
    safe_name = safe_name[:20]
    safe_name = re.sub(r'-+$', '', safe_name)

    if not safe_name:
        safe_name = "event"

    chars = string.ascii_lowercase + string.digits
    hash_part = ''.join(random.choice(chars) for _ in range(4))

    return f"{safe_name}-{hash_part}"


def _ensure_unique_id(event_id: str) -> str:
    """Ensure the event ID is unique."""
    original_id = event_id
    attempt = 0
    while event_exists(event_id):
        attempt += 1
        chars = string.ascii_lowercase + string.digits
        extra = ''.join(random.choice(chars) for _ in range(2))
        event_id = f"{original_id}{extra}"
        if attempt > 10:
            event_id = f"{original_id}-{random.randint(1000, 9999)}"
            break
    return event_id


def save_event(event_data: dict, event_id: Optional[str] = None) -> str:
    """
    Save an event. If no ID provided, generates one from the name.
    Returns the event ID.
    """
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)

    if not event_id:
        name = event_data.get('name', 'Unknown')
        event_id = generate_event_id(name)
        event_id = _ensure_unique_id(event_id)

    now = datetime.now().isoformat()
    if 'createdAt' not in event_data:
        event_data['createdAt'] = now
    event_data['updatedAt'] = now
    event_data['id'] = event_id

    # Ensure required fields
    if 'gameIds' not in event_data:
        event_data['gameIds'] = []
    if 'status' not in event_data:
        event_data['status'] = 'open'
    if 'defaults' not in event_data:
        event_data['defaults'] = {}
    if 'roster' not in event_data:
        event_data['roster'] = {'playerIds': [], 'pickupPlayers': []}

    event_file = EVENTS_DIR / f"{event_id}.json"
    with open(event_file, 'w') as f:
        json.dump(event_data, f, indent=2)

    return event_id


def get_event(event_id: str) -> dict:
    """Get an event by ID."""
    event_file = EVENTS_DIR / f"{event_id}.json"
    if not event_file.exists():
        raise FileNotFoundError(f"Event {event_id} not found")

    with open(event_file, 'r') as f:
        return json.load(f)


def list_events() -> List[dict]:
    """List all events."""
    events = []
    if not EVENTS_DIR.exists():
        return events

    for event_file in EVENTS_DIR.glob("*.json"):
        try:
            with open(event_file, 'r') as f:
                events.append(json.load(f))
        except (json.JSONDecodeError, KeyError):
            continue

    events.sort(key=lambda e: e.get('createdAt', ''), reverse=True)
    return events


def update_event(event_id: str, event_data: dict) -> str:
    """Update an existing event."""
    if not event_exists(event_id):
        raise FileNotFoundError(f"Event {event_id} not found")

    existing = get_event(event_id)
    event_data['createdAt'] = existing.get('createdAt', datetime.now().isoformat())

    return save_event(event_data, event_id)


def delete_event(event_id: str) -> bool:
    """Delete an event. Returns True if deleted."""
    event_file = EVENTS_DIR / f"{event_id}.json"
    if not event_file.exists():
        return False
    event_file.unlink()
    return True


def event_exists(event_id: str) -> bool:
    """Check if an event exists."""
    event_file = EVENTS_DIR / f"{event_id}.json"
    return event_file.exists()


def list_team_events(team_id: str) -> List[dict]:
    """List all events for a specific team."""
    all_events = list_events()
    return [e for e in all_events if e.get('teamId') == team_id]


def add_game_to_event(event_id: str, game_id: str) -> None:
    """Add a game ID to an event's gameIds list (idempotent)."""
    event = get_event(event_id)
    if game_id not in event.get('gameIds', []):
        event.setdefault('gameIds', []).append(game_id)
        save_event(event, event_id)
