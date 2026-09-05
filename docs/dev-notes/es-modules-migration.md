# ES-modules migration

Status: shipped (merged 2026-07-03, production build 945). The conventions it established are in ARCHITECTURE.md § Module Loading and summarised in AGENTS.md. This note records what rode along.

## What the migration fixed on the way

All pre-existing bugs, not migration-caused, found during the shakedown:

- `authFetch` self-heals a stale `isOnline=false` on any completed round-trip.
- The pending-sync dialog shows each stuck item's `lastError`.
- Poison-pill quarantine: failures classified as offline while connectivity is provably fine cap at 10 and go to a dead-letter list, so a genuine dead zone cannot accumulate them.

## The staging incident it explained

Root-owned directories under the server's data tree (from scripts run with sudo) caused `PermissionError` on version-backup writes, which raised an unhandled 500 **without CORS headers** (Starlette's error middleware sits outside the CORS middleware), which Safari surfaced as a `TypeError: Load failed` with no status, which the client classified as offline. Three fixes followed: a `chown` on the box, a CORS-carrying exception handler, and version-backup failures degrading to a loud log instead of failing the sync. Rule that survives: never run anything that touches the data directory as root.

## Window survivors

About 83 `window.*` globals survive, each marked `// window survivor:` at its owner: e2e seams (`window.currentGame`, `window.pingController`, start/stop controller polling), generated-HTML `onclick` handlers, `main.js` bootstrap globals, the `window.breakside` namespace, back-edge hooks, and two `defineProperty` accessors. Do not add new ones.

Follow-ups are in TODO.md § ES-module migration follow-ups.
