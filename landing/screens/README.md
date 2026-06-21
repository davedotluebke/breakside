# Hero carousel media

These are **stylized placeholder SVGs** for the landing-page hero carousel. Replace
each with a real screenshot (PNG/JPG) or a short looping clip (MP4/WebM) of the
feature in use.

The carousel is data-driven. To swap a placeholder for a real asset, edit the
`HERO_SLIDES` array in [`../hero-carousel.js`](../hero-carousel.js):

- Drop the new file in this folder (keep the name, or update `media.src`).
- For video, set `media.type: 'video'` and point `media.src` at the `.mp4`/`.webm`.
  Videos autoplay muted + looped; supply a `poster` for the first frame if you like.
- `orientation` (`portrait` | `landscape`) controls which device frame is used —
  match it to the asset's aspect ratio.

| Slide id          | Placeholder            | Capture (real asset)                                   |
|-------------------|------------------------|--------------------------------------------------------|
| `simple`          | simple.svg             | Simple tab — We Score / They Score / Key Play          |
| `simple-score`    | simple-score.svg       | Simple tab with the Score Attribution dialog open      |
| `full`            | full-offense.svg       | Full tab in Offense mode (player rows + modifier chips)|
| `field`           | field-portrait.svg     | Field tab, portrait                                    |
| `field-landscape` | field-landscape.svg    | Field tab, landscape full-screen takeover              |
| `line`            | line.svg               | Line tab (roster, points-played, On Deck)              |
| `all`             | ../game-screenshot.png | All tab — combined panel layout (existing real shot)   |
