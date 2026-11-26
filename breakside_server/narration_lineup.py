"""
Lineup narration endpoint — speech-to-lineup for the Lines tab.

POST /api/narration/lineup
    Accepts a transcript of the coach speaking, plus context (full roster,
    expected player count, previous lineup, current on-screen selection),
    and asks Claude for the TAP-EQUIVALENT CHANGES only — who goes in, who
    comes off, exactly as if the coach had tapped those names. The endpoint
    then derives the resulting selection itself via set arithmetic
    (_apply_changes), so the model structurally cannot pick, complete, or
    trim a line.

    Requires Coach or Stat Keeper access to the ``game_id`` in the body,
    and caps the transcript and roster: the request is forwarded to
    Anthropic on the operator's key.

This is a SEPARATE layer from the in-point narration pipeline in
narration.py (token minting + play-by-play finalize). Its sibling is
narration_squads.py (the squads of a scrimmage); what the two share —
evidence checks, lexicons, the closed roster, prompt fragments, the model
call — is narration_common.py. The frontend counterpart is
narration/lineupNarration.js.

The task differs from play-by-play extraction in kind, not just prompt:
the answer is a set of players rather than a sequence of events, and the
coach speaks in lineup idioms — "Kris goes in for Wes" (a substitution
against the previous lineup), "same line", "Omar completes the lineup" —
interleaved with asides and self-corrections that must resolve in favor
of the LAST thing said.

As with squads, some things are the server's rather than the model's:
  - the CLOSED ROSTER: a name the recognizer mangled is resolved to the one
    roster name it is closest to when the model did not do so itself;
  - a whole GROUP coming off ("the guys come off"), which the model only
    reports, with a quote, and the server expands over the selection;
  - COUNTS — "two more women", "add a guy" — which nobody on the server
    picks: the verified request goes back as a ``fill`` and the Lines tab
    chooses, by the same rules as its Auto button.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Dual-import pattern, mirroring narration.py / the rest of the backend.
try:
    from auth import get_json_body, require_body_game_recorder  # type: ignore
except ImportError:
    from breakside_server.auth import (  # type: ignore
        get_json_body,
        require_body_game_recorder,
    )

try:
    from narration import parse_body  # type: ignore
except ImportError:
    from breakside_server.narration import parse_body  # type: ignore

try:
    import narration_common as common  # type: ignore
    from narration_common import (  # type: ignore
        ANY_GROUP, RosterPlayer,
        _REMOVAL_RE,
        _anthropic_key, _auto_evidence_ok, _clear_evidence_ok, _evidence_in_transcript,
        _exact_roster_name, _gender_of, _has_removal_words, _is_auto_word, _light_normalize, _lineup_model, _normalize_name, _quote_names_player,
        _resolve_roster_name, _shape_groups, _shape_out_entries, _shape_phrases,
        _verified_group, _worksheet_phrase,
        prompt_roster, prompt_transcript, prompt_worksheet, rule_closed_roster, rule_gender_words,
    )
except ImportError:
    from breakside_server import narration_common as common  # type: ignore
    from breakside_server.narration_common import (  # type: ignore
        ANY_GROUP, RosterPlayer,
        _REMOVAL_RE,
        _anthropic_key, _auto_evidence_ok, _clear_evidence_ok, _evidence_in_transcript,
        _exact_roster_name, _gender_of, _has_removal_words, _is_auto_word, _light_normalize, _lineup_model, _normalize_name, _quote_names_player,
        _resolve_roster_name, _shape_groups, _shape_out_entries, _shape_phrases,
        _verified_group, _worksheet_phrase,
        prompt_roster, prompt_transcript, prompt_worksheet, rule_closed_roster, rule_gender_words,
    )


router = APIRouter(prefix="/api/narration", tags=["narration-lineup"])

# The roster entry both endpoints share (narration_common.RosterPlayer);
# the name is kept because the lineup contract has always called it this.
LineupRosterPlayer = RosterPlayer


# =============================================================================
# Request / response models
# =============================================================================

class LineupRequest(BaseModel):
    # Required: the route authorizes Coach access against THIS game's team
    # (require_body_game_recorder). It used to be optional and unread, which
    # made the endpoint a free Anthropic proxy for any signed-up account.
    game_id: str
    # Capped for the same reason as FinalizeRequest.transcript — it is pasted
    # into a prompt billed to the operator's key. A called line is one or two
    # sentences; 8000 is far past any honest client.
    transcript: str = Field(max_length=8000)
    # FULL active roster — not just on-field players. The whole point of
    # calling a line is naming players coming OFF the bench.
    roster: List[LineupRosterPlayer] = Field(max_length=40)
    expected_count: int = 7
    # Who played the last point (or is on the field right now). Basis for
    # substitution phrasing: "X in for Y", "same line", "X is coming off".
    previous_lineup: List[str] = []
    # What's currently checked on the Lines tab — the selection this
    # narration will replace. Usually equals previous_lineup between
    # points (the ending-line reseed), but diverges once the coach taps.
    current_selection: List[str] = []


class LineupFill(BaseModel):
    """A verified "N more <group>": the Lines tab chooses who."""
    group: str  # "FMP" | "MMP" | "ANY"
    count: int


class LineupResponse(BaseModel):
    # The full resulting selection, derived server-side by set arithmetic
    # (kept for client compatibility — every deployed client applies this).
    players: List[str]
    unmatched: List[str] = []
    note: str = ""
    error: Optional[str] = None
    # Observability: the tap-equivalent changes the model actually voiced.
    # players == (clear ? [] : current_selection − voiced_out) ∪ voiced_in.
    voiced_in: List[str] = []
    voiced_out: List[str] = []
    voiced_clear: bool = False
    # Gender groups voiced off whole ("the guys come off"), already applied
    # to ``players``.
    voiced_group_out: List[str] = []
    # Counts for the Lines tab to fill, in spoken order, after ``players``
    # ("two more women"): the client picks who, by its Auto rules.
    fills: List["LineupFill"] = []
    # The coach handed the rest of the picking to Auto ("auto the rest",
    # "auto-pick the FMPs"): "ANY", or the gender group whose open slots
    # Auto fills. Applied by the client after ``players`` and ``fills``.
    voiced_auto: List[str] = []


# =============================================================================
# Endpoint
# =============================================================================

async def _lineup_request(
    body: Dict[str, Any] = Depends(get_json_body)
) -> LineupRequest:
    """Typed view of the same parsed body the authorization dependency read."""
    return parse_body(LineupRequest, body)


@router.post("/lineup", response_model=LineupResponse)
async def extract_lineup(
    # Authorization first, deliberately: an unauthorized caller should not be
    # able to probe the request schema through validation errors.
    user: dict = Depends(require_body_game_recorder),
    req: LineupRequest = Depends(_lineup_request),
):
    """
    Extract the intended lineup from a coach's spoken narration.

    Unlike /finalize there is no graceful no-LLM fallback — without a
    model there is nothing sensible to return — so a missing key is a 503
    (same contract as /token without OPENAI_API_KEY). A failed model call
    returns 200 with `error` set and an empty `players` list; the client
    must not apply an empty result carrying an error.
    """
    anthropic_key = _anthropic_key()
    if not anthropic_key:
        raise HTTPException(
            status_code=503,
            detail="Lineup narration unavailable: ANTHROPIC_API_KEY not configured",
        )

    if not req.transcript.strip():
        return LineupResponse(players=[], unmatched=[], note="", error="Empty transcript")
    if not req.roster:
        return LineupResponse(players=[], unmatched=[], note="", error="Empty roster")

    prompt = _build_lineup_prompt(req)
    try:
        result = await _call_claude_lineup(anthropic_key, prompt)
    except Exception as e:  # noqa: BLE001 — degrade to an error payload, never a 500
        logger.exception("Lineup extraction LLM call failed")
        return LineupResponse(players=[], unmatched=[], note="", error=str(e))

    d = _derive_players(result, req)
    # Counts only — no names, no transcript: enough to tell, from the log,
    # whether a "that didn't work" was the recognizer, the model or a guard.
    logger.info(
        "Lineup: in=%d out=%d group_out=%d fills=%d auto=%d clear=%s "
        "unmatched=%d resolved_by_closest=%d dropped=%d",
        len(d.ins), len(d.outs), len(d.group_outs), len(d.fills), len(d.autos), d.cleared,
        len(d.unmatched), len(d.resolved), len(d.dropped),
    )
    note = str(result.get("note") or "")
    return LineupResponse(
        players=d.players, unmatched=d.unmatched, note=note,
        voiced_in=d.ins, voiced_out=d.outs, voiced_clear=d.cleared,
        voiced_group_out=d.group_outs,
        fills=[LineupFill(group=g, count=n) for g, n in d.fills],
        voiced_auto=d.autos,
    )


# =============================================================================
# Derivation and tap-equivalent set arithmetic
# =============================================================================

class LineupDerivation:
    """Everything _derive_players works out, named so callers do not unpack
    a tuple that keeps growing."""

    def __init__(self):
        self.players: List[str] = []
        self.ins: List[str] = []           # roster names, spoken order
        self.outs: List[str] = []          # roster names whose removal evidence held
        self.cleared: bool = False
        self.group_outs: List[str] = []    # gender groups voiced off whole
        self.fills: List[tuple] = []       # (group, count)
        self.autos: List[str] = []         # groups handed to Auto ("ANY" = the line)
        self.unmatched: List[str] = []
        self.resolved: List[tuple] = []    # (heard, roster name) — closest-name resolutions
        self.dropped: List[str] = []       # what a guard refused, for the log


def _derive_players(result: Dict[str, Any], req: LineupRequest) -> LineupDerivation:
    """The COMPLETE post-model derivation, in one place so the endpoint and
    the offline eval harness cannot drift: defensive shaping, names resolved
    against the closed roster, the clear/out/group evidence guards (quotes
    must exist in the transcript; outs must also reference the removed
    player; a clear must contain a collective idiom; a group must name its
    gender and a count its number; a hand-off to Auto must say "auto"), then
    tap-equivalent set arithmetic.
    """
    d = LineupDerivation()
    roster = req.roster
    unresolved: List[str] = []

    d.cleared = bool(result.get("clear"))
    if d.cleared and not _clear_evidence_ok(str(result.get("clear_said") or ""), req.transcript):
        d.cleared = False
        d.dropped.append("<clear>")

    for p in result.get("in", []):
        if isinstance(p, bool) or not isinstance(p, (str, int)):
            continue
        heard = str(p)
        name, by_closest = _resolve_roster_name(heard, roster)
        if name is None:
            unresolved.append(heard)
            continue
        if by_closest:
            d.resolved.append((heard, name))
        d.ins.append(name)

    raw_out_names = set()
    for e in result.get("out", []):
        if not isinstance(e, dict) or not e.get("name"):
            continue
        heard = str(e["name"])
        raw_out_names.add(heard)
        said = str(e.get("said") or "").strip()
        name, by_closest = _resolve_roster_name(heard, roster)
        if name is not None:
            raw_out_names.add(name)
        if (name is not None and said and _evidence_in_transcript(said, req.transcript)
                and _quote_names_player(said, name, roster)):
            d.outs.append(name)
            if by_closest:
                d.resolved.append((heard, name))
        else:
            d.dropped.append(name or heard)

    # A name the model gave up on ("unmatched") although exactly one roster
    # player is close to it: the roster is closed, so that is who it is. It
    # is recovered as an IN, and only when the model's own worksheet phrase
    # for it is a plain "in" with no removal words — "Kris in for Dayna" is
    # not guessed at. Never overrides something the model did report.
    for u in result.get("unmatched", []):
        if isinstance(u, bool) or not isinstance(u, (str, int)):
            continue
        heard = str(u)
        name, _ = _resolve_roster_name(heard, roster)
        if name is None or name in d.ins or name in raw_out_names:
            continue
        phrase = _worksheet_phrase(heard, result.get("phrases", []), req.transcript)
        if phrase is None or str(phrase.get("does") or "").strip().lower() != "in":
            continue
        if _REMOVAL_RE.search(_light_normalize(phrase.get("words", ""))):
            continue
        d.ins.append(name)
        d.resolved.append((heard, name))

    # Group phrases. What a phrase DOES is cross-checked against its quote:
    # a count going in must have no removal words, a group coming off must,
    # and a hand-off to Auto must contain the word "auto" (and no removal
    # words). The quote decides; the model's "does" can only veto.
    for g in result.get("groups", []):
        if not isinstance(g, dict):
            continue
        verified, why = _verified_group(g, req.transcript)
        if verified is None:
            d.dropped.append(why or "<group>")
            continue
        group, count = verified
        does = str(g.get("does") or "").strip().lower()
        removal = _has_removal_words(g.get("said", ""))
        auto = _auto_evidence_ok(g.get("said", ""), roster)
        if count is not None and not removal and does != "out":
            # "auto-pick two more women" is a count like any other: Auto
            # picks a count's players anyway.
            d.fills.append((group, count))
        elif count is None and auto and not removal and does != "out":
            if group not in d.autos:
                d.autos.append(group)
        elif (count is None and removal and not auto
              and does not in ("in", "auto") and group != ANY_GROUP):
            if group not in d.group_outs:
                d.group_outs.append(group)
        else:
            # A number coming off, a whole group going in without "auto", an
            # ungendered "everyone", a quote that both removes and hands off:
            # nothing the Lines tab can do from a phrase.
            d.dropped.append("<group:unsupported>")

    base = [] if d.cleared else list(req.current_selection)
    if d.group_outs:
        # Every selected player of the group comes off — except one the
        # coach named in the same breath ("the guys come off, Kris stays in").
        named_in = {n.casefold() for n in d.ins}

        def _stays(selected: str) -> bool:
            roster_name = _exact_roster_name(selected, roster)
            player = next((p for p in roster if p.name == roster_name), None)
            if player is None or _gender_of(player) not in d.group_outs:
                return True
            return player.name.casefold() in named_in

        base = [n for n in base if _stays(n)]
    d.players = _apply_changes(base, d.ins, d.outs)

    # What could not be placed: the model's own unmatched references — minus
    # any that turn out to be a player it did report (a small model lists
    # "Dayna" as unmatched AND puts Dana in) — plus names it reported that
    # resolve to nobody.
    named = set(d.ins) | set(d.outs)
    seen = set()
    for u in list(result.get("unmatched", [])) + unresolved:
        if isinstance(u, bool) or not isinstance(u, (str, int)):
            continue
        u = str(u)
        resolved, _ = _resolve_roster_name(u, roster)
        if resolved is not None and resolved in named:
            continue
        if u.casefold() in seen:
            continue
        # "Otto" / "auto" listed as a name nobody matched, when the phrase
        # it came from was honored as a hand-off to Auto.
        if d.autos and _is_auto_word(u):
            continue
        seen.add(u.casefold())
        d.unmatched.append(u)
    return d


def _apply_changes(selection: List[str], ins: List[str], outs: List[str]) -> List[str]:
    """players = (selection − outs) ∪ ins.

    Removal tiers per out-name: exact → casefold → UNIQUE normalized match
    (ambiguity keeps both, same refusal rule as the frontend matcher).
    Ins are appended in spoken order, skipping names already present
    (exact/casefold/unique-normalized duplicate detection).
    """
    # An out beats a matching in: the model is told never to list a player
    # in both, but when it happens anyway (player named early, removed
    # later; or a whole-line expansion overlapping an out) the removal is
    # the later, controlling statement.
    def _matches(a: str, b: str) -> bool:
        if a == b or a.casefold() == b.casefold():
            return True
        na, nb = _normalize_name(a), _normalize_name(b)
        return bool(na) and na == nb

    ins = [i for i in ins if not any(_matches(i, o) for o in outs)]

    kept = list(selection)
    for out_name in outs:
        exact = [k for k in kept if k == out_name]
        if not exact:
            exact = [k for k in kept if k.casefold() == out_name.casefold()]
        if not exact:
            norm = _normalize_name(out_name)
            if norm:
                hits = [k for k in kept if _normalize_name(k) == norm]
                if len(hits) == 1:
                    exact = hits
        if exact:
            kept = [k for k in kept if k != exact[0]]

    players = list(kept)
    for in_name in ins:
        dup = any(
            k == in_name or k.casefold() == in_name.casefold() for k in players
        )
        if not dup:
            norm = _normalize_name(in_name)
            if norm:
                hits = [k for k in players if _normalize_name(k) == norm]
                dup = len(hits) == 1
        if not dup:
            players.append(in_name)
    return players


# =============================================================================
# Prompt
# =============================================================================

def _build_lineup_prompt(req: LineupRequest) -> str:
    prev_block = (
        "\n".join(f"- {n}" for n in req.previous_lineup)
        if req.previous_lineup
        else "(none — no points played yet)"
    )
    # No base fallback of any kind: an empty selection stays empty (the
    # coach cleared it — Wholesale means Wholesale). The model only ever
    # sees the selection as context; it outputs changes, never a lineup.
    curr_block = (
        "\n".join(f"- {n}" for n in req.current_selection)
        if req.current_selection
        else "(empty — the coach cleared the selection or is starting fresh)"
    )

    worksheet = prompt_worksheet(
        '"Kris in for Wes" / "and Priya" / "that was a long point"',
        'what THAT phrase does: "in" (puts players in), "out" (takes players off), "swap" (X in for Y), '
        '"clear", "auto" (hands the picking to the app), or "aside" (chatter, or words the coach then took back)',
    )

    return f"""You are the voice-input layer for an ultimate frisbee lineup screen. The coach speaks; you extract WHICH PLAYERS GO IN and WHICH COME OFF — the verbal equivalent of tapping their names on the roster list. You never pick, complete, trim, or output a lineup: the app applies your in/out changes to the on-screen selection, and line-filling is the coach's job (or the app's Auto button), never yours. When the coach asks for a NUMBER of players without naming them ("two more women"), or hands the picking to the app by saying "auto" ("auto the rest"), you report the request and the app picks.

{prompt_roster(req.roster)}

Previous lineup (who played the last point). Used ONLY to expand explicit whole-line phrases like "same line" / "run it back" — never as something to fill from:
{prev_block}

Currently selected on screen (context only — the app applies your changes to this list; re-adding an already-selected player is harmless):
{curr_block}

Expected lineup size: {req.expected_count} players. Context for your "note" only — NEVER add players to approach it.

{prompt_transcript(req.transcript)}

Reply with ONLY a JSON object of this exact shape (no prose, no markdown fences):
{{"phrases": [{{"words": "a phrase of the transcript", "does": "in" | "out" | "swap" | "clear" | "auto" | "aside"}}, ...], "clear": false, "clear_said": "", "in": ["Name", ...], "out": [{{"name": "Name", "said": "the coach's exact removal words"}}, ...], "groups": [{{"group": "FMP" | "MMP" | "ANY", "does": "in" | "out" | "auto", "count": null, "said": "the coach's exact words"}}, ...], "unmatched": ["spoken reference", ...], "note": ""}}

{worksheet}

Every "out" entry MUST quote, in "said", the coach's actual words that took that player off ("Wes's coming off", "Priya in for Alice" quoting the replacement). If you cannot quote removal words for a player, that player does NOT go in "out". RETRACTED words are VOID as evidence: when the coach cancels a change ("Priya in for Alice — actually no, Priya's in for Wes, Alice stays"), the cancelled phrase no longer counts as removal words — Alice has no valid evidence and does NOT go in "out". "in" entries are plain names — additions need no evidence.

How to interpret the transcript:
1. Bare names go IN: "Kris", "umm, Priya... and Dana", "Jake, Kris, and Charlie go in" — exactly those players in "in", nothing in "out".
2. "X goes in for Y", "X replaces Y", "X for Y" — X in, Y out. "X is coming off", "X off", "X sits", "X takes a break" — X out. "add X", "X is on", "X's in" — X in.
3. "same line", "run it back", "same as last point" — every player of the Previous lineup goes in "in". "Kris in for Wes, everyone else run it back" — "in": Kris plus the rest of the Previous lineup, "out": Wes.
   CLEAR-EVERYONE: "wholesale" / "let's get a wholesale" (Wholesale is this app's clear-the-selection button — coaches use it as a verb), "everybody comes off", "everyone off", "all players come off", "clear the line", "start fresh" — set "clear": true and quote the coach's exact words in "clear_said". A clear un-taps the whole current selection at once; players named AFTER the clear go in "in" ("Let's get a wholesale, then put in Kris and Charlie" → clear: true, in: Kris, Charlie). A clear also cancels any "in" spoken BEFORE it. Do not also list the cleared players in "out".
4. Later statements override earlier ones. "...and is that Hank? No, I think it's Morgan" is an identity correction: Morgan in, Hank nowhere (not in "out" — the coach never removed him, they corrected themselves). A retracted change never happened: "Priya in for Alice — actually no, Priya's in for Wes, Alice stays" gives "in": Priya and "out": Wes only; Alice appears nowhere.
5. Ignore asides: commentary about the last point, scores, fatigue, weather, sideline chatter. Wrap-up phrases ("Omar completes the lineup", "that's the seven", "that's the line") mean the named player goes in and the coach finished talking — they NEVER make you add anyone else, and they are NOT an "auto" request (rule 7).
   A framing like "the line is X, Y, Z" only puts the named players in "in" — it puts NOBODY in "out". Already-selected players the coach didn't mention simply stay selected; when a coach wants a fresh line they clear the list first.
   A player never appears in both "in" and "out": resolve to the coach's LAST statement about that player ("Kris, Sam... and Kris is coming off" puts Kris ONLY in "out").
{rule_closed_roster(6, '"in" / "out"')}
7. GROUPS — the coach changes the line by gender group or by number instead of by name, or hands the picking to the app. Report each such phrase as one "groups" entry, quoting the coach's exact words in "said"; NEVER turn it into names in "in" or "out" — the app knows who is in each group and does the choosing.
{rule_gender_words()}
   - A number going IN: "two more women", "add a guy", "another FMP", "and a couple of guys", "three more" → {{"group": "FMP" | "MMP" | "ANY", "does": "in", "count": 2, "said": "…"}}, with the number word inside "said". The app picks which players, the way its Auto button would.
   - A whole group coming OFF: "the guys come off", "all the women off", "MMPs sit this one" → {{"group": "MMP", "does": "out", "count": null, "said": "…"}}. Every selected player of that group comes off; players the coach names stay governed by "in"/"out".
   - AUTO — the coach hands the remaining picks to the app's Auto button, and says the word "auto" to do it: "auto the rest", "and auto-pick the rest", "auto-select everybody else", "auto the line", "autofill" → {{"group": "ANY", "does": "auto", "count": null, "said": "…"}}. For ONE gender group only — "auto-pick the FMPs", "auto the guys", "auto the rest of the women" → the same entry with "group": "FMP" | "MMP". The word "auto" must be inside "said". The app fills the open slots (of that group, when one is named) the way its Auto button does; you never pick anyone. Players the coach names in the same breath still go in "in" / "out" as usual. The recognizer sometimes writes "auto" as "Otto": when nobody on the roster is called Otto, "Otto the rest" is this phrase — quote it as written, and Otto is not a name for "in" or "unmatched".
   - Anything else by group — a number coming off ("two guys off"), a whole group going in without the word "auto" ("all the women go in") — is not something the app can do from a phrase: report nothing for it and say so in "note".
8. THE CARDINAL RULE: "in" and "out" contain ONLY players the coach referred to — by name, nickname or number, or through an explicit whole-line phrase from rule 3. Never anyone else, no matter how short the resulting lineup would be: if the coach named 3 players, "in" has exactly 3 entries. And "out" contains ONLY players removed with explicit off/sits/coming-off/replaced-by language — NEVER a player who is merely absent from a list the coach recited. Reciting names ("the line is A, B, C") is tapping those names IN; it un-taps nobody. If something was notable (a retraction, an ambiguous reference, far fewer players than the expected size), say it in one short sentence in "note".
"""


# =============================================================================
# Model call and reply parsing
# =============================================================================

async def _call_claude_lineup(api_key: str, prompt: str) -> Dict[str, Any]:
    """The model call for /lineup (its own name so tests can mock it).

    Raises on transport/API/parse failure — the endpoint converts that to
    an error payload.
    """
    return _parse_lineup_reply(await common._call_claude_json(api_key, prompt, "in"))


def _parse_lineup_json(text: str) -> Dict[str, Any]:
    """Parse the model's reply, tolerating fences, prose, and self-corrections.

    Tap-equivalent shape: {"in": [...], "out": [...], ...}. "in" is the
    anchor key; a reply without it (including the retired full-lineup
    "players" shape) is a contract violation and errors out — the client
    then leaves the selection untouched.
    """
    return _parse_lineup_reply(common._last_json_object(text, "in"))


def _parse_lineup_reply(parsed: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(parsed.get("in"), list):
        raise RuntimeError("Claude lineup response missing 'in' list")
    if "out" in parsed and not isinstance(parsed.get("out"), list):
        raise RuntimeError("Claude lineup response 'out' is not a list")
    parsed["clear"] = bool(parsed.get("clear"))
    parsed["clear_said"] = str(parsed.get("clear_said") or "")
    # Out entries as {name, said}; bare strings mean the model skipped the
    # evidence field (treated as no evidence).
    parsed["out"] = _shape_out_entries(parsed.get("out"))
    parsed["groups"] = _shape_groups(parsed.get("groups"), "does")
    parsed["phrases"] = _shape_phrases(parsed.get("phrases"), "does")
    return parsed
