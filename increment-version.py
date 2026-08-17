#!/usr/bin/env python3
"""Version management for Breakside.

The semver STRING (major.minor.patch) in version.json is committed to the
repo and bumped manually with the major/minor/patch commands.

The BUILD number is NOT committed. It is computed at deploy time as
`git rev-list --count HEAD` (monotonic on main) and stamped into the
*deployed* copies of version.json and service-worker.js by the `stamp`
command, used by .github/workflows/main.yml (production) and
scripts/deploy-staging.sh (staging). The committed files carry the
placeholder build "dev" / cacheName 'build-dev'. See VERSIONING.md.
"""

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

VERSION_FILE = 'version.json'
SERVICE_WORKER_FILE = 'service-worker.js'
DEPLOY_EXCLUDES_FILE = 'scripts/deploy-excludes.txt'

LEVELS = ('major', 'minor', 'patch')

# ---------------------------------------------------------------------------
# Precache manifest
# ---------------------------------------------------------------------------
# Generated from the files actually being deployed, using the SAME exclude list
# as the S3 sync, so the manifest cannot list something that was never uploaded
# (a 404 the client would then retry on every install).
#
# Only the app shell. Runtime caching still handles everything else, so the
# question here is "what must be present for a cold offline launch to reach a
# usable screen", not "what might the user want later".

# Extensions that can be part of the shell. jpg/jpeg are deliberately absent:
# they're landing-page screenshots, dozens of them, none needed to boot.
PRECACHE_EXTENSIONS = {
    '.html', '.css', '.js', '.json', '.svg',
    '.png', '.ico', '.webp', '.woff', '.woff2',
}

# Never precache, whatever their extension:
#   version.json     — update detection compares the SERVER's copy against the
#                      running build. A cached one freezes update detection.
#   service-worker.js — the worker is versioned by the browser, not by us; both
#                      of these are uploaded separately with no-cache headers.
PRECACHE_NEVER = {'version.json', 'service-worker.js'}

# One oversized asset would evict the rest of the shell on a tight quota.
# images/logo.png is ~500 KB and IS the splash, so the cap has to clear it.
PRECACHE_MAX_FILE_BYTES = 1_500_000
# A whole shell far past this means something unintended got swept in.
PRECACHE_MAX_TOTAL_BYTES = 12_000_000


def _load_deploy_excludes(root='.'):
    """Patterns from scripts/deploy-excludes.txt (blank/# lines ignored)."""
    path = os.path.join(root, DEPLOY_EXCLUDES_FILE)
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [ln.strip() for ln in f
                if ln.strip() and not ln.lstrip().startswith('#')]


def _is_excluded(rel_path, patterns):
    """Mirror `aws s3 sync --exclude` matching for one relative path."""
    for pat in patterns:
        if fnmatch.fnmatch(rel_path, pat):
            return True
        # `dir/*` should exclude the whole subtree, as it does for s3 sync.
        if pat.endswith('/*') and (rel_path == pat[:-2]
                                   or rel_path.startswith(pat[:-1])):
            return True
        # A bare name (e.g. `.git`) excludes that path and anything under it.
        if '*' not in pat and (rel_path == pat or rel_path.startswith(pat + '/')):
            return True
    return False


def build_precache_manifest(root='.'):
    """Root-relative URLs for the app shell, sorted for a stable diff.

    Returns (urls, total_bytes, skipped_too_big).
    """
    patterns = _load_deploy_excludes(root)
    urls, total, too_big = [], 0, []

    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = '' if rel_dir == '.' else rel_dir.replace(os.sep, '/')
        # Prune excluded directories so we never descend into node_modules etc.
        dirnames[:] = [
            d for d in dirnames
            if not _is_excluded(f'{rel_dir}/{d}'.lstrip('/'), patterns)
        ]
        for name in filenames:
            rel = f'{rel_dir}/{name}'.lstrip('/')
            if name in PRECACHE_NEVER or _is_excluded(rel, patterns):
                continue
            if os.path.splitext(name)[1].lower() not in PRECACHE_EXTENSIONS:
                continue
            size = os.path.getsize(os.path.join(dirpath, name))
            if size > PRECACHE_MAX_FILE_BYTES:
                too_big.append((rel, size))
                continue
            urls.append('/' + rel)
            total += size

    urls.sort()
    # The PWA's start_url is the bare origin, which is a DIFFERENT cache key
    # from /index.html — caches.match() compares full URLs. A home-screen launch
    # requests '/', so without this the one request that matters most misses.
    if '/index.html' in urls:
        urls.insert(0, '/')
    return urls, total, too_big


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def read_version():
    with open(VERSION_FILE) as f:
        return json.load(f)


def write_version(data, path=VERSION_FILE):
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')


def bump(level):
    """Bump one component of the committed semver string; lower components reset to 0."""
    data = read_version()
    parts = [int(x) for x in data['version'].split('.')]
    idx = LEVELS.index(level)
    parts[idx] += 1
    parts[idx + 1:] = [0] * (2 - idx)
    data['version'] = '.'.join(map(str, parts))
    data['lastUpdated'] = utc_now_iso()
    write_version(data)
    print(f"Version updated: {data['version']}")


def deploy_build_number():
    return subprocess.check_output(
        ['git', 'rev-list', '--count', 'HEAD'], text=True).strip()


def stamp(args):
    """Write the deploy-time build number into deploy copies of version.json / service-worker.js."""
    build = args.build or deploy_build_number()

    data = read_version()
    data['build'] = build
    data['lastUpdated'] = utc_now_iso()
    if args.deploy_stamp:
        data['deployStamp'] = args.deploy_stamp
    if args.deploy_label:
        data['deployLabel'] = args.deploy_label
    write_version(data, args.out_version)

    cache_name = f'build-{build}' + (f'-{args.cache_suffix}' if args.cache_suffix else '')
    with open(SERVICE_WORKER_FILE) as f:
        sw = f.read()
    new_sw, n = re.subn(r"const cacheName = '[^']*';",
                        f"const cacheName = '{cache_name}';", sw, count=1)
    if n != 1:
        sys.exit('error: could not find the cacheName declaration in service-worker.js')

    urls, total, too_big = build_precache_manifest()
    manifest = 'const PRECACHE_URLS = [\n' + \
               ''.join(f"    '{u}',\n" for u in urls) + '];'
    new_sw, n = re.subn(r'const PRECACHE_URLS = \[[^\]]*\];', manifest, new_sw, count=1)
    if n != 1:
        sys.exit('error: could not find the PRECACHE_URLS declaration in service-worker.js')
    if total > PRECACHE_MAX_TOTAL_BYTES:
        sys.exit(f'error: precache manifest is {total/1e6:.1f} MB, over the '
                 f'{PRECACHE_MAX_TOTAL_BYTES/1e6:.0f} MB cap — something '
                 f'unintended is being swept in; check PRECACHE_EXTENSIONS '
                 f'and scripts/deploy-excludes.txt')

    with open(args.out_sw, 'w') as f:
        f.write(new_sw)

    print(f"Stamped build {build} (cacheName '{cache_name}') -> "
          f"{args.out_version}, {args.out_sw}")
    print(f"Precache: {len(urls)} files, {total/1e6:.2f} MB")
    for rel, size in too_big:
        print(f"  skipped (over {PRECACHE_MAX_FILE_BYTES/1e6:.1f} MB): {rel} "
              f"({size/1e6:.1f} MB)")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command')
    for level in LEVELS:
        sub.add_parser(level, help=f'bump the {level} component of the committed version string')
    p_stamp = sub.add_parser('stamp', help='stamp the deploy-time build number (deploy scripts only)')
    p_stamp.add_argument('--build',
                         help='override the build number (default: git rev-list --count HEAD)')
    p_stamp.add_argument('--deploy-stamp', help='deployStamp value written into version.json')
    p_stamp.add_argument('--deploy-label', help='deployLabel value written into version.json')
    p_stamp.add_argument('--cache-suffix',
                         help="extra suffix for the SW cacheName (e.g. 'stg-<stamp>')")
    p_stamp.add_argument('--out-version', default=VERSION_FILE,
                         help='where to write the stamped version.json (default: in place)')
    p_stamp.add_argument('--out-sw', default=SERVICE_WORKER_FILE,
                         help='where to write the stamped service-worker.js (default: in place)')
    sub.add_parser('build', help='retired — build numbers are stamped at deploy time')
    args = parser.parse_args()

    if args.command in LEVELS:
        bump(args.command)
    elif args.command == 'stamp':
        stamp(args)
    elif args.command == 'build':
        sys.exit("'build' is retired: build numbers are no longer committed. They are "
                 "stamped at deploy time (git rev-list --count HEAD) by "
                 ".github/workflows/main.yml and scripts/deploy-staging.sh. "
                 "See VERSIONING.md.")
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
