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
USERS_DIR = DATA_DIR / "users"

# Ensure data directories exist (only if we have write permissions)
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    GAMES_DIR.mkdir(parents=True, exist_ok=True)
    TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    USERS_DIR.mkdir(parents=True, exist_ok=True)
except (OSError, PermissionError):
    # Will be created when first game is saved
    pass

# Server configuration
HOST = os.getenv("ULTISTATS_HOST", "0.0.0.0")
PORT = int(os.getenv("ULTISTATS_PORT", "8000"))
DEBUG = os.getenv("ULTISTATS_DEBUG", "False").lower() == "true"

# Authentication
SECRET_KEY = os.getenv("ULTISTATS_SECRET_KEY", "change-me-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24 * 7  # 7 days

# CORS
ALLOWED_ORIGINS = os.getenv("ULTISTATS_ALLOWED_ORIGINS", "*").split(",")

# Git versioning (optional)
ENABLE_GIT_VERSIONING = os.getenv("ULTISTATS_ENABLE_GIT_VERSIONING", "false").lower() == "true"
