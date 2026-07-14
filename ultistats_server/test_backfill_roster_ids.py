"""
Tests for scripts/backfill_roster_player_ids.py — the one-shot migration that
gives legacy embedded team rosters stable player ids (see the script's
docstring for the unstable-random-id background).
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / 'scripts' / 'backfill_roster_player_ids.py'


def run_script(data_dir, *extra):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), '--data-dir', str(data_dir), *extra],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


@pytest.fixture
def legacy_data_dir(tmp_path):
    """A data dir with one legacy team exercising every id-resolution source:

    - Sterling: no embedded id, but a player record referenced by playerIds
      exists with his name          -> adopts that record's id (player-file)
    - Nico: no id, appears in a game rosterSnapshot                (game-refs)
    - Moe: no id, appears as an event pullerId ref                 (game-refs)
    - Andy: no id, TWO distinct ids across game sources     (minted, ambiguous)
    - Lou + Lou: duplicate names, no ids; first may claim, second mints
    - John: already has an embedded id but no player record   (kept, +record)
    """
    data = tmp_path / 'data'
    write_json(data / 'players' / 'Sterling-s1a2.json', {
        'id': 'Sterling-s1a2', 'name': 'Sterling', 'nickname': '',
        'gender': 'MMP', 'number': '4',
        'createdAt': '2024-01-01T00:00:00Z', 'updatedAt': '2024-01-01T00:00:00Z',
    })
    write_json(data / 'teams' / 'Velvet-Underground-vu01.json', {
        'id': 'Velvet-Underground-vu01', 'name': 'Velvet Underground',
        'playerIds': ['Sterling-s1a2', 'Ghost-gone1'],  # Ghost has no record file
        'updatedAt': '2024-01-01T00:00:00Z',
        'teamRoster': [
            {'name': 'Lou', 'gender': 'MMP'},
            {'name': 'Lou', 'gender': 'MMP'},
            {'name': 'Sterling', 'gender': 'MMP'},
            {'name': 'Nico', 'gender': 'FMP'},
            {'name': 'Moe', 'gender': 'FMP'},
            {'name': 'Andy', 'gender': 'MMP'},
            {'name': 'John', 'gender': 'MMP', 'id': 'John-j0hn'},
        ],
    })
    write_json(data / 'games' / 'vu-game-1' / 'current.json', {
        'teamId': 'Velvet-Underground-vu01',
        'rosterSnapshot': {'players': [
            {'name': 'Nico', 'id': 'Nico-hist'},
            {'name': 'Andy', 'id': 'Andy-aaaa'},
        ]},
        'points': [{'possessions': [{'events': [
            {'type': 'Pull', 'puller': 'Moe', 'pullerId': 'Moe-hist'},
            {'type': 'Throw', 'thrower': 'Andy', 'throwerId': 'Andy-bbbb'},
        ]}]}],
    })
    return data


def load_team(data_dir):
    return json.loads((data_dir / 'teams' / 'Velvet-Underground-vu01.json').read_text())


def test_dry_run_writes_nothing(legacy_data_dir):
    before = load_team(legacy_data_dir)
    out = run_script(legacy_data_dir)
    assert 'Dry-run only' in out
    assert load_team(legacy_data_dir) == before
    assert len(list((legacy_data_dir / 'players').glob('*.json'))) == 1


def test_apply_backfills_ids_records_and_playerIds(legacy_data_dir):
    run_script(legacy_data_dir, '--apply')
    team = load_team(legacy_data_dir)
    roster = team['teamRoster']
    by_name = {}
    for p in roster:
        by_name.setdefault(p['name'], []).append(p)

    # Every roster player now has an id, all distinct
    ids = [p['id'] for p in roster]
    assert all(ids) and len(set(ids)) == len(ids)

    # Resolution sources
    assert by_name['Sterling'][0]['id'] == 'Sterling-s1a2'   # existing record
    assert by_name['Nico'][0]['id'] == 'Nico-hist'           # rosterSnapshot
    assert by_name['Moe'][0]['id'] == 'Moe-hist'             # event ref
    assert by_name['Andy'][0]['id'] not in ('Andy-aaaa', 'Andy-bbbb')  # ambiguous -> minted
    assert by_name['John'][0]['id'] == 'John-j0hn'           # kept

    # Every roster player has a record file the /players endpoint can serve
    for pid in ids:
        record = json.loads((legacy_data_dir / 'players' / f'{pid}.json').read_text())
        assert record['id'] == pid and record['name']

    # playerIds rebuilt in roster order, preserving unknown extras
    assert team['playerIds'][:len(ids)] == ids
    assert 'Ghost-gone1' in team['playerIds']

    # updatedAt bumped so clients re-pull the id-bearing roster
    assert team['updatedAt'] > '2024-01-01T00:00:00Z'

    # Backup of the modified team file exists
    backups = list((legacy_data_dir / 'backfill-backups').glob('*/teams/Velvet-Underground-vu01.json'))
    assert len(backups) == 1


def test_apply_is_idempotent(legacy_data_dir):
    run_script(legacy_data_dir, '--apply')
    team_after_first = load_team(legacy_data_dir)
    out = run_script(legacy_data_dir, '--apply')
    assert '0 player entries to fix' in out
    assert load_team(legacy_data_dir) == team_after_first


def test_team_id_filter(legacy_data_dir):
    write_json(legacy_data_dir / 'teams' / 'Other-Team-ot01.json', {
        'id': 'Other-Team-ot01', 'name': 'Other Team',
        'teamRoster': [{'name': 'Zed', 'gender': 'MMP'}],
    })
    run_script(legacy_data_dir, '--team-id', 'Other-Team-ot01', '--apply')
    # Filtered team fixed, Velvet Underground untouched
    other = json.loads((legacy_data_dir / 'teams' / 'Other-Team-ot01.json').read_text())
    assert other['teamRoster'][0].get('id')
    assert 'id' not in load_team(legacy_data_dir)['teamRoster'][0]
