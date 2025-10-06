#!/bin/bash

# Simple wrapper script for version management
# Usage: ./version.sh [major|minor|build]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/increment-version.py" "$@"
