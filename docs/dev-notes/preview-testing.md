# Driving game flows in a browser preview

Status: current as of 2026-09-05. Hard-won setup for exercising the app end to end from an automated browser (an IDE preview pane, Playwright, or similar) against a local backend. The basics (`scripts/dev-backend.sh`, `?api=`) are in AGENTS.md; this is everything past that. The demo-video recipe is in DEMO_VIDEOS.md.

## Identity and auth bypass

- Load `?api=http://localhost:<port>&testMode=true` (localhost only). It injects a fake `test-user` session and the auth-disabled backend honours the `X-Test-User-Id` header.
- The identity is a URL parameter per load. Any in-app navigation or reload that drops `?testMode=true` bounces to `/landing/`. Recover by re-navigating with the full URL; localStorage keeps teams and game state, and an active-game "Tap to join" toast shortcuts back in.
- Seeding `test-user` a membership is required even with auth disabled, because the team list is membership-scoped. The membership JSON must include `joinedAt`, not only `createdAt`: `/api/auth/teams` reads `membership["joinedAt"]` inside a `try/except KeyError` that silently skips the row, so the list stays empty while `/api/auth/me` shows the membership fine. Minimal file: `{id, teamId, userId, role: "coach", createdAt, joinedAt}` plus both `_index.json` buckets.
- Alternate bypass if `testMode` ever regresses: anonymous visits to `/` redirect to `/landing/` unless the URL hash looks like a Supabase callback. Load `/?api=…#error_description=preview`, click `#continueWithoutAccountBtn`, stub `window.breakside.auth` (`isAuthenticated: () => true`, `getCurrentUser`, `getAccessToken: async () => null`) and call `window.showSelectTeamScreen()`. Re-apply after any reload.

## Two coaches in two tabs

`?testMode=true&testUserId=<id>` sets the fake identity per tab. Since 2026-07-19 `authFetch` sends `X-Test-User-Id`; before that every tab's requests were attributed to the default user, which produced phantom bugs (self-claims toasting "You are now Active Coach", roles "reverting"). When page and curl behaviour disagree, suspect page identity first. Seed the second user a membership directly in the dev backend's `.dev-data/<label>/memberships/`.

Caveats: both tabs share the origin's localStorage, so locally stored teams and games leak between "users" and only server-side role state is truly per-user. A backgrounded tab is throttled hard enough that its pings can gap past the server's stale timeout, so roles expire just by tab-switching. `read_page`-style accessibility output listing `checkbox "on"` does not mean checked. Role handoff auto-approves after `handoffTimeoutSeconds` if the holder does not respond. A `MutationObserver` on `#toastContainer` writing into a `window.__toastLog` array is the reliable way to catch transient toasts.

## State and roles

- In-memory game state: `window.teams.find(t => t.teamName === …).games.at(-1).points`. Live O/D mode: `window.pbpPossession.reconstructState().mode`.
- A session that joins a game after a reload does not hold Active Coach. Non-AC sessions get `refreshGameStateFromCloud` every few seconds, which **replaces** `game.points` with fresh objects (so does wake recovery). To simulate a non-AC session: `POST /api/games/{id}/release` with `{role:'activeCoach'}` and the test-user header.
- After Start Point, wait about 4.5 s before the first gesture: the post-start cloud-sync echo replaces `game.points` and silently eats an early edit.

## Re-query after every render

- Select-line checkboxes re-render the whole table after every click; a cached NodeList goes stale and later clicks silently no-op (points start with 2 players instead of 7). Query fresh per click.
- Field-mode pointer gestures must re-query `#fpField` and chips after any click that triggers `render()`; events on detached nodes do nothing.
- Full-PBP and the teams list re-render on polling cycles, so accessibility refs go stale in seconds. Most reliable: `.click()` on a freshly queried node from a script.
- Field-mode screen-to-stored coordinate mapping flips per point (attack direction) and per `flipHA` (width axis). Read the stored event back and verify against it rather than assuming screen fractions map to `{x, y}`.

## Timing under throttling

An unfocused tab throttles timers to about 1 s, so anything measured by wall clock inside the page stretches. Do not measure durations by polling. Capture the *scheduled* delay instead: wrap `window.setTimeout` from a main-world script, run the action, restore it, and read the delays the code requested. For fast async paths (for example `getUserMedia` auto-denied), read the phase synchronously right after dispatching the gesture; a 100 ms sampler can miss the round trip. `getUserMedia` is hard-blocked in automated panes, which is useful for failure paths and useless for real audio; test the WebSocket and API legs with an in-page probe or the Python runner. The mic button has no click listener: dispatch `mousedown` and `mouseup`, or drive `narrationEngine.startRecording()` directly.

## Isolated-world scripting

Tool-injected JavaScript typically runs in an isolated world: DOM shared, page globals not (`window.teams` reads undefined), and `await import('/x.js')` re-evaluates the module graph in the isolated world (module-level side effects crash, state is empty). Bridge: inject `<script type="module">` whose body imports app modules (hitting the page's module cache, same instances) and serialises results into `document.body.dataset.<key>`; read the dataset in a later call, since module scripts run deferred. A reload (for instance a service-worker update) wipes injected scripts and drops the query params. Each script execution shares one page scope, so wrap in an IIFE to avoid top-level `const` collisions.

Holding a transient boot-time element (splash overlay) still enough to screenshot: re-insert its markup, then `await import('/ui/thing.js?probe=' + Date.now())`; the distinct URL bypasses the module cache and re-runs the real logic against the fresh node. To observe a genuine cold boot, load the app in a same-origin full-viewport `<iframe>` and inspect `contentDocument` at its `load` event; `elementFromPoint(w/2, h/2)` returning the overlay proves occlusion, which a screenshot cannot.

## Hidden-pane failure modes

When nobody is watching an IDE preview pane, scroll and click actions can time out, screenshots can return a stale solid-dark buffer while the DOM is fine, and window scrolling can be clamped. Script execution keeps working: verify with DOM probes (`getBoundingClientRect`, computed styles). For a visual of an off-screen element, temporarily `position: fixed; top: 0` it, screenshot, remove. A forced reload can revive a stuck renderer. Coordinate clicks silently miss when the screenshot is scaled from the viewport; prefer scripted `.click()`.

## Demo data quirk

A pickup player added to an event roster but not the team roster resolves as a stub, not a roster Player. Any code using bare `getPlayerFromName()` misses it; use `buildPointPlayerLookup` (ARCHITECTURE.md § point.players entries). This was the actual trigger behind a July 2026 "dead Proceed button" report that a whole session first misattributed to an unmigrated team.
