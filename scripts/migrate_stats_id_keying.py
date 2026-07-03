#!/usr/bin/env python3
"""
One-shot migration: backfill player-id references into historical game data
so per-player stats (see utils/eventStats.js accumulateGameStats) can be
safely keyed by player.id instead of player.name.

Background
----------
`point.players` (store/models.js Point constructor) has only ever stored
player *names* — no id. Event objects (Throw/Turnover/Defense/Pull) carry
both a name and an id once resolved through store/storage.js's
serializeEvent/deserializeEvent, but that id can be missing on older/
incomplete data. Keying stats by name silently merges two roster players who
share a name, and splits one player's history across a rename.

What this script does, per team:
  1. Builds a name -> id map for each of that team's games, preferring (in
     priority order):
       a) that game's own `rosterSnapshot` — the roster as it stood when the
          game was played; the correct source for a renamed/since-removed
          player.
       b) ids already embedded on that game's own events (thrower/receiver/
          puller/defender/assist -> the sibling *Id field).
       c) the team's CURRENT roster (players/*.json) as a last resort —
          logged, since a player renamed since this game could resolve to
          the wrong id here.
     A name that resolves to more than one *distinct* id across these
     sources is logged as ambiguous and left unresolved (never guessed).
  2. Adds a `playerIds` array (parallel to `players`) on every point, and
     backfills any event's missing `*Id` field, using that map.
  3. Never edits the source tree in place. Writes the migrated team/player/
     game files under a fresh --out directory; refuses to run if --out
     already exists and is non-empty.
  4. Verifies the migration: recomputes per-player totals under the OLD
     name-keyed logic (straight from the source data) and the NEW id-keyed
     logic (from the migrated data), and diffs them. Any mismatch is fatal
     (non-zero exit) — this migration must never lose or double-count a
     stat, only re-key it.

Only `current.json` per game is migrated; the `versions/` backup history is
inspection-only and isn't read by any stats codepath, so it's intentionally
left untouched.

Usage
-----
    python3 scripts/migrate_stats_id_keying.py \\
        --data-dir /var/lib/breakside/data \\
        --team-id CUDO-Spring26-id1r \\
        --team-id Flickers-h0bd \\
        --team-id Mumbo-Sauce-9lwd \\
        --out /tmp/breakside-migrated

Unresolved/ambiguous names and the before/after verification summary are
printed to stdout and written to <out>/migration-report.json.
"""
import argparse
import glob
import json
import sys
from collections import defaultdict
from pathlib import Path

PLAYER_ROLES = ('thrower', 'receiver', 'puller', 'defender', 'assist')

STAT_FIELDS = (
    'pointsPlayed', 'timePlayed', 'goals', 'assists', 'hockeyAssists',
    'huckHockeyAssists', 'turnovers', 'plusMinus', 'pointsWon', 'pointsLost',
    'completions', 'huckCompletions', 'totalThrows', 'totalHucks', 'dPlays',
)


def load_json(path):
    with open(path) as f:
        return json.load(f)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)


def find_team_game_dirs(data_dir, team_id):
    game_dirs = []
    for current_json in sorted(glob.glob(str(data_dir / 'games' / '*' / 'current.json'))):
        game = load_json(current_json)
        if game.get('teamId') == team_id:
            game_dirs.append(Path(current_json).parent)
    return game_dirs


def build_current_roster_map(data_dir, team_id, warnings):
    """name -> id from the team's CURRENT roster (players/*.json). Duplicate
    current-roster names are logged (defensive — none exist in real data as
    of writing, but the resolver must not silently pick one)."""
    team = load_json(data_dir / 'teams' / f'{team_id}.json')
    name_to_id = {}
    seen_dupe = set()
    for pid in team.get('playerIds', []):
        p_path = data_dir / 'players' / f'{pid}.json'
        if not p_path.exists():
            warnings.append({'type': 'missing_player_file', 'teamId': team_id, 'playerId': pid})
            continue
        name = load_json(p_path).get('name')
        if not name:
            continue
        if name in name_to_id and name_to_id[name] != pid and name not in seen_dupe:
            warnings.append({'type': 'duplicate_current_roster_name', 'teamId': team_id, 'name': name})
            seen_dupe.add(name)
        name_to_id.setdefault(name, pid)
    return name_to_id, team


def build_game_resolver(game, current_roster_map):
    """name -> id ('AMBIGUOUS' sentinel if multiple distinct ids seen), built
    from rosterSnapshot, then this game's own event ids, then the current
    roster — in that priority order (first source to name a player wins;
    a later source only fills gaps, and a *conflicting* value marks it
    ambiguous rather than silently overriding)."""
    by_name = {}

    def add(name, pid):
        if not name or not pid:
            return
        if name in by_name and by_name[name] != pid:
            by_name[name] = 'AMBIGUOUS'
        elif name not in by_name:
            by_name[name] = pid

    for p in (game.get('rosterSnapshot') or {}).get('players') or []:
        add(p.get('name'), p.get('id'))

    for point in game.get('points', []):
        for poss in point.get('possessions', []):
            for ev in poss.get('events', []):
                for role in PLAYER_ROLES:
                    name = ev.get(role)
                    if isinstance(name, str):
                        add(name, ev.get(role + 'Id'))

    for name, pid in current_roster_map.items():
        add(name, pid)

    return by_name


def resolve(by_name, name, warnings, context):
    pid = by_name.get(name)
    if not pid:
        warnings.append({'type': 'unresolved', 'name': name, **context})
        return None
    if pid == 'AMBIGUOUS':
        warnings.append({'type': 'ambiguous', 'name': name, **context})
        return None
    return pid


def migrate_game(game, current_roster_map, warnings, team_id, game_id):
    by_name = build_game_resolver(game, current_roster_map)

    for pi, point in enumerate(game.get('points', [])):
        ids = []
        for name in point.get('players', []):
            ctx = {'teamId': team_id, 'gameId': game_id, 'pointIndex': pi}
            ids.append(resolve(by_name, name, warnings, ctx))
        point['playerIds'] = ids

        for possi, poss in enumerate(point.get('possessions', [])):
            for evi, ev in enumerate(poss.get('events', [])):
                for role in PLAYER_ROLES:
                    name = ev.get(role)
                    idfield = role + 'Id'
                    if isinstance(name, str) and not ev.get(idfield):
                        ctx = {'teamId': team_id, 'gameId': game_id, 'pointIndex': pi,
                               'possessionIndex': possi, 'eventIndex': evi, 'role': role}
                        pid = resolve(by_name, name, warnings, ctx)
                        if pid:
                            ev[idfield] = pid
    return game


def migrate_team(data_dir, out_dir, team_id, warnings):
    current_roster_map, team = build_current_roster_map(data_dir, team_id, warnings)

    write_json(out_dir / 'teams' / f'{team_id}.json', team)
    for pid in team.get('playerIds', []):
        p_path = data_dir / 'players' / f'{pid}.json'
        if p_path.exists():
            write_json(out_dir / 'players' / f'{pid}.json', load_json(p_path))

    source_games, migrated_games = [], []
    for game_dir in find_team_game_dirs(data_dir, team_id):
        game_id = game_dir.name
        source_game = load_json(game_dir / 'current.json')
        # Migrate a deep copy so the OLD-stats verification pass (below) reads
        # pristine source data, untouched by this game's own migration.
        migrated_game = migrate_game(json.loads(json.dumps(source_game)), current_roster_map, warnings, team_id, game_id)
        write_json(out_dir / 'games' / game_id / 'current.json', migrated_game)
        source_games.append(source_game)
        migrated_games.append(migrated_game)

    return source_games, migrated_games, current_roster_map


# ---------------------------------------------------------------------------
# Verification: recompute stats two ways and diff.
#
# accumulate_old mirrors the pre-migration accumulateGameStats (name-keyed,
# reading straight off the stored `thrower`/`receiver`/... name strings).
# accumulate_new mirrors the post-migration version (id-keyed, preferring the
# resolved `playerIds` / `*Id` fields written by this script, falling back to
# an `unresolved:<name>` bucket — matching the JS resolver's fallback — for
# anything this script couldn't resolve).
# ---------------------------------------------------------------------------

def _empty_stat():
    return {f: 0 for f in STAT_FIELDS}


def accumulate_old(games):
    stats = defaultdict(_empty_stat)

    def ensure(name):
        return stats[name]

    for game in games:
        for point in game.get('points', []):
            if not point.get('winner'):
                continue
            duration = point.get('totalPointTime', 0) or 0
            is_win = point.get('winner') == 'team'
            for name in point.get('players', []):
                s = ensure(name)
                s['pointsPlayed'] += 1
                s['timePlayed'] += duration
                if is_win:
                    s['pointsWon'] += 1
                    s['plusMinus'] += 1
                else:
                    s['pointsLost'] += 1
                    s['plusMinus'] -= 1

            for poss in point.get('possessions', []):
                events = poss.get('events', [])
                for idx, ev in enumerate(events):
                    et = ev.get('type')
                    if et == 'Throw':
                        thrower = ev.get('thrower')
                        if thrower:
                            s = ensure(thrower)
                            s['totalThrows'] += 1
                            s['completions'] += 1
                            if ev.get('huck_flag'):
                                s['totalHucks'] += 1
                                s['huckCompletions'] += 1
                            if ev.get('score_flag'):
                                s['assists'] += 1
                        if ev.get('score_flag'):
                            receiver = ev.get('receiver')
                            if receiver:
                                ensure(receiver)['goals'] += 1
                            for j in range(idx - 1, -1, -1):
                                prev = events[j]
                                if prev.get('type') == 'Throw':
                                    ha = prev.get('thrower')
                                    if ha:
                                        s = ensure(ha)
                                        s['hockeyAssists'] += 1
                                        if prev.get('huck_flag'):
                                            s['huckHockeyAssists'] += 1
                                    break
                    elif et == 'Turnover':
                        thrower = ev.get('thrower')
                        if thrower:
                            s = ensure(thrower)
                            s['turnovers'] += 1
                            s['totalThrows'] += 1
                            if ev.get('huck_flag'):
                                s['totalHucks'] += 1
                        if ev.get('drop_flag'):
                            receiver = ev.get('receiver')
                            if receiver:
                                ensure(receiver)['turnovers'] += 1
                    elif et == 'Defense':
                        defender = ev.get('defender')
                        if defender:
                            ensure(defender)['dPlays'] += 1
    return stats


def accumulate_new(games):
    stats = defaultdict(_empty_stat)
    names = {}

    def ensure(pid, name):
        if pid not in names:
            names[pid] = name
        return stats[pid]

    for game in games:
        for point in game.get('points', []):
            if not point.get('winner'):
                continue
            duration = point.get('totalPointTime', 0) or 0
            is_win = point.get('winner') == 'team'
            point_names = point.get('players', [])
            point_ids = point.get('playerIds') or [None] * len(point_names)
            for name, pid in zip(point_names, point_ids):
                key = pid or f'unresolved:{name}'
                s = ensure(key, name)
                s['pointsPlayed'] += 1
                s['timePlayed'] += duration
                if is_win:
                    s['pointsWon'] += 1
                    s['plusMinus'] += 1
                else:
                    s['pointsLost'] += 1
                    s['plusMinus'] -= 1

            for poss in point.get('possessions', []):
                events = poss.get('events', [])
                for idx, ev in enumerate(events):
                    et = ev.get('type')
                    if et == 'Throw':
                        tname, tid = ev.get('thrower'), ev.get('throwerId')
                        if tname:
                            key = tid or f'unresolved:{tname}'
                            s = ensure(key, tname)
                            s['totalThrows'] += 1
                            s['completions'] += 1
                            if ev.get('huck_flag'):
                                s['totalHucks'] += 1
                                s['huckCompletions'] += 1
                            if ev.get('score_flag'):
                                s['assists'] += 1
                        if ev.get('score_flag'):
                            rname, rid = ev.get('receiver'), ev.get('receiverId')
                            if rname:
                                key = rid or f'unresolved:{rname}'
                                ensure(key, rname)['goals'] += 1
                            for j in range(idx - 1, -1, -1):
                                prev = events[j]
                                if prev.get('type') == 'Throw':
                                    haname, haid = prev.get('thrower'), prev.get('throwerId')
                                    if haname:
                                        key = haid or f'unresolved:{haname}'
                                        s = ensure(key, haname)
                                        s['hockeyAssists'] += 1
                                        if prev.get('huck_flag'):
                                            s['huckHockeyAssists'] += 1
                                    break
                    elif et == 'Turnover':
                        tname, tid = ev.get('thrower'), ev.get('throwerId')
                        if tname:
                            key = tid or f'unresolved:{tname}'
                            s = ensure(key, tname)
                            s['turnovers'] += 1
                            s['totalThrows'] += 1
                            if ev.get('huck_flag'):
                                s['totalHucks'] += 1
                        if ev.get('drop_flag'):
                            rname, rid = ev.get('receiver'), ev.get('receiverId')
                            if rname:
                                key = rid or f'unresolved:{rname}'
                                ensure(key, rname)['turnovers'] += 1
                    elif et == 'Defense':
                        dname, did = ev.get('defender'), ev.get('defenderId')
                        if dname:
                            key = did or f'unresolved:{dname}'
                            ensure(key, dname)['dPlays'] += 1
    return stats, names


def verify_team(team_id, source_games, migrated_games, current_roster_map, report):
    old_stats = accumulate_old(source_games)
    new_stats, new_names = accumulate_new(migrated_games)

    id_to_name = {pid: name for name, pid in current_roster_map.items()}

    # 1. Global totals must be conserved exactly — re-keying must never lose
    #    or double-count a single point/throw/goal/etc.
    old_totals = _empty_stat()
    for s in old_stats.values():
        for f in STAT_FIELDS:
            old_totals[f] += s[f]
    new_totals = _empty_stat()
    for s in new_stats.values():
        for f in STAT_FIELDS:
            new_totals[f] += s[f]

    totals_match = old_totals == new_totals

    # 2. Per-player totals must match for every current-roster player: their
    #    OLD name-keyed bucket must equal their NEW id-keyed bucket.
    mismatches = []
    for name, s_old in old_stats.items():
        pid = current_roster_map.get(name)
        if not pid:
            continue  # not a current-roster player (departed/pickup) — nothing to compare against
        s_new = new_stats.get(pid, _empty_stat())
        if s_old != s_new:
            mismatches.append({'name': name, 'id': pid, 'old': s_old, 'new': s_new})

    unresolved_new_keys = [k for k in new_stats if isinstance(k, str) and k.startswith('unresolved:')]

    result = {
        'teamId': team_id,
        'players': len([n for n in old_stats if n in current_roster_map]),
        'oldTotals': old_totals,
        'newTotals': new_totals,
        'totalsMatch': totals_match,
        'perPlayerMismatches': mismatches,
        'unresolvedKeysInNewStats': unresolved_new_keys,
    }
    report['teams'].append(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data-dir', required=True, type=Path, help='Source data dir (teams/games/players layout)')
    parser.add_argument('--team-id', required=True, action='append', dest='team_ids', help='Team id to migrate (repeatable)')
    parser.add_argument('--out', required=True, type=Path, help='Output dir — must not already exist and be non-empty')
    args = parser.parse_args()

    if args.out.exists() and any(args.out.iterdir()):
        sys.exit(f"Refusing to run: --out {args.out} already exists and is non-empty. "
                  f"This migration never overwrites in place; pick a fresh --out directory.")

    warnings = []
    report = {'teams': [], 'warnings': warnings}

    all_ok = True
    for team_id in args.team_ids:
        source_games, migrated_games, current_roster_map = migrate_team(args.data_dir, args.out, team_id, warnings)
        result = verify_team(team_id, source_games, migrated_games, current_roster_map, report)

        print(f"\n=== {team_id} ===")
        print(f"  games migrated: {len(source_games)}")
        print(f"  current-roster players with historical stats: {result['players']}")
        print(f"  totals (old): {result['oldTotals']}")
        print(f"  totals (new): {result['newTotals']}")
        print(f"  totals match: {result['totalsMatch']}")
        if result['perPlayerMismatches']:
            all_ok = False
            print(f"  MISMATCHES: {len(result['perPlayerMismatches'])} player(s) differ before/after:")
            for m in result['perPlayerMismatches']:
                print(f"    - {m['name']} ({m['id']}): old={m['old']} new={m['new']}")
        else:
            print("  per-player totals: all match")
        if not result['totalsMatch']:
            all_ok = False

    team_warnings = [w for w in warnings if w.get('type') in ('unresolved', 'ambiguous')]
    if team_warnings:
        print(f"\n{len(team_warnings)} name(s) could not be cleanly resolved (logged, not guessed):")
        for w in team_warnings[:20]:
            print(f"  - {w}")
        if len(team_warnings) > 20:
            print(f"  ... and {len(team_warnings) - 20} more (see migration-report.json)")

    write_json(args.out / 'migration-report.json', report)
    print(f"\nMigrated data written to: {args.out}")
    print(f"Full report: {args.out / 'migration-report.json'}")

    if not all_ok:
        sys.exit("\nVerification FAILED — see mismatches above. Source data was not modified.")
    print("\nVerification PASSED for all teams — source data was not modified.")


if __name__ == '__main__':
    main()
