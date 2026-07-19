# Narration STT Research — July 2026

Research dive into the speech-to-text landscape, looking for **cheaper** and/or
**lower-latency** alternatives to the current narration pipeline (OpenAI Realtime
WebSocket transcription + Claude slow-pass event extraction). Conducted
2026-07-19 via a multi-agent verified-research harness: 24 sources fetched, 113
claims extracted, top 25 adversarially verified (3-vote panels), 23 confirmed /
2 refuted. Prices are vendor-published rates as fetched on 2026-07-19 and can
change without notice.

## TL;DR

1. **Our cost premise was stale by ~20x.** ARCHITECTURE.md said the fast pass
   costs ~$0.06/min. OpenAI's official pricing lists `gpt-4o-mini-transcribe`
   at **$0.003/min** ($1.25/1M audio tokens), and OpenAI's realtime-costs guide
   states transcription-intent Realtime sessions bill by audio duration at
   transcription rates — not speech-to-speech rates. At tens of game-hours per
   month the fast pass costs **$1–2/month**, and with corrected numbers the
   **Claude slow pass is now the majority of narration spend** (~$0.35/game vs
   ~$0.10–0.20/game of audio). Verified 3-0 against OpenAI's own pricing page.
   *(Repo docs corrected as part of this research. Residual check: read a
   month's OpenAI usage dashboard to confirm streamed sessions actually bill at
   the batch-estimate rate.)*
2. **"Cheaper" is mostly already achieved.** Nothing hosted is meaningfully
   cheaper than $0.003/min at our scale. AssemblyAI's $0.15/hr base
   (~$0.0025/min) is marginally cheaper; Gladia's 10 free hours/month could
   zero out a chunk of usage. Neither justifies a migration on cost alone.
3. **"Lower latency" has two levers.** The perceived wait is dominated by the
   slow pass (Claude Sonnet call after tapping stop, up to 2048 output tokens,
   30s timeout budget). Switching it to **Claude Haiku 4.5** (3x cheaper, meaningfully
   faster, one env var: `NARRATION_SLOW_MODEL=claude-haiku-4-5`) and validating
   with the existing audio regression harness is the highest-leverage change in
   the whole report. On the fast-pass side, Gladia/Deepgram/AssemblyAI all
   advertise sub-300ms streaming partials and all have verified
   ephemeral-token flows nearly isomorphic to our current design.
4. **On-device is the only path that is both cheaper AND potentially faster —
   and it adds offline narration.** Moonshine v2 streaming models via
   `moonshine-js` (WebGPU/WASM, MIT, zero marginal cost), newly plausible on
   iOS since Safari 26 shipped default-on WebGPU (Sept 2025). But
   noisy-sideline accuracy, roster-name biasing, and 90-minute battery/thermal
   are all unproven — treat as a staged experiment behind the existing
   pipeline, not a replacement.

---

## Current system baseline

| Stage | What happens | Cost (verified) | Latency |
|---|---|---|---|
| Token mint | `POST /api/narration/token` → OpenAI REST → ephemeral `client_secret` | free | ~0.5–1s of the tap-to-listening delay |
| Fast pass | Browser WS → OpenAI Realtime, transcription intent, `gpt-4o-mini-transcribe`, PCM16 | **$0.003/min** (docs said $0.06/min — wrong) | streaming deltas; VAD-gated finals |
| Slow pass | transcript + roster + context → Claude Sonnet 4.5 → ADD ops | ~$0.014/call (2K in / 500 out @ $3/$15) | **dominant perceived wait** after stop; `max_tokens: 2048`, 30s timeout |
| Game total | ~25 possessions, sporadic narration | **~$0.35–1.00** (not $2–4) | — |

Upgrade note: full `gpt-4o-transcribe` is $0.006/min — an accuracy upgrade
would cost ~$2–9/month extra at our scale (verified 3-0). Also verified: the
July-2026 `gpt-realtime-2.1-mini` audio rate card is $10/1M audio-in, $0.30/1M
cached, $20/1M audio-out — relevant only if a session were ever billed at
realtime audio-token rates, which the pricing guide says transcription-only
sessions are not.

## Hosted streaming STT comparison

**Verification key:** ✅ = survived 3-vote adversarial verification against
primary sources; ◐ = extracted from primary vendor docs but not
adversarially verified (verification budget cut); ✗ = claim refuted or
unverifiable.

| Provider | Streaming price | Latency (vendor-claimed) | Roster/jargon biasing | Browser WS + ephemeral token |
|---|---|---|---|---|
| **OpenAI (current)** | ✅ $0.003/min mini, $0.006/min full | not benchmarked this dive | prompt field (in use today via Advanced Settings) | ✅ in production today |
| **Gladia** | ✅ $0.75/hr = $0.0125/min, **10 free hrs/mo** (1 concurrent live session, 3h/session — fine for one sideline narrator); Growth commit as low as $0.25/hr | ✅ sub-300ms partials (self-reported 103–270ms; finals ~698ms) | ✗ not documented on pages fetched — must verify | ✗ token flow unverified — check before committing |
| **AssemblyAI** | ◐ $0.15/hr base + $0.04/hr keyterms ≈ $0.0032/min with biasing | ◐ 300–600ms median (third-party blog) | ◐ keyterms: 100/session (50 chars each), query params on WS URL, updatable mid-session; Universal-3 Pro (Mar 2026): up to 1,000 words, updatable mid-stream | ✅ `GET streaming.assemblyai.com/v3/token` (expires 1–600s, session cap 3h) |
| **Deepgram** | not verified this dive (Soniox's comparison page claims $0.39–0.55/hr with add-ons — hostile source, treat as unverified) | ◐ Flux end-of-turn ~260ms (third-party blog) | ◐ Keyterm Prompting on Nova-3 + Flux, streaming supported, 100 terms/500 tokens, no per-term weights; Flux allows mid-stream keyterm updates without reconnecting; vendor-documented confidence gains on domain words | ✅ `POST /v1/auth/grant` → 30s-TTL JWT (configurable ≤3600s); token only needs to be valid at connect time — socket stays open past expiry; reconnects need a fresh mint |
| **Soniox** | ✗ pricing unverifiable ($0.12/hr claim refuted 1-2; vendor's own June-2026 page says $0.10–0.12/hr) | not verified | not verified | ✅ direct browser→API stream, `POST /v1/auth/temporary-api-key` (`usage_type: transcribe_websocket`, ≤3600s, optional single-use), official browser SDK `soniox/speech-to-text-web` |
| **Speechmatics** | not verified | not verified | ◐ `additional_vocab` up to 1000 words/phrases, works in realtime, `sounds_like` alternate pronunciations, dictionary cached after first session | not verified |
| **Groq-hosted Whisper** | ◐ $0.04/hr (~$0.0007/min) — **batch, not streaming** | n/a | n/a | n/a |

**Not covered** (no surviving claims; would need a follow-up dive): ElevenLabs
Scribe (incl. any realtime version), Google Chirp/Gemini Live, Mistral
Voxtral, Amazon Transcribe, Fireworks-hosted Whisper.

Note on the biasing column: this was flagged "unverified everywhere" in the
verified report because those claims were cut by the verification budget, but
the underlying sources are the vendors' own docs pages (Deepgram keyterm docs,
AssemblyAI keyterms docs + Universal-3 Pro launch post, Speechmatics custom
dictionary docs), extracted with direct quotes. Confidence is high-but-not-
adversarially-verified. One accuracy-relevant vendor claim, for calibration
only: AssemblyAI's own benchmark says domain terms fail at 3–5x the rate of
general speech and claims 21% better Missed Entity Rate than Deepgram Nova-3 —
vendor marketing, unverified.

## On-device / in-browser

All findings below verified 3-0 unless noted.

- **Moonshine v2** (arXiv 2602.12241, Feb 2026): architecturally true
  streaming ASR — sliding-window self-attention encoder, linear cost, ~80ms
  lookahead, incremental emission (decoder still full-attention
  autoregressive). Three phone-feasible sizes: Tiny 34M / Small 123M / Medium
  245M params (~60–500MB by quantization; self-reported latencies 50/148/258ms).
  Self-reported Open-ASR WER 12.01 / 7.84 / 6.65% — **clean-benchmark, author-
  reported numbers; not outdoor-sideline conditions.**
- **moonshine-js**: fully local in-browser streaming (ONNX Runtime Web, WebGPU
  with WASM fallback), MIT English model, no API key. Live-caption-style
  `onTranscriptionUpdated` partials + `onTranscriptionCommitted` finals —
  functionally matches our current partials/finals interaction. Ships a Web
  Speech API polyfill and installs via plain CDN script — fits the no-bundler
  PWA. Caveats: beta; streaming mode requires `useVAD=false`; model weights
  come from a CDN on first use (must be service-worker-cached for offline);
  npm latest 0.1.29 (Jul 2025) — check activity before adopting.
- **WebGPU on iOS**: Transformers.js v3 (Oct 2024) claims "up to 100x faster
  than WASM" (independent benchmarks 10–64x on non-tiny models). Safari
  shipped WebGPU **default-on in Safari 26 / iOS 26, September 2025** — so
  stock current-OS iPhones can run it, but older-OS users fall back to WASM.
- **sherpa-onnx**: second viable runtime — streaming Zipformer via WASM in the
  browser, fully offline, actively maintained (release 2026-07-09). Supports
  keyword spotting/hotwords (◐ — the closest thing to roster biasing any
  on-device option offers). Caveat: WASM builds compile a specific model into
  the bundle; not a general drop-in JS library.
- **Unknowns that gate adoption** (explicitly unverified): accuracy on noisy
  outdoor sideline audio vs `gpt-4o-mini-transcribe`; any roster-name biasing
  mechanism in moonshine-js; battery/thermal on a mid-range phone across a
  90-minute game; iOS Safari real-world performance.
- **Not researched / no surviving claims**: Web Speech API quality per
  platform; Vosk; NVIDIA Parakeet browser ports. Apple's
  SpeechAnalyzer/SpeechTranscriber (iOS 26) is a native Swift framework —
  there is no web-exposed API, so a PWA cannot reach it directly (reasoned
  from platform architecture, not verified this dive; the only browser-native
  path on iOS remains the Web Speech API or in-page WASM/WebGPU inference).

## Slow pass (event extraction)

Pricing verified against Anthropic's live pricing page (fetched 2026-07-19)
and the claude-api reference:

| Model | Input | Output | Cache write (5m) | Cache read | Notes |
|---|---|---|---|---|---|
| Claude Sonnet 4.5 (current) | $3/MTok | $15/MTok | $3.75 | $0.30 | now a legacy-tier model |
| **Claude Haiku 4.5** | $1/MTok | $5/MTok | $1.25 | $0.10 | ~1/3 cost; SWE-bench 73.3 vs Sonnet 4.5's 77.2 (◐ third-party) |

- **Latency is the real motive, not cost** — the whole slow pass is cents per
  game. Haiku 4.5 generates output substantially faster, which directly cuts
  the stop→events wait the coach experiences.
- Trial is nearly free: `NARRATION_SLOW_MODEL=claude-haiku-4-5` (the existing
  env override) + run `ultistats_server/tests/narration/` for WER/event-F1
  regression. No code change.
- Prompt caching: the static prompt prefix (system instructions + operation
  schema) could be cached; only pays off if calls land within the 5-minute
  TTL — true during active narration (one call per possession). Marginal
  dollars, but cache reads also cut time-to-first-token a bit.
- Batch API (50% off) is useless here — asynchronous turnaround defeats the
  purpose.
- No hosted STT's built-in entity/keyword handling replaces the LLM step —
  keyterm boosting improves the *transcript*, not the structured extraction.
  The two-pass architecture stands.

## Self-hosted ASR on the EC2 box

NVIDIA Parakeet TDT 0.6B v3 INT8 runs ~30x faster than realtime on a desktop
i7-12700K (◐, project-reported), so CPU ASR is computationally plausible — but
the EC2 instance is far weaker than that benchmark CPU, it would be
batch-after-the-fact rather than live streaming to the phone, and it would
save at most ~$2/month against real ops burden. **Not worth it at this scale.**

## Recommendations

### Cheaper
1. **Done: fix the docs, keep the architecture.** The current pipeline is
   already near the hosted floor (~$2–6/month all-in). Confirm once against
   the OpenAI usage dashboard.
2. If squeezing further ever matters: Gladia's 10 free hrs/month, or
   AssemblyAI at $0.15/hr. Neither is worth a quality-risking migration today.
3. Actual next cost lever if one is wanted: slow pass → Haiku 4.5 (cuts the
   now-dominant cost component 3x) — but do it for latency, not cost.

### Lower latency
1. **Slow pass → Claude Haiku 4.5** via `NARRATION_SLOW_MODEL`, validated with
   the audio regression harness. Highest impact per unit effort in this report.
2. Consider streaming the finalize response (Anthropic streaming API) and
   applying ADD ops as they parse, so first events land before the full
   response completes. Moderate frontend/backend change.
3. Fast-pass partial latency: if live-transcript feel needs improving, Gladia
   (sub-300ms partials) or Deepgram/AssemblyAI/Soniox — all with verified
   ephemeral-token flows that drop into the existing FastAPI-mint +
   browser-WS design. Migration effort per provider: swap the mint endpoint's
   upstream call + a client adapter for socket URL/subprotocol and message
   format (browser JS can't set Authorization headers — token goes in
   `Sec-WebSocket-Protocol` or a query param, both documented at Deepgram/
   AssemblyAI/Soniox). Measure current OpenAI partial latency first; it may
   already be fine.

### Both (and offline)
- **Staged Moonshine v2 experiment**: (1) benchmark Small/Medium offline
  against recorded sideline audio using the existing test-harness WER
  tooling; (2) if quality holds, wire moonshine-js behind an Advanced
  Settings flag as an alternative fast pass (slow pass unchanged); (3) field
  test for battery/thermal on iPhone (iOS 26) and mid-range Android;
  (4) service-worker-cache the model weights → offline narration, a genuine
  offline-first PWA win no hosted option can match. Keep the OpenAI path as
  default until the experiment clears the quality bar.

## Refuted / unverified callouts

- **Refuted:** Soniox $0.12/hr streaming price (1-2); "Deepgram has no
  ephemeral-token flow" (0-3 — it does).
- **Vendor-marketing numbers used above but not independently measured:**
  Gladia sub-300ms (partials only; finals ~698ms self-reported); Moonshine WER
  and "parity with 6x-larger models"; AssemblyAI "21% better than Nova-3";
  Transformers.js "100x faster".
- **Coverage gaps** (no surviving verified claims): Speechmatics/ElevenLabs/
  Google/Groq-streaming/Voxtral/Amazon pricing & latency; Web Speech API
  quality; Apple SpeechAnalyzer PWA reachability; Vosk; Parakeet browser
  ports; Deepgram streaming price.
- **Billing nuance:** OpenAI's per-minute figures are labeled "estimated";
  the realtime-costs guide says transcription sessions bill by audio duration,
  but the cheapest confirmation is simply reading a month's usage dashboard.
