#!/bin/bash
# Deploy current working directory to the staging S3 bucket.
# Shares the production exclude list (scripts/deploy-excludes.txt) and the
# deploy-time version stamping scheme (increment-version.py stamp).
# Includes service worker and version.json with no-cache headers.
#
# Usage: ./scripts/deploy-staging.sh ["optional label"]
#
# Prerequisites:
#   - AWS CLI with a "breakside-deploy" profile that can write the bucket and
#     invalidate CloudFront (see AWS_PROFILE below)
#   - S3 bucket: staging.breakside.pro
#
# Optional env vars:
#   STAGING_BUCKET    - S3 bucket name (default: staging.breakside.pro)
#   STAGING_CF_DIST   - CloudFront distribution ID for invalidation (optional)
#   AWS_PROFILE       - AWS profile to deploy as (default: breakside-deploy)

# Ensure full PATH is available (Claude Desktop strips shell PATH)
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"

set -euo pipefail

BUCKET="${STAGING_BUCKET:-staging.breakside.pro}"
CF_DIST="${STAGING_CF_DIST:-E12N2STN9MM8FA}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Deploy credentials live in a named AWS profile, not the ambient environment,
# so the shell default can stay an interactive/admin identity. Sourcing
# ~/.zshenv above used to supply the keys; it deliberately no longer does.
# Fail fast with a clear message instead of a confusing S3 error mid-sync.
export AWS_PROFILE="${AWS_PROFILE:-breakside-deploy}"
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "error: AWS profile '$AWS_PROFILE' has no usable credentials." >&2
  echo "       Add it to ~/.aws/credentials, or set AWS_PROFILE to an identity" >&2
  echo "       that can write s3://$BUCKET and invalidate CloudFront $CF_DIST." >&2
  exit 1
fi

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
aws s3 sync "$DIR/breakside_server/static/viewer/" "s3://$BUCKET/viewer/" --delete

echo "Deployed to https://staging.breakside.pro"

# Optional CloudFront invalidation
echo "Invalidating CloudFront distribution $CF_DIST ..."
aws cloudfront create-invalidation \
  --distribution-id "$CF_DIST" \
  --paths "/*"
echo "CloudFront invalidation started"
