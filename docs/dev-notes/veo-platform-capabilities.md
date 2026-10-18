# Veo platform capabilities (for the video / vision work)

Status: research note, verified 2026-10-17 against Veo's public pages, its help-center articles (read through the Zendesk JSON API, which exposes each article's `updated_at`), the product-update feed, and the public demo matches Veo embeds on its own marketing pages. Nothing here comes from a Veo account or a private recording. Veo changes fast and the download policy is the point most likely to move: re-verify the dated items before building on them. The plan that consumes this note is [../video-vision-plan.md](../video-vision-plan.md).

## The one-paragraph version

Every Veo recording is kept in the cloud as the **dual-lens 4K master** (two HEVC 3840×2160 streams in one MPEG transport stream, about 17 Mbps together), a 2048×2048 web transcode of it that drives Interactive mode, and a 1080p H.264 **follow-cam** (about 4.5 Mbps) that Veo's AI cuts out of the panorama. Only the follow-cam can be downloaded; the panorama and Interactive views are explicitly online-only, stay available for 90 days after processing, and are then moved to cold storage (restorable within 24 h). Ultimate frisbee is listed as a follow-cam sport (capabilities article as of its 2026-08-24 edit), so full-match download works for us, but none of Veo's AI (events, analytics, player reels) runs on ultimate footage. The API is invite-only, through one's account representative. A sales claim that the "full-res dual-cam footage" can be downloaded is not supported by any document: the footage exists and is streamed, but no product surface exports it.

## What ultimate gets

Source: "Veo capabilities by sport" (article 30159089390865, edited 2026-08-24).

| Feature | Ultimate | Notes |
|---|---|---|
| Follow-cam view | yes | Ultimate is one of about eighteen follow-cam sports; "Other sports" get Interactive only |
| Interactive player (pan/zoom, panoramic) | yes | 90 days after processing, then "archived"; restore takes up to 24 h, repeatable |
| Drawing tools | yes | |
| Full-match download | yes, follow-cam only | A download exists only when a follow-cam was generated for the sport |
| AI events / AI clips | no | Football, rugby, lacrosse only |
| Analytics 2 (events, physical data, heat maps, 2D radar, Veo Vision, Player Moments) | no | Football only. Player Moments = per-player reels from shirt-number detection, football only |
| Speedrun, Lineup, Player of the Match | no | Football only |
| Livestream | works, "not officially supported" | |
| Processing time | up to 24 h for non-football | Football: about 1 h |

Recording modes (article 13887603409297, edited 2026-06-09): the camera records in **broadcast view** (zooms in and out like a TV broadcast) by default, or **tactical view**, which "consistently takes a wide-angle shot of the field while following the ball". Users cannot switch; Veo support sets it per camera on request. Tactical is the right mode for any computer-vision use of the follow-cam.

Plans (article 4450464075025, edited 2026-10-13): every plan has every Editor feature, full-match download included; plans differ only in teams, users, monthly recording hours and storage (6 months on Starter, 12 on Team / Club / Enterprise). Recording hours are consumed at upload. Storage policy (article 23485386875921): recordings are deleted after the retention period with a 30-day warning; no bulk download; an "extended storage" subscription is "in development". Saved clips survive expiry.

## What a recording consists of

Observed on public demo matches through the web app's own endpoints (`https://app.veo.co/api/app/matches/<slug>/` and `.../videos/`; the `/videos/` list is what the player reads). This is an internal, unversioned interface, not an offered one; treat the table as a snapshot of 2026-10.

| Render | Measured | Availability |
|---|---|---|
| `standard` (follow-cam) | 1920×1080 H.264 High, 29.97 fps, ~4.5 Mbps video + 128 kbps AAC; ~3.3 GB per 93 min | Downloadable. Paths distinguish `machine/` (automatic) from `human/` (hand-corrected) renders |
| `panorama`, mp4 | 2048×2048 H.264, ~8.2 Mbps; apparently the two lens images stacked (the alignment and correction files work in "stacked" coordinates) | Streams to Interactive mode for 90 days |
| `panorama`, mp2t | MPEG-TS with **two HEVC 3840×2160 streams** (left and right lens), ~30 fps each by frame count, plus AAC; ~17 Mbps total, ~6.5 GB per 50 min | Same 90 days; afterwards S3 answers `InvalidObjectState … DEEP_ARCHIVE` |

Sidecar files referenced from the same listing:

- `render_settings` → `camera_alignment-<uuid>.veo`, a 4 KB JSON despite the extension: `calibration_version` 6.0; per-lens 3×3 intrinsics and distortion; `lens_left2camera` / `lens_right2camera`; `camera2world`, `camera2presentation`, `camera2logic`; `field_width` / `field_length` (40 × 110 on the ultimate demo, a generic pitch model rather than an ultimate field); the operator-selected field corners per lens. This is the camera-to-pitch calibration the panorama is rendered and tracked with.
- `ball_detections`: a text table, header `frame,xpos,ypos,zpos,confidence,response,lock,bounds,xsmooth,zsmooth,xinter,zinter,xintersm,zintersm`, one row per frame at ~30 Hz, positions in metres on the pitch plane (`ypos` is always 0).
- `ball_corrections`: JSON keyed by frame number, the human keyframes that override the tracker in a `human/` follow-cam render.

The 4K figure was measured on a June-2026 basketball demo; the 2024 ultimate demo's panorama is already in cold storage. The camera model is not exposed; Veo lists Cam 2 and Cam 3 both as 4K / 30 fps.

## Veo's tracking is not disc tracking

The machine track for the public ultimate demo "Nationals – Mixtape" (2024-10-25, 93 min, 167,809 rows): median speed 1.7 m/s, p99 9 m/s, max 17.7 m/s; 26 bursts of at least 0.5 s above 9 m/s and 3 above 12 m/s in the whole game; `confidence` is a constant 1.0; the track never goes stationary between points. A disc in flight travels 12–25 m/s dozens of times per game, so this is an action-centre estimate: what a follow-cam needs, useful to us as a 30 Hz "where play is" prior in field metres, useless as an event detector. The same demo's follow-cam is a `human/` render with 5,693 correction keyframes about a second apart covering 88 % of the game, so the video on Veo's ultimate page does not show automatic output. The only ultimate-specific endorsement is a 2024 Columbia High School testimonial.

## Export surfaces that do exist

- Full match (follow-cam) → MP4, from the Editor or the Library, on a mobile browser too.
- Clips: individual MP4; "Download all (ZIP)"; an active filter limits the ZIP.
- **Directed Clips** (article 4454294980881): user-keyframed pan/zoom over the panorama while Interactive mode is live, up to 15 min each, unlimited, rendered server-side, downloadable. The sanctioned way to get custom-framed footage (for example a static wide shot of one point) out of the panorama.
- Playlists (article 51843347384849, 2026-10-16): cross-recording clip collections, desktop only, private to their creator, ZIP download; a merged video is "not available yet".
- Highlight reel: football only. League Exchange: match-data CSV for leagues. Sharing: a Public recording gets a view-only link with an optional start time; there is no embed or player API, and the recipient cannot download.

## API

`https://api.veo.co/` redirects to `/docs/invite-only`: "Veo API documentation is currently available to invited integration partners only. If you are evaluating a partnership or need access restored, contact your account representative with a short description of your intended use." The ideas-board thread "Veo api" (#1151, status Completed) has Veo confirming a "first version" about two years ago; a user calls it limited; later asks for analytics endpoints and player data went unanswered. Veo's terms define the Services to include "Content distributed through or interacting with various partner applications through Veo's application programming interface". The `developer.veo.co.uk` documentation that web searches return belongs to a different company (a UK coaching-video platform).

## Terms of service, as they bear on us

- Content you record is your intellectual property; the platform and everything on it except Content ("Material") is Veo's.
- Users "may not access, reproduce, download … any part of the Service or any Material except as specifically permitted". The follow-cam Download button and clip downloads are what is permitted. Pulling the panorama master or the sidecars through the app's internal endpoints, even for one's own recordings, is at best a gray area. Get it in writing (API access or an explicit OK) before building on it.
- You grant Veo a licence to use Content "for the purpose of developing, training, testing, improving, and operating Veo's products … including … generative artificial intelligence models". Relevant when players are minors.
- Reverse engineering the Products (camera, firmware) is prohibited. The Cam 3 has 96.81 GB of internal storage, no card slot, and no documented way to read recordings off it (Cam 1 owners have reported extracting its raw dual-stream files; not a path for us).

## How to re-verify

- `www.veo.com` pages are plain HTML (fetch with a browser user agent). The help centre blocks non-browsers, but its Zendesk JSON API does not: `https://support.veo.com/api/v2/help_center/en-us/articles/<id>.json` (the body is HTML; `updated_at` / `edited_at` are in the envelope), `/api/v2/help_center/en-us/articles.json?per_page=100&page=N` lists all ~200 articles, `/api/v2/help_center/articles/search.json?query=…&locale=en-us` searches. The ideas board sits behind a Cloudflare challenge; headless Chromium gets through. From a cloud session use `curl` through the proxy; `ffprobe` ignores the proxy, so probe a locally saved partial download instead.
- Key article ids: 4451733961361 (download), 4450464075025 (plans), 30159089390865 (capabilities by sport), 13887603409297 (recording modes), 10288769409425 (views), 27459477954705 (restore Interactive), 23485386875921 (storage), 4454294980881 (Directed Clips), 51843347384849 (Playlists), 27698176364817 (Player Moments), 11873714080657 (Analytics 2), 49953564466321 (Analytics versions), 37891575336849 (processing times), 22689559243537 (cam comparison), 34166787752337 (Cam 3 specs).
- Public demo matches used: `20241025-nationals-mixtape-2e53f9f8` and `20241018-sua-vs-discover-7719160b` (ultimate, 2024, tagged `other_sport`; both linked from https://www.veo.com/en-us/sport/ultimate-frisbee) and `20260627-nepsac-basketball-2-vs-andover-vs-deerfield-vea66432` (the 4K measurement).
