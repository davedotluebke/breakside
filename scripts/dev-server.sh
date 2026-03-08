#!/bin/bash
# Start a local dev server for the frontend.
# Usage: ./scripts/dev-server.sh [port]

PORT="${1:-3000}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Serving $DIR on http://localhost:$PORT"
echo "API calls will route to http://localhost:8000 (start backend separately if needed)"

cd "$DIR" && python3 -m http.server "$PORT"
