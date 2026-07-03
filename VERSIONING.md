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
- `.git/hooks/post-commit` — creates release tags (see below)

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

To create a release tag, include "release" or "Release" in your commit message:

```bash
git commit -m "Add new feature - release"
```

The post-commit hook creates a git tag like `v1.9.0` from the version string.

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
