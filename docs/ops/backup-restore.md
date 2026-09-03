# Data backup and restore

**Status: NOT YET INSTALLED.** Everything below is prepared but nothing has been
created in AWS. Until you work through §2–§5 there is still exactly one copy of
every team, roster and game in existence.

---

## 1. Why this exists, and what it does not cover

The backend keeps all state as JSON files under `/var/lib/breakside/data` on a
single EC2 instance, on a single EBS volume. There is no database, no replica
and — until this runbook is executed — **no off-instance copy at all**. An EBS
failure, a bad migration, or one mistyped `rm -rf` destroys every team, roster
and game permanently.

`/var/backups/breakside/*.tgz` is **not** a backup. It is on the same disk as
the data it protects, so it dies in exactly the scenarios that matter.

Measured on the live box (2026-08-24):

| | |
|---|---|
| Data size | 188 MB |
| File count | 7,091 |
| Compressed (`.tgz`) | ~8 MB — roughly 23:1 |
| Root volume | 8 GB, **79% used, 1.7 GB free** |

That last row is its own risk: this scheme deliberately never writes a large
temp file, because there is not much room to write one into.

**What this protects against:** volume failure, instance loss, bad migration,
accidental deletion, application bugs that corrupt files.

**What it does NOT protect against:** loss of the whole AWS account, or an
attacker with your admin credentials. The backup lives in the same account and
the same region as the data. Cross-account replication is the fix for that and
is noted in §7 as an optional upgrade — decide deliberately rather than
assuming this covers it.

**And it protects against everything above for 30 days, not forever.** The
sync mirrors deletions (so that an erased player is really erased from the
backup too — see §6), and versioning keeps the deleted copy recoverable for 30
days before the lifecycle rule expires it. A disaster you notice within the
month is fully recoverable; one you notice on day 31 is not. That number is a
deliberate trade against the privacy notice's promise, not a limit to shave.

---

## 2. Create the bucket

Pick a bucket name and use it consistently. It is referred to as
`<BACKUP_BUCKET>` throughout; your AWS account ID is `<ACCOUNT_ID>`. **Both are
deliberately left as placeholders — this repository is public.** Substitute the
real values as you type; do not commit them back into any tracked file.

S3 bucket names are globally unique, so pick something unguessable rather than
`breakside-backups`. A random suffix is fine and is a small but real speed bump
against someone probing for your backups.

```bash
export B=<BACKUP_BUCKET>
export AWS_PROFILE=admin        # no usable default profile on this machine
```

```bash
# NOTE: for us-east-1 you must NOT pass --create-bucket-configuration.
# Passing LocationConstraint=us-east-1 is an error, unlike every other region.
aws s3api create-bucket --bucket "$B" --region us-east-1
```

Block all public access — first, before anything is in it:

```bash
aws s3api put-public-access-block --bucket "$B" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

Versioning — this is load-bearing, not optional. It is what turns an overwrite
or a delete-marker into something recoverable:

```bash
aws s3api put-bucket-versioning --bucket "$B" \
  --versioning-configuration Status=Enabled
```

Default encryption at rest:

```bash
aws s3api put-bucket-encryption --bucket "$B" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
```

Lifecycle — this is what turns "erased" into "gone from the backup too", and
what bounds how long old versions accumulate. **The 30 days here is a policy
number**: it is what the privacy notice promises, and it is also the window
you have to notice and undo an accident. Change one, change the other.

```bash
cat > /tmp/backup-lifecycle.json <<'JSON'
{
  "Rules": [
    {
      "ID": "data-expire-noncurrent-30d",
      "Status": "Enabled",
      "Filter": { "Prefix": "data/" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
      "Expiration": { "ExpiredObjectDeleteMarker": true }
    },
    {
      "ID": "snapshots-expire-30d",
      "Status": "Enabled",
      "Filter": { "Prefix": "snapshots/" },
      "Expiration": { "Days": 30 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }
    },
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
JSON

aws s3api put-bucket-lifecycle-configuration \
  --bucket "$B" --lifecycle-configuration file:///tmp/backup-lifecycle.json
```

> **Read these rules before you paste them — each line is load-bearing.**
>
> - **`data/` has NO `Days` expiration.** An `Expiration: { Days }` on the
>   data prefix deletes *current* objects — that is, it deletes the backup.
>   A lifecycle rule is the most common way people quietly destroy their own
>   backups. The `data/` rule touches only **noncurrent** versions (superseded
>   or delete-marked copies), plus `ExpiredObjectDeleteMarker`, which cleans up
>   a zero-byte marker once the versions behind it have all expired.
> - **There is deliberately no `NewerNoncurrentVersions`.** The first draft
>   had `NewerNoncurrentVersions: 5`, which sounds like extra safety and is a
>   trap: it retains the five most recent noncurrent versions of every object
>   *indefinitely*, and only expires versions beyond those. An erased player
>   file has exactly **one** noncurrent version (the copy behind its delete
>   marker), so it would have been kept forever, and the 30-day promise would
>   have been false while the config looked right. Do not add it back.
> - **`snapshots/` is the one place a `Days` expiration is correct.** It holds
>   dated `.tgz` tarballs taken *before* any given erasure, so they must age
>   out too or the promise fails through the side door. They are disposable by
>   design — each is a point in time, never overwritten — so `Days: 30` is
>   safe there and nowhere else. On a versioned bucket that expiry writes a
>   delete marker, hence the 1-day noncurrent purge behind it: a tarball is
>   gone after ~31 days, not 60. **The script prunes the local copies on the
>   same schedule** (`SNAPSHOT_RETENTION_DAYS`, default 30), and only after a
>   successful ship — so `/var/backups/breakside/` stays bounded and the
>   promise holds on the box as well as in the bucket. The two numbers, the
>   script's and this rule's, must agree.
>
> The two rules use non-overlapping prefixes on purpose. S3 rejects some
> combinations of overlapping filters with conflicting `Expiration` actions,
> and "which rule wins" is not something to be reasoning about in an incident.

Verify everything took:

```bash
aws s3api get-bucket-versioning --bucket "$B"          # expect Status: Enabled
aws s3api get-public-access-block --bucket "$B"        # expect all four true
aws s3api get-bucket-encryption --bucket "$B"
aws s3api get-bucket-lifecycle-configuration --bucket "$B"
```

### Optional, decide now or never: Object Lock

Object Lock in governance mode makes objects undeletable even by an admin for a
retention window — real protection against credential compromise and against
your own mistakes. It **can only be enabled reliably at bucket creation**
(`--object-lock-enabled-for-bucket`, which also forces versioning on). Retrofitting
later is awkward. Given that the IAM policy in §3 already denies the instance
any delete, this is belt-and-braces; take it if you want the strongest guarantee,
but decide before you create the bucket.

---

## 3. IAM: a third, separate identity

Two things matter here.

**First: do not widen `breakside-deploy`.** That is the CI robot, scoped to the
two site buckets and CloudFront invalidations. Backups get their own policy.

**Second — and this is the trap: an instance profile called `breakside-ssm` is
already attached to the box, and it is what SSM uses.** `ssh breakside` tunnels
over SSM. An EC2 instance can have only **one** instance profile, so if you
"create and attach a backup instance profile" you *replace* the SSM one and
lock yourself out of the instance. Do not do that.

The correct move is additive: attach one more policy to the **existing**
`breakside-ssm` role. It currently carries only `AmazonSSMManagedInstanceCore`
and has no inline policies, so this is clean.

```bash
cat > /tmp/breakside-backup-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBackupBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::<BACKUP_BUCKET>"
    },
    {
      "Sid": "WriteAndMarkDeleted",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::<BACKUP_BUCKET>/*"
    },
    {
      "Sid": "NeverPurgeOrReconfigure",
      "Effect": "Deny",
      "Action": [
        "s3:DeleteObjectVersion",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:DeleteBucket",
        "s3:PutBucketAcl",
        "s3:PutObjectAcl"
      ],
      "Resource": [
        "arn:aws:s3:::<BACKUP_BUCKET>",
        "arn:aws:s3:::<BACKUP_BUCKET>/*"
      ]
    }
  ]
}
JSON
# substitute the real bucket name into the placeholders before creating:
sed -i '' "s/<BACKUP_BUCKET>/$B/g" /tmp/breakside-backup-policy.json

aws iam create-policy \
  --policy-name BreaksideDataBackupWrite \
  --description "Write-only backup access to the Breakside data backup bucket" \
  --policy-document file:///tmp/breakside-backup-policy.json

aws iam attach-role-policy \
  --role-name breakside-ssm \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/BreaksideDataBackupWrite
```

Why it is shaped this way:

- **No `s3:GetObject`.** The instance can write backups but cannot read them
  back. A compromised box cannot exfiltrate its own backup history. Restores
  run from your laptop with the `admin` profile, deliberately (§5).
- **`s3:DeleteObject` allowed, `s3:DeleteObjectVersion` explicitly denied.**
  This is the whole trick, and it only works because versioning is on. On a
  versioned bucket, `DeleteObject` without a version id does not destroy
  anything — it writes a **delete marker** and the previous copy becomes a
  noncurrent version, recoverable for 30 days. `DeleteObjectVersion` is the
  call that permanently removes a specific version, and that is what the Deny
  blocks. So the script's `--delete` can hide an object (which is what makes an
  erasure real in the backup), but a fully compromised box can only ever *hide*
  history for 30 days; it cannot purge it. The Deny is explicit rather than an
  omission because omission would be undone by any future broad policy on the
  same role; an explicit Deny cannot be overridden.
- **The Deny is scoped to this bucket only**, so it cannot interfere with
  `AmazonSSMManagedInstanceCore`, which needs S3 access to other paths.

Confirm the attachment:

```bash
aws iam list-attached-role-policies --role-name breakside-ssm
# expect BOTH AmazonSSMManagedInstanceCore and BreaksideDataBackupWrite
```

---

## 4. Install on the box

Credentials come from the EC2 instance role over IMDSv2 — nothing is stored on
disk and no access key is involved.

> **Verified, not assumed:** IMDSv2 is enforced on this instance (a token-less
> IMDSv1 request returns HTTP 401) with hop limit 1, and the installed
> `aws-cli/1.18.147` on Python 2.7 *did* resolve instance-role credentials (the box
> has since moved to AL2023, whose bundled `aws-cli/2.x` does the same — verified
> 2026-09-03 with a real run from the new instance). The original check: it
> through it correctly — confirmed under a fully scrubbed `env -i` environment,
> which is what cron gives you. The CLI is ancient but it works for this.
>
> The hop limit is why this must run **directly on the host**. Move it into a
> container and the extra network hop makes the metadata service unreachable,
> and credentials silently disappear.

Config file — this is where the bucket name lives, so it stays out of the
public repo:

```bash
ssh breakside
sudo install -d -m 700 /etc/breakside
printf 'BACKUP_BUCKET=%s\n' '<BACKUP_BUCKET>' | sudo tee /etc/breakside/backup.env >/dev/null
sudo chmod 600 /etc/breakside/backup.env
sudo chown root:root /etc/breakside/backup.env
```

Install the script. It ships in the repo at `/opt/breakside/scripts/backup-data.sh`
(root-owned, refreshed by `scripts/deploy-backend.sh`), but cron runs a copy in
`/usr/local/bin/`, matching where `cert-expiry-check.sh` already lives — and
avoiding the hazard of executing a file that a `git pull` may rewrite mid-run:

```bash
sudo install -m 755 -o root -g root \
  /opt/breakside/scripts/backup-data.sh /usr/local/bin/backup-data.sh
```

> Because it is a copy, **changes to the repo script do not reach cron until you
> re-run that `install` command.** To check for drift:
> `sudo diff /opt/breakside/scripts/backup-data.sh /usr/local/bin/backup-data.sh`

Dry run first — this changes nothing and prints what would upload:

```bash
sudo /usr/local/bin/backup-data.sh --dry-run
```

Then a real first run. This uploads all ~7,000 objects and takes a few minutes;
every later run only ships what changed:

```bash
sudo /usr/local/bin/backup-data.sh
aws s3 ls "s3://$B/data/" --recursive --summarize | tail -3   # from your laptop
```

Install the cron entry:

```bash
sudo tee /etc/cron.d/breakside-backup >/dev/null <<'CRON'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=dave@luebke.us
15 4 * * * root /usr/local/bin/backup-data.sh
CRON
sudo chmod 644 /etc/cron.d/breakside-backup
```

> **The `PATH=` line is not decoration.** cron's default PATH is `/usr/bin:/bin`
> and does not include `/usr/sbin`. That exact gap silently broke certbot
> renewals on this box for three months and eventually took the API down (see
> ARCHITECTURE.md § TLS Certificate Renewal). The script sets its own PATH too,
> and calls `sendmail` by absolute path, but keep this line as the second layer.
>
> `MAILTO` is the third layer: if the script dies so early it cannot mail you
> itself, cron mails whatever it wrote to stderr.

---

## 5. Verify a restore — an untested backup is not a backup

**This is the part that actually matters.** A backup you have never restored is
a hypothesis, not a safety net. Everything above is easy; this section is the
one that tells you whether any of it worked. Do it once now, and again after
any change to the schema or the script.

Restores run from your laptop with the `admin` profile — the instance role
deliberately cannot read the bucket.

### 5a. Restore to scratch and compare

**Never restore over `/var/lib/breakside/data`.** Restore to a scratch
directory and compare first.

```bash
export AWS_PROFILE=admin
export B=<BACKUP_BUCKET>
mkdir -p /tmp/breakside-restore && cd /tmp/breakside-restore

aws s3 sync "s3://$B/data/" ./data
find ./data -type f | wc -l          # compare against the live count
```

Get the live count to compare against (read-only):

```bash
ssh breakside "sudo find /var/lib/breakside/data -type f ! -name '*.tmp' | wc -l"
```

The restored count should **equal the live count exactly**. It used to be
allowed to run higher (orphans lingered when the sync did not mirror deletions);
now that it does, a mismatch in either direction means something is wrong —
most likely a file written between the backup and your count, so re-run the
sync and count again before worrying.

Spot-check that the JSON is intact rather than truncated:

```bash
python3 -c "
import json,pathlib,sys
bad=[]
files=list(pathlib.Path('./data').rglob('*.json'))
for p in files:
    try: json.loads(p.read_text())
    except Exception as e: bad.append((p,e))
print(f'{len(files)} JSON files checked, {len(bad)} unparseable')
[print(' ',p,e) for p,e in bad[:10]]
sys.exit(1 if bad else 0)
"
```

Zero unparseable files is the pass condition. This is a real test: the backend
writes JSON atomically (temp file + `os.replace()`, see
`ultistats_server/storage/file_utils.py`), so no individual file should ever be
captured half-written — this check confirms that guarantee held.

### 5b. Actually boot the app against the restored data

Counting files proves the bytes arrived. It does not prove the app can read
them. Use the existing dev-backend harness to serve the restored copy:

```bash
cd /Users/luebke/src/ultistats
cp -R /tmp/breakside-restore/data .dev-data/restore-test/
./scripts/dev-backend.sh restore-test
```

Then open the PWA against it — `http://localhost:3000/?api=http://localhost:<port>`
— and confirm your real teams, rosters and a completed game's stats all render.
That is the pass condition: **the app works on restored data.** Anything less
is a checksum, not a restore test.

Clean up:

```bash
rm -rf /tmp/breakside-restore /Users/luebke/src/ultistats/.dev-data/restore-test
```

### 5c. The real restore, if you ever need it

```bash
ssh breakside 'sudo systemctl stop breakside'
ssh breakside 'sudo mv /var/lib/breakside/data /var/lib/breakside/data.broken-$(date +%Y%m%d-%H%M%S)'
```

> Move the damaged directory aside, do not delete it. It may hold the only copy
> of something written since the last backup. Mind the 1.7 GB of free disk —
> check `df -h` before duplicating a 188 MB tree, and remove the `.broken-*`
> copy once you are satisfied.

Restore from your laptop into a staging path on the box, then swap it in, fix
ownership, and start:

```bash
# from the laptop, after syncing the backup down to ./data as in 5a
rsync -a ./data/ breakside:/tmp/restored-data/
ssh breakside '
  sudo mv /tmp/restored-data /var/lib/breakside/data &&
  sudo chown -R breakside:breakside /var/lib/breakside/data &&
  sudo systemctl start breakside &&
  sleep 3 && curl -s -o /dev/null -w "health %{http_code}\n" http://127.0.0.1:8000/health
'
```

Ownership matters: the app runs as `breakside` and refuses to boot if the data
directory is not writable.

### 5d. Point-in-time restore

For "the data was fine on Tuesday, a bad migration ran Wednesday", there are two
routes:

1. **The dated tarballs**, which the script also ships to `s3://<BACKUP_BUCKET>/snapshots/`.
   Far easier: pick the dated `.tgz`, download, extract, done.
   ```bash
   aws s3 ls "s3://$B/snapshots/"
   aws s3 cp "s3://$B/snapshots/data-20260823-234307.tgz" .
   tar xzf data-20260823-234307.tgz
   ```
2. **Object versions**, for a single file you need an older copy of — or one
   that was deleted:
   ```bash
   aws s3api list-object-versions --bucket "$B" --prefix "data/teams/<file>.json"
   aws s3api get-object --bucket "$B" --key "data/teams/<file>.json" \
     --version-id <VERSION_ID> ./recovered.json
   ```
   A file the script deleted (via `--delete`) shows up here as a **delete
   marker** on top of its last real version. Fetch that version by id exactly
   as above. **This only works for 30 days** — after that the noncurrent
   version is expired by the lifecycle rule and the file is genuinely gone,
   which is the point: that is what an erasure looks like from the backup's
   side. So the practical rule is: if you think something was wrongly deleted,
   act inside the month.

---

## 6. Design decisions, and what they cost you

**`aws s3 sync` WITH `--delete`, on a versioned bucket, with a 30-day noncurrent
expiration.** The first draft of this runbook omitted `--delete`, and for a
plain backup that is the conservative choice: a mirror replicates a stray
`rm -rf` to the one copy that could have saved you. What changed the answer is
that the app now genuinely erases people. An erasure deletes the player file and
rewrites every game; without `--delete` the rewritten games sync fine but the
deleted file is never touched again, and the erased person's record sits in the
backup with their name in it, forever. A backup that quietly keeps what the
product promised to delete is a privacy failure, not a safety feature.

The three pieces only work together. `--delete` on its own would be reckless.
Versioning turns each delete into a *delete marker* with the real copy kept
behind it as a noncurrent version. The lifecycle rule expires that version after
30 days. And IAM lets the instance write markers (`DeleteObject`) but never purge
versions (`DeleteObjectVersion`). Net: **an accident is recoverable for 30 days
rather than forever, and in exchange an erasure is real in the backup rather
than cosmetic.** The 30 is a policy number — it is the figure the privacy notice
gives, and it is also your window for noticing and undoing a mistake. If you
ever change one, change the other.

*What this does to restore:* it gets simpler, not harder. A delete marker makes
an object invisible to `aws s3 sync`, so **a restore returns exactly the live
dataset** — no orphans, no superset, nothing to clean up afterwards. The only
thing that is now a per-version procedure is recovering something that was
*deleted*, and that must happen inside the 30 days (§5d).

*The honest cost:* a bad migration you do not notice for 31 days is
unrecoverable from this backup. That is a real narrowing versus the
keep-forever draft, and it is why the failure alarm in the script matters and
why §5's restore drill is worth actually doing — you want to find out the
backup is good before you need it, and you have a month, not forever.

**Bucket versioning, not a dated prefix.** A dated prefix
(`s3://bucket/2026-08-24/…`) starts empty on every run, so sync has nothing to
compare against and re-uploads all 7,000 objects and 188 MB *every single day* —
throwing away the incremental behaviour that is the whole reason for syncing
rather than tarring. Versioning gives point-in-time recovery without re-uploading
unchanged objects. Dated restore points still exist, via the `.tgz` snapshots in
§5d.

**Sync, not tar-and-upload.** Incremental, and it never needs temp space — which
matters at 79% disk. Worth knowing though: this dataset compresses about **23:1**
(188 MB → ~8 MB), so a full tarball is much cheaper than it sounds and is far
easier to restore from. That is why the script also ships whatever `.tgz` files
already exist in `/var/backups/breakside/`. If you later want a *scheduled*
snapshot rather than only the ad-hoc ones, adding a weekly `tar` step is cheap —
it just needs ~8 MB of transient disk.

**`STANDARD`, not `STANDARD_IA`.** Counter-intuitive but arithmetic: IA bills
every object at a 128 KB minimum. With ~7,000 mostly-small JSON files that turns
188 MB of real data into ~900 MB of billable storage, so IA would cost *more*
here despite the lower per-GB rate. Expect single-digit cents per month either
way; the first full sync's ~7,000 PUTs cost about $0.04.

**Alarms.** Failures go to syslog (`logger -t breakside-backup`) *and* email via
`/usr/sbin/sendmail`, reusing the pattern already proven on this box by
`/usr/local/bin/cert-expiry-check.sh` — the box relays through Gmail (see
ARCHITECTURE.md § Outbound Mail).

A failure-only alarm has a blind spot: it cannot tell you the job stopped
running altogether. Three mitigations, in increasing order of reliability:
the script warns if the previous success was more than 3 days old; `MAILTO` in
the cron file catches early deaths; and every successful run writes
`s3://<BACKUP_BUCKET>/_status/last-success.json`, so freshness is checkable from
anywhere without shelling into the box:

```bash
aws s3 cp "s3://$B/_status/last-success.json" - 2>/dev/null
```

None of these catch "the instance is off". A external dead-man's-switch
(healthchecks.io, or a CloudWatch alarm on the bucket's `PutRequests` metric) is
the only thing that does. Worth adding; not required to get value from today.

**Refusal to back up a near-empty directory.** If the data dir has fewer than
100 files the script exits non-zero and alarms rather than reporting success.
Uploading the result of a disaster is the one outcome worse than not running.

---

## 7. Optional hardening, in rough priority order

1. **A dead-man's-switch** so a stopped schedule pages you (see §6).
2. **Cross-account replication.** Today the backup shares an account with the
   data, so an account compromise takes both. Replicating to a second account
   whose credentials the app never holds is the real fix.
3. **Cross-region replication**, if you want to survive a region-level event.
4. **Object Lock**, if you did not enable it at creation (§2) and want
   ransomware-grade protection.
5. **Prune the local `.tgz` files** once they are confirmed in S3 — the root
   volume is at 79%.

---

## 8. Quick reference

```bash
# is the backup current?          (laptop, admin profile)
aws s3 cp "s3://$B/_status/last-success.json" -

# run one now                     (box)
sudo /usr/local/bin/backup-data.sh

# what would it upload?           (box, changes nothing)
sudo /usr/local/bin/backup-data.sh --dry-run

# recent backup logs              (box)
sudo journalctl -t breakside-backup --since '7 days ago'

# has the installed copy drifted from the repo?
sudo diff /opt/breakside/scripts/backup-data.sh /usr/local/bin/backup-data.sh
```
