# Narration fast-pass pilot, Phase 1

Status: Phase 1 complete 2026-07-21 on branch `fastpass-eval`, **unmerged** as of 2026-09-05. Phase 2 (product wiring) is gated on the maintainer reading the numbers and deciding; do not start it unprompted. Plan: [../narration-fastpass-pilot-plan.md](../narration-fastpass-pilot-plan.md). Full results are on the branch at `docs/narration-fastpass-phase1-results-2026-07.md`.

## Facts a future session needs

- **Harness:** `stream_audio_for_events()` in the narration test runner plus a `fastpass_eval.py` driver; `--baseline` compares against the slow pass on identical audio. Noise probes 023, 024, 025 are committed; the generator is seeded. JSON run reports were ephemeral; rerun the driver to regenerate.
- **Numbers** (gpt-realtime, far-field, semantic VAD, eagerness low): fast pass precision 0.949, recall 0.685, F1 0.796, versus the Haiku slow pass at 0.980 / 0.907 / 0.942. Zero noise-only confabulations across five runs of two probes for both passes.
- **Run-to-run variance is large** (the same scenario scored 0.00 and 1.00 on different runs). Any configuration comparison needs at least three runs.
- `strict: true` on realtime tools is rejected by the API (`unknown_parameter session.tools[0].strict`). Do not retry; the harness falls back and records it.
- **Retraction works.** `retract_event` produced 5/5 correct sequences on the delayed-correction probe at eagerness high. At eagerness low, silence gaps (even 4 s) do not close the turn, so corrections are absorbed within-turn and retraction never gets a chance. The function-call-output acknowledgement hypothesis for truncation was refuted.
- **Truncation of long multi-event chains is the real remaining weakness**: intra-response model behaviour, recall about 0.68 at both eagerness settings.
- **The outdoor-audio premise was wrong.** Scenarios 004b, 008b, 015b, 019b, 021 have fixtures but no committed audio; 022 is the only real outdoor recording. Recording more outdoor audio is the biggest confidence lever.
