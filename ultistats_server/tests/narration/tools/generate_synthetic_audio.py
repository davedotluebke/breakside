"""
Generate synthetic test audio from a script using OpenAI's TTS API.

Cheap (~$0.002 per scenario) and deterministic enough to use in CI. The
output is committed as 24kHz mono FLAC (lossless, ~50% the size of raw
PCM). The runner decodes it to PCM in memory before streaming to the
Realtime API; FLAC compression introduces zero audio differences.

Usage:
  python -m ultistats_server.tests.narration.tools.generate_synthetic_audio \\
      ultistats_server/tests/narration/scenarios/001_single_throw

Reads `transcript.txt` from the scenario dir and writes:
  - `audio.flac` — committed canonical audio (used by the runner)
  - `audio.wav`  — preview-friendly side-file, gitignored

Skips generation if `audio.flac` already exists (re-running won't burn
TTS credits accidentally). Use `--force` to regenerate.

Voice can be overridden via env var TTS_VOICE (alloy / echo / fable /
onyx / nova / shimmer). Defaults to "nova" — neutral and clear.

Note: TTS produces idealized audio with no wind, no crowd, perfect
diction. That's a limitation of synthetic tests — they validate the
event-extraction pipeline but won't predict outdoor-noise robustness.
For that we need real recorded scenarios (just record at 24 kHz mono
and convert to FLAC; the runner accepts either).
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import wave
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf


DEFAULT_VOICE = "nova"
TTS_URL = "https://api.openai.com/v1/audio/speech"
TTS_MODEL = "tts-1"
SAMPLE_RATE = 24000  # OpenAI tts-1 PCM output is fixed at 24 kHz mono 16-bit


def _pcm16_to_int16_array(pcm_bytes: bytes) -> "np.ndarray":
    """Interpret raw little-endian 16-bit PCM bytes as a 1-D int16 array."""
    return np.frombuffer(pcm_bytes, dtype="<i2")


def _write_flac(pcm_bytes: bytes, output_path: Path, sample_rate: int = SAMPLE_RATE) -> None:
    """Save raw PCM16 mono as FLAC (lossless)."""
    samples = _pcm16_to_int16_array(pcm_bytes)
    sf.write(str(output_path), samples, sample_rate, format="FLAC", subtype="PCM_16")


def _write_wav(pcm_bytes: bytes, output_path: Path, sample_rate: int = SAMPLE_RATE) -> None:
    """Wrap raw PCM16 mono in a WAV container so previewers can play it."""
    with wave.open(str(output_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        w.writeframes(pcm_bytes)


def synthesize(text: str, flac_path: Path, voice: str = DEFAULT_VOICE) -> None:
    """Synthesize `text` and save:
       - flac_path      — canonical lossless committed audio
       - <same>.wav     — preview-friendly side-file (local, gitignored)
    """
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

    pcm_bytes = resp.content
    _write_flac(pcm_bytes, flac_path)
    wav_path = flac_path.with_suffix(".wav")
    _write_wav(pcm_bytes, wav_path)

    flac_kb = flac_path.stat().st_size / 1024
    wav_kb = wav_path.stat().st_size / 1024
    duration_s = len(pcm_bytes) / (SAMPLE_RATE * 2)
    print(f"  -> wrote {flac_path} ({flac_kb:.1f} KB, {duration_s:.1f}s)")
    print(f"  -> wrote {wav_path} ({wav_kb:.1f} KB, preview-only)")


def generate_for_scenario(scenario_dir: Path, voice: str, force: bool) -> None:
    transcript_path = scenario_dir / "transcript.txt"
    if not transcript_path.exists():
        raise FileNotFoundError(
            f"{scenario_dir} has no transcript.txt — write the script first."
        )
    flac_path = scenario_dir / "audio.flac"
    wav_path = scenario_dir / "audio.wav"
    legacy_pcm_path = scenario_dir / "audio.pcm"

    # Migration: if a scenario still has the legacy audio.pcm but no .flac,
    # convert it without spending on TTS.
    if legacy_pcm_path.exists() and not flac_path.exists() and not force:
        print(f"  migrating audio.pcm -> audio.flac (no TTS call)")
        pcm_bytes = legacy_pcm_path.read_bytes()
        _write_flac(pcm_bytes, flac_path)
        if not wav_path.exists():
            _write_wav(pcm_bytes, wav_path)
        return

    if flac_path.exists() and not force:
        # If only the .wav side-file is missing, regenerate it from the FLAC
        # (no TTS spend).
        if not wav_path.exists():
            print(f"  audio.flac exists; writing missing audio.wav from it")
            samples, sr = sf.read(str(flac_path), dtype="int16")
            with wave.open(str(wav_path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sr)
                w.writeframes(samples.tobytes())
        else:
            print(f"  skip (audio.flac exists; pass --force to regenerate)")
        return

    text = transcript_path.read_text().strip()
    if not text:
        raise ValueError(f"{transcript_path} is empty")
    print(f"Generating audio for {scenario_dir.name} (voice={voice}):")
    print(f"  text: {text!r}")
    synthesize(text, flac_path, voice=voice)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else "")
    ap.add_argument("scenario_dirs", nargs="+", type=Path, help="One or more scenario directories")
    ap.add_argument(
        "--voice",
        default=os.getenv("TTS_VOICE", DEFAULT_VOICE),
        help=f"OpenAI TTS voice (default: {DEFAULT_VOICE})",
    )
    ap.add_argument("--force", action="store_true", help="Regenerate even if audio.flac exists")
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
