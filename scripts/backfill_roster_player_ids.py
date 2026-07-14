#!/usr/bin/env python3
"""
One-shot backfill: give legacy embedded team rosters stable player ids.

Background
----------
Teams created before the cloud-first player model store their roster ONLY as
an embedded `teamRoster` array inside data/teams/{id}.json — typically with no
per-player `id` fields, no data/players/{id}.json records, and an empty (or
stale) `playerIds`. Every client that loads such a team mints fresh RANDOM ids
for the id-less players on deserialize (store/storage.js deserializePlayer ->
generateShortId), so ids differ per device and even per reload whenever the
server copy is newer. Consequences:

- the client player-sync merge (store/sync.js syncUserTeams) matched players
  strictly by id, so the same player could be appended as a DUPLICATE roster
  entry once any device pushed player records (mitigated client-side by a
  name-fallback merge on the same branch as this script);
- id-era references written while unstable ids were live (point.players
  lines, event *Id fields) fragment per-player stats.

What this script does, per team
-------------------------------
1. Resolves a stable id for every embedded roster player, in priority order
   (never guesses on ambiguity):
     a) keep the player's existing embedded id, if any;
     b) an existing data/players/*.json record referenced by the team's
        `playerIds` whose name matches;
     c) ids for that name found in the team's games (rosterSnapshot first,
        then event thrower/receiver/puller/defender/assist id refs);
     d) a freshly minted id (same format the server generates).
   A name mapping to multiple distinct ids across sources gets a FRESH id and
   is logged — splitting a history is recoverable, silently merging two
   players is not. Duplicate same-name roster entries: only the first can
   claim a resolved id; later ones mint fresh (logged).
2. Writes data/players/{id}.json for every roster player without a record, so
   GET /api/teams/{id}/players serves the full roster.
3. Backfills ids into the embedded teamRoster and rebuilds `playerIds`
   (roster order first, then any pre-existing entries it didn't cover).

Dry-run by default — prints the plan and writes nothing. With --apply, every
file about to be modified is first copied to
<data-dir>/backfill-backups/<timestamp>/ (same relative path), then written
in place. Running twice is a no-op (all ids already present and recorded).

Usage
-----
    # Dry-run over every team:
    python3 scripts/backfill_roster_player_ids.py --data-dir /var/lib/breakside/data

    # Apply to one team:
    python3 scripts/backfill_roster_player_ids.py \
        --data-dir /var/lib/breakside/data \
        --team-id Velvet-Underground-a1b2 --apply
"""
import argparse
import json
import random
import re
import shutil
import string
import sys
from datetime import datetime, timezone
from pathlib import Path

PLAYER_ROLES = ('thrower', 'receiver', 'puller', 'defender', 'assist')
_HASH_CHARS = string.ascii_lowercase + string.digits


def generate_player_id(name, exists):
    """Mirror ultistats_server/storage/id_utils.generate_entity_id +
    ensure_unique_id for players."""
    safe = re.sub(r'[^a-zA-Z0-9\s-]', '', name or '')
    safe = re.sub(r'\s+', '-', safe).strip('-')[:20]
    safe = re.sub(r'-+$', '', safe) or 'player'
    while True:
        pid = f"{safe}-{''.join(random.choice(_HASH_CHARS) for _ in range(4))}"
        if not exists(pid):
            return pid


def load_json(path):
    with open(path) as f:
        return json.load(f)


class Writer:
    """Collects writes; flushes them (with backups) only under --apply."""

    def __init__(self, data_dir, apply):
        self.data_dir = data_dir
        self.apply = apply
        self.backup_dir = data_dir / 'backfill-backups' / datetime.now().strftime('%Y%m%dT%H%M%S')
        self.pending = {}  # Path -> dict

    def stage(self, path, data):
        self.pending[path] = data

    def flush(self):
        if not self.apply:
            return
        for path, data in self.pending.items():
            if path.exists():
                backup = self.backup_dir / path.relative_to(self.data_dir)
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, backup)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, 'w') as f:
                json.dump(data, f, indent=1)


def name_to_ids_from_games(data_dir, team):
    """name -> set of ids seen for that name across the team's games
    (rosterSnapshot + event refs)."""
    out = {}

    def add(name, pid):
        if name and pid:
            out.setdefault(name, set()).add(pid)

    for current in sorted(data_dir.glob('games/*/current.json')):
        try:
            game = load_json(current)
        except (json.JSONDecodeError, OSError):
            continue
        if game.get('teamId') != team.get('id') and game.get('team') != team.get('name'):
            continue
        for p in (game.get('rosterSnapshot') or {}).get('players', []) or []:
            add(p.get('name'), p.get('id'))
        for point in game.get('points', []) or []:
            for poss in point.get('possessions', []) or []:
                for event in poss.get('events', []) or []:
                    for role in PLAYER_ROLES:
                        add(event.get(role), event.get(f'{role}Id'))
    return out


def process_team(team_path, data_dir, writer, report):
    team = load_json(team_path)
    roster = team.get('teamRoster') or []
    if not roster:
        return

    players_dir = data_dir / 'players'
    assigned = set()

    def player_file_exists(pid):
        return pid in assigned or (players_dir / f'{pid}.json').exists()

    # Source (b): player records already referenced by playerIds, by name
    ids_from_files = {}
    for pid in team.get('playerIds', []) or []:
        f = players_dir / f'{pid}.json'
        if f.exists():
            rec = load_json(f)
            ids_from_files.setdefault(rec.get('name'), set()).add(pid)

    # Source (c): ids recorded in this team's games
    ids_from_games = name_to_ids_from_games(data_dir, team)

    team_changed = False
    claimed = set()  # resolved ids already claimed by an earlier roster entry

    for player in roster:
        name = player.get('name')
        source = 'kept'
        if not player.get('id'):
            candidates = ids_from_files.get(name, set()) or ids_from_games.get(name, set())
            candidates = candidates - claimed
            if len(candidates) == 1:
                player['id'] = next(iter(candidates))
                source = 'player-file' if ids_from_files.get(name) else 'game-refs'
            else:
                player['id'] = generate_player_id(name, player_file_exists)
                source = 'minted-ambiguous' if candidates else 'minted'
            team_changed = True
        claimed.add(player['id'])
        assigned.add(player['id'])

        made_record = False
        record_path = players_dir / f"{player['id']}.json"
        if not record_path.exists():
            now = datetime.now(timezone.utc).isoformat()
            writer.stage(record_path, {
                'id': player['id'],
                'name': name,
                'nickname': player.get('nickname') or '',
                'gender': player.get('gender') or 'Unknown',
                'number': player.get('number'),
                'createdAt': player.get('createdAt') or now,
                'updatedAt': now,
            })
            made_record = True

        report.append({
            'team': team.get('name'), 'teamFile': team_path.name,
            'player': name, 'id': player['id'],
            'idSource': source, 'recordCreated': made_record,
        })

    # Rebuild playerIds: roster order first, then preserve extras
    roster_ids = [p['id'] for p in roster]
    extras = [pid for pid in (team.get('playerIds') or []) if pid not in roster_ids]
    if team.get('playerIds') != roster_ids + extras:
        team['playerIds'] = roster_ids + extras
        team_changed = True

    if team_changed:
        # Bumping updatedAt makes clients treat the server copy as newer and
        # re-deserialize the (now id-bearing) embedded roster.
        team['updatedAt'] = datetime.now(timezone.utc).isoformat()
        writer.stage(team_path, team)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data-dir', required=True, type=Path)
    ap.add_argument('--team-id', action='append', help='limit to specific team id(s); default: all teams')
    ap.add_argument('--apply', action='store_true', help='write changes (dry-run without this)')
    args = ap.parse_args()

    teams_dir = args.data_dir / 'teams'
    if not teams_dir.is_dir():
        sys.exit(f'No teams directory at {teams_dir}')

    writer = Writer(args.data_dir, args.apply)
    report = []
    for team_path in sorted(teams_dir.glob('*.json')):
        if args.team_id and team_path.stem not in args.team_id:
            continue
        process_team(team_path, args.data_dir, writer, report)

    changed = [r for r in report if r['idSource'] != 'kept' or r['recordCreated']]
    for r in changed:
        print(f"{r['team']}: {r['player']} -> {r['id']} "
              f"({r['idSource']}{', +record' if r['recordCreated'] else ''})")
    print(f"\n{len(changed)} player entries to fix across "
          f"{len({r['teamFile'] for r in changed})} team(s); "
          f"{sum(1 for r in changed if r['recordCreated'])} player records to create.")
    if args.apply:
        writer.flush()
        print(f"APPLIED. Backups of modified files: {writer.backup_dir}")
    else:
        print('Dry-run only — re-run with --apply to write.')


if __name__ == '__main__':
    main()
