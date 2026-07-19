#!/bin/bash
# Start a local dev server for the frontend.
# Usage: ./scripts/dev-server.sh [port]
#
# Port precedence: CLI arg > $BREAKSIDE_PORT > 3000.
# The env var lets scripts/sessions pin a per-worktree port without changing
# the human default (the e2e suite derives its own ports separately; see
# tests/helpers/constants.ts).

PORT="${1:-${BREAKSIDE_PORT:-3000}}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Serving $DIR on http://localhost:$PORT"
echo "API calls will route to http://localhost:8000 (start backend separately if needed)"

# Plain `python3 -m http.server` sends no Cache-Control header, so browsers
# heuristically cache JS/CSS (10% of the file's Last-Modified age) and can
# serve stale modules even after a reload. no-cache forces revalidation on
# every request; the server answers 304 from mtime, so edits always show up.
cd "$DIR" && python3 - "$PORT" <<'PY'
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

ThreadingHTTPServer(("", int(sys.argv[1])), NoCacheHandler).serve_forever()
PY
