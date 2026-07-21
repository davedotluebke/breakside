"""
Lineup narration endpoint — speech-to-lineup for the Lines tab.

POST /api/narration/lineup
    Accepts a transcript of the coach speaking the next line, plus the
    context needed to interpret it (full roster, expected player count,
    previous lineup, current on-screen selection), and asks Claude to
    return the final set of players for the line.

This is a SEPARATE layer from the in-point narration pipeline in
narration.py (token minting + play-by-play finalize). It deliberately
lives in its own module with its own router so lineup work and in-point
narration work don't step on each other. The frontend counterpart is
narration/lineupNarration.js.

The task differs from play-by-play extraction in kind, not just prompt:
the answer is a set of players rather than a sequence of events, and the
coach speaks in lineup idioms — "Cyrus goes in for Nate" (a substitution
against the previous lineup), "same line", "Owain completes the lineup" —
interleaved with asides and self-corrections that must resolve in favor
of the LAST thing said.
"""
from __future__ import annotations

import json
import logging
import os
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
    players: List[str]
    unmatched: List[str] = []
    note: str = ""
    error: Optional[str] = None


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

    # Defensive shaping: only ever return strings the model put in lists.
    players = [str(p) for p in result.get("players", []) if isinstance(p, (str, int))]
    unmatched = [str(u) for u in result.get("unmatched", []) if isinstance(u, (str, int))]
    note = str(result.get("note") or "")
    return LineupResponse(players=players, unmatched=unmatched, note=note)


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
    # Resolve the changes-base server-side so the model never has to choose
    # between two candidate lists (Haiku drifts to the fuller previous
    # lineup when the on-screen selection is partial).
    base_names = req.current_selection or req.previous_lineup
    base_block = (
        "\n".join(f"- {n}" for n in base_names)
        if base_names
        else "(empty — the coach is building a line from scratch)"
    )

    return f"""You are extracting an ultimate frisbee lineup — the set of players about to take the field — from a coach's spoken words.

Team roster. These are the ONLY valid players. Match spoken references against the name, the "nickname" in quotes, and the #jersey-number:
{roster_block}

Expected lineup size: {req.expected_count} players.

Previous lineup (who played the last point — this is what "same line" / "run it back" refers to):
{prev_block}

BASE — the current on-screen selection that bare additions and substitutions modify (your "players" output replaces this selection):
{base_block}

Transcript of what the coach said (speech-to-text; may contain transcription errors and unrelated chatter):
---
{req.transcript}
---

Determine the FINAL lineup the coach wants, and reply with JSON only.

How to interpret the transcript:
1. Naming players puts them on the line: "Cyrus, Max, Everett" means those players are in.
2. The coach may speak in CHANGES relative to the previous lineup / current selection instead of naming everyone:
   - "X goes in for Y", "X replaces Y", "X for Y" — X is in, Y is out, everyone else stays.
   - "same line", "run it back", "same as last point" — the previous lineup, unchanged.
   - "X is coming off", "X off", "X sits", "X takes a break" — X is out.
   - "X is on", "X's in", "add X" — X is in.
   When the coach speaks in changes, start from the BASE above and apply the changes ("same line" / "run it back" swaps the BASE to the previous lineup first).
   Coaches often build a line a few players at a time, thinking between utterances. Bare names with no in/out language ("Cyrus", "umm, Priya... and Dana") are ADDITIONS to the current selection (the BASE) — everyone already selected stays. Treat the utterance as a fresh from-scratch line (exactly the players named, replacing the selection) ONLY when the coach names a full line's worth of players (the expected size or more) or explicitly frames it as the whole line ("new line:", "the line is...").
3. Later statements override earlier ones. "...and is that Leif? No, I think it's Everett" is the coach correcting an identification: Everett is the player going in, Leif is not (unless Leif was already on the BASE and the coach says nothing about removing him). Naming a player and later saying they're coming off means they are OUT.
4. Ignore asides that aren't about lineup membership: commentary about the last point, scores, fatigue, weather, sideline chatter. "Cyrus is coming off, yeah that was a long point" — only the first clause matters.
5. "X completes the lineup", "that's the seven", "and that's the line" mean the coach believes the lineup is now fully specified.
6. Spoken references may be first names, full names, nicknames, jersey numbers ("number 12", "twelve", "#12"), or mispronounced/mistranscribed versions of a name — map each to the closest roster player. A trailing initial or fragment after a name ("Everett H", "Everett HB") usually disambiguates between similarly-named players; match it to the roster player whose name best fits.
7. In the "players" output, use each player's name spelled EXACTLY as it appears at the start of its roster line — do not append the "nickname" or the #jersey-number decorations. Some roster names contain digits or symbols as part of the name itself ("Jamal 23", "23 Jamal", "Jamal #23"): spoken "Jamal" or "Jamal twenty-three" refers to that player, and you must output the name byte-for-byte as the roster spells it, digits included — never a cleaned-up version. Never output anyone not on the roster; if a spoken reference cannot be matched to any roster player, put the spoken text in "unmatched" instead.
8. Do not pad the lineup with unmentioned players to reach the expected size, and do not drop named players to fit it. If only four players are specified for a seven-player line, output four — NEVER pull extra players from the previous lineup, the bench, or the roster to fill the gap. The expected size is context for interpreting the coach (e.g. whether the line sounds complete) — the coach's words always win. If the final count differs from the expected size, or something else was ambiguous, say so briefly in "note".

Reply with ONLY a JSON object of this exact shape (no prose, no markdown fences):
{{"changes": [{{"out": "Name or null", "in": "Name or null"}}], "players": ["Name", ...], "unmatched": ["spoken reference", ...], "note": ""}}

Fill "changes" FIRST — it is your worksheet:
- If the coach spoke in changes, list every change you heard: {{"out": "Nate", "in": "Cyrus"}} for "Cyrus in for Nate"; {{"out": "Max", "in": null}} for "Max is coming off" with no named replacement; {{"out": null, "in": "Henry"}} for "Henry's on".
- Bare added names are in-only changes too: a partial utterance like "Cyrus and Priya" is {{"out": null, "in": "Cyrus"}}, {{"out": null, "in": "Priya"}} — never a fresh line.
- If the coach corrects a change ("Priya in for Alice — actually no, Priya's in for Nate, Alice stays"), record ONLY the corrected version: {{"out": "Nate", "in": "Priya"}}. The retracted change never happened — Alice must NOT appear in "changes" and stays on the line. Never list both the first version and its correction.
- If the coach recited a fresh line instead, leave "changes" as an empty list.
- Then compute "players": when "changes" is non-empty, it MUST be exactly the BASE with those changes applied — every "out" player removed, every "in" player added, and NOBODY else added or removed. The BASE stays the BASE even when it is smaller than the expected size: NEVER import players from the previous lineup or the roster to fill out the count. A 3-player BASE plus one addition is 4 players, full stop.
- Count check before replying: if "players" has fewer than the expected size, reply with the smaller list AS IS — the coach will add more players in a later utterance. Adding anyone the coach never mentioned is the worst possible error. Also double-check each "out" player is absent from "players" — and that every player whose removal the coach RETRACTED ("actually no, ... Alice stays") is still present.
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
    """Parse the model's reply, tolerating fences, prose, and self-corrections."""
    parsed = _last_json_object(text, "players")
    if not isinstance(parsed.get("players"), list):
        raise RuntimeError("Claude lineup response missing 'players' list")
    return parsed
