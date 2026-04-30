"""
Pytest entry point for narration scenarios.

Each subdirectory under scenarios/ that has audio.{pcm,wav} +
transcript.txt + expected.json + roster.json becomes a parametrized
test case. The test passes if F1 over event matching is at or above
MIN_F1, and (separately) reports WER as a soft warning if it's high.

Skipping behavior:
  - The whole module is skipped if OPENAI_API_KEY is not set, since the
    runner needs to actually hit the Realtime API.
  - Individual scenarios are skipped if their audio file is missing
    (lets you commit transcript.txt + expected.json before generating
    audio).

Run with:
  pytest ultistats_server/tests/narration/                     # all scenarios
  pytest ultistats_server/tests/narration/ -k single_throw     # one scenario
  pytest ultistats_server/tests/narration/ -s                  # show metrics
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from .runner import (
    list_scenarios,
    run_scenario,
    Scenario,
)


SCENARIOS_DIR = Path(__file__).parent / "scenarios"

# Pass threshold. The slow pass + transcript pipeline is stochastic, so we
# require partial matches rather than perfect equality. Tighten once we
# have more data on stability.
MIN_F1 = float(os.getenv("NARRATION_MIN_F1", "0.6"))
# WER above this is reported as a warning but doesn't fail the test —
# transcription quality varies by voice and script.
WER_WARNING_THRESHOLD = float(os.getenv("NARRATION_WER_WARNING", "0.25"))


# Skip the entire module if API keys are missing.
_skip_reason = None
if not os.getenv("OPENAI_API_KEY"):
    _skip_reason = "OPENAI_API_KEY not set"
elif not os.getenv("ANTHROPIC_API_KEY"):
    _skip_reason = "ANTHROPIC_API_KEY not set"

pytestmark = pytest.mark.skipif(_skip_reason is not None, reason=_skip_reason or "")


def _scenario_id(p: Path) -> str:
    return p.name


@pytest.mark.parametrize(
    "scenario_dir",
    list_scenarios(SCENARIOS_DIR),
    ids=_scenario_id,
)
def test_scenario(scenario_dir: Path, capsys):
    # Quick existence check: skip rather than fail if audio's not generated yet.
    has_audio = any((scenario_dir / f).exists() for f in ("audio.flac", "audio.wav", "audio.pcm"))
    if not has_audio:
        pytest.skip(f"no audio file in {scenario_dir.name} (run generate_synthetic_audio.py)")

    result = asyncio.run(run_scenario(scenario_dir))

    # Always print the metrics + diff so failures are debuggable. Use -s to
    # see this output regardless of pass/fail.
    with capsys.disabled():
        print(f"\n--- {result.name} ---")
        print(f"WER:       {result.wer:.3f}")
        print(f"Precision: {result.event_score.precision:.3f}")
        print(f"Recall:    {result.event_score.recall:.3f}")
        print(f"F1:        {result.event_score.f1:.3f}")
        print(f"Expected transcript: {result.expected_transcript!r}")
        print(f"Actual transcript:   {result.actual_transcript!r}")
        if result.event_score.missing:
            print("Missed events:")
            for ev in result.event_score.missing:
                print(f"  - {ev}")
        if result.event_score.extra:
            print("Extra (hallucinated?) events:")
            for ev in result.event_score.extra:
                print(f"  - {ev}")
        if result.wer > WER_WARNING_THRESHOLD:
            print(f"  ! transcript WER {result.wer:.2f} above warning threshold {WER_WARNING_THRESHOLD:.2f}")

    # The hard assertion is on event F1 — that's what users actually care about.
    assert result.event_score.f1 >= MIN_F1, (
        f"F1 {result.event_score.f1:.2f} < threshold {MIN_F1:.2f} "
        f"(precision={result.event_score.precision:.2f}, recall={result.event_score.recall:.2f})"
    )
