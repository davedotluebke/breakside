#!/usr/bin/env bash
# Deploy the backend to EC2: pull, byte-compile, restart, verify.
#
# Usage — from a dev machine, piping THIS file to the server:
#
#   ssh breakside 'sudo bash -s' < scripts/deploy-backend.sh
#
# It is piped rather than executed in place on purpose. The script lives in
# the repo it updates, and bash reads a script file incrementally — a `git
# pull` that rewrites the file mid-run can make bash resume at a garbage
# offset. Piping means the copy being executed is the local one, which is
# also the version you are deploying.
#
# Safe to re-run: if HEAD does not move it reports "already current" and
# leaves the service alone rather than restarting for nothing.
set -euo pipefail

REPO=/opt/breakside
UNIT=breakside
SERVER_DIR="$REPO/ultistats_server"
VENV_PY="$REPO/venv/bin/python"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { red "ERROR: $*"; exit 1; }

[[ $EUID -eq 0 ]] || fail "must run as root — use: ssh breakside 'sudo bash -s' < scripts/deploy-backend.sh"
[[ -d "$REPO/.git" ]] || fail "$REPO is not a git checkout"
[[ -x "$VENV_PY" ]]   || fail "no interpreter at $VENV_PY"

cd "$REPO"

# --------------------------------------------------------------- drift ------
# The ownership model everything below depends on: root owns the tree, so the
# app cannot modify its own source, and root builds the bytecode the app then
# reads. Checked BEFORE the up-to-date early exit, so running this script is
# always a valid state check even when there is nothing to deploy —
# ownership drift's only symptom is otherwise "mysteriously slower".
NOT_ROOT=$(find "$REPO" -not -user root -print -quit 2>/dev/null | wc -l)
if [[ "$NOT_ROOT" -ne 0 ]]; then
    red "=============================================================="
    red " WARNING: $REPO contains files not owned by root."
    red " The app user may be able to rewrite its own source, and root"
    red " may not be able to refresh the bytecode cache."
    red " Restore with: sudo chown -R root:root $REPO"
    red "=============================================================="
fi

# ---------------------------------------------------------------- pull ------
BEFORE=$(git rev-parse --short HEAD)
bold "current : $BEFORE  $(git log -1 --format=%s)"

git pull --ff-only origin main
AFTER=$(git rev-parse --short HEAD)

if [[ "$BEFORE" == "$AFTER" ]]; then
    bold "already current — nothing to deploy, service left running"
    exit 0
fi
bold "pulled  : $AFTER  $(git log -1 --format=%s)"

# ------------------------------------------------------------ bytecode ------
# The runtime user cannot write into $REPO (it is root-owned so the app can
# never rewrite its own source), so it cannot build its own .pyc cache. We
# build it here as root instead. This is not just a startup optimisation:
# parts of the code import lazily at REQUEST time, so a cold cache costs a
# live user, not the boot sequence.
#
# compileall also doubles as a syntax gate — a file that will not compile
# aborts the deploy BEFORE the restart, so a bad push cannot take the API
# down.
bold "compiling bytecode..."
if ! "$VENV_PY" -m compileall -q "$SERVER_DIR"; then
    red   "=============================================================="
    red   " BYTECODE COMPILATION FAILED — NOT RESTARTING"
    red   " The working tree is at $AFTER but the service still runs the"
    red   " old code. Fix the syntax error and re-run, or roll back with:"
    red   "   sudo git -C $REPO reset --hard $BEFORE"
    red   "=============================================================="
    exit 1
fi

# Verify the cache is WARM, not that files were freshly written. compileall
# legitimately writes nothing when no .py changed (e.g. a docs- or
# script-only deploy), so "wrote 0 files" is not evidence of a problem — a
# warning that cries wolf on every such deploy is one people learn to ignore.
# What actually matters is whether every source file has a current .pyc.
UNCACHED=0
while IFS= read -r src; do
    cache="$(dirname "$src")/__pycache__/$(basename "$src" .py).cpython-*.pyc"
    # shellcheck disable=SC2086
    newest=$(ls -1t $cache 2>/dev/null | head -1)
    if [[ -z "$newest" || "$src" -nt "$newest" ]]; then
        UNCACHED=$((UNCACHED + 1))
    fi
done < <(find "$SERVER_DIR" -name '*.py' -not -path '*/__pycache__/*')

if [[ "$UNCACHED" -ne 0 ]]; then
    red   "=============================================================="
    red   " WARNING: $UNCACHED source file(s) have no current .pyc."
    red   " Those imports compile from source on demand — including lazy"
    red   " imports that run mid-REQUEST, so a live user pays the cost."
    red   " Check ownership/permissions:"
    red   "   ls -ld $SERVER_DIR $SERVER_DIR/__pycache__"
    red   "=============================================================="
else
    bold "bytecode: cache warm (every source file has a current .pyc)"
fi

# ------------------------------------------------------------- restart ------
bold "restarting $UNIT..."
systemctl restart "$UNIT"
sleep 5

ACTIVE=$(systemctl is-active "$UNIT" || true)
[[ "$ACTIVE" == "active" ]] || fail "$UNIT is '$ACTIVE' after restart — check: journalctl -u $UNIT -n 50"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8000/health || true)
[[ "$CODE" == "200" ]] || fail "health check returned HTTP ${CODE:-none} — check: journalctl -u $UNIT -n 50"

ERRS=$(journalctl -u "$UNIT" --since '2 minutes ago' --no-pager 2>/dev/null | grep -ciE 'error|traceback' || true)
[[ "$ERRS" -eq 0 ]] || red "note: $ERRS error-ish log lines since restart — worth a look"

bold "deployed $BEFORE -> $AFTER, service active, health 200"
