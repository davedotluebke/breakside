"""
Tests for the lineup narration endpoint (narration_lineup.py).

Contract under test (tap-equivalent): the model returns only the voiced
changes {"in": [...], "out": [...]} — the verbal equivalent of tapping
names on the Lines tab — and the ENDPOINT derives the resulting selection
via set arithmetic. The model structurally cannot pick, complete, or trim
a lineup.

Prompt-content, parsing, and set-arithmetic tests are pure. Endpoint tests
use TestClient with auth overridden and the Claude call mocked.

An opt-in live test (NARRATION_LIVE_TESTS=1) runs the canonical messy
utterance through the real model as a prompt-quality eval.

Run with: cd ultistats_server && python -m pytest test_narration_lineup.py -v
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
    _lineup_model,
    _normalize_name,
    _parse_lineup_json,
)

MOCK_USER = {"id": "test-user", "email": "coach@test.com", "role": "authenticated"}


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
        assert '{"in": ["Name", ...], "out": [{"name": "Name", "said":' in prompt
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
def client():
    from main import app
    from auth.jwt_validation import get_current_user

    app.dependency_overrides[get_current_user] = lambda: MOCK_USER
    yield TestClient(app)
    app.dependency_overrides.clear()


def request_body(**overrides):
    body = {
        "game_id": "game-1",
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
        assert resp.status_code in (401, 403)


# =============================================================================
# Live prompt-quality eval (opt-in: NARRATION_LIVE_TESTS=1)
# =============================================================================

@pytest.mark.live_llm
@pytest.mark.skipif(
    os.getenv("NARRATION_LIVE_TESTS") != "1" or not os.getenv("ANTHROPIC_API_KEY"),
    reason="live LLM test; set NARRATION_LIVE_TESTS=1 with ANTHROPIC_API_KEY",
)
class TestLiveLineupExtraction:
    """Canonical messy utterance against the real model, graded under
    tap-equivalent semantics: named players go in, Kris comes off,
    unmentioned selected players (Hank) stay, nobody is fabricated."""

    def test_asides_and_corrections(self, client):
        transcript = (
            "Kris, Sam, and is that Hank? No I think it's Morgan. Yeah, Morgan HB. "
            "And Kris is coming off, yeah that was a long point. "
            "Nora's on and Omar completes the lineup"
        )
        roster = [
            {"name": "Kris", "number": "12"},
            {"name": "Sam", "number": "3"},
            {"name": "Hank", "number": "21"},
            {"name": "Morgan Vale", "nickname": "HB", "number": "8"},
            {"name": "Nora", "number": "44"},
            {"name": "Omar", "number": "10"},
            {"name": "Wes", "number": "7"},
            {"name": "Alice", "number": "2"},
            {"name": "Priya", "number": "5"},
        ]
        prev = ["Kris", "Wes", "Alice", "Sam", "Hank", "Nora", "Omar"]
        resp = client.post("/api/narration/lineup", json={
            "game_id": "live-test",
            "transcript": transcript,
            "roster": roster,
            "expected_count": 7,
            "previous_lineup": prev,
            "current_selection": prev,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["error"] is None, data
        players = set(data["players"])
        assert "Kris" not in players, data          # explicitly came off
        assert "Priya" not in players, data          # never mentioned, not selected
        for named in ("Sam", "Morgan Vale", "Nora", "Omar"):
            assert named in players, data
        for p in players:
            assert p in [r["name"] for r in roster] + prev, data
