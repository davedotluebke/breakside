# Reviving Fast-Pass Events? OpenAI Realtime Research — July 2026

Companion to [narration-stt-research-2026-07.md](narration-stt-research-2026-07.md).
Question: are OpenAI's current realtime speech models now reliable enough to
revive **live speech → structured event extraction** (conversation-mode session
emitting function calls for throw/turnover/defense/score, including spoken
self-corrections) — the path abandoned in 2025 because `gpt-realtime`
confabulated events from garbled audio in noisy outdoor conditions?

Conducted 2026-07-21 via the multi-agent verified-research harness: 21 sources,
101 claims extracted, top 25 adversarially verified (23 confirmed, 2 refuted).

## Verdict

**Plausibly improved, unproven fixed. Revive only as a gated pilot, and only
because the Claude slow pass stays on as reviewer.** OpenAI has explicitly
targeted this failure mode across three consecutive releases, but every
noise/hallucination claim for the realtime models is qualitative vendor
self-report, no independent benchmark of the July-2026 `gpt-realtime-2.1`
generation exists yet (it was 15 days old at research time), and independent
evals of the generation four months prior show the over-triggering bias — the
closest measured proxy to our confabulation failure — was still alive. The
question "does 2.1 stop confabulating on *our* noise profile" is answerable
only empirically, and our audio test harness is well positioned to answer it.

## Evidence that the problem was worked on (all verified 3-0, all vendor self-report)

- **Sept 2025**: OpenAI's developer notes admit GA `gpt-realtime` "sometimes
  hallucinates the content of a nonexistent function response" during pending
  tool calls — mitigated with tuned placeholders, not eliminated. (Also
  confirms async/pending function-call support.)
- **Dec 2025 snapshots**: "Fewer hallucinations during silence or with
  background noise" — an unquantified one-line bullet. The only *quantified*
  hallucination numbers in that post (~90% fewer than Whisper v2, ~70% fewer
  than prior gpt-4o-transcribe on an internal noise eval) apply to
  `gpt-4o-mini-transcribe`, **not** the realtime models.
  `gpt-realtime-mini-2025-12-15` claimed +18.6pp instruction-following and
  +12.9pp tool-calling on internal speech-to-speech evals.
- **July 6, 2026**: `gpt-realtime-2.1` / `2.1-mini` ship with "improved
  alphanumeric recognition, silence and noise handling, and interruption
  behavior." No benchmark scores, no hallucination-rate or false-tool-call
  data. Secondary coverage reads "silence and noise handling" primarily as
  **turn-detection robustness** — adjacent to, but not the same as, reduced
  confabulated tool calls. Only quantified 2.1 number: 25% p95 latency
  reduction (from caching).

## Independent evidence (all of the *pre-2.1* generation, `gpt-realtime-1.5`, Feb 2026)

Three non-peer-reviewed-but-credible preprints (τ-Voice is an ICML 2026
poster; caveats: two use TTS-synthesized audio, none uses outdoor/crowd noise,
τ-Voice's author Sierra is itself a voice-agent vendor):

| Finding | Numbers | Verified |
|---|---|---|
| Best-in-class at tool calling from speech, mediocre in absolute terms | Full-Duplex-Bench-v3: Pass@1 0.600, Tool-Selection F1 0.876 on disfluent real speech (best of 6 systems). Confetti: 59.2% audio vs 64.0% text tool-call accuracy. τ-Voice: 49% clean / **35% realistic-noise** Pass@1 vs 85% for text GPT-5. | ✅ 3-0 |
| Speech corrupts *decisions*, not just hearing | 37.4% of speech-induced failures are wrong decisions about **whether to call a tool at all** (worst of 3 systems analyzed); ~54% are argument errors (= wrong player attributed). | ✅ 3-0 |
| **Over-triggering bias persists** (the confabulation proxy) | Worst-in-class selectivity: responds to 6% — i.e. nearly all — backchannels, vocal tics, non-directed speech (Gemini Live 54%, Grok 57%). Audio When2Call: better at calling when required (85.2%) than refraining when not (73.1%). | ✅ 3-0 |
| Audio-native decisively beats cascaded STT→LLM on spoken self-corrections | 0.588 vs 0.176 Pass@1 — the cascade's ASR finalizes the wrong transcript before the correction arrives. **Caveats:** only ~17 scenarios; the losing cascade was a full-duplex streaming agent — a per-utterance batch hybrid (or our existing slow pass) sees intra-utterance corrections in the transcript text, so 0.176 does not transfer cleanly to our design. Even the winner fails ~41% of self-corrections. | ✅ 3-0 (with caveats) |
| `2.1-mini` tool-calling regression report | One practitioner (Jul 9): identical config, model collects/confirms an order then never invokes the function (false-*negative* polarity). Unreproduced by an independent user (Jul 17); no OpenAI response. One anecdote, not a confirmed regression — but it compounds with mini's weak Confetti showing (41.4 vs 59.2). | ◐ existence verified; regression unconfirmed |

**Refuted in verification** (do not cite): "GPT-Realtime showed zero
hallucinated tool calls in no-response cases / Gemini calls tools on 86% of
silent cases" (1-2); "self-corrections are the single hardest failure mode for
all models" (1-2).

## API features needed — all confirmed present (3-0, primary docs fetched 2026-07-21)

- **Semantic VAD**: classifier over uttered words, tunable `eagerness`
  low/medium/high/auto.
- **Input noise reduction**: `near_field` / `far_field`, applied before VAD
  and the model. Fine print: modes are keyed to *microphone distance*
  (headset vs laptop/conference mic), not environmental noise; neither is
  documented for outdoor/crowd noise. For `server_vad`, the docs' only noise
  mitigation is raising the activation threshold.
- **Mid-session `session.update`** of any field except voice and model —
  tools/instructions can change for roster substitutions, including clearing
  tools.
- **Parallel input-audio transcription** runs as a separate async pass
  alongside conversation mode — the live transcript UI survives the revival.
  Fine print: the transcript is explicitly "guidance… rather than precisely
  what the model heard" — an audit trail, not ground truth; on garbled audio
  it can diverge from the emitted function calls.
- **Not verified** (research gap, prerequisites to confirm before building):
  the current GA ephemeral-token/browser-WS auth mechanism (ours works today
  on the older path — likely fine, but re-check), and `strict: true`
  enforcement on function-argument schemas in GA realtime sessions.

## Cost (rates verified digit-for-digit; per-hour model is synthesis arithmetic)

| | audio in /1M | cached audio /1M | text out /1M | est. mostly-listening hour |
|---|---|---|---|---|
| `gpt-realtime-2.1` | $32 | $0.40 | $24 | **~$2.2/hr** |
| `gpt-realtime-2.1-mini` | $10 | $0.30 | $2.40 | **~$1.0/hr** |
| current transcription-only | — | — | — | ~$0.18/hr |

Assumptions behind the hourly figure (unverified for 2.1): ~600 audio
tokens/min accrual, ~2 turns/min, cumulative re-processed cached context.
Cached context cost grows **quadratically** with uninterrupted session length
— but our narration sessions are short per-possession mic bursts, not
game-long sessions, which largely defuses this and pushes real cost toward
the fresh-audio component. Net: reviving the fast pass costs roughly
**$1–3/game-hour, a 6–12x increase that is still small in absolute terms**.
(Historical footnote: the "stale" $0.06/min figure we corrected in the last
report was approximately right *for conversation mode* — it described the
original design and was never updated for the transcription-only switch.)

## Competing routes

- **Gemini Live**: mixed picture — better Confetti tool-calling accuracy
  (70.4 vs 59.2) and far better selectivity on non-directed speech (54% vs
  6%), but worst-of-three on τ-Voice grounded tasks (31%/26%). No provider is
  reliably better across benchmarks; OpenAI wins the axis that matters most
  here (disfluency/self-correction), Gemini the not-responding-to-cross-talk
  axis. Gemini Live pricing and browser ephemeral-token support: unverified.
- **Amazon Nova Sonic**: no surviving claims — unresearched.
- **Hybrid (streaming STT partials → per-utterance Haiku 4.5 extraction)**:
  no direct benchmark exists. Synthesis view: it would see intra-utterance
  corrections in text (dodging the cascade's 0.176 trap), cost cents/hour,
  and lag speech by roughly STT-final + one short Haiku call (~2–3s) vs
  sub-second audio-native calls. It is the incremental evolution of the
  current architecture; the audio-native fast pass is the revolution. Both
  keep the slow pass as reviewer.

## Recommended pilot (if reviving)

1. **Model: `gpt-realtime-2.1`, not mini** — mini's weaker benchmarks + the
   unresolved regression report outweigh the ~$1.2/hr saving.
2. **Config**: `far_field` noise reduction (unless the coach wears a
   headset/lapel mic → `near_field`); semantic VAD, `eagerness: low` (coach
   narration has long pauses and trailing corrections); parallel
   `gpt-4o-transcribe` input transcription for the transcript UI + audit
   trail; instructions making **no-call the default** ("only emit an event
   when a player action is clearly and completely stated"), a confidence
   field on every function call; `session.update` on substitutions.
3. **Gate on an offline replay eval before any live use**: feed recorded real
   sideline audio (the hand-recorded harness scenarios, plus new outdoor
   captures) through the configured conversation-mode session and measure
   **event precision** against expected.json ground truth. The existing test
   harness (`ultistats_server/tests/narration/`) already has the
   audio + expected-events scenario format; it needs a conversation-mode
   runner path. This is the only way to answer the central question — no
   external benchmark of 2.1 exists.
4. **Wiring note**: the fast-pass code (`buildTools` / `buildInstructions` /
   `handleFunctionCall`) was *removed*, not flag-gated — recover from git
   history. The receiving side (provisional events, CONFIRM/RETRACT/ADD
   applier, conversation-mode session path and token endpoint) is intact.
5. **UX note**: the slow pass makes moderate fast-pass precision *tolerable*,
   not free — confabulated events shown live to a coach are a UX cost even if
   later retracted. Set the pilot's precision bar accordingly.

## Open questions

- Does 2.1 measurably reduce false tool calls on noisy/silent audio vs 1.5?
  (Answerable only by the in-house replay eval.)
- Current GA ephemeral-token mechanics and `strict: true` support in realtime
  sessions.
- Exact audio-token accrual and cached-context re-billing on 2.1 (swings the
  cost estimate 2–4x; mostly moot given short per-possession sessions).
- Whether Gemini Live's selectivity advantage + browser tokens could make it
  the safer fast-pass engine despite worse task scores; whether Nova Sonic
  does audio function calling at all.
