# Share links

Status: shipped (merged 2026-07-26; the public payload was narrowed to an allowlist 2026-08-23 and widened again for replay positions in 2026-09). Routing chain and payload in ARCHITECTURE.md § Share Links. This note is the non-obvious infrastructure fact and its corollaries.

## The viewer is served same-origin, twice

Both production and staging deploy their own copy of `breakside_server/static/viewer/` to `/viewer/` on the static origin (the "Sync viewer to S3" step in the workflow and in `deploy-staging.sh`). So `/view/<hash>` bounces same-origin to `/viewer/?share=<hash>`, never to the API host. The API host also serves it at `/static/viewer/` and answers `/view/<hash>` with a 302.

Corollaries:

- The viewer's asset paths must stay **relative**, because it is served at two different paths. This is the opposite of `landing/join.html`, whose paths were made absolute for a different reason (see [invite-url-flow.md](invite-url-flow.md)).
- A viewer-only commit used to never reach S3, because the workflow's `paths-ignore` covered the whole server directory. Fixed 2026-08-23: the workflow now uses `paths` with negations and re-includes the viewer directory last.
- `scripts/dev-server.sh` serves `index.html` for `/join/*` and `/view/*` so both shims are testable locally. `tests/unit/shortLinkShim.test.mjs` pins both by extracting the real shim from `index.html`.

## Deploy note

The feature has a backend half (share endpoints, the `/view` route). Staging cannot exercise new endpoints until the backend is deployed, because staging talks to the production API. The landing "Happening on Breakside" section fails safe to hidden and the share dialog shows a friendly error until then; do not debug that as a bug.

## Verified at ship

Backend 306 passed (20 new in `test_shares.py`), unit 119, e2e 21/21, plus a live walkthrough: create listed and unlisted, revoke via dialog, viewer live score update within 3 s, mid-view revoke banner, dead-link error view, landing card with LIVE badge. Deferred follow-ups are in TODO.md under "Share-flow follow-ups".
