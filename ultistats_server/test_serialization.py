"""
Unit tests for serialization functions.

Tests the conversion between app data models and Google Sheets format.
"""

import json
from datetime import datetime
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from sheets.serialization import (
    serialize_point_start,
    serialize_point_end,
    serialize_event,
    serialize_point_to_rows,
    serialize_game_to_sheet_rows,
    format_throw_modifiers,
    format_defense_modifiers,
    format_pull,
    format_turnover_type,
    format_violation_type,
)


def test_format_throw_modifiers():
    """Test throw modifier formatting."""
    # Test with all flags
    event = {
        'huck_flag': True,
        'break_flag': True,
        'dump_flag': False,
        'hammer_flag': True,
        'sky_flag': True,
        'layout_flag': False,
        'score_flag': True,
    }
    result = format_throw_modifiers(event)
    assert 'huck' in result
    assert 'break' in result
    assert 'hammer' in result
    assert 'sky' in result
    assert 'score' in result
    assert 'dump' not in result
    assert 'layout' not in result
    print("✓ format_throw_modifiers test passed")


def test_format_defense_modifiers():
    """Test defense modifier formatting."""
    event = {
        'interception_flag': True,
        'layout_flag': True,
        'sky_flag': False,
        'Callahan_flag': False,
        'stall_flag': False,
        'unforcedError_flag': False,
    }
    result = format_defense_modifiers(event)
    assert 'interception' in result
    assert 'layout' in result
    assert 'sky' not in result
    print("✓ format_defense_modifiers test passed")


def test_format_pull():
    """Test pull formatting."""
    event = {
        'puller': {'name': 'John Doe'},
        'quality': 'Good Pull',
        'flick_flag': True,
        'io_flag': True,
    }
    result = format_pull(event)
    assert 'John Doe' in result
    assert 'Good Pull' in result
    assert 'flick' in result
    assert 'io' in result
    print("✓ format_pull test passed")
    
    # Test with unknown player
    event2 = {
        'puller': None,
        'quality': 'Brick',
    }
    result2 = format_pull(event2)
    assert 'Unknown Player' in result2
    assert 'Brick' in result2
    print("✓ format_pull (unknown player) test passed")


def test_serialize_point_start():
    """Test point start serialization."""
    point = {
        'players': ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve', 'Frank', 'Grace'],
        'startingPosition': 'offense',
        'startTimestamp': datetime(2024, 1, 15, 10, 0, 0),
    }
    row = serialize_point_start(point, point_num=1)
    
    assert row[0] == '1'  # Point #
    assert '2024-01-15' in row[1]  # Point Start Time
    assert row[2] == 'Offense'  # Starting Position
    assert 'Alice' in row[3]  # Active Players
    assert 'Bob' in row[3]
    print("✓ serialize_point_start test passed")


def test_serialize_point_end():
    """Test point end serialization."""
    point = {
        'endTimestamp': datetime(2024, 1, 15, 10, 5, 0),
        'totalPointTime': 300000,  # 5 minutes in milliseconds
        'winner': 'team',
    }
    game_scores = {'team': 1, 'opponent': 0}
    row = serialize_point_end(point, point_num=1, game_scores=game_scores)
    
    assert row[0] == '1'  # Point #
    assert '2024-01-15' in row[4]  # Point End Time
    assert row[5] == '300'  # Point Duration (seconds)
    assert row[6] == 'team'  # Point Winner
    assert row[7] == '1-0'  # Score After Point
    print("✓ serialize_point_end test passed")


def test_serialize_throw_event():
    """Test throw event serialization."""
    event = {
        'type': 'Throw',
        'thrower': {'name': 'Alice'},
        'receiver': {'name': 'Bob'},
        'huck_flag': True,
        'sky_flag': True,
        'score_flag': True,
    }
    row = serialize_event(event, point_num=1, possession_num=1, possession_type='offensive')
    
    assert row[0] == '1'  # Point #
    # Thrower is column I = index 8
    assert row[8] == 'Alice'  # Thrower
    # Receiver is column J = index 9
    assert row[9] == 'Bob'  # Receiver
    # Throw Modifiers is column K = index 10
    assert 'huck' in row[10]  # Throw Modifiers
    assert 'sky' in row[10]
    assert 'score' in row[10]
    print("✓ serialize_throw_event test passed")


def test_serialize_defense_event():
    """Test defense event serialization."""
    event = {
        'type': 'Defense',
        'defender': {'name': 'Dave'},
        'interception_flag': True,
        'layout_flag': True,
    }
    row = serialize_event(event, point_num=1, possession_num=1, possession_type='defensive')
    
    assert row[11] == 'Dave'  # Defender (Column L = index 11)
    assert 'interception' in row[12]  # Defense Modifiers (Column M = index 12)
    assert 'layout' in row[12]  # Defense Modifiers (Column M = index 12)
    print("✓ serialize_defense_event test passed")


def test_serialize_turnover_event():
    """Test turnover event serialization."""
    event = {
        'type': 'Turnover',
        'thrower': {'name': 'Alice'},
        'receiver': {'name': 'Bob'},
        'drop_flag': True,
        'huck_flag': True,
        'defense_flag': True,
    }
    row = serialize_event(event, point_num=1, possession_num=1, possession_type='offensive')
    
    assert row[13] == 'drop'  # Turnover Type (Column N = index 13)
    assert row[14] == 'Bob'  # Turnover Player (Column O = index 14)
    assert 'huck' in row[15]  # Turnover Modifiers (Column P = index 15)
    assert 'defense' in row[15]  # Turnover Modifiers (Column P = index 15)
    print("✓ serialize_turnover_event test passed")


def test_serialize_pull_event():
    """Test pull event serialization."""
    event = {
        'type': 'Pull',
        'puller': {'name': 'John Doe'},
        'quality': 'Good Pull',
        'flick_flag': True,
        'io_flag': True,
    }
    row = serialize_event(event, point_num=1, possession_num=1, possession_type='offensive')
    
    assert 'John Doe' in row[7]  # Pull (Column H = index 7)
    assert 'Good Pull' in row[7]
    assert 'flick' in row[7]
    assert 'io' in row[7]
    print("✓ serialize_pull_event test passed")


def test_serialize_point_to_rows():
    """Test full point serialization."""
    point = {
        'players': ['Alice', 'Bob', 'Charlie'],
        'startingPosition': 'offense',
        'startTimestamp': datetime(2024, 1, 15, 10, 0, 0),
        'endTimestamp': datetime(2024, 1, 15, 10, 5, 0),
        'totalPointTime': 300000,
        'winner': 'team',
        'possessions': [
            {
                'offensive': True,
                'events': [
                    {
                        'type': 'Throw',
                        'thrower': {'name': 'Alice'},
                        'receiver': {'name': 'Bob'},
                        'huck_flag': True,
                    },
                    {
                        'type': 'Defense',
                        'defender': {'name': 'Dave'},
                        'interception_flag': True,
                    },
                ],
            },
        ],
    }
    scores_before = {'team': 0, 'opponent': 0}
    scores_after = {'team': 1, 'opponent': 0}
    
    rows = serialize_point_to_rows(point, point_num=1, game_scores_before=scores_before, game_scores_after=scores_after)
    
    # Should have: point start + 2 events + point end = 4 rows
    assert len(rows) == 4
    
    # Check point start row
    assert rows[0][0] == '1'
    assert rows[0][2] == 'Offense'
    
    # Check first event (throw)
    assert rows[1][8] == 'Alice'  # Thrower (Column I = index 8)
    assert rows[1][9] == 'Bob'  # Receiver (Column J = index 9)
    
    # Check second event (defense)
    assert rows[2][11] == 'Dave'  # Defender (Column L = index 11)
    
    # Check point end row
    assert rows[3][6] == 'team'  # Winner
    assert rows[3][7] == '1-0'  # Score
    print("✓ serialize_point_to_rows test passed")


def test_serialize_game_to_sheet_rows():
    """Test full game serialization."""
    game = {
        'team': 'My Team',
        'opponent': 'Opponent Team',
        'gameStartTimestamp': datetime(2024, 1, 15, 10, 0, 0),
        'gameEndTimestamp': None,
        'scores': {'team': 1, 'opponent': 0},
        'points': [
            {
                'players': ['Alice', 'Bob'],
                'startingPosition': 'offense',
                'startTimestamp': datetime(2024, 1, 15, 10, 0, 0),
                'endTimestamp': datetime(2024, 1, 15, 10, 5, 0),
                'totalPointTime': 300000,
                'winner': 'team',
                'possessions': [
                    {
                        'offensive': True,
                        'events': [
                            {
                                'type': 'Throw',
                                'thrower': {'name': 'Alice'},
                                'receiver': {'name': 'Bob'},
                                'score_flag': True,
                            },
                        ],
                    },
                ],
            },
        ],
    }
    
    rows = serialize_game_to_sheet_rows(game)
    
    # Should have: 3 header rows + (point start + event + point end) = 6 rows
    assert len(rows) >= 6
    
    # Check header row 1
    assert 'My Team' in rows[0][0]
    assert 'Opponent Team' in rows[0][0]
    
    # Check header row 2 (column headers)
    assert rows[1][0] == 'Point #'
    assert rows[1][9] == 'Thrower'
    
    # Check first point start
    assert rows[3][0] == '1'  # Point #
    assert rows[3][2] == 'Offense'
    
    print("✓ serialize_game_to_sheet_rows test passed")


def run_all_tests():
    """Run all tests."""
    print("Running serialization tests...\n")
    
    try:
        test_format_throw_modifiers()
        test_format_defense_modifiers()
        test_format_pull()
        test_serialize_point_start()
        test_serialize_point_end()
        test_serialize_throw_event()
        test_serialize_defense_event()
        test_serialize_turnover_event()
        test_serialize_pull_event()
        test_serialize_point_to_rows()
        test_serialize_game_to_sheet_rows()
        
        print("\n✅ All tests passed!")
        return True
    except AssertionError as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False
    except Exception as e:
        print(f"\n❌ Error running tests: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == '__main__':
    run_all_tests()

