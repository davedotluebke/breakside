# Speaker Diarization for Narration — Research and Eval Scoping, September 2026

Question: can speaker diarization pick the coach's voice out of sideline
chatter, and what would it take to find out? Prompted by NVIDIA's
Nemotron 3 Diarization release (2026-09-23). Companion to
[narration-stt-research-2026-07.md](narration-stt-research-2026-07.md) and
[narration-realtime-events-research-2026-07.md](narration-realtime-events-research-2026-07.md).
Researched 2026-09-30 from primary sources (model card, NVIDIA blog, OpenAI
docs); nothing here has been run yet.

## Verdict

- **Nemotron 3 Diarization is real, open and small**: 100M parameters,
  OpenMDW 1.1 (commercial use allowed), streaming at 0.32–1.04 s latency,
  up to 8 speakers, and credible on standard benchmarks (DER 9–13%;
  ranked first on VoiceArena's Diarization-Bench). It **does not identify a
  person**: its labels are anonymous and arrival-ordered — `speaker_0` is
  the first voice heard and keeps that channel. There is no enrollment,
  verification or embedding feature. "Identifying one speaker out of a
  group" would be our heuristic on top of it, and our UX happens to supply
  a good one: the coach taps the mic and speaks first, so **the coach is
  `speaker_0`** for the session — as long as that holds (see the trap in
  § Fit).
- **The product-shaped alternative already exists on our vendor**:
  OpenAI's `gpt-4o-transcribe-diarize` takes 2–10 s reference clips for up
  to four *known* speakers and labels segments with their names — a
  genuine "find the coach" — at $0.006/min. But it is file-transcription
  only (the docs say explicitly it is not supported in Realtime
  transcription sessions), capped at 25 MB per file, and **does not accept
  a `prompt`**, so it loses the roster vocabulary hint the production path
  relies on for names.
- **Neither drops into the live path as-is.** Today the browser streams
  mic audio straight to OpenAI; no Breakside server ever sees audio. A live
  coach-only gate means either in-browser inference (community ONNX
  exports exist, but nobody has published phone or browser numbers) or
  relaying audio through our server (a privacy-notice change, and the
  production box has no GPU — see `breakside-ops` for the box). So the
  right first step is an **offline eval on the clips the new recorder
  produces** (`narration/clipRecorder.js`), which costs nothing and answers
  the only question that matters: does separating speakers reduce
  bystander-derived events and name errors on *our* audio?

## What Nemotron 3 Diarization is

| | |
|---|---|
| Architecture | 31-layer Transformer encoder (RoPE), Sortformer family; 80 ms encoder frames upsampled to 10 ms output; ~100M params |
| Input | 16 kHz mono (mandatory) — our 24 kHz PCM needs resampling |
| Modes | Offline (30.4 s window) or streaming with presets: 1.04 s, 0.64 s, 0.32 s input-buffer latency; unbounded length via an arrival-order speaker cache + FIFO |
| Speakers | up to 8, channels ordered by first arrival; overlapping speech handled |
| Benchmarks (DER) | DIHARD III 12.7% (1–4 speakers 9.1%), CALLHOME 9.1%, AMI SDM 11.1%, AliMeeting 6.4%; AISHELL-4 low-latency 9.8% vs 27.2% for Streaming Sortformer v2.1 |
| License | OpenMDW 1.1 |
| Runtimes | NeMo (Python ≥ 3.12, PyTorch), native Hugging Face Transformers, NeMo-Speech.cpp (C++), community ONNX exports (`diarizer.onnx` + external weights, stateless acoustic core — the streaming cache/FIFO logic lives outside the graph), hosted on Baseten / DeepInfra at about $0.01 per audio hour (batch HTTP, WebSocket streaming, or joint diarized transcription with Parakeet) |
| Hardware | Published speed is GPU only (RTFx 38–164× at the 1.04 s preset on an RTX PRO 5000, batched). Apple-silicon ports exist (FluidAudio/CoreML; a reported 150× RTFx on an M2 Air via the Neural Engine; Hedy runs it on iPhone natively) |
| Known limits | "Performance can still degrade on … severe noise, reverberation, far-field capture, or domain shift" — i.e. exactly a sideline; no enrollment; labels are session-local |

NVIDIA's own ASR integration guide pairs it with NeMo ASR (multitalker
Parakeet or Nemotron 3.5 ASR) by **masking each speaker's stream with the
diarization activity** before recognition — the same idea as a coach-only
gate, in their stack rather than OpenAI's.

## Fit with our pipeline

Where speech confusion actually hurts us today: (1) the recognizer
transcribes bystanders, and the slow pass or lineup pass then extracts
events or player names from speech the coach never said; (2) names are
misheard. Diarization addresses (1) directly and (2) only indirectly (less
non-coach audio competing with the vocabulary hint).

Three places a speaker gate could sit:

- **A. In the browser, before `input_audio_buffer.append`** — mask or drop
  frames where the coach's channel is inactive. Keeps the architecture
  (no audio touches our server). Needs ONNX Runtime Web on a phone: a
  ~100M-parameter model is ~200 MB in fp16, ~100 MB int8, cacheable once;
  compute at the 1.04 s preset is unmeasured in browsers. iOS Safari has
  WebGPU as of iOS 26; whether it is fast enough is the open question.
- **B. Relay audio through our server** — simplest to build, but changes
  the privacy notice ("streamed from your browser to OpenAI" becomes
  "through Breakside"), and the production box is CPU-only.
- **C. Post-hoc, on the recorded session** — run diarization (Nemotron
  offline, or OpenAI's diarize model with a coach reference clip) over the
  whole session at stop and hand the slow pass a coach-only transcript.
  Fixes the slow/lineup passes but not the live transcript; also needs
  audio to reach a server (ours, or OpenAI's file endpoint — which the
  browser cannot call with an ephemeral token).

The **`speaker_0` trap**: if bystanders talk between the mic tap and the
coach's first words, the coach lands on a later channel. Phase 0 measures
how often that happens on real clips; if it matters, Phase 2 adds a small
speaker-embedding model (NeMo TitaNet / ECAPA, ~20 MB) with a one-time
coach enrollment to choose the channel — Nemotron itself cannot.

## Eval plan

**Prerequisite** — rebase the unmerged `fastpass-eval` branch onto `main`
(it holds the noise probes 023–025, the TTS mix generators and the
`fastpass_eval.py` driver that this reuses); the server directory was
renamed since, so use `git -c merge.directoryRenames=true rebase main`.

**Phase 0 — offline feasibility (1–2 sessions, no API spend)**

1. *Ground truth.* Extend `generate_noise_audio.py` to emit RTTM references
   for its mixes — exact by construction, since it places every TTS clip at
   a known offset: 024 (chatter only, coach absent), 025 (coach over two
   chatter voices), plus new mixes with the coach at several SNRs and with
   chatter *before* the coach speaks (the trap). Hand-label 022 (65 s real
   field audio) coarsely as coach / other. Real recorder clips as they
   arrive, labelled the same way.
2. *Diarize.* Run Nemotron 3 on the M2 (NeMo, CPU/MPS is fine offline;
   ~16 GB RAM) in offline mode and at the 1.04 s and 0.32 s streaming
   presets on 16 kHz resamples. Score DER, and the metric we care about:
   **coach-channel purity and coverage** — frame precision/recall of
   `speaker_0` (and of "most-active channel") against the coach reference.
3. *Downstream.* Add a `--coach-filter` to the eval driver: mask non-coach
   frames, run the unchanged transcription + slow pass (vocabulary hint and
   all), and compare WER on coach speech and event / lineup precision and
   recall against the unfiltered run, three runs each (variance is large;
   see [dev-notes/fastpass-eval.md](dev-notes/fastpass-eval.md)).

Acceptance bar to bother with Phase 2: on chatter mixes, coach-channel
frame precision ≥ 0.95 and recall ≥ 0.90 at the 1.04 s preset;
bystander-derived false events and names drop to zero on the 024/025-type
probes with no more than a few points of coach recall lost.

**Phase 1 — OpenAI diarize comparison (½ session, cents)**

Same clips through `/v1/audio/transcriptions` with
`gpt-4o-transcribe-diarize`, `response_format=diarized_json` and a 5 s
coach reference cut from the clip's own start; keep the coach's segments;
same downstream metrics. The point is to learn whether known-speaker
labelling beats the arrival-order heuristic by enough to justify path C,
and how much the missing vocabulary hint costs on names.

**Phase 2 — only if Phase 0 clears the bar (one research session before any product code)**

Browser feasibility numbers for path A (ONNX Runtime Web + WebGPU on an
iPhone: model size, load time, real-time factor at 1.04 s), the enrollment
add-on for the trap, and a decision between A and C. Product wiring is a
separate approval, as with the fast-pass pilot.

## Related options noticed on the way

- `gpt-live-transcribe` ($0.017/min) and `gpt-transcribe` ($0.0045/min)
  are newer OpenAI recognizers than the `gpt-4o-mini-transcribe` we run
  ($0.003/min); a plain STT-model swap is a cheaper first experiment for
  the name-accuracy complaint and needs no diarization.
- A fully NVIDIA stack (Nemotron 3 Diarization + Parakeet/Nemotron 3.5 ASR,
  hosted on Baseten by the audio hour) would be a vendor change for the
  whole live path, not an add-on. Out of scope until Phase 0 says
  diarization is worth anything here.

## Sources

- [nvidia/Nemotron-3-Diarization model card](https://huggingface.co/nvidia/Nemotron-3-Diarization/blob/main/README.md)
- [ASR integration guide](https://huggingface.co/nvidia/Nemotron-3-Diarization/blob/main/ASR_INTEGRATION_GUIDE.md)
- [NVIDIA blog: Know Who Spoke When](https://huggingface.co/blog/nvidia/nemotron-diarization)
- [Community ONNX export](https://huggingface.co/diarizeapp/nemotron-3-diarization-onnx)
- [Baseten: Nemotron 3 Diarization hosting](https://www.baseten.co/blog/nvidia-nemotron-3-diarization/)
- [Apple-silicon ports: FluidAudio PR](https://github.com/FluidInference/FluidAudio/pull/883), [Hedy on iPhone](https://www.hedy.ai/post/nemotron-3-diarization-on-device/)
- [OpenAI speech-to-text guide (diarize model)](https://developers.openai.com/api/docs/guides/speech-to-text), [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [MarkTechPost release summary](https://www.marktechpost.com/2026/09/23/nvidia-releases-nemotron-3-diarization/)
