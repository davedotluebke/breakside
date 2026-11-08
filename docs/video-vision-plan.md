# Video and vision — Veo integration plan

Breakside already knows *what* happened in a game: every event, who, when, and (from the Field tab) where. A Veo Cam 3 now records *how it looked*. This plan joins the two in three moves: play the right second of video for any event; let the video fill in what the coach did not tap; let the video propose events the coach only has to confirm.

**Status (2026-10-18):** plan drafted after the Veo research in [dev-notes/veo-platform-capabilities.md](dev-notes/veo-platform-capabilities.md). Nothing is built. Decisions marked *pending* need Dave; the footage question (§ 2) gates everything past Tier 0. This supersedes the 2026-10 "video linking" design (YouTube / Vimeo embeds), which assumed footage we would never control; what survives from it is in § 3. **2026-11-08:** § 11 added, a clip-level audio-video-language-model route recorded as a plausible alternative for Tiers 3–4, not as plan of record. **Also 2026-11-08: the footage question in § 2 is resolved.** Veo confirmed in conversation that the captured footage is the camera owner's, analytics included, and gave no prospect of API or engineering help; Scenario A proceeds by fetching the panorama master through the web viewer's own endpoints (Decision 13).

## 1. What Veo gives us

| | Follow-cam (always) | Panorama master (only if Veo grants it) |
|---|---|---|
| Format | 1080p H.264, ~4.5 Mbps, 30 fps; downloadable MP4 on every plan | Two 3840×2160 HEVC lens streams, ~17 Mbps, 30 fps; exists for every recording, streamed for 90 days, cold storage after; **not downloadable through the product** |
| Camera model | Virtual pan-tilt-zoom over a fixed camera; players away from the disc are often out of frame | Fixed camera; the whole field in every frame; factory calibration (`camera_alignment`) to pitch metres |
| Veo's own data | None for ultimate | Same, plus an "action centre" track at 30 Hz in field metres (not a disc track) |
| How to get it | Download button; ask Veo support to switch the camera to **tactical** mode (wide, steady zoom) | The web viewer's own endpoints, with the owner's login (see § 2); no partner API is expected |

The rep's claim that the dual-4K footage is downloadable was resolved on 2026-11-08; see § 2.

## 2. Footage scenarios

**Scenario A — master plus calibration.** Veo supplies the panorama transport stream and the `camera_alignment` file per recording (API, export, or a documented endpoint we are allowed to call). We own a fixed-camera, calibrated, 4K-per-lens record of every game. Every tier below becomes engineering rather than research: a stable background, a per-frame homography for free, at least the follow-cam's pixels on the disc (about twice as many when the follow-cam is wide) and one generation of compression less.

**Scenario B — follow-cam only.** We own a 1080p virtual-PTZ MP4. Tier 0 and Tier 1 work unchanged. Tier 2 needs per-frame camera-pose estimation from field features (cones, lines, the far sideline) before any position is meaningful, and only the players in frame are ever tracked. Tier 3 becomes a research project. Directed Clips (hand-keyframed wide shots from the panorama, up to 15 min each, downloadable) can cover a handful of points per game for development and for showcase reels.

Both scenarios: archive the footage ourselves. Veo keeps Interactive mode for 90 days and the recording for 6–12 months; nothing we build may depend on Veo still having the game.

**Decision (2026-11-08): Scenario A, through the web viewer.** When asked directly about downloading the full-resolution dual-4K footage, Veo's sales representative said that "all captured footage is yours", confirmed on being asked again that the camera owner has full rights to the captured footage including running their own video analytics on it, and implied that their engineers were unlikely to help with the process. We read that as: no API is coming, and fetching our own recordings' panorama master and calibration through the endpoints the web viewer itself uses is within the intent of the rights Veo describes. So:

- Footage acquisition is the web app's own `/api/app/matches/<slug>/` and `/videos/` listing with the owner's login, then the `panorama/video.ts` master, the 2048×2048 transcode, the follow-cam MP4, `camera_alignment` and `ball_detections` per recording, archived to S3. Own recordings only, never a shared or public one.
- Fetch within the 90 days after processing while the renders are "available"; after that, trigger "Restore Interactive Mode" in the viewer and wait up to 24 h before fetching.
- The interface is internal and unversioned: expect it to change without notice, keep the fetcher small and separate, verify every download against its `content-length`, and keep Scenario B (follow-cam only) working as the fallback.
- Ask the rep to put the ownership statement in a reply email, and keep it with the ops notes.
- Still ask support for **tactical** recording mode: it shapes the follow-cam, which remains the viewing file for Tier 0 and the single-view input for any clip-level model test (§ 11); the master is two lens streams that need stitching or cropping before a model can look at them. The master itself is unaffected by the mode.

## 3. Decisions

| # | Decision | Status | Why |
|---|---|---|---|
| 1 | **Breakside's event stream is the ground truth; video adds pixels, timing and geometry.** Vision proposes, the coach confirms; nothing enters stats unconfirmed. | settled | Every public ultimate CV project struggles because it starts open-world. We start with the lineup, the pull, the attack direction and `at` on every event. |
| 2 | **We host the footage we use** (S3 + CloudFront, signed URLs), ingested from Veo's follow-cam download or the master. | settled (was "linking only") | Veo offers no embed or player API; share links need the recording set Public and give no programmatic seek. Linking was right for YouTube and wrong for Veo. |
| 3 | **Sync = one anchor per game plus per-point refinement.** Anchor: the coach taps "this frame is the first pull". Refinement: Tier 1's point segmentation snaps each point's clock to the video; manual anchors remain the override. | settled | A game is one continuous recording with a fixed clock; the offset is per recording, drift is small, and the automatic snap removes the chore. |
| 4 | **One recording per game in v1; multiple recordings (camera restarted, a second camera) later.** | settled | Veo produces one recording per record session; a restart mid-game is the exception. |
| 5 | **Post-game only.** No live video features. | settled | Veo processing takes up to 24 h for non-football sports. |
| 6 | **Feature order: player reels → log scrubbing → point clips and a dead-time-free game → clip export.** | settled | Reels are what players share; scrubbing is what coaches review with; export comes last because deep links do nothing on Veo and S3 clips need a cutter. |
| 7 | **Reel clip boundaries: per-event windows (throw −3/+5 s, score −5/+8 s, D −5/+3 s) until Tier 3 supplies release and catch times.** | pending | Fixed windows are predictable and need no CV. |
| 8 | **Playback UI: a modal over the Log tab and the Game Summary, driven by the replay viewer's playhead.** | pending | Keeps the five-screen navigation; `replayController` already owns "which event is current". |
| 9 | **Detector licence: Apache-2.0 model families (RT-DETR upstream, RF-DETR, D-FINE) rather than Ultralytics YOLO (AGPL).** | settled | The repo is MIT and public. |
| 10 | **No faces, no re-identification across games.** Identity comes from the lineup prior, jersey numbers and one coach tap per point; crops are not stored. | settled | Youth players; Veo's own terms already license footage to Veo for AI training, and we will not add to the exposure. |
| 11 | **The pipeline runs off the API box**: a Python batch package `breakside_vision/`, run on a Mac (MPS) for development and on an AWS GPU spot instance for whole games; results are sidecar files in S3 referenced from the game. | settled | The EC2 box is a JSON store; GPUs are rented by the hour. |
| 12 | **Veo's `ball_detections` is a prior for "where play is", never a disc track.** | settled | Measured on a 93-minute ultimate demo: it never reaches disc-flight speeds. |
| 13 | **Footage is fetched from Veo through the web viewer's own endpoints with the owner's login**: the panorama master, the 2048×2048 transcode, the follow-cam MP4, `camera_alignment` and `ball_detections` per recording, within the 90-day window, archived to S3. Own recordings only. | settled 2026-11-08 | Veo confirmed the owner's rights to the footage and to their own analytics, and offered no API; the viewer already fetches these files by URL. |

## 4. What exists today in Breakside (verified 2026-10-17)

- Per point: the seven on the line (`Point.players`, `rosterSnapshot` with numbers and gender), `startingPosition`, `startTimestamp` / `clockPending`, who pulled.
- Per event: `at` (epoch ms since 2026-09; `null` on older games and never synthesized — ARCHITECTURE.md § Event timestamps); Field-tab `from` / `to` in the normalized `{x, y}` frame (§ Field PBP spatial coordinate frame); pull `hang`; `Possession.set`.
- Consumers ready for real positions: the replay engine's actor layer (`fieldRender.js actorLayerHTML`), `eventAmend.js` (geometry → huck / reset / swing), `replayController.js` (playhead, `'entry'` listeners).
- An ingestion path for proposed events: the narration engine's ADD / RETRACT operations with `inferred_flag` and drop reasons, plus the Log-tab editor for corrections.
- Field calibration UI: none. The Field tab draws a schematic pitch; nothing maps pixels to it.

## 5. Tiers

**Tier 0 — attach, sync, watch (no CV).** Attach a recording to a game (upload the follow-cam MP4 to S3; store Veo's match slug for the link back); the anchor UI (tap the first pull); a modal player driven by the replay playhead; player reels as playlists of per-event windows; a per-point jump list. Ships first in either scenario.

**Tier 1 — point segmentation.** Detect pull → play → stop → walk-back from person detections at low fps (two clusters on the goal lines before a pull; motion energy). Outputs per-point video intervals: automatic sync (Decision 3's refinement), point clips, a dead-time-free game, and video-measured hang time to validate the Field tab's stopwatch. Scenario-independent: the follow-cam zooms out exactly between points.

**Tier 2 — player tracking → positions.** Detect and track (ByteTrack-class), split teams by kit colour, resolve identity by assignment: seven tracks ↔ seven names from the lineup prior, jersey OCR where legible, and a one-tap-per-point labelling UI for the rest. Scenario A: positions in pitch metres from the calibration, every player in every frame. Scenario B: per-frame pose from field features first; in-frame players only; distances are lower bounds. Outputs: the actor layer animates real movement; per-point distance and sprint counts as new, clearly labelled stats; `from` / `to` auto-filled for Simple- and Full-mode games; cut maps.

**Tier 3 — possession, disc, proposed events.** Infer possession from kinematics (the stationary holder and marker pair), confirm release and arrival with intermittent disc detections, map to Throw / Turnover / Pickup proposals with thrower, receiver, `from` / `to` and geometry flags; diff against the coach's stream (missing, mistimed, wrong receiver) in a review UI. Realistically Scenario A only.

**Tier 4 — the semantic long tail.** Layout and sky flags, drop vs block, why play stopped: short clips, pre-localized by Tier 3, to a vision-language model on the server, in the shape of the narration slow pass. Cost is bounded by clip count.

Tiers 3 and 4 as written assume the classical route (track, then infer). § 11 records a second route in which a video-language model answers event questions from a whole point clip without any tracking; the two are complementary and should be measured on the same fixture.

## 6. Architecture

- `breakside_vision/` (Python, sibling of `breakside_server/`, added to `scripts/deploy-excludes.txt`): `ingest` (`veo`: list the owner's recordings and fetch the master, transcode, follow-cam and sidecars per Decision 13, credentials from the environment and never in the repo; then → S3 and proxy transcodes), `segment` (Tier 1), `track` (Tier 2), `events` (Tier 3), `calib` (field corners → homography; reads Veo's `camera_alignment` when present). Code only in this repo: no footage, no weights, no fixtures with real players (ARCHITECTURE.md § Names in examples).
- Storage: `s3://<bucket>/video/<gameId>/{source.mp4 | master.ts, proxy-720.mp4, points.json, tracks.parquet, suggestions.json}`; bucket names and policies live in `breakside-ops`. Signed URLs from a new `GET /api/games/{id}/video`; coaches of the team only; share guests get nothing in v1.
- Game JSON: `video: { source: 'veo' | 'mp4', veoSlug, key, durationS, anchors: [{ eventAt, videoT }], pointOffsets: { [pointIndex]: videoT } }`. Events gain an optional `videoT` once Tier 1 or 3 refines them; `at` is never rewritten.
- Frontend: a `video/` module layer (player, sync model, reels, anchor UI, suggestion review as a Log-tab mode) at the Features position in `main.js`'s import order.
- Compute: Mac MPS for development; a `g5` spot instance for whole games (a 90-minute game at 4K dual-stream with detection at 10 fps should be on the order of an hour of GPU time; step 2 measures it). Egress about $0.09/GB: a 3 GB follow-cam watched 20 times is roughly $5.

## 7. Sequence

0. **Dave, this week:** get the rep's ownership statement in a reply email (§ 2); ask support for tactical mode; record one game with Field-tab stats so a paired fixture exists; fetch that game's follow-cam MP4, panorama master and `camera_alignment` while its renders are still "available" (Decision 13).
1. **Tier 0 spike** on the fixture: S3 upload, anchor, modal player on the replay playhead, one reel.
2. **Feasibility spike** on ten minutes of the fixture (follow-cam, and the master if A lands): person-detection recall, disc pixel size and visibility, camera-motion statistics, pose-from-cones error, the segmentation heuristic. The numbers decide Tier 2 / 3 scope.
3. Tier 1 → ship (automatic sync, point clips, dead-time-free game).
4. Tier 2 → actor replay on real tracks, auto-locations, per-point distance.
5. Tier 3 review UI (Scenario A).

## 8. Open questions for Dave

1. Hosting cost acceptance: S3 / CloudFront egress for coaches and players watching reels (estimate in § 6).
2. Minors on any team? That changes sharing defaults and whether share guests ever see video.
3. How hard to push Veo for Scenario A: a partner application, or a one-off export?
4. Reel windows (Decision 7) and the playback UI (Decision 8).
5. Whether a second, cheap fixed camera (a phone on the tripod) is worth running beside the Veo on Scenario B games, to give Tier 2 a static view.

## 9. Non-goals (v1 and v2)

Live or in-game video; hosting other teams' footage; server-side video editing beyond clip cuts; faces or cross-game re-identification; replacing the coach's tap entry; depending on Veo's internal endpoints; any Veo feature that needs Analytics 2 (football only).

## 10. Risks

- Veo's internal endpoints change, add authentication we cannot satisfy, or Veo objects despite the rep's statement: fall back to Scenario B (follow-cam only); Tier 3 stalls, Tiers 0–2 still pay for themselves. Archive early so what we already have is ours.
- The follow-cam's 4.5 Mbps smears the disc: Tier 3 on B is likely infeasible; step 2 measures it.
- Veo deletes or re-encodes: our S3 copy is the system of record from day one.
- Public repo: bucket names, keys and anything deployment-specific stay in `breakside-ops`.

## 11. A plausible alternative route: clip-level audio-video language models (not plan of record)

Added 2026-11-08 after reading NVIDIA's Sports Intelligence Playbooks (Apache-2.0, https://nvidia.github.io/sports-intelligence-playbooks/latest/, site last updated 2026-11-03). Recorded as a path we might follow, not as a decision.

**What the playbooks are.** A recipe for fine-tuning one audio-video-language model, Nemotron 3 Nano Omni (31B-parameter mixture of experts, ~3B active; video, audio, image and text in, text out; NVIDIA Open Model Agreement, commercial use allowed), on sports clips: annotate → template-generate multiple-choice and open-ended Q&A as JSONL → SFT or LoRA (NeMo AutoModel or Megatron-Bridge) → inference → evaluation (per-class MCQ accuracy plus an LLM judge) → FP8/NVFP4 quantization → vLLM serving. Reference checkpoints exist for tennis and basketball (OpenMDW-1.1). There is no detection, tracking, homography or ball tracking in it: strictly clip in, answer out. It therefore touches neither Tier 1–2 nor the Veo footage question; it is an alternative to the classical route for Tiers 3–4, and a better way to evaluate anything that claims to understand a point.

**Why it fits Breakside.** Their basketball annotation (the public BARD dataset) is structurally a Breakside point: an ordered action list per clip, each action naming the actor by jersey colour and number, the action, its result and the assister, plus a one-sentence caption per action. Ours is richer (throw flags, locations, hang time), and `summarize()` already writes the captions. Their onboarding recipe (`avlm/data_prep_example/ONBOARD_NEW_DATASET.md`) maps one-to-one: the sample is the point clip (event-based chunking, which they recommend; rally action is about a quarter of a tennis match, and ultimate is similar); actors are addressed by visible attributes, never names (our Decision 10); split by game, never by clip; report chance, majority and a duration-only baseline, because clip length tracks event count; every template carries an ambiguity filter so exactly one answer is right. Their sixteen basketball templates translate directly: who caught the pull (MCQ over the seven on the line), how the point ended (score / throwaway / drop / block / stall), who threw the assist, whether the huck completed, which action came first, throw count as a range, and an open-ended point caption.

**Reality checks.**

- Scale: a season of one team is roughly 500–1,000 point clips, 6k–12k Q&A rows. That is their small-data regime (1.6k rows from 21 matches), where constrained MCQ stayed in the low-to-mid 90s but open-ended answers were weak and sensitive to a one-second shift in clip boundaries. Throw-by-throw captions are out of reach at our scale; outcomes and attribution are plausible.
- Perception: their own finding is that jersey numbers and "who touched the ball" need the vision encoder unfrozen and per-frame encoding, and gain from higher effective resolution. Their clips are 720p60 broadcast with a basketball; ours are a 1080p30 follow-cam with a ten-pixel disc and fourteen players, sampled at 1–2 fps per the model card. Fine for outcomes and body language, blind to a disc in flight.
- Compute: the MoE recipes need expert-parallel 8, so training needs an 8×A100-80GB node even for LoRA (~30 GiB per GPU): roughly $30/h rented, so one LoRA experiment is low hundreds of dollars and a run like theirs (64 GPUs for days) is five figures. Inference is one GPU at 3–4 s per clip: BF16 needs 80 GB, FP8 fits an L40S (48 GB), NVFP4 a 32 GB card or a DGX Spark. The published sports checkpoints are BF16 only.

**What we would take from it, in order.**

1. The evaluation harness, before any model choice: generate MCQ/QA per point from Breakside events, run hosted frontier models (and the base Nemotron, if a GPU is rented for an afternoon) on about fifty point clips, score with a per-class MCQ scorer and a judge rubric like theirs. This is the AVLM half of the Step 2 feasibility spike. For structured event output, the narration harness's event precision / recall / F1 (`breakside_server/tests/narration/`) is the natural scorer.
2. Breakside as a data factory, as a by-product of Tier 1: point clips cut on our boundaries, a JSONL exporter in their row schema (`id`, `class`, `evaluation_type`, `super_category`, `fine_category`, `conversation`), splits by game. No GPU; the same artefact feeds the hosted-model path and any later fine-tune.
3. One data-model addition every vision path needs anyway: per-game kit colours for us and the opponent. We store numbers, not colours, and "the player in white #7" is how a model has to be addressed.
4. Tiers 3–4 as two routes measured on the same fixture: classical tracking (needs the panorama master; yields positions and timing) and clip-level AVLM (needs only follow-cam point clips; yields outcomes and attribution).
5. Fine-tuning Nemotron Omni or a successor is a 2027 option, gated on a season of clips and on the zero-shot benchmark coming back insufficient.

**Candidate decisions, not yet made:** evaluation harness first; kit colours per game; the point clip as the unit of any VLM call; actors addressed by colour and number in prompts; the follow-cam as the AVLM input (the panorama is for tracking).
