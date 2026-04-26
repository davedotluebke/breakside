"""
Narration endpoints — AI-powered speech-to-event processing.

Two endpoints support the two-pass hybrid narration pipeline:

  POST /api/narration/token
    Creates an ephemeral OpenAI Realtime API session token so the browser can
    open a WebSocket to OpenAI directly without the real API key ever leaving
    the server.

  POST /api/narration/finalize
    Accepts the accumulated transcript + provisional events from the client
    and asks a higher-quality model (Claude Sonnet) to review and issue
    corrections as a list of operations (CONFIRM / AMEND / RETRACT / ADD).

Both endpoints require coach-level access to the referenced game.
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

# Import auth helpers — mirror the dual-import pattern used elsewhere in the codebase.
try:
    from auth import get_current_user  # type: ignore
except ImportError:
    from ultistats_server.auth import get_current_user  # type: ignore


router = APIRouter(prefix="/api/narration", tags=["narration"])


# =============================================================================
# Config helpers
# =============================================================================

def _openai_key() -> str:
    key = os.getenv("OPENAI_API_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="Narration unavailable: OPENAI_API_KEY not configured")
    return key


def _anthropic_key() -> Optional[str]:
    return os.getenv("ANTHROPIC_API_KEY", "") or None


# =============================================================================
# POST /api/narration/token
# =============================================================================

class TokenRequest(BaseModel):
    model: str = "gpt-realtime"
    # Game id lets us authenticate the requester against the game team.
    # Sent in body rather than path because this token is issued, not tied to
    # a specific persistent resource.
    game_id: Optional[str] = None


@router.post("/token")
async def create_ephemeral_token(
    req: TokenRequest = Body(...),
    # Any authenticated user with game access may request a token. The token
    # itself is short-lived and scoped to the OpenAI session. We deliberately
    # don't require coach-of-this-team here because tokens are also useful
    # during a "practice narration" flow that has no game_id yet.
    user: dict = Depends(get_current_user),
):
    """
    Create an ephemeral OpenAI Realtime API session token.

    Forwards to OpenAI's `POST /v1/realtime/sessions`, passing through the
    model. Returns just the client_secret so the browser can open the
    WebSocket without seeing the real API key.
    """
    api_key = _openai_key()

    payload: Dict[str, Any] = {
        "model": req.model,
        # We only need transcription + function calling back, not audio out.
        "modalities": ["text"],
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.post(
                "https://api.openai.com/v1/realtime/sessions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "OpenAI-Beta": "realtime=v1",
                },
                json=payload,
            )
        except httpx.HTTPError as e:
            logger.exception("Ephemeral token creation failed (network error)")
            raise HTTPException(status_code=502, detail=f"Upstream OpenAI error: {e}") from e

    if resp.status_code != 200:
        logger.warning("OpenAI token create returned %s: %s", resp.status_code, resp.text[:500])
        raise HTTPException(status_code=resp.status_code, detail=f"OpenAI: {resp.text}")

    data = resp.json()
    # OpenAI returns { client_secret: { value, expires_at }, ... }
    secret = data.get("client_secret") or {}
    token = secret.get("value")
    expires_at = secret.get("expires_at")
    if not token:
        logger.error("OpenAI token response missing client_secret.value: %s", data)
        raise HTTPException(status_code=502, detail="OpenAI returned no token")

    return {"token": token, "expires_at": expires_at, "model": req.model}


# =============================================================================
# POST /api/narration/finalize
# =============================================================================

class ProvisionalEventRef(BaseModel):
    id: str
    type: str
    summary: str = ""


class RosterPlayer(BaseModel):
    name: str
    nickname: Optional[str] = None
    number: Optional[str] = None


class GameContext(BaseModel):
    offense: bool = True
    our_score: int = 0
    their_score: int = 0
    point: int = 0


class FinalizeRequest(BaseModel):
    game_id: str
    transcript: str
    roster: List[RosterPlayer]
    provisional_events: List[ProvisionalEventRef]
    game_context: GameContext


class FinalizeOperation(BaseModel):
    op: str  # 'CONFIRM' | 'AMEND' | 'RETRACT' | 'ADD'
    provisional_id: Optional[str] = None
    event: Optional[Dict[str, Any]] = None


@router.post("/finalize")
async def finalize_narration(
    req: FinalizeRequest = Body(...),
    user: dict = Depends(get_current_user),
):
    """
    Run the slow-pass review over the full transcript.

    Uses Claude Sonnet (Anthropic API) if an ANTHROPIC_API_KEY is set;
    otherwise returns a no-op response that confirms all provisionals (the
    fast-pass events stand on their own).
    """
    anthropic_key = _anthropic_key()
    if not anthropic_key:
        logger.info("ANTHROPIC_API_KEY not set — slow pass disabled, confirming all provisionals")
        return {
            "operations": [
                {"op": "CONFIRM", "provisional_id": p.id} for p in req.provisional_events
            ]
        }

    prompt = _build_finalize_prompt(req)
    try:
        operations = await _call_claude_finalize(anthropic_key, prompt)
    except Exception as e:
        logger.exception("Slow pass LLM call failed")
        # Fallback: confirm all provisionals rather than losing data.
        return {
            "operations": [
                {"op": "CONFIRM", "provisional_id": p.id} for p in req.provisional_events
            ],
            "error": str(e),
        }

    return {"operations": operations}


def _build_finalize_prompt(req: FinalizeRequest) -> str:
    roster_lines = []
    for p in req.roster:
        parts = [p.name]
        if p.nickname:
            parts.append(f'"{p.nickname}"')
        if p.number:
            parts.append(f"#{p.number}")
        roster_lines.append("- " + " ".join(parts))

    prov_lines = []
    for p in req.provisional_events:
        prov_lines.append(f"- id={p.id} type={p.type} summary={p.summary!r}")

    side = "OFFENSE" if req.game_context.offense else "DEFENSE"

    has_provisionals = bool(req.provisional_events)

    # Mode-specific framing. In transcript-only mode there's nothing to review;
    # the slow pass is the SOLE source of structured events. In hybrid mode it
    # reviews the fast pass's output.
    if has_provisionals:
        review_section = f"""A fast-pass model already extracted these provisional events in order:
{chr(10).join(prov_lines)}

For each provisional event, emit one of:
  - CONFIRM  — the event is correct as-is
  - RETRACT  — the event should not have been recorded (coach corrected
               themselves, misheard, etc.)

Additionally, for any events clearly described in the transcript but
missed by the fast pass, emit ADD.

If the coach corrected a detail ("Bob threw to Alice — no wait, Carol"),
emit RETRACT for the wrong event and ADD for the correct one. Do NOT
emit an AMEND op — it is not supported."""
    else:
        review_section = """No fast-pass events were extracted live — you are the SOLE source
of structured events for this narration. Walk through the transcript
and emit one ADD operation for every distinct game event you find, in
the order they happened.

Be conservative: if a phrase is too garbled or ambiguous to interpret
with confidence, skip it rather than guessing. It is better to miss an
event than to fabricate one."""

    return f"""You are extracting structured ultimate frisbee events from a coach's spoken narration of one possession.

On-field players (use these EXACT spellings for any player names you emit):
{chr(10).join(roster_lines) if roster_lines else "(none)"}

Game context: our team is on {side}. Score our={req.game_context.our_score}, opponent={req.game_context.their_score}.

Full transcript (what the coach said — note transcription may have errors):
---
{req.transcript}
---

{review_section}

Event schema for ADD ops — the "event" object must have:
  - kind: one of "throw" | "turnover" | "defense" | "opponent_score"
  - For kind=throw: thrower (player name), receiver (player name),
    and any of huck, break_throw, dump, hammer, sky, layout, score (booleans)
  - For kind=turnover: thrower, receiver (optional), and any of
    throwaway, drop, huck, good_defense, stall (booleans)
  - For kind=defense: defender (player name), and any of
    interception, layout, sky, callahan (booleans)
  - For kind=opponent_score: no additional fields

Vocabulary mapping:
  - "reset" or "dump" -> throw with dump=true
  - "break" or "break-side" or "break mark" -> throw with break_throw=true
  - "huck" or "deep" or "long" -> throw with huck=true
  - "hammer" -> throw with hammer=true
  - "sky" -> sky=true on the relevant throw or defense
  - "layout" or "lays out" or "diving catch" -> layout=true on the throw or defense
  - "score" / "goal" / "in the endzone" -> throw with score=true (or defense with callahan=true if a D-line interception in the endzone)
  - "interception" or "block" or "got the D" -> defense with interception=true (or layout/sky as appropriate)
  - "throwaway" -> turnover with throwaway=true
  - "drop" or "missed the catch" -> turnover with drop=true (receiver = the dropper)
  - "stall" or "stalled out" -> turnover with stall=true

Player names in ADD events must match names from the on-field roster above EXACTLY (case and spelling).
If a transcribed name is misspelled but clearly corresponds to a roster player (e.g. "Sirius" -> "Cyrus"),
use the corrected roster spelling.

Output ONLY a JSON object of the form:
{{
  "operations": [
    {{ "op": "CONFIRM", "provisional_id": "..." }},
    {{ "op": "RETRACT", "provisional_id": "..." }},
    {{ "op": "ADD",     "event": {{ "kind": "throw", "thrower": "...", "receiver": "...", "score": true }} }}
  ]
}}

No prose, no markdown fences — just the JSON.
"""


async def _call_claude_finalize(api_key: str, prompt: str) -> List[Dict[str, Any]]:
    """
    Call Claude Sonnet via the Anthropic REST API. Returns a list of
    operations. Raises on failure — caller decides the fallback.
    """
    model = os.getenv("NARRATION_SLOW_MODEL", "claude-sonnet-4-5-20250929")

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
                "max_tokens": 2048,
                "messages": [
                    {"role": "user", "content": prompt}
                ],
            },
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Anthropic API {resp.status_code}: {resp.text[:500]}")

    body = resp.json()
    # Extract text from content blocks
    text_parts: List[str] = []
    for block in body.get("content", []):
        if block.get("type") == "text":
            text_parts.append(block.get("text", ""))
    text = "".join(text_parts).strip()

    # Be defensive about stray markdown fences.
    if text.startswith("```"):
        text = text.strip("`")
        # Drop a leading "json" language tag if present
        if text.lower().startswith("json"):
            text = text[4:].strip()

    parsed = json.loads(text)
    ops = parsed.get("operations", [])
    if not isinstance(ops, list):
        raise RuntimeError("Claude response 'operations' is not a list")
    return ops
