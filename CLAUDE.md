# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Breakside is a Progressive Web App for tracking real-time ultimate frisbee statistics. It has a vanilla JavaScript frontend (no framework, no bundler) deployed to AWS S3/CloudFront, and a Python FastAPI backend on EC2 with file-based JSON storage.

- **Live PWA**: https://www.breakside.pro
- **Staging PWA**: https://staging.breakside.pro
- **Live API**: https://api.breakside.pro
- **Beta software** — backwards/forwards compatibility not guaranteed

## Commands

### Backend tests
```bash
pytest ultistats_server/                    # all tests
pytest ultistats_server/test_controller.py  # single test file
pytest ultistats_server/test_api.py -k "test_name"  # single test
```

### Local backend server
```bash
cd ultistats_server && pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Local dev server
```bash
./scripts/dev-server.sh        # serves frontend on http://localhost:3000
./scripts/dev-server.sh 8080   # custom port
```
API auto-routes to `http://localhost:8000` when on localhost. Start backend separately if needed.

### Staging deployment
```bash
./scripts/deploy-staging.sh    # deploys working directory to staging.breakside.pro
```
Deploys current working directory (not committed state) to S3 + CloudFront invalidation. Each deploy writes a `deployStamp` into `version.json` so the PWA can detect redeploys without a commit (tap Online/About to check for updates). Staging uses the same production API (`api.breakside.pro`). Use `?api=<url>` to override the API endpoint (saved to localStorage), `?api=reset` to clear. Staging has a purple header (vs production orange) for visual distinction.

### Production deployment
- **Frontend**: Push to `main` triggers GitHub Actions → S3 sync → CloudFront invalidation. No server restart needed.
- **Backend**: After push, manually SSH to EC2 and restart:
  ```bash
  ssh ec2-user@3.212.138.180
  cd /opt/breakside && sudo git pull && sudo systemctl restart breakside
  ```
- Only remind about server restart when changes touch `ultistats_server/` files.

### Version tracking
`version.json` has version and build number. A pre-commit hook (`increment-version.py`) auto-increments the build number on each commit. On staging, the deploy script also writes a `deployStamp` field so the app detects redeploys even without a build number change.

## Feature Worktrees

For parallel development (e.g., multiple Claude Code sessions), use git worktrees:

```bash
# Create worktree with feature branch
git worktree add .worktrees/<feature-name> -b <feature-name>

# Dev server on a different port
cd .worktrees/<feature-name> && ./scripts/dev-server.sh 3001

# Merge back from main directory
git merge <feature-name>

# Cleanup
git worktree remove .worktrees/<feature-name> && git branch -d <feature-name>
```

`.worktrees/` is gitignored so other sessions won't accidentally stage worktree files.

## Architecture

### Frontend (root directory)
No build system — vanilla JS files loaded in order via `index.html`. No module bundler.

| Directory | Purpose |
|-----------|---------|
| `store/` | Data layer: `models.js` (Player, Game, Team, Point, Event classes), `storage.js` (localStorage serialization), `sync.js` (server sync + offline queue) |
| `screens/` | `navigation.js` — manages 5 main screens |
| `teams/` | Team selection, roster management, settings/invites |
| `game/` | Core game logic, point management, player selection, controller state for multi-coach |
| `playByPlay/` | Offense/defense/simple-mode screens, pull/key-play dialogs |
| `ui/` | Panel system, active players display, event log, button layout |
| `auth/` | Supabase authentication (email/password + Google OAuth) |
| `landing/` | Landing page and invite join flow |

**Key patterns:**
- Global state shared via `store/storage.js`
- Dependency flow: Data → Utils → Features → UI (no circular deps)
- Offline-first: localStorage + service worker (network-first with 5s timeout)
- IDs use format `{sanitized-name}-{4-char-hash}` (e.g., "Alice-7f3a")

### Backend (`ultistats_server/`)
FastAPI app in `main.py`. File-based JSON storage (no database).

| Directory | Purpose |
|-----------|---------|
| `storage/` | CRUD modules for games, teams, players, users, memberships, invites, shares, controller state |
| `auth/` | Supabase JWT validation and FastAPI auth dependencies |
| `static/viewer/` | Public game viewer |

**Key patterns:**
- Full game state sent on each sync (stateless API)
- Every sync creates a timestamped version backup
- Controller state (Active Coach / Line Coach roles) is in-memory only
- Data stored at `/var/lib/breakside/data/` on EC2

### Environment variables (backend)
Key env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `ULTISTATS_DATA_DIR`, `ULTISTATS_AUTH_REQUIRED`. See `ultistats_server/config.py` for full list.

## CI/CD
- **Production**: GitHub Actions (`.github/workflows/main.yml`) deploys frontend on push to `main`. Skips deploy if changes only touch `ultistats_server/`, `data/`, `scripts/`, `*.py`, or `*.md`.
- **Staging**: Manual deploy via `./scripts/deploy-staging.sh` (no CI — deploys working directory directly).
