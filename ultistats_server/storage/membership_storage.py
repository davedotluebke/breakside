"""
Team membership storage module.

Tracks which users have access to which teams and their role (coach/viewer).

Membership data structure:
{
    "id": "mem_abc123",
    "teamId": "Sample-Team-b2c4",
    "userId": "uuid-from-supabase",
    "role": "coach",                    # "coach" | "viewer"
    "invitedBy": "uuid-of-inviter",     # null if created team
    "joinedAt": "2024-01-15T10:00:00Z"
}

Storage: One JSON file per membership, stored as {membership_id}.json
Also maintain an index file for fast lookups by user or team.
"""

import json
import secrets
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional, Literal

from ._config import config
from .file_utils import atomic_write_json
from .json_index import JsonIndex, add_to_bucket, remove_from_bucket

MEMBERSHIPS_DIR = config.MEMBERSHIPS_DIR

# Index file for fast lookups
INDEX_FILE = MEMBERSHIPS_DIR / "_index.json"

# The JsonIndex serializes read-modify-write of the membership index so two
# concurrent membership changes can't each overwrite the other (dropping a
# membership). Path is a getter so tests can patch INDEX_FILE.
_index = JsonIndex(
    path_getter=lambda: INDEX_FILE,
    lock_key="membership-index",
    empty=lambda: {"byUser": {}, "byTeam": {}},
)


def _membership_file(membership_id: str) -> Path:
    """Get the path to a membership JSON file."""
    return MEMBERSHIPS_DIR / f"{membership_id}.json"


def _generate_membership_id() -> str:
    """Generate a unique membership ID."""
    return f"mem_{secrets.token_hex(6)}"


def _index_entry_add(index: Dict[str, Any], membership: Dict[str, Any]) -> None:
    """Record one membership in the index (byUser + byTeam)."""
    add_to_bucket(index, "byUser", membership["userId"], membership["id"])
    add_to_bucket(index, "byTeam", membership["teamId"], membership["id"])


def _update_index_add(membership: Dict[str, Any]) -> None:
    """Add a membership to the index (serialized read-modify-write)."""
    with _index.update() as index:
        _index_entry_add(index, membership)


def _update_index_remove(membership: Dict[str, Any]) -> None:
    """Remove a membership from the index (serialized read-modify-write)."""
    with _index.update() as index:
        remove_from_bucket(index, "byUser", membership["userId"], membership["id"])
        remove_from_bucket(index, "byTeam", membership["teamId"], membership["id"])


def membership_exists(membership_id: str) -> bool:
    """Check if a membership exists."""
    return _membership_file(membership_id).exists()


def get_membership(membership_id: str) -> Optional[Dict[str, Any]]:
    """Get a membership by ID."""
    mem_file = _membership_file(membership_id)
    if not mem_file.exists():
        return None

    with open(mem_file, "r") as f:
        return json.load(f)


def create_membership(
    team_id: str,
    user_id: str,
    role: Literal["coach", "viewer"],
    invited_by: Optional[str] = None
) -> Dict[str, Any]:
    """
    Create a new team membership.

    Args:
        team_id: The team ID
        user_id: The user ID
        role: Either "coach" or "viewer"
        invited_by: User ID of who sent the invite (null if creator)

    Returns:
        The created membership

    Raises:
        ValueError: If user already has a membership for this team
    """
    # Check if membership already exists
    existing = get_user_team_membership(user_id, team_id)
    if existing:
        raise ValueError(f"User {user_id} already has membership for team {team_id}")

    membership = {
        "id": _generate_membership_id(),
        "teamId": team_id,
        "userId": user_id,
        "role": role,
        "invitedBy": invited_by,
        "joinedAt": datetime.now().isoformat(),
    }

    # Ensure directory exists
    MEMBERSHIPS_DIR.mkdir(parents=True, exist_ok=True)

    atomic_write_json(_membership_file(membership["id"]), membership)

    _update_index_add(membership)

    return membership


def update_membership_role(
    membership_id: str,
    new_role: Literal["coach", "viewer"]
) -> Optional[Dict[str, Any]]:
    """
    Update a membership's role.

    Returns:
        Updated membership, or None if not found
    """
    membership = get_membership(membership_id)
    if not membership:
        return None

    membership["role"] = new_role

    atomic_write_json(_membership_file(membership_id), membership)

    return membership


def delete_membership(membership_id: str) -> bool:
    """
    Delete a membership.

    Returns:
        True if deleted, False if not found
    """
    membership = get_membership(membership_id)
    if not membership:
        return False

    _update_index_remove(membership)
    _membership_file(membership_id).unlink()

    return True


def get_user_memberships(user_id: str) -> List[Dict[str, Any]]:
    """Get all team memberships for a user."""
    index = _index.load()
    membership_ids = index.get("byUser", {}).get(user_id, [])

    memberships = []
    for mem_id in membership_ids:
        membership = get_membership(mem_id)
        if membership:
            memberships.append(membership)

    return memberships


def get_team_memberships(team_id: str) -> List[Dict[str, Any]]:
    """Get all memberships for a team."""
    index = _index.load()
    membership_ids = index.get("byTeam", {}).get(team_id, [])

    memberships = []
    for mem_id in membership_ids:
        membership = get_membership(mem_id)
        if membership:
            memberships.append(membership)

    return memberships


def get_user_team_membership(user_id: str, team_id: str) -> Optional[Dict[str, Any]]:
    """
    Get a user's membership for a specific team.

    Returns:
        Membership dict or None if no membership exists
    """
    user_memberships = get_user_memberships(user_id)
    for membership in user_memberships:
        if membership["teamId"] == team_id:
            return membership
    return None


def get_user_team_role(user_id: str, team_id: str) -> Optional[str]:
    """
    Get a user's role for a specific team.

    Returns:
        "coach", "viewer", or None if no membership
    """
    membership = get_user_team_membership(user_id, team_id)
    return membership["role"] if membership else None


def get_user_teams(user_id: str) -> List[str]:
    """Get all team IDs a user has access to."""
    memberships = get_user_memberships(user_id)
    return [m["teamId"] for m in memberships]


def get_team_coaches(team_id: str) -> List[str]:
    """Get all user IDs who are coaches for a team."""
    memberships = get_team_memberships(team_id)
    return [m["userId"] for m in memberships if m["role"] == "coach"]


def get_team_viewers(team_id: str) -> List[str]:
    """Get all user IDs who are viewers for a team."""
    memberships = get_team_memberships(team_id)
    return [m["userId"] for m in memberships if m["role"] == "viewer"]


def rebuild_membership_index() -> Dict[str, Any]:
    """
    Rebuild the membership index from all membership files.

    Useful if the index gets corrupted or out of sync.

    Returns:
        The rebuilt index
    """
    return _index.rebuild(MEMBERSHIPS_DIR, _index_entry_add)
