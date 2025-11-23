"""
Configuration settings for the Ultistats server.
"""
import os
from pathlib import Path

# Base directory
BASE_DIR = Path(__file__).resolve().parent

# Server settings
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
DEBUG = os.getenv("DEBUG", "False").lower() == "true"

# Google API settings
# For testing, reuse the license plate game spreadsheet and service account
# In production, set these via environment variables
SPREADSHEET_ID = os.getenv(
    "SPREADSHEET_ID",
    "1I_mlDRKCEr2djnrm-URaSgIk4yZ_D2NwygMr8TaJ9kw"  # License plate game spreadsheet for testing
)
# Service account file path - check multiple possible locations
# First check parent directory (where license_plate_server expects it)
# Then check sibling license-plate-game directory
_license_plate_service_account_1 = os.path.join(BASE_DIR.parent, "license-plate-game-database-bf652bd0aac4.json")
_license_plate_service_account_2 = os.path.join(BASE_DIR.parent.parent, "license-plate-game", "license-plate-game-database-bf652bd0aac4.json")
_license_plate_service_account = _license_plate_service_account_1 if os.path.exists(_license_plate_service_account_1) else _license_plate_service_account_2

SERVICE_ACCOUNT_FILE = os.getenv(
    "SERVICE_ACCOUNT_FILE",
    _license_plate_service_account if os.path.exists(_license_plate_service_account) else ""
)
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

# Security settings
SECRET_KEY = os.getenv("SECRET_KEY")  # Must be set as an environment variable in production
if not SECRET_KEY and DEBUG:
    import secrets
    SECRET_KEY = secrets.token_hex(32)  # Generate a random key only in debug mode
elif not SECRET_KEY:
    raise ValueError("SECRET_KEY environment variable must be set in production")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 1 week

# Rate limiting
RATE_LIMIT_PER_MINUTE = 60

