# Ultistats Server - JSON File Backend

Python FastAPI server for the Ultistats application, providing JSON file-based cloud storage with versioning.

## Features

- **JSON File Storage**: Simple, human-readable game storage
- **Automatic Versioning**: Every sync creates a timestamped version
- **Git Integration**: Optional git-based versioning for full history
- **Full Game Sync**: Stateless sync of complete game state
- **Fast Performance**: ~25-50ms sync time for typical games

## Setup

### 1. Install Dependencies

```bash
cd ultistats_server
pip install -r requirements.txt
```

### 2. Configure Data Directory

Set the data directory via environment variable (defaults to `/data`):

```bash
export ULTISTATS_DATA_DIR=/path/to/data
```

Or set in `config.py` directly.

### 3. Set Environment Variables (Optional)

```bash
# Server configuration
export ULTISTATS_HOST=0.0.0.0
export ULTISTATS_PORT=8000
export ULTISTATS_DEBUG=false

# Authentication (for future use)
export ULTISTATS_SECRET_KEY=your-secret-key-here

# CORS
export ULTISTATS_ALLOWED_ORIGINS=http://localhost:3000,https://yourdomain.com

# Git versioning (optional)
export ULTISTATS_ENABLE_GIT_VERSIONING=true
```

### 4. Run Server

```bash
python3 main.py
```

Or with uvicorn directly:

```bash
uvicorn ultistats_server.main:app --host 0.0.0.0 --port 8000
```

## API Endpoints

### Games

- `POST /games/{game_id}/sync` - Sync complete game state
- `GET /games/{game_id}` - Get current game state
- `GET /games` - List all games
- `DELETE /games/{game_id}` - Delete game

### Versions

- `GET /games/{game_id}/versions` - List all versions
- `GET /games/{game_id}/versions/{timestamp}` - Get specific version
- `POST /games/{game_id}/restore/{timestamp}` - Restore to version

## Data Structure

```
/data/
  games/
    {game_id}/
      current.json          # Latest version
      versions/
        2024-01-15T10-30-45.json
        2024-01-15T10-35-12.json
      .git/                 # Optional git repo
```

## Testing

Test the API with curl:

```bash
# Sync a game
curl -X POST http://localhost:8000/games/test-game-123/sync \
  -H "Content-Type: application/json" \
  -d @game_data.json

# Get game
curl http://localhost:8000/games/test-game-123

# List versions
curl http://localhost:8000/games/test-game-123/versions
```

## Development

The server uses FastAPI with automatic API documentation:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc
