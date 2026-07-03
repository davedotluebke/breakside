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
import json
import re
import subprocess
import sys
from datetime import datetime, timezone

VERSION_FILE = 'version.json'
SERVICE_WORKER_FILE = 'service-worker.js'

LEVELS = ('major', 'minor', 'patch')


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
    with open(args.out_sw, 'w') as f:
        f.write(new_sw)

    print(f"Stamped build {build} (cacheName '{cache_name}') -> "
          f"{args.out_version}, {args.out_sw}")


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
