"""
Generate synthetic test audio from a script using OpenAI's TTS API.

Cheap (~$0.002 per scenario) and deterministic enough to use in CI. The
output is 24kHz PCM16 mono — exactly what the Realtime API expects, no
resampling needed.

Usage:
  python -m ultistats_server.tests.narration.tools.generate_synthetic_audio \\
      ultistats_server/tests/narration/scenarios/001_single_throw

Reads `transcript.txt` from the scenario dir and writes `audio.pcm`
alongside it. Skips generation if `audio.pcm` already exists (re-running
won't burn TTS credits accidentally).

Voice can be overridden via env var TTS_VOICE (alloy / echo / fable /
onyx / nova / shimmer). Defaults to "nova" — neutral and clear.

Note: TTS produces idealized audio with no wind, no crowd, perfect
diction. That's a limitation of synthetic tests — they validate the
event-extraction pipeline but won't predict outdoor-noise robustness.
For that we need real recorded scenarios.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import httpx


DEFAULT_VOICE = "nova"
TTS_URL = "https://api.openai.com/v1/audio/speech"
TTS_MODEL = "tts-1"


def synthesize(text: str, output_path: Path, voice: str = DEFAULT_VOICE) -> None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY env var not set")

    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            TTS_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": TTS_MODEL,
                "voice": voice,
                "input": text,
                # 24kHz raw PCM16 — what Realtime expects, no decoding needed.
                "response_format": "pcm",
            },
        )
    if resp.status_code != 200:
        raise RuntimeError(f"TTS failed: {resp.status_code} {resp.text[:300]}")

    output_path.write_bytes(resp.content)
    size_kb = len(resp.content) / 1024
    duration_s = len(resp.content) / (24000 * 2)
    print(f"  -> wrote {output_path} ({size_kb:.1f} KB, {duration_s:.1f}s)")


def generate_for_scenario(scenario_dir: Path, voice: str, force: bool) -> None:
    transcript_path = scenario_dir / "transcript.txt"
    if not transcript_path.exists():
        raise FileNotFoundError(
            f"{scenario_dir} has no transcript.txt — write the script first."
        )
    audio_path = scenario_dir / "audio.pcm"
    if audio_path.exists() and not force:
        print(f"  skip (audio.pcm exists; pass --force to regenerate)")
        return
    text = transcript_path.read_text().strip()
    if not text:
        raise ValueError(f"{transcript_path} is empty")
    print(f"Generating audio for {scenario_dir.name} (voice={voice}):")
    print(f"  text: {text!r}")
    synthesize(text, audio_path, voice=voice)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else "")
    ap.add_argument("scenario_dirs", nargs="+", type=Path, help="One or more scenario directories")
    ap.add_argument(
        "--voice",
        default=os.getenv("TTS_VOICE", DEFAULT_VOICE),
        help=f"OpenAI TTS voice (default: {DEFAULT_VOICE})",
    )
    ap.add_argument("--force", action="store_true", help="Regenerate even if audio.pcm exists")
    args = ap.parse_args()

    failed = 0
    for sd in args.scenario_dirs:
        if not sd.is_dir():
            print(f"  not a directory: {sd}", file=sys.stderr)
            failed += 1
            continue
        try:
            generate_for_scenario(sd, args.voice, args.force)
        except Exception as e:
            print(f"  FAILED for {sd}: {e}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
