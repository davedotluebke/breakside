"""
Tests for the squads narration endpoint (narration_lineup.py, POST
/api/narration/squads) — the scrimmage dialog's voice input.

Contract under test (tap-equivalent, as /lineup): the model returns only
the voiced placements {"assign": [{name, squad}], "out": [...]} and the
ENDPOINT derives the resulting squads. The rule that matters most to a
coach who reads out a list without naming a squad — everyone goes on the
FIRST squad — is applied here, by the server, to a blank squad field.

Pure tests cover the derivation, the squad-word mapping, the evidence
guards and the prompt; endpoint tests run TestClient with the Claude call
mocked and only ``get_current_user`` overridden, so ``require_body_team_recorder``
runs for real against the ``narration_data`` fixture's memberships.

Run with: cd breakside_server && python -m pytest test_narration_squads.py -v
"""
import pytest
from fastapi.testclient import TestClient

import narration_lineup
from narration_lineup import (
    LineupRosterPlayer,
    SquadsRequest,
    _apply_squad_changes,
    _build_squads_prompt,
    _derive_squads,
    _parse_squads_json,
    _rest_evidence_ok,
    _squad_key,
)

from conftest import (
    NARRATION_COACH,
    NARRATION_OTHER_COACH,
    NARRATION_OUTSIDER,
    NARRATION_VIEWER,
)

NAMES = {"X": "Orange", "Y": "Black"}
ROSTER = [
    LineupRosterPlayer(name="Alice", number="7"),
    LineupRosterPlayer(name="Bob", nickname="Bobby", number="11"),
    LineupRosterPlayer(name="Charlie", number="3"),
    LineupRosterPlayer(name="Dana", number="22"),
    LineupRosterPlayer(name="Eve", number="9"),
    LineupRosterPlayer(name="Jamal 23", number="23"),
]


def make_request(**overrides):
    base = dict(
        teamId="team-1",
        transcript="Alice and Bob on Orange, Dana on Black",
        roster=ROSTER,
        squad_names=NAMES,
        current_squads={"X": ["Charlie"], "Y": ["Eve"]},
    )
    base.update(overrides)
    return SquadsRequest(**base)


def model_reply(assign=None, out=None, clear=False, clear_said="", rest="", rest_said="",
                unmatched=None, note=""):
    return {
        "clear": clear, "clear_said": clear_said,
        "assign": assign or [], "rest": rest, "rest_said": rest_said,
        "out": out or [], "unmatched": unmatched or [], "note": note,
    }


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
# Set arithmetic
# =============================================================================

class TestApplySquadChanges:
    def test_placements_move_players_between_squads(self):
        squads = _apply_squad_changes(
            {"X": ["Charlie", "Eve"], "Y": ["Dana"]},
            [("Alice", "X"), ("Eve", "Y"), ("Dana", "X")],
            [], None, [p.name for p in ROSTER],
        )
        assert squads == {"X": ["Charlie", "Alice", "Dana"], "Y": ["Eve"]}

    def test_unnamed_players_stay_put(self):
        squads = _apply_squad_changes(
            {"X": ["Charlie"], "Y": ["Eve"]}, [("Alice", "X")], [], None, [p.name for p in ROSTER])
        assert squads == {"X": ["Charlie", "Alice"], "Y": ["Eve"]}

    def test_out_removes_from_both_and_beats_a_placement(self):
        squads = _apply_squad_changes(
            {"X": ["Charlie"], "Y": ["Eve"]},
            [("Eve", "X"), ("Alice", "Y")], ["Eve"], None, [p.name for p in ROSTER])
        assert squads == {"X": ["Charlie"], "Y": ["Alice"]}

    def test_last_placement_for_a_name_wins(self):
        squads = _apply_squad_changes(
            {"X": [], "Y": []}, [("Dana", "X"), ("Dana", "Y")], [], None, [p.name for p in ROSTER])
        assert squads == {"X": [], "Y": ["Dana"]}

    def test_rest_sends_every_unnamed_roster_player(self):
        squads = _apply_squad_changes(
            {"X": ["Charlie", "Dana"], "Y": ["Eve"]},
            [("Alice", "X"), ("Bob", "X")], ["Jamal 23"], "Y", [p.name for p in ROSTER])
        assert squads["X"] == ["Alice", "Bob"]
        assert sorted(squads["Y"]) == ["Charlie", "Dana", "Eve"]

    def test_normalized_match_absorbs_embedded_numbers(self):
        squads = _apply_squad_changes(
            {"X": ["Jamal 23"], "Y": []}, [("Jamal", "Y")], [], None, [p.name for p in ROSTER])
        assert squads == {"X": [], "Y": ["Jamal"]}

    def test_casefold_removal(self):
        squads = _apply_squad_changes(
            {"X": ["alice"], "Y": []}, [], ["Alice"], None, [p.name for p in ROSTER])
        assert squads == {"X": [], "Y": []}


# =============================================================================
# Derivation with evidence guards
# =============================================================================

class TestDeriveSquads:
    def test_blank_squads_default_to_first(self):
        req = make_request(transcript="Alice, Bob, Dana", current_squads={})
        reply = model_reply(assign=[{"name": "Alice", "squad": ""}, {"name": "Bob", "squad": ""},
                                    {"name": "Dana", "squad": ""}])
        squads, assign, outs, cleared, rest, dropped = _derive_squads(reply, req)
        assert squads == {"X": ["Alice", "Bob", "Dana"], "Y": []}
        assert assign == [("Alice", "X"), ("Bob", "X"), ("Dana", "X")]
        assert not dropped

    def test_named_squads_are_mapped(self):
        req = make_request()
        reply = model_reply(assign=[{"name": "Alice", "squad": "Orange"}, {"name": "Bob", "squad": "orange"},
                                    {"name": "Dana", "squad": "Black"}])
        squads, *_ = _derive_squads(reply, req)
        assert squads == {"X": ["Charlie", "Alice", "Bob"], "Y": ["Eve", "Dana"]}

    def test_unknown_squad_word_falls_back_to_first_and_is_logged(self):
        req = make_request(transcript="Alice on green")
        reply = model_reply(assign=[{"name": "Alice", "squad": "Green"}])
        squads, assign, _, _, _, dropped = _derive_squads(reply, req)
        assert squads["X"] == ["Charlie", "Alice"]
        assert assign == [("Alice", "X")]
        assert dropped == ["Alice:squad='Green'"]

    def test_out_needs_evidence_in_transcript_naming_the_player(self):
        req = make_request(transcript="Alice on Orange. Eve sits out today")
        honest = model_reply(out=[{"name": "Eve", "said": "Eve sits out"}])
        squads, _, outs, _, _, dropped = _derive_squads(honest, req)
        assert outs == ["Eve"] and squads["Y"] == [] and not dropped

        fabricated = model_reply(out=[{"name": "Charlie", "said": "Charlie sits out"}])
        squads, _, outs, _, _, dropped = _derive_squads(fabricated, req)
        assert outs == [] and squads["X"] == ["Charlie"] and dropped == ["Charlie"]

        unrelated = model_reply(out=[{"name": "Charlie", "said": "Alice on Orange"}])
        _, _, outs, _, _, dropped = _derive_squads(unrelated, req)
        assert outs == [] and dropped == ["Charlie"]

    def test_out_by_jersey_number_evidence(self):
        req = make_request(transcript="number three is out")
        reply = model_reply(out=[{"name": "Charlie", "said": "number three is out"}])
        _, _, outs, _, _, dropped = _derive_squads(reply, req)
        assert outs == ["Charlie"] and not dropped

    def test_clear_needs_collective_evidence(self):
        req = make_request(transcript="clear the squads, then Alice on Orange")
        reply = model_reply(clear=True, clear_said="clear the squads",
                            assign=[{"name": "Alice", "squad": "Orange"}])
        squads, _, _, cleared, _, dropped = _derive_squads(reply, req)
        assert cleared and squads == {"X": ["Alice"], "Y": []} and not dropped

        req = make_request(transcript="Alice on Orange")
        reply = model_reply(clear=True, clear_said="clear the squads",
                            assign=[{"name": "Alice", "squad": "Orange"}])
        squads, _, _, cleared, _, dropped = _derive_squads(reply, req)
        assert not cleared and squads == {"X": ["Charlie", "Alice"], "Y": ["Eve"]}
        assert dropped == ["<clear>"]

    def test_rest_needs_a_collective_phrase_from_the_transcript(self):
        req = make_request(transcript="Alice and Bob on Orange, everyone else on Black")
        reply = model_reply(assign=[{"name": "Alice", "squad": "Orange"}, {"name": "Bob", "squad": "Orange"}],
                            rest="Black", rest_said="everyone else on Black")
        squads, _, _, _, rest, dropped = _derive_squads(reply, req)
        assert rest == "Y" and not dropped
        assert squads["X"] == ["Alice", "Bob"]
        assert sorted(squads["Y"]) == ["Charlie", "Dana", "Eve", "Jamal 23"]

        req = make_request(transcript="Alice and Bob on Orange")
        reply = model_reply(assign=[{"name": "Alice", "squad": "Orange"}],
                            rest="Black", rest_said="everyone else on Black")
        squads, _, _, _, rest, dropped = _derive_squads(reply, req)
        assert rest is None and dropped == ["<rest>"]
        assert squads == {"X": ["Charlie", "Alice"], "Y": ["Eve"]}

    def test_rest_lexicon(self):
        assert _rest_evidence_ok("everyone else on Black", "put everyone else on Black")
        assert _rest_evidence_ok("the rest are Orange", "and the rest are Orange")
        assert _rest_evidence_ok("the others go Black", "the others go Black now")
        assert not _rest_evidence_ok("Alice on Black", "Alice on Black")
        assert not _rest_evidence_ok("", "everyone else on Black")


# =============================================================================
# Prompt and parsing
# =============================================================================

class TestSquadsPrompt:
    def test_prompt_names_both_squads_and_the_default_rule(self):
        prompt = _build_squads_prompt(make_request())
        assert '"Orange" and "Black"' in prompt
        assert 'The app puts blank placements on "Orange"' in prompt
        assert "leave it blank, never guess" in prompt

    def test_prompt_lists_roster_and_current_squads(self):
        prompt = _build_squads_prompt(make_request())
        assert '- Bob "Bobby" #11' in prompt
        assert "- Jamal 23 #23" in prompt
        x_block = prompt.split('Currently on "Orange"')[1].split('Currently on "Black"')[0]
        assert "- Charlie" in x_block and "- Eve" not in x_block
        y_block = prompt.split('Currently on "Black"')[1].split("Transcript")[0]
        assert "- Eve" in y_block

    def test_prompt_shows_empty_squads(self):
        prompt = _build_squads_prompt(make_request(current_squads={}))
        assert prompt.count("(empty)") == 2

    def test_prompt_states_the_cardinal_rule_and_evidence(self):
        prompt = _build_squads_prompt(make_request())
        assert "THE CARDINAL RULE" in prompt
        assert "You never fill, balance, complete or output a squad" in prompt
        assert '"rest_said"' in prompt and '"clear_said"' in prompt


class TestParseSquadsJson:
    def test_parses_fenced_reply_and_normalizes(self):
        text = '```json\n{"assign": [{"name": "Alice", "squad": "Orange"}, "Bob"], "out": ["Eve"]}\n```'
        parsed = _parse_squads_json(text)
        assert parsed["assign"] == [{"name": "Alice", "squad": "Orange"}, {"name": "Bob", "squad": ""}]
        assert parsed["out"] == [{"name": "Eve", "said": ""}]
        assert parsed["clear"] is False and parsed["rest"] == ""

    def test_last_object_wins(self):
        text = '{"assign": [{"name": "Alice", "squad": "Black"}]} actually no: {"assign": [{"name": "Alice", "squad": "Orange"}]}'
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
        "roster": [{"name": p.name, "nickname": p.nickname, "number": p.number} for p in ROSTER],
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
        monkeypatch.setattr(narration_lineup, "_call_claude_squads", fake_model(model_reply(
            assign=[{"name": "Alice", "squad": "Orange"}, {"name": "Bob", "squad": ""},
                    {"name": "Dana", "squad": "Black"}],
            unmatched=["Zeb"], note="Zeb is not on the roster")))
        resp = client.post("/api/narration/squads", json=request_body(narration_data["team_id"]))
        assert resp.status_code == 200
        data = resp.json()
        assert data["squads"] == {"X": ["Charlie", "Alice", "Bob"], "Y": ["Eve", "Dana"]}
        assert data["voiced_assign"] == [
            {"name": "Alice", "squad": "X"}, {"name": "Bob", "squad": "X"}, {"name": "Dana", "squad": "Y"}]
        assert data["out"] == [] and data["unmatched"] == ["Zeb"]
        assert data["error"] is None

    def test_model_failure_echoes_squads_with_error(self, client, narration_data, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

        async def boom(api_key, prompt):
            raise RuntimeError("Anthropic API 500")
        monkeypatch.setattr(narration_lineup, "_call_claude_squads", boom)
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
        monkeypatch.setattr(narration_lineup, "_call_claude_squads", fake_model(model_reply(
            assign=[{"name": "Alice", "squad": "Orange"}])))

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
