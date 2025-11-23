"""
Configuration settings for the License Plate Game server.
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
SPREADSHEET_ID = "1I_mlDRKCEr2djnrm-URaSgIk4yZ_D2NwygMr8TaJ9kw"
SERVICE_ACCOUNT_FILE = os.path.join(BASE_DIR.parent, "license-plate-game-database-bf652bd0aac4.json")
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