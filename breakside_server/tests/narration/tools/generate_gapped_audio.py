"""
Generate scenario audio with controlled silence gaps between utterances.

The plain TTS generator reads transcript.txt as one continuous read — VAD
sees a single utterance. Some probes need the opposite: speech, a long
pause that forces the turn to CLOSE (so the model responds), then more
speech. The delayed-correction probe (026) is the motivating case: the
wrong event must be emitted before the correction is heard, making
retract_event the only path to a correct final state.

A scenario opts in with a `segments.json` file:

    [
      {"text": "Alice throws to Bob in the endzone for the score!", "gap_after": 4.0},
      {"text": "Wait, no — that was Daniel who caught it, not Bob."}
    ]

Each segment is synthesized with OpenAI TTS (same voice throughout) and the
segments are joined with `gap_after` seconds of near-silence (a faint noise
floor, so VAD sees quiet air rather than a dead digital channel). Writes the
usual audio.flac + gitignored audio.wav.

Usage:
  python -m ultistats_server.tests.narration.tools.generate_gapped_audio \\
      ultistats_server/tests/narration/scenarios/026_delayed_correction [--force]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import wave
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf

SAMPLE_RATE = 24000
TTS_URL = "https://api.openai.com/v1/audio/speech"
TTS_MODEL = "tts-1"
DEFAULT_VOICE = "nova"


def tts_clip(text: str, voice: str) -> np.ndarray:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY env var not set")
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            TTS_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": TTS_MODEL, "voice": voice, "input": text, "response_format": "pcm"},
        )
    if resp.status_code != 200:
        raise RuntimeError(f"TTS failed: {resp.status_code} {resp.text[:300]}")
    return np.frombuffer(resp.content, dtype="<i2").astype(np.float64) / 32768.0


def generate(scenario_dir: Path, voice: str, force: bool) -> None:
    segments_path = scenario_dir / "segments.json"
    if not segments_path.exists():
        raise FileNotFoundError(f"{scenario_dir} has no segments.json")
    flac_path = scenario_dir / "audio.flac"
    if flac_path.exists() and not force:
        print(f"  skip {scenario_dir.name} (audio.flac exists; pass --force to regenerate)")
        return

    segments = json.loads(segments_path.read_text())
    rng = np.random.default_rng(20260726)
    parts = []
    for seg in segments:
        clip = tts_clip(seg["text"], voice)
        parts.append(clip)
        gap = float(seg.get("gap_after", 0.0))
        if gap > 0:
            # Faint noise floor (~-60 dBFS) instead of digital silence.
            parts.append(rng.standard_normal(int(gap * SAMPLE_RATE)) * 0.001)
    mix = np.concatenate(parts)
    peak = np.max(np.abs(mix)) or 1.0
    if peak > 0.95:
        mix = mix * (0.95 / peak)
    pcm = (mix * 32767.0).astype("<i2")
    sf.write(str(flac_path), pcm, SAMPLE_RATE, format="FLAC", subtype="PCM_16")
    with wave.open(str(scenario_dir / "audio.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    print(f"  -> wrote {flac_path} ({flac_path.stat().st_size / 1024:.1f} KB, {len(pcm) / SAMPLE_RATE:.1f}s)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate gap-structured scenario audio from segments.json")
    ap.add_argument("scenario_dirs", nargs="+", type=Path)
    ap.add_argument("--voice", default=os.getenv("TTS_VOICE", DEFAULT_VOICE))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    failed = 0
    for sd in args.scenario_dirs:
        try:
            generate(sd, args.voice, args.force)
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED for {sd}: {e}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
