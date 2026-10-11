#!/bin/bash
# Start a local dev server for the frontend.
# Usage: ./scripts/dev-server.sh [port]
#
# Port precedence: CLI arg > $BREAKSIDE_PORT > 3000.
# The env var lets scripts/sessions pin a per-worktree port without changing
# the human default (the e2e suite derives its own ports separately; see
# tests/helpers/constants.ts).
#
# The server itself is scripts/serve-static.py, shared with the e2e suite:
# HTTP/1.1 keep-alive with a real listen backlog (plain `python3 -m
# http.server` lost files to connection resets under the app's boot burst),
# Cache-Control: no-cache so edits show on the next reload, and index.html
# served for the /join/<code> and /view/<hash> short links, as production's
# S3 ErrorDocument does. Details in that file's docstring.

PORT="${1:-${BREAKSIDE_PORT:-3000}}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "API calls will route to http://localhost:8000 (start backend separately if needed)"
exec python3 "$DIR/scripts/serve-static.py" "$PORT" "$DIR"
