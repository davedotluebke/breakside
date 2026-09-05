# Invite URL flow

Status: shipped and verified on all three origins 2026-07-23 (branch `invite-url-fix`). The canonical join URL is `/landing/join.html?code=<code>`; short `/join/<code>` links are sugar that redirect there.

## What was broken, and the shape of the fix

The Team Settings invite link (`www.breakside.pro/join/CODE`) failed three ways:

1. On the static origin, S3's 404 fallback serves `index.html` for `/join/*`, and the app booted into an unknown route. Fix: an inline shim in `index.html`'s `<head>` that redirects to the canonical page before the app boots. (`/view/*` uses the same shim; see [share-links.md](share-links.md).)
2. `landing/join.js` used `window.location.origin` as its API base, dead-ending at S3. Fix: map Breakside hostnames to the API host, localhost to `:8000`, with a transient `?api=` override.
3. The FastAPI `/join/{code}` route served `join.html` directly, so the same route swallowed the page's own relative asset requests. Fix: the route is a 302, and `join.html`'s asset paths are absolute. (Note the viewer went the other way and must stay relative.)

`test_invite_redeem.py` pins the redeem lifecycle and the redirect; redeem had been untested.

## Testing the join page locally

- Backend on port 8000 (`scripts/dev-backend.sh --port 8000`), or pass `?api=http://localhost:<port>` to the join page.
- To test the short-link path, serve the repo with an S3-style 404-to-index fallback. `scripts/dev-server.sh` now does this for `/join/*` and `/view/*`.
- `landing/` pages are classic scripts: `supabaseClient` is a global `const`, not on `window`. Patch its methods from an injected main-world `<script>`, for example `supabaseClient.auth.getSession = async () => ({data:{session:{access_token:'x', user}}})`, then call the global `updateUIForUser(user)` and click `#joinTeamBtn`. An auth-disabled backend ignores the bearer and attributes the redeem to the default `test-user`.
- The in-app join flow (`teamList.js`) uses native `confirm()` and `alert()`. An automated browser pane auto-dismisses them, and a dismissed `confirm()` returns false and silently aborts; override both before clicking `#teamsJoinBtn`.
