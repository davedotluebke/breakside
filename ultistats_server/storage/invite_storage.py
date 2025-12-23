"""
Team invite storage module.

Manages invite codes that allow users to join teams as coaches or viewers.

Invite data structure:
{
    "id": "inv_abc123def456",
    "code": "X7K2M",                   # 5-char human-friendly code
    "teamId": "Sample-Team-b2c4",
    "role": "coach",                   # "coach" | "viewer"
    "createdBy": "user-uuid",
    "createdAt": "2025-01-15T10:00:00Z",
    "expiresAt": "2025-01-22T10:00:00Z",
    "maxUses": 1,                      # null = unlimited
    "uses": 0,
    "usedBy": [                        # Audit trail
        {"userId": "user-xyz", "usedAt": "2025-01-16T14:30:00Z"}
    ],
    "revokedAt": null,
    "revokedBy": null
}

Storage: One JSON file per invite, stored as {invite_id}.json
Also maintain an index file for fast lookups by code and team.
"""

import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional, Literal

# Import config
try:
    from config import INVITES_DIR
except ImportError:
    from ultistats_server.config import INVITES_DIR

# Import membership storage for redemption
try:
    from storage.membership_storage import (
        create_membership,
        get_user_team_membership,
    )
except ImportError:
    from ultistats_server.storage.membership_storage import (
        create_membership,
        get_user_team_membership,
    )


# Human-friendly alphabet (no 0/O/1/I/L)
INVITE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
INVITE_CODE_LENGTH = 5

# Index file for fast lookups
INDEX_FILE = INVITES_DIR / "_index.json"


def _invite_file(invite_id: str) -> Path:
    """Get the path to an invite JSON file."""
    return INVITES_DIR / f"{invite_id}.json"


def _generate_invite_id() -> str:
    """Generate a unique invite ID."""
    return f"inv_{secrets.token_hex(6)}"


def generate_invite_code() -> str:
    """
    Generate a 5-character human-friendly invite code.
    
    Uses a 32-character alphabet, giving 32^5 ≈ 33 million possible codes.
    Codes are case-insensitive but generated uppercase.
    """
    return ''.join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_CODE_LENGTH))


def _load_index() -> Dict[str, Any]:
    """Load the invite index."""
    if not INDEX_FILE.exists():
        return {"byCode": {}, "byTeam": {}}
    
    try:
        with open(INDEX_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {"byCode": {}, "byTeam": {}}


def _save_index(index: Dict[str, Any]) -> None:
    """Save the invite index."""
    INVITES_DIR.mkdir(parents=True, exist_ok=True)
    with open(INDEX_FILE, "w") as f:
        json.dump(index, f, indent=2)


def _update_index_add(invite: Dict[str, Any]) -> None:
    """Add an invite to the index."""
    index = _load_index()
    
    invite_id = invite["id"]
    code = invite["code"]
    team_id = invite["teamId"]
    
    # Add to code index (uppercase for case-insensitive lookup)
    index["byCode"][code.upper()] = invite_id
    
    # Add to team index
    if team_id not in index["byTeam"]:
        index["byTeam"][team_id] = []
    if invite_id not in index["byTeam"][team_id]:
        index["byTeam"][team_id].append(invite_id)
    
    _save_index(index)


def _update_index_remove(invite: Dict[str, Any]) -> None:
    """Remove an invite from the index."""
    index = _load_index()
    
    invite_id = invite["id"]
    code = invite["code"]
    team_id = invite["teamId"]
    
    # Remove from code index
    if code.upper() in index["byCode"]:
        del index["byCode"][code.upper()]
    
    # Remove from team index
    if team_id in index["byTeam"]:
        index["byTeam"][team_id] = [i for i in index["byTeam"][team_id] if i != invite_id]
        if not index["byTeam"][team_id]:
            del index["byTeam"][team_id]
    
    _save_index(index)


def invite_exists(invite_id: str) -> bool:
    """Check if an invite exists."""
    return _invite_file(invite_id).exists()


def get_invite(invite_id: str) -> Optional[Dict[str, Any]]:
    """Get an invite by ID."""
    invite_file = _invite_file(invite_id)
    if not invite_file.exists():
        return None
    
    with open(invite_file, "r") as f:
        return json.load(f)


def get_invite_by_code(code: str) -> Optional[Dict[str, Any]]:
    """
    Look up an invite by its shareable code (case-insensitive).
    
    Args:
        code: The 5-character invite code
        
    Returns:
        Invite dict or None if not found
    """
    index = _load_index()
    invite_id = index.get("byCode", {}).get(code.upper())
    
    if not invite_id:
        return None
    
    return get_invite(invite_id)


def is_invite_valid(invite: Dict[str, Any]) -> bool:
    """
    Check if an invite is currently valid (not expired, not revoked, not at max uses).
    
    Args:
        invite: The invite dict
        
    Returns:
        True if the invite is valid for use
    """
    # Check if revoked
    if invite.get("revokedAt"):
        return False
    
    # Check if expired
    expires_at = invite.get("expiresAt")
    if expires_at:
        try:
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) > expiry:
                return False
        except (ValueError, TypeError):
            # If we can't parse the date, treat as expired for safety
            return False
    
    # Check max uses
    max_uses = invite.get("maxUses")
    if max_uses is not None:
        if invite.get("uses", 0) >= max_uses:
            return False
    
    return True


def get_invite_validity_reason(invite: Dict[str, Any]) -> Optional[str]:
    """
    Get the reason an invite is invalid.
    
    Args:
        invite: The invite dict
        
    Returns:
        Reason string if invalid, None if valid
    """
    if invite.get("revokedAt"):
        return "revoked"
    
    expires_at = invite.get("expiresAt")
    if expires_at:
        try:
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) > expiry:
                return "expired"
        except (ValueError, TypeError):
            return "expired"
    
    max_uses = invite.get("maxUses")
    if max_uses is not None:
        if invite.get("uses", 0) >= max_uses:
            return "max_uses"
    
    return None


def create_invite(
    team_id: str,
    role: Literal["coach", "viewer"],
    created_by: str,
    expires_days: Optional[int] = None,
    max_uses: Optional[int] = None
) -> Dict[str, Any]:
    """
    Create a new invite for a team.
    
    Args:
        team_id: The team ID
        role: Either "coach" or "viewer"
        created_by: User ID of who created the invite
        expires_days: Days until expiration (None uses defaults: 7 for coach, 30 for viewer)
        max_uses: Max number of times the invite can be used (None = unlimited)
        
    Returns:
        The created invite
    """
    now = datetime.now(timezone.utc)
    
    # Set defaults based on role
    if expires_days is None:
        expires_days = 7 if role == "coach" else 30
    
    if max_uses is None and role == "coach":
        max_uses = 1  # Coach invites are single-use by default
    
    # Calculate expiry
    expires_at = None
    if expires_days > 0:
        expires_at = (now + timedelta(days=expires_days)).isoformat().replace("+00:00", "Z")
    
    # Generate unique code (retry if collision)
    code = generate_invite_code()
    while get_invite_by_code(code) is not None:
        code = generate_invite_code()
    
    invite = {
        "id": _generate_invite_id(),
        "code": code,
        "teamId": team_id,
        "role": role,
        "createdBy": created_by,
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        "expiresAt": expires_at,
        "maxUses": max_uses,
        "uses": 0,
        "usedBy": [],
        "revokedAt": None,
        "revokedBy": None,
    }
    
    # Ensure directory exists
    INVITES_DIR.mkdir(parents=True, exist_ok=True)
    
    # Save invite file
    with open(_invite_file(invite["id"]), "w") as f:
        json.dump(invite, f, indent=2)
    
    # Update index
    _update_index_add(invite)
    
    return invite


def list_team_invites(team_id: str) -> List[Dict[str, Any]]:
    """
    List all invites for a team (including expired/revoked).
    
    Args:
        team_id: The team ID
        
    Returns:
        List of invite dicts, sorted by creation date (newest first)
    """
    index = _load_index()
    invite_ids = index.get("byTeam", {}).get(team_id, [])
    
    invites = []
    for invite_id in invite_ids:
        invite = get_invite(invite_id)
        if invite:
            invites.append(invite)
    
    # Sort by creation date, newest first
    invites.sort(key=lambda i: i.get("createdAt", ""), reverse=True)
    
    return invites


def redeem_invite(code: str, user_id: str) -> Dict[str, Any]:
    """
    Redeem an invite code.
    
    Creates a team membership for the user if the invite is valid.
    
    Args:
        code: The invite code (case-insensitive)
        user_id: The user ID redeeming the invite
        
    Returns:
        {"success": True, "membership": {...}} on success
        {"success": False, "error": "...", "reason": "..."} on failure
    """
    invite = get_invite_by_code(code)
    
    if not invite:
        return {"success": False, "error": "Invite not found", "reason": "not_found"}
    
    # Check validity
    reason = get_invite_validity_reason(invite)
    if reason:
        error_messages = {
            "revoked": "This invite has been revoked",
            "expired": "This invite has expired",
            "max_uses": "This invite has already been used",
        }
        return {
            "success": False, 
            "error": error_messages.get(reason, "Invite is no longer valid"),
            "reason": reason
        }
    
    # Check if user is already a member
    existing = get_user_team_membership(user_id, invite["teamId"])
    if existing:
        return {
            "success": False,
            "error": "You're already a member of this team",
            "reason": "already_member"
        }
    
    # Create membership
    try:
        membership = create_membership(
            team_id=invite["teamId"],
            user_id=user_id,
            role=invite["role"],
            invited_by=invite["createdBy"]
        )
    except ValueError as e:
        return {"success": False, "error": str(e), "reason": "membership_error"}
    
    # Update invite usage
    invite["uses"] = invite.get("uses", 0) + 1
    invite["usedBy"].append({
        "userId": user_id,
        "usedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    })
    
    # Save updated invite
    with open(_invite_file(invite["id"]), "w") as f:
        json.dump(invite, f, indent=2)
    
    return {"success": True, "membership": membership}


def revoke_invite(invite_id: str, revoked_by: str) -> bool:
    """
    Revoke an invite.
    
    Args:
        invite_id: The invite ID
        revoked_by: User ID of who revoked it
        
    Returns:
        True if invite was found and revoked, False if not found
    """
    invite = get_invite(invite_id)
    if not invite:
        return False
    
    # Already revoked?
    if invite.get("revokedAt"):
        return True  # Idempotent
    
    # Mark as revoked
    invite["revokedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    invite["revokedBy"] = revoked_by
    
    # Save updated invite
    with open(_invite_file(invite_id), "w") as f:
        json.dump(invite, f, indent=2)
    
    return True


def delete_invite(invite_id: str) -> bool:
    """
    Permanently delete an invite.
    
    Note: Prefer revoke_invite() to maintain audit trail.
    
    Args:
        invite_id: The invite ID
        
    Returns:
        True if deleted, False if not found
    """
    invite = get_invite(invite_id)
    if not invite:
        return False
    
    # Remove from index
    _update_index_remove(invite)
    
    # Delete file
    _invite_file(invite_id).unlink()
    
    return True


def rebuild_invite_index() -> Dict[str, Any]:
    """
    Rebuild the invite index from all invite files.
    
    Useful if the index gets corrupted or out of sync.
    
    Returns:
        The rebuilt index
    """
    index = {"byCode": {}, "byTeam": {}}
    
    if not INVITES_DIR.exists():
        _save_index(index)
        return index
    
    for invite_file in INVITES_DIR.glob("*.json"):
        if invite_file.name.startswith("_"):
            continue  # Skip index file
        
        try:
            with open(invite_file, "r") as f:
                invite = json.load(f)
            
            invite_id = invite["id"]
            code = invite["code"]
            team_id = invite["teamId"]
            
            # Add to code index
            index["byCode"][code.upper()] = invite_id
            
            # Add to team index
            if team_id not in index["byTeam"]:
                index["byTeam"][team_id] = []
            index["byTeam"][team_id].append(invite_id)
            
        except (json.JSONDecodeError, IOError, KeyError):
            continue
    
    _save_index(index)
    return index

