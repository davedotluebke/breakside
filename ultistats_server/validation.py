"""
Input validation helpers for path safety.

User-supplied identifiers (game/team/player/event IDs, version timestamps,
share hashes, invite codes) and filenames flow into ``Path(...)`` joins for
file-based storage. Without validation, a value like ``../../etc/passwd`` (or
URL-encoded equivalents) escapes the intended directory. These helpers reject
such values at the API boundary and re-confirm containment for static serving.
"""
import re
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, status

# A safe identifier is a non-empty run of letters, digits, underscore and
# hyphen. This covers every ID format the app generates:
#   - players/teams: ``Name-7f3a``
#   - games: ``2025-11-15_CUDO-Mixed_vs_Alexandria_1763235977720``
#   - version timestamps: ``2025-11-15T10-23-45`` (and counter suffixes)
#   - invite codes / share hashes: alphanumeric tokens
# Crucially it contains no ``.`` and no ``/``, so ``..`` and absolute/relative
# path escapes are rejected.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def is_valid_id(value: str) -> bool:
    """Return True if ``value`` is a safe ``[A-Za-z0-9_-]+`` identifier."""
    return bool(value) and _ID_RE.match(value) is not None


def validate_id(value: str, name: str = "id") -> str:
    """Validate a path-parameter identifier, or raise HTTP 400.

    Use this on every user-supplied value that is subsequently joined into a
    filesystem path (game_id, timestamp, player_id, team_id, event_id, share
    hash, invite code).
    """
    if not is_valid_id(value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {name}",
        )
    return value


def safe_static_path(base_dir: Path, relative: str) -> Optional[Path]:
    """Resolve ``relative`` under ``base_dir`` and confirm it stays inside.

    Returns the resolved :class:`Path` when it is an existing file genuinely
    contained in ``base_dir``; returns ``None`` otherwise (caller should 404).

    A first-path-segment whitelist alone is insufficient — ``game/../../secret``
    passes such a check but escapes the directory. Resolving both paths and
    asserting ``is_relative_to`` closes that hole.
    """
    if not relative:
        return None
    base = base_dir.resolve()
    try:
        candidate = (base / relative).resolve()
    except (OSError, ValueError, RuntimeError):
        return None
    if base != candidate and base not in candidate.parents:
        return None
    if not candidate.is_file():
        return None
    return candidate
