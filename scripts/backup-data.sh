#!/usr/bin/env bash
# Back up the live data directory to S3. Runs ON THE EC2 BOX, from cron, as root.
#
#   /usr/local/bin/backup-data.sh          # normal run
#   /usr/local/bin/backup-data.sh --dry-run # show what would upload, change nothing
#
# Why this exists: there is exactly one instance, one EBS volume, and one copy
# of every team, roster and game. `/var/backups/breakside/*.tgz` is NOT a backup
# — it is on the same disk, so it dies with the disk. This is the off-instance
# copy. See docs/ops/backup-restore.md for the bucket/IAM setup and, more
# importantly, for the RESTORE drill. An untested backup is not a backup.
#
# Credentials: the EC2 instance role, resolved through IMDSv2. Nothing is
# stored on disk and no access key is involved. This works because the script
# runs directly on the host — IMDSv2 is enforced with a hop limit of 1, so if
# this is ever moved inside Docker the extra network hop makes the metadata
# service unreachable and credentials silently vanish. Keep it on the host.
set -euo pipefail

# cron's default PATH is /usr/bin:/bin, which does NOT include /usr/sbin. That
# exact gap silently broke certbot renewals here for three months (see
# ARCHITECTURE.md § TLS Certificate Renewal), so set PATH explicitly and call
# sendmail by absolute path below rather than trusting the environment.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

CONFIG_FILE=/etc/breakside/backup.env
LOG_TAG=breakside-backup

# Source config FIRST, so every default below can be overridden from it. The
# bucket name is deliberately NOT hardcoded here: this repo is public. It lives
# in /etc/breakside/backup.env (root-owned, mode 600), alongside the existing
# /etc/breakside/env. See the runbook for the one line that file needs.
# shellcheck source=/dev/null
[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"

BUCKET="${BACKUP_BUCKET:-}"
DATA_DIR="${ULTISTATS_DATA_DIR:-/var/lib/breakside/data}"
LOCAL_SNAPSHOT_DIR="${BACKUP_SNAPSHOT_DIR:-/var/backups/breakside}"
STATE_DIR=/var/lib/breakside/backup-state
LOCK_FILE=/var/run/breakside-backup.lock
ALERT_EMAIL="${BACKUP_ALERT_EMAIL:-dave@luebke.us}"
export AWS_DEFAULT_REGION="${BACKUP_REGION:-us-east-1}"

# Warn if the last SUCCESSFUL run is older than this. Catches the failure mode
# a failure-only alarm cannot: runs that stopped happening at all.
STALE_DAYS="${BACKUP_STALE_DAYS:-3}"
# Refuse to back up a suspiciously empty data dir (see preflight).
MIN_FILES="${BACKUP_MIN_FILES:-100}"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

log()  { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; logger -t "$LOG_TAG" -p user.info "$*"; }
warn() { printf '%s WARNING: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; logger -t "$LOG_TAG" -p user.warning "$*"; }

# Mail an alarm, matching the pattern already proven on this box in
# /usr/local/bin/cert-expiry-check.sh — syslog AND email, so a failure is
# visible whether or not anyone is reading logs. sendmail by absolute path:
# /usr/sbin is not on cron's PATH.
alert() {
    local subject="$1" body="$2"
    logger -t "$LOG_TAG" -p user.err "$subject"
    printf 'Subject: [Breakside] %s\nFrom: %s\nTo: %s\n\n%s\n\nHost: %s\nData dir: %s\nBucket: %s\nRun: %s\nLogs: journalctl -t %s --since today\n' \
        "$subject" "$ALERT_EMAIL" "$ALERT_EMAIL" "$body" \
        "$(hostname)" "$DATA_DIR" "${BUCKET:-<unset>}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$LOG_TAG" \
        | /usr/sbin/sendmail -t || warn "sendmail failed — alarm went to syslog only"
}

# Any unexpected non-zero exit mails an alarm. Without this a cron failure is
# silent, which is how you discover in an outage that backups stopped in March.
FAILED_STEP="startup"
on_exit() {
    local code=$?
    [[ $code -eq 0 ]] && exit 0
    alert "DATA BACKUP FAILED (exit $code)" \
          "The nightly backup of $DATA_DIR failed during: $FAILED_STEP

There is no other off-instance copy of this data. Investigate now:
  sudo journalctl -t $LOG_TAG --since today
  sudo /usr/local/bin/backup-data.sh --dry-run"
    exit "$code"
}
trap on_exit EXIT

# ------------------------------------------------------------- preflight ----
FAILED_STEP="preflight checks"
[[ $EUID -eq 0 ]] || { echo "ERROR: must run as root (needs to read $DATA_DIR)" >&2; exit 2; }
[[ -n "$BUCKET" ]] || { echo "ERROR: BACKUP_BUCKET is not set. Add it to $CONFIG_FILE — see docs/ops/backup-restore.md" >&2; exit 2; }
[[ -d "$DATA_DIR" ]] || { echo "ERROR: data directory $DATA_DIR does not exist" >&2; exit 2; }
command -v aws >/dev/null || { echo "ERROR: aws CLI not found on PATH" >&2; exit 2; }

# Refuse to "successfully" back up an empty directory. If a bad migration or an
# rm -rf has already emptied the data dir, uploading that result is the worst
# possible outcome — with bucket versioning it is recoverable, but the run
# should still stop and shout rather than report success.
FILE_COUNT=$(find "$DATA_DIR" -type f ! -name '*.tmp' | wc -l)
MIN_FILES="${BACKUP_MIN_FILES:-100}"
if [[ "$FILE_COUNT" -lt "$MIN_FILES" ]]; then
    echo "ERROR: only $FILE_COUNT files in $DATA_DIR (expected >= $MIN_FILES)." >&2
    echo "       Refusing to run. If the data really did shrink this much, something" >&2
    echo "       destructive happened — read the runbook before touching the bucket." >&2
    exit 3
fi

# One run at a time. A slow sync must not overlap the next cron tick.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    warn "another backup run holds $LOCK_FILE — skipping this tick"
    trap - EXIT
    exit 0
fi

# Fail fast and legibly if the instance role cannot be resolved, rather than
# emitting a confusing S3 error halfway through the sync (same courtesy
# deploy-staging.sh extends for its named profile).
FAILED_STEP="AWS credential check"
if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "ERROR: no usable AWS credentials." >&2
    echo "       Expected the EC2 instance role via IMDSv2. Check that an instance" >&2
    echo "       profile is attached and that this is running on the host (not in a" >&2
    echo "       container — IMDSv2 hop limit is 1)." >&2
    exit 4
fi

mkdir -p "$STATE_DIR"
LAST_SUCCESS_FILE="$STATE_DIR/last-success"

# ------------------------------------------------------------ the sync ------
# WHY NO --delete
# ---------------
# --delete would make the bucket a mirror: anything gone locally is removed
# remotely. That is precisely the failure this backup exists to survive. A bad
# migration or a stray `rm -rf` would be faithfully replicated to the backup on
# the very next run, and the one copy that could have saved us is gone.
#
# Bucket versioning does soften that — a --delete would write delete markers
# rather than truly destroying data, so it is *recoverable*. But recovering
# means enumerating delete markers and restoring per-object versions under
# pressure, which is exactly the procedure nobody wants to be learning during
# an incident. Without --delete a restore is a plain `aws s3 sync` back.
#
# The cost of omitting it: objects deleted locally linger in the bucket, so a
# restore returns a SUPERSET of the current dataset. For ~190 MB of JSON the
# storage cost is noise, and the app keys everything by id off index.json, so a
# resurrected orphan file is inert rather than corrupting. The runbook's
# restore procedure calls this out explicitly.
#
# Belt and braces: bucket versioning is the second layer, and the IAM policy
# denies the instance any Delete* on this bucket at all, so even a fully
# compromised box cannot erase the backups it writes.
#
# WHY A SINGLE PREFIX, NOT A DATED ONE
# ------------------------------------
# A dated prefix (s3://bucket/2026-08-24/...) starts empty every run, so sync
# has nothing to compare against and re-uploads all ~7,000 objects and ~190 MB
# every single day. That throws away the incremental behaviour that is the
# entire reason for syncing instead of tarring. Versioning gives point-in-time
# recovery without re-uploading unchanged objects, so: one stable prefix,
# versioning on, lifecycle rule to bound how long old versions are kept.
#
# *.tmp is excluded: the backend writes JSON atomically as
# "<name>.<pid>.<tid>.tmp" then os.replace()s it into place
# (ultistats_server/storage/file_utils.py), so any .tmp seen mid-sync is
# transient scratch, not data.
SYNC_ARGS=(
    "$DATA_DIR/" "s3://$BUCKET/data/"
    --exclude '*.tmp'
    --exclude '.writable-probe-*'
    --no-progress
    --sse AES256
)
# STANDARD, deliberately not STANDARD_IA. IA bills every object at a 128 KB
# minimum; with ~7,000 mostly-small JSON files that inflates ~190 MB of real
# data into ~900 MB of billable storage, so IA would cost MORE here despite the
# lower per-GB rate. At this size the whole thing is a few cents a month.
[[ $DRY_RUN -eq 1 ]] && SYNC_ARGS+=(--dryrun)

FAILED_STEP="s3 sync of $DATA_DIR"
log "starting backup: $FILE_COUNT files in $DATA_DIR -> s3://$BUCKET/data/${DRY_RUN:+ (dry run)}"

SYNC_LOG=$(mktemp)

if ! aws s3 sync "${SYNC_ARGS[@]}" >"$SYNC_LOG" 2>&1; then
    warn "sync failed; last lines follow"
    tail -20 "$SYNC_LOG" >&2
    alert "DATA BACKUP FAILED (s3 sync)" \
          "aws s3 sync returned non-zero backing up $DATA_DIR to s3://$BUCKET/data/

Last output:
$(tail -20 "$SYNC_LOG")"
    rm -f "$SYNC_LOG"
    trap - EXIT
    exit 5
fi

UPLOADED=$(grep -c '^upload:' "$SYNC_LOG" || true)
log "sync complete: $UPLOADED object(s) uploaded"
rm -f "$SYNC_LOG"

# ------------------------------------------- local snapshot tarballs --------
# /var/backups/breakside/*.tgz are dated point-in-time snapshots that already
# exist on the box. They are tiny (this dataset compresses roughly 23:1) and
# they are the easiest thing to restore from, but they are on the SAME DISK as
# the data, so they protect against nothing that matters. Shipping them costs
# almost nothing and buys dated restore points to complement versioning — and
# it means the local copies can be pruned to reclaim disk.
if [[ -d "$LOCAL_SNAPSHOT_DIR" ]] && compgen -G "$LOCAL_SNAPSHOT_DIR/*.tgz" >/dev/null; then
    FAILED_STEP="s3 sync of $LOCAL_SNAPSHOT_DIR"
    SNAP_ARGS=("$LOCAL_SNAPSHOT_DIR/" "s3://$BUCKET/snapshots/" --exclude '*' --include '*.tgz' --no-progress --sse AES256)
    [[ $DRY_RUN -eq 1 ]] && SNAP_ARGS+=(--dryrun)
    if aws s3 sync "${SNAP_ARGS[@]}" >/dev/null 2>&1; then
        log "snapshot tarballs synced to s3://$BUCKET/snapshots/"
    else
        warn "snapshot tarball sync failed (the main data sync succeeded)"
    fi
fi

# ---------------------------------------------------- freshness beacon ------
# Publish a tiny status object. This is what makes "the backup quietly stopped"
# detectable from anywhere — one `aws s3 ls s3://BUCKET/_status/` from a laptop
# answers "when did this last work?" without shelling into the box. A
# failure-only email cannot tell you that cron stopped firing; a timestamp
# that stops advancing can.
if [[ $DRY_RUN -eq 0 ]]; then
    FAILED_STEP="status beacon upload"
    NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    STATUS_JSON=$(mktemp)
    printf '{"last_success":"%s","host":"%s","files":%s,"uploaded":%s,"data_dir":"%s"}\n' \
        "$NOW_ISO" "$(hostname)" "$FILE_COUNT" "$UPLOADED" "$DATA_DIR" >"$STATUS_JSON"
    aws s3 cp "$STATUS_JSON" "s3://$BUCKET/_status/last-success.json" \
        --content-type application/json --sse AES256 --only-show-errors || \
        warn "could not write status beacon (backup itself succeeded)"
    rm -f "$STATUS_JSON"

    # Staleness check against the PREVIOUS run, evaluated after this one
    # succeeded so a recovered backup does not keep nagging.
    if [[ -f "$LAST_SUCCESS_FILE" ]]; then
        PREV=$(cat "$LAST_SUCCESS_FILE" 2>/dev/null || echo 0)
        AGE_DAYS=$(( ( $(date +%s) - PREV ) / 86400 ))
        if [[ "$AGE_DAYS" -ge "$STALE_DAYS" ]]; then
            alert "Data backup had been stale for $AGE_DAYS days" \
                  "This run succeeded, but the previous successful backup was $AGE_DAYS days ago.
Something stopped the schedule in between. Check /etc/cron.d/breakside-backup
and: sudo journalctl -t $LOG_TAG --since '$AGE_DAYS days ago'"
        fi
    fi
    date +%s >"$LAST_SUCCESS_FILE"
fi

log "backup OK: $FILE_COUNT files present, $UPLOADED uploaded, bucket s3://$BUCKET"
trap - EXIT
exit 0
