# Version Management

Breakside has two version identifiers with different lifecycles:

- **Version string** (semver `major.minor.patch`, e.g. `1.9.0`) — committed in
  `version.json`, bumped manually when it matters for humans.
- **Build number** — **never committed**. It is computed and stamped into the
  deployed artifacts at deploy time only. The committed `version.json` carries
  the placeholder `"build": "dev"` (and `service-worker.js` the cacheName
  `'build-dev'`), which is what you see when running locally.

## How deploy-time stamping works

At deploy time, both deploy paths run `increment-version.py stamp`, which:

1. Computes the build number as **`git rev-list --count HEAD`** — the commit
   count of the deployed tree. Deterministic, monotonic on `main`, and requires
   no committed state, bot commits, or hooks.
2. Writes the build number, a fresh UTC `lastUpdated`, and a `deployStamp`
   (staging also gets `deployLabel`) into the **deployed** `version.json`.
3. Rewrites the service-worker `cacheName` to `build-<n>` (staging:
   `build-<n>-stg-<stamp>`), so the browser installs the new SW and purges old
   caches on activate.

Nothing is committed or pushed back to the repo.

The client (`checkForAppUpdate` in `main.js`) detects updates by **inequality**
of build number and deploy stamp — not by ordering — so every stamped deploy is
detected, including staging redeploys with no new commit.

Deploy paths:

- **Production** (`.github/workflows/main.yml`): on push to `main`, CI stamps
  the checkout in place, then syncs to S3 (`version.json` and
  `service-worker.js` are uploaded separately with no-cache headers).
- **Staging** (`scripts/deploy-staging.sh "label"`): stamps into temp copies
  (your working tree is left untouched), then syncs the working directory.

Both syncs share one exclude list: `scripts/deploy-excludes.txt`.

## Files

- `version.json` — committed version string + placeholder build
- `increment-version.py` — semver bumps and the `stamp` command
- `version.sh` — shell wrapper for `increment-version.py`
- `scripts/deploy-excludes.txt` — shared S3 sync exclude list
- `scripts/git-hooks/post-commit` — the post-commit hook that tags version
  bumps; installed as a symlink at `.git/hooks/post-commit` (see below)

The old pre-commit build-bump hook is retired; `.git/hooks/pre-commit` is a
no-op stub. There is no bump on commit, anywhere.

## Usage

```bash
# Bump the committed semver string (commit the result)
python3 increment-version.py patch    # 1.9.0 -> 1.9.1
python3 increment-version.py minor    # 1.9.0 -> 1.10.0
python3 increment-version.py major    # 1.9.0 -> 2.0.0
# (./version.sh patch|minor|major does the same)

# Deploy-time stamping — normally invoked only by the deploy scripts
python3 increment-version.py stamp --help
```

`python3 increment-version.py build` is retired and exits with an explanation.

## Release Tagging

A release is the commit that bumps `version` in `version.json` — normally the
`chore(version): X.Y.Z — ...` commit that follows a merge. The post-commit hook
compares `version.json` in the new commit with its first parent's and, when the
version went up, creates an annotated tag `vX.Y.Z` on that commit. The commit
message plays no part, so the word "release" is safe anywhere. Tags are local
until pushed:

```bash
python3 increment-version.py minor                      # 2.6.1 -> 2.7.0
git commit -am "chore(version): 2.7.0 — what shipped"   # hook: tagged v2.7.0
git push origin main v2.7.0
```

Details:

- Versions are read from the commits (`git show HEAD:version.json`), not from a
  working tree, so a bump committed in a linked worktree is tagged correctly.
- If `vX.Y.Z` already exists the hook says so and leaves it alone. When the
  tagged commit is no longer an ancestor of `HEAD` (the release commit was
  amended or rebased) it prints the `git tag -f` that moves the tag.
- A version *decrease* (reverting a bump) never tags.
- `git merge` runs no post-commit hook. A bump committed on a branch keeps the
  tag it got there, and the tag rides into `main` with the merge, fast-forward
  or not. A squash merge is a new commit, so the hook runs and reports the
  branch tag as "not an ancestor"; move it with the printed command.

The hook is tracked at `scripts/git-hooks/post-commit`. `.git/hooks/` is not
under version control, so each clone installs it once:

```bash
ln -sf ../../scripts/git-hooks/post-commit .git/hooks/post-commit
```

### Tagging from CI

A release that reaches `main` without passing through a laptop is tagged by
`.github/workflows/tag-release.yml`. A Claude Code cloud session's credential
can push only its own `claude/…` branch — never `main`, never a tag — so a
release from one arrives as a merged pull request with no tag (v2.7.1, v2.7.2
and v2.8.0 all did, until the backfill). The workflow runs on every push to
`main` that touches `version.json` and applies the hook's rule to the commits
the push brought (`scripts/tag-releases.sh`): each one that raised the version
gets an annotated `vX.Y.Z` whose message is the commit subject, pushed with the
Actions token. Existing tags are skipped, so a laptop release still tags at
commit time and CI simply agrees; a release merged with a merge commit is
tagged at the bump commit on the branch, not at the merge. Its manual trigger
is the backfill: it tags every untagged release since the newest existing tag
(or since a tag or commit you name; `all` for the whole history), with a
dry-run option. Nine releases from 2025 predate the hook and have no tag; a
few early tags sit near rather than on their bump commit. Both are left as
they are unless someone asks for `all`. The script does the same from a
checkout:

```bash
scripts/tag-releases.sh --dry-run v2.7.0..HEAD   # what the backfill would create
scripts/tag-releases.sh --push v2.7.0..HEAD      # create and push them
```

History: until 2026-09-26 the hook keyed on the substring "release" in the
commit message, on any branch, reading the main checkout's `version.json`. It
tagged unrelated commits that happened to mention the word and missed every
`chore(version)` bump since 2.1.0, so releases 2.1.1 through 2.6.1 were not
tagged at the time.

## Checking the current version

In the app: the version toast / top of the game log shows
`App Version: <version> (Build <n>)` plus the staging `[label]` when present.
Locally the build shows as `dev`.

From the command line, for a deployed environment:

```bash
curl -s https://www.breakside.pro/version.json
curl -s https://staging.breakside.pro/version.json
```

## Troubleshooting

- **Pushed a fix but the PWA serves old code**: check that the GitHub Actions
  deploy ran and the deployed `version.json` build changed (`curl` it). The SW
  cacheName is stamped from the same build number, so a successful deploy
  always moves the cache forward.
- **Build shows `dev` in production**: the stamp step was skipped or failed —
  the deploy workflow should have failed; check the Actions log.
- Version information is loaded asynchronously when the app starts, so it may
  take a moment to appear.
