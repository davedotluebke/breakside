"""
Configuration for Ultistats server.
"""
import os
from pathlib import Path

# Data directory - can be overridden via environment variable
# Default to local 'data' directory for development
_default_data_dir = Path(__file__).parent.parent / "data"
DATA_DIR = Path(os.getenv("ULTISTATS_DATA_DIR", str(_default_data_dir)))
GAMES_DIR = DATA_DIR / "games"
TEAMS_DIR = DATA_DIR / "teams"
PLAYERS_DIR = DATA_DIR / "players"
USERS_DIR = DATA_DIR / "users"
MEMBERSHIPS_DIR = DATA_DIR / "memberships"
INVITES_DIR = DATA_DIR / "invites"
SHARES_DIR = DATA_DIR / "shares"
SESSIONS_DIR = DATA_DIR / "sessions"
INDEX_FILE = DATA_DIR / "index.json"

# Ensure data directories exist (only if we have write permissions)
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    GAMES_DIR.mkdir(parents=True, exist_ok=True)
    TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    PLAYERS_DIR.mkdir(parents=True, exist_ok=True)
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    MEMBERSHIPS_DIR.mkdir(parents=True, exist_ok=True)
    INVITES_DIR.mkdir(parents=True, exist_ok=True)
    SHARES_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
except (OSError, PermissionError):
    # Will be created when first entity is saved
    pass

# Server configuration
HOST = os.getenv("ULTISTATS_HOST", "0.0.0.0")
PORT = int(os.getenv("ULTISTATS_PORT", "8000"))
DEBUG = os.getenv("ULTISTATS_DEBUG", "False").lower() == "true"

# =============================================================================
# Supabase Authentication
# =============================================================================
# Get these from your Supabase project: Settings -> API
SUPABASE_URL = os.getenv("SUPABASE_URL", "")  # e.g., "https://abcdefgh.supabase.co"
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")  # Public anon key (safe for client)
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")  # Secret service key (server only)
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")  # JWT secret for token verification

# Legacy auth settings (kept for potential future use)
SECRET_KEY = os.getenv("ULTISTATS_SECRET_KEY", "change-me-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24 * 7  # 7 days

# CORS
ALLOWED_ORIGINS = os.getenv("ULTISTATS_ALLOWED_ORIGINS", "*").split(",")

# Git versioning (optional)
ENABLE_GIT_VERSIONING = os.getenv("ULTISTATS_ENABLE_GIT_VERSIONING", "false").lower() == "true"

# =============================================================================
# Feature flags
# =============================================================================
# Set to True to require authentication for all API endpoints
# Set to False to allow anonymous access (useful during development/migration)
AUTH_REQUIRED = os.getenv("ULTISTATS_AUTH_REQUIRED", "false").lower() == "true"
