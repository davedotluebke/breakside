"""
Tests for the squads narration endpoint (narration_squads.py, POST
/api/narration/squads) — the scrimmage dialog's voice input.

Contract under test (tap-equivalent, as /lineup): the model only REPORTS
what the coach said — named placements, sit-outs, collective phrases and
counts, each with a quote where it places people it did not name — and the
ENDPOINT does the rest:

  - a blank squad means the FIRST squad (the coach who just reads out names);
  - the roster is CLOSED, so a mangled name resolves to the one roster name
    it is closest to, even when the model gave up on it;
  - "everyone else", "the FMPs", "the rest of the guys" are expanded here,
    over players who are here today, leaving ones the coach already placed
    alone when the phrase says "rest";
  - "two more FMPs on Dark" goes back as a verified ``fill`` for the picker
    to choose — nobody on the server picks players.

Pure tests cover the derivation, the lexicons and guards and the prompt;
endpoint tests run TestClient with the Claude call mocked and only
``get_current_user`` overridden, so ``require_body_team_recorder`` runs for
real against the ``narration_data`` fixture's memberships. An opt-in live
matrix (NARRATION_LIVE_TESTS=1) is the gate for prompt changes.

Run with: cd breakside_server && python -m pytest test_narration_squads.py -v
"""
import os

import pytest
from fastapi.testclient import TestClient

import narration_squads
from narration_common import (
    _closest_roster_name,
    _count_evidence_ok,
    _group_evidence_ok,
    _group_in_quote,
    _rest_evidence_ok,
)
from narration_squads import (
    SquadsRequest,
    SquadsRosterPlayer,
    _apply_squad_changes,
    _build_squads_prompt,
    _derive_squads,
    _parse_squads_json,
    _squad_key,
)

from conftest import (
    NARRATION_COACH,
    NARRATION_OTHER_COACH,
    NARRATION_OUTSIDER,
    NARRATION_VIEWER,
)

NAMES = {"X": "Orange", "Y": "Black"}

# The canonical fictional roster (ARCHITECTURE.md § Names in examples).
FMPS = ["Alice", "Dana", "Eve", "Iris", "Mia", "Nora", "Tara", "Zoe"]
MMPS = ["Bob", "Charlie", "Hank", "Jake", "Kris", "Omar", "Sam", "Wes"]
EVERYONE = sorted(FMPS + MMPS)


def roster(absent=(), pinned=(), extra=()):
    players = [
        SquadsRosterPlayer(
            name=n, gender="FMP" if n in FMPS else "MMP",
            here=n not in absent, pinned=n in pinned,
            nickname="Bobby" if n == "Bob" else None,
            number="3" if n == "Charlie" else None,
        )
        for n in EVERYONE
    ]
    return players + list(extra)


def make_request(transcript="Alice and Bob on Orange, Dana on Black", **overrides):
    base = dict(
        teamId="team-1",
        transcript=transcript,
        roster=roster(),
        squad_names=NAMES,
        current_squads={"X": ["Charlie"], "Y": ["Eve"]},
    )
    base.update(overrides)
    return SquadsRequest(**base)


def model_reply(assign=None, out=None, groups=None, clear=False, clear_said="",
                rest="", rest_said="", unmatched=None, phrases=None, note=""):
    return {
        "phrases": phrases or [],
        "clear": clear, "clear_said": clear_said,
        "assign": assign or [], "groups": groups or [],
        "rest": rest, "rest_said": rest_said,
        "out": out or [], "unmatched": unmatched or [], "note": note,
    }


def placed(*pairs):
    return [{"name": n, "squad": s} for n, s in pairs]


def sorted_squads(d):
    return {k: sorted(v) for k, v in d.squads.items()}


# =============================================================================
# Squad-word mapping and the default squad
# =============================================================================

class TestSquadKey:
    def test_blank_means_first_squad(self):
        assert _squad_key("", NAMES) == "X"
        assert _squad_key(None, NAMES) == "X"
        assert _squad_key("   ", NAMES) == "X"

    def test_names_map_case_insensitively(self):
        assert _squad_key("orange", NAMES) == "X"
        assert _squad_key("BLACK", NAMES) == "Y"
        assert _squad_key("Black.", NAMES) == "Y"

    def test_key_letters_and_words_of_a_name(self):
        assert _squad_key("Y", NAMES) == "Y"
        assert _squad_key("team orange", NAMES) == "X"
        assert _squad_key("Light", {"X": "Dark Blue", "Y": "Light Grey"}) == "Y"

    def test_unknown_squad_is_none(self):
        assert _squad_key("Green", NAMES) is None


# =============================================================================
# The closed roster: a name as heard
# =============================================================================

class TestClosestRosterName:
    @pytest.mark.parametrize("heard,expected", [
        ("Dayna", "Dana"), ("Omer", "Omar"), ("Tera", "Tara"), ("Norah", "Nora"),
        ("Hanc", "Hank"), ("Wess", "Wes"), ("Mya", "Mia"), ("Zoey", "Zoe"),
        ("Charley", "Charlie"), ("Char", "Charlie"), ("bobby", "Bob"),
    ])
    def test_mangled_names_resolve(self, heard, expected):
        assert _closest_roster_name(heard, roster()) == expected

    @pytest.mark.parametrize("heard", ["Zebediah", "Priya", "the new kid", "Al", "xx", ""])
    def test_strangers_and_fragments_do_not(self, heard):
        assert _closest_roster_name(heard, roster()) is None

    def test_a_name_that_could_be_two_players_stays_unmatched(self):
        twins = [SquadsRosterPlayer(name="Dana"), SquadsRosterPlayer(name="Dara")]
        assert _closest_roster_name("Dama", twins) is None
        assert _closest_roster_name("Dana", twins) == "Dana"   # exact is always its own best

    def test_derivation_resolves_a_mangled_placement(self):
        req = make_request("Dayna and Omer on Black", current_squads={})
        d = _derive_squads(model_reply(assign=placed(("Dayna", "Black"), ("Omer", "Black"))), req)
        assert d.squads == {"X": [], "Y": ["Dana", "Omar"]}
        assert d.assign == [("Dana", "Y"), ("Omar", "Y")]
        assert d.resolved == [("Dayna", "Dana"), ("Omer", "Omar")]
        assert d.unmatched == []

    def test_spurious_unmatched_for_a_placed_player_is_dropped(self):
        """A small model lists the word as unmatched AND places the player."""
        req = make_request("Alice and Dayna on Orange", current_squads={})
        d = _derive_squads(model_reply(assign=placed(("Alice", "Orange"), ("Dana", "Orange")),
                                       unmatched=["Dayna"]), req)
        assert d.squads["X"] == ["Alice", "Dana"] and d.unmatched == []

    def test_given_up_name_is_recovered_from_the_worksheet(self):
        """The model left the word in "unmatched" with no placement: the
        phrase it was spoken in says which squad."""
        req = make_request("Alice and Dayna on Black. Bob on Orange.", current_squads={})
        reply = model_reply(
            phrases=[{"words": "Alice and Dayna on Black", "squad": "Black"},
                     {"words": "Bob on Orange", "squad": "Orange"}],
            assign=placed(("Alice", "Black"), ("Bob", "Orange")), unmatched=["Dayna"])
        d = _derive_squads(reply, req)
        assert d.squads == {"X": ["Bob"], "Y": ["Alice", "Dana"]}
        assert ("Dayna", "Dana") in d.resolved and d.unmatched == []

    def test_recovery_needs_a_real_phrase_and_never_from_a_sit_out(self):
        req = make_request("Dayna sits out. Bob on Orange.", current_squads={"X": [], "Y": ["Dana"]})
        sit_out = model_reply(phrases=[{"words": "Dayna sits out", "squad": ""}],
                              assign=placed(("Bob", "Orange")), unmatched=["Dayna"])
        d = _derive_squads(sit_out, req)
        assert d.squads == {"X": ["Bob"], "Y": ["Dana"]} and d.unmatched == ["Dayna"]

        invented = model_reply(phrases=[{"words": "Dayna on Black", "squad": "Black"}],
                               assign=placed(("Bob", "Orange")), unmatched=["Dayna"])
        d = _derive_squads(invented, req)
        assert d.squads["Y"] == ["Dana"] and d.unmatched == ["Dayna"]   # phrase is not in the transcript

    def test_stranger_goes_to_unmatched_and_places_nobody(self):
        req = make_request("Alice and Zebediah on Orange", current_squads={})
        d = _derive_squads(model_reply(assign=placed(("Alice", "Orange"), ("Zebediah", "Orange"))), req)
        assert d.squads == {"X": ["Alice"], "Y": []} and d.unmatched == ["Zebediah"]

    def test_sit_out_of_a_mangled_name(self):
        req = make_request("Tera sits out today", current_squads={"X": ["Tara"], "Y": []})
        d = _derive_squads(model_reply(out=[{"name": "Tara", "said": "Tera sits out"}]), req)
        assert d.outs == ["Tara"] and d.squads == {"X": [], "Y": []} and not d.dropped


# =============================================================================
# Set arithmetic
# =============================================================================

class TestApplySquadChanges:
    def test_placements_move_players_between_squads(self):
        squads = _apply_squad_changes(
            {"X": ["Charlie", "Eve"], "Y": ["Dana"]},
            [("Alice", "X"), ("Eve", "Y"), ("Dana", "X")], [], None, EVERYONE)
        assert squads == {"X": ["Charlie", "Alice", "Dana"], "Y": ["Eve"]}

    def test_unnamed_players_stay_put(self):
        squads = _apply_squad_changes({"X": ["Charlie"], "Y": ["Eve"]}, [("Alice", "X")], [], None, EVERYONE)
        assert squads == {"X": ["Charlie", "Alice"], "Y": ["Eve"]}

    def test_out_removes_from_both_and_beats_a_placement(self):
        squads = _apply_squad_changes(
            {"X": ["Charlie"], "Y": ["Eve"]}, [("Eve", "X"), ("Alice", "Y")], ["Eve"], None, EVERYONE)
        assert squads == {"X": ["Charlie"], "Y": ["Alice"]}

    def test_last_placement_for_a_name_wins(self):
        squads = _apply_squad_changes({"X": [], "Y": []}, [("Dana", "X"), ("Dana", "Y")], [], None, EVERYONE)
        assert squads == {"X": [], "Y": ["Dana"]}

    def test_rest_sends_every_unnamed_roster_player(self):
        squads = _apply_squad_changes(
            {"X": ["Charlie", "Dana"], "Y": ["Eve"]}, [("Alice", "X"), ("Bob", "X")], ["Wes"], "Y", EVERYONE)
        assert squads["X"] == ["Alice", "Bob"]
        assert sorted(squads["Y"]) == sorted(set(EVERYONE) - {"Alice", "Bob", "Wes"})

    def test_rest_skips_players_who_are_not_here(self):
        squads = _apply_squad_changes(
            {"X": [], "Y": []}, [("Alice", "X")], [], "Y", roster(absent=("Zoe", "Wes")))
        assert "Zoe" not in squads["Y"] and "Wes" not in squads["Y"]
        assert len(squads["Y"]) == len(EVERYONE) - 3

    def test_rest_leaves_players_the_coach_already_placed(self):
        """Three were tapped onto Orange; "everyone else on Black" in a later
        recording must not take them."""
        squads = _apply_squad_changes(
            {"X": ["Alice", "Bob", "Charlie"], "Y": []}, [], [], "Y",
            roster(pinned=("Alice", "Bob", "Charlie")))
        assert squads["X"] == ["Alice", "Bob", "Charlie"]
        assert len(squads["Y"]) == len(EVERYONE) - 3

    def test_rest_moves_players_auto_dealt_onto_the_other_squad(self):
        squads = _apply_squad_changes(
            {"X": ["Alice", "Zoe"], "Y": ["Bob"]}, [("Alice", "X")], [], "Y", roster())
        assert squads["X"] == ["Alice"] and "Zoe" in squads["Y"]

    def test_a_clear_unpins_everyone(self):
        squads = _apply_squad_changes(
            {"X": [], "Y": []}, [("Alice", "X")], [], "Y", roster(pinned=("Bob",)), cleared=True)
        assert "Bob" in squads["Y"]

    def test_group_all_moves_the_whole_group_even_pinned(self):
        squads = _apply_squad_changes(
            {"X": ["Bob"], "Y": ["Alice"]}, [], [], None, roster(pinned=("Alice",)),
            groups=[("FMP", "X", "all")])
        assert sorted(squads["X"]) == sorted(FMPS + ["Bob"]) and squads["Y"] == []

    def test_group_rest_leaves_pinned_and_named_and_absent(self):
        squads = _apply_squad_changes(
            {"X": ["Alice"], "Y": []}, [("Dana", "X")], [], None,
            roster(pinned=("Alice",), absent=("Zoe",)), groups=[("FMP", "Y", "rest")])
        assert squads["X"] == ["Alice", "Dana"]
        assert sorted(squads["Y"]) == ["Eve", "Iris", "Mia", "Nora", "Tara"]

    def test_groups_then_everyone_else(self):
        """"The women on Orange, everyone else on Black": else excludes the group."""
        squads = _apply_squad_changes(
            {"X": [], "Y": []}, [], [], "Y", roster(), groups=[("FMP", "X", "all")])
        assert sorted(squads["X"]) == sorted(FMPS) and sorted(squads["Y"]) == sorted(MMPS)

    def test_unknown_gender_belongs_to_neither_group(self):
        extra = [SquadsRosterPlayer(name="Morgan Vale", gender="Unknown")]
        squads = _apply_squad_changes(
            {"X": [], "Y": []}, [], [], None, roster(extra=extra),
            groups=[("FMP", "X", "all"), ("MMP", "Y", "all")])
        assert "Morgan Vale" not in squads["X"] + squads["Y"]

    def test_normalized_match_absorbs_embedded_numbers(self):
        squads = _apply_squad_changes({"X": ["Jamal 23"], "Y": []}, [("Jamal", "Y")], [], None, ["Jamal 23"])
        assert squads == {"X": [], "Y": ["Jamal"]}

    def test_casefold_removal(self):
        squads = _apply_squad_changes({"X": ["alice"], "Y": []}, [], ["Alice"], None, EVERYONE)
        assert squads == {"X": [], "Y": []}


# =============================================================================
# Derivation with evidence guards
# =============================================================================

class TestDeriveSquads:
    def test_blank_squads_default_to_first(self):
        req = make_request("Alice, Bob, Dana", current_squads={})
        d = _derive_squads(model_reply(assign=placed(("Alice", ""), ("Bob", ""), ("Dana", ""))), req)
        assert d.squads == {"X": ["Alice", "Bob", "Dana"], "Y": []}
        assert d.assign == [("Alice", "X"), ("Bob", "X"), ("Dana", "X")]
        assert not d.dropped

    def test_named_squads_are_mapped(self):
        d = _derive_squads(model_reply(
            assign=placed(("Alice", "Orange"), ("Bob", "orange"), ("Dana", "Black"))), make_request())
        assert d.squads == {"X": ["Charlie", "Alice", "Bob"], "Y": ["Eve", "Dana"]}

    def test_unknown_squad_word_falls_back_to_first_and_is_logged(self):
        d = _derive_squads(model_reply(assign=placed(("Alice", "Green"))), make_request("Alice on green"))
        assert d.squads["X"] == ["Charlie", "Alice"]
        assert d.assign == [("Alice", "X")]
        assert d.dropped == ["Alice:squad='Green'"]

    def test_out_needs_evidence_in_transcript_naming_the_player(self):
        req = make_request("Alice on Orange. Eve sits out today")
        d = _derive_squads(model_reply(out=[{"name": "Eve", "said": "Eve sits out"}]), req)
        assert d.outs == ["Eve"] and d.squads["Y"] == [] and not d.dropped

        d = _derive_squads(model_reply(out=[{"name": "Charlie", "said": "Charlie sits out"}]), req)
        assert d.outs == [] and d.squads["X"] == ["Charlie"] and d.dropped == ["Charlie"]

        d = _derive_squads(model_reply(out=[{"name": "Charlie", "said": "Alice on Orange"}]), req)
        assert d.outs == [] and d.dropped == ["Charlie"]

    def test_out_by_jersey_number_evidence(self):
        req = make_request("number three is out")
        d = _derive_squads(model_reply(out=[{"name": "Charlie", "said": "number three is out"}]), req)
        assert d.outs == ["Charlie"] and not d.dropped

    def test_clear_needs_collective_evidence(self):
        req = make_request("clear the squads, then Alice on Orange")
        d = _derive_squads(model_reply(clear=True, clear_said="clear the squads",
                                       assign=placed(("Alice", "Orange"))), req)
        assert d.cleared and d.squads == {"X": ["Alice"], "Y": []} and not d.dropped

        req = make_request("Alice on Orange")
        d = _derive_squads(model_reply(clear=True, clear_said="clear the squads",
                                       assign=placed(("Alice", "Orange"))), req)
        assert not d.cleared and d.squads == {"X": ["Charlie", "Alice"], "Y": ["Eve"]}
        assert d.dropped == ["<clear>"]

    def test_rest_needs_a_collective_phrase_from_the_transcript(self):
        req = make_request("Alice and Bob on Orange, everyone else on Black")
        d = _derive_squads(model_reply(assign=placed(("Alice", "Orange"), ("Bob", "Orange")),
                                       rest="Black", rest_said="everyone else on Black"), req)
        assert d.rest == "Y" and not d.dropped
        assert d.squads["X"] == ["Alice", "Bob"]
        assert sorted(d.squads["Y"]) == sorted(set(EVERYONE) - {"Alice", "Bob"})

        req = make_request("Alice and Bob on Orange")
        d = _derive_squads(model_reply(assign=placed(("Alice", "Orange")),
                                       rest="Black", rest_said="everyone else on Black"), req)
        assert d.rest is None and d.dropped == ["<rest>"]
        assert d.squads == {"X": ["Charlie", "Alice"], "Y": ["Eve"]}

    def test_rest_lexicon(self):
        assert _rest_evidence_ok("everyone else on Black", "put everyone else on Black")
        assert _rest_evidence_ok("the rest are Orange", "and the rest are Orange")
        assert _rest_evidence_ok("the others go Black", "the others go Black now")
        assert not _rest_evidence_ok("Alice on Black", "Alice on Black")
        assert not _rest_evidence_ok("", "everyone else on Black")


# =============================================================================
# Gender groups and counts
# =============================================================================

class TestGroups:
    @pytest.mark.parametrize("said,group", [
        ("the FMPs on Orange", "FMP"), ("two more F.M.P.s on orange", "FMP"), ("FMP's on Black", "FMP"),
        ("the rest of the GMPs", "FMP"), ("all the women", "FMP"), ("the girls are Orange", "FMP"),
        ("female-matching players on Black", "FMP"), ("female players", "FMP"), ("the ladies", "FMP"),
        ("the MMPs on Black", "MMP"), ("the guys on Black", "MMP"), ("another guy", "MMP"),
        ("the men", "MMP"), ("male-matching players", "MMP"), ("the boys", "MMP"), ("BMPs", "MMP"),
    ])
    def test_group_words(self, said, group):
        assert _group_in_quote(said) == group
        assert _group_evidence_ok(said, group, f"okay {said} please")
        other = "MMP" if group == "FMP" else "FMP"
        assert not _group_evidence_ok(said, other, f"okay {said} please")

    def test_female_and_women_are_not_male_or_men(self):
        assert _group_in_quote("the women and the female players") == "FMP"
        assert _group_in_quote("the women and the men") is None        # both: ambiguous
        assert _group_in_quote("everyone else") is None

    def test_group_quote_must_be_in_the_transcript(self):
        assert not _group_evidence_ok("the FMPs on Orange", "FMP", "Alice on Orange")

    @pytest.mark.parametrize("said,count,ok", [
        ("two more FMPs", 2, True), ("2 more FMPs", 2, True), ("a couple of girls", 2, True),
        ("another guy", 1, True), ("one more", 1, True), ("twelve more", 12, True),
        ("twenty one more", 21, True), ("two more FMPs", 3, False), ("more FMPs", 2, False),
        ("12 more", 1, False),
    ])
    def test_count_evidence(self, said, count, ok):
        assert _count_evidence_ok(said, count) is ok

    def test_whole_group_and_rest_scope_come_from_the_quote(self):
        req = make_request("All the women on Orange. The rest of the guys on Black.", current_squads={})
        d = _derive_squads(model_reply(groups=[
            {"group": "FMP", "squad": "Orange", "count": None, "said": "All the women on Orange"},
            {"group": "MMP", "squad": "Black", "count": None, "said": "The rest of the guys on Black"},
        ]), req)
        assert d.groups == [("FMP", "X", "all"), ("MMP", "Y", "rest")]
        assert sorted_squads(d) == {"X": sorted(FMPS), "Y": sorted(MMPS)}
        assert d.assign == [] and d.fills == []

    def test_the_quote_outranks_the_models_group_label(self):
        """Both models read "GMPs" as a mishearing of "MMPs"."""
        req = make_request("The rest of the GMPs on Black.", current_squads={})
        d = _derive_squads(model_reply(groups=[
            {"group": "MMP", "squad": "Black", "count": None, "said": "The rest of the GMPs on Black"}]), req)
        assert d.groups == [("FMP", "Y", "rest")] and sorted(d.squads["Y"]) == sorted(FMPS)

    def test_group_without_evidence_is_dropped(self):
        req = make_request("Alice on Orange", current_squads={})
        d = _derive_squads(model_reply(assign=placed(("Alice", "Orange")), groups=[
            {"group": "FMP", "squad": "Black", "count": None, "said": "the rest of the FMPs on Black"}]), req)
        assert d.groups == [] and d.dropped == ["<group>"] and d.squads == {"X": ["Alice"], "Y": []}

    def test_counts_become_fills_and_move_nobody(self):
        req = make_request("Two more FMPs on Orange and another guy on Black. Three more on Black.")
        d = _derive_squads(model_reply(groups=[
            {"group": "FMP", "squad": "Orange", "count": 2, "said": "Two more FMPs on Orange"},
            {"group": "MMP", "squad": "Black", "count": 1, "said": "another guy on Black"},
            {"group": "ANY", "squad": "Black", "count": 3, "said": "Three more on Black"},
        ]), req)
        assert d.fills == [("FMP", "X", 2), ("MMP", "Y", 1), ("ANY", "Y", 3)]
        assert d.squads == {"X": ["Charlie"], "Y": ["Eve"]} and d.groups == []

    def test_count_without_its_number_in_the_quote_is_dropped(self):
        req = make_request("more FMPs on Orange")
        d = _derive_squads(model_reply(groups=[
            {"group": "FMP", "squad": "Orange", "count": 4, "said": "more FMPs on Orange"}]), req)
        assert d.fills == [] and d.dropped == ["<group:count>"]

    def test_ungendered_group_without_a_count_is_not_a_move(self):
        req = make_request("everyone on Orange")
        d = _derive_squads(model_reply(groups=[
            {"group": "ANY", "squad": "Orange", "count": None, "said": "everyone on Orange"}]), req)
        assert d.groups == [] and d.fills == [] and d.dropped == ["<group:any>"]

    def test_group_with_no_squad_takes_the_first(self):
        req = make_request("two more girls", current_squads={})
        d = _derive_squads(model_reply(groups=[
            {"group": "FMP", "squad": "", "count": 2, "said": "two more girls"}]), req)
        assert d.fills == [("FMP", "X", 2)]


class TestVoicedAuto:
    """"auto the rest" is the Auto button by voice: reported as a groups
    entry, honored only on the word itself, dealt by the picker."""

    def auto(self, transcript, said=None, group="ANY", squad="", **kw):
        req = make_request(transcript, **kw)
        return _derive_squads(model_reply(groups=[
            {"group": group, "squad": squad, "count": None, "said": said or transcript}]), req)

    @pytest.mark.parametrize("said", [
        "auto the rest", "and auto-pick the rest", "Auto-select everybody else",
        "auto the squads", "autofill", "just auto it", "auto pick everyone else",
    ])
    def test_auto_phrases_hand_everyone_left_to_auto(self, said):
        d = self.auto(f"Alice on Orange. {said}.", said=said)
        assert d.autos == ["ANY"] and d.groups == [] and d.fills == [] and d.rest is None
        assert d.squads == {"X": ["Charlie"], "Y": ["Eve"]}      # the server moves nobody for it

    @pytest.mark.parametrize("said,group", [
        ("auto-pick the FMPs", "FMP"), ("auto the guys", "MMP"), ("auto the rest of the women", "FMP"),
    ])
    def test_a_gender_group_is_read_from_the_quote(self, said, group):
        d = self.auto(said, group="ANY")
        assert d.autos == [group] and d.groups == []

    def test_a_squad_the_model_carried_over_is_ignored(self):
        """"Dana on Black, auto the rest": the quote names no squad."""
        d = self.auto("Dana on Black, auto the rest", said="auto the rest", squad="Black")
        assert d.autos == ["ANY"] and d.rest is None and d.groups == []

    def test_the_word_must_be_in_the_quote(self):
        d = self.auto("fill in the rest", group="ANY")
        assert d.autos == [] and d.dropped == ["<group:any>"]
        d = self.auto("the rest of the FMPs", group="FMP")
        assert d.autos == [] and d.groups == [("FMP", "X", "rest")]

    def test_the_quote_must_be_in_the_transcript(self):
        d = self.auto("Alice on Orange", said="auto the rest")
        assert d.autos == [] and d.dropped == ["<group>"]

    def test_auto_with_a_count_is_a_count(self):
        req = make_request("Auto-pick two more guys for Black.")
        d = _derive_squads(model_reply(groups=[
            {"group": "MMP", "squad": "Black", "count": 2, "said": "Auto-pick two more guys for Black"}]), req)
        assert d.fills == [("MMP", "Y", 2)] and d.autos == []

    def test_auto_onto_a_named_squad_is_not_a_deal(self):
        """Auto deals across both squads; with a squad in the quote the
        phrase is the plain collective one."""
        d = self.auto("Auto the rest onto Black.", squad="Black", current_squads={"X": ["Alice"]},
                      roster=roster(pinned=("Alice",)))
        assert d.autos == [] and d.rest == "Y"
        assert d.squads["X"] == ["Alice"] and len(d.squads["Y"]) == 15
        d = self.auto("Auto-pick the rest of the women for Orange.", group="FMP", squad="Orange", current_squads={})
        assert d.autos == [] and d.groups == [("FMP", "X", "rest")]

    def test_the_squad_comes_from_the_quote_when_the_model_left_it_blank(self):
        """Both models, told Auto takes no squad, report "auto the rest onto
        Black" with a blank squad — which would mean the FIRST squad."""
        d = self.auto("Auto the rest onto Black.", squad="", current_squads={})
        assert d.autos == [] and d.rest == "Y" and d.squads["X"] == []
        d = self.auto("Auto the rest of the guys onto Black.", squad="", current_squads={})
        assert d.groups == [("MMP", "Y", "rest")]

    def test_naming_both_squads_is_still_a_deal(self):
        d = self.auto("Auto the rest between Orange and Black.")
        assert d.autos == ["ANY"] and d.rest is None

    def test_auto_filed_under_rest_is_a_deal_not_a_squad(self):
        """The dangerous reading: "Dana on Black, auto the rest" reported as
        rest → Black would send the whole team to Black."""
        req = make_request("Dana on Black, auto the rest", current_squads={})
        d = _derive_squads(model_reply(assign=placed(("Dana", "Black")),
                                       rest="Black", rest_said="auto the rest"), req)
        assert d.autos == ["ANY"] and d.rest is None
        assert d.squads == {"X": [], "Y": ["Dana"]}
        # … but with the squad in the quote it is "the rest onto Black".
        req = make_request("Dana on Orange, auto the rest onto Black", current_squads={})
        d = _derive_squads(model_reply(assign=placed(("Dana", "Orange")),
                                       rest="Black", rest_said="auto the rest onto Black"), req)
        assert d.autos == [] and d.rest == "Y" and len(d.squads["Y"]) == 15

    def test_removal_words_veto_but_the_rest_is_not_one(self):
        assert self.auto("auto everybody off").autos == []
        assert self.auto("auto the rest").autos == ["ANY"]

    def test_otto_only_when_nobody_is_called_otto(self):
        req = make_request("Jake on Black. Otto the rest.")
        reply = model_reply(assign=placed(("Jake", "Black")), unmatched=["Otto"], groups=[
            {"group": "ANY", "squad": "", "count": None, "said": "Otto the rest"}])
        d = _derive_squads(reply, req)
        assert d.autos == ["ANY"] and d.unmatched == []
        with_otto = roster(extra=[SquadsRosterPlayer(name="Otto", gender="MMP")])
        d = _derive_squads(reply, make_request("Jake on Black. Otto the rest.", roster=with_otto))
        assert d.autos == []

    def test_each_group_once(self):
        req = make_request("auto the rest. auto the rest.")
        d = _derive_squads(model_reply(rest_said="auto the rest", groups=[
            {"group": "ANY", "squad": "", "count": None, "said": "auto the rest"}]), req)
        assert d.autos == ["ANY"]


# =============================================================================
# Prompt and parsing
# =============================================================================

class TestSquadsPrompt:
    def test_prompt_names_both_squads_and_the_default_rule(self):
        prompt = _build_squads_prompt(make_request())
        assert '"Orange" and "Black"' in prompt
        assert 'The app puts blank placements on "Orange"' in prompt
        assert "leave it blank, never guess" in prompt

    def test_prompt_lists_roster_with_gender_and_current_squads(self):
        prompt = _build_squads_prompt(make_request())
        assert '- Bob "Bobby" [MMP]' in prompt
        assert "- Charlie #3 [MMP]" in prompt
        assert "- Alice [FMP]" in prompt
        x_block = prompt.split('Currently on "Orange"')[1].split('Currently on "Black"')[0]
        assert "- Charlie" in x_block and "- Eve" not in x_block
        y_block = prompt.split('Currently on "Black"')[1].split("Transcript")[0]
        assert "- Eve" in y_block

    def test_prompt_shows_empty_squads(self):
        prompt = _build_squads_prompt(make_request(current_squads={}))
        assert prompt.count("(empty)") == 2

    def test_prompt_states_the_closed_roster_groups_and_cardinal_rule(self):
        prompt = _build_squads_prompt(make_request())
        assert "THE ROSTER IS CLOSED" in prompt
        assert "NEVER expand it into names" in prompt
        assert "THE CARDINAL RULE" in prompt
        assert "You never fill, balance, complete or output a squad yourself" in prompt
        assert '"rest_said"' in prompt and '"clear_said"' in prompt and '"phrases"' in prompt
        assert "it is NOT a mishearing of MMP" in prompt

    def test_prompt_states_the_auto_rule(self):
        prompt = _build_squads_prompt(make_request())
        assert 'The word "auto" must be inside "said"' in prompt
        assert "Auto deals players across BOTH squads" in prompt
        assert "it never stands in for a clear" in prompt


class TestParseSquadsJson:
    def test_parses_fenced_reply_and_normalizes(self):
        text = ('```json\n{"phrases": [{"words": "Alice on Orange", "squad": "Orange"}, "junk"], '
                '"assign": [{"name": "Alice", "squad": "Orange"}, "Bob"], "out": ["Eve"], '
                '"groups": [{"group": "FMP", "squad": "Black", "count": "2", "said": "two girls"}, "junk", '
                '{"group": "MMP", "count": true, "said": "the guys"}]}\n```')
        parsed = _parse_squads_json(text)
        assert parsed["assign"] == [{"name": "Alice", "squad": "Orange"}, {"name": "Bob", "squad": ""}]
        assert parsed["out"] == [{"name": "Eve", "said": ""}]
        assert parsed["phrases"] == [{"words": "Alice on Orange", "squad": "Orange"}]
        assert parsed["groups"] == [
            {"group": "FMP", "squad": "Black", "count": 2, "said": "two girls"},
            {"group": "MMP", "squad": "", "count": None, "said": "the guys"},
        ]
        assert parsed["clear"] is False and parsed["rest"] == ""

    def test_reply_without_the_new_keys_still_parses(self):
        parsed = _parse_squads_json('{"assign": [{"name": "Alice", "squad": ""}]}')
        assert parsed["groups"] == [] and parsed["phrases"] == []

    def test_last_object_wins(self):
        text = ('{"assign": [{"name": "Alice", "squad": "Black"}]} actually no: '
                '{"assign": [{"name": "Alice", "squad": "Orange"}]}')
        assert _parse_squads_json(text)["assign"][0]["squad"] == "Orange"

    def test_missing_assign_errors(self):
        with pytest.raises(RuntimeError):
            _parse_squads_json('{"players": ["Alice"]}')
        with pytest.raises(RuntimeError):
            _parse_squads_json('{"assign": "Alice"}')


# =============================================================================
# Endpoint behavior and authorization
# =============================================================================

@pytest.fixture()
def client(narration_data):
    from main import app
    from auth.jwt_validation import get_current_user

    app.dependency_overrides[get_current_user] = lambda: NARRATION_COACH
    yield TestClient(app)
    app.dependency_overrides.clear()


def request_body(team_id, **overrides):
    body = {
        "teamId": team_id,
        "transcript": "Alice and Bob on Orange, Dana on Black",
        "roster": [p.model_dump() for p in roster()],
        "squad_names": NAMES,
        "current_squads": {"X": ["Charlie"], "Y": ["Eve"]},
    }
    body.update(overrides)
    return body


def fake_model(reply):
    async def call(api_key, prompt):
        return reply
    return call


class TestSquadsEndpoint:
    def test_503_without_api_key(self, client, narration_data, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        resp = client.post("/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 503

    def test_derives_squads_from_placements(self, client, narration_data, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(narration_squads, "_call_claude_squads", fake_model(model_reply(
            assign=placed(("Alice", "Orange"), ("Bob", ""), ("Dana", "Black")),
            unmatched=["Zebediah"], note="Zebediah is not on the roster")))
        resp = client.post("/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 200
        data = resp.json()
        assert data["squads"] == {"X": ["Charlie", "Alice", "Bob"], "Y": ["Eve", "Dana"]}
        assert data["voiced_assign"] == [
            {"name": "Alice", "squad": "X"}, {"name": "Bob", "squad": "X"}, {"name": "Dana", "squad": "Y"}]
        assert data["out"] == [] and data["unmatched"] == ["Zebediah"]
        assert data["fills"] == [] and data["voiced_groups"] == []
        assert data["error"] is None

    def test_groups_and_fills_in_the_response(self, client, narration_data, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(narration_squads, "_call_claude_squads", fake_model(model_reply(groups=[
            {"group": "MMP", "squad": "Black", "count": None, "said": "the rest of the guys on Black"},
            {"group": "FMP", "squad": "Orange", "count": 2, "said": "two more FMPs on Orange"},
        ])))
        resp = client.post("/api/narration/squads", json=request_body(
            narration_data["team_id"],
            transcript="the rest of the guys on Black, and two more FMPs on Orange"))
        data = resp.json()
        assert data["voiced_groups"] == [{"group": "MMP", "squad": "Y", "scope": "rest"}]
        assert data["fills"] == [{"squad": "X", "group": "FMP", "count": 2}]
        assert sorted(data["squads"]["Y"]) == sorted(MMPS + ["Eve"])
        assert data["squads"]["X"] == []

    def test_voiced_auto_in_the_response(self, client, narration_data, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(narration_squads, "_call_claude_squads", fake_model(model_reply(
            assign=placed(("Alice", "Orange")),
            groups=[{"group": "ANY", "squad": "Orange", "count": None, "said": "auto the rest"}])))
        resp = client.post("/api/narration/squads", json=request_body(
            narration_data["team_id"], transcript="Alice on Orange, auto the rest"))
        data = resp.json()
        assert data["voiced_auto"] == ["ANY"] and data["voiced_rest"] is None
        assert "Alice" in data["squads"]["X"]

    def test_a_client_that_sends_no_gender_or_flags_still_works(self, client, narration_data, monkeypatch):
        """The 2.26.0 client sends name / nickname / number only."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(narration_squads, "_call_claude_squads", fake_model(model_reply(
            assign=placed(("Alice", "Orange")), rest="Black", rest_said="everyone else on Black")))
        body = request_body(narration_data["team_id"],
                            transcript="Alice on Orange, everyone else on Black",
                            roster=[{"name": n, "nickname": None, "number": None} for n in EVERYONE])
        data = client.post("/api/narration/squads", json=body).json()
        assert data["squads"]["X"] == ["Alice"] and len(data["squads"]["Y"]) == len(EVERYONE) - 1

    def test_model_failure_echoes_squads_with_error(self, client, narration_data, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def boom(api_key, prompt):
            raise RuntimeError("Anthropic API 500")
        monkeypatch.setattr(narration_squads, "_call_claude_squads", boom)
        resp = client.post("/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 200
        data = resp.json()
        assert data["error"] == "Anthropic API 500"
        assert data["squads"] == {"X": ["Charlie"], "Y": ["Eve"]}

    def test_empty_transcript_is_an_error_payload(self, client, narration_data, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/narration/squads",
                           json=request_body(narration_data["team_id"], transcript="   "))
        assert resp.status_code == 200 and resp.json()["error"] == "Empty transcript"

    def test_missing_squad_name_is_an_error_payload(self, client, narration_data, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/narration/squads",
                           json=request_body(narration_data["team_id"], squad_names={"X": "Orange"}))
        assert resp.status_code == 200 and "squad names" in resp.json()["error"]

    def test_transcript_cap(self, client, narration_data, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/narration/squads",
                           json=request_body(narration_data["team_id"], transcript="x" * 8001))
        assert resp.status_code == 422


class TestSquadsAuthorization:
    """``require_body_team_recorder`` runs for real: the team's coach and
    its stat keeper pass (whoever may start the scrimmage may narrate its
    squads); everyone else is refused before the model is ever called."""

    @pytest.fixture(autouse=True)
    def _key_and_model(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.setattr(narration_squads, "_call_claude_squads", fake_model(model_reply(
            assign=placed(("Alice", "Orange")))))

    def _as(self, user):
        from main import app
        from auth.jwt_validation import get_current_user
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    def test_team_coach_allowed(self, narration_data):
        resp = self._as(NARRATION_COACH).post(
            "/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 200 and resp.json()["squads"]["X"] == ["Charlie", "Alice"]

    def test_stat_keeper_allowed(self, narration_data):
        from storage import membership_storage
        keeper = {"id": "narr-keeper", "email": "narr-keeper@test", "role": "authenticated"}
        membership_storage.create_membership(narration_data["team_id"], keeper["id"], "statkeeper")
        resp = self._as(keeper).post(
            "/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 200 and resp.json()["error"] is None

    def test_malformed_team_id_is_rejected(self, narration_data):
        resp = self._as(NARRATION_COACH).post(
            "/api/narration/squads", json=request_body("../../etc"))
        assert resp.status_code == 400

    def test_viewer_forbidden(self, narration_data):
        resp = self._as(NARRATION_VIEWER).post(
            "/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 403

    def test_other_teams_coach_forbidden(self, narration_data):
        resp = self._as(NARRATION_OTHER_COACH).post(
            "/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 403

    def test_outsider_forbidden(self, narration_data):
        resp = self._as(NARRATION_OUTSIDER).post(
            "/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 403

    def test_missing_team_id_is_400(self, narration_data):
        body = request_body(narration_data["team_id"])
        del body["teamId"]
        resp = self._as(NARRATION_COACH).post("/api/narration/squads", json=body)
        assert resp.status_code == 400


# =============================================================================
# Live eval matrix (opt-in) — the gate for squads prompt / contract changes
# =============================================================================

def _live_req(t, current=None, pinned=(), absent=()):
    return SquadsRequest(teamId="t", transcript=t, roster=roster(absent=absent, pinned=pinned),
                         squad_names=NAMES, current_squads=current or {})


# (id, request, grader over the SquadDerivation). The mangled names here are
# deliberately NOT the ones the prompt uses as examples.
_LIVE_SCENARIOS = [
    ("list_no_squad", _live_req("Alice, Bob, Charlie, and Dana."),
     lambda d: sorted_squads(d) == {"X": ["Alice", "Bob", "Charlie", "Dana"], "Y": []} and not d.unmatched),
    ("misheard_no_squad", _live_req("Alice, Bob, Omer, and Tera."),
     lambda d: sorted_squads(d) == {"X": ["Alice", "Bob", "Omar", "Tara"], "Y": []} and not d.unmatched),
    ("misheard_squads", _live_req("Norah and Hanc on Orange. Wess and Mya on Black."),
     lambda d: sorted_squads(d) == {"X": ["Hank", "Nora"], "Y": ["Mia", "Wes"]} and not d.unmatched),
    ("carry_squad", _live_req("Black is Eve, Hank and Iris. Orange is Jake and Kris."),
     lambda d: sorted_squads(d) == {"X": ["Jake", "Kris"], "Y": ["Eve", "Hank", "Iris"]}),
    ("everyone_else", _live_req("Orange is going to be Alice, Bob, Charlie, and Dana. Everyone else on Black."),
     lambda d: sorted(d.squads["X"]) == ["Alice", "Bob", "Charlie", "Dana"]
     and len(d.squads["Y"]) == 12 and len(d.assign) == 4),
    ("sit_out_misheard", _live_req("Tera sits out today. Alice and Bob on Black.", current={"X": ["Tara"], "Y": []}),
     lambda d: d.outs == ["Tara"] and sorted_squads(d) == {"X": [], "Y": ["Alice", "Bob"]}),
    ("group_rest", _live_req("Alice and Dana on Orange. The rest of the FMPs on Black."),
     lambda d: d.groups == [("FMP", "Y", "rest")] and len(d.assign) == 2
     and sorted_squads(d) == {"X": ["Alice", "Dana"], "Y": ["Eve", "Iris", "Mia", "Nora", "Tara", "Zoe"]}),
    ("group_all_synonyms", _live_req("All the women on Orange and the guys on Black."),
     lambda d: sorted(d.groups) == [("FMP", "X", "all"), ("MMP", "Y", "all")] and not d.assign
     and sorted_squads(d) == {"X": sorted(FMPS), "Y": sorted(MMPS)}),
    ("count_fmp", _live_req("Two more FMPs on Orange."),
     lambda d: d.fills == [("FMP", "X", 2)] and not d.assign and d.squads == {"X": [], "Y": []}),
    ("count_synonyms", _live_req("Add another guy to Black and a couple of girls to Orange."),
     lambda d: sorted(d.fills) == [("FMP", "X", 2), ("MMP", "Y", 1)] and not d.assign),
    ("count_any", _live_req("Three more on Black."),
     lambda d: d.fills == [("ANY", "Y", 3)] and not d.assign),
    ("retraction", _live_req("Dana on Orange. No, wait, Black."),
     lambda d: sorted_squads(d) == {"X": [], "Y": ["Dana"]}),
    ("chatter", _live_req("Okay, um, it's freezing out here. Alright, let's go. Bob and Eve on Orange."),
     lambda d: sorted_squads(d) == {"X": ["Bob", "Eve"], "Y": []}),
    ("clear_then", _live_req("Clear the squads. Alice and Bob on Orange, Eve on Black.",
                             current={"X": ["Zoe", "Wes"], "Y": ["Sam"]}),
     lambda d: d.cleared and sorted_squads(d) == {"X": ["Alice", "Bob"], "Y": ["Eve"]}),
    ("count_stt_initialism", _live_req("Two more F.M.P.s on orange."),
     lambda d: d.fills == [("FMP", "X", 2)] and not d.assign),
    ("gmp_rest", _live_req("The rest of the GMPs on Black.", current={"X": ["Alice"], "Y": []}, pinned=("Alice",)),
     lambda d: d.groups == [("FMP", "Y", "rest")] and d.squads["X"] == ["Alice"] and len(d.squads["Y"]) == 7),
    ("not_on_roster", _live_req("Alice and Zebediah on Orange."),
     lambda d: sorted_squads(d) == {"X": ["Alice"], "Y": []} and len(d.unmatched) == 1),
    ("list_then_rest_by_gender",
     _live_req("Orange: Alice, Bob, Mia. The other women on Black, the other guys on Orange."),
     lambda d: sorted(d.groups) == [("FMP", "Y", "rest"), ("MMP", "X", "rest")] and len(d.assign) == 3),
    # The voiced Auto. Every other scenario is also held to d.autos == [].
    ("auto_rest", _live_req("Alice and Bob on Orange, Dana on Black. Auto the rest."),
     lambda d: d.autos == ["ANY"] and d.rest is None and not d.groups and not d.fills
     and sorted_squads(d) == {"X": ["Alice", "Bob"], "Y": ["Dana"]}),
    ("auto_everybody_else", _live_req("Orange is Alice, Charlie and Mia. Auto-select everybody else."),
     lambda d: d.autos == ["ANY"] and d.rest is None
     and sorted_squads(d) == {"X": ["Alice", "Charlie", "Mia"], "Y": []}),
    ("auto_after_a_carried_squad", _live_req("Black is Eve, Hank and Iris, and auto-pick the rest."),
     lambda d: d.autos == ["ANY"] and d.rest is None
     and sorted_squads(d) == {"X": [], "Y": ["Eve", "Hank", "Iris"]}),
    ("auto_fmps", _live_req("Auto-pick the FMPs."),
     lambda d: d.autos == ["FMP"] and not d.groups and not d.assign and d.squads == {"X": [], "Y": []}),
    ("auto_guys_after_names", _live_req("Alice and Dana on Orange, Eve and Iris on Black. Auto the guys."),
     lambda d: d.autos == ["MMP"] and not d.groups and len(d.assign) == 4
     and sorted_squads(d) == {"X": ["Alice", "Dana"], "Y": ["Eve", "Iris"]}),
    ("auto_only", _live_req("Okay, just auto the squads."),
     lambda d: d.autos == ["ANY"] and not d.assign and d.rest is None and not d.unmatched),
    ("auto_clear_first", _live_req("Start over. Auto everybody.",
                                   current={"X": ["Zoe", "Wes", "Tara"], "Y": ["Sam", "Nora"]}),
     lambda d: d.cleared and d.autos == ["ANY"] and d.squads == {"X": [], "Y": []}),
    ("auto_otto", _live_req("Jake and Kris on Black. Otto the rest."),
     lambda d: d.autos == ["ANY"] and not d.unmatched and d.rest is None
     and sorted_squads(d) == {"X": [], "Y": ["Jake", "Kris"]}),
    ("auto_with_a_count", _live_req("Auto-pick two more guys for Black."),
     lambda d: d.fills == [("MMP", "Y", 2)] and d.autos == [] and not d.assign),
    ("auto_onto_a_named_squad", _live_req("Alice on Orange. Auto the rest onto Black.",
                                          current={"X": ["Alice"], "Y": []}),
     lambda d: d.autos == [] and d.rest == "Y" and d.squads["X"] == ["Alice"] and len(d.squads["Y"]) == 15),
]

_LIVE_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-5-20250929"]


@pytest.mark.live_llm
@pytest.mark.skipif(
    os.getenv("NARRATION_LIVE_TESTS") != "1" or not os.getenv("ANTHROPIC_API_KEY"),
    reason="live LLM eval; set NARRATION_LIVE_TESTS=1 with ANTHROPIC_API_KEY",
)
@pytest.mark.parametrize("model", _LIVE_MODELS)
@pytest.mark.parametrize("sc", _LIVE_SCENARIOS, ids=lambda s: s[0])
def test_live_squads_eval_matrix(sc, model, monkeypatch):
    """The shipping gate for squads prompt/contract changes. Run with:
    NARRATION_LIVE_TESTS=1 pytest test_narration_squads.py -k live -v
    (56 calls, about two minutes, a few cents). One retry absorbs transient
    API timeouts."""
    import asyncio
    from narration_squads import _call_claude_squads

    _, req, grade = sc
    monkeypatch.setenv("NARRATION_LINEUP_MODEL", model)
    prompt = _build_squads_prompt(req)
    last_err = None
    for _ in range(2):
        try:
            res = asyncio.run(_call_claude_squads(os.environ["ANTHROPIC_API_KEY"], prompt))
            break
        except Exception as e:  # noqa: BLE001 — transient API errors get one retry
            last_err = e
    else:
        pytest.fail(f"model call failed twice: {last_err}")

    d = _derive_squads(res, req)
    if not sc[0].startswith("auto_"):
        assert d.autos == [], f"auto heard where none was said: {d.autos}"
    assert grade(d), (
        f"squads={d.squads} assign={d.assign} out={d.outs} groups={d.groups} fills={d.fills} autos={d.autos} clear={d.cleared} "
        f"rest={d.rest} unmatched={d.unmatched} dropped={d.dropped} note={res.get('note')!r}")
