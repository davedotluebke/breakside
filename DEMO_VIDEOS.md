# Demo / Tutorial Videos — Production Recipe

How the demo and tutorial clips are made, in the **same style** across the series: the
Field-mode demo (`landing/screens/field-mode-demo.mp4`, the hero-carousel finale and the
"Watch a point unfold" lightbox) and the per-feature clips on the docs page
(`docs/clips/*.mp4`, shown at `/docs.html`).

The Field-mode original was produced 2026-08 in a single session, two takes. It shows one
offense point in Field mode: pickup, swing, cross-field swing, reset, swing, huck, endzone
score with attribution, ending on the field with the score at 1–0.

## Making a new clip (the short version)

The one-off scaffolding is now permanent:

| File | What it is |
|------|-----------|
| `tests/playwright.demo.config.ts` | Portrait 480×960, `video: 'on'`, `retries: 0`, its own `demo-data-dir`. `testDir: ./demo`, which the default config never looks at. |
| `tests/demo/cinema.ts` | The style, as code: the orange touch cursor, eased glides, the pacing beats, trim/OK markers. |
| `tests/demo/setup.ts` | Off-camera setup (team, roster, game, line, pull) — the fast path that gets trimmed out. |
| `tests/demo/*.spec.ts` | One `test()` per clip. |
| `scripts/record-demos.sh` | Record, then trim + encode + poster each take into `docs/clips/`. |

```bash
./scripts/record-demos.sh                    # everything
./scripts/record-demos.sh quickstart         # one spec
./scripts/record-demos.sh details full-02    # one clip (second arg is a -g regex)
```

A clip is a `test()` that ends with `holdEnding(page, '<clip-name>')`. Anatomy:

```ts
test('qs-04-we-score', async ({ page }) => {
  const t0 = Date.now();
  await makeTeamWithRoster(page, 'qs04');       // off camera
  await beginGame(page, 'offense');
  await checkWholeLine(page);
  await goToTab(page, 'simple');
  await startPoint(page);
  await page.waitForTimeout(SYNC_ECHO_WAIT);
  resetCursor();
  await markTrim(page, t0, 'qs-04-we-score');   // ← everything above is cut

  await tap(page, '#pbpWeScoreBtn', { after: BEAT.notable });
  await expect(page.locator('#scoreAttributionDialog')).toBeVisible();
  // ...
  await holdEnding(page, 'qs-04-we-score');     // hold the payoff, mark the take good
});
```

`markTrim` prints `DEMO_TRIM_MS[<clip>]=<ms>`; `holdEnding` prints `DEMO_OK[<clip>]`. The
cutter needs **both** — a take that died halfway still leaves a `video.webm` and a trim
line behind, and cutting that ships truncated footage from a run that looked green.
Without a `DEMO_OK` the previous `docs/clips/<clip>.mp4` is left alone.

## Pipeline overview

Videos are **recorded by Playwright**, not by hand and not via the in-IDE preview
(the preview pane renders as a hidden document — autoplay is blocked, timers throttle,
and there's no video capture). The e2e harness in `tests/` already provides everything:
auto-started frontend + auth-disabled backend (ports derive per worktree), a wiped
`test-data-dir`, and `tests/helpers/app.ts` for team/roster/game setup.

1. **Demo config** — a copy of `tests/playwright.config.ts` with:
   - `testMatch` pointing only at the demo spec (never let demo specs run in the real suite —
     the pre-merge hook runs the full suite on every merge to main)
   - `use: { viewport: {width: 480, height: 960}, video: {mode: 'on', size: {width: 480, height: 960}} }`
   - `retries: 0` — **mandatory**: a retry silently re-records and you ship the wrong take
   - `timeout: 180_000` — human pacing is slow; the Field demo test ran ~35s of choreography
   - `reporter: [['list']]`
2. **Demo spec** — does the boring setup off-camera, logs a trim offset, then performs
   the choreography with human pacing (details below).
3. **Post-production** — trim the setup, encode mp4, extract a poster, review frames.

For the original one-off, both files were temporary and deleted after. They are now
committed (`tests/demo/`, `tests/playwright.demo.config.ts`) and stay outside the default
config's `testDir`, so the e2e suite and the pre-merge hook never run them.

`tests/demo/_scout.spec.ts` is not a clip — it's a screenshot sweep of every screen the
clips visit, at the recording viewport. Re-run it when the UI moves; reading its output is
much cheaper than discovering a renamed selector one failed take at a time.

## The style (consistency checklist)

These are the elements that make the clips read as a series:

- **Portrait 480×960**, matching the phone-frame presentation on the landing page.
- **Fictional roster only**: `DEFAULT_PLAYERS` from `tests/helpers/app.ts`
  (Alice/Bob/Carol/Dave/Eve/Frank/Grace, numbers 1–7), team **"Breakside Demo"**,
  opponent **"Rivals"**. Never a real player name — see ARCHITECTURE.md's
  fictional-roster convention; the git history was scrubbed of real names and nothing
  may reintroduce one (in text, filenames, commit messages, *or pixels*).
- **Fake touch cursor**: Playwright videos have no cursor, so inject one via
  `page.addInitScript` — a fixed-position div following `pointermove`/`pointerdown`/`pointerup`
  (capture phase), `pointer-events: none`, `z-index: 2147483647`:
  26px ring, `background: rgba(255,90,0,.35)`, `border: 2.5px solid rgba(255,90,0,.95)`,
  soft shadow; shrinks to 18px and darkens to `.75` alpha while pressed. This orange dot
  is the series' visual signature — reuse the exact values.
- **Human pacing**: eased glides (ease-in-out interpolation, ~22 steps × ~22ms per move;
  ~14×18ms for short cursor hops). Beats: ~250ms settle before pressing, ~140ms after
  `mouse.down`, ~320ms hold before releasing a drag, 800ms between routine actions,
  1100–1400ms after a notable moment (a modifier chip lighting up, a dialog opening).
- **End on the payoff, held ~3s**: finish each clip on the screen that shows the
  feature's result (the Field demo ends on the field view with the completed point drawn
  and the 1–0 scoreboard, cursor resting under the score). The app will often auto-navigate
  somewhere else (scoring jumps to the Line tab) — deliberately navigate back to the shot
  you want before the hold.
- **Trim the setup**: record `const t0 = Date.now()` at test start, do all
  team/roster/game setup first, then `console.log('DEMO_TRIM_MS=' + (Date.now() - t0))`
  and pause ~600ms before the first on-camera action. Cut with ffmpeg at that offset —
  a brief beat of context before the first click is good; roster typing is not.
- **Suppress overlays**: pre-stamp hint toasts in the init script
  (`localStorage.setItem('breakside_hint_<id>', '<YYYY-MM-DD today>')` — e.g.
  `field-rotate`); for a series, consider the blanket `hints.hideAll` advanced setting.

## Post-production (ffmpeg, installed via homebrew)

```bash
# Trim + encode (DEMO_TRIM_MS from the test output; video is at
# tests/test-results/<spec-name>/video.webm)
ffmpeg -ss <trim-seconds> -i video.webm -c:v libx264 -pix_fmt yuv420p \
       -crf 20 -preset slow -movflags +faststart out.mp4

# Poster = final frame (the payoff shot)
ffmpeg -sseof -0.5 -i out.mp4 -frames:v 1 poster.png

# Review contact sheet — ALWAYS inspect before shipping (see lessons)
ffmpeg -i out.mp4 -vf "fps=1/2,scale=300:-1" frames/f%02d.png
```

Budget: the 34s Field demo is 762KB at these settings (~20KB/s) — short tutorial clips
will be 200–500KB each, fine for the repo and S3.

## Gotchas that cost time (don't rediscover these)

1. **Verify app state after every scripted gesture.** Take 1 *passed* and produced a
   subtly wrong video: the opening pickup was silently swallowed, so the whole point
   played out one player off. Assert the app's own feedback after each action (Field mode:
   `.fp-statusbar` shows `"<name> has the disc"`) so a broken take **fails fast** instead
   of rendering. This is the single most important lesson.
2. **The cloud refresh eats gestures — and it recurs.** ~3–5s after starting a point, a
   sync refresh ("Another coach updated the game" toast) replaces `game.points` and
   discards in-flight entry state. Wait ~4.5s after Start Point (`SYNC_ECHO_WAIT`) before
   the first gesture — but note this is not a one-off: the refresh runs on
   `sync.refreshIntervalSec` (default **10s**), so any clip with more than ~10s of
   choreography will eventually land a tap inside one and lose it. It presents as a tap
   that visibly happened and did nothing, one clip in several, in a different place each
   time. `cinema.ts` pins the interval to 120s (the setting's clamped maximum) in its init
   script; don't remove that.
3. **Field-mode drags record above the finger.** A chip drop lands `DRAG_LIFT_PX` (56px)
   *above* the pointer (the pegman's ✕). End the mouse 56px below the intended spot.
4. **Field-mode modifiers are geometry-driven.** Huck/Reset/Swing chips light automatically
   from throw geometry (huck ≥ 50% of the playing field forward; reset = meaningfully
   backward; swing = lateral travel ≥ 25% of field width — thresholds in Advanced
   Settings → Field). Choreograph throws to trigger them deliberately; you don't tap the chips.
5. **Review the frames yourself before shipping.** Both take-1 bugs (wrong pickup, ending
   on the Line tab instead of the field) were caught by extracting frames and looking,
   not by the test passing.
6. **The video records from page creation**, slightly before the test body starts — trim
   offsets are ~0.1–0.3s early, which is fine (err toward trimming slightly early).
7. Portrait Field-mode orientation: first point attacks **up** (top of screen); attack
   direction flips each point. Endzone boundaries for a 20yd endzone on a 110yd field:
   goal lines at 18.2% and 81.8% of field height.
8. **Every tab has its own Start Point button.** `#pbpStartPointBtn` (Simple/All),
   `#fullPbpStartPointBtn`, `#lineTabStartPointBtn`, `#fpStartPointBtn` (Field). Clicking
   the wrong one waits on a hidden element until the test times out — minutes of nothing,
   with no error until the end. `setup.ts`'s `startPoint()` picks whichever is visible;
   use it off-camera. On camera, name the one that belongs to the tab you're filming.
9. **`playwright.demo.config.ts` sets `outputDir: demo-results`, and Playwright wipes that
   directory at the start of every run.** Anything you want to survive the run (the
   recording log the cutter parses) has to live outside it.
10. **Parsing `DEMO_TRIM_MS[clip]=ms` in bash:** `${line#DEMO_TRIM_MS[}` reads the bracket
   as a glob character class and eats a wrong-length prefix — silently, and differently on
   each line, so the first clip cuts fine and later ones "have no take". Use `sed -nE`. Then
   strip ANSI first: the list reporter's cursor escapes interleave with the tests' stdout
   *mid-line*, so the extracted name can have an escape sequence buried inside it.
11. **`ffmpeg -ss` must come AFTER `-i` for these takes.** Playwright's VP8 webm has no
   duration header and sparse keyframes; input-side seeking makes ffmpeg stop early and
   the encoded clip ends several seconds before the payoff — a clean-looking mp4 that is
   simply missing its ending. Output-side seeking decodes from the start and is
   frame-accurate; at 30s that costs nothing.
12. **A tap can land and do nothing.** The game screen re-renders on a 3s timer
   (`startGameStateRefresh`). If that fires between a manual `mouse.down()` and
   `mouse.up()`, the two events have different targets, the browser dispatches no `click`,
   and the handler never runs — the video shows a press with no result, in a different
   place each take. Glide the cursor by hand, but press with `locator.click({delay})`,
   which re-resolves and retries when the DOM moves under it.

## Publishing lessons (landing-page integration)

- The hero carousel (`landing/hero-carousel.js`) natively supports video slides
  (`media: {type:'video', src, poster}`): a video slide plays muted from the start when
  activated and **holds the carousel until the clip ends** (45s stall guard; replays if
  hovered; rests on last frame under reduced motion). Add a slide entry + assets, done.
- The Field Mode card's lightbox (`#videoModal` in `landing/index.html` + wiring in
  `landing.js`) requests native fullscreen inside the click gesture, with
  `webkitEnterFullscreen` for iOS. Reuse this pattern for "watch" links on other cards —
  a docs site can use plain `<video controls>` instead.
- `muted` must be set as **both** property and attribute for autoplay policies.
- Staging gets overwritten by sibling sessions constantly — always deploy with a fresh
  `deployLabel` and expect to redeploy. Production (merge to main) is the only stable home.
- Frontend-only changes need no EC2 restart; the pre-merge hook runs the full e2e suite.
