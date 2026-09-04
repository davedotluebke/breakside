"""
Tests for the slow-pass finalize prompt and its scoring harness (narration.py,
tests/narration/runner.py).

These are pure — no API key, no network. They cover the parts of the slow pass
that were previously reachable only through the opt-in live corpus in
tests/narration/test_scenarios.py (that whole module is gated behind
NARRATION_LIVE_TESTS, so score_events had no coverage in the default run).

Focus is the `pull` event kind. Its rules are load-bearing in a way the other
kinds' are not: a pull is recorded automatically by the pull dialog at every
D-point start, so a narrated pull is a duplicate unless it names a puller the
dialog wouldn't have. Live probing showed the model will happily emit a bare
{"kind": "pull"} for scene-setting narration ("we pulled it", "they pull") if
the required-puller gate is ever softened, so that gate is pinned here.

The endpoint sections at the bottom cover the two routes in narration.py as
HTTP surfaces rather than as prompt builders: who may call them (both used to
take any authenticated user and never look at the game_id they were handed),
what they will accept into a prompt billed to the operator, and — for /token —
which OpenAI session a request may ask for. The provider calls are always
mocked; nothing here reaches a real API.

Run with: cd breakside_server && python -m pytest test_narration_finalize.py -v
"""
import pytest
from fastapi.testclient import TestClient

import narration
from narration import (
    FinalizeRequest,
    GameContext,
    RosterPlayer,
    _build_finalize_prompt,
)
from tests.narration.runner import _event_signature, score_events

from conftest import (
    NARRATION_COACH,
    NARRATION_GAME_ID,
    NARRATION_OTHER_COACH,
    NARRATION_OUTSIDER,
    NARRATION_VIEWER,
)


def build_prompt(offense=True, transcript="Alice throws to Bob."):
    return _build_finalize_prompt(FinalizeRequest(
        transcript=transcript,
        roster=[RosterPlayer(name="Alice"), RosterPlayer(name="Daniel")],
        game_context=GameContext(offense=offense, our_score=0, their_score=0),
        provisional_events=[],
        game_id="test",
    ))


# ---------------------------------------------------------------------------
# Prompt content
# ---------------------------------------------------------------------------

def test_pull_is_an_allowed_kind():
    prompt = build_prompt()
    kind_line = next(l for l in prompt.splitlines() if "kind: one of" in l)
    assert '"pull"' in kind_line


def test_pull_schema_documents_its_fields():
    prompt = build_prompt()
    assert "For kind=pull:" in prompt
    for field in ("puller", "flick", "roller", "io", "oi", "brick", "quality"):
        assert field in prompt, f"pull field {field!r} missing from prompt"


def test_pull_requires_a_named_puller():
    """
    The gate that keeps scene-setting narration from becoming junk events.
    Without it the model emits {"kind": "pull"} for "we pulled it" — verified
    live, twice, before this rule was strengthened.
    """
    prompt = build_prompt()
    assert "`puller` is REQUIRED" in prompt
    # The negative example must show the bare event as WRONG.
    assert 'WRONG: { "kind": "pull" }' in prompt


def test_pull_rules_reject_the_opponents_pull():
    prompt = build_prompt()
    assert "The opponent's pull is never our event" in prompt


def test_puller_listed_among_bare_name_fields():
    """Names must be emitted bare — no "#7" or nickname decoration."""
    prompt = build_prompt()
    assert "`defender`, and `puller` fields" in prompt


# ---------------------------------------------------------------------------
# Scoring harness — pull events must compare on their contents
# ---------------------------------------------------------------------------

def test_pull_signature_distinguishes_pullers():
    a = _event_signature({"kind": "pull", "puller": "Daniel"})
    b = _event_signature({"kind": "pull", "puller": "Gina"})
    assert a != b, "two pulls by different players must not score as a match"


def test_pull_signature_includes_flags():
    plain = _event_signature({"kind": "pull", "puller": "Daniel"})
    bricked = _event_signature({"kind": "pull", "puller": "Daniel", "brick": True})
    assert plain != bricked


def test_pull_signature_drops_false_flags():
    """Consistent with the other kinds: an omitted flag == an explicit False."""
    omitted = _event_signature({"kind": "pull", "puller": "Daniel"})
    explicit = _event_signature({
        "kind": "pull", "puller": "Daniel",
        "flick": False, "roller": False, "io": False, "oi": False, "brick": False,
    })
    assert omitted == explicit


def test_score_events_matches_an_expected_pull():
    expected = [{"kind": "pull", "puller": "Daniel", "flick": True}]
    ops = [{"op": "ADD", "event": {
        "kind": "pull", "puller": "Daniel", "flick": True, "brick": False,
    }}]
    score = score_events(expected, ops)
    assert score.matched == 1
    assert not score.missing and not score.extra


def test_score_events_flags_a_pullerless_pull_as_extra():
    """
    The regression this whole gate exists to catch: the model narrating
    "we pulled it" as an event. It must show up as a precision hit, not
    silently match an expected pull.
    """
    expected = [{"kind": "pull", "puller": "Daniel"}]
    ops = [{"op": "ADD", "event": {"kind": "pull"}}]
    score = score_events(expected, ops)
    assert score.matched == 0
    assert score.missing == expected
    assert score.extra == [{"kind": "pull"}]


def test_score_events_ignores_non_add_ops():
    expected = [{"kind": "pull", "puller": "Daniel"}]
    ops = [
        {"op": "CONFIRM", "provisional_id": "prov-1"},
        {"op": "ADD", "event": {"kind": "pull", "puller": "Daniel"}},
    ]
    score = score_events(expected, ops)
    assert score.matched == 1
    assert score.actual == 1
