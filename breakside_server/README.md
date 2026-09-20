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
cd breakside_server
pip install -r requirements.txt
python main.py
```

Server runs at http://localhost:8000

### API Documentation

The interactive docs are development-only — they are served only when
`BREAKSIDE_DEBUG=true`, and return 404 otherwise (production must not publish
a map of every endpoint). Start the server with the flag to use them:

```bash
BREAKSIDE_DEBUG=true python main.py
```

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc
- OpenAPI schema: http://localhost:8000/openapi.json

## Configuration

Set via environment variables or in `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `BREAKSIDE_DATA_DIR` | `/data` | Where game data is stored |
| `BREAKSIDE_HOST` | `0.0.0.0` | Server bind address |
| `BREAKSIDE_PORT` | `8000` | Server port |
| `BREAKSIDE_DEBUG` | `false` | Enable debug mode |
| `BREAKSIDE_ALLOWED_ORIGINS` | `*` | CORS allowed origins |
| `BREAKSIDE_MAIL_TRANSPORT` | `none` | Team mailing lists: `ses`, `file` (outbox dir, for dev/tests) or `none` |
| `BREAKSIDE_MAIL_DOMAIN` | `team.breakside.pro` | Domain the list addresses live at |
| `BREAKSIDE_MAIL_QUEUE_URL` | | SQS queue fed by SES receiving; the inbound poller runs only when set (with `ses`) |
| `BREAKSIDE_MAIL_INBOUND_BUCKET` | | S3 bucket SES stores received mail in |
| `BREAKSIDE_MAIL_CONFIGURATION_SET` | | SES configuration set stamped on every send (reject events; bounces and complaints arrive as identity notifications) |
| `BREAKSIDE_MAIL_REGION` | `us-east-1` | AWS region for SES/S3/SQS |

These were prefixed `ULTISTATS_` until the project settled on its name
(renamed 2026-09-03). `config.py` accepted both for one release; that
fallback is gone, so an environment still setting an `ULTISTATS_` name gets
the *default* rather than its configured value — silently, since an unset
`BREAKSIDE_DATA_DIR` falls back to a relative path and the API comes up
healthy on an empty dataset.

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
