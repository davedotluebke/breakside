"""
Tests for game controller state management.

Tests the Active Coach / Line Coach role claiming, handoffs, and timeouts.
"""
import pytest
import time
from datetime import datetime, timedelta

# Import the controller storage module
from storage.controller_storage import (
    get_controller_state,
    claim_role,
    request_handoff,
    respond_to_handoff,
    release_role,
    ping_role,
    record_coach_ping,
    get_coach_ping_interval,
    clear_game_state,
    get_active_games,
    STALE_TIMEOUT_SECONDS,
    HANDOFF_EXPIRY_SECONDS,
    PING_INTERVAL_MULTI_MS,
    PING_INTERVAL_SOLO_MS,
    INSTANCE_LIVENESS_FACTOR,
    _controller_states,
    _connected_coaches,
    _lock,
)


# =============================================================================
# Test Fixtures
# =============================================================================

@pytest.fixture(autouse=True)
def clear_state():
    """Clear controller state before and after each test.

    Connected coaches are separate module state from role holders, and they
    decide ping cadence — leaving them behind lets one test's coaches make the
    next test's game look multi-coach.
    """
    with _lock:
        _controller_states.clear()
        _connected_coaches.clear()
    yield
    with _lock:
        _controller_states.clear()
        _connected_coaches.clear()


# =============================================================================
# Basic Claim Tests
# =============================================================================

def test_claim_vacant_role():
    """Claiming a vacant role should succeed immediately."""
    game_id = "test-game-1"
    user_id = "user-alice"
    display_name = "Alice"
    
    result = claim_role(game_id, "activeCoach", user_id, display_name)
    
    assert result["success"] is True
    assert result["state"]["activeCoach"]["userId"] == user_id
    assert result["state"]["activeCoach"]["displayName"] == display_name
    assert result["state"]["lineCoach"] is None


def test_claim_both_roles():
    """Two different users can hold different roles."""
    game_id = "test-game-1"
    
    # Alice claims active
    result1 = claim_role(game_id, "activeCoach", "user-alice", "Alice")
    assert result1["success"] is True
    
    # Bob claims line
    result2 = claim_role(game_id, "lineCoach", "user-bob", "Bob")
    assert result2["success"] is True
    
    state = get_controller_state(game_id)
    assert state["activeCoach"]["userId"] == "user-alice"
    assert state["lineCoach"]["userId"] == "user-bob"


def test_claim_already_held_role():
    """Claiming a role already held by same user should refresh the ping."""
    game_id = "test-game-1"
    user_id = "user-alice"
    
    # First claim
    result1 = claim_role(game_id, "activeCoach", user_id, "Alice")
    first_ping = result1["state"]["activeCoach"]["lastPing"]
    
    # Small delay
    time.sleep(0.1)
    
    # Second claim (refresh)
    result2 = claim_role(game_id, "activeCoach", user_id, "Alice")
    second_ping = result2["state"]["activeCoach"]["lastPing"]
    
    assert result2["success"] is True
    assert second_ping > first_ping


def test_claim_occupied_role_fails():
    """Claiming a role held by another user should fail."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob tries to claim
    result = claim_role(game_id, "activeCoach", "user-bob", "Bob")
    
    assert result["success"] is False
    assert result["reason"] == "occupied"
    assert result["currentHolder"]["userId"] == "user-alice"


# =============================================================================
# Handoff Tests
# =============================================================================

def test_request_handoff():
    """Requesting handoff for an occupied role should create pending handoff."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob requests handoff
    result = request_handoff(game_id, "activeCoach", "user-bob", "Bob")
    
    assert result["success"] is True
    assert result["handoff"]["role"] == "activeCoach"
    assert result["handoff"]["requesterId"] == "user-bob"
    assert result["handoff"]["currentHolderId"] == "user-alice"


def test_accept_handoff():
    """Accepting a handoff should transfer the role."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob requests handoff
    request_handoff(game_id, "activeCoach", "user-bob", "Bob")
    
    # Alice accepts
    result = respond_to_handoff(game_id, "user-alice", accept=True)
    
    assert result["success"] is True
    assert result["accepted"] is True
    assert result["state"]["activeCoach"]["userId"] == "user-bob"
    assert result["state"]["pendingHandoff"] is None


def test_deny_handoff():
    """Denying a handoff should keep the role with current holder."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob requests handoff
    request_handoff(game_id, "activeCoach", "user-bob", "Bob")
    
    # Alice denies
    result = respond_to_handoff(game_id, "user-alice", accept=False)
    
    assert result["success"] is True
    assert result["accepted"] is False
    assert result["state"]["activeCoach"]["userId"] == "user-alice"
    assert result["state"]["pendingHandoff"] is None


def test_only_one_pending_handoff():
    """Only one handoff can be pending at a time."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob requests handoff
    request_handoff(game_id, "activeCoach", "user-bob", "Bob")
    
    # Charlie also tries to request
    result = request_handoff(game_id, "activeCoach", "user-charlie", "Charlie")
    
    assert result["success"] is False
    assert result["reason"] == "handoff_pending"


def test_handoff_for_vacant_role_fails():
    """Cannot request handoff for a vacant role."""
    game_id = "test-game-1"
    
    result = request_handoff(game_id, "activeCoach", "user-bob", "Bob")
    
    assert result["success"] is False
    assert result["reason"] == "role_vacant"


def test_handoff_from_self_fails():
    """Cannot request handoff from yourself."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Alice requests handoff from herself (weird but test it)
    result = request_handoff(game_id, "activeCoach", "user-alice", "Alice")
    
    assert result["success"] is False
    assert result["reason"] == "already_holder"


def test_wrong_user_cannot_respond():
    """Only the current holder can respond to a handoff."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob requests handoff
    request_handoff(game_id, "activeCoach", "user-bob", "Bob")
    
    # Charlie tries to respond (not the holder)
    result = respond_to_handoff(game_id, "user-charlie", accept=True)
    
    assert result["success"] is False
    assert result["reason"] == "not_holder"


# =============================================================================
# Release Tests
# =============================================================================

def test_release_role():
    """Releasing a role should make it vacant."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Alice releases
    result = release_role(game_id, "activeCoach", "user-alice")
    
    assert result["success"] is True
    assert result["state"]["activeCoach"] is None


def test_release_clears_pending_handoff():
    """Releasing a role should clear any pending handoff for it."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob requests handoff
    request_handoff(game_id, "activeCoach", "user-bob", "Bob")
    
    # Alice releases (instead of responding)
    result = release_role(game_id, "activeCoach", "user-alice")
    
    assert result["success"] is True
    assert result["state"]["activeCoach"] is None
    assert result["state"]["pendingHandoff"] is None


def test_cannot_release_role_not_held():
    """Cannot release a role you don't hold."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob tries to release (not the holder)
    result = release_role(game_id, "activeCoach", "user-bob")
    
    assert result["success"] is False
    assert result["reason"] == "not_holder"


# =============================================================================
# Ping Tests
# =============================================================================

def test_ping_updates_timestamp():
    """Pinging should update the lastPing timestamp."""
    game_id = "test-game-1"
    
    # Alice claims
    result1 = claim_role(game_id, "activeCoach", "user-alice", "Alice")
    first_ping = result1["state"]["activeCoach"]["lastPing"]
    
    # Small delay
    time.sleep(0.1)
    
    # Ping
    result2 = ping_role(game_id, "activeCoach", "user-alice")
    second_ping = result2["state"]["activeCoach"]["lastPing"]
    
    assert result2["success"] is True
    assert second_ping > first_ping


def test_cannot_ping_role_not_held():
    """Cannot ping a role you don't hold."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob tries to ping (not the holder)
    result = ping_role(game_id, "activeCoach", "user-bob")
    
    assert result["success"] is False
    assert result["reason"] == "not_holder"


# =============================================================================
# Stale Claim Tests
# =============================================================================

def test_stale_claim_cleared():
    """Stale claims should be cleared when state is accessed."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Manually set lastPing to the past (simulating timeout)
    with _lock:
        stale_time = (datetime.now() - timedelta(seconds=STALE_TIMEOUT_SECONDS + 1)).isoformat()
        _controller_states[game_id]["activeCoach"]["lastPing"] = stale_time
    
    # Get state (should clean up stale claim)
    state = get_controller_state(game_id)
    
    assert state["activeCoach"] is None


def test_stale_claim_allows_new_claim():
    """A stale claim should allow another user to claim."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Make Alice's claim stale
    with _lock:
        stale_time = (datetime.now() - timedelta(seconds=STALE_TIMEOUT_SECONDS + 1)).isoformat()
        _controller_states[game_id]["activeCoach"]["lastPing"] = stale_time
    
    # Bob claims (should succeed because Alice's claim is stale)
    result = claim_role(game_id, "activeCoach", "user-bob", "Bob")
    
    assert result["success"] is True
    assert result["state"]["activeCoach"]["userId"] == "user-bob"


# =============================================================================
# Auto-Approve Handoff Tests
# =============================================================================

def test_handoff_auto_approves():
    """Expired handoff should auto-approve when state is accessed."""
    game_id = "test-game-1"
    
    # Alice claims
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    
    # Bob requests handoff
    request_handoff(game_id, "activeCoach", "user-bob", "Bob")
    
    # Make handoff expired
    with _lock:
        expired_time = (datetime.now() - timedelta(seconds=1)).isoformat()
        _controller_states[game_id]["pendingHandoff"]["expiresAt"] = expired_time
    
    # Get state (should auto-approve handoff)
    state = get_controller_state(game_id)
    
    assert state["activeCoach"]["userId"] == "user-bob"
    assert state["pendingHandoff"] is None


# =============================================================================
# Utility Tests
# =============================================================================

def test_clear_game_state():
    """Clearing game state should remove all controller data."""
    game_id = "test-game-1"
    
    # Set up some state
    claim_role(game_id, "activeCoach", "user-alice", "Alice")
    claim_role(game_id, "lineCoach", "user-bob", "Bob")
    
    # Clear
    clear_game_state(game_id)
    
    # Should be empty
    state = get_controller_state(game_id)
    assert state["activeCoach"] is None
    assert state["lineCoach"] is None


def test_get_active_games():
    """Should return all games with controller state."""
    # Set up multiple games
    claim_role("game-1", "activeCoach", "user-alice", "Alice")
    claim_role("game-2", "lineCoach", "user-bob", "Bob")
    
    active = get_active_games()
    
    assert "game-1" in active
    assert "game-2" in active
    assert active["game-1"]["activeCoach"]["userId"] == "user-alice"
    assert active["game-2"]["lineCoach"]["userId"] == "user-bob"


def test_independent_games():
    """Controller state should be independent between games."""
    # Alice claims active in game 1
    claim_role("game-1", "activeCoach", "user-alice", "Alice")
    
    # Bob claims active in game 2
    claim_role("game-2", "activeCoach", "user-bob", "Bob")
    
    # Alice claims line in game 2
    claim_role("game-2", "lineCoach", "user-alice", "Alice")
    
    state1 = get_controller_state("game-1")
    state2 = get_controller_state("game-2")
    
    assert state1["activeCoach"]["userId"] == "user-alice"
    assert state1["lineCoach"] is None
    
    assert state2["activeCoach"]["userId"] == "user-bob"
    assert state2["lineCoach"]["userId"] == "user-alice"


# =============================================================================
# Ping Cadence (solo backoff)
# =============================================================================

def test_solo_coach_is_told_to_back_off():
    result = record_coach_ping("game-1", "user-alice", "Alice", "inst-a")

    assert result["pingIntervalMs"] == PING_INTERVAL_SOLO_MS
    assert result["duplicateInstance"] is False


def test_second_coach_is_fast_on_its_very_first_ping():
    """The coach who *makes* a game multi-coach must not be told to go slow.

    Regression guard for counting connected coaches before recording the ping
    that is being answered: Bob isn't in the list yet at that moment, so the
    game still looks solo and Bob gets the backed-off cadence.
    """
    record_coach_ping("game-1", "user-alice", "Alice", "inst-a")

    bob = record_coach_ping("game-1", "user-bob", "Bob", "inst-b")

    assert bob["pingIntervalMs"] == PING_INTERVAL_MULTI_MS


def test_incumbent_speeds_up_on_its_next_ping():
    alice_solo = record_coach_ping("game-1", "user-alice", "Alice", "inst-a")
    assert alice_solo["pingIntervalMs"] == PING_INTERVAL_SOLO_MS

    record_coach_ping("game-1", "user-bob", "Bob", "inst-b")
    alice_again = record_coach_ping("game-1", "user-alice", "Alice", "inst-a")

    assert alice_again["pingIntervalMs"] == PING_INTERVAL_MULTI_MS


def test_cadence_is_per_game():
    record_coach_ping("game-1", "user-alice", "Alice", "inst-a")
    record_coach_ping("game-1", "user-bob", "Bob", "inst-b")

    solo_elsewhere = record_coach_ping("game-2", "user-alice", "Alice", "inst-a")

    assert solo_elsewhere["pingIntervalMs"] == PING_INTERVAL_SOLO_MS


# =============================================================================
# Duplicate Instance Detection
# =============================================================================

def test_two_instances_of_one_account_are_flagged_and_kept_fast():
    """One user in two places must not be read as "solo" and backed off."""
    record_coach_ping("game-1", "user-alice", "Alice", "inst-phone")

    second = record_coach_ping("game-1", "user-alice", "Alice", "inst-tablet")

    assert second["duplicateInstance"] is True
    assert second["pingIntervalMs"] == PING_INTERVAL_MULTI_MS


def test_repeat_pings_from_one_instance_are_not_duplicates():
    record_coach_ping("game-1", "user-alice", "Alice", "inst-phone")
    again = record_coach_ping("game-1", "user-alice", "Alice", "inst-phone")

    assert again["duplicateInstance"] is False
    assert again["pingIntervalMs"] == PING_INTERVAL_SOLO_MS


def test_absent_instance_id_never_reports_a_duplicate():
    """No id means "can't tell" — an old client must not trip the warning."""
    record_coach_ping("game-1", "user-alice", "Alice", None)
    again = record_coach_ping("game-1", "user-alice", "Alice", None)

    assert again["duplicateInstance"] is False


def test_departed_instance_ages_out_and_solo_backoff_returns():
    """Closing the second copy should hand the cadence back, not latch fast."""
    record_coach_ping("game-1", "user-alice", "Alice", "inst-phone")
    flagged = record_coach_ping("game-1", "user-alice", "Alice", "inst-tablet")
    assert flagged["duplicateInstance"] is True

    # The tablet goes away: backdate it past its own liveness window, which is
    # a multiple of the cadence it was last told to use (now the fast one).
    stale_by = (PING_INTERVAL_MULTI_MS / 1000) * INSTANCE_LIVENESS_FACTOR + 1
    with _lock:
        instances = _connected_coaches["game-1"]["user-alice"]["instances"]
        instances["inst-tablet"] = datetime.now() - timedelta(seconds=stale_by)

    recovered = record_coach_ping("game-1", "user-alice", "Alice", "inst-phone")

    assert recovered["duplicateInstance"] is False
    assert recovered["pingIntervalMs"] == PING_INTERVAL_SOLO_MS


# =============================================================================
# Handoff Expiry vs Holder Cadence
# =============================================================================

def test_handoff_window_covers_a_backed_off_holder():
    """A solo holder must not lose a role to a timer they never saw start.

    Alice is pinging every 10s, so a 10s handoff window could elapse entirely
    within one of her gaps — auto-approving before she is ever shown the prompt.
    """
    claim_role("game-1", "activeCoach", "user-alice", "Alice")
    record_coach_ping("game-1", "user-alice", "Alice", "inst-a")
    assert get_coach_ping_interval("game-1", "user-alice") == PING_INTERVAL_SOLO_MS

    result = request_handoff("game-1", "activeCoach", "user-bob", "Bob")

    assert result["success"] is True
    requested = datetime.fromisoformat(result["handoff"]["requestedAt"])
    expires = datetime.fromisoformat(result["handoff"]["expiresAt"])
    window = (expires - requested).total_seconds()

    # One interval to notice, one to respond, plus slack.
    assert window > HANDOFF_EXPIRY_SECONDS
    assert window == pytest.approx(2 * (PING_INTERVAL_SOLO_MS / 1000) + 2, abs=1)


def test_handoff_window_is_unchanged_for_a_fast_holder():
    claim_role("game-1", "activeCoach", "user-alice", "Alice")
    record_coach_ping("game-1", "user-alice", "Alice", "inst-a")
    record_coach_ping("game-1", "user-bob", "Bob", "inst-b")
    record_coach_ping("game-1", "user-alice", "Alice", "inst-a")
    assert get_coach_ping_interval("game-1", "user-alice") == PING_INTERVAL_MULTI_MS

    result = request_handoff("game-1", "activeCoach", "user-bob", "Bob")

    requested = datetime.fromisoformat(result["handoff"]["requestedAt"])
    expires = datetime.fromisoformat(result["handoff"]["expiresAt"])
    window = (expires - requested).total_seconds()

    assert window == pytest.approx(HANDOFF_EXPIRY_SECONDS, abs=1)


def test_handoff_window_defaults_fast_for_an_unknown_holder():
    """Never-pinged holder: assume fast, or every handoff inflates."""
    claim_role("game-1", "activeCoach", "user-alice", "Alice")

    result = request_handoff("game-1", "activeCoach", "user-bob", "Bob")

    requested = datetime.fromisoformat(result["handoff"]["requestedAt"])
    expires = datetime.fromisoformat(result["handoff"]["expiresAt"])
    window = (expires - requested).total_seconds()

    assert window == pytest.approx(HANDOFF_EXPIRY_SECONDS, abs=1)


# =============================================================================
# Run Tests
# =============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v"])

