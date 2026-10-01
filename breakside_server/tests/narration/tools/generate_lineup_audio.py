"""
Generate audio-driven lineup scenarios from the text lineup eval matrix.

breakside_server/test_narration_lineup.py::_EVAL_SCENARIOS is the shipping
gate for the lineup prompt — 18 utterances with roster, prior line, current
selection and the expected resolved set — but it hands the model the exact
transcript. Real line calls arrive through the recognizer, and names are
where they go wrong. This tool speaks each utterance with OpenAI TTS so the
same 18 cases can be scored end to end from audio (stt_eval.py --lineups):
recognizer → lineup prompt → server derivation → client matcher.

Writes breakside_server/tests/narration/lineup_scenarios/<id>/ with
transcript.txt, roster.json ({roster, previous_lineup, current_selection,
expected_count}), expected.json ({expect, grade, must_in, must_out,
allowed}) and audio.flac. With --noisy also writes <id>-noisy/: the same
clip over a sideline crowd bed (wind + chatter from generate_noise_audio),
speech about 6 dB above the bed, sharing one committed _crowd_bed.flac so
the noise is identical across regenerations.

Usage:
  python -m breakside_server.tests.narration.tools.generate_lineup_audio [--noisy] [--force]

Cost: 18 TTS clips ≈ $0.04 (clean); the bed's chatter adds a few cents once.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from .generate_synthetic_audio import synthesize, SAMPLE_RATE
from .generate_noise_audio import synth_wind, tts_clip, place, _rms_to_gain, write_audio, CHATTER_CLIPS

HERE = Path(__file__).resolve().parent
LINEUP_DIR = HERE.parent / "lineup_scenarios"
SERVER_DIR = HERE.parents[2]  # breakside_server/

# S1 is constraint-graded in the text eval (_grade_s1); the sets live inline
# there, so they are restated here for the fixture.
S1_GRADE = {
    "must_in": ["Sam", "Morgan Vale", "Nora", "Omar"],
    "must_out": ["Kris", "Priya", "Dana", "Jake", "Charlie"],
    "allowed": ["Sam", "Morgan Vale", "Nora", "Omar", "Wes", "Alice", "Hank"],
}


def _load_matrix():
    # The test module does bare sibling imports (pytest's rootdir is
    # breakside_server/), so give it that path.
    if str(SERVER_DIR) not in sys.path:
        sys.path.insert(0, str(SERVER_DIR))
    from test_narration_lineup import _EVAL_SCENARIOS  # type: ignore
    return _EVAL_SCENARIOS


def _roster_json(roster):
    return [
        {"name": p["name"], "nickname": p.get("nickname"), "number": p.get("number")}
        for p in roster
    ]


def write_fixtures(sc, d: Path) -> None:
    d.mkdir(parents=True, exist_ok=True)
    (d / "transcript.txt").write_text(sc["t"].strip() + "\n")
    (d / "roster.json").write_text(json.dumps({
        "roster": _roster_json(sc["roster"]),
        "previous_lineup": list(sc["prev"]),
        "current_selection": list(sc["sel"]),
        "expected_count": 7,
    }, indent=2) + "\n")
    expected = {"grade": sc.get("grade"), "expect": sorted(sc["expect"]) if "expect" in sc else None}
    if sc.get("grade") == "s1":
        expected.update(S1_GRADE)
    (d / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")


def crowd_bed(force: bool) -> np.ndarray:
    """40 s of wind + sideline chatter, committed once as _crowd_bed.flac."""
    bed_path = LINEUP_DIR / "_crowd_bed.flac"
    if bed_path.exists() and not force:
        bed, sr = sf.read(str(bed_path), dtype="float64")
        return bed
    wind = synth_wind(40.0, seed=20261001)
    bed = wind * _rms_to_gain(wind, -30.0)
    for voice, text, offset in CHATTER_CLIPS:
        clip = tts_clip(text, voice)
        place(bed, clip * _rms_to_gain(clip, -24.0), offset)
    peak = np.max(np.abs(bed)) or 1.0
    if peak > 0.95:
        bed = bed * (0.95 / peak)
    LINEUP_DIR.mkdir(parents=True, exist_ok=True)
    sf.write(str(bed_path), (bed * 32767.0).astype("<i2"), SAMPLE_RATE, format="FLAC", subtype="PCM_16")
    print(f"  -> wrote {bed_path}")
    return bed


def write_noisy(clean_dir: Path, noisy_dir: Path, bed: np.ndarray, seed: int) -> None:
    speech, sr = sf.read(str(clean_dir / "audio.flac"), dtype="int16")
    speech = speech.astype(np.float64) / 32768.0
    rng = np.random.default_rng(seed)
    lead, tail = 1.0, 1.5
    total = int((lead + tail) * SAMPLE_RATE) + len(speech)
    start = int(rng.integers(0, max(1, len(bed) - total)))
    window = bed[start:start + total]
    if len(window) < total:
        window = np.concatenate([window, np.zeros(total - len(window))])
    mix = window * _rms_to_gain(window, -26.0)
    place(mix, speech * _rms_to_gain(speech, -20.0), lead)
    write_audio(mix, noisy_dir)


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate audio-driven lineup scenarios")
    ap.add_argument("--noisy", action="store_true", help="also write <id>-noisy variants over a crowd bed")
    ap.add_argument("--voice", default="nova")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    scenarios = _load_matrix()
    bed = crowd_bed(args.force) if args.noisy else None
    for i, sc in enumerate(scenarios):
        d = LINEUP_DIR / sc["id"]
        write_fixtures(sc, d)
        if (d / "audio.flac").exists() and not args.force:
            print(f"  {sc['id']}: audio exists")
        else:
            print(f"  {sc['id']}: synthesizing")
            synthesize(sc["t"], d / "audio.flac", voice=args.voice)
        if bed is not None:
            nd = LINEUP_DIR / f"{sc['id']}-noisy"
            write_fixtures(sc, nd)
            if (nd / "audio.flac").exists() and not args.force:
                print(f"  {sc['id']}-noisy: audio exists")
            else:
                write_noisy(d, nd, bed, seed=20261001 + i)
    return 0


if __name__ == "__main__":
    sys.exit(main())
