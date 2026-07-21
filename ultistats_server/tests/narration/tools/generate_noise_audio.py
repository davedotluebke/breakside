"""
Generate the noise-probe scenario audio (023-025) — the direct confabulation
probes for the fast-pass replay eval (docs/narration-fastpass-pilot-plan.md).

The TTS generator can't make these: they need audio that is NOT clean
narration. Three scenarios:

  023_noise_only_wind      ~40s of synthesized outdoor wind (gusty, band-
                           shaped noise). Zero speech. expected.json is [] —
                           ANY emitted event is a confabulation.
  024_noise_only_sideline  wind bed + overlapping TTS "sideline chatter"
                           clips: cheering, snack logistics, game-adjacent
                           talk — real speech, zero narrated player actions.
                           expected.json is [].
  025_narration_over_crowd 002_multi_throw_possession's narration overlaid
                           on a loud chatter+wind bed. Same expected events
                           as 002 — measures precision/recall degradation
                           under crowd noise on known-good narration.

Wind is synthesized (seeded, reproducible): FFT-shaped noise with a slow
gust envelope. Chatter comes from OpenAI TTS (~$0.01 total) in multiple
voices. Committed output is the usual 24kHz mono audio.flac (+ gitignored
audio.wav preview).

Usage:
  python -m ultistats_server.tests.narration.tools.generate_noise_audio [--force]

Skips scenarios whose audio.flac already exists unless --force (regenerating
chatter re-spends TTS pennies; wind is free). Requires OPENAI_API_KEY for
024/025 chatter.
"""
from __future__ import annotations

import argparse
import os
import sys
import wave
from pathlib import Path
from typing import List, Optional, Tuple

import httpx
import numpy as np
import soundfile as sf

SAMPLE_RATE = 24000
SCENARIOS_DIR = Path(__file__).resolve().parent.parent / "scenarios"

TTS_URL = "https://api.openai.com/v1/audio/speech"
TTS_MODEL = "tts-1"

# Sideline chatter: real speech with zero narrated player actions. Includes
# game-adjacent hard negatives (cheering, "nice throw!", disc talk) — the
# things a sideline mic actually hears — but no roster names and no complete
# "player did X" statements.
CHATTER_CLIPS: List[Tuple[str, str, float]] = [
    # (voice, text, start offset in seconds)
    ("alloy", "Hey, did you bring the extra water bottles? I think I left mine in the car.", 2.0),
    ("onyx", "Let's go blue! Come on, you've got this! Woo!", 8.5),
    ("shimmer", "Are we still getting pizza after this? I don't know, it depends how long this one runs.", 14.0),
    ("echo", "It's so windy today. Yeah, the disc keeps sailing on them. Classic.", 22.0),
    ("fable", "Nice throw! Woo! Oh wow, that was awesome.", 30.0),
]


# ---------------------------------------------------------------------------
# Synthesis helpers
# ---------------------------------------------------------------------------

def _shaped_noise(n: int, sr: int, rng: np.random.Generator, corner_hz: float, rolloff_hz: float, power: float) -> np.ndarray:
    """White noise spectrally shaped to 1/(f+corner)^power with a soft
    low-pass beyond rolloff_hz. Returns float array normalized to unit RMS."""
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    shape = 1.0 / np.power(freqs + corner_hz, power)
    shape *= 1.0 / (1.0 + (freqs / rolloff_hz) ** 4)
    spec *= shape
    out = np.fft.irfft(spec, n)
    rms = np.sqrt(np.mean(out**2)) or 1.0
    return out / rms


def synth_wind(duration_s: float, sr: int = SAMPLE_RATE, seed: int = 20260721) -> np.ndarray:
    """Gusty outdoor wind: band-shaped rumble modulated by a slow gust
    envelope, plus a quieter broadband hiss. Float output, unit-RMS-ish."""
    rng = np.random.default_rng(seed)
    n = int(duration_s * sr)
    rumble = _shaped_noise(n, sr, rng, corner_hz=40.0, rolloff_hz=500.0, power=1.2)
    hiss = _shaped_noise(n, sr, rng, corner_hz=200.0, rolloff_hz=4000.0, power=0.8)
    # Gust envelope: very-low-frequency noise mapped to [0.25, 1.0].
    env = _shaped_noise(n, sr, rng, corner_hz=0.08, rolloff_hz=0.4, power=1.0)
    env = (env - env.min()) / (env.max() - env.min() or 1.0)
    env = 0.25 + 0.75 * env**1.5
    wind = (rumble * 0.85 + hiss * 0.15) * env
    return wind / (np.sqrt(np.mean(wind**2)) or 1.0)


def tts_clip(text: str, voice: str) -> np.ndarray:
    """Fetch a TTS clip as float samples at 24kHz."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY env var not set (needed for chatter TTS)")
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            TTS_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": TTS_MODEL, "voice": voice, "input": text, "response_format": "pcm"},
        )
    if resp.status_code != 200:
        raise RuntimeError(f"TTS failed: {resp.status_code} {resp.text[:300]}")
    return np.frombuffer(resp.content, dtype="<i2").astype(np.float64) / 32768.0


def _rms_to_gain(x: np.ndarray, target_dbfs: float) -> float:
    rms = np.sqrt(np.mean(x**2)) or 1e-9
    return (10 ** (target_dbfs / 20.0)) / rms


def place(dst: np.ndarray, clip: np.ndarray, offset_s: float, sr: int = SAMPLE_RATE) -> None:
    """Mix clip into dst starting at offset (clipped to fit)."""
    start = int(offset_s * sr)
    end = min(start + len(clip), len(dst))
    if start < len(dst):
        dst[start:end] += clip[: end - start]


def write_audio(samples: np.ndarray, scenario_dir: Path) -> None:
    """Peak-clamp, convert to int16, write audio.flac + audio.wav preview."""
    peak = np.max(np.abs(samples)) or 1.0
    if peak > 0.95:
        samples = samples * (0.95 / peak)
    pcm = (samples * 32767.0).astype("<i2")
    flac_path = scenario_dir / "audio.flac"
    sf.write(str(flac_path), pcm, SAMPLE_RATE, format="FLAC", subtype="PCM_16")
    with wave.open(str(scenario_dir / "audio.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    print(f"  -> wrote {flac_path} ({flac_path.stat().st_size / 1024:.1f} KB, {len(pcm) / SAMPLE_RATE:.1f}s)")


# ---------------------------------------------------------------------------
# Scenario builders
# ---------------------------------------------------------------------------

def build_wind_only(scenario_dir: Path) -> None:
    wind = synth_wind(40.0, seed=20260721)
    write_audio(wind * _rms_to_gain(wind, -26.0), scenario_dir)


def build_sideline(scenario_dir: Path) -> None:
    wind = synth_wind(40.0, seed=20260722)
    mix = wind * _rms_to_gain(wind, -30.0)
    for voice, text, offset in CHATTER_CLIPS:
        clip = tts_clip(text, voice)
        mix_gain = _rms_to_gain(clip, -23.0)
        place(mix, clip * mix_gain, offset)
    write_audio(mix, scenario_dir)


def build_narration_over_crowd(scenario_dir: Path) -> None:
    src = SCENARIOS_DIR / "002_multi_throw_possession" / "audio.flac"
    if not src.exists():
        raise FileNotFoundError(f"{src} missing — generate 002 audio first")
    speech, sr = sf.read(str(src), dtype="int16")
    if sr != SAMPLE_RATE:
        raise ValueError(f"{src}: expected {SAMPLE_RATE}Hz, got {sr}")
    speech = speech.astype(np.float64) / 32768.0

    lead, tail = 2.0, 2.5
    total = lead + len(speech) / SAMPLE_RATE + tail
    wind = synth_wind(total, seed=20260723)
    bed = wind * _rms_to_gain(wind, -27.0)
    # A couple of chatter snippets under the narration make the bed a crowd,
    # not just weather. Kept quieter than the coach.
    for voice, text, offset in [
        ("onyx", "Let's go blue! Come on! Woo!", 0.5),
        ("shimmer", "Nice! Oh wow.", 4.5),
    ]:
        clip = tts_clip(text, voice)
        place(bed, clip * _rms_to_gain(clip, -26.0), offset)
    # Coach only ~4 dB above the bed — "loud crowd" conditions.
    place(bed, speech * _rms_to_gain(speech, -20.0), lead)
    write_audio(bed, scenario_dir)


BUILDERS = {
    "023_noise_only_wind": build_wind_only,
    "024_noise_only_sideline": build_sideline,
    "025_narration_over_crowd": build_narration_over_crowd,
}


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate noise-probe scenario audio (023-025)")
    ap.add_argument("--force", action="store_true", help="Regenerate even if audio.flac exists")
    args = ap.parse_args()

    failed = 0
    for name, builder in BUILDERS.items():
        scenario_dir = SCENARIOS_DIR / name
        if not scenario_dir.is_dir():
            print(f"  FAILED {name}: scenario dir missing (create fixtures first)", file=sys.stderr)
            failed += 1
            continue
        if (scenario_dir / "audio.flac").exists() and not args.force:
            print(f"  skip {name} (audio.flac exists; pass --force to regenerate)")
            continue
        print(f"Generating {name}:")
        try:
            builder(scenario_dir)
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED {name}: {e}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
