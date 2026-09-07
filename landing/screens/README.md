# Hero carousel media

Real-app screenshots for the landing-page hero carousel, captured from one
scripted game (Breakside 6 – Rival City 6, canonical roster) by
[`tests/demo/hero-shots.spec.ts`](../../tests/demo/hero-shots.spec.ts). Re-shoot
all seven whenever the in-game chrome changes:

```bash
cd tests && HERO_SHOTS=1 npx playwright test --config=playwright.demo.config.ts demo/hero-shots.spec.ts
```

To swap any slide for a different screenshot or a short looping clip (MP4/WebM),
edit the `HERO_SLIDES` array in [`../hero-carousel.js`](../hero-carousel.js):

- Drop the new file in this folder (keep the name, or update `media.src`).
- For video, set `media.type: 'video'` and point `media.src` at the `.mp4`/`.webm`.
  Videos autoplay muted + looped; supply a `poster` for the first frame if you like.
- `orientation` (`portrait` | `landscape`) controls which device frame is used —
  match it to the asset's aspect ratio.

| Slide id          | File                  | Screen                                                   |
|-------------------|-----------------------|----------------------------------------------------------|
| `simple`          | simple.png            | Simple tab — We Score / They Score / Key Play            |
| `simple-score`    | simple-score.png      | Score Attribution dialog (Assist / Goal + modifiers)     |
| `full`            | full.png              | Full tab, Offense mode (player rows + Drop/Score)        |
| `field`           | field.png             | Field tab, portrait — a throw placed on the field        |
| `field-landscape` | field-landscape.png   | Field tab, landscape full-screen takeover                |
| `line`            | line.png              | Line tab (roster, score progression, points-played)      |
| `all`             | all.png               | All tab — combined PBP + Next Line + Game Log            |

All shots are from one consistent game with the thirteenth point about a
minute old, so the header point-timer reads as mid-point rather than 0:0x.
