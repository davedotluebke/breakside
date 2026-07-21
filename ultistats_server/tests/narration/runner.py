"""
Audio-driven narration test runner.

Drives the full narration pipeline server-to-server (no browser needed):

  1. Reads a scenario directory: roster.json, transcript.txt, expected.json,
     and an audio file (.wav or .pcm at 24kHz mono PCM16).
  2. Opens a WebSocket to the OpenAI Realtime API as a transcription-only
     session (mirrors what realtimeSession.js does in the browser).
  3. Streams the audio chunks, accumulates the transcript from the
     conversation.item.input_audio_transcription events.
  4. Calls our local /api/narration/finalize endpoint with the actual
     transcript to get the slow-pass operations.
  5. Scores transcript word error rate and event-set precision / recall
     against the scenario's expected outputs.

Designed to be runnable two ways:
  - As a CLI:  python -m ultistats_server.tests.narration.runner SCENARIO_DIR
  - From pytest via test_scenarios.py

Environment:
  OPENAI_API_KEY      required — used directly (no ephemeral token in tests)
  ANTHROPIC_API_KEY   required — for the slow pass to actually emit events

Cost note: each scenario hits the Realtime API for the duration of the
audio (≈ $0.003/min transcription-only; ≈ $0.03-0.06/min for the
conversation-mode fast pass) plus one Claude call (≈ $0.01-0.03). A typical
small scenario is well under $0.10 either way.
"""
from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import os
import sys
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

# Optional dep — only the runner uses soundfile, and only when FLAC scenarios
# are present. Imported lazily so the rest of the test infrastructure works
# even on machines without it (e.g. for syntax checks / discovery).
try:
    import soundfile as sf  # type: ignore
    _HAS_SOUNDFILE = True
except ImportError:
    sf = None  # type: ignore
    _HAS_SOUNDFILE = False

try:
    import websockets  # type: ignore
except ImportError:
    websockets = None  # checked at runtime; pytest skips if unavailable


# =============================================================================
# Scenario file loading
# =============================================================================

@dataclass
class Scenario:
    """One test case loaded from disk."""
    name: str
    audio_path: Path
    sample_rate: int
    expected_transcript: str
    expected_events: List[Dict[str, Any]]
    roster: List[Dict[str, Any]]
    game_context: Dict[str, Any]

    @classmethod
    def load(cls, scenario_dir: Path) -> "Scenario":
        # Locate audio file. FLAC is the canonical committed format; .wav and
        # legacy .pcm are accepted as fallbacks.
        audio_path: Optional[Path] = None
        sample_rate = 24000
        for candidate in ("audio.flac", "audio.wav", "audio.pcm"):
            p = scenario_dir / candidate
            if p.exists():
                audio_path = p
                break
        if audio_path is None:
            raise FileNotFoundError(
                f"Scenario {scenario_dir.name!r} missing audio.flac, audio.wav, or audio.pcm"
            )
        if audio_path.suffix == ".wav":
            with wave.open(str(audio_path), "rb") as w:
                sample_rate = w.getframerate()
                if w.getnchannels() != 1:
                    raise ValueError(f"{audio_path}: expected mono audio")
                if w.getsampwidth() != 2:
                    raise ValueError(f"{audio_path}: expected 16-bit PCM")
        elif audio_path.suffix == ".flac":
            if not _HAS_SOUNDFILE:
                raise RuntimeError(
                    "Scenario uses FLAC audio but the 'soundfile' package is "
                    "not installed. Run: pip install soundfile"
                )
            info = sf.info(str(audio_path))
            sample_rate = info.samplerate
            if info.channels != 1:
                raise ValueError(f"{audio_path}: expected mono audio")

        transcript_path = scenario_dir / "transcript.txt"
        expected_path = scenario_dir / "expected.json"
        roster_path = scenario_dir / "roster.json"

        expected_transcript = transcript_path.read_text().strip()
        expected_events = json.loads(expected_path.read_text())
        roster_data = json.loads(roster_path.read_text())

        roster = roster_data.get("roster", roster_data) if isinstance(roster_data, dict) else roster_data
        game_context = (
            roster_data.get("game_context", _default_game_context())
            if isinstance(roster_data, dict)
            else _default_game_context()
        )

        return cls(
            name=scenario_dir.name,
            audio_path=audio_path,
            sample_rate=sample_rate,
            expected_transcript=expected_transcript,
            expected_events=expected_events,
            roster=roster,
            game_context=game_context,
        )


def _default_game_context() -> Dict[str, Any]:
    return {"offense": True, "our_score": 0, "their_score": 0, "point": 1}


# =============================================================================
# Audio helpers
# =============================================================================

def _decode_audio_to_pcm16(audio_path: Path) -> Tuple[bytes, int]:
    """Decode a scenario audio file (FLAC, WAV, or raw PCM) into raw PCM16
    little-endian mono bytes + the sample rate. Used by both chunked
    streaming and any in-memory audio inspection."""
    if audio_path.suffix == ".wav":
        with wave.open(str(audio_path), "rb") as w:
            return w.readframes(w.getnframes()), w.getframerate()
    if audio_path.suffix == ".flac":
        if not _HAS_SOUNDFILE:
            raise RuntimeError("FLAC audio requires the 'soundfile' package")
        # int16 dtype gives us PCM16 directly; tobytes() is little-endian
        # on x86/arm which matches what OpenAI Realtime expects.
        samples, sr = sf.read(str(audio_path), dtype="int16")
        if samples.ndim > 1:
            raise ValueError(f"{audio_path}: expected mono audio")
        return samples.tobytes(), int(sr)
    # raw .pcm — assume 24kHz mono 16-bit (legacy / hand-prepared)
    return audio_path.read_bytes(), 24000


def _read_pcm16_chunks(audio_path: Path, chunk_ms: int = 100, sample_rate: int = 24000):
    """Yield (base64_payload, real_time_seconds_consumed) for each chunk."""
    raw, sample_rate = _decode_audio_to_pcm16(audio_path)
    bytes_per_sample = 2
    samples_per_chunk = int(sample_rate * chunk_ms / 1000)
    bytes_per_chunk = samples_per_chunk * bytes_per_sample

    for offset in range(0, len(raw), bytes_per_chunk):
        chunk = raw[offset : offset + bytes_per_chunk]
        if not chunk:
            break
        yield base64.b64encode(chunk).decode("ascii"), len(chunk) / (
            sample_rate * bytes_per_sample
        )


# =============================================================================
# OpenAI Realtime transcription session (server-to-server)
# =============================================================================

# GA Realtime transcription endpoint. The model is NOT in the URL for
# transcription sessions — it's set via session.update (transcription.model).
# The old `?model=` + `OpenAI-Beta: realtime=v1` beta shape was disabled by
# OpenAI (close code 4000 beta_api_shape_disabled); this mirrors the GA shape
# that production uses in narration/realtimeSession.js.
REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription"


async def stream_audio_for_transcription(
    audio_path: Path,
    sample_rate: int = 24000,
    transcription_model: str = "gpt-4o-mini-transcribe",
    timeout_s: float = 60.0,
) -> str:
    """
    Stream a PCM16 audio file to the Realtime API and return the accumulated
    transcript. Uses a GA transcription-only session (no tools, no model
    output) — matches the production fast-pass mode in realtimeSession.js.
    """
    if websockets is None:
        raise RuntimeError(
            "The 'websockets' Python package is required for the test runner. "
            "Install it: pip install websockets"
        )
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY env var not set")

    # Server-to-server auth: a standard API key in the Authorization header.
    # The GA endpoint no longer wants (and now rejects) the OpenAI-Beta header.
    # The browser uses an ephemeral token via subprotocol because it can't set
    # headers; server-side we just send the key directly.
    headers = [("Authorization", f"Bearer {api_key}")]

    transcript_parts: List[str] = []
    # Transcription-only GA sessions never emit response.done — the
    # input_audio_transcription.completed that follows our manual
    # input_audio_buffer.commit IS the end-of-turn signal.
    transcription_completed = asyncio.Event()
    session_error: Dict[str, Any] = {}

    # websockets API note: the legacy `websockets.connect` (v10.x and the
    # legacy compat shim in v12+) uses `extra_headers=`; the new modern
    # asyncio API in v12+ would use `additional_headers=`. We use the
    # legacy name because it's accepted by both major versions.
    async with websockets.connect(
        REALTIME_TRANSCRIPTION_URL, extra_headers=headers, max_size=2**24
    ) as ws:  # type: ignore[attr-defined]
        # Configure the GA transcription session: nested under audio.input.*
        # with session.type=transcription. No tools, no instructions, no
        # response model — pure ASR. Mirrors realtimeSession.js.
        await ws.send(
            json.dumps(
                {
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": {
                            "input": {
                                # GA wants an object here, not a bare string.
                                "format": {"type": "audio/pcm", "rate": sample_rate},
                                "transcription": {"model": transcription_model},
                                "turn_detection": {
                                    "type": "server_vad",
                                    "threshold": 0.5,
                                    "prefix_padding_ms": 300,
                                    "silence_duration_ms": 500,
                                },
                            }
                        },
                    },
                }
            )
        )

        async def reader():
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("type", "")
                if t == "conversation.item.input_audio_transcription.delta":
                    if msg.get("delta"):
                        transcript_parts.append(msg["delta"])
                elif t == "conversation.item.input_audio_transcription.completed":
                    text = msg.get("transcript", "") or ""
                    # Some servers emit only completed (no deltas); ensure we
                    # have *something* in that case.
                    if text and not "".join(transcript_parts).strip():
                        transcript_parts.append(text)
                    transcription_completed.set()
                elif t == "error":
                    session_error["error"] = msg.get("error")
                    raise RuntimeError(f"Realtime error: {msg.get('error')}")

        async def writer():
            # Stream audio chunks at roughly real-time pacing. Slightly faster
            # than wall-clock is fine; OpenAI's server buffers and applies VAD.
            for payload_b64, dur in _read_pcm16_chunks(
                audio_path, chunk_ms=100, sample_rate=sample_rate
            ):
                await ws.send(
                    json.dumps({"type": "input_audio_buffer.append", "audio": payload_b64})
                )
                # A bit faster than real-time so tests aren't unnecessarily slow.
                await asyncio.sleep(dur * 0.5)

            # Append ~800ms of trailing silence so server_vad sees the gap and
            # closes the turn (speech_stopped -> auto-commit -> transcription).
            # A manual input_audio_buffer.commit is wrong here: VAD has usually
            # already drained the buffer, so commit errors on an empty buffer.
            silence_chunk = base64.b64encode(
                b"\x00\x00" * int(sample_rate * 0.1)
            ).decode("ascii")
            for _ in range(8):
                await ws.send(
                    json.dumps({"type": "input_audio_buffer.append", "audio": silence_chunk})
                )
                await asyncio.sleep(0.05)

        reader_task = asyncio.create_task(reader())
        writer_task = asyncio.create_task(writer())

        try:
            await asyncio.wait_for(writer_task, timeout=timeout_s)
            # After audio is committed, wait for the ASR result. The completed
            # event can lag the audio for short clips, so give it a window.
            try:
                await asyncio.wait_for(transcription_completed.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                pass  # take whatever transcript we have
        finally:
            reader_task.cancel()
            try:
                await reader_task
            except (asyncio.CancelledError, Exception):
                pass

    return "".join(transcript_parts).strip()


# =============================================================================
# OpenAI Realtime conversation session — fast-pass event extraction
# =============================================================================

# Conversation-mode GA endpoint: the model IS in the URL here (unlike
# transcription sessions, where it goes in session.update). Mirrors the
# mode='conversation' path in narration/realtimeSession.js.
REALTIME_CONVERSATION_URL = "wss://api.openai.com/v1/realtime?model={model}"

_CONFIDENCE_PROP = {
    "type": "string",
    "enum": ["low", "medium", "high"],
    "description": (
        "How clearly and completely the coach stated this. Use 'high' only "
        "when the utterance was clear and complete."
    ),
}

_FASTPASS_KINDS = ("throw", "turnover", "defense", "opponent_score")

_FN_TO_KIND = {
    "record_throw": "throw",
    "record_turnover": "turnover",
    "record_defense": "defense",
    "record_opponent_score": "opponent_score",
}


def build_fastpass_tools(strict: bool = False) -> List[Dict[str, Any]]:
    """
    Tool definitions for the conversation-mode fast pass.

    Descended from the original fast-pass implementation (buildTools in
    pre-ff79ef1 narration/narrationEngine.js), updated for the current event
    schema (dump -> reset, added swing), a required `confidence` field on
    every call, and a retract_event tool for spoken corrections that arrive
    after the wrong event was already emitted. The event dicts these calls
    map to (see _fastpass_call_to_event) match the ADD-operation event shape
    in ultistats_server/narration.py.

    With strict=True the schemas are reshaped to OpenAI structured-output
    strict form: additionalProperties=false, every property required,
    optional fields made nullable, and a top-level "strict": true flag.
    Whether GA realtime sessions honor `strict` is itself a question this
    harness answers — stream_audio_for_events() falls back to non-strict if
    the session.update is rejected, and records which way it went.
    """
    def tool(name: str, description: str, props: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
        props = {**props, "confidence": _CONFIDENCE_PROP}
        required = list(required) + ["confidence"]
        if strict:
            strict_props = {}
            for key, spec in props.items():
                spec = dict(spec)
                if key not in required and isinstance(spec.get("type"), str):
                    spec["type"] = [spec["type"], "null"]
                strict_props[key] = spec
            parameters: Dict[str, Any] = {
                "type": "object",
                "properties": strict_props,
                "required": list(strict_props.keys()),
                "additionalProperties": False,
            }
        else:
            parameters = {
                "type": "object",
                "properties": props,
                "required": required,
                "additionalProperties": False,
            }
        out: Dict[str, Any] = {
            "type": "function",
            "name": name,
            "description": description,
            "parameters": parameters,
        }
        if strict:
            out["strict"] = True
        return out

    return [
        tool(
            "record_throw",
            "A completed pass from one player to another. Use for any successful throw + catch.",
            {
                "thrower": {"type": "string", "description": "Roster name of the player who threw the disc"},
                "receiver": {"type": "string", "description": "Roster name of the player who caught it"},
                "huck": {"type": "boolean", "description": "A long deep shot — only when clearly described ('hucks it', 'puts it deep')"},
                "break_throw": {"type": "boolean", "description": "A break-side throw — only when the coach explicitly says 'break'"},
                "reset": {"type": "boolean", "description": "A short backward pass to a handler — the coach says 'reset' or 'dump'"},
                "swing": {"type": "boolean", "description": "A lateral cross-field pass — the coach says 'swing'"},
                "hammer": {"type": "boolean", "description": "An overhead hammer throw"},
                "sky": {"type": "boolean", "description": "Receiver skied/jumped over a defender"},
                "layout": {"type": "boolean", "description": "Receiver laid out (dove) for the catch"},
                "score": {"type": "boolean", "description": "This throw scored a goal"},
            },
            ["thrower", "receiver"],
        ),
        tool(
            "record_turnover",
            "We lost possession: throwaway, drop, or stall. Attribute to the responsible player.",
            {
                "thrower": {"type": "string", "description": "Thrower on the turnover (set unless a pure drop with unknown thrower)"},
                "receiver": {"type": "string", "description": "Intended receiver, if named (e.g. who dropped it)"},
                "throwaway": {"type": "boolean", "description": "The throw itself was errant (behind/over/past the target, out of bounds). Mutually exclusive with drop."},
                "drop": {"type": "boolean", "description": "The throw was catchable and the receiver failed to hold it. Mutually exclusive with throwaway."},
                "huck": {"type": "boolean", "description": "Happened on a huck"},
                "good_defense": {"type": "boolean", "description": "Caused by strong defensive pressure"},
                "stall": {"type": "boolean", "description": "Thrower got stalled out"},
            },
            [],
        ),
        tool(
            "record_defense",
            "A defensive play by OUR player that takes the disc away (block, interception, layout D, Callahan).",
            {
                "defender": {"type": "string", "description": "Roster name of the defender making the play"},
                "block": {"type": "boolean", "description": "Disc deflected (footblock, knockdown) — defender did not catch it. Mutually exclusive with interception."},
                "interception": {"type": "boolean", "description": "Defender caught the throw out of the air"},
                "layout": {"type": "boolean", "description": "Defender laid out for the play"},
                "sky": {"type": "boolean", "description": "Defender skied for the play"},
                "callahan": {"type": "boolean", "description": "Defender caught the opponent's throw in their endzone for an instant goal for US"},
            },
            ["defender"],
        ),
        tool(
            "record_opponent_score",
            "The opposing team scored (they completed a goal against us).",
            {},
            [],
        ),
        tool(
            "retract_event",
            "Remove an event you already recorded that turned out to be wrong — "
            "use when the coach corrects themselves AFTER you emitted the event. "
            "Retracts the most recent matching event; follow with the corrected "
            "record_* call if the coach supplied a corrected version.",
            {
                "kind": {"type": "string", "enum": list(_FASTPASS_KINDS), "description": "Kind of the event being retracted"},
                "player": {"type": "string", "description": "A player named in the event being retracted (helps pick the right one)"},
                "reason": {"type": "string", "description": "Very short reason, e.g. 'coach corrected receiver'"},
            },
            ["kind"],
        ),
    ]


def build_fastpass_instructions(
    roster: List[Dict[str, Any]], game_context: Dict[str, Any]
) -> str:
    """
    Session instructions for the fast pass. Unlike the original 2025 prompt
    ("better to emit a best-guess event than nothing"), the default here is
    to emit NOTHING unless the narration is clear — the slow-pass reviewer
    covers omissions, but confabulated events shown live to a coach are the
    failure mode that killed the original fast pass.
    """
    roster_lines = []
    for p in roster:
        parts = [str(p.get("name", ""))]
        if p.get("nickname"):
            parts.append(f'"{p["nickname"]}"')
        if p.get("number"):
            parts.append(f"#{p['number']}")
        roster_lines.append("- " + " ".join(parts))
    side = "OFFENSE" if game_context.get("offense", True) else "DEFENSE"

    return f"""You are extracting structured game events from a coach's LIVE spoken narration of an ultimate frisbee game, heard through an outdoor sideline microphone. The audio can be noisy: wind, crowd, and unrelated sideline chatter may be present, and not everything you hear is the coach narrating play.

On-field players (our team):
{chr(10).join(roster_lines)}

Current context: we are on {side}. Score: our team {game_context.get('our_score', 0)}, opponent {game_context.get('their_score', 0)}.

THE DEFAULT IS TO EMIT NOTHING. Only call a record_* function when a player action is clearly and completely stated by the coach. A reviewer pass runs over the full transcript afterward and will catch anything you omit — but false events it has to clean up are shown live to the coach first. When uncertain, emit nothing.

Never emit an event from:
- garbled, partial, or barely audible speech;
- crowd noise, cheering, or encouragement ("nice throw!", "let's go!");
- sideline conversation that is not play-by-play narration;
- a name alone with no clearly stated action.

Never guess player names: if you cannot confidently match a spoken name to the roster, emit nothing. When you do match, put ONLY the player's bare name in the call, with the exact roster spelling — e.g. "Alice", never "Alice #7" or a nickname. The nicknames and jersey numbers on the roster lines are hints for matching what the coach said (partial names, nicknames, and numbers all refer to players), not part of the name.

A single utterance often chains MULTIPLE events ("Alice to Bob, Bob hucks it to Carla for the score"). Emit a separate function call for each event, in the order they happened, before your response ends.

One completed pass = ONE record_throw call. A follow-on clause about the receiver's catch ("...to Ella, Ella skies her defender for the score") supplies modifiers (sky, layout, score) for that SAME throw — never a second event for the catch. Never emit a throw whose thrower and receiver are the same player.

Never record the same event twice. You may hear overlapping or repeated audio; before calling, make sure you have not already recorded that exact pass, turnover, or play earlier in this session.

Corrections: coaches correct themselves ("to Bob — no, wait, to Daniel"). If the correction arrives before you have recorded anything, record only the corrected version. If you already recorded the wrong event, call retract_event for it, then record the corrected event.

Set the required confidence field honestly on every call: "high" only when the utterance was clear and complete. If your honest confidence is "low", strongly prefer emitting nothing instead.

Never produce text: no acknowledgments, no announcing what you are about to log, no commentary — function calls only. If there is nothing to record, produce no output at all."""


@dataclass
class FastPassConfig:
    """Session configuration for stream_audio_for_events. The defaults are
    the research doc's recommended pilot config (docs/
    narration-realtime-events-research-2026-07.md § Recommended pilot)."""
    model: str = "gpt-realtime-2.1"
    noise_reduction: Optional[str] = "far_field"  # "near_field" | "far_field" | None (off)
    vad_eagerness: str = "low"  # semantic_vad eagerness: low | medium | high | auto
    try_strict: bool = True
    transcription_model: str = "gpt-4o-mini-transcribe"
    pace: float = 1.0  # per-chunk sleep multiplier; 1.0 = real-time, 0.5 = 2x speed
    # Send a function_call_output ack for each call once its response
    # completes. Production never did (fire-and-forget), which leaves every
    # call "pending" — OpenAI's own dev notes say pending tool calls make
    # the model hallucinate/stall, so this tests whether unacked calls cause
    # the observed text-instead-of-calls truncation and the dead retract
    # path. Acking after response.done avoids the mid-response
    # short-circuit the original client hit.
    ack_function_calls: bool = False


@dataclass
class FastPassOutcome:
    """Everything a conversation-mode session produced for one audio file."""
    calls: List[Dict[str, Any]] = field(default_factory=list)  # raw, in arrival order
    net_events: List[Dict[str, Any]] = field(default_factory=list)  # after retractions
    retractions: List[Dict[str, Any]] = field(default_factory=list)
    unmatched_retractions: int = 0
    transcript: str = ""  # parallel input-transcription pass (audit trail)
    # strict schema support answer: accepted | stripped | rejected |
    # accepted_unverified (update accepted but echo had no tools to check) |
    # not_attempted
    strict_mode: str = "not_attempted"
    unexpected_texts: List[str] = field(default_factory=list)
    errors: List[Dict[str, Any]] = field(default_factory=list)
    responses: int = 0  # response.done count
    acks_sent: int = 0  # function_call_output items sent (ack_function_calls mode)


def _fastpass_call_to_event(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Map a record_* function call to the narration.py ADD-event shape.
    Drops null (strict-mode padding) and False values; keeps confidence as
    an informational field (it is not an _EVENT_KEY_FIELDS member, so it
    never affects matching)."""
    ev: Dict[str, Any] = {"kind": _FN_TO_KIND[name]}
    for k, v in (args or {}).items():
        if v is None or v is False:
            continue
        ev[k] = v
    return ev


def resolve_player_name(spoken: Any, roster: List[Dict[str, Any]]) -> Optional[str]:
    """
    Fuzzy-match a spoken/emitted name to a roster player, returning the
    canonical roster name. Port of resolvePlayerName from the original
    fast-pass client (pre-ff79ef1 narration/narrationEngine.js) — the
    production path resolved model-emitted names this way before creating
    events, so the eval scores what the coach would actually have seen.

    Strategy (in order): exact name; exact nickname; case-insensitive
    name/nickname; startsWith on name/nickname; jersey number (any digits in
    the string); first-name match. Returns None if nothing matches.
    """
    if spoken is None:
        return None
    s = str(spoken).strip()
    if not s:
        return None
    low = s.lower()
    for p in roster:
        if p.get("name") == s:
            return p["name"]
    for p in roster:
        if p.get("nickname") and p["nickname"] == s:
            return p["name"]
    for p in roster:
        if str(p.get("name", "")).lower() == low:
            return p["name"]
        if p.get("nickname") and str(p["nickname"]).lower() == low:
            return p["name"]
    for p in roster:
        if str(p.get("name", "")).lower().startswith(low):
            return p["name"]
        if p.get("nickname") and str(p["nickname"]).lower().startswith(low):
            return p["name"]
    digits = "".join(ch for ch in s if ch.isdigit())
    if digits:
        for p in roster:
            if str(p.get("number") or "") == digits:
                return p["name"]
    for p in roster:
        name = str(p.get("name", ""))
        first = name.split()[0].lower() if name else ""
        if first and first == low:
            return p["name"]
    return None


_PLAYER_FIELDS = ("thrower", "receiver", "defender")


def resolve_event_players(
    events: List[Dict[str, Any]], roster: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Return copies of the events with player fields resolved to canonical
    roster names where possible. Unresolvable names are left as emitted, so
    a confabulated name still scores as a mismatch."""
    out = []
    for ev in events:
        ev = dict(ev)
        for f in _PLAYER_FIELDS:
            if f in ev:
                resolved = resolve_player_name(ev[f], roster)
                if resolved is not None:
                    ev[f] = resolved
        out.append(ev)
    return out


def filter_appliable_events(
    events: List[Dict[str, Any]], roster: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Mirror the original fast-pass client's appliers: applyThrow returned null
    (no event created) unless BOTH thrower and receiver resolved to roster
    players, applyDefense required the defender, applyTurnover substituted
    Unknown Player and kept the event. Run this AFTER resolve_event_players:
    an event whose required player fields still aren't roster names would
    never have reached the coach's screen. Returns (kept, dropped).
    """
    names = {str(p.get("name")) for p in roster}
    kept: List[Dict[str, Any]] = []
    dropped: List[Dict[str, Any]] = []
    for ev in events:
        kind = ev.get("kind")
        if kind == "throw":
            ok = ev.get("thrower") in names and ev.get("receiver") in names
        elif kind == "defense":
            ok = ev.get("defender") in names
        else:
            ok = True
        (kept if ok else dropped).append(ev)
    return kept, dropped


def _apply_fastpass_retractions(
    calls: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], int]:
    """
    Compute the net event list: record_* calls append; retract_event removes
    the most recent surviving event matching its kind (and player, if given —
    matched against thrower/receiver/defender). Scoring runs on the net list,
    so a wrong event the fast pass retracted itself costs nothing.
    """
    events: List[Dict[str, Any]] = []
    retractions: List[Dict[str, Any]] = []
    unmatched = 0
    for call in calls:
        name = call.get("name")
        args = call.get("args") or {}
        if name in _FN_TO_KIND:
            events.append(_fastpass_call_to_event(name, args))
        elif name == "retract_event":
            kind = args.get("kind")
            player = str(args.get("player") or "").strip().lower()
            target_idx = None
            for i in range(len(events) - 1, -1, -1):
                ev = events[i]
                if kind and ev.get("kind") != kind:
                    continue
                if player:
                    names = {str(ev.get(f, "")).lower() for f in ("thrower", "receiver", "defender")}
                    if player not in names:
                        continue
                target_idx = i
                break
            if target_idx is None:
                unmatched += 1
                retractions.append({"args": args, "retracted_event": None})
            else:
                retractions.append({"args": args, "retracted_event": events.pop(target_idx)})
    return events, retractions, unmatched


def _fastpass_session_payload(
    config: FastPassConfig,
    sample_rate: int,
    tools: List[Dict[str, Any]],
    instructions: str,
) -> Dict[str, Any]:
    input_cfg: Dict[str, Any] = {
        "format": {"type": "audio/pcm", "rate": sample_rate},
        # Parallel input transcription, as production would run it — lets the
        # eval log transcript-vs-events divergence.
        "transcription": {"model": config.transcription_model},
        "turn_detection": {"type": "semantic_vad", "eagerness": config.vad_eagerness},
    }
    if config.noise_reduction:
        input_cfg["noise_reduction"] = {"type": config.noise_reduction}
    return {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "output_modalities": ["text"],
            "instructions": instructions,
            "tools": tools,
            "tool_choice": "auto",
            "audio": {"input": input_cfg},
        },
    }


# Error messages that mean "the server already handled the commit/response
# we just sent" — same benign set realtimeSession.js filters.
_BENIGN_ERROR_SNIPPETS = ("buffer too small", "buffer_empty", "active response")


async def stream_audio_for_events(
    audio_path: Path,
    roster: List[Dict[str, Any]],
    game_context: Dict[str, Any],
    sample_rate: int = 24000,
    config: Optional[FastPassConfig] = None,
) -> FastPassOutcome:
    """
    Stream a PCM16 audio file through a conversation-mode Realtime session
    (tools + function calling) and collect the function calls the model
    emits — the "fast pass events" path abandoned in 2025, replayed offline.

    Sibling of stream_audio_for_transcription: same chunked streaming, but
    the session has a response model. Semantic VAD closes each utterance and
    the model responds with zero or more function calls; a parallel input
    transcription runs alongside. On finish we mirror realtimeSession.stop():
    commit + response.create to flush any pending turn, wait for the final
    response.done, then close.
    """
    if websockets is None:
        raise RuntimeError(
            "The 'websockets' Python package is required for the test runner. "
            "Install it: pip install websockets"
        )
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY env var not set")

    config = config or FastPassConfig()
    outcome = FastPassOutcome()
    instructions = build_fastpass_instructions(roster, game_context)
    url = REALTIME_CONVERSATION_URL.format(model=config.model)
    headers = [("Authorization", f"Bearer {api_key}")]

    handshake_done = asyncio.Event()
    handshake_error: List[Dict[str, Any]] = []
    session_echo: Dict[str, Any] = {}
    flush_response_done = asyncio.Event()
    flush_armed = False
    seen_call_ids: set = set()
    delta_parts: List[str] = []
    completed_utterances: List[str] = []
    last_activity = [0.0]

    def record_call(call_id: Optional[str], name: str, arguments_json: Optional[str]) -> None:
        if call_id and call_id in seen_call_ids:
            return
        if call_id:
            seen_call_ids.add(call_id)
        try:
            args = json.loads(arguments_json or "{}")
        except json.JSONDecodeError:
            outcome.errors.append(
                {"where": "parse_arguments", "name": name, "arguments": arguments_json}
            )
            args = {}
        # response_index: how many responses had completed when this call
        # arrived — i.e. which response it belongs to. Lets the retraction
        # analysis see whether a correction crossed a response boundary.
        outcome.calls.append(
            {"name": name, "args": args, "call_id": call_id, "response_index": outcome.responses}
        )

    async with websockets.connect(
        url, extra_headers=headers, max_size=2**24
    ) as ws:  # type: ignore[attr-defined]

        async def reader():
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("type", "")
                last_activity[0] = asyncio.get_running_loop().time()
                if t == "session.updated":
                    session_echo.clear()
                    session_echo.update(msg.get("session") or {})
                    handshake_done.set()
                elif t == "conversation.item.input_audio_transcription.delta":
                    if msg.get("delta"):
                        delta_parts.append(msg["delta"])
                elif t == "conversation.item.input_audio_transcription.completed":
                    if msg.get("transcript"):
                        completed_utterances.append(msg["transcript"])
                elif t == "response.function_call_arguments.done":
                    record_call(msg.get("call_id"), msg.get("name", ""), msg.get("arguments"))
                elif t == "response.done":
                    resp = msg.get("response") or {}
                    for item in resp.get("output") or []:
                        # Safety net: collect any call missed by the
                        # arguments.done path (deduped by call_id), and
                        # capture text the model was told not to produce.
                        if item.get("type") == "function_call":
                            record_call(item.get("call_id"), item.get("name", ""), item.get("arguments"))
                        elif item.get("type") == "message":
                            for part in item.get("content") or []:
                                if part.get("text"):
                                    outcome.unexpected_texts.append(part["text"])
                    outcome.responses += 1
                    if config.ack_function_calls:
                        # Resolve this response's calls so they aren't left
                        # pending in conversation state. Safe here: the
                        # response is complete, so this can't short-circuit
                        # streaming the way mid-response acks did.
                        for item in resp.get("output") or []:
                            if item.get("type") == "function_call" and item.get("call_id"):
                                await ws.send(
                                    json.dumps(
                                        {
                                            "type": "conversation.item.create",
                                            "item": {
                                                "type": "function_call_output",
                                                "call_id": item["call_id"],
                                                "output": json.dumps({"status": "recorded"}),
                                            },
                                        }
                                    )
                                )
                                outcome.acks_sent += 1
                    if flush_armed:
                        flush_response_done.set()
                elif t == "response.text.done":
                    if msg.get("text"):
                        outcome.unexpected_texts.append(msg["text"])
                elif t == "error":
                    err = msg.get("error") or {}
                    emsg = str(err.get("message", ""))
                    if (
                        any(s in emsg for s in _BENIGN_ERROR_SNIPPETS)
                        or err.get("code") == "conversation_already_has_active_response"
                    ):
                        continue
                    if not handshake_done.is_set():
                        handshake_error.append(err)
                        handshake_done.set()
                    else:
                        outcome.errors.append(err)

        reader_task = asyncio.create_task(reader())
        try:
            # --- session.update handshake, with strict fallback ------------
            tools = build_fastpass_tools(strict=config.try_strict)
            await ws.send(json.dumps(_fastpass_session_payload(config, sample_rate, tools, instructions)))
            await asyncio.wait_for(handshake_done.wait(), timeout=15.0)
            if handshake_error and config.try_strict:
                outcome.strict_mode = "rejected"
                outcome.errors.append({"where": "strict_session_update", **handshake_error[0]})
                handshake_error.clear()
                handshake_done.clear()
                tools = build_fastpass_tools(strict=False)
                await ws.send(json.dumps(_fastpass_session_payload(config, sample_rate, tools, instructions)))
                await asyncio.wait_for(handshake_done.wait(), timeout=15.0)
            if handshake_error:
                raise RuntimeError(f"Realtime session.update rejected: {handshake_error[0]}")
            if config.try_strict and outcome.strict_mode != "rejected":
                echoed = [t for t in (session_echo.get("tools") or []) if isinstance(t, dict)]
                if echoed and all(t.get("strict") for t in echoed):
                    outcome.strict_mode = "accepted"
                elif echoed:
                    outcome.strict_mode = "stripped"
                else:
                    outcome.strict_mode = "accepted_unverified"

            # --- stream audio at (roughly) real-time pace ------------------
            for payload_b64, dur in _read_pcm16_chunks(
                audio_path, chunk_ms=100, sample_rate=sample_rate
            ):
                await ws.send(
                    json.dumps({"type": "input_audio_buffer.append", "audio": payload_b64})
                )
                await asyncio.sleep(dur * config.pace)

            # ~2s trailing silence so semantic VAD sees the last utterance end.
            silence_chunk = base64.b64encode(
                b"\x00\x00" * int(sample_rate * 0.1)
            ).decode("ascii")
            for _ in range(20):
                await ws.send(
                    json.dumps({"type": "input_audio_buffer.append", "audio": silence_chunk})
                )
                await asyncio.sleep(0.1 * config.pace)

            # --- drain: let in-flight VAD turns / responses settle ---------
            now = asyncio.get_running_loop().time
            deadline = now() + 20.0
            while now() < deadline and (now() - last_activity[0]) < 2.5:
                await asyncio.sleep(0.25)

            # --- final flush, mirroring realtimeSession.stop(): force
            # end-of-turn + a response for any still-pending audio. The
            # errors these produce when VAD already handled it are benign
            # and filtered in the reader.
            flush_armed = True
            try:
                await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                await ws.send(json.dumps({"type": "response.create"}))
                await asyncio.wait_for(flush_response_done.wait(), timeout=12.0)
            except asyncio.TimeoutError:
                pass  # take what we have
        finally:
            reader_task.cancel()
            try:
                await reader_task
            except (asyncio.CancelledError, Exception):
                pass

    outcome.transcript = (
        " ".join(completed_utterances) if completed_utterances else "".join(delta_parts)
    ).strip()
    outcome.net_events, outcome.retractions, outcome.unmatched_retractions = (
        _apply_fastpass_retractions(outcome.calls)
    )
    return outcome


# =============================================================================
# Slow-pass call (uses our local FastAPI app via TestClient)
# =============================================================================

def call_finalize(
    transcript: str,
    roster: List[Dict[str, Any]],
    game_context: Dict[str, Any],
    game_id: str = "test-scenario",
) -> Dict[str, Any]:
    """
    Call /api/narration/finalize via fastapi.testclient.TestClient. We don't
    spin up a real HTTP server — we exercise the FastAPI app directly. This
    keeps tests fast and avoids a network hop.
    """
    # Late imports so module-load failures don't kill scenario discovery.
    from fastapi.testclient import TestClient
    # Ensure auth is disabled for tests by default.
    os.environ.setdefault("ULTISTATS_AUTH_REQUIRED", "false")
    # Local import — main.py does heavy import work, so do it once.
    if "ultistats_test_app" not in globals():
        from ultistats_server.main import app  # type: ignore
        globals()["ultistats_test_app"] = app
    app = globals()["ultistats_test_app"]

    client = TestClient(app)
    resp = client.post(
        "/api/narration/finalize",
        json={
            "game_id": game_id,
            "transcript": transcript,
            "roster": roster,
            "provisional_events": [],
            "game_context": game_context,
        },
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"finalize returned {resp.status_code}: {resp.text[:500]}"
        )
    return resp.json()


# =============================================================================
# Metrics
# =============================================================================

def word_error_rate(reference: str, hypothesis: str) -> float:
    """Standard WER via Levenshtein distance over word tokens. Returns a
    float in [0, ∞) — usually [0, 1] but can exceed 1 if hypothesis has many
    insertions."""
    ref = _normalize(reference).split()
    hyp = _normalize(hypothesis).split()
    if not ref:
        return 1.0 if hyp else 0.0
    # Classic DP edit-distance
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                d[i][j] = d[i - 1][j - 1]
            else:
                d[i][j] = 1 + min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1])
    return d[n][m] / n


def _normalize(s: str) -> str:
    """Lowercase + strip punctuation for fair WER comparison."""
    out = []
    for ch in s.lower():
        if ch.isalnum() or ch.isspace():
            out.append(ch)
        else:
            out.append(" ")
    return " ".join("".join(out).split())


@dataclass
class EventScore:
    matched: int = 0
    expected: int = 0
    actual: int = 0
    matches: List[Tuple[Dict[str, Any], Dict[str, Any]]] = field(default_factory=list)
    missing: List[Dict[str, Any]] = field(default_factory=list)
    extra: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def precision(self) -> float:
        return self.matched / self.actual if self.actual else 1.0

    @property
    def recall(self) -> float:
        return self.matched / self.expected if self.expected else 1.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) else 0.0


# Fields that count for "this event matches" (everything else is informational).
_EVENT_KEY_FIELDS = (
    "kind",
    "thrower",
    "receiver",
    "defender",
    "huck",
    "break_throw",
    "reset",
    "swing",
    # "dump" is retired (renamed to reset, 2026-07-19) but stays a key field:
    # if the model ever emits it despite the schema, it should surface as a
    # visible mismatch, not be silently dropped from the signature.
    "dump",
    "hammer",
    "sky",
    "layout",
    "score",
    "throwaway",
    "drop",
    "good_defense",
    "stall",
    "block",
    "interception",
    "callahan",
)


def _event_signature(ev: Dict[str, Any]) -> Dict[str, Any]:
    """
    Reduce an event dict to its key-field signature for matching.

    Drops boolean flags whose value is False or None — so an event with
    `dump=False` matches one that omits `dump` entirely. This makes
    fixtures less brittle: the slow-pass model is free to fully populate
    schema flags or omit them, as long as the truthy fields agree.
    """
    sig: Dict[str, Any] = {}
    for k in _EVENT_KEY_FIELDS:
        if k not in ev:
            continue
        v = ev[k]
        if v is False or v is None:
            continue
        sig[k] = v
    return sig


def score_events(
    expected_events: List[Dict[str, Any]],
    operations: List[Dict[str, Any]],
) -> EventScore:
    """Compare expected events to ADD operations from the slow pass."""
    actual_events = [op["event"] for op in operations if op.get("op") == "ADD" and "event" in op]
    return score_event_list(expected_events, actual_events)


def score_event_list(
    expected_events: List[Dict[str, Any]],
    actual_events: List[Dict[str, Any]],
) -> EventScore:
    """
    Compare expected events to a plain list of actual event dicts (slow-pass
    ADD events or fast-pass net events).

    Matching is greedy in expected-order: for each expected event we try to
    find the first unmatched actual event with the same kind + same key
    fields. This rewards order preservation.
    """
    score = EventScore(expected=len(expected_events), actual=len(actual_events))

    used = [False] * len(actual_events)
    for exp in expected_events:
        exp_sig = _event_signature(exp)
        for i, act in enumerate(actual_events):
            if used[i]:
                continue
            if _event_signature(act) == exp_sig:
                used[i] = True
                score.matched += 1
                score.matches.append((exp, act))
                break
        else:
            score.missing.append(exp)
    for i, act in enumerate(actual_events):
        if not used[i]:
            score.extra.append(act)
    return score


# =============================================================================
# Top-level scenario runner
# =============================================================================

@dataclass
class ScenarioResult:
    name: str
    expected_transcript: str
    actual_transcript: str
    wer: float
    expected_events: List[Dict[str, Any]]
    operations: List[Dict[str, Any]]
    event_score: EventScore

    def as_dict(self) -> Dict[str, Any]:
        d = dataclasses.asdict(self)
        d["precision"] = self.event_score.precision
        d["recall"] = self.event_score.recall
        d["f1"] = self.event_score.f1
        return d


async def run_scenario(scenario_dir: Path) -> ScenarioResult:
    s = Scenario.load(scenario_dir)
    actual_transcript = await stream_audio_for_transcription(
        s.audio_path, sample_rate=s.sample_rate
    )
    finalize_response = call_finalize(
        actual_transcript, s.roster, s.game_context, game_id=f"test-{s.name}"
    )
    operations = finalize_response.get("operations", [])
    score = score_events(s.expected_events, operations)
    return ScenarioResult(
        name=s.name,
        expected_transcript=s.expected_transcript,
        actual_transcript=actual_transcript,
        wer=word_error_rate(s.expected_transcript, actual_transcript),
        expected_events=s.expected_events,
        operations=operations,
        event_score=score,
    )


@dataclass
class FastPassScenarioResult:
    """One scenario run through the conversation-mode fast pass."""
    name: str
    config: FastPassConfig
    outcome: FastPassOutcome
    expected_transcript: str
    expected_events: List[Dict[str, Any]]
    # net_events after resolve_event_players() + filter_appliable_events() —
    # what production would show the coach, and what event_score is computed on.
    scored_events: List[Dict[str, Any]]
    # events production's appliers would have silently dropped (unresolvable
    # thrower/receiver/defender) — excluded from scoring but reported.
    dropped_unresolvable: List[Dict[str, Any]]
    event_score: EventScore

    @property
    def wer(self) -> Optional[float]:
        # WER is meaningless for noise-only scenarios (empty reference).
        if not self.expected_transcript:
            return None
        return word_error_rate(self.expected_transcript, self.outcome.transcript)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "config": dataclasses.asdict(self.config),
            "outcome": dataclasses.asdict(self.outcome),
            "expected_transcript": self.expected_transcript,
            "expected_events": self.expected_events,
            "scored_events": self.scored_events,
            "dropped_unresolvable": self.dropped_unresolvable,
            "precision": self.event_score.precision,
            "recall": self.event_score.recall,
            "f1": self.event_score.f1,
            "matched": self.event_score.matched,
            "missing": self.event_score.missing,
            "extra": self.event_score.extra,
            "wer": self.wer,
        }


async def run_scenario_fastpass(
    scenario_dir: Path, config: Optional[FastPassConfig] = None
) -> FastPassScenarioResult:
    """Load a scenario, replay it through the fast pass, score the net events."""
    config = config or FastPassConfig()
    s = Scenario.load(scenario_dir)
    outcome = await stream_audio_for_events(
        s.audio_path, s.roster, s.game_context, sample_rate=s.sample_rate, config=config
    )
    resolved = resolve_event_players(outcome.net_events, s.roster)
    scored_events, dropped = filter_appliable_events(resolved, s.roster)
    score = score_event_list(s.expected_events, scored_events)
    return FastPassScenarioResult(
        name=s.name,
        config=config,
        outcome=outcome,
        expected_transcript=s.expected_transcript,
        expected_events=s.expected_events,
        scored_events=scored_events,
        dropped_unresolvable=dropped,
        event_score=score,
    )


def list_scenarios(root: Path) -> List[Path]:
    """Return the sorted list of scenario directories under root."""
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_"))


# =============================================================================
# CLI entry point
# =============================================================================

def _print_result(r: ScenarioResult) -> None:
    print(f"\n=== {r.name} ===")
    print(f"WER:        {r.wer:.3f}  (lower is better)")
    print(f"Precision:  {r.event_score.precision:.3f}")
    print(f"Recall:     {r.event_score.recall:.3f}")
    print(f"F1:         {r.event_score.f1:.3f}")
    print(f"\nExpected transcript:\n  {r.expected_transcript}")
    print(f"\nActual transcript:\n  {r.actual_transcript}")
    if r.event_score.missing:
        print("\nMissed events (in expected, not in actual):")
        for ev in r.event_score.missing:
            print(f"  - {ev}")
    if r.event_score.extra:
        print("\nExtra events (in actual, not in expected):")
        for ev in r.event_score.extra:
            print(f"  - {ev}")


def main(argv: List[str]) -> int:
    if len(argv) < 2:
        print("usage: python -m ultistats_server.tests.narration.runner SCENARIO_DIR", file=sys.stderr)
        return 2
    sd = Path(argv[1])
    if not sd.is_dir():
        print(f"not a directory: {sd}", file=sys.stderr)
        return 2
    result = asyncio.run(run_scenario(sd))
    _print_result(result)
    # Exit non-zero if the scenario failed all/most metrics, so this can be
    # used in CI even without pytest.
    return 0 if result.event_score.f1 >= 0.5 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
