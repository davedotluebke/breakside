# The documentation page (`/docs.html`)

One page, three sections — **Quickstart**, **Details**, **Advanced** — with a terse
factual entry per feature and a short silent clip beside it. Linked from the landing
page's Quickstart card. Not linked from the in-game menu (deliberate: the app's own menu
stays about the game).

## Files

| Path | What |
|------|------|
| `docs.html` | The page. Copy lives here; clips are built from `data-clip` slugs by the inline script. |
| `docs.css` | Page layout. Design tokens come from `landing/landing.css`, which the page also loads. |
| `docs/clips/<theme>/*.mp4` + `.jpg` | The clips and their posters, produced by `scripts/record-demos.sh`. Every clip exists in `light/` and `dark/`. |
| `tests/demo/*.spec.ts` | The choreography that produces them — see DEMO_VIDEOS.md. |

Adding an entry is: write the `<article class="docs-entry">`, give its `.docs-clip` a
`data-clip="<slug>"`, and add a `test('<slug>', …)` to a demo spec. A slug with no
recorded mp4 degrades to a text-only entry at runtime (the `error` handler drops the
slot and the entry reflows to full width), so a half-recorded page is never broken —
just less illustrated.

`data-src` / `data-poster` on a slot override the path; a `{theme}` placeholder in either
is substituted at runtime.

**Theme.** The page reads `prefers-color-scheme` to choose `light/` or `dark/`, and swaps
both sources if the OS setting changes while the page is open. `docs.css` carries a
matching pair of palettes — dark phone screenshots on a white page is the mismatch the
two passes exist to avoid. The phone bezel and the screen behind the video stay dark in
both themes; they're a physical object, not page furniture.

**Playback.** Clips loop while they're on screen: rest ~1.6s on the final frame (the
payoff each clip was choreographed to end on), dip to black over 320ms, rewind unseen,
and come back up at the top. The dip is what makes a restart read as a restart instead of
a glitch — black rather than the page colour, because what's going dark is a phone
screen, which is also why the same treatment works in both palettes. A wipe was the other
candidate and lost for being directional: it competes with the app's own motion inside
the frame.

`FADE_MS` in docs.html and `.device-shade`'s transition in docs.css have to agree.

Only on-screen clips play, so the page costs about one video at a time. There's no replay
control because looping makes one unnecessary, and `prefers-reduced-motion` leaves the
posters up instead.

## Deliberately not covered

Each of these is a decision, not an oversight. Revisit as they change.

- **Signing in / creating an account.** Skipped on request. The page carries a one-line
  note that an account is required and that the app works offline once signed in.
  It previously said the opposite — "you can use Breakside without an account" — which
  was never true: entry is hard-gated on a Supabase session. That claim is what
  prompted `docs/offline-no-account-audit.md`. Don't reinstate it unless §1 of that
  audit actually ships.
- **Pre-created Lines** (`Lines…` on the Line tab, sending in a whole line). Untested by
  the author at the time of writing, so not documented.
- **Share links / the public live viewer.** Left out of this pass.
- **Speech narration** and **Export** are text-only entries — accurate, but no clip.
  Narration needs a real OpenAI + Claude backend and injected audio to record; export
  ends in a file download, which doesn't read as anything on screen.
- **Field mode in landscape.** Described in text; the clip is portrait. A landscape clip
  needs a second viewport in the demo config. (The Field entry used to borrow the landing
  page's carousel video, which exists only in light — it now has its own clip in both
  themes, recorded by `tests/demo/field.spec.ts`.)
- **Scoring from the Full tab** is described but not filmed — `qs-04-we-score` already
  shows the attribution dialog it opens, and the Full-tab clip is about pass entry.
