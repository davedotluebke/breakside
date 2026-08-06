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

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Dual-import pattern, mirroring narration.py / the rest of the backend.
try:
    from auth import get_current_user  # type: ignore
except ImportError:
    from ultistats_server.auth import get_current_user  # type: ignore

try:
    from narration import _last_json_object  # type: ignore
except ImportError:
    from ultistats_server.narration import _last_json_object  # type: ignore


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
    # For auth/audit context; lineup extraction itself is stateless.
    game_id: Optional[str] = None
    transcript: str
    # FULL active roster — not just on-field players. The whole point of
    # calling a line is naming players coming OFF the bench.
    roster: List[LineupRosterPlayer]
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

@router.post("/lineup", response_model=LineupResponse)
async def extract_lineup(
    req: LineupRequest = Body(...),
    user: dict = Depends(get_current_user),
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
    r"|clear\s+(the\s+)?(line|list|selection)"
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
