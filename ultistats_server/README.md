# Breakside Server

FastAPI backend for the Breakside ultimate frisbee statistics tracker.

## Features

- **Cloud Storage** - Sync games, teams, and players to the server
- **Automatic Versioning** - Every sync creates a timestamped backup
- **Offline-First** - PWA works fully offline, syncs when connected
- **Human-Readable Data** - All data stored as JSON files
- **Fast Sync** - ~25-50ms for typical game sync

## Quick Start

### Local Development

```bash
cd ultistats_server
pip install -r requirements.txt
python main.py
```

Server runs at http://localhost:8000

### API Documentation

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Configuration

Set via environment variables or in `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `ULTISTATS_DATA_DIR` | `/data` | Where game data is stored |
| `ULTISTATS_HOST` | `0.0.0.0` | Server bind address |
| `ULTISTATS_PORT` | `8000` | Server port |
| `ULTISTATS_DEBUG` | `false` | Enable debug mode |
| `ULTISTATS_ALLOWED_ORIGINS` | `*` | CORS allowed origins |

## API Overview

### Games
- `POST /api/games/{id}/sync` - Save/update a game
- `GET /api/games/{id}` - Get a game
- `GET /api/games` - List all games
- `DELETE /api/games/{id}` - Delete a game

### Teams & Players
- `POST /api/teams/{id}/sync` - Save/update a team
- `POST /api/players/{id}/sync` - Save/update a player
- `GET /api/teams`, `GET /api/players` - List all

### Utilities
- `GET /health` - Health check
- `POST /api/index/rebuild` - Rebuild search index

## Testing

```bash
# Health check
curl http://localhost:8000/health

# List games
curl http://localhost:8000/api/games

# Sync a game
curl -X POST http://localhost:8000/api/games/test-game/sync \
  -H "Content-Type: application/json" \
  -d '{"team": "My Team", "opponent": "Other Team"}'
```

## Production Deployment

The server is deployed on EC2 with nginx as a reverse proxy.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for:
- Full deployment architecture
- Server file structure
- Data directory layout
- Infrastructure details
- Quick reference commands
