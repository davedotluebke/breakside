"""
Tests for the lineup narration endpoint (narration_lineup.py).

Contract under test (tap-equivalent): the model returns only the voiced
changes {"in": [...], "out": [...]} — the verbal equivalent of tapping
names on the Lines tab — and the ENDPOINT derives the resulting selection
via set arithmetic. The model structurally cannot pick, complete, or trim
a lineup.

Prompt-content, parsing, and set-arithmetic tests are pure. Endpoint tests
use TestClient with the Claude call mocked; only ``get_current_user`` is
overridden (a test can't mint a Supabase JWT), so ``require_body_game_recorder``
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
    _derive_players,
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
        assert '"clear": false, "clear_said": "", "in": ["Name", ...], "out": [{"name": "Name", "said":' in prompt
        # Group phrases are reported, never expanded into names
        assert '"groups": [{"group": "FMP" | "MMP" | "ANY", "does": "in" | "out" | "auto", "count": null' in prompt
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
# The closed roster, group phrases and counts (shared with squads:
# narration_common.py)
# =============================================================================

G_ROSTER = [
    LineupRosterPlayer(name="Kris", number="12", gender="MMP"),
    LineupRosterPlayer(name="Wes", nickname="Big Wes", number="7", gender="MMP"),
    LineupRosterPlayer(name="Sam", number="3", gender="MMP"),
    LineupRosterPlayer(name="Alice", number="2", gender="FMP"),
    LineupRosterPlayer(name="Nora", number="44", gender="FMP"),
    LineupRosterPlayer(name="Dana", number="22", gender="FMP"),
    LineupRosterPlayer(name="Morgan Vale", nickname="MV", gender="Unknown"),
]


def g_request(transcript, sel=("Wes", "Alice", "Sam"), **overrides):
    return make_request(transcript=transcript, roster=G_ROSTER,
                        current_selection=list(sel), previous_lineup=list(sel), **overrides)


def reply(ins=(), out=(), groups=(), unmatched=(), phrases=(), clear=False, clear_said=""):
    return {"in": list(ins), "out": list(out), "groups": list(groups), "unmatched": list(unmatched),
            "phrases": list(phrases), "clear": clear, "clear_said": clear_said, "note": ""}


class TestLineupClosedRoster:
    def test_mangled_in_resolves_to_the_roster_spelling(self):
        d = _derive_players(reply(ins=["Chris", "Norah"]), g_request("Chris and Norah"))
        assert d.players == ["Wes", "Alice", "Sam", "Kris", "Nora"]
        assert d.ins == ["Kris", "Nora"]
        assert d.resolved == [("Chris", "Kris"), ("Norah", "Nora")] and d.unmatched == []

    def test_stranger_goes_to_unmatched_not_into_the_line(self):
        d = _derive_players(reply(ins=["Kris", "Zebediah"]), g_request("Kris and Zebediah"))
        assert d.players == ["Wes", "Alice", "Sam", "Kris"] and d.unmatched == ["Zebediah"]

    def test_nickname_and_bare_jersey_number(self):
        d = _derive_players(reply(ins=["MV", 44, "#22"]), g_request("MV, forty four and twenty two", sel=()))
        assert d.players == ["Morgan Vale", "Nora", "Dana"]

    def test_sit_out_of_a_mangled_name(self):
        d = _derive_players(reply(out=[{"name": "Wes", "said": "Wess sits"}]), g_request("Wess sits"))
        assert d.outs == ["Wes"] and d.players == ["Alice", "Sam"] and not d.dropped

    def test_out_named_as_heard_still_needs_its_quote(self):
        d = _derive_players(reply(out=[{"name": "Wess", "said": "Wess sits"}]), g_request("Kris in"))
        assert d.outs == [] and d.dropped == ["Wes"] and d.players == ["Wes", "Alice", "Sam"]

    def test_spurious_unmatched_for_a_reported_player_is_dropped(self):
        d = _derive_players(reply(ins=["Kris"], unmatched=["Chris"]), g_request("Chris goes in"))
        assert d.players[-1] == "Kris" and d.unmatched == []

    def test_given_up_name_is_recovered_from_an_in_phrase_only(self):
        req = g_request("Norah goes in. Kris in for Dayna.")
        phrases = [{"words": "Norah goes in", "does": "in"}, {"words": "Kris in for Dayna", "does": "swap"}]
        d = _derive_players(reply(ins=["Kris"], unmatched=["Norah", "Dayna"], phrases=phrases), req)
        assert d.ins == ["Kris", "Nora"]            # Norah recovered; Dayna is not guessed at
        assert d.unmatched == ["Dayna"]
        assert "Dana" not in d.players

    def test_recovery_needs_the_phrase_in_the_transcript(self):
        req = g_request("Kris goes in")
        d = _derive_players(reply(ins=["Kris"], unmatched=["Norah"],
                                  phrases=[{"words": "Norah goes in", "does": "in"}]), req)
        assert d.ins == ["Kris"] and d.unmatched == ["Norah"]


class TestLineupGroups:
    def test_count_becomes_a_fill_and_selects_nobody(self):
        req = g_request("Two more women, and add a guy")
        d = _derive_players(reply(groups=[
            {"group": "FMP", "does": "in", "count": 2, "said": "Two more women"},
            {"group": "MMP", "does": "in", "count": 1, "said": "add a guy"},
        ]), req)
        assert d.fills == [("FMP", 2), ("MMP", 1)]
        assert d.players == ["Wes", "Alice", "Sam"] and d.group_outs == []

    def test_ungendered_count(self):
        d = _derive_players(reply(groups=[
            {"group": "ANY", "does": "in", "count": 3, "said": "three more"}]), g_request("and three more"))
        assert d.fills == [("ANY", 3)]

    def test_count_must_be_in_the_quote(self):
        d = _derive_players(reply(groups=[
            {"group": "FMP", "does": "in", "count": 4, "said": "more women"}]), g_request("more women"))
        assert d.fills == [] and d.dropped == ["<group:count>"]

    def test_whole_group_comes_off(self):
        req = g_request("The guys come off", sel=("Wes", "Alice", "Sam", "Nora", "Morgan Vale"))
        d = _derive_players(reply(groups=[
            {"group": "MMP", "does": "out", "count": None, "said": "The guys come off"}]), req)
        assert d.group_outs == ["MMP"]
        assert d.players == ["Alice", "Nora", "Morgan Vale"]   # unknown gender is in neither group

    def test_group_off_spares_a_player_named_in_the_same_breath(self):
        req = g_request("All the guys off, but Wes stays in, and Kris goes in")
        d = _derive_players(reply(ins=["Wes", "Kris"], groups=[
            {"group": "MMP", "does": "out", "count": None, "said": "All the guys off"}]), req)
        assert d.players == ["Wes", "Alice", "Kris"]

    def test_the_quote_decides_the_group_and_checks_the_direction(self):
        req = g_request("The GMPs come off")
        d = _derive_players(reply(groups=[
            {"group": "MMP", "does": "out", "count": None, "said": "The GMPs come off"}]), req)
        assert d.group_outs == ["FMP"] and d.players == ["Wes", "Sam"]
        # "out" without removal words in the quote, "in" with them: refused
        for g in ({"group": "MMP", "does": "out", "count": None, "said": "the guys"},
                  {"group": "MMP", "does": "in", "count": 2, "said": "two guys come off"}):
            d = _derive_players(reply(groups=[g]), g_request("the guys. two guys come off"))
            assert d.fills == [] and d.group_outs == [] and d.dropped == ["<group:unsupported>"]

    def test_a_whole_group_going_in_is_not_supported(self):
        d = _derive_players(reply(groups=[
            {"group": "FMP", "does": "in", "count": None, "said": "all the women"}]), g_request("all the women"))
        assert d.fills == [] and d.group_outs == [] and d.dropped == ["<group:unsupported>"]

    def test_group_without_evidence_is_dropped(self):
        d = _derive_players(reply(groups=[
            {"group": "FMP", "does": "in", "count": 2, "said": "two more women"}]), g_request("Kris in"))
        assert d.fills == [] and d.dropped == ["<group>"]

    # --- the voiced Auto: "auto the rest", "auto-pick the FMPs" ---

    def test_auto_the_rest_hands_the_line_to_auto(self):
        for said in ("auto the rest", "auto-pick the rest", "Auto-select everybody else",
                     "autofill", "auto the line"):
            req = g_request(f"Kris, and {said}")
            d = _derive_players(reply(ins=["Kris"], groups=[
                {"group": "ANY", "does": "auto", "count": None, "said": said}]), req)
            assert d.autos == ["ANY"], said
            assert d.fills == [] and d.group_outs == [] and d.dropped == [], said
            # Auto is the client's pick: the server selects nobody for it.
            assert d.players == ["Wes", "Alice", "Sam", "Kris"], said

    def test_auto_for_one_gender_group_reads_the_group_from_the_quote(self):
        req = g_request("Auto-pick the FMPs. Auto the rest of the guys.")
        d = _derive_players(reply(groups=[
            {"group": "ANY", "does": "auto", "count": None, "said": "Auto-pick the FMPs"},
            {"group": "MMP", "does": "auto", "count": None, "said": "Auto the rest of the guys"},
        ]), req)
        assert d.autos == ["FMP", "MMP"] and d.dropped == []

    def test_the_word_auto_must_be_in_the_quote(self):
        # "does": "auto" on a wrap-up or a fill-in phrase is refused: only
        # the word hands the picking over.
        for said in ("that completes the line", "fill in the rest", "everybody else"):
            d = _derive_players(reply(groups=[
                {"group": "ANY", "does": "auto", "count": None, "said": said}]), g_request(f"Kris and {said}"))
            assert d.autos == [] and d.dropped == ["<group:unsupported>"], said

    def test_the_quote_decides_auto_whatever_the_model_called_it(self):
        d = _derive_players(reply(groups=[
            {"group": "FMP", "does": "in", "count": None, "said": "auto-pick the women"}]),
            g_request("auto-pick the women"))
        assert d.autos == ["FMP"]
        # ...but a model that read it as a removal vetoes it, and a quote that
        # both removes and hands off is not guessed at.
        for g, t in (({"group": "ANY", "does": "out", "count": None, "said": "auto the rest"}, "auto the rest"),
                     ({"group": "MMP", "does": "auto", "count": None, "said": "the guys come off and auto the rest"},
                      "the guys come off and auto the rest")):
            d = _derive_players(reply(groups=[g]), g_request(t))
            assert d.autos == [] and d.group_outs == [] and d.dropped == ["<group:unsupported>"]

    def test_auto_with_a_count_is_a_count(self):
        d = _derive_players(reply(groups=[
            {"group": "FMP", "does": "auto", "count": 2, "said": "auto-pick two more women"}]),
            g_request("auto-pick two more women"))
        assert d.fills == [("FMP", 2)] and d.autos == []

    def test_the_rest_is_not_a_removal_word(self):
        # _REMOVAL_RE has "rest" for "Wes rests"; "the rest" is who is left.
        d = _derive_players(reply(groups=[
            {"group": "MMP", "does": "in", "count": 2, "said": "two guys for the rest"}]),
            g_request("two guys for the rest"))
        assert d.fills == [("MMP", 2)]
        d = _derive_players(reply(groups=[
            {"group": "MMP", "does": "out", "count": None, "said": "the guys take a rest"}]),
            g_request("the guys take a rest"))
        assert d.group_outs == ["MMP"]

    def test_auto_heard_as_otto_only_when_nobody_is_called_otto(self):
        said = "Otto the rest"
        d = _derive_players(reply(ins=["Kris"], unmatched=["Otto"], groups=[
            {"group": "ANY", "does": "auto", "count": None, "said": said}]), g_request(f"Kris, {said}"))
        assert d.autos == ["ANY"] and d.unmatched == []
        with_otto = G_ROSTER + [LineupRosterPlayer(name="Otto Lake", gender="MMP")]
        d = _derive_players(reply(groups=[
            {"group": "ANY", "does": "auto", "count": None, "said": said}]),
            make_request(transcript=said, roster=with_otto, current_selection=[], previous_lineup=[]))
        assert d.autos == [] and d.dropped == ["<group:unsupported>"]

    def test_auto_evidence_must_be_in_the_transcript(self):
        d = _derive_players(reply(groups=[
            {"group": "ANY", "does": "auto", "count": None, "said": "auto the rest"}]), g_request("Kris in"))
        assert d.autos == [] and d.dropped == ["<group>"]

    def test_prompt_carries_the_shared_rules(self):
        prompt = _build_lineup_prompt(g_request("Kris in"))
        assert '"does": "in" | "out" | "auto"' in prompt and "AUTO — the coach hands" in prompt
        assert "THE ROSTER IS CLOSED" in prompt
        assert "it is NOT a mishearing of MMP" in prompt
        assert "- Wes \"Big Wes\" #7 [MMP]" in prompt and "- Morgan Vale \"MV\"\n" in prompt
        assert 'Fill "phrases" FIRST, as a worksheet' in prompt

    def test_both_prompts_use_the_same_names_and_gender_rules(self):
        """The point of narration_common: a rule about names or gender words
        is written once."""
        from narration_common import rule_gender_words
        from narration_squads import SquadsRequest, SquadsRosterPlayer, _build_squads_prompt
        lineup = _build_lineup_prompt(g_request("Kris in"))
        squads = _build_squads_prompt(SquadsRequest(
            teamId="t", transcript="Kris on Dark",
            roster=[SquadsRosterPlayer(**p.model_dump()) for p in G_ROSTER],
            squad_names={"X": "Dark", "Y": "Light"}))
        assert rule_gender_words() in lineup and rule_gender_words() in squads
        closed = lineup[lineup.index("THE ROSTER IS CLOSED"):lineup.index("Put the ROSTER spelling")]
        assert closed in squads
        roster_intro = lineup[lineup.index("Team roster."):lineup.index("- Kris")]
        assert roster_intro in squads


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

    def test_fills_and_group_out_in_the_response(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return reply(groups=[
                {"group": "MMP", "does": "out", "count": None, "said": "the guys come off"},
                {"group": "FMP", "does": "in", "count": 2, "said": "two more women"}])
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        body = request_body(transcript="the guys come off and two more women",
                            roster=[p.model_dump() for p in G_ROSTER],
                            current_selection=["Wes", "Alice", "Sam"])
        data = client.post("/api/narration/lineup", json=body).json()
        assert data["players"] == ["Alice"]
        assert data["voiced_group_out"] == ["MMP"]
        assert data["fills"] == [{"group": "FMP", "count": 2}]
        assert data["error"] is None

    def test_voiced_auto_in_the_response(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return reply(ins=["Kris"], groups=[
                {"group": "ANY", "does": "auto", "count": None, "said": "auto the rest"}])
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        body = request_body(transcript="Kris, and auto the rest",
                            roster=[p.model_dump() for p in G_ROSTER], current_selection=[])
        data = client.post("/api/narration/lineup", json=body).json()
        # The server names nobody for Auto: the Lines tab does the picking.
        assert data["players"] == ["Kris"] and data["fills"] == []
        assert data["voiced_auto"] == ["ANY"]
        assert data["error"] is None

    def test_a_client_that_sends_no_gender_still_works(self, client, monkeypatch):
        """Clients before the group phrases send name / nickname / number only:
        names work as ever, a group phrase finds nobody to take off."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def call(api_key, prompt):
            return reply(ins=["Kris"], groups=[
                {"group": "MMP", "does": "out", "count": None, "said": "the guys come off"}])
        monkeypatch.setattr(narration_lineup, "_call_claude_lineup", call)
        data = client.post("/api/narration/lineup", json=request_body(
            transcript="the guys come off, Kris in")).json()
        assert data["players"] == ["Wes", "Alice", "Kris"]

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
        # A bare number is a jersey number: 7 is Wes (#7), not a player called "7".
        assert data["players"] == ["Kris", "Wes"]
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
# spend the budget. These tests drive the REAL require_body_game_recorder — only
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
# The same roster with gender groups, for the group-phrase scenarios (G).
_EVAL_FMP = {"Morgan Vale", "Nora", "Alice", "Priya", "Dana"}
_EVAL_RG = [dict(p, gender="FMP" if p["name"] in _EVAL_FMP else "MMP") for p in _EVAL_R]
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
    # Names the recognizer mangled (N): the roster is closed, so each is
    # somebody on it. Deliberately not the prompt's own examples.
    dict(id="N1-mangled-names-go-in", roster=_EVAL_R, prev=_EVAL_PREV, sel=[],
         t="Omer, Norah, and Preeya go in", expect={"Omar", "Nora", "Priya"}),
    dict(id="N2-mangled-sub", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Charly in for Wess",
         expect={"Kris", "Charlie", "Alice", "Sam", "Hank", "Nora", "Omar"}),
    dict(id="N3-mangled-add-and-off", roster=_EVAL_R, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Hanc is coming off. Add Jakey.",
         expect={"Kris", "Wes", "Alice", "Sam", "Nora", "Omar", "Jake"}),
    # Group phrases and counts (G): reported, never expanded into names.
    dict(id="G1-count-of-a-group", roster=_EVAL_RG, prev=_EVAL_PREV,
         sel=["Kris", "Wes", "Alice", "Sam", "Hank"], t="Two more women",
         expect={"Kris", "Wes", "Alice", "Sam", "Hank"}, fills=[("FMP", 2)]),
    dict(id="G2-names-then-a-count", roster=_EVAL_RG, prev=_EVAL_PREV, sel=[],
         t="Kris, Sam and Alice, plus a couple of guys",
         expect={"Kris", "Sam", "Alice"}, fills=[("MMP", 2)]),
    dict(id="G3-group-off-then-names", roster=_EVAL_RG, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="All the guys come off. Jake and Charlie go in.",
         expect={"Alice", "Nora", "Jake", "Charlie"}, group_out=["MMP"]),
    dict(id="G4-ungendered-count", roster=_EVAL_RG, prev=_EVAL_PREV,
         sel=["Kris", "Wes", "Alice", "Sam"], t="Add three more",
         expect={"Kris", "Wes", "Alice", "Sam"}, fills=[("ANY", 3)]),
    dict(id="G5-wrap-up-is-not-a-fill", roster=_EVAL_RG, prev=_EVAL_PREV, sel=[],
         t="Kris and Sam, and Nora completes the line. That's the seven.",
         expect={"Kris", "Sam", "Nora"}),
    dict(id="G6-fmps-initialism", roster=_EVAL_RG, prev=_EVAL_PREV,
         sel=["Kris", "Wes", "Sam", "Hank"], t="Three F.M.P.s and we're good",
         expect={"Kris", "Wes", "Sam", "Hank"}, fills=[("FMP", 3)]),
    # The voiced Auto (U): the coach hands the picking to the app; the model
    # reports the phrase and names nobody for it.
    dict(id="U1-names-then-auto-the-rest", roster=_EVAL_RG, prev=_EVAL_PREV, sel=[],
         t="Kris and Alice, and auto the rest", expect={"Kris", "Alice"}, auto=["ANY"]),
    dict(id="U2-auto-select-everybody-else", roster=_EVAL_RG, prev=_EVAL_PREV,
         sel=["Wes", "Sam", "Nora"], t="Auto-select everybody else.",
         expect={"Wes", "Sam", "Nora"}, auto=["ANY"]),
    dict(id="U3-auto-pick-the-fmps", roster=_EVAL_RG, prev=_EVAL_PREV, sel=[],
         t="Auto-pick the FMPs. The guys are Jake, Charlie and Hank.",
         expect={"Jake", "Charlie", "Hank"}, auto=["FMP"]),
    dict(id="U4-wholesale-then-auto", roster=_EVAL_RG, prev=_EVAL_PREV, sel=_EVAL_PREV,
         t="Wholesale. Auto the line.", expect=set(), auto=["ANY"]),
    dict(id="U5-sub-then-auto-the-guys", roster=_EVAL_RG, prev=_EVAL_PREV,
         sel=["Alice", "Nora", "Wes"], t="Priya in for Wes, and auto-pick the rest of the guys",
         expect={"Alice", "Nora", "Priya"}, auto=["MMP"]),
    dict(id="U6-auto-heard-as-otto", roster=_EVAL_RG, prev=_EVAL_PREV, sel=[],
         t="Sam, Dana, and Otto the rest.", expect={"Sam", "Dana"}, auto=["ANY"]),
    dict(id="U7-count-then-auto", roster=_EVAL_RG, prev=_EVAL_PREV, sel=["Kris"],
         t="Two more women and then auto-pick the rest", expect={"Kris"},
         fills=[("FMP", 2)], auto=["ANY"]),
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
    (68 calls, ~3min, ~$0.20). One retry absorbs transient API timeouts."""
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

    d = _derive_players(res, req)
    players, ins, outs = d.players, d.ins, d.outs
    fe = _frontend_match(players, sc["roster"])
    matched = set(fe["m"])
    assert not fe["u"], f"unmatched leak: {fe['u']} (in={ins})"
    # A fill or a group coming off only when the coach asked for one — on
    # every scenario, so a wrap-up ("Omar completes the lineup") that starts
    # producing fills is caught.
    assert d.fills == sc.get("fills", []), f"fills={d.fills} dropped={d.dropped} note={res.get('note')!r}"
    assert d.group_outs == sc.get("group_out", []), f"group_outs={d.group_outs} dropped={d.dropped}"
    assert d.autos == sc.get("auto", []), f"autos={d.autos} dropped={d.dropped} note={res.get('note')!r}"
    assert not d.unmatched or "auto" not in sc, f"unmatched={d.unmatched}"
    if sc.get("grade") == "s1":
        assert _grade_s1(matched), f"matched={sorted(matched)} in={ins} out={outs}"
    else:
        assert matched == sc["expect"], (
            f"matched={sorted(matched)} expect={sorted(sc['expect'])} "
            f"in={ins} out={outs} clear={d.cleared}")
