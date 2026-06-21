#!/bin/bash
# Launch an isolated local backend instance with its OWN copy of the data store.
#
# Why: multiple Claude Code sessions / worktrees often advance different
# server-side work at once. Each should run its own backend against its own
# state so they never collide — and so schema-breaking experiments (new fields
# on Event/Player, etc.) never touch production data. This is the durable
# replacement for pointing a localhost frontend at the prod API.
#
# Each instance = one port + one data dir under .dev-data/<label>/ (gitignored).
# Runs with ULTISTATS_AUTH_REQUIRED=false: no Supabase secrets needed and
# membership checks are skipped, so a locally-served frontend can read/write the
# copied data via ?api=http://localhost:<port>.
#
# Multiple at once: just run this in each worktree (or with a different --port);
# it auto-picks a free port from 8000 and an independent data dir, so N sessions
# coexist. The backend serves THIS worktree's ultistats_server code (--reload),
# so each session tests its own server changes against its own data.
#
# Usage:
#   ./scripts/dev-backend.sh                       # auto port (from 8000), data copied from ./data
#   ./scripts/dev-backend.sh --port 8001 --label on-deck
#   ./scripts/dev-backend.sh --fresh               # start with an empty data store
#   ./scripts/dev-backend.sh --from /path/to/snapshot   # seed from elsewhere (e.g. a prod export)
#   ./scripts/dev-backend.sh --reset               # wipe & re-seed this label's data dir
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Default seed source = the MAIN worktree's data/ dir (where local dev data
# lives). data/ is gitignored, so linked worktrees don't have their own copy;
# resolve the main worktree via git's common dir so seeding works from anywhere.
_common_dir="$(git -C "$REPO" rev-parse --git-common-dir 2>/dev/null || echo "")"
if [ -n "$_common_dir" ]; then
  case "$_common_dir" in /*) : ;; *) _common_dir="$REPO/$_common_dir";; esac
  MAIN_ROOT="$(cd "$(dirname "$_common_dir")" && pwd)"
else
  MAIN_ROOT="$REPO"
fi

PORT=""
LABEL=""
SEED_FROM="$MAIN_ROOT/data"
FRESH=0
RESET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port)  PORT="$2";  shift 2;;
    --label) LABEL="$2"; shift 2;;
    --from)  SEED_FROM="$2"; shift 2;;
    --fresh) FRESH=1; shift;;
    --reset) RESET=1; shift;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unknown arg: $1 (try --help)" >&2; exit 1;;
  esac
done

# Pick the first free TCP port in [8000, 8100) if one wasn't given.
find_free_port() {
  python3 - <<'PY'
import socket
for p in range(8000, 8100):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p))
        print(p)
        break
    except OSError:
        continue
    finally:
        s.close()
PY
}

[ -z "$PORT" ] && PORT="$(find_free_port)"
[ -z "$PORT" ] && { echo "No free port found in 8000-8099" >&2; exit 1; }
[ -z "$LABEL" ] && LABEL="be-$PORT"

DATADIR="$REPO/.dev-data/$LABEL"

if [ "$RESET" = "1" ] && [ -d "$DATADIR" ]; then
  echo "Resetting data dir: $DATADIR"
  rm -rf "$DATADIR"
fi

if [ ! -d "$DATADIR" ]; then
  mkdir -p "$DATADIR"
  if [ "$FRESH" = "1" ]; then
    echo "Fresh empty data store at $DATADIR (server creates the structure on start)"
  elif [ -d "$SEED_FROM" ]; then
    echo "Seeding $DATADIR from $SEED_FROM"
    cp -R "$SEED_FROM"/. "$DATADIR"/ 2>/dev/null || true
  else
    echo "Seed source not found ($SEED_FROM); starting empty"
  fi
else
  echo "Reusing existing data dir: $DATADIR (use --reset to re-seed)"
fi

echo
echo "──────────────────────────────────────────────────────────────"
echo "  Local backend:  http://localhost:$PORT   (label: $LABEL)"
echo "  Data dir:       $DATADIR"
echo "  Auth:           disabled (ULTISTATS_AUTH_REQUIRED=false)"
echo
echo "  Pair a frontend with it (open once; saved to that origin's localStorage):"
echo "    http://localhost:<frontend-port>/index.html?api=http://localhost:$PORT"
echo "    (?api=reset clears the override)"
echo
echo "  Stop with Ctrl-C."
echo "──────────────────────────────────────────────────────────────"
echo

cd "$REPO/ultistats_server"
exec env ULTISTATS_DATA_DIR="$DATADIR" \
         ULTISTATS_AUTH_REQUIRED=false \
         ULTISTATS_PORT="$PORT" \
         uvicorn main:app --reload --port "$PORT"
