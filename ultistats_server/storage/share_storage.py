"""
Game share link storage module.

Manages share links that allow public (no-auth) access to specific games.
Share links can have optional expiration dates and can be revoked.

Share link structure:
{
    "id": "share_abc123def456",
    "gameId": "2025-12-07_Sample-Team_vs_Bad-Guys_...",
    "hash": "a8f3e2b1c9d4",      # 12-char random hex for URL
    "teamId": "Sample-Team-7y0n", # Denormalized for permission checks
    "createdBy": "user-uuid",
    "createdAt": "2025-01-15T10:00:00Z",
    "expiresAt": "2025-01-22T10:00:00Z",  # null = no expiry
    "revokedAt": null,
    "revokedBy": null
}

Storage: One JSON file per share, stored as {share_id}.json
Also maintain an index file for fast lookups by hash and game.
"""

import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional

from ._config import config
from .file_utils import atomic_write_json
from .json_index import JsonIndex, add_to_bucket, remove_from_bucket

SHARES_DIR = config.SHARES_DIR

# Index file for fast lookups
INDEX_FILE = SHARES_DIR / "_index.json"

# Serialized (locked) read-modify-write of the share index.
_index = JsonIndex(
    path_getter=lambda: INDEX_FILE,
    lock_key="share-index",
    empty=lambda: {"byHash": {}, "byGame": {}},
)


def _share_file(share_id: str) -> Path:
    """Get the path to a share JSON file."""
    return SHARES_DIR / f"{share_id}.json"


def _generate_share_id() -> str:
    """Generate a unique share ID."""
    return f"share_{secrets.token_hex(6)}"


def _generate_share_hash() -> str:
    """Generate a 12-character hex hash for the share URL."""
    return secrets.token_hex(6)


def _index_entry_add(index: Dict[str, Any], share: Dict[str, Any]) -> None:
    """Record one share in the index (byHash + byGame)."""
    index["byHash"][share["hash"]] = share["id"]
    add_to_bucket(index, "byGame", share["gameId"], share["id"])


def _update_index_add(share: Dict[str, Any]) -> None:
    """Add a share to the index (serialized read-modify-write)."""
    with _index.update() as index:
        _index_entry_add(index, share)


def _update_index_remove(share: Dict[str, Any]) -> None:
    """Remove a share from the index (serialized read-modify-write)."""
    with _index.update() as index:
        index["byHash"].pop(share["hash"], None)
        remove_from_bucket(index, "byGame", share["gameId"], share["id"])


def share_exists(share_id: str) -> bool:
    """Check if a share exists."""
    return _share_file(share_id).exists()


def get_share(share_id: str) -> Optional[Dict[str, Any]]:
    """Get a share by ID."""
    share_file = _share_file(share_id)
    if not share_file.exists():
        return None

    with open(share_file, "r") as f:
        return json.load(f)


def get_share_by_hash(hash: str) -> Optional[Dict[str, Any]]:
    """
    Look up a share by its URL hash.

    Args:
        hash: The 12-character hash from the share URL

    Returns:
        Share dict or None if not found
    """
    index = _index.load()
    share_id = index.get("byHash", {}).get(hash)

    if not share_id:
        return None

    return get_share(share_id)


def is_share_valid(share: Dict[str, Any]) -> bool:
    """
    Check if a share is currently valid (not expired, not revoked).

    Args:
        share: The share dict

    Returns:
        True if the share is valid for use
    """
    # Check if revoked
    if share.get("revokedAt"):
        return False

    # Check if expired
    expires_at = share.get("expiresAt")
    if expires_at:
        try:
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            # Normalize naive timestamps to UTC so the comparison is always
            # tz-aware (matches invite_storage); avoids a naive-vs-aware error.
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > expiry:
                return False
        except (ValueError, TypeError):
            # If we can't parse the date, treat as expired for safety
            return False

    return True


def create_share_link(
    game_id: str,
    team_id: str,
    created_by: str,
    expires_days: int = 7
) -> Dict[str, Any]:
    """
    Create a new share link for a game.

    Args:
        game_id: The game ID
        team_id: The team ID (denormalized for permission checks)
        created_by: User ID of who created the share
        expires_days: Days until expiration (1-365), or 0 for no expiry

    Returns:
        The created share link dict
    """
    now = datetime.now(timezone.utc)

    # Calculate expiry
    expires_at = None
    if expires_days > 0:
        expires_at = (now + timedelta(days=expires_days)).isoformat().replace("+00:00", "Z")

    share = {
        "id": _generate_share_id(),
        "gameId": game_id,
        "hash": _generate_share_hash(),
        "teamId": team_id,
        "createdBy": created_by,
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        "expiresAt": expires_at,
        "revokedAt": None,
        "revokedBy": None,
    }

    # Ensure directory exists
    SHARES_DIR.mkdir(parents=True, exist_ok=True)

    # Save share file
    atomic_write_json(_share_file(share["id"]), share)

    # Update index
    _update_index_add(share)

    return share


def list_game_shares(game_id: str) -> List[Dict[str, Any]]:
    """
    List all share links for a game.

    Args:
        game_id: The game ID

    Returns:
        List of share dicts (including revoked ones)
    """
    index = _index.load()
    share_ids = index.get("byGame", {}).get(game_id, [])

    shares = []
    for share_id in share_ids:
        share = get_share(share_id)
        if share:
            shares.append(share)

    # Sort by creation date, newest first
    shares.sort(key=lambda s: s.get("createdAt", ""), reverse=True)

    return shares


def revoke_share(share_id: str, revoked_by: str) -> bool:
    """
    Revoke a share link.

    Args:
        share_id: The share ID
        revoked_by: User ID of who revoked it

    Returns:
        True if share was found and revoked, False if not found
    """
    share = get_share(share_id)
    if not share:
        return False

    # Already revoked?
    if share.get("revokedAt"):
        return True  # Idempotent

    # Mark as revoked
    share["revokedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    share["revokedBy"] = revoked_by

    # Save updated share atomically
    atomic_write_json(_share_file(share_id), share)

    return True


def delete_share(share_id: str) -> bool:
    """
    Permanently delete a share link.

    Note: Prefer revoke_share() to maintain audit trail.

    Args:
        share_id: The share ID

    Returns:
        True if deleted, False if not found
    """
    share = get_share(share_id)
    if not share:
        return False

    # Remove from index
    _update_index_remove(share)

    # Delete file
    _share_file(share_id).unlink()

    return True


def rebuild_share_index() -> Dict[str, Any]:
    """
    Rebuild the share index from all share files.

    Useful if the index gets corrupted or out of sync.

    Returns:
        The rebuilt index
    """
    return _index.rebuild(SHARES_DIR, _index_entry_add)
