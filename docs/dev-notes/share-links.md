# Share links

Status: shipped (merged 2026-07-26; the public payload was narrowed to an allowlist 2026-08-23 and widened again for replay positions in 2026-09; the standalone viewer app was retired 2026-09-05 — share links now open inside the PWA). Routing chain and payload in ARCHITECTURE.md § Share Links. This note is the non-obvious infrastructure fact and its corollaries.

Last verified: 2026-09-05.

## A share link is the app, booted from the root

`/view/<hash>` has no route on any static origin; the S3 404 fallback serves the PWA's `index.html`, whose head shim bounces to `/?share=<hash>` on the same origin. `main.js initializeApp()` checks for a share hash before auth and starts a read-only guest session (`teams/shareGuest.js`) on the Review screen. The API host answers `/view/<hash>` with a 302 to the canonical www URL; it serves no copy of the app at that path.

Corollaries:

- The shim must bounce rather than boot in place, because `index.html`'s asset URLs are relative and would resolve under `/view/`. That was the "unstyled page" half of the 2026-09-02 iOS report. Keep the `?share=` form working: it is what the shim produces.
- `scripts/dev-server.sh` serves `index.html` for `/join/*` and `/view/*` so both shims are testable locally. `tests/unit/shortLinkShim.test.mjs` pins both by extracting the real shim from `index.html`; `test_shares.py::TestViewShortLink` pins the API host's redirect.
- There is exactly one renderer for a game: the Review screen. A guest sees `showGameSummaryForShare()`; a poll refresh goes through `refreshGameSummaryForShare()` so the mounted replay keeps its playhead. Event phrasing, dark mode, and stats changes reach share links with no extra work — which is why the separate viewer was retired (it had drifted on all three).
- The guest theme defaults to the device (`auto`), not the app's dark default. A stored preference on that origin still wins.

## Deploy note

The feature has a backend half (share endpoints, the `/view` redirect). Staging cannot exercise new endpoints until the backend is deployed, because staging talks to the production API. The landing "Happening on Breakside" section fails safe to hidden and the share dialog shows a friendly error until then; do not debug that as a bug.

## History

- 2026-07-26: shipped with a standalone viewer under `breakside_server/static/viewer/`, synced to `/viewer/` on each static origin and served by the API at `/static/viewer/`. Its asset paths had to stay relative because of the two prefixes, and viewer-only commits once failed to trigger the deploy (fixed 2026-08-23 with a path re-include).
- 2026-09-05 (`viewer-shell`): the viewer became a shell over the shared modules (log renderer, models, replay view) with token-based dark mode.
- 2026-09-05 (`share-route`): the viewer directory, its S3 sync steps, the API-host static mounts and the leaf-allowlist test were removed; share links became a guest route in the app.
