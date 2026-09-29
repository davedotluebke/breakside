#!/usr/bin/env bash
#
# Tag the releases in a range of history.
#
# A release is a commit that raises `version` in version.json (VERSIONING.md
# § Release Tagging). Every such commit in the range gets an annotated tag
# vX.Y.Z whose message is the commit's subject — unless the tag already
# exists, which is left alone. The rule is the post-commit hook's
# (scripts/git-hooks/post-commit) applied after the fact: the hook tags a
# release the moment it is committed on a laptop, and the tag is then pushed
# by hand; a release that reaches main from a Claude Code cloud session never
# gets that far, because the session's credential can push only its own
# branch, never main or a tag. .github/workflows/tag-release.yml runs this
# on every push to main that touches version.json, and its manual trigger
# runs it over the whole history to backfill tags that were never pushed.
# Both the hook and this script skip existing tags, so they agree.
#
# Usage:
#   scripts/tag-releases.sh [--dry-run] [--push] [<range>]
#
#   <range>    the commits to examine, e.g. BEFORE..HEAD; default HEAD, which
#              is the whole history (the backfill)
#   --dry-run  print what would be tagged, create nothing
#   --push     push the tags this run created to origin
#
# Versions are read from the commits (git show <rev>:version.json), never
# from a working tree. A merge commit whose version.json matches one of its
# parents is not examined (git's default history simplification drops it),
# so a release merged with a merge commit is tagged at the bump commit on the
# branch, not at the merge.
set -euo pipefail

DRY_RUN=0
PUSH=0
RANGE=HEAD
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --push)    PUSH=1 ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *)         RANGE="$arg" ;;
    esac
done

# version_at <rev>: the version string in <rev>'s version.json, or nothing.
version_at() {
    git show "$1:version.json" 2>/dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin)["version"])
except Exception:
    pass
'
}

# is_newer <old> <new>: exit 0 when <new> sorts after <old>, numerically, dot by dot.
is_newer() {
    python3 -c '
import sys
def key(v):
    return [int("".join(c for c in part if c.isdigit()) or 0) for part in v.split(".")]
sys.exit(0 if key(sys.argv[2]) > key(sys.argv[1]) else 1)
' "$1" "$2"
}

created=()
examined=0
while IFS= read -r commit; do
    [[ -n "$commit" ]] || continue
    examined=$((examined + 1))
    short="${commit:0:7}"
    new="$(version_at "$commit")"
    [[ -n "$new" ]] || continue                    # no version.json in this commit
    old="$(version_at "${commit}^1" || true)"
    [[ -n "$old" ]] || continue                    # root commit, or the parent had no version.json
    [[ "$new" != "$old" ]] || continue             # version unchanged: not a release
    subject="$(git log -1 --format=%s "$commit")"
    if ! is_newer "$old" "$new"; then
        echo "skip   $short  $old -> $new is not a bump  ($subject)"
        continue
    fi
    tag="v$new"
    if at="$(git rev-parse -q --verify "refs/tags/$tag^{commit}")"; then
        if [[ "$at" != "$commit" ]]; then
            echo "exists $tag at ${at:0:7}, not at $short  ($subject)"
        fi
        continue
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "would  $tag at $short  ($subject)"
    else
        git tag -a "$tag" -m "$subject" "$commit"
        echo "tagged $tag at $short  ($subject)"
    fi
    created+=("$tag")
done < <(git rev-list --reverse "$RANGE" -- version.json)

echo "examined $examined commit(s) touching version.json in $RANGE; ${#created[@]} tag(s) $([[ "$DRY_RUN" -eq 1 ]] && echo 'to create' || echo 'created')"

if [[ "$PUSH" -eq 1 && "$DRY_RUN" -eq 0 && "${#created[@]}" -gt 0 ]]; then
    refs=()
    for tag in "${created[@]}"; do refs+=("refs/tags/$tag"); done
    git push origin "${refs[@]}"
fi
