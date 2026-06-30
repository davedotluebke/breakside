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
EVENTS_DIR = DATA_DIR / "events"
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
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
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
def auth_required() -> bool:
    """Single source of truth for whether the API enforces authentication.

    Defaults to TRUE (secure by default). The ONLY supported way to disable
    auth is to explicitly set ``ULTISTATS_AUTH_REQUIRED=false`` — which local
    dev / agent tooling does (see ``scripts/dev-backend.sh``) and production
    never does.

    Read at call time (not frozen at import) so tests and dev servers can
    toggle the env var at runtime. Every per-request guard MUST call this
    rather than re-reading ``os.getenv`` with its own default — previously
    ``config.py`` defaulted ``false`` while the guards defaulted ``true``, so
    whether the API was open depended on which layer you looked at.
    """
    return os.getenv("ULTISTATS_AUTH_REQUIRED", "true").lower() == "true"


# Backwards-compatible module constant, evaluated once at import. Prefer
# ``auth_required()`` for per-request checks so a runtime env change is seen.
AUTH_REQUIRED = auth_required()

# =============================================================================
# AI Narration (speech-to-events)
# =============================================================================
# OpenAI is used for the fast pass (Realtime API ephemeral tokens + streaming
# ASR / function-calling). Anthropic is used for the optional slow pass that
# reviews the full transcript and issues corrections. If ANTHROPIC_API_KEY is
# empty, the slow pass is skipped and all provisional events are confirmed.
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
NARRATION_SLOW_MODEL = os.getenv("NARRATION_SLOW_MODEL", "claude-sonnet-4-5-20250929")
