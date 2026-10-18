# Video and vision — Veo integration plan

Breakside already knows *what* happened in a game: every event, who, when, and (from the Field tab) where. A Veo Cam 3 now records *how it looked*. This plan joins the two in three moves: play the right second of video for any event; let the video fill in what the coach did not tap; let the video propose events the coach only has to confirm.

**Status (2026-10-18):** plan drafted after the Veo research in [dev-notes/veo-platform-capabilities.md](dev-notes/veo-platform-capabilities.md). Nothing is built. Decisions marked *pending* need Dave; the footage question (§ 2) gates everything past Tier 0. This supersedes the 2026-10 "video linking" design (YouTube / Vimeo embeds), which assumed footage we would never control; what survives from it is in § 3.

## 1. What Veo gives us

| | Follow-cam (always) | Panorama master (only if Veo grants it) |
|---|---|---|
| Format | 1080p H.264, ~4.5 Mbps, 30 fps; downloadable MP4 on every plan | Two 3840×2160 HEVC lens streams, ~17 Mbps, 30 fps; exists for every recording, streamed for 90 days, cold storage after; **not downloadable through the product** |
| Camera model | Virtual pan-tilt-zoom over a fixed camera; players away from the disc are often out of frame | Fixed camera; the whole field in every frame; factory calibration (`camera_alignment`) to pitch metres |
| Veo's own data | None for ultimate | Same, plus an "action centre" track at 30 Hz in field metres (not a disc track) |
| How to get it | Download button; ask Veo support to switch the camera to **tactical** mode (wide, steady zoom) | Partner API (invite-only, through the account rep) or written permission |

The rep's claim that the dual-4K footage is downloadable is the first thing to resolve; see § 2.

## 2. Footage scenarios

**Scenario A — master plus calibration.** Veo supplies the panorama transport stream and the `camera_alignment` file per recording (API, export, or a documented endpoint we are allowed to call). We own a fixed-camera, calibrated, 4K-per-lens record of every game. Every tier below becomes engineering rather than research: a stable background, a per-frame homography for free, at least the follow-cam's pixels on the disc (about twice as many when the follow-cam is wide) and one generation of compression less.

**Scenario B — follow-cam only.** We own a 1080p virtual-PTZ MP4. Tier 0 and Tier 1 work unchanged. Tier 2 needs per-frame camera-pose estimation from field features (cones, lines, the far sideline) before any position is meaningful, and only the players in frame are ever tracked. Tier 3 becomes a research project. Directed Clips (hand-keyframed wide shots from the panorama, up to 15 min each, downloadable) can cover a handful of points per game for development and for showcase reels.

Both scenarios: archive the footage ourselves. Veo keeps Interactive mode for 90 days and the recording for 6–12 months; nothing we build may depend on Veo still having the game.

**Decision pending (Dave):** ask the rep for A in writing: API access with a one-paragraph intended use (own-team analysis, non-commercial, open source), and the question "can the dual-4K panorama and its camera-alignment file be downloaded or fetched for our own recordings?" Until answered, design for B and keep A's hooks (a `panorama` source type, calibration ingestion) cheap.

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
| 12 | **Veo's `ball_detections`, if we ever get it, is a prior for "where play is", never a disc track.** | settled | Measured on a 93-minute ultimate demo: it never reaches disc-flight speeds. |

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

## 6. Architecture

- `breakside_vision/` (Python, sibling of `breakside_server/`, added to `scripts/deploy-excludes.txt`): `ingest` (Veo MP4 or TS → S3, proxy transcodes), `segment` (Tier 1), `track` (Tier 2), `events` (Tier 3), `calib` (field corners → homography; reads Veo's `camera_alignment` when present). Code only in this repo: no footage, no weights, no fixtures with real players (ARCHITECTURE.md § Names in examples).
- Storage: `s3://<bucket>/video/<gameId>/{source.mp4 | master.ts, proxy-720.mp4, points.json, tracks.parquet, suggestions.json}`; bucket names and policies live in `breakside-ops`. Signed URLs from a new `GET /api/games/{id}/video`; coaches of the team only; share guests get nothing in v1.
- Game JSON: `video: { source: 'veo' | 'mp4', veoSlug, key, durationS, anchors: [{ eventAt, videoT }], pointOffsets: { [pointIndex]: videoT } }`. Events gain an optional `videoT` once Tier 1 or 3 refines them; `at` is never rewritten.
- Frontend: a `video/` module layer (player, sync model, reels, anchor UI, suggestion review as a Log-tab mode) at the Features position in `main.js`'s import order.
- Compute: Mac MPS for development; a `g5` spot instance for whole games (a 90-minute game at 4K dual-stream with detection at 10 fps should be on the order of an hour of GPU time; step 2 measures it). Egress about $0.09/GB: a 3 GB follow-cam watched 20 times is roughly $5.

## 7. Sequence

0. **Dave, this week:** the written question to the rep (§ 2); request API access; ask support for tactical mode; record one game with Field-tab stats so a paired fixture exists while its Interactive mode is live; download that game's follow-cam MP4 the day it processes.
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

- Veo never grants A: Tier 3 stalls; Tiers 0–2 still pay for themselves.
- The follow-cam's 4.5 Mbps smears the disc: Tier 3 on B is likely infeasible; step 2 measures it.
- Veo deletes or re-encodes: our S3 copy is the system of record from day one.
- Public repo: bucket names, keys and anything deployment-specific stay in `breakside-ops`.
