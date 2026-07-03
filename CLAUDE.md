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

For **parallel sessions** that each need their own isolated server + data copy
(concurrent server-side work without collisions; schema experiments never touch
prod), use `./scripts/dev-backend.sh` — auto-picks a free port from 8000, copies
the main worktree's `data/` into a gitignored per-instance `.dev-data/<label>/`,
runs with auth disabled. Pair a frontend via `?api=http://localhost:<port>`. See
ARCHITECTURE.md § Local development backends.

To **drive the in-IDE preview against a backend yourself** (create a team,
start a game, etc.): a localhost preview can't hit the prod API — prod CORS only
allows the real origins, so data calls fail and no teams show. Don't add
localhost to prod CORS; instead start a `dev-backend.sh` (auth-disabled, CORS
`*`) and load the preview with `?api=http://localhost:<port>`, then create
throwaway test data. For a user exploring their *own real* teams, use **staging**
(a CORS-allowed origin) and the user-login handoff instead. See ARCHITECTURE.md
§ Driving the preview against a local backend.

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
`version.json` holds the committed semver `version` string (bump manually with `python3 increment-version.py major|minor|patch`) and a `build` field whose committed value is the placeholder `"dev"` — **build numbers are never committed**. They are stamped at **deploy time only**: both the production GitHub Action and `deploy-staging.sh` run `increment-version.py stamp`, which computes `git rev-list --count HEAD` and writes it into the *deployed* `version.json` and service-worker `cacheName` (the client detects updates by build/stamp *inequality*, so any new deploy triggers the update prompt). Nothing is pushed back to main — there is no pre-commit bump, no CI bot commit, and no cherry-pick caveat. Staging additionally stamps `deployStamp`/`deployLabel` and suffixes the cacheName (`build-<n>-stg-<stamp>`) so redeploys without a commit are still detected. See VERSIONING.md.

## Multi-Session Development

Each Claude Code session MUST work in its own worktree for code changes. Never edit code files directly on main.

**Exception:** purely informational docs (`TODO.md`, `README.md`, `ARCHITECTURE.md`, etc.) may be edited directly on main and committed/pushed without a worktree. The worktree rule exists to prevent concurrent code edits from stepping on each other; single-section additions to a shared docs file don't have that problem and often need to land *now* so a sibling session can see them.

### Starting a session
```bash
git worktree add .worktrees/<feature> -b <feature>
cd .worktrees/<feature>
./scripts/dev-server.sh 3001   # use a different port per worktree
```

### Committing
Commit early and often on feature branches. Commits are free — nothing bumps versions at commit time (build numbers are stamped at deploy time only). Commit after each logical change (a function, a bug fix, a UI tweak) without waiting for the user to ask. This keeps `git status` clean and prevents uncommitted changes from blocking merges in other sessions.

### Testing on staging
```bash
./scripts/deploy-staging.sh "<feature>"   # label shows in version.json as deployLabel
```
Only one feature can be on staging at a time. Redeploy from the relevant worktree when switching.

### Merging to production
```bash
cd /Users/luebke/src/ultistats    # main worktree — keep it clean
git checkout main
git merge <feature>
git push origin main
```

### If branches overlap
```bash
# Rebase the later branch onto main after the first merges:
cd .worktrees/<feature-b>
git rebase main
# Resolve conflicts in the worktree, then merge as normal
```

### Cleanup
```bash
git worktree remove .worktrees/<feature>
```
Keep feature branches after merging — don't delete them. Branch names serve as a record of past work on GitHub.

`.worktrees/` is gitignored so other sessions won't accidentally stage worktree files.

## Architecture

Before debugging any styling issue, skim **ARCHITECTURE.md § CSS Styling Gotchas** — it lists the non-obvious cascade/box-model traps that have bitten layout work here (global `button { margin: 10px }` inheritance, reusable button presets that carry their own size, `width: 100%` + padding interactions, flex/grid `min-width: 0` discipline, service-worker caching of CSS). Add new gotchas there as you find them, not to this file.

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
- Connected coaches tracked in-memory via ping endpoint (separate from role holders)
- Role buttons hidden when solo coaching; latch visible once multi-coach detected (resets on game exit)
- Data stored at `/var/lib/breakside/data/` on EC2

### Environment variables (backend)
Key env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `ULTISTATS_DATA_DIR`, `ULTISTATS_AUTH_REQUIRED`. See `ultistats_server/config.py` for full list.

## CI/CD
- **Production**: GitHub Actions (`.github/workflows/main.yml`) deploys frontend on push to `main`. Skips deploy if changes only touch `ultistats_server/`, `data/`, `scripts/`, `*.py`, or `*.md`.
- **Staging**: Manual deploy via `./scripts/deploy-staging.sh` (no CI — deploys working directory directly).
