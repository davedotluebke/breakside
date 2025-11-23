# Ultistats Server

Python FastAPI server for the Ultistats application, providing Google Sheets-based cloud storage and real-time synchronization.

## Setup

### 1. Install Dependencies

```bash
cd ultistats_server
pip install -r requirements.txt
```

### 2. Configure Google Sheets API

1. Create a Google Cloud Project (or use existing one)
2. Enable the Google Sheets API
3. Create a Service Account and download the JSON key file
4. Place the JSON key file in the parent directory (or specify path via `SERVICE_ACCOUNT_FILE` env var)
5. Share your Google Spreadsheet with the service account email address

### 3. Set Environment Variables

Create a `.env` file or set environment variables:

```bash
# Required
SPREADSHEET_ID=your_spreadsheet_id_here
SERVICE_ACCOUNT_FILE=path/to/service-account.json
SECRET_KEY=your_secret_key_here  # For JWT tokens

# Optional
HOST=0.0.0.0
PORT=8000
DEBUG=False
```

Or set them in `config.py` directly (not recommended for production).

### 4. Initialize Spreadsheet

Run the setup script to create the initial spreadsheet structure:

```bash
python3 setup_spreadsheet.py <SPREADSHEET_ID>
```

This creates:
- **Teams** sheet - Team metadata
- **Players** sheet - All players across teams
- **Games** sheet - Game metadata
- **Users** sheet - User authentication data

### 5. Test Basic Operations

Test that everything is working:

```bash
python3 test_basic_operations.py <SPREADSHEET_ID>
```

## Project Structure

```
ultistats_server/
├── main.py                    # FastAPI application (to be created)
├── config.py                  # Configuration settings
├── requirements.txt           # Python dependencies
├── setup_spreadsheet.py       # Spreadsheet initialization script
├── test_basic_operations.py   # Basic operations test script
├── auth/                      # Authentication modules
│   ├── models.py             # User models and JWT handling
│   └── routes.py             # Auth endpoints
├── sheets/                    # Google Sheets integration
│   ├── service.py            # SheetsService class
│   ├── operations.py         # CRUD operations (to be created)
│   └── serialization.py      # Game data serialization
└── websocket/                 # WebSocket handlers (to be created)
    └── handlers.py           # Real-time update handlers
```

## Development

### Running the Server

```bash
# Development mode with auto-reload
uvicorn ultistats_server.main:app --reload --host 0.0.0.0 --port 8000
```

### Testing

```bash
# Test serialization
python3 test_serialization.py

# Test with real game data
python3 test_real_game.py ~/path/to/teamData.json

# Test all games
python3 test_all_games.py ~/path/to/teamData.json

# Test basic Sheets operations
python3 test_basic_operations.py <SPREADSHEET_ID>
```

## Next Steps

- [ ] Implement `sheets/operations.py` for Teams, Players, Games CRUD
- [ ] Implement REST API endpoints in `main.py`
- [ ] Implement WebSocket handlers for real-time updates
- [ ] Deploy to EC2 instance

## Notes

- The service account JSON file should be kept secure and never committed to git
- Use environment variables for sensitive configuration in production
- The spreadsheet must be shared with the service account email for access

