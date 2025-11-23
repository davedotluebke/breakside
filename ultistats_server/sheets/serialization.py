"""
Serialization functions for converting between app data models and Google Sheets format.

This module handles the conversion between the JavaScript data structures used in the
client app and the human-readable row-by-row format used in Google Sheets game tabs.
"""

from typing import List, Dict, Any, Optional
from datetime import datetime


# Column indices (0-based for Python, but we'll use A1 notation for Sheets)
# Column A = 0, B = 1, etc.
# Based on TODO.md schema:
# A-D: Point Start (Point #, Point Start Time, Starting Position, Active Players)
# E-H: Point End (Point End Time, Point Duration, Point Winner, Score After Point)
# I: Pull
# I-K: Throw (Thrower, Receiver, Throw Modifiers) - NOTE: I-K means columns I, J, K
# L-M: Defense (Defender, Defense Modifiers)
# N-P: Turnover (Turnover Type, Turnover Player, Turnover Modifiers)
# Q-R: Violation (Violation Type, Violation Player)
# S-V: Other Events (Timeout, Injury Sub, Time Cap, Side Switch, Halftime)
# W-X: Possession Tracking (Possession #, Possession Type)
COLUMN_MAP = {
    'point_num': 0,           # A: Point #
    'point_start_time': 1,    # B: Point Start Time
    'starting_position': 2,   # C: Starting Position
    'active_players': 3,       # D: Active Players
    'point_end_time': 4,       # E: Point End Time
    'point_duration': 5,       # F: Point Duration
    'point_winner': 6,         # G: Point Winner
    'score_after_point': 7,   # H: Score After Point
    'pull': 7,                 # H: Pull (Column H = index 7)
    'thrower': 8,              # I: Thrower (Column I = index 8)
    'receiver': 9,             # J: Receiver (Column J = index 9)
    'throw_modifiers': 10,     # K: Throw Modifiers (Column K = index 10)
    'defender': 11,            # L: Defender
    'defense_modifiers': 12,   # M: Defense Modifiers
    'turnover_type': 13,       # N: Turnover Type
    'turnover_player': 14,     # O: Turnover Player
    'turnover_modifiers': 15,  # P: Turnover Modifiers
    'violation_type': 16,      # Q: Violation Type
    'violation_player': 17,    # R: Violation Player
    'timeout': 18,             # S: Timeout
    'injury_sub': 19,         # T: Injury Sub
    'time_cap': 20,           # U: Time Cap
    'side_switch': 21,        # V: Side Switch
    'halftime': 22,           # W: Halftime
    'possession_num': 23,     # X: Possession #
    'possession_type': 24,    # Y: Possession Type (actually column X, but index 24)
}

# Total columns: A through Z = 26 columns (0-25)
# Based on TODO.md: A-D (Point Start), E-H (Point End), I (Pull), I-K (Throw), 
# L-M (Defense), N-P (Turnover), Q-R (Violation), S-V (Other), W-X (Possession)
# Note: Actually 26 columns total (A-Z)
TOTAL_COLUMNS = 26


def format_timestamp(ts: Optional[Any]) -> str:
    """Format a timestamp to ISO string format."""
    if ts is None:
        return ""
    if isinstance(ts, str):
        # Already a string, return as-is
        return ts
    if isinstance(ts, datetime):
        return ts.isoformat()
    # Try to parse as ISO string
    return str(ts)


def format_player_name(player: Any) -> str:
    """Extract player name from player object or string."""
    if player is None:
        return ""
    if isinstance(player, str):
        return player
    if isinstance(player, dict):
        # Handle dictionary with 'name' key
        return player.get('name', '')
    if hasattr(player, 'name'):
        return player.name
    return str(player)


def format_throw_modifiers(throw_event: Dict[str, Any]) -> str:
    """Convert throw event flags to space-separated modifier string."""
    modifiers = []
    if throw_event.get('huck_flag') or throw_event.get('huck'):
        modifiers.append('huck')
    if throw_event.get('break_flag') or throw_event.get('breakmark') or throw_event.get('break'):
        modifiers.append('break')
    if throw_event.get('dump_flag') or throw_event.get('dump'):
        modifiers.append('dump')
    if throw_event.get('hammer_flag') or throw_event.get('hammer'):
        modifiers.append('hammer')
    if throw_event.get('sky_flag') or throw_event.get('sky'):
        modifiers.append('sky')
    if throw_event.get('layout_flag') or throw_event.get('layout'):
        modifiers.append('layout')
    if throw_event.get('score_flag') or throw_event.get('score'):
        modifiers.append('score')
    return ' '.join(modifiers)


def parse_throw_modifiers(modifier_string: str) -> Dict[str, bool]:
    """Parse space-separated modifier string back to flags."""
    if not modifier_string:
        return {}
    flags = set(modifier_string.lower().split())
    return {
        'huck': 'huck' in flags,
        'break': 'break' in flags,
        'dump': 'dump' in flags,
        'hammer': 'hammer' in flags,
        'sky': 'sky' in flags,
        'layout': 'layout' in flags,
        'score': 'score' in flags,
    }


def format_defense_modifiers(defense_event: Dict[str, Any]) -> str:
    """Convert defense event flags to space-separated modifier string."""
    modifiers = []
    if defense_event.get('interception_flag') or defense_event.get('interception'):
        modifiers.append('interception')
    if defense_event.get('layout_flag') or defense_event.get('layout'):
        modifiers.append('layout')
    if defense_event.get('sky_flag') or defense_event.get('sky'):
        modifiers.append('sky')
    if defense_event.get('Callahan_flag') or defense_event.get('Callahan') or defense_event.get('callahan'):
        modifiers.append('Callahan')
    if defense_event.get('stall_flag') or defense_event.get('stall'):
        modifiers.append('stall')
    if defense_event.get('unforcedError_flag') or defense_event.get('unforcedError') or defense_event.get('unforced'):
        modifiers.append('unforced')
    return ' '.join(modifiers)


def parse_defense_modifiers(modifier_string: str) -> Dict[str, bool]:
    """Parse space-separated modifier string back to flags."""
    if not modifier_string:
        return {}
    flags = set(modifier_string.lower().split())
    return {
        'interception': 'interception' in flags,
        'layout': 'layout' in flags,
        'sky': 'sky' in flags,
        'Callahan': 'callahan' in flags,
        'stall': 'stall' in flags,
        'unforcedError': 'unforced' in flags,
    }


def format_turnover_modifiers(turnover_event: Dict[str, Any]) -> str:
    """Convert turnover event flags to space-separated modifier string."""
    modifiers = []
    if turnover_event.get('huck_flag') or turnover_event.get('huck'):
        modifiers.append('huck')
    if turnover_event.get('defense_flag') or turnover_event.get('goodDefense') or turnover_event.get('defense'):
        modifiers.append('defense')
    return ' '.join(modifiers)


def parse_turnover_modifiers(modifier_string: str) -> Dict[str, bool]:
    """Parse space-separated modifier string back to flags."""
    if not modifier_string:
        return {}
    flags = set(modifier_string.lower().split())
    return {
        'huck': 'huck' in flags,
        'defense': 'defense' in flags,
    }


def format_turnover_type(turnover_event: Dict[str, Any]) -> str:
    """Extract turnover type from turnover event."""
    if turnover_event.get('throwaway_flag') or turnover_event.get('throwaway'):
        return 'throwaway'
    if turnover_event.get('drop_flag') or turnover_event.get('receiverError') or turnover_event.get('drop'):
        return 'drop'
    if turnover_event.get('stall_flag') or turnover_event.get('stall'):
        return 'stall'
    if turnover_event.get('unforcedError_flag') or turnover_event.get('unforcedError') or turnover_event.get('unforced'):
        return 'unforced'
    return ''


def format_violation_type(violation_event: Dict[str, Any]) -> str:
    """Extract violation type from violation event."""
    if violation_event.get('ofoul_flag') or violation_event.get('offensive') or violation_event.get('offensive_flag'):
        return 'offensive'
    if violation_event.get('strip_flag') or violation_event.get('strip'):
        return 'strip'
    if violation_event.get('pick_flag') or violation_event.get('pick'):
        return 'pick'
    if violation_event.get('travel_flag') or violation_event.get('travel'):
        return 'travel'
    if violation_event.get('contest_flag') or violation_event.get('contested'):
        return 'contested'
    if violation_event.get('dblteam_flag') or violation_event.get('doubleTeam'):
        return 'doubleTeam'
    return ''


def format_pull(pull_event: Dict[str, Any]) -> str:
    """Format pull event to string: "PlayerName (quality) flags"."""
    puller_name = format_player_name(pull_event.get('puller'))
    if not puller_name:
        puller_name = "Unknown Player"
    
    quality = pull_event.get('quality', '')
    flags = []
    if pull_event.get('flick_flag') or pull_event.get('flick'):
        flags.append('flick')
    if pull_event.get('roller_flag') or pull_event.get('roller'):
        flags.append('roller')
    if pull_event.get('io_flag') or pull_event.get('io'):
        flags.append('io')
    if pull_event.get('oi_flag') or pull_event.get('oi'):
        flags.append('oi')
    
    parts = [puller_name]
    if quality:
        parts.append(f"({quality})")
    if flags:
        parts.append(' '.join(flags))
    
    return ' '.join(parts)


def create_empty_row() -> List[str]:
    """Create an empty row with all columns initialized to empty strings."""
    return [''] * TOTAL_COLUMNS


def serialize_point_start(point: Dict[str, Any], point_num: int, game_scores: Optional[Dict[str, int]] = None) -> List[str]:
    """
    Create a row for point start.
    
    Args:
        point: Point object with players, startingPosition, startTimestamp
        point_num: Sequential point number (1-indexed)
        game_scores: Current game scores dict with 'team' and 'opponent' keys
    
    Returns:
        List of strings representing the row
    """
    row = create_empty_row()
    
    # Point Start Columns (A-D)
    row[COLUMN_MAP['point_num']] = str(point_num)
    row[COLUMN_MAP['point_start_time']] = format_timestamp(point.get('startTimestamp'))
    row[COLUMN_MAP['starting_position']] = point.get('startingPosition', '').capitalize()
    
    # Active Players (comma-separated)
    players = point.get('players', [])
    if isinstance(players, list):
        # Extract names if they're player objects
        player_names = [format_player_name(p) for p in players if p]
        row[COLUMN_MAP['active_players']] = ','.join(player_names)
    else:
        row[COLUMN_MAP['active_players']] = str(players)
    
    return row


def serialize_point_end(point: Dict[str, Any], point_num: int, game_scores: Dict[str, int]) -> List[str]:
    """
    Create a row for point end.
    
    Args:
        point: Point object with endTimestamp, winner, totalPointTime
        point_num: Sequential point number (1-indexed)
        game_scores: Game scores dict with 'team' and 'opponent' keys after this point
    
    Returns:
        List of strings representing the row
    """
    row = create_empty_row()
    
    # Keep point number for reference
    row[COLUMN_MAP['point_num']] = str(point_num)
    
    # Point End Columns (E-H)
    row[COLUMN_MAP['point_end_time']] = format_timestamp(point.get('endTimestamp'))
    
    # Point Duration in seconds
    total_time_ms = point.get('totalPointTime', 0)
    duration_seconds = int(total_time_ms / 1000) if total_time_ms else 0
    row[COLUMN_MAP['point_duration']] = str(duration_seconds)
    
    row[COLUMN_MAP['point_winner']] = point.get('winner', '')
    
    # Score After Point
    team_score = game_scores.get('team', 0)
    opponent_score = game_scores.get('opponent', 0)
    row[COLUMN_MAP['score_after_point']] = f"{team_score}-{opponent_score}"
    
    return row


def serialize_event(event: Dict[str, Any], point_num: int, possession_num: int, possession_type: str) -> List[str]:
    """
    Create a row for a single event.
    
    Args:
        event: Event object (Throw, Turnover, Defense, Violation, Pull, Other)
        point_num: Sequential point number (1-indexed)
        possession_num: Sequential possession number within point (1-indexed)
        possession_type: "offensive" or "defensive"
    
    Returns:
        List of strings representing the row
    """
    row = create_empty_row()
    
    # Keep point number and possession info for reference
    row[COLUMN_MAP['point_num']] = str(point_num)
    row[COLUMN_MAP['possession_num']] = str(possession_num)
    row[COLUMN_MAP['possession_type']] = possession_type
    
    event_type = event.get('type', '')
    
    if event_type == 'Throw':
        row[COLUMN_MAP['thrower']] = format_player_name(event.get('thrower'))
        row[COLUMN_MAP['receiver']] = format_player_name(event.get('receiver'))
        row[COLUMN_MAP['throw_modifiers']] = format_throw_modifiers(event)
    
    elif event_type == 'Defense':
        row[COLUMN_MAP['defender']] = format_player_name(event.get('defender'))
        row[COLUMN_MAP['defense_modifiers']] = format_defense_modifiers(event)
    
    elif event_type == 'Turnover':
        row[COLUMN_MAP['turnover_type']] = format_turnover_type(event)
        # Turnover player could be thrower or receiver depending on type
        turnover_type = format_turnover_type(event)
        if turnover_type == 'drop':
            row[COLUMN_MAP['turnover_player']] = format_player_name(event.get('receiver'))
        else:
            row[COLUMN_MAP['turnover_player']] = format_player_name(event.get('thrower'))
        row[COLUMN_MAP['turnover_modifiers']] = format_turnover_modifiers(event)
    
    elif event_type == 'Violation':
        row[COLUMN_MAP['violation_type']] = format_violation_type(event)
        # Violation player - check if there's a player field
        # Note: Violation events don't always have a player in the current model
        # This might need to be added later
        row[COLUMN_MAP['violation_player']] = format_player_name(event.get('player', ''))
    
    elif event_type == 'Pull':
        row[COLUMN_MAP['pull']] = format_pull(event)
    
    elif event_type == 'Other':
        if event.get('timeout_flag') or event.get('timeout'):
            timeout_value = event.get('timeout_flag') or event.get('timeout')
            if isinstance(timeout_value, str):
                row[COLUMN_MAP['timeout']] = timeout_value
            else:
                row[COLUMN_MAP['timeout']] = 'team'  # Default if just True
        if event.get('injury_flag') or event.get('injury'):
            row[COLUMN_MAP['injury_sub']] = format_player_name(event.get('injury'))
        if event.get('timecap_flag') or event.get('timecap'):
            timecap_value = event.get('timecap_flag') or event.get('timecap')
            if isinstance(timecap_value, str):
                row[COLUMN_MAP['time_cap']] = timecap_value
            else:
                row[COLUMN_MAP['time_cap']] = 'hard'  # Default if just True
        if event.get('switchsides_flag') or event.get('switchsides'):
            row[COLUMN_MAP['side_switch']] = 'yes'
        if event.get('halftime_flag') or event.get('halftime'):
            row[COLUMN_MAP['halftime']] = 'yes'
    
    return row


def serialize_point_to_rows(point: Dict[str, Any], point_num: int, game_scores_before: Dict[str, int], game_scores_after: Dict[str, int]) -> List[List[str]]:
    """
    Convert a Point object to multiple rows (point start, events, point end).
    
    Args:
        point: Point object with possessions and events
        point_num: Sequential point number (1-indexed)
        game_scores_before: Game scores before this point
        game_scores_after: Game scores after this point
    
    Returns:
        List of rows (each row is a list of strings)
    """
    rows = []
    
    # Point start row
    rows.append(serialize_point_start(point, point_num, game_scores_before))
    
    # Process possessions and events
    possessions = point.get('possessions', [])
    possession_num = 1
    
    for possession in possessions:
        possession_type = 'offensive' if possession.get('offensive', True) else 'defensive'
        events = possession.get('events', [])
        
        for event in events:
            rows.append(serialize_event(event, point_num, possession_num, possession_type))
        
        # Increment possession number after processing all events
        # (new possession starts on next turnover or point start)
        possession_num += 1
    
    # Point end row
    rows.append(serialize_point_end(point, point_num, game_scores_after))
    
    return rows


def serialize_game_to_sheet_rows(game: Dict[str, Any]) -> List[List[str]]:
    """
    Convert a Game object to all rows for a Google Sheets tab.
    
    Includes header rows and data rows for all points.
    
    Args:
        game: Game object with points array
    
    Returns:
        List of rows (each row is a list of strings)
    """
    rows = []
    
    # Header Row 1: Game metadata
    header1 = create_empty_row()
    header1[0] = f"Game: {game.get('team', '')} vs {game.get('opponent', '')}"
    header1[1] = f"Date: {format_timestamp(game.get('gameStartTimestamp'))}"
    if game.get('gameEndTimestamp'):
        header1[2] = f"End: {format_timestamp(game.get('gameEndTimestamp'))}"
    rows.append(header1)
    
    # Header Row 2: Column headers
    header2 = [
        'Point #',
        'Point Start Time',
        'Starting Position',
        'Active Players',
        'Point End Time',
        'Point Duration',
        'Point Winner',
        'Score After Point',
        'Pull',
        'Thrower',
        'Receiver',
        'Throw Modifiers',
        'Defender',
        'Defense Modifiers',
        'Turnover Type',
        'Turnover Player',
        'Turnover Modifiers',
        'Violation Type',
        'Violation Player',
        'Timeout',
        'Injury Sub',
        'Time Cap',
        'Side Switch',
        'Halftime',
        'Possession #',
        'Possession Type',
    ]
    rows.append(header2)
    
    # Header Row 3: Column descriptions (optional)
    header3 = create_empty_row()
    header3[0] = "Sequential point number"
    header3[1] = "ISO timestamp"
    header3[2] = "Offense or Defense"
    header3[3] = "Comma-separated player names"
    header3[8] = "Format: PlayerName (quality) flags"
    header3[11] = "Space-separated: huck break dump hammer sky layout score"
    header3[13] = "Space-separated: interception layout sky Callahan stall unforced"
    header3[16] = "Space-separated: huck defense"
    rows.append(header3)
    
    # Process points
    points = game.get('points', [])
    current_scores = {
        'team': game.get('scores', {}).get('team', 0) or 0,
        'opponent': game.get('scores', {}).get('opponent', 0) or 0,
    }
    
    for i, point in enumerate(points, start=1):
        # Calculate scores before this point
        # (scores accumulate as we process points)
        scores_before = current_scores.copy()
        
        # Process point
        point_rows = serialize_point_to_rows(point, i, scores_before, scores_before)
        rows.extend(point_rows)
        
        # Update scores after point (if point has winner)
        winner = point.get('winner', '')
        if winner == 'team':
            current_scores['team'] += 1
        elif winner == 'opponent':
            current_scores['opponent'] += 1
        
        # Update scores_after for the point end row we just added
        if point_rows:
            point_rows[-1][COLUMN_MAP['score_after_point']] = f"{current_scores['team']}-{current_scores['opponent']}"
    
    return rows


def get_column_headers() -> List[str]:
    """Get the list of column headers."""
    return [
        'Point #',
        'Point Start Time',
        'Starting Position',
        'Active Players',
        'Point End Time',
        'Point Duration',
        'Point Winner',
        'Score After Point',
        'Pull',
        'Thrower',
        'Receiver',
        'Throw Modifiers',
        'Defender',
        'Defense Modifiers',
        'Turnover Type',
        'Turnover Player',
        'Turnover Modifiers',
        'Violation Type',
        'Violation Player',
        'Timeout',
        'Injury Sub',
        'Time Cap',
        'Side Switch',
        'Halftime',
        'Possession #',
        'Possession Type',
    ]

