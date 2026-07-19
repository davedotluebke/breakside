"""
Tests for the lineup narration endpoint (narration_lineup.py).

Prompt-content and parsing tests are pure. Endpoint tests use TestClient
with auth overridden and the Claude call mocked — no storage involved
(the endpoint is stateless).

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
    _build_lineup_prompt,
    _lineup_model,
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

    def test_prompt_includes_previous_lineup_and_current_selection(self):
        prompt = _build_lineup_prompt(make_request())
        prev_section = prompt.split("Previous lineup")[1].split("Currently selected")[0]
        assert "- Alice" in prev_section and "- Bob" in prev_section
        curr_section = prompt.split("Currently selected")[1].split("Transcript")[0]
        assert "- Alice" in curr_section and "- Bob" not in curr_section

    def test_prompt_handles_empty_previous_lineup(self):
        prompt = _build_lineup_prompt(make_request(previous_lineup=[], current_selection=[]))
        assert "(none — no points played yet)" in prompt
        assert "(empty)" in prompt

    def test_prompt_includes_transcript(self):
        prompt = _build_lineup_prompt(make_request(transcript="same line but Kris for Wes"))
        assert "same line but Kris for Wes" in prompt

    def test_prompt_states_key_interpretation_rules(self):
        """The rules that make this robust to subs phrasing and corrections
        must actually be in the prompt — this pins them against edits."""
        prompt = _build_lineup_prompt(make_request())
        # Substitution semantics
        assert '"X goes in for Y"' in prompt
        assert '"same line"' in prompt
        assert '"X is coming off"' in prompt
        # Corrections: later statements win
        assert "Later statements override earlier ones" in prompt
        # Asides are ignored
        assert "Ignore asides" in prompt
        # Never invent players; unmatched bucket
        assert "unmatched" in prompt
        # Expected size is context, never padding
        assert "Do not pad the lineup" in prompt

    def test_prompt_demands_exact_roster_spelling(self):
        prompt = _build_lineup_prompt(make_request())
        assert "EXACTLY as it appears" in prompt


# =============================================================================
# Response parsing
# =============================================================================

class TestParseLineupJson:
    def test_plain_json(self):
        out = _parse_lineup_json('{"players": ["A", "B"], "unmatched": [], "note": ""}')
        assert out["players"] == ["A", "B"]

    def test_fenced_json(self):
        out = _parse_lineup_json('```json\n{"players": ["A"], "unmatched": ["zeb"], "note": "n"}\n```')
        assert out["players"] == ["A"]
        assert out["unmatched"] == ["zeb"]

    def test_fenced_without_language_tag(self):
        out = _parse_lineup_json('```\n{"players": []}\n```')
        assert out["players"] == []

    def test_garbage_raises(self):
        with pytest.raises(Exception):
            _parse_lineup_json("Sure! The lineup is Kris, Max and Morgan.")

    def test_missing_players_key_raises(self):
        with pytest.raises(RuntimeError):
            _parse_lineup_json('{"lineup": ["A"]}')


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
        ],
        "expected_count": 7,
        "previous_lineup": ["Wes"],
        "current_selection": ["Wes"],
    }
    body.update(overrides)
    return body


class TestLineupEndpoint:
    def test_503_without_api_key(self, client, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        resp = client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 503
        assert "ANTHROPIC_API_KEY" in resp.json()["detail"]

    def test_success_with_mocked_claude(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def fake_call(api_key, prompt):
            assert api_key == "test-key"
            assert "Kris goes in for Wes" in prompt
            return {"players": ["Kris"], "unmatched": ["zeb"], "note": "swapped for Wes"}

        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", fake_call)
        resp = client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 200
        data = resp.json()
        assert data["players"] == ["Kris"]
        assert data["unmatched"] == ["zeb"]
        assert data["note"] == "swapped for Wes"
        assert data["error"] is None

    def test_empty_transcript_is_error_payload(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/narration/lineup", json=request_body(transcript="   "))
        assert resp.status_code == 200
        data = resp.json()
        assert data["players"] == []
        assert data["error"] == "Empty transcript"

    def test_empty_roster_is_error_payload(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/narration/lineup", json=request_body(roster=[]))
        assert resp.status_code == 200
        assert resp.json()["error"] == "Empty roster"

    def test_claude_failure_degrades_to_error_payload(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def failing_call(api_key, prompt):
            raise RuntimeError("Anthropic API 529: overloaded")

        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", failing_call)
        resp = client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 200
        data = resp.json()
        assert data["players"] == []
        assert "overloaded" in data["error"]

    def test_non_string_entries_are_shaped(self, client, monkeypatch):
        """Model misbehavior (objects in lists) must not 500 or leak junk."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def odd_call(api_key, prompt):
            return {"players": ["Kris", {"name": "bad"}, 7], "unmatched": [None], "note": None}

        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", odd_call)
        resp = client.post("/api/narration/lineup", json=request_body())
        assert resp.status_code == 200
        data = resp.json()
        assert data["players"] == ["Kris", "7"]
        assert data["unmatched"] == []
        assert data["note"] == ""

    def test_requires_auth(self):
        """Without the auth override, the endpoint must not be open."""
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
    """The canonical messy utterance from the feature request, against the
    real model. Asserts only what a human reading it would insist on."""

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
        players = data["players"]
        # The corrections must resolve in favor of the last statement:
        assert "Kris" not in players, data       # "Kris is coming off"
        assert "Hank" not in players, data        # "No I think it's Morgan"
        assert "Morgan Vale" in players, data # corrected + "HB" fragment
        for definite in ("Sam", "Nora", "Omar"):
            assert definite in players, data
        # Exact roster spellings only
        for p in players:
            assert p in [r["name"] for r in roster], data
