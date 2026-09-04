"""
Tests for the lineup narration endpoint (narration_lineup.py).

Contract under test (tap-equivalent): the model returns only the voiced
changes {"in": [...], "out": [...]} — the verbal equivalent of tapping
names on the Lines tab — and the ENDPOINT derives the resulting selection
via set arithmetic. The model structurally cannot pick, complete, or trim
a lineup.

Prompt-content, parsing, and set-arithmetic tests are pure. Endpoint tests
use TestClient with the Claude call mocked; only ``get_current_user`` is
overridden (a test can't mint a Supabase JWT), so ``require_body_game_coach``
runs for real against the seeded storage of the ``narration_data`` fixture.
Overriding the authorization dependency itself would let the behavior tests
sail past the very check TestLineupAuthorization pins.

An opt-in live test (NARRATION_LIVE_TESTS=1) runs the canonical messy
utterance through the real model as a prompt-quality eval.

Run with: cd breakside_server && python -m pytest test_narration_lineup.py -v
"""
import json
import os

import pytest
from fastapi.testclient import TestClient

import narration_lineup
from narration_lineup import (
    LineupRequest,
    LineupRosterPlayer,
    _apply_changes,
    _build_lineup_prompt,
    _clear_evidence_ok,
    _lineup_model,
    _normalize_name,
    _parse_lineup_json,
)

from conftest import (
    NARRATION_COACH,
    NARRATION_GAME_ID,
    NARRATION_OTHER_COACH,
    NARRATION_OUTSIDER,
    NARRATION_VIEWER,
)


def make_request(**overrides):
    base = dict(
        game_id="game-1",
        transcript="Kris goes in for Wes",
        roster=[
            LineupRosterPlayer(name="Kris", nickname=None, number="12"),
            LineupRosterPlayer(name="Wes", nickname="Big Wes", number="7"),
            LineupRosterPlayer(name="Morgan Vale", nickname=None, number=None),
        ],
        expected_count=7,
        previous_lineup=["Wes", "Alice", "Bob"],
        current_selection=["Wes", "Alice"],
    )
    base.update(overrides)
    return LineupRequest(**base)


# =============================================================================
# Prompt construction
# =============================================================================

class TestLineupPrompt:
    def test_prompt_includes_expected_count(self):
        prompt = _build_lineup_prompt(make_request(expected_count=5))
        assert "Expected lineup size: 5 players" in prompt

    def test_prompt_includes_roster_with_nickname_and_number(self):
        prompt = _build_lineup_prompt(make_request())
        assert "- Kris #12" in prompt
        assert '- Wes "Big Wes" #7' in prompt
        assert "- Morgan Vale" in prompt

    def test_prompt_includes_previous_lineup_and_selection(self):
        prompt = _build_lineup_prompt(make_request())
        prev_section = prompt.split("Previous lineup")[1].split("Currently selected")[0]
        assert "- Alice" in prev_section and "- Bob" in prev_section
        curr_section = prompt.split("Currently selected")[1].split("Transcript")[0]
        assert "- Alice" in curr_section and "- Bob" not in curr_section

    def test_prompt_empty_selection_stays_empty(self):
        """The Wholesale regression: an empty selection must NEVER be
        silently replaced by the previous lineup in the prompt."""
        prompt = _build_lineup_prompt(make_request(current_selection=[]))
        curr_section = prompt.split("Currently selected")[1].split("Transcript")[0]
        assert "(empty — the coach cleared the selection or is starting fresh)" in curr_section
        assert "- Wes" not in curr_section and "- Alice" not in curr_section

    def test_prompt_handles_empty_previous_lineup(self):
        prompt = _build_lineup_prompt(make_request(previous_lineup=[], current_selection=[]))
        assert "(none — no points played yet)" in prompt

    def test_prompt_states_tap_equivalence(self):
        """The core contract: voice = tapping names; changes only."""
        prompt = _build_lineup_prompt(make_request())
        assert "verbal equivalent of tapping" in prompt
        assert "You never pick, complete, trim, or output a lineup" in prompt
        assert "ONLY players the coach referred to" in prompt
        assert '"in" has exactly 3 entries' in prompt
        assert "NEVER add players to approach it" in prompt

    def test_prompt_states_key_interpretation_rules(self):
        prompt = _build_lineup_prompt(make_request())
        # Substitution / removal / addition idioms
        assert '"X goes in for Y"' in prompt
        assert '"same line"' in prompt
        assert '"X is coming off"' in prompt
        # Corrections and retractions
        assert "Later statements override earlier ones" in prompt
        assert "A retracted change never happened" in prompt
        # Asides / wrap-up phrases
        assert "Ignore asides" in prompt
        # Unknown references
        assert "unmatched" in prompt

    def test_prompt_demands_exact_roster_spelling_with_digits(self):
        prompt = _build_lineup_prompt(make_request())
        assert "EXACTLY as its roster line spells the name" in prompt
        assert "digits and symbols included" in prompt
        assert "never a cleaned-up version" in prompt

    def test_prompt_output_shape_is_changes_only(self):
        prompt = _build_lineup_prompt(make_request())
        assert '{"clear": false, "clear_said": "", "in": ["Name", ...], "out": [{"name": "Name", "said":' in prompt
        # The retired full-lineup output shape must be gone
        assert '"players":' not in prompt


# =============================================================================
# Response parsing
# =============================================================================

class TestParseLineupJson:
    def test_plain_json(self):
        out = _parse_lineup_json('{"in": ["A"], "out": ["B"], "unmatched": [], "note": ""}')
        assert out["in"] == ["A"]
        # bare-string outs are normalized to evidence-less entries
        assert out["out"] == [{"name": "B", "said": ""}]

    def test_fenced_json(self):
        out = _parse_lineup_json('```json\n{"in": ["A"], "out": [], "unmatched": ["zeb"], "note": "n"}\n```')
        assert out["in"] == ["A"]
        assert out["unmatched"] == ["zeb"]

    def test_missing_out_is_tolerated(self):
        out = _parse_lineup_json('{"in": ["A"]}')
        assert out["in"] == ["A"]

    def test_garbage_raises(self):
        with pytest.raises(Exception):
            _parse_lineup_json("Sure! Kris goes in and Wes comes off.")

    def test_old_players_shape_raises(self):
        """The retired full-lineup contract must not silently pass through —
        it is exactly the shape that allowed line-filling."""
        with pytest.raises(Exception):
            _parse_lineup_json('{"players": ["A", "B"], "unmatched": [], "note": ""}')

    def test_non_list_out_raises(self):
        with pytest.raises(RuntimeError):
            _parse_lineup_json('{"in": [], "out": "Wes"}')

    def test_clear_fields_normalized(self):
        out = _parse_lineup_json('{"in": [], "clear": true, "clear_said": "wholesale"}')
        assert out["clear"] is True and out["clear_said"] == "wholesale"
        out2 = _parse_lineup_json('{"in": ["A"]}')
        assert out2["clear"] is False and out2["clear_said"] == ""

    def test_out_entries_normalized_to_name_said(self):
        out = _parse_lineup_json(
            '{"in": [], "out": [{"name": "Wes", "said": "Wes sits"}, "Sam"]}')
        assert out["out"] == [{"name": "Wes", "said": "Wes sits"},
                              {"name": "Sam", "said": ""}]


# =============================================================================
# Set arithmetic (_apply_changes)
# =============================================================================

class TestApplyChanges:
    def test_wholesale_then_adds_yields_only_the_adds(self):
        """The field-report repro: empty selection + 3 ins = exactly 3."""
        assert _apply_changes([], ["Jake", "Kris", "Charlie"], []) == ["Jake", "Kris", "Charlie"]

    def test_sub_removes_and_adds(self):
        sel = ["Wes", "Alice", "Sam"]
        assert _apply_changes(sel, ["Kris"], ["Wes"]) == ["Alice", "Sam", "Kris"]

    def test_out_matches_casefold(self):
        assert _apply_changes(["Wes"], [], ["wes"]) == []

    def test_out_matches_embedded_number_name(self):
        """Model returns the cleaned name; selection holds 'Jamal 23'."""
        assert _apply_changes(["Jamal 23", "Keisha 7"], [], ["Jamal"]) == ["Keisha 7"]

    def test_out_ambiguous_normalized_is_noop(self):
        sel = ["Jamal 23", "Jamal 40"]
        assert _apply_changes(sel, [], ["Jamal"]) == sel

    def test_out_not_selected_is_noop(self):
        sel = ["Alice"]
        assert _apply_changes(sel, ["Kris"], ["Wes"]) == ["Alice", "Kris"]

    def test_in_dedupes_exact_and_casefold(self):
        assert _apply_changes(["Alice"], ["Alice", "alice", "Bob"], []) == ["Alice", "Bob"]

    def test_in_dedupes_normalized_number_name(self):
        assert _apply_changes(["Jamal 23"], ["Jamal"], []) == ["Jamal 23"]

    def test_in_preserves_spoken_order(self):
        assert _apply_changes([], ["C", "A", "B"], []) == ["C", "A", "B"]

    def test_out_beats_matching_in(self):
        """Player named early then removed later can surface in both lists;
        the removal is the later, controlling statement."""
        assert _apply_changes(["Kris", "Alice"], ["Kris"], ["Kris"]) == ["Alice"]

    def test_run_it_back_expansion_overlapping_outs(self):
        """'Run it back except X off' can expand ins to the whole previous
        line while outs lists X — X must stay out."""
        prev = ["Wes", "Alice", "Sam"]
        assert _apply_changes(prev, prev + ["Priya"], ["Wes"]) == ["Alice", "Sam", "Priya"]

    def test_normalize_name_mirrors_frontend(self):
        assert _normalize_name("Jamal 23") == "jamal"
        assert _normalize_name("23 Jamal") == "jamal"
        assert _normalize_name("Jamal #23") == "jamal"
        assert _normalize_name('Morgan Vale "HB"') == "morgan vale"


class TestClearEvidence:
    def test_wholesale_variants_accepted(self):
        for t, quote in [
            ("Let's get a wholesale, then put in Kris", "Let's get a wholesale"),
            ("OK whole sale everybody", "whole sale"),
            ("Everybody comes off", "Everybody comes off"),
            ("All players come off. Priya in.", "All players come off"),
            ("Clear the line please", "Clear the line"),
            ("Let's start fresh here", "start fresh"),
            ("Everyone off, thanks", "Everyone off"),
        ]:
            assert _clear_evidence_ok(quote, t), (t, quote)

    def test_quote_not_in_transcript_rejected(self):
        assert not _clear_evidence_ok("everybody comes off", "Kris in for Wes")

    def test_non_collective_quote_rejected(self):
        """A real transcript quote that isn't a collective-clear idiom must
        not clear the selection."""
        assert not _clear_evidence_ok("Wes comes off", "Wes comes off")

    def test_empty_quote_rejected(self):
        assert not _clear_evidence_ok("", "wholesale")


# =============================================================================
# Model selection
# =============================================================================

class TestModelSelection:
    def test_lineup_model_env_wins(self, monkeypatch):
        monkeypatch.setenv("NARRATION_LINEUP_MODEL", "model-a")
        monkeypatch.setenv("NARRATION_SLOW_MODEL", "model-b")
        assert _lineup_model() == "model-a"

    def test_falls_back_to_slow_model_env(self, monkeypatch):
        monkeypatch.delenv("NARRATION_LINEUP_MODEL", raising=False)
        monkeypatch.setenv("NARRATION_SLOW_MODEL", "model-b")
        assert _lineup_model() == "model-b"

    def test_default_model(self, monkeypatch):
        monkeypatch.delenv("NARRATION_LINEUP_MODEL", raising=False)
        monkeypatch.delenv("NARRATION_SLOW_MODEL", raising=False)
        assert _lineup_model() == "claude-sonnet-4-5-20250929"


# =============================================================================
# Endpoint behavior
# =============================================================================

@pytest.fixture()
def client(narration_data):
    """TestClient authenticated as a real coach of the seeded game's team."""
    from main import app
    from auth.jwt_validation import get_current_user

    app.dependency_overrides[get_current_user] = lambda: NARRATION_COACH
    yield TestClient(app)
    app.dependency_overrides.clear()


def request_body(**overrides):
    body = {
        "game_id": NARRATION_GAME_ID,
        "transcript": "Kris goes in for Wes",
        "roster": [
            {"name": "Kris", "nickname": None, "number": "12"},
            {"name": "Wes", "nickname": None, "number": "7"},
            {"name": "Alice", "nickname": None, "number": "2"},
        ],
        "expected_count": 7,
        "previous_lineup": ["Wes", "Alice"],
        "current_selection": ["Wes", "Alice"],
    }
    body.update(overrides)
    return body


def fake_model(ins, outs, unmatched=None, note=""):
    """outs: list of names — wrapped as evidence-backed entries. The quote
    must exist in the request transcript, so tests using this pass a
    transcript like 'X off' (see request_body overrides)."""
    async def call(api_key, prompt):
        return {"in": ins,
                "out": [{"name": o, "said": f"{o} off"} for o in outs],
                "unmatched": unmatched or [], "note": note}
    return call


class TestLineupEndpoint:
    def test_503_without_api_key(self, client, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        resp = client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 503
        assert "ANTHROPIC_API_KEY" in resp.json()["detail"]

    def test_sub_derives_players_from_changes(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup",
                            fake_model(["Kris"], ["Wes"]))
        resp = client.post("/api/narration/lineup",
                           json=request_body(transcript="Kris in, Wes off"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["players"] == ["Alice", "Kris"]
        assert data["voiced_in"] == ["Kris"]
        assert data["voiced_out"] == ["Wes"]
        assert data["error"] is None

    def test_wholesale_repro_returns_only_named_players(self, client, monkeypatch):
        """The user's field report: Wholesale (empty selection) + 'go in'
        must yield exactly the named players — no fill from the previous
        lineup, no matter how full it was."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup",
                            fake_model(["Kris", "Alice"], []))
        resp = client.post("/api/narration/lineup", json=request_body(
            current_selection=[],
            previous_lineup=["Wes", "Alice", "Bob", "Carol", "Dana", "Eve", "Fay"],
        ))
        data = resp.json()
        assert data["players"] == ["Kris", "Alice"]

    def test_voiced_clear_then_ins(self, client, monkeypatch):
        """'Let's get a wholesale, then put in Kris' — selection empties,
        then the named players go in. The field-requested idiom."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return {"in": ["Kris"], "out": [], "clear": True,
                    "clear_said": "Let's get a wholesale",
                    "unmatched": [], "note": ""}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        resp = client.post("/api/narration/lineup", json=request_body(
            transcript="Let's get a wholesale, then put in Kris"))
        data = resp.json()
        assert data["players"] == ["Kris"]
        assert data["voiced_clear"] is True

    def test_voiced_clear_alone_empties(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return {"in": [], "out": [], "clear": True,
                    "clear_said": "Everybody comes off",
                    "unmatched": [], "note": ""}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        resp = client.post("/api/narration/lineup", json=request_body(
            transcript="Everybody comes off"))
        data = resp.json()
        assert data["players"] == []
        assert data["voiced_clear"] is True

    def test_unverified_clear_is_ignored(self, client, monkeypatch):
        """clear=true without a verifiable collective quote must not wipe."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return {"in": [], "out": [], "clear": True,
                    "clear_said": "Kris goes in for Wes",
                    "unmatched": [], "note": ""}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        resp = client.post("/api/narration/lineup", json=request_body())
        data = resp.json()
        assert data["players"] == ["Wes", "Alice"]
        assert data["voiced_clear"] is False

    def test_out_with_fabricated_quote_is_dropped(self, client, monkeypatch):
        """A quote that names the player but never occurs in the transcript
        is fabricated evidence — dropped."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return {"in": [],
                    "out": [{"name": "Wes", "said": "Wes comes off"}],
                    "unmatched": [], "note": ""}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        resp = client.post("/api/narration/lineup",
                           json=request_body(transcript="Line is Kris and Alice"))
        assert resp.json()["players"] == ["Wes", "Alice"]

    def test_out_with_unrelated_evidence_is_dropped(self, client, monkeypatch):
        """Fabricated evidence — quoting transcript text that never mentions
        the player — must not remove them (the recite-as-evidence dodge)."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return {"in": ["Kris"],
                    "out": [{"name": "Wes", "said": "Line is Kris and Alice"}],
                    "unmatched": [], "note": ""}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        resp = client.post("/api/narration/lineup", json=request_body())
        assert resp.json()["players"] == ["Wes", "Alice", "Kris"]

    def test_out_evidence_by_jersey_number_words(self, client, monkeypatch):
        """'number five comes off' names no one, but references #5's jersey —
        digits and spoken-word forms both count as evidence."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return {"in": [],
                    "out": [{"name": "Alice", "said": "number two comes off"}],
                    "unmatched": [], "note": ""}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        resp = client.post("/api/narration/lineup",
                           json=request_body(transcript="number two comes off"))
        assert resp.json()["players"] == ["Wes"]

    def test_out_without_evidence_is_dropped(self, client, monkeypatch):
        """An out with no quoted removal words is ignored — this is the
        server-side guarantee that 'absent from a recited list' can never
        remove a player (the Haiku implicit-replace failure)."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return {"in": ["Kris"],
                    "out": [{"name": "Wes", "said": ""},
                            {"name": "Alice", "said": "Alice takes a break"}],
                    "unmatched": [], "note": ""}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        resp = client.post("/api/narration/lineup",
                           json=request_body(transcript="Kris in. Alice takes a break"))
        data = resp.json()
        assert data["players"] == ["Wes", "Kris"]      # Wes kept, Alice removed
        assert data["voiced_out"] == ["Alice"]

    def test_model_cannot_inject_players_field(self, client, monkeypatch):
        """Even if the model regresses to emitting a full-lineup 'players'
        field alongside in/out, only the derived set arithmetic counts."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def sneaky(api_key, prompt):
            return {"in": ["Kris"], "out": [],
                    "players": ["Kris", "Wes", "Alice", "Bob", "Carol", "Dana", "Eve"],
                    "unmatched": [], "note": ""}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", sneaky)
        resp = client.post("/api/narration/lineup", json=request_body(current_selection=[]))
        assert resp.json()["players"] == ["Kris"]

    def test_empty_transcript_is_error_payload(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/narration/lineup", json=request_body(transcript="   "))
        data = resp.json()
        assert resp.status_code == 200
        assert data["players"] == []
        assert data["error"] == "Empty transcript"

    def test_empty_roster_is_error_payload(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/narration/lineup", json=request_body(roster=[]))
        assert resp.json()["error"] == "Empty roster"

    def test_claude_failure_degrades_to_error_payload(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def failing_call(api_key, prompt):
            raise RuntimeError("Anthropic API 529: overloaded")
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", failing_call)
        resp = client.post("/api/narration/lineup", json=request_body())
        data = resp.json()
        assert resp.status_code == 200
        assert data["players"] == []
        assert "overloaded" in data["error"]

    def test_non_string_entries_are_shaped(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def odd_call(api_key, prompt):
            return {"in": ["Kris", {"name": "bad"}, 7], "out": [None, "junk", 3],
                    "unmatched": [None], "note": None}
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", odd_call)
        resp = client.post("/api/narration/lineup", json=request_body(current_selection=[]))
        data = resp.json()
        assert data["players"] == ["Kris", "7"]
        assert data["unmatched"] == []
        assert data["note"] == ""

    def test_requires_auth(self):
        from main import app
        assert not app.dependency_overrides
        unauth_client = TestClient(app)
        resp = unauth_client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 401


# =============================================================================
# Authorization — the endpoint used to accept ANY authenticated user
# =============================================================================
#
# /lineup takes a game_id and forwards the transcript to Anthropic on the
# operator's key. It used to read only `Depends(get_current_user)` and never
# look at game_id at all, so any Supabase signup (self-signup is open) could
# spend the budget. These tests drive the REAL require_body_game_coach — only
# get_current_user is overridden, because a test can't mint a Supabase JWT.

def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user
    app.dependency_overrides[get_current_user] = lambda: user


@pytest.fixture()
def authz_client(narration_data, monkeypatch):
    """Client with no user bound yet — each test picks one with _as()."""
    from main import app
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(narration_lineup, "_call_claude_lineup",
                        fake_model(["Kris"], []))
    app.dependency_overrides.clear()
    yield TestClient(app)
    app.dependency_overrides.clear()


class TestLineupAuthorization:
    def test_unauthenticated_is_401(self, authz_client):
        resp = authz_client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 401

    def test_authenticated_non_coach_is_403(self, authz_client):
        _as(NARRATION_OUTSIDER)
        resp = authz_client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 403

    def test_viewer_on_the_games_team_is_403(self, authz_client):
        """Viewer access to a game is not permission to spend LLM budget."""
        _as(NARRATION_VIEWER)
        resp = authz_client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 403

    def test_coach_of_a_different_team_is_403(self, authz_client):
        _as(NARRATION_OTHER_COACH)
        resp = authz_client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 403

    def test_coach_of_the_games_team_passes(self, authz_client):
        _as(NARRATION_COACH)
        resp = authz_client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 200

    def test_unknown_game_is_404(self, authz_client):
        _as(NARRATION_COACH)
        resp = authz_client.post("/api/narration/lineup",
                                 json=request_body(game_id="no-such-game"))
        assert resp.status_code == 404

    def test_missing_game_id_is_rejected(self, authz_client):
        """game_id is required now — it used to be Optional and unread."""
        body = request_body()
        del body["game_id"]
        _as(NARRATION_COACH)
        resp = authz_client.post("/api/narration/lineup", json=body)
        assert resp.status_code == 400

    def test_traversal_game_id_is_400(self, authz_client):
        _as(NARRATION_COACH)
        resp = authz_client.post("/api/narration/lineup",
                                 json=request_body(game_id="../../etc/passwd"))
        assert resp.status_code == 400


class TestLineupInputCaps:
    """Oversize inputs are rejected, not truncated: a client that overruns
    these has a bug, and silently trimming would hide it while still paying
    for the call."""

    def test_oversize_transcript_is_422(self, client):
        resp = client.post("/api/narration/lineup",
                           json=request_body(transcript="x" * 8001))
        assert resp.status_code == 422

    def test_transcript_at_the_cap_is_accepted(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup",
                            fake_model(["Kris"], []))
        resp = client.post("/api/narration/lineup",
                           json=request_body(transcript="x" * 8000))
        assert resp.status_code == 200

    def test_oversize_roster_is_422(self, client):
        roster = [{"name": f"P{i}", "nickname": None, "number": None}
                  for i in range(41)]
        resp = client.post("/api/narration/lineup", json=request_body(roster=roster))
        assert resp.status_code == 422


# =============================================================================
# Live prompt-quality eval (opt-in: NARRATION_LIVE_TESTS=1)
# =============================================================================

# The 18-scenario matrix that gated every prompt/contract change during
# development, ported verbatim so future changes can re-run the gate:
# Wholesale family (W), clear idioms (C), regression under tap semantics (S),
# additive UX (A), numbers-embedded-in-names rosters (M). Each runs END TO
# END: real prompt -> real model -> _derive_players -> the real frontend
# matcher (narration/lineupResolve.js under node).
_EVAL_R = [
    {"name": "Kris", "number": "12"}, {"name": "Sam", "number": "3"},
    {"name": "Hank", "number": "21"},
    {"name": "Morgan Vale", "nickname": "HB", "number": "8"},
    {"name": "Nora", "number": "44"}, {"name": "Omar", "number": "10"},
    {"name": "Wes", "number": "7"}, {"name": "Alice", "number": "2"},
    {"name": "Priya", "number": "5"}, {"name": "Dana", "nickname": "Hammer", "number": "99"},
    {"name": "Jake", "number": "77"}, {"name": "Charlie", "number": "14"},
]
_EVAL_NUMBERED = [{"name": f"{n} {j}"} for n, j in [
    ("Jamal", 23), ("Keisha", 7), ("Marcus", 15), ("Tanya", 4),
    ("DeShawn", 11), ("Lena", 9), ("Otis", 30), ("Rosa", 2), ("Andre", 55),
]]
_EVAL_PREV = ["Kris", "Wes", "Alice", "Sam", "Hank", "Nora", "Omar"]
_RECITE7 = {"Kris", "Sam", "Morgan Vale", "Nora", "Omar", "Wes", "Alice"}

_EVAL_SCENARIOS = [
    dict(id="W1-wholesale-3-go-in", roster=_EVAL_R, prev=_EVAL_PREV, sel=[],
         t="Jake, Kris, and Charlie go in", expect={"Jake", "Kris", "Charlie"}),
    dict(id="W2-wholesale-run-it-back", roster=_EVAL_R, prev=_EVAL_PREV, sel=[],
         t="Run it back", expect=set(_EVAL_PREV)),
    dict(id="W3-wholesale-sub-phrase", roster=_EVAL_R, prev=_EVAL_PREV, sel=[],
         t="Kris in for Wes", expect={"Kris"}),
    dict(id="C1-voiced-wholesale-then-ins", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Let's get a wholesale, then put in Kris, Charlie and Jake",
         expect={"Kris", "Charlie", "Jake"}),
    dict(id="C2-everybody-comes-off", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Everybody comes off", expect=set()),
    dict(id="C3-all-off-then-two-in", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="All players come off. Priya and Dana in.", expect={"Priya", "Dana"}),
    dict(id="S1-messy-corrections", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Kris, Sam, and is that Hank? No I think it's Morgan. Yeah, Morgan HB. "
           "And Kris is coming off, yeah that was a long point. Nora's on and Omar completes the lineup",
         grade="s1"),
    dict(id="S2-sub-run-it-back", roster=_EVAL_R,
         prev=["Wes", "Alice", "Sam", "Hank", "Nora", "Omar", "Priya"],
         sel=["Wes", "Alice", "Sam", "Hank", "Nora", "Omar", "Priya"],
         t="Kris goes in for Wes, everyone else run it back",
         expect={"Kris", "Alice", "Sam", "Hank", "Nora", "Omar", "Priya"}),
    dict(id="S3-jersey-sub", roster=_EVAL_R,
         prev=["Wes", "Alice", "Sam", "Kris", "Nora", "Omar", "Priya"],
         sel=["Wes", "Alice", "Sam", "Kris", "Nora", "Omar", "Priya"],
         t="Same line but number five comes off for big Morgan",
         expect={"Wes", "Alice", "Sam", "Kris", "Nora", "Omar", "Morgan Vale"}),
    dict(id="S4-recite-over-full-sel-unions", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Line is Kris, Sam, HB, Nora, Omar, Wes, Alice — water's behind the tent by the way",
         expect=set(_EVAL_PREV) | _RECITE7),
    dict(id="S5-corrected-sub-hammer", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Run it back except Priya in for Alice — actually no, Priya's in for Wes, Alice stays. And Hammer replaces Sam.",
         expect={"Kris", "Priya", "Alice", "Dana", "Hank", "Nora", "Omar"}),
    dict(id="A1-single-bare-add-partial", roster=_EVAL_R, prev=_EVAL_PREV,
         sel=["Alice", "Sam", "Nora"], t="Kris",
         expect={"Alice", "Sam", "Nora", "Kris"}),
    dict(id="A2-two-adds-filler-partial", roster=_EVAL_R, prev=_EVAL_PREV,
         sel=["Alice", "Sam", "Nora"], t="Umm... Priya. And Dana too.",
         expect={"Alice", "Sam", "Nora", "Priya", "Dana"}),
    dict(id="A3-bare-add-full-sel", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Priya", expect=set(_EVAL_PREV) | {"Priya"}),
    dict(id="A4-sub-partial-sel", roster=_EVAL_R, prev=_EVAL_PREV,
         sel=["Wes", "Alice", "Sam"], t="Kris in for Wes",
         expect={"Kris", "Alice", "Sam"}),
    dict(id="A5-recite-over-partial-unions", roster=_EVAL_R,
         prev=["Priya", "Dana"], sel=["Priya", "Dana"],
         t="Line is Kris, Sam, HB, Nora, Omar, Wes, Alice",
         expect={"Priya", "Dana"} | _RECITE7),
    dict(id="M1-numbered-recite-from-empty", roster=_EVAL_NUMBERED, prev=[], sel=[],
         t="Jamal, Keisha, Marcus, Tanya, DeShawn, Lena and Otis",
         expect={"Jamal 23", "Keisha 7", "Marcus 15", "Tanya 4", "DeShawn 11", "Lena 9", "Otis 30"}),
    dict(id="M2-numbered-single-add-partial", roster=_EVAL_NUMBERED,
         prev=["Keisha 7", "Tanya 4"], sel=["Keisha 7", "Tanya 4"],
         t="Add Jamal", expect={"Keisha 7", "Tanya 4", "Jamal 23"}),
]

_EVAL_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-5-20250929"]


def _grade_s1(matched):
    """Constraint-graded: named players in, Kris out, no fabrication;
    base members (Hank/Wes/Alice) may stay (merge read) or not (recite)."""
    must_in = {"Sam", "Morgan Vale", "Nora", "Omar"}
    must_out = {"Kris", "Priya", "Dana", "Jake", "Charlie"}
    allowed = must_in | {"Wes", "Alice", "Hank"}
    return must_in <= matched and not (matched & must_out) and matched <= allowed


def _frontend_match(returned, roster):
    """Run the returned names through the REAL client matcher under node."""
    import shutil
    import subprocess
    from pathlib import Path
    if not shutil.which("node"):
        pytest.skip("node not available for frontend-matcher leg")
    resolve_js = (Path(__file__).resolve().parents[1] / "narration" / "lineupResolve.js")
    script = (
        f"import {{ resolveLineupPlayers }} from '{resolve_js}';\n"
        f"const out = resolveLineupPlayers({json.dumps(returned)}, {json.dumps(roster)});\n"
        "console.log(JSON.stringify({m: out.players.map(p => p.name), u: out.unmatched}));"
    )
    r = subprocess.run(["node", "--input-type=module", "-e", script],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[:300]
    return json.loads(r.stdout)


@pytest.mark.live_llm
@pytest.mark.skipif(
    os.getenv("NARRATION_LIVE_TESTS") != "1" or not os.getenv("ANTHROPIC_API_KEY"),
    reason="live LLM eval; set NARRATION_LIVE_TESTS=1 with ANTHROPIC_API_KEY",
)
@pytest.mark.parametrize("model", _EVAL_MODELS)
@pytest.mark.parametrize("sc", _EVAL_SCENARIOS, ids=lambda s: s["id"])
def test_live_lineup_eval_matrix(sc, model, monkeypatch):
    """The shipping gate for lineup prompt/contract changes. Run with:
    NARRATION_LIVE_TESTS=1 pytest test_narration_lineup.py -k live -v
    (36 calls, ~2min, ~$0.10). One retry absorbs transient API timeouts."""
    import asyncio
    from narration_lineup import _call_claude_lineup, _derive_players

    monkeypatch.setenv("NARRATION_LINEUP_MODEL", model)
    req = make_request(
        transcript=sc["t"],
        roster=[LineupRosterPlayer(**pl) for pl in sc["roster"]],
        previous_lineup=sc["prev"], current_selection=sc["sel"],
    )
    prompt = _build_lineup_prompt(req)
    last_err = None
    for _ in range(2):
        try:
            res = asyncio.run(_call_claude_lineup(os.environ["ANTHROPIC_API_KEY"], prompt))
            break
        except Exception as e:  # noqa: BLE001 — transient API errors get one retry
            last_err = e
    else:
        pytest.fail(f"model call failed twice: {last_err}")

    players, ins, outs, cleared, dropped = _derive_players(res, req)
    fe = _frontend_match(players, sc["roster"])
    matched = set(fe["m"])
    assert not fe["u"], f"unmatched leak: {fe['u']} (in={ins})"
    if sc.get("grade") == "s1":
        assert _grade_s1(matched), f"matched={sorted(matched)} in={ins} out={outs}"
    else:
        assert matched == sc["expect"], (
            f"matched={sorted(matched)} expect={sorted(sc['expect'])} "
            f"in={ins} out={outs} clear={cleared}")
