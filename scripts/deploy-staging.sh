#!/bin/bash
# Deploy current working directory to the staging S3 bucket.
# Shares the production exclude list (scripts/deploy-excludes.txt) and the
# deploy-time version stamping scheme (increment-version.py stamp).
# Includes service worker and version.json with no-cache headers.
#
# Usage: ./scripts/deploy-staging.sh ["optional label"]
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - S3 bucket: staging.breakside.pro
#
# Optional env vars:
#   STAGING_BUCKET    - S3 bucket name (default: staging.breakside.pro)
#   STAGING_CF_DIST   - CloudFront distribution ID for invalidation (optional)

# Ensure full PATH is available (Claude Desktop strips shell PATH)
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"

set -euo pipefail

BUCKET="${STAGING_BUCKET:-staging.breakside.pro}"
CF_DIST="${STAGING_CF_DIST:-E12N2STN9MM8FA}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

LABEL="${1:-}"
STAMP=$(date -u +%Y%m%d%H%M%S)
echo "Deploying $DIR to s3://$BUCKET (stamp: $STAMP${LABEL:+, label: $LABEL}) ..."

# Stamp the deploy-time build number (git rev-list --count HEAD), deployStamp
# and optional deployLabel into temp copies of version.json/service-worker.js.
# The SW cacheName gets a -stg-<stamp> suffix so every staging deploy registers
# as an SW update (purging old CacheStorage on activate) even without a commit.
# The working tree is left untouched.
STAGED_VERSION=$(mktemp)
STAGED_SW=$(mktemp)
(cd "$DIR" && python3 increment-version.py stamp \
    --deploy-stamp "$STAMP" \
    ${LABEL:+--deploy-label "$LABEL"} \
    --cache-suffix "stg-$STAMP" \
    --out-version "$STAGED_VERSION" \
    --out-sw "$STAGED_SW")

# Build --exclude args from the shared exclude list
EXCLUDES=()
while IFS= read -r pattern; do
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue
  EXCLUDES+=(--exclude "$pattern")
done < "$DIR/scripts/deploy-excludes.txt"

aws s3 sync "$DIR" "s3://$BUCKET/" "${EXCLUDES[@]}" --delete

# Upload stamped version.json with no-cache headers
aws s3 cp "$STAGED_VERSION" "s3://$BUCKET/version.json" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "application/json"

# Upload stamped service worker with no-cache headers
aws s3 cp "$STAGED_SW" "s3://$BUCKET/service-worker.js" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "application/javascript"

rm -f "$STAGED_VERSION" "$STAGED_SW"

# Sync viewer files
aws s3 sync "$DIR/ultistats_server/static/viewer/" "s3://$BUCKET/viewer/"

echo "Deployed to https://staging.breakside.pro"

# Optional CloudFront invalidation
echo "Invalidating CloudFront distribution $CF_DIST ..."
aws cloudfront create-invalidation \
  --distribution-id "$CF_DIST" \
  --paths "/*"
echo "CloudFront invalidation started"
