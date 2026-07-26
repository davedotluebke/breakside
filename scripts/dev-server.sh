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
import re
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# Short-link paths that exist only as redirects performed by index.html's
# inline shim (/join/<code>, /view/<hash>). In production the S3 website
# config's ErrorDocument serves index.html for them; a plain http.server
# 404s instead, so the shims were untestable locally. Serve index.html for
# exactly these shapes — narrower than a blanket 404 fallback, so genuine
# missing-asset 404s still surface (the e2e suite runs against this server).
SHORT_LINK_RE = re.compile(r"^/(join|view)/[A-Za-z0-9]+/?$")


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def translate_path(self, path):
        if SHORT_LINK_RE.match(path.split("?", 1)[0]):
            return super().translate_path("/index.html")
        return super().translate_path(path)


ThreadingHTTPServer(("", int(sys.argv[1])), NoCacheHandler).serve_forever()
PY
