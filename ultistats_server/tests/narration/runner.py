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
audio (≈ $0.06/min) plus one Claude Sonnet call (≈ $0.01-0.03). A typical
small scenario is well under $0.10.
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

REALTIME_URL_TEMPLATE = "wss://api.openai.com/v1/realtime?model={model}"


async def stream_audio_for_transcription(
    audio_path: Path,
    sample_rate: int = 24000,
    model: str = "gpt-realtime",
    timeout_s: float = 60.0,
) -> str:
    """
    Stream a PCM16 audio file to the Realtime API and return the accumulated
    transcript. Uses transcription-only session config (no tools, no model
    output) — matches the production fast-pass mode.
    """
    if websockets is None:
        raise RuntimeError(
            "The 'websockets' Python package is required for the test runner. "
            "Install it: pip install websockets"
        )
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY env var not set")

    url = REALTIME_URL_TEMPLATE.format(model=model)
    headers = [
        ("Authorization", f"Bearer {api_key}"),
        ("OpenAI-Beta", "realtime=v1"),
    ]

    transcript_parts: List[str] = []
    response_done = asyncio.Event()
    # Transcription is a separate event stream from the model response. For
    # short audio it sometimes lands AFTER response.done, so we track its
    # completion independently and wait for whichever happens later.
    transcription_completed = asyncio.Event()

    # websockets API note: the legacy `websockets.connect` (v10.x and the
    # legacy compat shim in v12+) uses `extra_headers=`; the new modern
    # asyncio API in v12+ would use `additional_headers=`. We use the
    # legacy name because it's accepted by both major versions.
    async with websockets.connect(url, extra_headers=headers, max_size=2**24) as ws:  # type: ignore[attr-defined]
        # Configure session: text-only, transcription enabled, no tools.
        await ws.send(
            json.dumps(
                {
                    "type": "session.update",
                    "session": {
                        "modalities": ["text"],
                        "instructions": (
                            "You are passively listening. Do not respond. "
                            "Just transcribe."
                        ),
                        "input_audio_format": "pcm16",
                        "input_audio_transcription": {
                            "model": "gpt-4o-mini-transcribe"
                        },
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.5,
                            "prefix_padding_ms": 300,
                            "silence_duration_ms": 500,
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
                elif t == "response.done":
                    response_done.set()
                elif t == "error":
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

            # Force end-of-turn so transcription completes promptly.
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            await ws.send(json.dumps({"type": "response.create"}))

        reader_task = asyncio.create_task(reader())
        writer_task = asyncio.create_task(writer())

        try:
            await asyncio.wait_for(writer_task, timeout=timeout_s)
            # After audio is fully sent and committed, wait for BOTH:
            # - response.done (model's reply finishes; for transcription-only
            #   sessions this is usually a tiny acknowledgment)
            # - input_audio_transcription.completed (the actual ASR result —
            #   what we care about)
            # These come on independent pipelines and can arrive in either
            # order, especially for short audio. Waiting only for response.done
            # (the original bug) caused empty transcripts on ~2s scenarios.
            try:
                await asyncio.wait_for(
                    asyncio.gather(
                        response_done.wait(),
                        transcription_completed.wait(),
                    ),
                    timeout=10.0,
                )
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
    "dump",
    "hammer",
    "sky",
    "layout",
    "score",
    "throwaway",
    "drop",
    "good_defense",
    "stall",
    "interception",
    "callahan",
)


def _event_signature(ev: Dict[str, Any]) -> Dict[str, Any]:
    return {k: ev.get(k) for k in _EVENT_KEY_FIELDS if k in ev}


def score_events(
    expected_events: List[Dict[str, Any]],
    operations: List[Dict[str, Any]],
) -> EventScore:
    """
    Compare expected events to ADD operations from the slow pass.

    Matching is greedy in expected-order: for each expected event we try to
    find the first unmatched ADD op with the same kind + same key fields.
    This rewards order preservation.
    """
    actual_events = [op["event"] for op in operations if op.get("op") == "ADD" and "event" in op]
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
