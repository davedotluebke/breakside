#!/bin/bash

# Simple wrapper script for version management
# Usage: ./version.sh [major|minor|patch]
# (build numbers are stamped at deploy time — see VERSIONING.md)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/increment-version.py" "$@"
