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
| `docs/clips/*.mp4` + `.jpg` | The clips and their posters, produced by `scripts/record-demos.sh`. |
| `tests/demo/*.spec.ts` | The choreography that produces them — see DEMO_VIDEOS.md. |

Adding an entry is: write the `<article class="docs-entry">`, give its `.docs-clip` a
`data-clip="<slug>"`, and add a `test('<slug>', …)` to a demo spec. A slug with no
recorded mp4 degrades to a text-only entry at runtime (the `error` handler drops the
slot and the entry reflows to full width), so a half-recorded page is never broken —
just less illustrated.

`data-src` / `data-poster` on a slot override the path, for reusing a clip that already
ships elsewhere. The Field-mode entry uses this to point at the landing page's carousel
video instead of duplicating 760KB.

## Deliberately not covered

Each of these is a decision, not an oversight. Revisit as they change.

- **Signing in / creating an account.** Skipped on request. The page carries a one-line
  note that the app works without an account and that cloud sync, multi-coach, and share
  links need one.
- **Pre-created Lines** (`Lines…` on the Line tab, sending in a whole line). Untested by
  the author at the time of writing, so not documented.
- **On Deck line.** Lives on the unmerged `on-deck-line` branch. The Details entry
  describes Combined vs Separate without it; add On Deck to that entry when the branch
  merges.
- **Share links / the public live viewer.** Left out of this pass.
- **Speech narration** and **Export** are text-only entries — accurate, but no clip.
  Narration needs a real OpenAI + Claude backend and injected audio to record; export
  ends in a file download, which doesn't read as anything on screen.
- **Field mode in landscape.** Described in text; the clip is the existing portrait
  landing-page demo. A landscape clip needs a second viewport in the demo config.
- **Scoring from the Full tab** is described but not filmed — `qs-04-we-score` already
  shows the attribution dialog it opens, and the Full-tab clip is about pass entry.
