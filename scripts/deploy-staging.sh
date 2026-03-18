#!/bin/bash
# Deploy current working directory to the staging S3 bucket.
# Mirrors production exclusions. Includes service worker with no-cache headers.
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

set -euo pipefail

BUCKET="${STAGING_BUCKET:-staging.breakside.pro}"
CF_DIST="${STAGING_CF_DIST:-E12N2STN9MM8FA}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

LABEL="${1:-}"
STAMP=$(date -u +%Y%m%d%H%M%S)
echo "Deploying $DIR to s3://$BUCKET (stamp: $STAMP${LABEL:+, label: $LABEL}) ..."

# Create a stamped version.json for staging (detects redeploys without a commit)
STAGED_VERSION=$(mktemp)
python3 -c "
import json, sys
v = json.load(open('$DIR/version.json'))
v['deployStamp'] = '$STAMP'
label = '$LABEL'
if label:
    v['deployLabel'] = label
json.dump(v, sys.stdout, indent=2)
" > "$STAGED_VERSION"

aws s3 sync "$DIR" "s3://$BUCKET/" \
  --exclude ".git/*" \
  --exclude ".github/*" \
  --exclude ".claude/*" \
  --exclude ".worktrees/*" \
  --exclude ".vscode/*" \
  --exclude ".pytest_cache/*" \
  --exclude ".gitignore" \
  --exclude "ultistats_server/*" \
  --exclude "data/*" \
  --exclude "scripts/*" \
  --exclude "*.py" \
  --exclude "*.sh" \
  --exclude "__pycache__/*" \
  --exclude "*.md" \
  --exclude ".DS_Store" \
  --exclude "*.wav" \
  --exclude "*.ogg" \
  --exclude "*.m4a" \
  --exclude "*.webm" \
  --exclude "service-worker.js" \
  --exclude "version.json" \
  --exclude "LICENSE" \
  --exclude "CLAUDE.md" \
  --delete

# Upload version.json with deploy stamp and no-cache headers
aws s3 cp "$STAGED_VERSION" "s3://$BUCKET/version.json" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "application/json"
rm -f "$STAGED_VERSION"

# Upload service worker with no-cache headers
aws s3 cp "$DIR/service-worker.js" "s3://$BUCKET/service-worker.js" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "application/javascript"

# Sync viewer files
aws s3 sync "$DIR/ultistats_server/static/viewer/" "s3://$BUCKET/viewer/"

echo "Deployed to https://staging.breakside.pro"

# Optional CloudFront invalidation
echo "Invalidating CloudFront distribution $CF_DIST ..."
aws cloudfront create-invalidation \
  --distribution-id "$CF_DIST" \
  --paths "/*"
echo "CloudFront invalidation started"
