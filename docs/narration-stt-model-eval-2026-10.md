# Transcription Model Comparison — October 2026

Which OpenAI Realtime transcription model gets player names right on our
audio? Run 2026-10-01 with `breakside_server/tests/narration/stt_eval.py`
(branch `stt-swap`), prompted by lineup narration mishearing names in the
field. Companion to [narration-stt-research-2026-07.md](narration-stt-research-2026-07.md)
(pricing landscape) and [narration-diarization-research-2026-09.md](narration-diarization-research-2026-09.md)
(where this was proposed as the cheap first experiment).

## Verdict

**Switch the default from `gpt-4o-mini-transcribe` to `gpt-4o-transcribe`.**
It is already the "Full (more accurate)" option in Advanced Settings and
already allowlisted by the token endpoint, so the change is a settings
default, not a server change. On spoken line calls it keeps 97.7% of
roster-name mentions (mini: 82.5%), passes the lineup matrix 94.4% of the
time end to end (mini: 87.0%), and under sideline chatter it inserts far
less junk (WER 0.46 vs mini's 1.25 — mini twice echoed the vocabulary
prompt into the transcript verbatim and once fabricated an entire
play-by-play from crowd noise). Cost doubles from $0.003 to $0.006 per
audio minute: about $0.36 instead of $0.18 per game-hour of mic time.

Two things the model swap does **not** fix, both actionable separately:

1. **"Kris" is heard as "Chris"** by every model to some degree (mini 30 of
   30 mentions, `gpt-transcribe` 25/30, `gpt-4o-transcribe` 4/30) despite
   "Kris" being in the vocabulary hint. Downstream it is not cosmetic: the
   client matcher leaks "Chris" as unmatched, and the server's out-evidence
   guard rejects "Chris is coming off" because the quote does not name
   Kris. A sound-alike tier (Soundex / double metaphone, unique roster hit
   only) in `narration/lineupResolve.js` and in the server guard would turn
   those into matches for every model — the one lineup case
   `gpt-4o-transcribe` still fails (C1) is exactly this.
2. **The slow pass can confabulate from chatter**: on the sideline-chatter
   probe, one of twelve runs turned "Nice throw! Woo!" — a transcript with
   no names at all — into `throw Alice → Bob`. A recognizer swap cannot
   touch that; it is a prompt-guard gap in `/finalize` (no roster name in
   the clause, no event).

## What was measured

All models ran through the production-equivalent transcription session
(`runner.TranscriptionConfig`: semantic VAD medium, near-field noise
reduction, English, roster vocabulary hint; commit on stop as
`realtimeSession.stop()` does), three runs each, on two legs:

- **events** — the 20 TTS and field scenarios with audio (WER, roster-name
  recall, event F1 through the real `/finalize` on Haiku), plus the four
  noise probes separately.
- **lineups** — the 18-case lineup matrix from `test_narration_lineup.py`
  spoken by TTS (`tools/generate_lineup_audio.py`), clean and over a
  sideline crowd bed (speech ≈ 6 dB above wind + chatter), scored end to
  end: recognizer → real lineup prompt → Haiku → `_derive_players` → the
  real client matcher. 171 roster-name mentions per model per condition.

Model acceptance (the Realtime API's answer, not the docs'):
`gpt-live-transcribe` and `gpt-realtime-whisper` refuse `turn_detection`
(they segment themselves), `gpt-realtime-whisper` also refuses the `prompt`,
and `gpt-4o-transcribe-diarize` is not available to transcription sessions.
Production would need the no-turn-detection change to run either of the
first two.

## Results

| model | $/min | events WER | events names | events ev-F1 | lineup clean exact | clean names | lineup noisy exact | noisy names | noisy WER |
|---|---|---|---|---|---|---|---|---|---|
| gpt-4o-mini-transcribe (prod) | 0.003 | 0.003 | 100% | 0.92 | 87.0% | 82.5% | 64.8% | 77.8% | **1.25** |
| **gpt-4o-transcribe** | 0.006 | 0.010 | 100% | 0.92 | 94.4% | **97.7%** | 66.7% | 85.4% | **0.46** |
| gpt-transcribe | 0.0045 | 0.047 | 97.9% | 0.93 | 88.9% | 85.4% | 64.8% | 78.9% | 0.79 |
| gpt-live-transcribe | 0.017 | 0.051 | 97.9% | 0.95 | **98.1%** | 94.7% | 63.0% | 84.2% | 0.82 |
| gpt-realtime-whisper | ? | 0.078 | 98.4% | 0.92 | 85.2% | 80.7% | 48.1% | 69.0% | 0.98 |
| whisper-1 | 0.006 | 0.005 | 100% | 0.92 | 85.2% | 90.1% | **79.6%** | **87.1%** | 0.76 |

Reading it:

- The **events leg does not discriminate**: TTS-clean narration is easy for
  every model (names ≈ 100%) and event F1 is set by the slow pass. The one
  real field recording (022) is in there and did not separate them either.
- The **lineup leg is where names fail**, and the clean condition is the
  cleanest signal: 171 mentions, same audio for every model. mini's 30
  misses are all "Kris"; `gpt-4o-transcribe`'s four are the same word.
- In **noise** the pass rates converge (several mixes bury a word under a
  chatter clip for every model) but the transcripts differ in kind: mini's
  WER above 1 is insertions — the prompt echo and the fabricated
  play-by-play — which the lineup prompt tolerates and the events prompt
  would not.
- **`whisper-1`** looks strong in noise but returns an **empty transcript
  for one-word utterances** ("Kris", "Priya" — 0 of 6), which is the
  additive lineup idiom; not a candidate.
- **`gpt-live-transcribe`** wins clean lineups by a hair at 5.7× the price,
  needs a session change, and is no better in noise. Not worth it.

Noise probes (3 runs × 4 models): pure wind → every model silent, zero
events; sideline chatter → transcribed faithfully by all, one slow-pass
confabulation (above); narration over a loud crowd → every model F1 1.00;
delayed correction → every model F1 1.00.

## Caveats

- TTS speech, one voice, synthetic chatter. Real clips from the opt-in
  recorder (`narration-clips` branch) are the next input; the lineup leg
  takes any `lineup_scenarios/<id>/` directory.
- 3 runs. Lineup differences under ~5 points (the noisy exact rates) are
  within run-to-run variance; the clean name-recall gap (82.5 vs 97.7 on 171
  mentions) is not.
- Latency was not measured; the probe timings were indistinguishable.
- `gpt-4o-mini-transcribe` and its `2025-12-15` snapshot produced identical
  output on the probe, so the alias very likely already points at the
  December "fewer hallucinations in noise" snapshot.

## Reproduce

```bash
NARRATION_LINEUP_MODEL=claude-haiku-4-5 NARRATION_SLOW_MODEL=claude-haiku-4-5 \
python -m breakside_server.tests.narration.stt_eval --runs 3 --slow-pass --concurrency 8 --json out.json
```
About 45 minutes and under $5 (mostly Haiku) for six models.
