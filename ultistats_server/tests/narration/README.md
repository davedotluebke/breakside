# Narration test suite

Audio-driven regression / evaluation harness for the AI narration feature. Each test scenario is a folder of small files; the runner streams the audio through the OpenAI Realtime API for transcription, calls our `/api/narration/finalize` endpoint to extract events, and compares the result to expected outputs.

## Layout

```
tests/narration/
├── runner.py                # core: audio streaming + finalize call + metrics
├── test_scenarios.py        # pytest entry point (auto-discovers scenarios/)
├── tools/
│   └── generate_synthetic_audio.py   # OpenAI TTS → audio.pcm
└── scenarios/
    └── 001_single_throw/
        ├── transcript.txt   # ground-truth: what the coach is saying
        ├── roster.json      # on-field roster + initial game context
        ├── expected.json    # expected events (list of {kind, thrower, ...})
        ├── audio.flac       # 24kHz mono FLAC — committed canonical audio
        └── audio.wav        # gitignored preview-only side-file (open in Finder)
```

A scenario is "complete" once it has the four required files (transcript, roster, expected, and one audio file).

**Audio formats:**

The committed canonical format is **FLAC** — lossless and ~50% the size of raw PCM. The runner decodes FLAC to PCM in memory and streams that to OpenAI; FLAC compression introduces zero audio differences vs. uncompressed PCM, so test reproducibility is fully preserved.

The generator also writes a sibling `audio.wav` for convenience — playable directly in Finder / Quicklook / `afplay`. The `.wav` files are `.gitignore`d to keep the repo lean.

The audio can come from:

- **TTS** via `generate_synthetic_audio.py` (OpenAI `tts-1` → 24kHz PCM → encoded to FLAC). Cheap (~$0.002/scenario), deterministic, no background noise — good for validating the prompt + extraction pipeline.
- **Hand-recording** for real-world conditions (wind, accents, distance). Convert your recording to 24kHz mono FLAC and drop it in as `audio.flac`. The runner also accepts `.wav` if you'd rather not encode to FLAC.

Tip — preview without `audio.wav`:
```bash
afplay scenarios/001_single_throw/audio.wav     # if generator wrote one
ffplay -autoexit -nodisp scenarios/001_single_throw/audio.flac    # FLAC directly
```

## Running

### One-time setup

```bash
pip install -r ultistats_server/requirements.txt   # picks up websockets + soundfile
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

`soundfile` wraps `libsndfile`, which most systems already have. On macOS:
`brew install libsndfile` if installation fails.

### Generate audio for a new scenario

```bash
python -m ultistats_server.tests.narration.tools.generate_synthetic_audio \
    ultistats_server/tests/narration/scenarios/001_single_throw
```

Re-running is a no-op unless you pass `--force`. Voice can be changed with `--voice` or `TTS_VOICE=...`.

### Run a single scenario directly (handy when iterating)

```bash
python -m ultistats_server.tests.narration.runner \
    ultistats_server/tests/narration/scenarios/001_single_throw
```

Prints WER, precision/recall/F1, the full expected and actual transcripts, and any missing or extra events.

### Run via pytest (CI-friendly)

```bash
pytest ultistats_server/tests/narration/ -s
```

Pass threshold is F1 ≥ 0.6 by default (override with `NARRATION_MIN_F1=0.8`). Scenarios with no audio file are skipped, not failed — lets you commit a transcript + expected pair before generating audio.

## Adding a scenario

1. Pick a number (next free) and a short slug. Make a directory: `scenarios/NNN_short_slug/`.
2. Write `transcript.txt` — one paragraph of natural narration.
3. Write `roster.json` — at minimum:
   ```json
   {
     "roster": [{"name": "Alice", "nickname": null, "number": "7"}, ...],
     "game_context": {"offense": true, "our_score": 0, "their_score": 0, "point": 1}
   }
   ```
4. Write `expected.json` — a JSON array of expected events. Each event has a `kind` (`throw` / `turnover` / `defense` / `opponent_score`) plus the relevant fields. Mirror the schema documented in `ultistats_server/narration.py`.
5. Generate audio (or record it).
6. Run the scenario directly to see how it does. Iterate on the slow-pass prompt or your expected.json until they agree.

## Metrics explained

- **WER** (word error rate): edit distance between expected and actual transcript, normalized by reference length. Lower is better. Reported as a soft warning above 0.25; doesn't fail the test on its own.
- **Precision**: of the events the slow pass emitted, what fraction are correct? Penalizes hallucinations.
- **Recall**: of the events that should have been emitted, what fraction were? Penalizes misses.
- **F1**: harmonic mean of precision and recall. This is what the test asserts on.

Two events match if their `kind` and all "key fields" (player names, flags) are identical. See `_EVENT_KEY_FIELDS` in `runner.py` for the exact list. Order of events isn't strictly required to match — the runner does greedy matching in expected order, which rewards correct order without enforcing it.

## What this catches vs. doesn't

**Catches:**
- Slow-pass prompt regressions (wrong event types, dropped events, hallucinated players)
- Player-name resolution issues (TTS pronunciations vs. roster spellings)
- Schema drift (e.g., Claude emitting `throwaway: true` on a `defense` event)

**Doesn't catch (yet):**
- Real-world audio conditions: wind, crowd, distance, accents — synthetic TTS is too clean. Add hand-recorded scenarios for this.
- Possession structure / state-machine bugs in the client (the runner only checks the ADD operations the slow pass returns, not how the JS client applies them).
- Multi-speaker disambiguation — TTS uses one voice.

These are good follow-ups; see `TODO.md` under "Audio-Driven Test Suite".

## Cost per run

Roughly $0.05–0.10 per scenario:

- **Realtime API** (audio in → text out): ~$0.06 per minute of audio
- **Claude Sonnet** (slow pass): ~$0.01–0.03 per scenario depending on transcript length

A full suite of 10 scenarios runs in under a dollar.
