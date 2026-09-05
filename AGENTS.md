# AGENTS.md

Instructions for any AI coding agent (and any human) working in this repository. Tool-agnostic: nothing here depends on a particular harness. `CLAUDE.md` imports this file and adds Claude-Code-specific notes; other tools should read this file directly.

## Project overview

Breakside is a Progressive Web App for tracking real-time ultimate frisbee statistics. Vanilla JavaScript frontend (no framework, no bundler) deployed to AWS S3/CloudFront, and a Python FastAPI backend on EC2 with file-based JSON storage.

- Live PWA: https://www.breakside.pro
- Staging PWA: https://staging.breakside.pro (purple header; talks to the production API)
- Live API: https://api.breakside.pro
- Beta software: backwards/forwards compatibility not guaranteed.

**This repository is public.** It holds the code and the deploy *mechanisms*. Everything that is true only of the one real production deployment (infrastructure identifiers, box configuration, runbooks, the security backlog, incident history) lives in a separate private repository, `breakside-ops`, normally checked out as a sibling at `../breakside-ops` (`~/src/breakside-ops`). The dividing test: would a self-hoster need it? Then it goes here. Is it true only of Dave's deployment? Then it goes there. Never write production identifiers, audit findings, exploit details, or runbooks into a tracked file here; refer to `breakside-ops` by name instead. This has gone wrong before, which is why the rule is absolute.

## Commands

### Backend tests
```bash
pytest breakside_server/                    # all tests
pytest breakside_server/test_controller.py  # single test file
pytest breakside_server/test_api.py -k "test_name"  # single test
```

### Frontend unit tests
```bash
node --test 'tests/unit/*.test.mjs'         # quote the glob; the bare directory form fails on Node 25
```

### Local backend server
```bash
cd breakside_server && pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

For parallel sessions that each need an isolated server and data copy, use `./scripts/dev-backend.sh`: it picks a free port from 8000, copies the main worktree's `data/` into a gitignored `.dev-data/<label>/`, and runs with auth disabled. Pair a frontend via `?api=http://localhost:<port>`. See ARCHITECTURE.md § Local development backends.

A localhost preview cannot hit the production API (prod CORS allows only the real origins). Do not add localhost to prod CORS; run a dev backend and use `?api=`. For exploring a user's own real teams, use staging and let the user sign in themselves. See ARCHITECTURE.md § Driving the preview against a local backend.

### Local dev server
```bash
./scripts/dev-server.sh        # serves frontend on http://localhost:3000
./scripts/dev-server.sh 8080   # custom port
```
API auto-routes to `http://localhost:8000` on localhost. `?testMode=true` (localhost only) skips the landing-page auth redirect.

### Staging deployment
```bash
./scripts/deploy-staging.sh "<feature> v2"
```
Deploys the **working directory** of the checkout containing the script (not committed state) to S3 and invalidates CloudFront. **Always change the label between redeploys**: the client detects a redeploy by `deployStamp` inequality, and the stamp derives from the label, so a repeated label shows no "Update now" prompt. Only one feature can be on staging at a time. `?api=<url>` overrides the API endpoint (saved to localStorage), `?api=reset` clears it.

### Production deployment
- **Frontend**: push to `main`. GitHub Actions syncs S3 and invalidates CloudFront. No restart.
- **Backend**: push to `main` **first** (the box pulls from origin), then:
  ```bash
  ssh breakside 'sudo bash -s' < scripts/deploy-backend.sh
  ```
  `breakside` is an SSH alias on the maintainer's machine (tunnels over AWS SSM; the box has no port 22). The script pulls, byte-compiles, restarts, and health-checks, aborting before the restart on any failure. It is piped rather than run in place because it lives in the repo it updates. Do not hand-chain `git pull && systemctl restart`: `/opt/breakside` is root-owned (so the app can never rewrite its own source, and the service user cannot build its own `.pyc` cache; the script compiles as root), and piping the pull through anything hides its exit status from `set -e`. Only mention a backend deploy when changes touch `breakside_server/`.
- Operator detail (aliases, rollback, verification): `breakside-ops`, `runbooks/deploy.md`.

### Version tracking
`version.json` holds the committed semver `version` (bump manually with `python3 increment-version.py major|minor|patch`) and a `build` field whose committed value is the placeholder `"dev"`. **Build numbers are never committed.** Both deploy paths run `increment-version.py stamp` at deploy time, writing `git rev-list --count HEAD` into the deployed `version.json` and service-worker `cacheName`; the client detects updates by inequality. Nothing is pushed back to main. See VERSIONING.md.

## Multi-session development

Each agent session MUST work in its own worktree for code changes. Never edit code files directly on `main`.

**Exception:** purely informational docs (`TODO.md`, `README.md`, `ARCHITECTURE.md`, and similar) may be edited directly on `main` and committed/pushed without a worktree.

### Starting a session
```bash
git worktree add .worktrees/<feature> -b <feature>
cd .worktrees/<feature>
./scripts/dev-server.sh 3001   # a different port per worktree
```

### Committing
Commit early and often on feature branches; nothing bumps versions at commit time. Commit after each logical change without waiting to be asked. **Stage explicit paths; never `git add -A` or `git add .`**: a shell whose cwd silently reset to the main checkout would sweep another session's uncommitted work into your commit. Pass absolute paths to git (`git -C /abs/path/.worktrees/<feature> ...`) and to any script whose behaviour depends on its own location (`deploy-staging.sh` deploys the directory containing the script). Shell redirects (`cat >>`, `tee`, `>`) reset the same way; write files by absolute path and verify they landed.

### Testing on staging
```bash
./scripts/deploy-staging.sh "<feature> v1"   # label shows in version.json as deployLabel
```

### Merging to production
```bash
cd /Users/luebke/src/ultistats    # main worktree; keep it clean
git checkout main
git merge <feature>
git push origin main
```
`.git/hooks/pre-merge-commit` runs the full Playwright e2e suite (about 2 minutes, a lot of output) on any non-fast-forward merge into `main` and aborts on failure; fast-forward merges skip it. Grep the output for `passed (` rather than reading it all.

### If branches overlap
```bash
cd .worktrees/<feature-b>
git rebase main
```

### Cleanup
When the work is clearly finished (merged, or the user says so), tear down without being asked: `git worktree remove .worktrees/<feature>` and stop any dev server you started. **Keep the branch**; branch names are the record of past work. `.worktrees/` is gitignored.

### Where documentation goes
Coding and architectural notes (CSS gotchas, conventions, model semantics, pitfalls) go in user-visible repo files: ARCHITECTURE.md, README.md, or `docs/*.md`. Agent instruction files hold rules and pointers only, and reference those docs rather than duplicating them. Engineering notes recovered from an agent's memory belong in `docs/dev-notes/<topic>.md`, one topic per file, each opening with a status line and a last-verified date. Production and ops notes go to `breakside-ops`.

## Architecture

Before debugging any styling issue, skim **ARCHITECTURE.md § CSS Styling Gotchas**: global `button { margin: 10px }` inheritance, reusable button presets that carry their own size, `width: 100%` plus padding interactions, flex/grid `min-width: 0` discipline, service-worker caching of CSS. Add new gotchas there.

### Frontend (root directory)
Native ES modules, no build system; files ship to S3 as-is. `index.html` loads a single `<script type="module" src="main.js">` (plus the Supabase CDN and `vendor/xlsx` classic tags); `main.js`'s import block lists every module in load order. See ARCHITECTURE.md § Module Loading.

| Directory | Purpose |
|-----------|---------|
| `store/` | Data layer: `models.js` (Player, Game, Team, Point, Event), `storage.js` (localStorage serialization), `sync.js` (server sync + offline queue) |
| `screens/` | `navigation.js` manages the 5 main screens |
| `teams/` | Team selection, roster management, settings/invites |
| `game/` | Core game logic, point management, player selection, controller state for multi-coach |
| `playByPlay/` | Offense/defense/simple-mode screens, pull/key-play dialogs |
| `ui/` | Panel system, active players display, event log, button layout |
| `auth/` | Supabase authentication (email/password + Google OAuth) |
| `landing/` | Landing page and invite join flow |

Key patterns:
- Global state lives in `store/storage.js`, exported as live bindings; cross-module writes go through its setters (`setCurrentTeam()` and friends). Never assign to an imported binding.
- Dependency flow: Data → Utils → Features → UI for imports; upward calls are late-bound `window.*?.()` hooks or CustomEvents, each marked `// window survivor:` at its owner. Do not add new bare `window.foo = ...` globals.
- New frontend file = new module: add `import './dir/file.js';` to `main.js` at its layer position, never a classic `<script>` tag (`landing/` and `service-worker.js` are the intentional exceptions).
- Offline-first: localStorage plus a service worker (network-first with 5 s timeout).
- IDs use the format `{sanitized-name}-{4-char-hash}` (e.g. `Alice-7f3a`). Names in examples, fixtures and test data follow ARCHITECTURE.md § Names in examples; never use real player names.

### Backend (`breakside_server/`)
FastAPI app in `main.py`. File-based JSON storage, no database.

| Directory | Purpose |
|-----------|---------|
| `storage/` | CRUD modules for games, teams, players, users, memberships, invites, shares, controller state |
| `auth/` | Supabase JWT validation and FastAPI auth dependencies |
| `static/viewer/` | Public game viewer |

Key patterns:
- Full game state sent on each sync (stateless API); every sync writes a timestamped version backup.
- Controller state (Active Coach / Line Coach roles) and connected-coach pings are in-memory only.
- Role buttons are hidden when solo coaching; a latch shows them once multi-coach is detected (resets on game exit).
- Production data lives at `/var/lib/breakside/data`; never write there as root.

Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `BREAKSIDE_DATA_DIR`, `BREAKSIDE_AUTH_REQUIRED`, and the rest in `breakside_server/config.py`. Running backend tests from a checkout older than July 2026 pollutes `data/`; the current suite is isolated.

## CI/CD
- **Production**: `.github/workflows/main.yml` deploys the frontend on push to `main`. It skips the deploy when a push touches only `breakside_server/`, `data/`, `scripts/`, `**.py`, `**.md`, `.claude/`, or `.gitignore`. The double star matters: GitHub path filters do not let `*` match `/`. `.github/` is deliberately not on the list (a workflow edit still runs); `docs/**` is deliberately absent because `docs/clips/` is deployed.
- **Staging**: manual, `./scripts/deploy-staging.sh`. No CI.
- `scripts/deploy-excludes.txt` is the single list of what the PWA syncs exclude, shared by both. `.gitignore` does **not** protect the S3 buckets: staging deploys a working directory, so any new local-only directory must be added to the exclude list too.
