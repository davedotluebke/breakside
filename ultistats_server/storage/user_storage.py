"""
User storage module.

Users are authenticated via Supabase, but we store additional user data
(display name, admin status, etc.) in our own JSON files.

User data structure:
{
    "id": "uuid-from-supabase",      # Supabase auth.users.id
    "email": "user@example.com",     # From Supabase
    "displayName": "Coach Dave",     # User-editable
    "isAdmin": false,                # Global admin flag
    "createdAt": "2024-01-15T10:00:00Z",
    "updatedAt": "2024-01-15T10:00:00Z"
}
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional

# Import config
try:
    from config import USERS_DIR
except ImportError:
    from ultistats_server.config import USERS_DIR


def _user_file(user_id: str) -> Path:
    """Get the path to a user's JSON file."""
    return USERS_DIR / f"{user_id}.json"


def user_exists(user_id: str) -> bool:
    """Check if a user exists in our storage."""
    return _user_file(user_id).exists()


def get_user(user_id: str) -> Optional[Dict[str, Any]]:
    """
    Get a user by ID.
    
    Returns:
        User dict or None if not found
    """
    user_file = _user_file(user_id)
    if not user_file.exists():
        return None
    
    with open(user_file, "r") as f:
        return json.load(f)


def save_user(user_data: Dict[str, Any]) -> str:
    """
    Save a user to storage.
    
    Args:
        user_data: User dict with at least "id" and "email"
        
    Returns:
        The user ID
    """
    user_id = user_data.get("id")
    if not user_id:
        raise ValueError("User data must include 'id'")
    
    # Ensure required fields
    now = datetime.now().isoformat()
    user_data.setdefault("createdAt", now)
    user_data["updatedAt"] = now
    user_data.setdefault("isAdmin", False)
    user_data.setdefault("displayName", user_data.get("email", "").split("@")[0])
    
    # Ensure directory exists
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    
    with open(_user_file(user_id), "w") as f:
        json.dump(user_data, f, indent=2)
    
    return user_id


def create_or_update_user(user_id: str, email: str, display_name: Optional[str] = None) -> Dict[str, Any]:
    """
    Create a user if they don't exist, or update their email/display name if they do.
    
    This is called when a user authenticates - we sync their Supabase info
    with our local storage.
    
    Args:
        user_id: Supabase user ID
        email: User's email from Supabase
        display_name: Optional display name (uses email prefix if not provided)
        
    Returns:
        The user dict
    """
    existing = get_user(user_id)
    
    if existing:
        # Update email if changed
        if existing.get("email") != email:
            existing["email"] = email
            existing["updatedAt"] = datetime.now().isoformat()
            save_user(existing)
        return existing
    
    # Create new user
    user_data = {
        "id": user_id,
        "email": email,
        "displayName": display_name or email.split("@")[0],
        "isAdmin": False,
    }
    save_user(user_data)
    return get_user(user_id)


def update_user(user_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Update a user's data.
    
    Args:
        user_id: The user's ID
        updates: Dict of fields to update
        
    Returns:
        Updated user dict, or None if user doesn't exist
    """
    user = get_user(user_id)
    if not user:
        return None
    
    # Don't allow updating certain fields
    protected_fields = {"id", "createdAt"}
    for field in protected_fields:
        updates.pop(field, None)
    
    user.update(updates)
    user["updatedAt"] = datetime.now().isoformat()
    save_user(user)
    
    return user


def delete_user(user_id: str) -> bool:
    """
    Delete a user.
    
    Returns:
        True if deleted, False if user didn't exist
    """
    user_file = _user_file(user_id)
    if not user_file.exists():
        return False
    
    user_file.unlink()
    return True


def list_users() -> List[Dict[str, Any]]:
    """List all users."""
    users = []
    
    if not USERS_DIR.exists():
        return users
    
    for user_file in USERS_DIR.glob("*.json"):
        try:
            with open(user_file, "r") as f:
                users.append(json.load(f))
        except (json.JSONDecodeError, IOError):
            continue
    
    return users


def set_admin(user_id: str, is_admin: bool) -> Optional[Dict[str, Any]]:
    """
    Set or remove admin status for a user.
    
    Args:
        user_id: The user's ID
        is_admin: Whether the user should be an admin
        
    Returns:
        Updated user dict, or None if user doesn't exist
    """
    return update_user(user_id, {"isAdmin": is_admin})

