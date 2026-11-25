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

    Requires Coach access to the ``game_id`` in the body, and caps the
    transcript and roster: the request is forwarded to Anthropic on the
    operator's key.

POST /api/narration/squads
    The same idea for a scrimmage's two squads (teams/scrimmageDialogs.js):
    the coach names players and which squad they go on — "Alice and Bob on
    Orange, Dana on Black", "Eve sits out", "everyone else on Black", "the
    rest of the FMPs on Orange", "two more guys on Black" — and the model
    only reports it. The endpoint maps squad words to the two squad keys,
    puts every UNSTATED placement on the FIRST squad (the one rule a coach
    who just rattles off names relies on), resolves names the recognizer
    mangled against the closed roster, verifies the evidence for sit-outs,
    a clear and the collective phrases and expands those itself
    (_apply_squad_changes), and hands a verified count back for the picker
    to choose. Requires Coach or Stat Keeper access to the ``teamId`` in
    the body (whoever may start the scrimmage may narrate its squads) —
    there is no game yet when a scrimmage is being set up.

This is a SEPARATE layer from the in-point narration pipeline in
narration.py (token minting + play-by-play finalize). It deliberately
lives in its own module with its own router so lineup work and in-point
narration work don't step on each other. The frontend counterpart is
narration/lineupNarration.js.

The task differs from play-by-play extraction in kind, not just prompt:
the answer is a set of players rather than a sequence of events, and the
coach speaks in lineup idioms — "Kris goes in for Wes" (a substitution
against the previous lineup), "same line", "Omar completes the lineup" —
interleaved with asides and self-corrections that must resolve in favor
of the LAST thing said.
"""
from __future__ import annotations

import difflib
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Dual-import pattern, mirroring narration.py / the rest of the backend.
try:
    from auth import get_json_body, require_body_game_recorder, require_body_team_recorder  # type: ignore
except ImportError:
    from breakside_server.auth import (  # type: ignore
        get_json_body,
        require_body_game_recorder,
        require_body_team_recorder,
    )

try:
    from narration import _last_json_object, parse_body  # type: ignore
except ImportError:
    from breakside_server.narration import (  # type: ignore
        _last_json_object,
        parse_body,
    )


router = APIRouter(prefix="/api/narration", tags=["narration-lineup"])


def _anthropic_key() -> Optional[str]:
    return os.getenv("ANTHROPIC_API_KEY", "") or None


def _lineup_model() -> str:
    """Model for lineup extraction.

    NARRATION_LINEUP_MODEL wins; otherwise follow NARRATION_SLOW_MODEL so
    one env knob moves both narration passes; otherwise the same default
    as the finalize pass.
    """
    return (
        os.getenv("NARRATION_LINEUP_MODEL")
        or os.getenv("NARRATION_SLOW_MODEL")
        or "claude-sonnet-4-5-20250929"
    )


# =============================================================================
# Request / response models
# =============================================================================

class LineupRosterPlayer(BaseModel):
    name: str
    nickname: Optional[str] = None
    number: Optional[str] = None


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

    players, ins, outs, cleared, dropped = _derive_players(result, req)
    if dropped:
        logger.info("Lineup outs/clear dropped (missing/unrelated evidence): %s", dropped)
    unmatched = [str(u) for u in result.get("unmatched", []) if isinstance(u, (str, int))]
    note = str(result.get("note") or "")
    return LineupResponse(players=players, unmatched=unmatched, note=note,
                          voiced_in=ins, voiced_out=outs, voiced_clear=cleared)


# Collective clear-everyone idioms, matched against the LIGHT-normalized
# quote ("Wholesale" is the app's clear button — coaches verb it; STT may
# split it "whole sale").
_CLEAR_LEXICON_RE = re.compile(
    r"whole ?sale"
    r"|every(one|body)('?s)?\s+(comes?\s+|goes?\s+)?(off|out)"
    r"|all\s+(the\s+)?players?\s+(come\s+|go\s+)?(off|out)"
    r"|clear\s+(the\s+|both\s+)?(line|list|selection|squads?|teams?)"
    r"|clear\s+every(one|body)"
    r"|(take|start)\s+every(one|body)\s+(off|over)"
    r"|start\s+(over|fresh)"
)


def _clear_evidence_ok(said: str, transcript: str) -> bool:
    """A voiced clear-everyone is honored only when its quote occurs in the
    transcript AND actually contains a collective-clear idiom — the same
    trust-but-verify stance as per-player outs, adapted for a phrase that
    by design names nobody."""
    if not said or not _evidence_in_transcript(said, transcript):
        return False
    return bool(_CLEAR_LEXICON_RE.search(_light_normalize(said)))


def _derive_players(result: Dict[str, Any], req: LineupRequest):
    """The COMPLETE post-model derivation, in one place so the endpoint and
    the offline eval harness cannot drift: defensive shaping, the clear/out
    evidence guards (quotes must exist in the transcript; outs must also
    reference the removed player; a clear must contain a collective idiom),
    then tap-equivalent set arithmetic.

    Returns (players, ins, honored_outs, cleared, dropped).
    """
    ins = [str(p) for p in result.get("in", []) if isinstance(p, (str, int))]
    dropped = []

    cleared = bool(result.get("clear"))
    if cleared and not _clear_evidence_ok(str(result.get("clear_said") or ""), req.transcript):
        cleared = False
        dropped.append("<clear>")

    outs = []
    for e in result.get("out", []):
        if not isinstance(e, dict) or not e.get("name"):
            continue
        said = str(e.get("said") or "").strip()
        if (said and _evidence_in_transcript(said, req.transcript)
                and _evidence_references_player(said, e["name"], req.roster)):
            outs.append(e["name"])
        else:
            dropped.append(e["name"])

    base = [] if cleared else req.current_selection
    players = _apply_changes(base, ins, outs)
    return players, ins, outs, cleared, dropped


# =============================================================================
# Tap-equivalent set arithmetic
# =============================================================================

_QUOTED_SPAN_RE = re.compile(r"[\"\u2018\u2019\u201c\u201d'][^\"\u2018\u2019\u201c\u201d']*[\"\u2018\u2019\u201c\u201d']")
_DECOR_RE = re.compile(r"[0-9#()\[\].,_'\"-]+")


def _normalize_name(s: str) -> str:
    """Digits/decoration-tolerant form, mirroring lineupResolve.js
    normalizeName — rosters sometimes embed jersey numbers in the name
    string ("Jamal 23") while the model returns the cleaned name."""
    s = _QUOTED_SPAN_RE.sub(" ", str(s or "").lower())
    s = _DECOR_RE.sub(" ", s)
    return " ".join(s.split())


_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
          "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
          "seventeen", "eighteen", "nineteen"]


def _number_words(n: int) -> str:
    """0-99 as spoken words ('23' -> 'twenty three'), for matching jersey
    numbers inside quoted evidence."""
    if 0 <= n < 20:
        return _UNITS[n]
    if 20 <= n < 100:
        tens, unit = divmod(n, 10)
        return _TENS[tens] + (f" {_UNITS[unit]}" if unit else "")
    return str(n)


_LIGHT_STRIP_RE = re.compile(r"[^a-z0-9\s]+")


def _light_normalize(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace — but KEEP digits
    (unlike _normalize_name) so quotes with jersey numbers stay checkable."""
    return " ".join(_LIGHT_STRIP_RE.sub(" ", str(s or "").lower()).split())


def _evidence_in_transcript(said: str, transcript: str) -> bool:
    """The quoted removal words must actually occur in the transcript —
    a fabricated quote ('Priya comes off' when the coach only recited other
    names) fails this regardless of how plausible it sounds."""
    said_l = _light_normalize(said)
    return bool(said_l) and said_l in _light_normalize(transcript)


def _evidence_references_player(said: str, out_name: str, roster) -> bool:
    """Does the quoted removal evidence actually reference this player —
    by a name token, nickname token, or jersey number (digits or words)?
    'Line is Kris, Sam, ...' quoted as evidence for removing Priya
    references her in no way and is rejected."""
    said_norm_tokens = set(_normalize_name(said).split())
    name_tokens = set(_normalize_name(out_name).split())
    if said_norm_tokens & name_tokens:
        return True

    # Resolve the out-name to a roster entry for nickname/number checks.
    player = None
    for p in roster:
        if p.name == out_name or p.name.casefold() == out_name.casefold():
            player = p
            break
    if player is None:
        norm = _normalize_name(out_name)
        hits = [p for p in roster if _normalize_name(p.name) == norm]
        player = hits[0] if len(hits) == 1 else None
    if player is None:
        return False

    if player.nickname and set(_normalize_name(player.nickname).split()) & said_norm_tokens:
        return True
    if player.number:
        num = str(player.number).strip()
        if num and re.search(rf"(?<![0-9]){re.escape(num)}(?![0-9])", said):
            return True
        try:
            words = set(_number_words(int(num)).split())
        except ValueError:
            words = set()
        if words and words <= said_norm_tokens:
            return True
    return False


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

def _roster_line(p: LineupRosterPlayer) -> str:
    parts = [p.name]
    if p.nickname:
        parts.append(f'"{p.nickname}"')
    if p.number:
        parts.append(f"#{p.number}")
    return "- " + " ".join(parts)


def _build_lineup_prompt(req: LineupRequest) -> str:
    roster_block = "\n".join(_roster_line(p) for p in req.roster)

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

    return f"""You are the voice-input layer for an ultimate frisbee lineup screen. The coach speaks; you extract WHICH PLAYERS GO IN and WHICH COME OFF — the verbal equivalent of tapping their names on the roster list. You never pick, complete, trim, or output a lineup: the app applies your in/out changes to the on-screen selection, and line-filling is the coach's job (or the app's Auto button), never yours.

Team roster. These are the ONLY valid players. Match spoken references against the name, the "nickname" in quotes, and the #jersey-number:
{roster_block}

Previous lineup (who played the last point). Used ONLY to expand explicit whole-line phrases like "same line" / "run it back" — never as something to fill from:
{prev_block}

Currently selected on screen (context only — the app applies your changes to this list; re-adding an already-selected player is harmless):
{curr_block}

Expected lineup size: {req.expected_count} players. Context for your "note" only — NEVER add players to approach it.

Transcript of what the coach said (speech-to-text; may contain transcription errors and unrelated chatter):
---
{req.transcript}
---

Reply with ONLY a JSON object of this exact shape (no prose, no markdown fences):
{{"clear": false, "clear_said": "", "in": ["Name", ...], "out": [{{"name": "Name", "said": "the coach's exact removal words"}}, ...], "unmatched": ["spoken reference", ...], "note": ""}}

Every "out" entry MUST quote, in "said", the coach's actual words that took that player off ("Wes's coming off", "Priya in for Alice" quoting the replacement). If you cannot quote removal words for a player, that player does NOT go in "out". RETRACTED words are VOID as evidence: when the coach cancels a change ("Priya in for Alice — actually no, Priya's in for Wes, Alice stays"), the cancelled phrase no longer counts as removal words — Alice has no valid evidence and does NOT go in "out". "in" entries are plain names — additions need no evidence.

How to interpret the transcript:
1. Bare names go IN: "Kris", "umm, Priya... and Dana", "Jake, Kris, and Charlie go in" — exactly those players in "in", nothing in "out".
2. "X goes in for Y", "X replaces Y", "X for Y" — X in, Y out. "X is coming off", "X off", "X sits", "X takes a break" — X out. "add X", "X is on", "X's in" — X in.
3. "same line", "run it back", "same as last point" — every player of the Previous lineup goes in "in". "Kris in for Wes, everyone else run it back" — "in": Kris plus the rest of the Previous lineup, "out": Wes.
   CLEAR-EVERYONE: "wholesale" / "let's get a wholesale" (Wholesale is this app's clear-the-selection button — coaches use it as a verb), "everybody comes off", "everyone off", "all players come off", "clear the line", "start fresh" — set "clear": true and quote the coach's exact words in "clear_said". A clear un-taps the whole current selection at once; players named AFTER the clear go in "in" ("Let's get a wholesale, then put in Kris and Charlie" → clear: true, in: Kris, Charlie). A clear also cancels any "in" spoken BEFORE it. Do not also list the cleared players in "out".
4. Later statements override earlier ones. "...and is that Hank? No, I think it's Morgan" is an identity correction: Morgan in, Hank nowhere (not in "out" — the coach never removed him, they corrected themselves). A retracted change never happened: "Priya in for Alice — actually no, Priya's in for Wes, Alice stays" gives "in": Priya and "out": Wes only; Alice appears nowhere.
5. Ignore asides: commentary about the last point, scores, fatigue, weather, sideline chatter. Wrap-up phrases ("Omar completes the lineup", "that's the seven", "that's the line") mean the named player goes in and the coach finished talking — they NEVER make you add anyone else.
   A framing like "the line is X, Y, Z" only puts the named players in "in" — it puts NOBODY in "out". Already-selected players the coach didn't mention simply stay selected; when a coach wants a fresh line they clear the list first.
   A player never appears in both "in" and "out": resolve to the coach's LAST statement about that player ("Kris, Sam... and Kris is coming off" puts Kris ONLY in "out").
6. Spoken references may be first names, full names, nicknames, jersey numbers ("number 12", "twelve", "#12"), or mispronounced/mistranscribed versions of a name — map each to the closest roster player. A trailing initial or fragment ("Morgan V", "Morgan MV") disambiguates between similarly-named players.
7. Spell every entry in "in"/"out" EXACTLY as its roster line spells the name — digits and symbols included when they are part of the name itself ("Jamal 23", "23 Jamal", "Jamal #23"), never a cleaned-up version, and never with the "nickname" or #jersey-number decorations appended. A spoken reference that matches nobody on the roster goes in "unmatched", never in "in" or "out".
8. THE CARDINAL RULE: "in" and "out" contain ONLY players the coach referred to — by name, or through an explicit whole-line phrase from rule 3. Never anyone else, no matter how short the resulting lineup would be: if the coach named 3 players, "in" has exactly 3 entries. And "out" contains ONLY players removed with explicit off/sits/coming-off/replaced-by language — NEVER a player who is merely absent from a list the coach recited. Reciting names ("the line is A, B, C") is tapping those names IN; it un-taps nobody. If something was notable (a retraction, an ambiguous reference, far fewer players than the expected size), say it in one short sentence in "note".
"""


# =============================================================================
# Claude call
# =============================================================================

async def _call_claude_lineup(api_key: str, prompt: str) -> Dict[str, Any]:
    """POST the prompt to the Anthropic Messages API and parse the JSON reply.

    Raises on transport/API/parse failure — the endpoint converts that to
    an error payload.
    """
    model = _lineup_model()

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Anthropic API {resp.status_code}: {resp.text[:500]}")

    body = resp.json()
    text_parts: List[str] = []
    for block in body.get("content", []):
        if block.get("type") == "text":
            text_parts.append(block.get("text", ""))
    text = "".join(text_parts).strip()
    return _parse_lineup_json(text)


def _parse_lineup_json(text: str) -> Dict[str, Any]:
    """Parse the model's reply, tolerating fences, prose, and self-corrections.

    Tap-equivalent shape: {"in": [...], "out": [...], ...}. "in" is the
    anchor key; a reply without it (including the retired full-lineup
    "players" shape) is a contract violation and errors out — the client
    then leaves the selection untouched.
    """
    parsed = _last_json_object(text, "in")
    if not isinstance(parsed.get("in"), list):
        raise RuntimeError("Claude lineup response missing 'in' list")
    if "out" in parsed and not isinstance(parsed.get("out"), list):
        raise RuntimeError("Claude lineup response 'out' is not a list")
    parsed["clear"] = bool(parsed.get("clear"))
    parsed["clear_said"] = str(parsed.get("clear_said") or "")
    # Normalize out entries to {name, said} dicts; bare strings mean the
    # model skipped the evidence field (treated as no evidence).
    outs = []
    for entry in parsed.get("out", []):
        if isinstance(entry, dict) and entry.get("name"):
            outs.append({"name": str(entry["name"]), "said": str(entry.get("said") or "")})
        elif isinstance(entry, (str, int)):
            outs.append({"name": str(entry), "said": ""})
    parsed["out"] = outs
    return parsed


# =============================================================================
# Squads — speech-to-squads for the scrimmage dialog
#
# POST /api/narration/squads. Same contract shape as /lineup: the model
# reports what the coach said, the server applies it. Here a "tap" is a pick
# button in the New Scrimmage / Edit Squads picker: a player goes on squad
# X, on squad Y, or on neither. Four things are the server's, not the
# model's:
#   - the DEFAULT SQUAD: a name read out with no squad means the first
#     squad; the model leaves the squad blank and the server fills it in;
#   - the CLOSED ROSTER: a coach only names players on the team, so a name
#     the recognizer mangled ("Dayna" for Dana) is resolved to the one
#     roster name it is closest to (_closest_roster_name) when the model
#     did not do so itself;
#   - COLLECTIVE phrases — "everyone else on Black", "the FMPs on Orange",
#     "the rest of the guys on Black" — which the model only reports, with a
#     quote; the server verifies the quote and expands it over the roster,
#     skipping anyone who is not here today and, for a "rest", anyone the
#     coach has already placed (roster[].pinned);
#   - COUNTS — "two more FMPs on Dark" — which nobody on the server picks:
#     the verified instruction goes back as a ``fill`` and the picker
#     chooses, with the same balance rules as its Auto button.
# =============================================================================

SQUAD_KEYS = ("X", "Y")
GENDER_GROUPS = ("FMP", "MMP")
ANY_GROUP = "ANY"
MAX_FILL_COUNT = 30


class SquadsRosterPlayer(LineupRosterPlayer):
    # "FMP" | "MMP"; anything else is unknown and belongs to neither group.
    gender: Optional[str] = None
    # The picker's "here today" box. A player who is not here is never
    # swept up by a collective phrase or picked for a count — only naming
    # them puts them on a squad.
    here: bool = True
    # Placed on a squad by the coach (a tap, or an earlier narration), as
    # opposed to dealt there by Auto. "Everyone else" and "the rest of the
    # FMPs" leave pinned players where the coach put them.
    pinned: bool = False


class SquadsRequest(BaseModel):
    # Authorization is against the TEAM (require_body_team_recorder): a new
    # scrimmage has no game yet when its squads are being called.
    teamId: str
    transcript: str = Field(max_length=8000)
    # The whole team roster (everyone the picker lists), not one squad's.
    roster: List[SquadsRosterPlayer] = Field(max_length=60)
    # {"X": "Dark", "Y": "Light"} — what the coach calls the two squads.
    squad_names: Dict[str, str]
    # Who is on each squad now, by roster name — the picker's current state,
    # which the voiced placements are applied to (an unnamed player stays put).
    current_squads: Dict[str, List[str]] = {}


class SquadPlacement(BaseModel):
    name: str
    squad: str  # "X" | "Y"


class SquadGroupMove(BaseModel):
    group: str  # "FMP" | "MMP"
    squad: str  # "X" | "Y"
    scope: str  # "all" | "rest"


class SquadFill(BaseModel):
    """A verified "N more <group> on <squad>": the picker chooses who."""
    squad: str  # "X" | "Y"
    group: str  # "FMP" | "MMP" | "ANY"
    count: int


class SquadsResponse(BaseModel):
    # The resulting squads, derived server-side: {"X": [...], "Y": [...]},
    # before any ``fills`` are picked.
    squads: Dict[str, List[str]]
    # Players voiced off both squads (evidence-verified), in spoken order.
    out: List[str] = []
    # Counts for the picker to fill, in spoken order, after ``squads``.
    fills: List[SquadFill] = []
    unmatched: List[str] = []
    note: str = ""
    error: Optional[str] = None
    # Observability: what the model voiced, after the default-squad rule
    # and name resolution.
    voiced_assign: List[SquadPlacement] = []
    voiced_clear: bool = False
    # The squad an honored "everyone else on …" sent the unnamed players to.
    voiced_rest: Optional[str] = None
    voiced_groups: List[SquadGroupMove] = []


async def _squads_request(
    body: Dict[str, Any] = Depends(get_json_body)
) -> SquadsRequest:
    return parse_body(SquadsRequest, body)


@router.post("/squads", response_model=SquadsResponse)
async def extract_squads(
    user: dict = Depends(require_body_team_recorder),
    req: SquadsRequest = Depends(_squads_request),
):
    """
    Place players on a scrimmage's squads from the coach's spoken narration.

    Same error contract as /lineup: 503 without a key, 200 with ``error``
    set (and the current squads echoed back unchanged) when the model call
    fails — the client applies nothing that carries an error.
    """
    anthropic_key = _anthropic_key()
    if not anthropic_key:
        raise HTTPException(
            status_code=503,
            detail="Lineup narration unavailable: ANTHROPIC_API_KEY not configured",
        )

    unchanged = _current_squads(req)
    if not req.transcript.strip():
        return SquadsResponse(squads=unchanged, error="Empty transcript")
    if not req.roster:
        return SquadsResponse(squads=unchanged, error="Empty roster")
    if not all(str(req.squad_names.get(k) or "").strip() for k in SQUAD_KEYS):
        return SquadsResponse(squads=unchanged, error="Both squad names are required")

    prompt = _build_squads_prompt(req)
    try:
        result = await _call_claude_squads(anthropic_key, prompt)
    except Exception as e:  # noqa: BLE001 — degrade to an error payload, never a 500
        logger.exception("Squad extraction LLM call failed")
        return SquadsResponse(squads=unchanged, error=str(e))

    d = _derive_squads(result, req)
    # Counts only — no names, no transcript: enough to tell, from the log,
    # whether a "that didn't work" was the recognizer, the model or a guard.
    logger.info(
        "Squads: placed=%d out=%d groups=%d fills=%d rest=%s clear=%s "
        "unmatched=%d resolved_by_closest=%d dropped=%d",
        len(d.assign), len(d.outs), len(d.groups), len(d.fills), d.rest, d.cleared,
        len(d.unmatched), len(d.resolved), len(d.dropped),
    )
    note = str(result.get("note") or "")
    return SquadsResponse(
        squads=d.squads, out=d.outs, unmatched=d.unmatched, note=note,
        fills=[SquadFill(squad=k, group=g, count=n) for g, k, n in d.fills],
        voiced_assign=[SquadPlacement(name=n, squad=s) for n, s in d.assign],
        voiced_clear=d.cleared, voiced_rest=d.rest,
        voiced_groups=[SquadGroupMove(group=g, squad=k, scope=s) for g, k, s in d.groups],
    )


def _current_squads(req: SquadsRequest) -> Dict[str, List[str]]:
    return {k: [str(n) for n in (req.current_squads.get(k) or [])] for k in SQUAD_KEYS}


# ── evidence lexicons ────────────────────────────────────────────────────

# "everyone else on Black" — and, inside a group quote, what makes "the rest
# of the FMPs" a rest rather than "all the FMPs". Matched against the
# light-normalized quote.
_REST_LEXICON_RE = re.compile(
    r"every(one|body)\s+else"
    r"|(the\s+)?rest\s+(of\s+)?"
    r"|(all\s+)?the\s+others?\b"
    r"|\bother\s"
    r"|(all\s+)?the\s+remaining"
    r"|\bremaining\b"
    r"|the\s+remainder"
    r"|\bleft\s*over"
)

# Words that name a gender group. FMP = female-matching player, MMP =
# male-matching player (the app's own terms, store/models.js Gender); GMP
# and BMP are the girl-/boy-matching spellings some teams use. Speech-to-
# text writes the initialisms every which way ("FMPs", "F.M.P.s", "FMP's"),
# and light normalization turns the punctuation into spaces.
_GROUP_LEXICON = {
    "FMP": re.compile(r"\b(f\s?m\s?p|g\s?m\s?p|females?|wom[ae]n|girls?|lad(y|ies)|gals?)(\s?s)?\b"),
    "MMP": re.compile(r"\b(m\s?m\s?p|b\s?m\s?p|males?|m[ae]n|guys?|boys?|dudes?|gentlem[ae]n|fellas?)(\s?s)?\b"),
}

_COUNT_SYNONYMS = {
    1: {"a", "an", "one", "another", "single"},
    2: {"couple", "pair"},
}


def _rest_evidence_ok(said: str, transcript: str) -> bool:
    if not said or not _evidence_in_transcript(said, transcript):
        return False
    return bool(_REST_LEXICON_RE.search(_light_normalize(said)))


def _group_evidence_ok(said: str, group: str, transcript: str) -> bool:
    """A group phrase is honored only when its quote occurs in the transcript
    and, for a gender group, actually contains a word for THAT group — a
    model that reports "the FMPs" from a quote about "the guys" is refused."""
    if not said or not _evidence_in_transcript(said, transcript):
        return False
    if group == ANY_GROUP:
        return True
    lexicon = _GROUP_LEXICON.get(group)
    return bool(lexicon and lexicon.search(_light_normalize(said)))


def _group_in_quote(said: str) -> Optional[str]:
    """The gender group a quote names, when it names exactly one."""
    norm = _light_normalize(said)
    hits = [g for g in GENDER_GROUPS if _GROUP_LEXICON[g].search(norm)]
    return hits[0] if len(hits) == 1 else None


def _count_evidence_ok(said: str, count: int) -> bool:
    """The number in a "two more FMPs" must be in the quote — as digits, as
    words, or as one of the few idioms for one and two."""
    norm = _light_normalize(said)
    tokens = set(norm.split())
    if re.search(rf"(?<![0-9]){count}(?![0-9])", norm):
        return True
    words = set(_number_words(count).split())
    if words and words <= tokens:
        return True
    return bool(_COUNT_SYNONYMS.get(count, set()) & tokens)


def _group_key(spoken: Any) -> Optional[str]:
    g = str(spoken or "").strip().upper()
    if g in GENDER_GROUPS or g == ANY_GROUP:
        return g
    return None


def _squad_key(spoken: str, squad_names: Dict[str, str]) -> Optional[str]:
    """Map the model's squad field to "X" / "Y".

    Accepts the squad's name (case-insensitive, decoration-tolerant), the
    key letter itself, or a blank — which is the default-squad rule: None
    is returned ONLY for a non-empty string that names neither squad, so
    the caller can tell "unstated" (→ first squad) from "unrecognised".
    """
    raw = str(spoken or "").strip()
    if not raw:
        return SQUAD_KEYS[0]
    norm = _normalize_name(raw)
    for key in SQUAD_KEYS:
        if norm and norm == _normalize_name(squad_names.get(key, "")):
            return key
    if raw.upper() in SQUAD_KEYS:
        return raw.upper()
    for key in SQUAD_KEYS:
        name_norm = _normalize_name(squad_names.get(key, ""))
        if norm and name_norm and (norm in name_norm.split() or name_norm in norm.split()):
            return key
    return None


# ── the closed roster: resolving a name as heard ─────────────────────────

# A heard name is taken for a roster player when it is at least this similar
# to one of their names and clearly more similar than to anyone else's.
_CLOSEST_MIN_SCORE = 0.65
_CLOSEST_MIN_MARGIN = 0.1


def _exact_roster_name(name: str, roster) -> Optional[str]:
    """The roster's own spelling for ``name`` when it IS a roster name:
    exact → casefold → nickname → unique normalized (the frontend matcher's
    ladder, narration/lineupResolve.js matchRosterPlayer)."""
    wanted = str(name or "").strip()
    if not wanted:
        return None
    for p in roster:
        if p.name == wanted:
            return p.name
    folded = wanted.casefold()
    for p in roster:
        if p.name.casefold() == folded:
            return p.name
    for p in roster:
        if p.nickname and str(p.nickname).casefold() == folded:
            return p.name
    norm = _normalize_name(wanted)
    if norm:
        hits = [p for p in roster if _normalize_name(p.name) == norm]
        if len(hits) == 1:
            return hits[0].name
    return None


def _name_similarity(heard: str, candidate: str) -> float:
    if not heard or not candidate:
        return 0.0
    score = difflib.SequenceMatcher(None, heard, candidate).ratio()
    # Recognizers get the start of a name right far more often than the
    # rest; a shared first letter separates "Mya" → Mia from the Omar that
    # merely shares its letters.
    if heard[0] == candidate[0]:
        score = min(1.0, score + 0.05)
    # A clipped name ("Char" for Charlie) is a prefix, which the ratio
    # alone undersells.
    if len(heard) >= 3 and candidate.startswith(heard):
        score = max(score, 0.85)
    return score


def _closest_roster_name(heard: str, roster) -> Optional[str]:
    """The ONE roster player a mangled name most plausibly is, or None.

    The roster is closed — a coach setting up a scrimmage names only people
    on the team — so a name the recognizer wrote wrongly ("Dayna", "Chris",
    "Zoey") is somebody on it. Compared against each player's full name, each
    word of it and their nickname; taken only when the best score clears
    _CLOSEST_MIN_SCORE and beats the runner-up by _CLOSEST_MIN_MARGIN, so a
    name that could be two players stays unmatched rather than guessed.
    """
    norm = _normalize_name(heard)
    forms = {norm} | {t for t in norm.split() if len(t) >= 3}
    forms = {f for f in forms if len(f) >= 3}
    if not forms:
        return None
    scored = []
    for p in roster:
        cands = set()
        for source in (p.name, p.nickname):
            n = _normalize_name(source or "")
            if n:
                cands.add(n)
                cands.update(n.split())
        best = max((_name_similarity(f, c) for f in forms for c in cands), default=0.0)
        scored.append((best, p.name))
    scored.sort(key=lambda t: t[0], reverse=True)
    if not scored:
        return None
    best, name = scored[0]
    runner_up = scored[1][0] if len(scored) > 1 else 0.0
    if best >= _CLOSEST_MIN_SCORE and best - runner_up >= _CLOSEST_MIN_MARGIN:
        return name
    return None


def _resolve_roster_name(name: str, roster):
    """(roster name | None, resolved_by_closest)."""
    exact = _exact_roster_name(name, roster)
    if exact is not None:
        return exact, False
    closest = _closest_roster_name(name, roster)
    return closest, closest is not None


def _worksheet_squad(heard: str, phrases, req) -> Optional[str]:
    """The squad of the worksheet phrase a heard name was spoken in, or None
    when no phrase of the transcript contains it (or the phrase is not about
    placing anyone — a sit-out, say, which the caller must not turn into a
    placement)."""
    word = _light_normalize(heard)
    if not word:
        return None
    for ph in phrases or []:
        words = _light_normalize(ph.get("words", ""))
        if not words or word not in words.split() and f" {word} " not in f" {words} ":
            continue
        if not _evidence_in_transcript(ph.get("words", ""), req.transcript):
            continue
        if _SIT_OUT_RE.search(words):
            return None
        key = _squad_key(ph.get("squad"), req.squad_names)
        return key if key is not None else SQUAD_KEYS[0]
    return None


# A worksheet phrase that takes somebody OFF rather than putting them on.
_SIT_OUT_RE = re.compile(
    r"\bsits?\b|\bsitting\b|\bis out\b|\bs out\b|\bare out\b|\bisn t here\b|\bnot here\b"
    r"|\binjured\b|\bhurt\b|\boff\b|\babsent\b|\bcan t (make|play)\b"
)


def _quote_names_player(said: str, roster_name: str, roster) -> bool:
    """Does a quote refer to this player once mangled names are allowed for?
    The strict check first (a name, nickname or number token); failing that,
    any word of the quote that resolves — as a heard name — to this player
    and to nobody else ("Dayna sits out" names Dana)."""
    if _evidence_references_player(said, roster_name, roster):
        return True
    for token in _normalize_name(said).split():
        if len(token) >= 3 and _closest_roster_name(token, roster) == roster_name:
            return True
    return False


# ── derivation ───────────────────────────────────────────────────────────

class SquadDerivation:
    """Everything _derive_squads works out, named so callers do not unpack
    a tuple that keeps growing."""

    def __init__(self):
        self.squads: Dict[str, List[str]] = {k: [] for k in SQUAD_KEYS}
        self.assign: List[tuple] = []      # (roster name, squad key)
        self.outs: List[str] = []          # roster names
        self.cleared: bool = False
        self.rest: Optional[str] = None    # squad key
        self.groups: List[tuple] = []      # (group, squad key, "all" | "rest")
        self.fills: List[tuple] = []       # (group, squad key, count)
        self.unmatched: List[str] = []
        self.resolved: List[tuple] = []    # (heard, roster name) — closest-name resolutions
        self.dropped: List[str] = []       # what a guard refused, for the log


def _derive_squads(result: Dict[str, Any], req: SquadsRequest) -> SquadDerivation:
    """The complete post-model derivation for /squads, in one place (the
    same reason as _derive_players): shape the reply defensively, resolve
    names against the closed roster, verify the evidence for a clear, the
    sit-outs, an "everyone else" and the group phrases, apply the
    default-squad rule, then the tap-equivalent set arithmetic."""
    d = SquadDerivation()
    roster = req.roster
    unresolved: List[str] = []

    d.cleared = bool(result.get("clear"))
    if d.cleared and not _clear_evidence_ok(str(result.get("clear_said") or ""), req.transcript):
        d.cleared = False
        d.dropped.append("<clear>")

    for entry in result.get("assign", []):
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        heard = str(entry["name"])
        name, by_closest = _resolve_roster_name(heard, roster)
        if name is None:
            unresolved.append(heard)
            continue
        if by_closest:
            d.resolved.append((heard, name))
        key = _squad_key(entry.get("squad"), req.squad_names)
        if key is None:
            # Named a squad that is not one of the two: the player was still
            # placed on purpose, so the first squad is the honest fallback.
            d.dropped.append(f"{name}:squad={entry.get('squad')!r}")
            key = SQUAD_KEYS[0]
        d.assign.append((name, key))

    # A name the model gave up on ("unmatched") although exactly one roster
    # player is close to it: the roster is closed, so that is who it is. The
    # squad comes from the model's own worksheet — the phrase the word was
    # spoken in — and only a phrase that really is in the transcript counts.
    # Never overrides something the model did place.
    placed = {n for n, _ in d.assign}
    out_names_raw = {str(e.get("name")) for e in result.get("out", []) if isinstance(e, dict)}
    for u in result.get("unmatched", []):
        if not isinstance(u, (str, int)):
            continue
        heard = str(u)
        name, _ = _resolve_roster_name(heard, roster)
        if name is None or name in placed or name in out_names_raw:
            continue
        key = _worksheet_squad(heard, result.get("phrases", []), req)
        if key is None:
            continue
        d.assign.append((name, key))
        d.resolved.append((heard, name))
        placed.add(name)

    for e in result.get("out", []):
        if not isinstance(e, dict) or not e.get("name"):
            continue
        heard = str(e["name"])
        said = str(e.get("said") or "").strip()
        name, by_closest = _resolve_roster_name(heard, roster)
        if (name is not None and said and _evidence_in_transcript(said, req.transcript)
                and _quote_names_player(said, name, roster)):
            d.outs.append(name)
            if by_closest:
                d.resolved.append((heard, name))
        else:
            d.dropped.append(name or heard)

    rest_raw = str(result.get("rest") or "").strip()
    if rest_raw:
        rest_key = _squad_key(rest_raw, req.squad_names)
        if rest_key is None or not _rest_evidence_ok(str(result.get("rest_said") or ""), req.transcript):
            d.dropped.append("<rest>")
        else:
            d.rest = rest_key

    for g in result.get("groups", []):
        if not isinstance(g, dict):
            continue
        group = _group_key(g.get("group"))
        key = _squad_key(g.get("squad"), req.squad_names)
        said = str(g.get("said") or "").strip()
        count = g.get("count")
        if isinstance(count, bool) or not isinstance(count, int):
            count = None
        # The quote outranks the model's label: "the rest of the GMPs" names
        # the FMP group whatever the model made of the initialism.
        quoted = _group_in_quote(said)
        if quoted is not None:
            group = quoted
        if group is None or key is None or not _group_evidence_ok(said, group, req.transcript):
            d.dropped.append("<group>")
            continue
        if count is not None:
            if not (1 <= count <= MAX_FILL_COUNT) or not _count_evidence_ok(said, count):
                d.dropped.append("<group:count>")
                continue
            d.fills.append((group, key, count))
        elif group == ANY_GROUP:
            # "Everyone on Dark" with no gender and no number is not a
            # group move; an ungendered "everyone else" is ``rest``.
            d.dropped.append("<group:any>")
        else:
            scope = "rest" if _REST_LEXICON_RE.search(_light_normalize(said)) else "all"
            d.groups.append((group, key, scope))

    base = {k: [] for k in SQUAD_KEYS} if d.cleared else _current_squads(req)
    d.squads = _apply_squad_changes(
        base, d.assign, d.outs, d.rest, roster, groups=d.groups, cleared=d.cleared)

    # What could not be placed: the model's own unmatched references — minus
    # any that turn out to be a player it did place (a small model lists
    # "Dayna" as unmatched AND places Dana) — plus names it placed that
    # resolve to nobody.
    named = {n for n, _ in d.assign} | set(d.outs)
    seen = set()
    for u in list(result.get("unmatched", [])) + unresolved:
        if not isinstance(u, (str, int)):
            continue
        u = str(u)
        resolved, _ = _resolve_roster_name(u, roster)
        if resolved is not None and resolved in named:
            continue
        if u.casefold() in seen:
            continue
        seen.add(u.casefold())
        d.unmatched.append(u)
    return d


def _roster_facts(roster) -> List[tuple]:
    """(name, gender group | None, here, pinned) per roster entry. A plain
    list of names is accepted too (everyone here, nobody pinned)."""
    facts = []
    for p in roster:
        if isinstance(p, str):
            facts.append((p, None, True, False))
            continue
        gender = str(getattr(p, "gender", None) or "").strip().upper()
        facts.append((
            p.name,
            gender if gender in GENDER_GROUPS else None,
            bool(getattr(p, "here", True)),
            bool(getattr(p, "pinned", False)),
        ))
    return facts


def _apply_squad_changes(
    current: Dict[str, List[str]],
    assign: List[tuple],
    outs: List[str],
    rest: Optional[str],
    roster,
    groups=(),
    cleared: bool = False,
) -> Dict[str, List[str]]:
    """squads = current, with the collective phrases expanded first and the
    named placements applied over them.

    Collective phrases place players the coach did NOT name, and only ones
    who are here today: a gender group ("the FMPs on Orange": everyone in
    the group; "the rest of the FMPs": everyone in it the coach has not
    already placed — roster ``pinned``), then an ungendered "everyone else"
    over whoever no group claimed, again leaving pinned players alone. A
    clear un-pins everyone: nothing placed before it survives it.

    Then every out comes off both squads and every named player moves to
    the squad voiced for them. A later statement about a player wins (a
    duplicate name is kept to the last placement), and an out beats a
    placement for the same name. Name matching is the same exact → casefold
    → unique-normalized ladder as _apply_changes.
    """
    def _matches(a: str, b: str) -> bool:
        if a == b or a.casefold() == b.casefold():
            return True
        na, nb = _normalize_name(a), _normalize_name(b)
        return bool(na) and na == nb

    # Last placement per name wins; an out cancels a placement.
    final: List[tuple] = []
    for name, key in assign:
        final = [(n, k) for n, k in final if not _matches(n, name)]
        final.append((name, key))
    final = [(n, k) for n, k in final if not any(_matches(n, o) for o in outs)]

    def _remove(lst: List[str], name: str) -> List[str]:
        hit = next((x for x in lst if x == name), None)
        if hit is None:
            hit = next((x for x in lst if x.casefold() == name.casefold()), None)
        if hit is None:
            norm = _normalize_name(name)
            hits = [x for x in lst if norm and _normalize_name(x) == norm]
            hit = hits[0] if len(hits) == 1 else None
        return [x for x in lst if x != hit] if hit is not None else lst

    squads = {k: list(current.get(k) or []) for k in SQUAD_KEYS}
    named = [n for n, _ in final] + list(outs)
    facts = _roster_facts(roster)

    def _move(names: List[str], key: str) -> None:
        for k in SQUAD_KEYS:
            for n in names:
                squads[k] = _remove(squads[k], n)
        for n in names:
            if not any(_matches(n, x) for x in squads[key]):
                squads[key].append(n)

    claimed: List[str] = []

    def _unnamed(include_pinned: bool, group: Optional[str] = None) -> List[str]:
        return [
            name for name, gender, here, pinned in facts
            if here
            and (group is None or gender == group)
            and (include_pinned or cleared or not pinned)
            and not any(_matches(name, m) for m in named)
            and name not in claimed
        ]

    for group, key, scope in groups:
        members = _unnamed(include_pinned=(scope == "all"), group=group)
        _move(members, key)
        claimed.extend(members)

    if rest:
        _move(_unnamed(include_pinned=False), rest)

    for name in outs:
        for k in SQUAD_KEYS:
            squads[k] = _remove(squads[k], name)
    for name, key in final:
        for k in SQUAD_KEYS:
            squads[k] = _remove(squads[k], name)
        squads[key].append(name)
    return squads


# ── prompt ───────────────────────────────────────────────────────────────

def _squad_roster_line(p) -> str:
    line = _roster_line(p)
    gender = str(getattr(p, "gender", None) or "").strip().upper()
    if gender in GENDER_GROUPS:
        line += f" [{gender}]"
    return line


def _build_squads_prompt(req: SquadsRequest) -> str:
    roster_block = "\n".join(_squad_roster_line(p) for p in req.roster)
    first = req.squad_names["X"].strip()
    second = req.squad_names["Y"].strip()

    def squad_block(key: str) -> str:
        names = req.current_squads.get(key) or []
        return "\n".join(f"- {n}" for n in names) if names else "(empty)"

    return f"""You are the voice-input layer for a scrimmage set-up screen in an ultimate frisbee app. The team is split into two squads, "{first}" and "{second}". The coach speaks; you report WHICH PLAYERS GO ON WHICH SQUAD and WHO SITS OUT — the verbal equivalent of tapping a player's "{first}" or "{second}" button on the list. You never fill, balance, complete or output a squad yourself: you report what the coach said and the app applies it, including choosing the players when the coach asks for a number of them.

Team roster. This list is CLOSED: these are the only people the coach can be talking about. Each line is the name, then an optional "nickname" in quotes, an optional #jersey-number, and the player's gender group in brackets ([FMP] female-matching, [MMP] male-matching):
{roster_block}

Currently on "{first}" (context only — the app applies what you report to this):
{squad_block("X")}

Currently on "{second}" (context only):
{squad_block("Y")}

Transcript of what the coach said (speech-to-text; names are often transcribed wrongly, and there may be unrelated chatter):
---
{req.transcript}
---

Reply with ONLY a JSON object of this exact shape (no prose, no markdown fences):
{{"phrases": [{{"words": "a phrase of the transcript", "squad": "{first}" | "{second}" | ""}}, ...], "clear": false, "clear_said": "", "assign": [{{"name": "Name", "squad": "{first}" | "{second}" | ""}}, ...], "groups": [{{"group": "FMP" | "MMP" | "ANY", "squad": "{first}" | "{second}" | "", "count": null, "said": "the coach's exact words"}}, ...], "rest": "", "rest_said": "", "out": [{{"name": "Name", "said": "the coach's exact words"}}, ...], "unmatched": ["spoken reference", ...], "note": ""}}

Fill "phrases" FIRST, as a worksheet: cut the transcript into its placement phrases in the order spoken ("Alice and Dana on {first}" / "the rest of the FMPs on {second}"), and beside each write the squad THAT phrase puts people on ("" when it names none and none carries to it). Then build everything else from the worksheet, one phrase at a time: the names in a phrase get that phrase's squad and no other phrase's.

How to interpret the transcript:
1. Every player the coach names goes in "assign", with "squad" set to the squad the coach put them on, spelled exactly "{first}" or "{second}". "Alice and Bob on {first}, Dana {second}" → Alice and Bob with "{first}", Dana with "{second}". Squads may be referred to by name, by colour, or by a word of the name; map them to the two names above.
2. A name spoken with NO squad gets "squad": "" — leave it blank, never guess. The app puts blank placements on "{first}", so a coach who simply reads out a list ("Alice, Bob, Charlie, Dana") is filling "{first}". A squad named once carries to the names that follow it until another squad is named: "{second} is Eve, Hank and Iris" gives all three "{second}"; "{first}: Alice, Bob. {second}: Dana, Eve" splits them.
3. THE ROSTER IS CLOSED, and speech-to-text mangles names. A name-like word that is not spelled like anyone on the roster is a MISHEARING of somebody who is — never a different person. "Dayna" on a roster with a Dana IS Dana; "Chris" is Kris; "Zoey" is Zoe; "Jakes" is Jake. Put the ROSTER spelling in "name" and do NOT also list the word in "unmatched". Only when a name-like word sounds equally like two roster players, or like none of them, put it in "name" exactly AS HEARD (keeping its squad) — the app will resolve it or tell the coach. Spoken references may also be full names, nicknames or jersey numbers ("number 12", "twelve", "#12"); a trailing initial disambiguates similar names. Spell every resolved "name" EXACTLY as its roster line spells it, digits and symbols included, without the nickname, #number or [group] decorations. "unmatched" is only for references you could not turn into a placement at all ("the new kid", "what's-his-name").
4. "X sits out", "X is out", "X isn't here", "X is injured", "X off", "take X off" — X goes in "out" (rule 3 applies to the name), quoting the coach's exact words in "said". A player never appears in both "assign" and "out": the coach's LAST statement about a player wins ("Alice on {first}… actually Alice is sitting out" → out only). RETRACTED words are void as evidence.
5. GROUPS — the coach places players by gender group or by number instead of by name. Report each such phrase as one "groups" entry, quoting the coach's exact words in "said"; NEVER expand it into names in "assign" — the app knows who is in each group, who is here and who is already placed.
   - Gender words: FMP = "FMP(s)", "GMP(s)" (girl-matching player — a real term some teams use; it is NOT a mishearing of MMP), "female players", "female-matching players", "women", "girls", "ladies". MMP = "MMP(s)", "BMP(s)" (boy-matching player), "male players", "male-matching players", "men", "guys", "boys". Use "ANY" only for a number with no gender word.
   - The whole group, "count": null: "the FMPs on {first}", "all the women on {second}", "girls are {first}" → {{"group": "FMP", "squad": "…", "count": null, "said": "…"}}.
   - The rest of a group, "count": null: "the rest of the FMPs on {second}", "the other guys on {first}", "the remaining women go {second}" → the same shape. Keep the word "rest" / "other" / "remaining" inside "said": the app reads from your quote that the coach meant only the ones not yet placed.
   - A number of them: "two more FMPs on {first}", "another guy on {second}", "add a couple of women to {first}", "three more on {second}" → "count" is the number (2, 1, 2, 3) and "said" contains the number word; "group" is "ANY" when no gender word was said. The app chooses which players.
   - A group phrase with no squad gets "squad": "", like a name (rule 2), and a squad named earlier carries to it.
6. "everyone else on {second}", "the rest on {first}", "the others are {second}" — with NO gender word — set "rest" to that squad name and quote the words in "rest_said". The app then sends every player you did not name, and no group covered, to that squad. Do not list those players yourself.
7. CLEAR-EVERYONE: "clear the squads", "start fresh", "start over", "everybody off", "wholesale" — set "clear": true and quote the words in "clear_said". A clear empties both squads before anything else you report applies.
8. Later statements override earlier ones ("Dana on {first} — no, {second}" → Dana with "{second}"; "is that Hank? no, Morgan" → Morgan, Hank nowhere). Ignore asides: chatter, the weather, who is late, the score of the last point. Wrap-ups ("that's everyone", "that's the split") add nobody.
9. THE CARDINAL RULE: "assign" and "out" contain ONLY players the coach referred to by name, nickname or number. Never anyone else, however uneven the squads would be: if the coach named 3 players, "assign" has exactly 3 entries. Reciting names taps those players onto a squad; it moves nobody else. Say anything notable (a retraction, an ambiguous reference) in one short sentence in "note".
"""


async def _call_claude_squads(api_key: str, prompt: str) -> Dict[str, Any]:
    """Same transport as the lineup call; separate so tests can mock each."""
    model = _lineup_model()
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Anthropic API {resp.status_code}: {resp.text[:500]}")

    body = resp.json()
    text = "".join(
        block.get("text", "") for block in body.get("content", []) if block.get("type") == "text"
    ).strip()
    return _parse_squads_json(text)


def _parse_squads_json(text: str) -> Dict[str, Any]:
    """Parse the model's reply. "assign" is the anchor key; a reply without
    it is a contract violation and errors out, so the client applies nothing."""
    parsed = _last_json_object(text, "assign")
    if not isinstance(parsed.get("assign"), list):
        raise RuntimeError("Claude squads response missing 'assign' list")
    if "out" in parsed and not isinstance(parsed.get("out"), list):
        raise RuntimeError("Claude squads response 'out' is not a list")
    parsed["clear"] = bool(parsed.get("clear"))
    parsed["clear_said"] = str(parsed.get("clear_said") or "")
    parsed["rest"] = str(parsed.get("rest") or "")
    parsed["rest_said"] = str(parsed.get("rest_said") or "")
    assign = []
    for entry in parsed.get("assign", []):
        if isinstance(entry, dict) and entry.get("name"):
            assign.append({"name": str(entry["name"]), "squad": str(entry.get("squad") or "")})
        elif isinstance(entry, (str, int)):
            # A bare name: the model skipped the squad field — unstated.
            assign.append({"name": str(entry), "squad": ""})
    parsed["assign"] = assign
    outs = []
    for entry in parsed.get("out", []):
        if isinstance(entry, dict) and entry.get("name"):
            outs.append({"name": str(entry["name"]), "said": str(entry.get("said") or "")})
        elif isinstance(entry, (str, int)):
            outs.append({"name": str(entry), "said": ""})
    parsed["out"] = outs
    groups = []
    raw_groups = parsed.get("groups")
    for entry in (raw_groups if isinstance(raw_groups, list) else []):
        if not isinstance(entry, dict):
            continue
        count = entry.get("count")
        if isinstance(count, str) and count.strip().isdigit():
            count = int(count.strip())
        if isinstance(count, bool) or not isinstance(count, int):
            count = None
        groups.append({
            "group": str(entry.get("group") or ""),
            "squad": str(entry.get("squad") or ""),
            "count": count,
            "said": str(entry.get("said") or ""),
        })
    parsed["groups"] = groups
    phrases = []
    raw_phrases = parsed.get("phrases")
    for entry in (raw_phrases if isinstance(raw_phrases, list) else []):
        if isinstance(entry, dict) and entry.get("words"):
            phrases.append({"words": str(entry["words"]), "squad": str(entry.get("squad") or "")})
    parsed["phrases"] = phrases
    return parsed
