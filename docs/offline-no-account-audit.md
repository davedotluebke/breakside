# Audit: "You can use Breakside without an account"

**Date:** 2026-08-16 · **Branch:** `claude/breakside-offline-audit-8ux2js` · **Commit audited:** `9cdf054`

> **Status update (same day):** the two highest-severity findings below have been
> fixed on this branch — **§6** (Sign Out destroying unsynced data) and **§4**
> (the Supabase CDN as an offline single point of failure). §5's `forceAppUpdate`
> guard and §7's persistent-storage request are still open, as is all of §1–§2.
> The findings are left below as written, describing the code *as audited*; see
> TODO.md § "Offline reliability, and account-free solo use" for what shipped.

Claim under test, from a docs draft:

> You can use Breakside without an account — data stays on the device. Cloud sync,
> multi-coach, and share links need one; sign in from the home page.

**Verdict: false as written.** There is no anonymous path into the app. A visitor
with no Supabase session is redirected to the landing page, where every call to
action opens the sign-in modal. Nothing about "data stays on the device" is
reachable, because the device-local surface is never shown to a signed-out user.

The second sentence is directionally right — cloud sync, multi-coach and share
links *do* require an account — but so does everything else.

---

## 1. Entry is hard-gated on a Supabase session

`main.js:356-363` — the only route into the app for a signed-out user is a
redirect out of it:

```js
} else {
    // User is not logged in
    if (!hasAuthCallback) {
        log('User not authenticated, redirecting to landing page');
        window.location.href = '/landing/';
        return;
    }
```

`main.js` has two fallbacks that *look* like an escape hatch — the `catch` at
line 374 and the `else` at line 379, both calling `showSelectTeamScreen(true)`
with a "running in offline mode" warning. **Both are effectively dead code:**

- `initializeAuth()` (`auth/auth.js:42-148`) catches every failure internally
  (missing `window.supabase`, missing config, client-construction throw) and
  returns normally. It never rejects, so the `catch` never fires.
- `auth/auth.js` is a static import in `main.js:63`, so `window.breakside.auth`
  is always populated by the time `initializeApp()` runs. The `else` never fires.

And `/landing/` offers nothing else: `loginBtn`, `getStartedBtn` and
`quickstartBtn` all bind to `openAuthModal` (`landing/landing.js:66-68`). The
only non-auth action on the page is "Watch Live Games" (the public viewer).

## 2. Past the gate, the team list is cloud-only anyway

Even if the redirect were removed, two more gates stand behind it.

`teams/teamList.js:34-54` — the function's own log line names the design:

```js
function showSelectTeamScreen(firsttime = false) {
    log('showSelectTeamScreen called (cloud-only mode)');
    ...
    if (!isAuthenticated) {
        teamListWarning.innerHTML = '<p>Please sign in to access your teams and games.</p>';
        showScreen('selectTeamScreen');
        return;
    }
```

There is no surviving local-teams renderer — `populateCloudTeamsAndGames()`
(`teamList.js:158+`) fetches `/api/auth/teams` and is the only list path.

Team creation (`teamList.js:845-852`) blocks unless `isAuthenticated()` **or**
`canActOffline()`. `canActOffline()` (`auth/auth.js:175-189`) returns true only
when the device is offline or Supabase is unreachable — i.e. it means "we can't
confirm you're signed out", not "you don't need an account". An *online*
signed-out user is refused.

So the offline create-and-queue machinery below it exists, but today only a
**signed-in, offline** user can reach it.

## 3. Empirical test

Set up per `CLAUDE.md`:

```bash
./scripts/dev-server.sh 3000                     # frontend
./scripts/dev-backend.sh --fresh --label audit   # isolated backend on :8000, auth disabled
```

Drove the app with the pre-installed Chromium (Playwright). Four scenarios, all
as a fresh anonymous profile:

| # | Scenario | Final URL | Result |
|---|----------|-----------|--------|
| A | `/index.html`, online | `/landing/` | redirected |
| B | `/index.html?api=http://localhost:8000` | `/landing/` | redirected |
| C | `/index.html`, browser offline | n/a | SW disabled on localhost, page won't load |
| D | `/` (root), online | `/landing/` | redirected |

Console in every case:

```
[warning] Supabase JS not loaded. Auth features disabled.
[log]     User not authenticated, redirecting to landing page
```

Landing page body text confirms where they end up: *"Sign In / Sign Up … Get
Started Free … Watch Live Games"*. `localStorage.teamsData` was **absent** — the
app never got far enough to create anything.

Note the sandbox blocks `cdn.jsdelivr.net`, which incidentally reproduced the
CDN-outage path in §4 for free.

## 4. Risk: the Supabase CDN is a single point of failure for *offline* use

This one bites signed-in users, not just the doc claim.

- `index.html:141` loads supabase-js from `https://cdn.jsdelivr.net/...`.
- `service-worker.js:67` caches only same-origin responses with
  `networkResponse.ok`. The CDN script is cross-origin, and an opaque
  cross-origin response has `ok === false` regardless — so it is **never** in
  the service-worker cache.
- If that script doesn't load, `initializeAuth()` bails at `auth/auth.js:47-51`,
  `isAuthenticated()` returns false, and `main.js` redirects to `/landing/` —
  **regardless of what is in localStorage.**

Verified directly. Seeding a device with a team, a pending sync-queue entry and a
Supabase session blob, then loading the app with the CDN unreachable:

```
final URL: http://localhost:3000/landing/
teamsData: [{"id":"Sideline-ab12","name":"Sideline FC", ... }]   ← still there
queue:     [{"type":"game","action":"update","id":"g1", ... }]   ← still there
```

The data is **stranded, not deleted** — intact in localStorage, unreachable from
the UI.

The only thing standing between users and this in the real world is the browser
HTTP cache: the service worker uses a plain `fetch(e.request)` for cross-origin
requests (`service-worker.js:55-57`), so the HTTP cache still applies and a
recently-fetched copy of the script will serve offline. I could not verify
jsDelivr's `max-age` from this sandbox (proxy returns 403), so the practical
window is unknown — but it is finite, and eviction can end it early.

**Consequence for `README.md`:** "Full functionality without internet connection"
(line 96) and "Works fully offline, syncs when connected" (line 190) are also
overstated. Offline works only while a third-party script happens to be in the
browser's HTTP cache.

## 5. Risk on upgrade — the question asked

**The upgrade itself does not delete data.** Confirmed:

- `forceAppUpdate()` (`main.js:268-290`) clears Cache Storage and reloads.
  localStorage is untouched.
- The service worker's `activate` handler (`service-worker.js:14-25`) deletes
  stale **caches** only.
- Game state is persisted continuously — 53 `saveAllTeamsData()` call sites — and
  the sync queue is localStorage-backed (`SYNC_QUEUE_KEY`, `sync.js:190-212`).

**But the reload re-runs `initializeApp()`**, and that is where the risk lands.
If the session cannot be restored at that moment — CDN unavailable per §4, device
offline, or a refresh token that has expired — the user lands on `/landing/` with
their data stranded. From there the destructive action is one tap away (§6).

Two smaller sharp edges in the same path:

- `forceAppUpdate()` has **no `isReloadUnsafe()` guard**, unlike the automatic
  service-worker reload (`main.js:190-195`) which correctly defers mid-game and
  mid-recording. The manual "Update Now" button will reload during a live game.
- `confirmAppUpdate()` (`syncStatusUI.js:250-257`) deliberately skips
  confirmation, and neither it nor `forceAppUpdate()` checks
  `getPendingSyncCount()`. Committed events survive; in-memory uncommitted point
  state does not.

## 6. Risk: Sign Out silently destroys unsynced local data

Highest-severity finding, and it gets *worse* if the docs claim ships as written.

`handleSignOut()` (`syncStatusUI.js:165-196`) → `signOut()` → `clearLocalData()`
(`auth/auth.js:368-391`), which removes:

```
teamsData, ultistats_sync_queue, ultistats_local_players,
ultistats_local_teams, ultistats_local_games
```

There is **no confirmation dialog and no `getPendingSyncCount()` check**. A coach
who recorded a tournament offline and taps Sign Out loses all of it — games and
the queue that would have uploaded them. Verified: the five `removeItem` calls
take the seeded team and queue from §4 to `null`.

This matters especially for the claim under audit: telling people "use it
locally, sign in later" makes Sign Out feel like a harmless toggle. It is not.

(`syncDeadLetter` is *not* cleared by `clearLocalData()` — a partial, accidental
consolation prize.)

## 7. Risk: localStorage is not persisted storage

No `navigator.storage.persist()` call exists anywhere in the codebase. All local
data is best-effort and evictable. On iOS Safari a non-installed PWA's storage is
subject to ITP's 7-day eviction. "Data stays on the device" currently has no
durability guarantee behind it.

---

## What it would take to make the claim true

The good news: the hard part is already built. The offline create-and-queue path
exists and is exercised (`createTeamOffline`, `addToSyncQueue`,
`processSyncQueue`), and `syncUserTeams()` (`sync.js:1309+`) **merges** rather
than clobbers — a local-only team survives a later sign-in, and its queued entry
uploads. What's missing is a way to reach any of it without a session.

Ordered by effort-to-value:

1. **Entry point** — *small, `main.js`.* Replace the unconditional redirect with
   a local-mode check. Needs a real `isLocalMode()` concept (a
   `breakside_local_mode` flag set by a "Continue without an account" button on
   the landing page), not a reuse of `canActOffline()` — that predicate means
   "auth state unknown", which is a different thing.

2. **Local team list** — *medium, `teams/teamList.js`.* Restore a local-teams
   renderer behind `showSelectTeamScreen()`'s early return and as a branch in
   `populateCloudTeamsAndGames()`. This is the bulk of the work; the "cloud-only
   mode" rewrite removed the path that used to exist. Worth checking the history
   before rebuilding from scratch.

3. **Gate by capability, not by session** — *medium, spread across
   `teams/teamSettings.js`, `teams/activeGamePolling.js`, `game/shareGame.js`,
   `game/controllerState.js`.* These should read "needs an account" and hide
   cleanly, rather than "Please sign in". This is exactly where the claim's
   second sentence becomes literally true instead of aspirational.

4. **Don't burn the sync queue while anonymous** — *small, `store/sync.js`.*
   `processSyncQueue()` (line 314) is gated on `isOnline` but **not** on
   `isAuthenticated()`. An anonymous-but-online user's queued items would 401,
   retry five times at 5s intervals (`MAX_SYNC_RETRIES`, line 255), then be
   quarantined into `syncDeadLetter` — destroying precisely the data they'd want
   uploaded at sign-up. Add an auth check so the queue simply holds.

5. **Make Sign Out non-destructive** — *small, high value, worth doing
   regardless.* Warn when `getPendingSyncCount() > 0`; don't wipe local-only data
   for an account that never had cloud data.

6. **Vendor supabase-js** — *small, high value, worth doing regardless.* Drop it
   beside `vendor/xlsx.mini.min.js` so it is same-origin and service-worker
   cacheable. Removes the §4 single point of failure and makes README's offline
   claim true.

7. **Request persistent storage** — *trivial.* `navigator.storage.persist()` on
   first data write.

8. **Sign-in migration UX** — *medium, needs a product decision.* When a local
   user signs in, do their local teams get adopted by the new account? The
   client-side merge is already additive; what's missing is the prompt and the
   server-side ownership handoff.

Items 1, 4, 5, 6 and 7 are each roughly an afternoon. Items 2 and 3 are the real
project. Item 8 is a decision before it is code.

## Suggested docs wording until then

> Breakside needs a free account. Once you're signed in it works offline —
> record a whole tournament with no signal and it syncs when you're back.

Accurate today, subject to the §4 caveat about the CDN script. If items 5 and 6
land, it becomes accurate without caveat.
