# Fast-Pass Pilot Plan — Replay Eval Harness First

Kickoff plan for a fresh Claude Code session. Goal: decide empirically whether
`gpt-realtime-2.1` is reliable enough to revive **live speech → structured
event extraction** (the "fast pass events" path abandoned in 2025 for
confabulating events from noisy outdoor audio), by building an offline replay
eval before touching any product code.

## Kickoff prompt (copy-paste to start the session)

> Read docs/narration-fastpass-pilot-plan.md and build Phase 1 (the replay
> eval harness). Work in a worktree per CLAUDE.md. Stop after Phase 1 and
> report the eval numbers before proposing any Phase 2 work.

## Background (read first, in this order)

1. `ARCHITECTURE.md` § AI Narration — current two-pass design (fast pass =
   transcription-only Realtime session; slow pass = Claude → CONFIRM/RETRACT/ADD
   operations).
2. `docs/narration-realtime-events-research-2026-07.md` — the verified
   research behind this pilot: verdict ("plausibly improved, unproven fixed"),
   recommended session config, cost model, and why an in-house replay eval is
   the only way to answer the question (no independent benchmark of the 2.1
   generation exists).
3. `docs/narration-stt-research-2026-07.md` — pricing landscape; corrected
   cost baselines.
4. `ultistats_server/tests/narration/README.md` — existing audio test harness.

## Key code references

- **Existing harness**: `ultistats_server/tests/narration/runner.py`.
  `Scenario.load()` reads `(audio.flac, transcript.txt, roster.json,
  expected.json)` dirs from `scenarios/`; `stream_audio_for_transcription()`
  is the server-to-server Realtime WebSocket streamer (PCM16 chunks at
  real-time pace, GA transcription session via `session.update`). The
  conversation-mode runner should be a sibling function mirroring its shape.
  `test_scenarios.py` computes WER + event precision/recall/F1 — reuse its
  event-comparison logic for fast-pass emitted events.
- **Outdoor scenarios already exist**: `004b_name_correction_outdoor`,
  `008b_yoyo_outdoor` (hand-recorded). These are the ones that matter most.
- **Removed fast-pass code**: deleted in commit `ff79ef1` (dead-code sweep);
  original implementation in `953dd3d` ("Add in-game AI speech narration").
  `git show ff79ef1^:narration/narrationEngine.js` has `buildTools` /
  `buildInstructions` / `handleFunctionCall` — use as the *starting point* for
  the eval's tool schema and instructions (they'll need updating for 2.1 and
  the no-call-default rules below). The event schema they emit must match the
  ADD-operation event shape in `ultistats_server/narration.py`.
- **Conversation-mode plumbing still live**: `narration/realtimeSession.js`
  (mode `'conversation'`, `?model=` URL form) and the conversation-mode token
  path in `ultistats_server/narration.py` — not needed for Phase 1 (the
  harness uses the API key directly, server-to-server) but confirms the wire
  format.

## Phase 1 — replay eval harness (this session's deliverable)

Build `stream_audio_for_events()` in the harness: opens a **conversation-mode**
Realtime session, streams scenario audio at real-time pace, collects emitted
function calls, and scores them against `expected.json`.

Session configuration (from the research doc's recommendation):

- Model: `gpt-realtime-2.1` (NOT mini — weaker benchmarks + unresolved
  regression report). Make it a parameter so mini can be measured too.
- `audio.input.noise_reduction: far_field`; semantic VAD with
  `eagerness: low`. Make both parameters — worth a small sweep.
- Tools: one function per event kind (start from the `ff79ef1^` versions),
  updated with: **no-call-default instructions** ("only emit an event when a
  player action is clearly and completely stated; when uncertain, emit
  nothing — a reviewer pass will catch omissions"), a required `confidence`
  field on every call, and roster injected into instructions.
- Try `strict: true` on function schemas — whether GA realtime sessions
  accept it is an open research question; the harness answering it is itself
  a deliverable. Fall back gracefully if rejected.
- Also run the parallel input-transcription config (as production would) so
  transcript-vs-events divergence can be logged.

Metrics per scenario, and aggregated:

- **Event precision** (the gate metric), recall, F1 vs `expected.json` —
  reuse the existing comparison logic; corrections in expected output are
  RETRACT+ADD pairs, so score the *net* event list after applying the fast
  pass's own retractions.
- Confabulation count: events emitted that match nothing in ground truth.
- Correction handling: scenarios `004*`, `006`, `008*` specifically.

**New scenarios required** (the direct confabulation probe — current suite
has none): 2–3 *noise-only* scenarios — crowd noise / sideline chatter /
wind with **zero narration** and `expected.json: []`. Any emitted event is a
confabulation. `tools/generate_synthetic_audio.py` can't make these; source
freefield ambience or record it. Also consider a narration-over-loud-crowd
mix if easy (overlay with ffmpeg).

Baseline comparison: run the existing transcription+slow-pass path on the
same scenarios (already supported) so the report is "fast pass vs slow pass
on identical audio," not fast pass in isolation.

Cost note: conversation-mode replay ≈ $0.03–0.06/audio-minute; a full-suite
run is well under a dollar. Iterate freely.

Suggested acceptance bar for proceeding to Phase 2 (tune with judgment):
zero confabulated events on the noise-only scenarios across 3 runs, and
outdoor-scenario precision within a few points of the slow-pass baseline
(recall may lag — the slow pass reviewer covers that).

## Phase 2 — product wiring (only if Phase 1 passes; separate approval)

Restore the fast-pass path from git history behind a re-introduced
`FAST_PASS_EVENTS_ENABLED` flag (default off) + an Advanced Settings toggle:
conversation-mode session with the Phase-1-winning config, provisional events
via the intact `provisionalEvents` / CONFIRM-RETRACT-ADD applier, slow pass
unchanged as reviewer. Re-verify the browser ephemeral-token flow for
conversation sessions (flagged unverified in the research). Cost impact:
~$1–3/game-hour vs ~$0.18 (fine at hobby scale).

## Phase 3 — field test

Real game, mic on, flag on for the pilot device only; compare fast-pass
provisional events against what the slow pass confirms; watch battery/data.

## Process notes for the session

- Code changes in a worktree (`git worktree add .worktrees/fastpass-eval -b
  fastpass-eval`); commit early and often. Docs may go straight to main.
- Harness runs are backend-only: plain `OPENAI_API_KEY`, no dev server, no
  browser needed for Phase 1. Don't run pytest in a pre-G3 worktree without
  the per-worktree data isolation (see MEMORY notes / CLAUDE.md).
- The stale `~$0.06/min` comment at `ultistats_server/tests/narration/runner.py:26`
  can be corrected in passing while editing that file (docs already fixed).
