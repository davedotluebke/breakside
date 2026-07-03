"""
Shared ID generation for named entities (players, teams, events).

IDs use the format ``{sanitized-name}-{4-char-hash}`` (e.g. "Alice-7f3a",
"Sample-Team-b2c4"). This logic was previously copy-pasted verbatim across
player/team/event storage.
"""
import random
import re
import string
from typing import Callable

_HASH_CHARS = string.ascii_lowercase + string.digits


def generate_entity_id(name: str, fallback: str) -> str:
    """
    Generate a short, human-readable entity ID.
    Format: {sanitized-name}-{4-char-hash}
    Example: "Alice-7f3a", "Bob-Smith-2d9e"

    ``fallback`` is used when the name sanitizes to nothing (e.g. "player").
    """
    # Sanitize: keep alphanumeric and spaces, convert spaces to hyphens
    safe_name = re.sub(r'[^a-zA-Z0-9\s-]', '', name)
    safe_name = re.sub(r'\s+', '-', safe_name).strip('-')
    safe_name = safe_name[:20]  # Max 20 chars
    safe_name = re.sub(r'-+$', '', safe_name)  # Trim trailing hyphens

    if not safe_name:
        safe_name = fallback

    # Generate 4-char alphanumeric hash
    hash_part = ''.join(random.choice(_HASH_CHARS) for _ in range(4))

    return f"{safe_name}-{hash_part}"


def ensure_unique_id(entity_id: str, exists: Callable[[str], bool]) -> str:
    """
    Ensure the entity ID is unique (per ``exists``). If collision, append extra chars.
    """
    original_id = entity_id
    attempt = 0
    while exists(entity_id):
        attempt += 1
        extra = ''.join(random.choice(_HASH_CHARS) for _ in range(2))
        entity_id = f"{original_id}{extra}"
        if attempt > 10:
            # Extremely unlikely, but prevent infinite loop
            entity_id = f"{original_id}-{random.randint(1000, 9999)}"
            break
    return entity_id
