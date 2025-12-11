# Breakside Architecture

This document describes the technical architecture of the Breakside ultimate frisbee statistics tracker.

## System Overview

Breakside uses a hybrid architecture with a Progressive Web App (PWA) frontend hosted on CloudFront/S3 and a FastAPI backend on EC2.

```
                              USERS
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
   breakside.pro          www.breakside.pro      api.breakside.pro
   (apex domain)                                        
         │                      │                      │
         ▼                      ▼                      ▼
   EC2 / nginx              CloudFront             EC2 / nginx
   (301 redirect)             (CDN)                 (proxy)
         │                      │                      │
         └──────────────►  S3 Bucket              FastAPI
                          (PWA + Viewer)         (port 8000)
```

### Live URLs

| Service | URL | Hosted On |
|---------|-----|-----------|
| **PWA** | https://www.breakside.pro | CloudFront → S3 |
| **PWA (redirect)** | https://breakside.pro | EC2 → www |
| **Static Viewer** | https://www.breakside.pro/viewer/ | CloudFront → S3 |
| **API** | https://api.breakside.pro | EC2 → FastAPI |
| **Health Check** | https://api.breakside.pro/health | EC2 |

---

## Frontend Architecture

### PWA Structure

The frontend is a vanilla JavaScript Progressive Web App with no framework dependencies.

```
ultistats/
├── index.html              # Main HTML entry point
├── main.js                 # Application bootstrap (~200 lines)
├── main.css                # Application styles
├── manifest.json           # PWA manifest
├── service-worker.js       # Service worker for offline functionality
├── version.json            # Version tracking
│
├── store/                   # Data layer
│   ├── models.js           # Data structure definitions (Player, Game, Team, etc.)
│   ├── storage.js          # Serialization/deserialization and local storage
│   └── sync.js             # Server synchronization logic
│
├── utils/                   # Utility functions
│   ├── helpers.js          # Pure utility functions and state accessors
│   └── statistics.js       # Statistics calculation and game summaries
│
├── screens/                 # Screen management
│   └── navigation.js       # Screen navigation and state management
│
├── teams/                   # Team management
│   ├── teamSelection.js    # Team selection and team CRUD operations
│   └── rosterManagement.js # Roster display, player and line management
│
├── game/                    # Game core logic
│   ├── gameLogic.js        # Game initialization, scoring, undo
│   ├── pointManagement.js  # Point creation, timing, transitions
│   ├── beforePointScreen.js# Player selection and line management
│   └── genderRatioDropdown.js # Gender ratio rule selection
│
├── playByPlay/              # Play-by-play tracking
│   ├── offenseScreen.js    # Offensive possession tracking
│   ├── defenseScreen.js    # Defensive possession tracking
│   ├── simpleModeScreen.js # Simple mode scoring
│   ├── keyPlayDialog.js    # Key play recording dialog
│   └── pullDialog.js       # Pull tracking dialog
│
├── ui/                      # UI components
│   ├── activePlayersDisplay.js # Active players table
│   ├── eventLogDisplay.js   # Event log management
│   └── buttonLayout.js      # UI consistency functions
│
└── images/                  # App icons and logos
    ├── logo.png            # Full logo with text
    ├── logo.disc.only.png  # Icon-only logo
    └── favicon-*.png       # Various favicon sizes
```

### Module Loading

- Modules are loaded in order via `<script>` tags in `index.html`
- Data layer (`store/`) loads first, followed by utilities, then feature modules
- Global state is managed through shared variables in `store/storage.js`
- No circular dependencies - clear data flow: data → utils → features → UI

### Offline Support

The service worker implements a network-first strategy with cache fallback:

1. Try network request first
2. On success, cache the response
3. On failure (or timeout), serve from cache
4. API calls to `api.breakside.pro` are never cached

---

## Backend Architecture

### Server Stack

| Component | Details |
|-----------|---------|
| **Runtime** | Python 3.8 with venv |
| **Framework** | FastAPI with uvicorn |
| **Web Server** | nginx (reverse proxy, SSL termination) |
| **Process Manager** | systemd |
| **Data Storage** | JSON files on filesystem |
| **SSL** | Let's Encrypt (certbot) |

### Server File Structure

```
ultistats_server/
├── main.py              # FastAPI application and routes
├── config.py            # Configuration from environment variables
├── requirements.txt     # Python dependencies
│
├── storage/             # Data storage layer
│   ├── __init__.py
│   ├── game_storage.py  # Game CRUD operations
│   ├── team_storage.py  # Team CRUD operations
│   ├── player_storage.py# Player CRUD operations
│   └── index_storage.py # Cross-entity index management
│
├── static/
│   └── viewer/          # Static game viewer
│       ├── index.html
│       ├── viewer.js
│       └── viewer.css
│
└── auth/                # Authentication (future)
    └── __init__.py
```

### Data Directory Structure

```
/var/lib/breakside/data/
├── games/
│   └── {game_id}/
│       ├── current.json      # Latest game state
│       └── versions/         # Historical versions
│           ├── 2024-01-15T10-30-45.json
│           └── 2024-01-15T10-35-12.json
├── teams/
│   └── {team_id}.json
├── players/
│   └── {player_id}.json
├── users/                    # Future: user accounts
└── index.json                # Cross-entity index
```

### API Endpoints

#### Games
- `POST /api/games/{game_id}/sync` - Sync complete game state
- `GET /api/games/{game_id}` - Get current game state
- `GET /api/games` - List all games
- `DELETE /api/games/{game_id}` - Delete game

#### Teams
- `POST /api/teams/{team_id}/sync` - Sync team data
- `GET /api/teams/{team_id}` - Get team
- `GET /api/teams` - List all teams

#### Players
- `POST /api/players/{player_id}/sync` - Sync player data
- `GET /api/players/{player_id}` - Get player
- `GET /api/players` - List all players

#### Index
- `POST /api/index/rebuild` - Rebuild cross-entity index
- `GET /api/index` - Get current index

#### Versions
- `GET /api/games/{game_id}/versions` - List all versions
- `GET /api/games/{game_id}/versions/{timestamp}` - Get specific version
- `POST /api/games/{game_id}/restore/{timestamp}` - Restore to version

---

## Data Model

### Entity IDs

Human-readable IDs with collision-resistant hash suffix:

```javascript
/**
 * Generate a short, human-readable ID
 * Format: {sanitized-name}-{4-char-hash}
 * Examples: "Alice-7f3a", "Sample-Team-b2c4"
 */
function generateShortId(name) {
    const safeName = name
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 20)
        .replace(/-+$/, '');
    
    const hash = Math.random().toString(36).substring(2, 6);
    return `${safeName}-${hash}`;
}
```

**Collision Handling:**
- On sync, if ID exists with different data, append 2 more chars
- Example: `Alice-7f3a` collides → try `Alice-7f3a2b`
- Extremely rare with 4-char hash (1 in 1.6M chance per name)

### Server-Side Index

Cross-entity index for efficient queries:

```json
{
  "lastRebuilt": "2024-01-15T10:30:00Z",
  "playerGames": {
    "Alice-7f3a": ["game_id_1", "game_id_2"],
    "Bob-2d9e": ["game_id_1"]
  },
  "teamGames": {
    "Sample-Team-b2c4": ["game_id_1", "game_id_2"]
  },
  "gameRoster": {
    "game_id_1": ["Alice-7f3a", "Bob-2d9e", "Charlie-4k1m"]
  }
}
```

**Rebuild Logic:**
- Scan all games, extract player IDs from roster snapshots
- Scan all teams, extract player IDs
- Takes ~1 second for hundreds of games
- Triggered via `POST /api/index/rebuild` or automatically if missing

### Roster Snapshots

Games capture player state at game time for historical accuracy:

```javascript
{
  rosterSnapshot: {
    players: [
      {
        id: "Alice-7f3a",
        name: "Alice",
        nickname: "Ace",
        number: "7",
        gender: "FMP"
      }
    ],
    capturedAt: "2024-01-15T10:30:00Z"
  }
}
```

### Event References

Events reference players by ID:

```javascript
{
  type: "Throw",
  throwerId: "Alice-7f3a",
  receiverId: "Bob-2d9e",
  // ... flags
}
```

---

## Sync Strategy

### Full Game Sync (Stateless)

Every sync operation sends the **complete game state**:

- Average game size: ~6 KB (compresses to ~1.2 KB)
- Sync time: ~25-50ms
- Simple, idempotent, easy to debug

```javascript
async function syncGameToServer(gameId, gameData) {
    const response = await fetch(`${API_BASE}/api/games/${gameId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gameData)
    });
    return response.json();
}
```

### Automatic Versioning

Every sync creates a timestamped version file:

1. Save to `versions/{timestamp}.json`
2. Copy to `current.json`
3. (Optional) Git commit for full history

### Offline Support

```
User creates/edits while offline:
1. Save to localStorage immediately
2. Add to sync queue
3. UI works fully offline

When online:
4. Process sync queue
5. POST to server
6. Handle conflicts (last-write-wins)
```

---

## Deployment

### Infrastructure

| Component | Details |
|-----------|---------|
| **CloudFront** | Distribution `E6M9KCXIU9CKD` |
| **S3 Bucket** | `breakside.pro` (us-east-1) |
| **EC2 Instance** | Amazon Linux 2, IP: 3.212.138.180 |
| **SSL (CloudFront)** | ACM certificate |
| **SSL (EC2)** | Let's Encrypt via certbot |

### Configuration Files

| File | Purpose |
|------|---------|
| `/etc/breakside/env` | Environment variables |
| `/etc/systemd/system/breakside.service` | systemd unit |
| `/etc/nginx/conf.d/breakside.conf` | nginx config |
| `/etc/cron.d/certbot` | SSL renewal cron |

### DNS (Pair.com)

| Domain | Type | Value |
|--------|------|-------|
| `breakside.pro` | A | 3.212.138.180 |
| `www.breakside.pro` | CNAME | d17eottm1x91n5.cloudfront.net |
| `api.breakside.pro` | A | 3.212.138.180 |

### CI/CD

GitHub Actions workflow (`.github/workflows/main.yml`):
1. Triggers on push to `main` branch
2. Syncs PWA files to S3
3. Syncs viewer to S3
4. Invalidates CloudFront cache

---

## Quick Reference Commands

### EC2 / API

```bash
# SSH
ssh -i ~/.ssh/your-key.pem ec2-user@3.212.138.180

# Service management
sudo systemctl status breakside
sudo systemctl restart breakside
sudo journalctl -u breakside -f

# Deploy API updates
cd /opt/breakside && sudo git pull && sudo systemctl restart breakside

# Rebuild index
curl -X POST https://api.breakside.pro/api/index/rebuild
```

### S3 / CloudFront

```bash
# Deploy PWA
aws s3 sync . s3://breakside.pro/ \
  --exclude ".git/*" \
  --exclude "ultistats_server/*" \
  --exclude "data/*" \
  --exclude "scripts/*" \
  --exclude "*.py" \
  --exclude "*.md" \
  --exclude ".DS_Store"

# Deploy viewer
aws s3 sync ultistats_server/static/viewer/ s3://breakside.pro/viewer/

# Invalidate cache
aws cloudfront create-invalidation --distribution-id E6M9KCXIU9CKD --paths "/*"
```

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Average game size | 5.85 KB |
| Compressed size | ~1.17 KB |
| Sync time | 25-50ms |
| Index rebuild | ~1 second (hundreds of games) |
| PWA load (cached) | <100ms |
| PWA load (network) | <500ms |

