# Breakside Roadmap

This document tracks active work, near-term improvements, and the longer-term backlog. The original framing was a "Multi-user rollout" plan; multi-user shipped, so the scope is now broader.

For deployment info and technical architecture, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

Sections, in roughly priority order:

- **Active** — what's being worked on right now
- **Near Term** — small/medium items queued behind active work
- **Backlog** — solid ideas, not yet scheduled
- **Future Enhancements** — bigger asks, deferred until after current themes stabilize

---

## Active

### 🧪 Field-test the two features shipped 2026-07-26 (share links + set tracking)

Both merged as `2405fbd` with suites green (332 backend / 133 unit / 21 e2e) and
walked through end-to-end — but only against a **local dev backend on one desktop
browser**. Nothing below has been exercised on real devices, real origins, or a
real game. Listed roughly in the order a failure would hurt most.

**Share links** — *the API half stays inert until the EC2 `git pull` + `systemctl
restart breakside`; confirm that happened before treating anything here as broken.*

- [ ] **The actual promise: mint a link in the PWA, open it logged-out on another
      device** (phone, different browser, no account). Everything else is detail.
- [ ] **`/view/<hash>` on www AND staging.** Rides the same S3 404-fallback shim as
      `/join/<code>` — and staging needed a bucket `ErrorDocument` fix before `/join`
      resolved there (see G11.5 below). Assume nothing; test both origins.
- [ ] **Live updating during a real game**: score + play-by-play should move within
      ~3s while a coach records. Then lock the phone and wake it — polling pauses
      while the tab is hidden and should catch up on resume.
- [ ] **Copy-to-clipboard on iOS Safari.** The dialog copies *after* awaiting the
      create call, and Safari can revoke the user-gesture context across an `await`.
      There's an `execCommand` fallback and the URL is visible in the row, but
      confirm the copy actually lands on a real iPhone.
- [ ] **Expiry + revoke on a live link**: a revoked link should leave a watcher on
      the last-known state under the "expired" banner, not a blank or error page.
- [ ] **"List publicly"**: game appears in the landing page's "Happening on
      Breakside" and disappears again when the share is revoked or expires.
- [ ] Worth knowing: **two viewer copies are deployed** — `www/viewer/` (S3, synced
      by the same Action) and `api/static/viewer/` (FastAPI). Share links route to
      the API copy. If the two ever diverge, check that first.

**Set tracking (zone)** — invisible until a team opts in via Team Settings → Set Tracking.

- [ ] **Does the pull-dialog set picker slow down pull recording?** That dialog is
      used under real time pressure; an extra control there is the main UX risk.
- [ ] **Phone layout for the Full-PBP `Set:` chip.** It's appended *after* the seven
      throw-modifier chips on a `nowrap` row that scrolls horizontally (verified:
      layout doesn't break) — but on a narrow screen it will sit off-screen and may
      never be discovered. Decide whether it should lead the row or get its own line.
- [ ] **Sticky default**: the pull picker pre-selects the last set used. Confirm that
      helps over a full game rather than silently mis-tagging when the D changes.
- [ ] **Multi-coach**: tag a set mid-point on one device, confirm it survives the
      sync merge and appears on the other.
- [ ] **Legacy games unchanged**: untagged possessions must read exactly as before
      in the log (no empty parens, no styling drift).
- [ ] Not built yet — stage 6 (per-set stat filters + xlsx column). See the
      *Per-possession set flag* item under Backlog.

### ✅ Temp ops cleanup — remove localhost from prod CORS (resolved 2026-07-19)

Added `http://localhost:3002` (and possibly `:3001`/`:3000`) to `ULTISTATS_ALLOWED_ORIGINS`
in `/etc/breakside/env` on EC2 so the localhost-only Claude preview could hit the prod API
while building the **Field tab** (`field-position` branch). Low risk (auth is a Bearer JWT in
`localStorage`, not reachable cross-origin), but remove it once Field-tab dev wraps up:

- [x] `ssh ec2-user@3.212.138.180`; edit `/etc/breakside/env`, drop the `http://localhost:*`
      origin(s) from `ULTISTATS_ALLOWED_ORIGINS`; `sudo systemctl restart breakside`
      *(done 2026-07-19 — inspection found **no** localhost entries anywhere in the env
      file (never persisted or already removed). Restarted anyway to pick up G2/G3;
      curl-verified: preflight from `http://localhost:3002` rejected, prod origin 200
      with allow-origin header.)*
- [x] ~~Revert the `field-tab-phase0` staging deploy / remove the `field-app` launch entry~~
      *(done — the `field-app` entry is gone from `.claude/launch.json` and staging has been
      redeployed many times since)*

### AI Narration

MVP shipped. Coach speaks naturally; the system extracts structured game events. See **AI Narration** in [ARCHITECTURE.md](ARCHITECTURE.md) for the full design. Active work going forward is the post-MVP improvements list below.

---

## Near Term

### Code-review follow-ups (see CODE_REVIEW_REPORT.md §8)

The 2026-06/07 whole-codebase review program (A1…F5) is **complete**; everything still
open from it lives in **[CODE_REVIEW_REPORT.md](CODE_REVIEW_REPORT.md) §8** (the G1–G11
punch list) — that section is the single source of truth for review follow-up work, so
cleanup items are no longer scattered across this file's sections. Status snapshot
(2026-07-19 session):

- **MERGED 2026-07-19:** **G3** backend suite green (231/0 fresh-worktree, deterministic),
  **G2** CORS-on-500s + version-backup degrade + startup writability check, **G4**
  authFetch 401-retry (+ proxy-image auth fix), **G6** game-log renderers unified
  (`utils/gameLogRenderer.js`), **G11.6** console sweep, and the
  **`point.startTimestamp`-at-score-time fix** (updateScore no longer stamps score time
  as the point start). **G2/G3 went live on EC2 2026-07-19** — `git pull` + restart done,
  service healthy, startup writability probe logged no unwritable-dir errors.
- **G7 MERGED 2026-07-19** (branch `g7-e2e-ports`): e2e ports derive per worktree (no more
  3099/8100 singleton), and the multi-coach/sleep-wake flake was root-caused — specs raced
  the offline-first first game sync (controller endpoints 404 until it lands) and slept fixed
  margins against server-side staleness; both fixed test-side (`tests/helpers/controllerApi.ts`).
  Measured: 4/64 failures before → 0/64 after (retries=0, repeat-each=8). The suite's
  `retries: 2` can likely drop after a burn-in period. Known coverage gap: the
  `visibilitychange` wake handler is still not exercised (see 04's header; overlaps G11.1).
- **FIXED 2026-07-19 — staging `/join/{code}` (G11.5).** Root cause was the **S3 website
  config**, not CloudFront: prod's bucket had `ErrorDocument: index.html` (SPA fallback),
  staging's lacked it. Dave applied `put-bucket-website` on `staging.breakside.pro`
  (IndexDocument + ErrorDocument both `index.html`) and invalidated `/join/*` on
  distribution `E12N2STN9MM8FA`. Verified: `get-bucket-website` shows the config, and
  `staging.breakside.pro/join/<code>` now serves the app's `index.html` byte-identical to
  prod (both via S3's ErrorDocument mechanism, which returns HTTP 404 with the SPA body —
  prod has always worked this way).
- **✅ DONE 2026-07-19 — prod stats spot-check (G8).** Dave pulled a prod snapshot to
  `.dev-data/prod-snapshot/` (gitignored; keep local) and the old-vs-new replay ran
  against all three teams: **Team A and Team B match exactly** (0 per-player
  diffs, 0 unresolved); **Team C's 23/24 per-player diffs are the id-keying fix
  working** — a mid-tournament mass rename on 2026-07-12 (jersey-number prefixes) split
  every player across two name buckets; id-keying reunites them, all diffs gains, team
  totals identical. Also answered: the write-migration was never run on prod (no
  `playerIds` anywhere) and isn't needed — frontend era resolvers are the stats path.
  Full findings + script caveats in CODE_REVIEW_REPORT.md §G8.
- **Verified clean (G8):** prod + staging S3 buckets contain no stray `.claude/` /
  `.vscode/` / `.worktrees/` objects (checked 2026-07-19).
- **G11.1–.2 exercised locally 2026-07-19** (two-tab multi-coach via
  `?testMode=true&testUserId=<id>` against a dev backend seeded with the real Nov-2025
  Team D vs Team E game). **Verified good:** injury-sub undo restores `point.players`
  verbatim + removes the sub event + no O/D surface flip (real id-era game); Line-tab Undo
  does a clean score-revert + empty-point back-out; role gating/View Only for the roleless
  coach; roles-expire takeover; the startTimestamp fix live on real data. **Bugs found —
  each deserves a focused session:**
  1. ✅ **FIXED 2026-07-19 (branch `fix-handoff-toast`) — handoff toasts + the real root
     cause.** Deep-dive rewrote the original diagnosis: `authFetch` never sent
     `X-Test-User-Id` (bearer-only, and the bearer is null in test mode), so EVERY
     test-mode page's requests were attributed to the backend's DEFAULT test user —
     `?testUserId=<other>` pages silently acted as the wrong user. The "false 'You are
     now Active Coach'" was a self-claim by the holder's own identity (role never moved,
     original `claimedAt` — there was never a reversal), and the e2e holder page pinged
     as the wrong user so `hasPendingHandoffForMe` stayed false (no prompt). Shipped:
     (a) `authFetchLogic` `getExtraHeaders` dep forwards the test header (test-mode only,
     prod rejects it); (b) the `handoffResolved` boolean latch → keyed
     `lastResolvedHandoffKey` (a new request always prompts — the old latch could
     suppress it for its whole lifetime); (c) **role-loss toasts**: losing a role you
     didn't give away now shows "<coach> took over <role>" (level-based transition
     detection, deduped; release/accept suppress their own); (d) throttled-tab expiry
     guard (no late auto-accept POST for an already-resolved handoff, honest "already
     resolved" toast on a 400). Pinned by a new e2e test (scenarios/03: prompt → deny →
     re-prompt → accept → external-takeover toast); suites 21/21 e2e, 74/74 unit.
  2. ✅ **FIXED 2026-07-19** (branch `claude/clever-lewin-617873`) — **Id-era
     `pendingNextLine` soft-locked Start Point.** Every place that compared stored
     line/point entries to roster names now routes through F2's era resolver:
     Line-panel checkbox render + On Deck projection (`membership.onList`), the
     Next Line header, `checkPanelGenderRatio`, the injury-sub modal render AND
     `confirmSubstitution`'s in/out diff (a raw diff on an id-era point counted the
     whole line as everyone-out/everyone-in; staying entries now keep their stored
     form, per the applyLineupCorrection convention). Re-verified live on the real
     Team-E game via dev backend: boxes render checked, header shows names, Start
     Point starts point 14 with id-era players preserved, sub in/out diff exact,
     sub-undo still restores `point.players` verbatim, O/D toggle no longer wipes
     the line. e2e spec 07 green (20/20 suite, retries as configured).
  3. ✅ **FIXED 2026-07-19** (same branch) — **Id-era display gaps:** game-log
     "Point N roster:" lines resolve to names via a new `resolvePlayerName` option
     on `buildGameLogText` (renderer stays a pure leaf; summarizeGame +
     renderGameSummaryEventLog pass `buildPointPlayerLookup` resolution — unit
     tests pin it), and the Next Line header resolves via the same lookup.
     The related `updateScore`/`revertPointScore` seam (raw-name matching for
     the legacy live counters — symmetric no-ops on id-era games) got its
     paired-migration session 2026-07-19 (branch `claude/reverent-hellman-c773a7`):
     both sides now match via `buildPointMembership` (extracted to pure
     `game/pointStats.js`, unit-tested), and each newly-scored point is stamped
     `playerStatsCounted` (serialized) so undo picks the matching that did the
     incrementing — unmarked pre-fix points revert by raw name, keeping undo on
     reopened id-era games a harmless no-op no matter how far back it chains.
     Historical id-era points keep their gap in the legacy counters by design
     (no backfill): event-derived stats (utils/eventStats.js) are the accurate
     path and already resolve ids.
  4. ✅ **FIXED 2026-07-19** (branch `worktree-zombie-point-normalizer`) —
     **Zombie point in real data.** Ground truth differed from the original
     note: the live zombie was Team-E's **point 1** (winner `""`,
     `startTimestamp` running since Nov 2025, totalPointTime 0) — point 13
     only carries a *static* 45-min banked `totalPointTime` (start==end
     score-time stamps, the old updateScore bug). All four Nov-2025 games
     had zombie markers (13/8/15/14 repaired). `deserializePointsFromServer`
     now runs `normalizePointTimers` (`store/pointTimerNormalizer.js`, pure
     leaf, unit-tested): a running `startTimestamp` is nulled when the point
     is concluded (winner/endTimestamp), a later point exists, or the marker
     is >12h from now in either direction; a genuinely live last point
     survives mid-game reloads and cloud refreshes untouched. Stale segments
     are dropped, never banked. Verified live on the real Team-E game via dev
     backend: Game-time column shows banked minutes (not ~352,7xx), and the
     repaired state syncs back to the store (self-healing). Legacy *static*
     `totalPointTime` inflation (that 45-min point 13) is left as-is by
     design — the true duration is unknowable. Unit 95/95, e2e 20/21+flaky
     pass (flaky spec clean in isolation).

### ES-module migration follow-ups (from task E1, 2026-07-03)

The frontend is now native ES modules (branch `es-modules`). Cleanups the
migration surfaced but deliberately did not do (behavior-preserving rule):

- [x] **Consolidate authFetch onto the 401-retry variant.** auth/auth.js's
      401-refresh-retry `authFetch` had been dead code since store/sync.js's
      simpler same-named global overwrote it at load time; the migration
      deleted the dead copy to preserve runtime behavior. The retry logic was
      the better implementation (B2 work) — port it into `store/sync.js`'s
      `authFetch` deliberately, with the test-mode guard intact.
      *Done (G4, branch `g4-authfetch-retry`): retry ported into
      `store/sync.js` via new pure `store/authFetchLogic.js` (single-flight
      refresh, retry-once, test-mode untouched; 14 unit tests). Also fixed
      `teamSettings.js` proxy-image raw fetch that sent no auth.*
- [x] **Delete dead code found during conversion** *(done — F2 deleted
      `updateGameSummaryRosterDisplay` + `utils/statistics.js`; the F3 cleanup
      sweep (merged 2026-07-19) deleted the remaining caller-less shims:
      `selectTeam`, `populateCloudGames`, `deleteCloudGame`, `importCloudGame`,
      `triggerManualSync`, `pullDataFromCloud`, `removeGameStatsFromRoster`,
      etc. — only historical comments reference them now)*.
- [x] **Countdown timer display**: `game/pointManagement.js`'s
      `updateTimerDisplay(seconds)` (targeting `#timerDisplay`) had been
      shadowed by `game/gameTimer.js`'s zero-arg version since gameTimer was
      introduced — its countdown ticks never updated `#timerDisplay`.
      *(Fixed on `game-events`, 2026-07-04: the countdown owns its own
      renderer now — MM:SS with the timer-normal/warning/danger colors,
      holds 00:00 in red at expiry, anchored below `#panel-header` so it
      doesn't cover the point chip, hidden when the setting is 0.)*

### Backend test suite — ✅ GREEN (G3, merged 2026-07-19)

Fixed on branch `g3-green-tests`: test paths updated to `/api/...`; the real bug was
test_api's fixture writing to the repo's **real `data/` dir** and leaking
`dependency_overrides` into later modules (that's what broke test_auth in full runs) —
all modules now use isolated tmp data dirs and restore what they patch; the suite leaves
zero files in `data/`. `test_existing_data.py` auto-skips where real data is absent
(worktrees). Narration live-LLM scenarios are **opt-in** (`NARRATION_LIVE_TESTS=1`,
marker `live_llm`) so the default run is deterministic: **fresh worktree = 231 passed /
49 skipped in ~5s**.

Remaining:
- [x] **Main-worktree `data/` cleanup** *(done 2026-07-19: purged the 7 junk
      test-game dirs plus 142 fixture teams, 118 fixture players, 134 test
      memberships, 1 share, 2 expired invites; all four indexes rebuilt.
      `test_existing_data.py` 24/24 on main and the full backend suite now
      leaves zero files in `data/`. Hazard: worktrees on pre-G3 commits still
      write fixtures into the real `data/` if backend pytest runs there —
      rebase such worktrees onto main before running backend tests.)*
- [x] Two narration scenarios (`013_hammer_sky_combo`, `019_nickname_recognition`)
      scored **F1 0.0** in the last live run *(root-caused + fixed 2026-07-19 on
      `g5-narration-fix` — unrelated to the G5 socket outage: 013 failed
      deterministically because the slow pass split "…to Ella, Ella skies…for the
      score" into two throws (the real one + a bogus Ella→Ella self-throw carrying
      sky+score); 019 ("Acer hits Hammer…") failed stochastically on the
      nickname-vs-jargon collision. Two targeted prompt rules added in
      `ultistats_server/narration.py`: catch clauses modify the SAME throw / never
      thrower==receiver, and words in player positions are player references. 013+019
      pass twice consecutively; full-corpus regression run green 2026-07-19 — 20
      passed / 0 failed / 5 skipped (the audio-less hand-record scenarios).)*

### Multi-user rollout — final items

The multi-user push is mostly done. A few items linger:

- [x] ~~PWA: Join game via URL (`/view/{game-hash}`)~~ **Shipped 2026-07-23
      (branch `share-links`) as the full share-link flow:** Share Game dialog
      (in-game hamburger + game-summary button) mints `/view/{hash}` links
      (expiry 1 day–6 months, revocable, auto-copy); `/view/{hash}` resolves on
      every origin (S3-fallback shim on www/staging, FastAPI 302 on api) into
      the standalone viewer's new **share mode**. See ARCHITECTURE.md § Share
      Links. *Server-side pieces need the EC2 restart on deploy.*
- [x] **Viewer: Show live score and play-by-play** — share mode polls a cheap
      change stamp (`/api/share/{hash}/poll`, mtime-based) every 3s and
      refetches the full game only on change; LIVE/In progress/Final badge
      (LIVE requires activity within 30 min); polling pauses when the tab is
      hidden; mid-view expiry keeps the last state under an "expired" banner.
      (The pre-existing browse viewer had been dead for anonymous visitors
      since auth hardening — every endpoint it fetched required auth.)
- [x] **Landing page: List recent public games** — "Happening on Breakside"
      section fed by `GET /api/public/games`. Listing is a per-share opt-in
      (`listed=true`, the dialog's "List publicly" checkbox) — a share link
      alone never lists the game. Hero "Watch Live Games" button retargets to
      the section while it's populated (its old `/viewer/` target is
      anonymous-empty).
- [x] **"Clear pending" in connection info** — the Online/About toast now shows
      "N pending updates waiting to sync" with a View / Clear… button opening
      the existing pending-sync dialog (reachable mid-game, unlike the
      teams-screen badge). Same branch (`share-links`).
- [ ] Share-flow follow-ups (deliberately deferred): QR code in the Share
      dialog (pairs with the invite-QR backlog item); central share-link
      management outside the dialog (Team Settings list of all team shares);
      viewer polish (fade transition on score change).

### Multi-user rollout — completed (historical)

<details>
<summary>Phase 5: optimizations</summary>

- [x] API poll endpoint with version check (avoid fetching unchanged data)
- [x] Role-based polling intervals (Active Coach: push-only, Viewer: 5s)
- [x] Server-side version tracking for optimized polling
- [x] Conflict notification toast: "Game updated by another coach"
- [x] API: `GET /api/teams/{team_id}/active-game`
- [x] Auto-join prompt when another coach starts/resumes a game

</details>

<details>
<summary>Phase 7: viewer experience</summary>

- [x] PWA: Read-only mode for Viewers (hide event buttons, "Spectating" badge, live updates)

</details>

### Offline reliability, and account-free solo use

Both items below came out of the 2026-08-16 audit in
**[docs/offline-no-account-audit.md](docs/offline-no-account-audit.md)** — which
was prompted by a docs draft claiming "you can use Breakside without an account".
That claim is false today, and checking it turned up several things that hurt
*signed-in* offline users too. The audit has the full evidence (code refs plus a
browser test against a local dev server); this is the actionable summary.

The two are separable — the first is bug-fixing, the second is a feature — but
items 1a and 1b below are prerequisites for the second either way.

#### 1. Make offline (with an account) as reliable as practical

README currently promises "Full functionality without internet connection" and
"Works fully offline, syncs when connected" (lines 96, 190). The sync layer
mostly earns that; the app *shell* does not. Four problems, roughly by severity:

- [x] **1a. Sign Out silently destroys unsynced local data.** ***(DONE 2026-08-16,
      branch `claude/breakside-offline-audit-8ux2js`.*** `handleSignOut()` now goes
      through a new `confirmSignOutWithPending()` in `teams/syncStatusUI.js`: with
      nothing pending it's unchanged (no new nagging); with items pending **and
      online** it drains the queue first — `processSyncQueue()` attempts every item
      once before returning, so the count immediately after is an honest "what's
      genuinely stuck" — and signs out silently if that clears it; only if changes
      are *still* stranded does it `confirm()`, naming the count and saying plainly
      they'll be erased, with a reason tailored to online ("check View / Clear… for
      why") vs offline ("reconnecting first would let them sync"). Cancel restores
      the button and touches nothing. `clearLocalData()` (`auth/auth.js`) now
      snapshots to `breakside_signout_backup` before wiping — best-effort,
      never throws, drops the prior backup before writing so two snapshots can't
      stack against the quota — and its five keys moved into one `LOCAL_DATA_KEYS`
      list so the backup can't drift from the removals. Verified in a browser
      across four cases (offline+pending cancel/accept, online+pending, empty
      queue); suites green: 198 unit, 21 e2e. **Follow-up left open:** there is no
      restore *UI* — recovery is currently by hand from devtools. Worth adding an
      offer-to-restore at sign-in if this ever fires in the wild.)*

      <details><summary>Original problem statement</summary>

      `handleSignOut()`
      (`teams/syncStatusUI.js:165`) → `signOut()` → `clearLocalData()`
      (`auth/auth.js:368`) removes `teamsData`, `ultistats_sync_queue`, and the
      three `ultistats_local_*` keys — **with no confirmation dialog and no
      `getPendingSyncCount()` check**. A coach who recorded a tournament with no
      signal and then taps Sign Out loses the games *and* the queue that would
      have uploaded them. The wipe exists for a good reason (don't leak one
      account's data to the next), so the fix isn't to delete it:
      *Suggested:* block on a confirm when `getPendingSyncCount() > 0`, naming
      what's at stake ("3 games haven't synced yet — signing out will discard
      them"), with a "Sync now, then sign out" primary action. Consider stashing
      the wiped payload under a timestamped `breakside_signout_backup_*` key for
      one session as a safety net. Small, self-contained, worth doing on its own.

      </details>

- [x] **1b. The Supabase CDN is a single point of failure for offline launches.**
      ***(DONE 2026-08-16, same branch.*** supabase-js v2.112.3 is now vendored at
      `vendor/supabase-js.min.js` — the package's own `jsdelivr` entry point
      (`dist/umd/supabase.js`), byte-identical to what the CDN served, so this
      pins rather than upgrades. All three consumers switched:
      `index.html`, `landing/index.html`, `landing/join.html`. `vendor/` is not in
      `scripts/deploy-excludes.txt`, so it ships with both deploys, and being
      same-origin it now lands in the service-worker cache like any other asset.
      The file's header carries provenance, the `npm pack` update recipe, and a
      "do not revert to the CDN" note with the reason. Verified in a browser with
      `cdn.jsdelivr.net` hard-blocked: `window.supabase` present on all three
      pages, zero jsdelivr requests, and — the actual payoff — **a device with a
      session and local data now stays in the app instead of being bounced to
      `/landing/`** (`isAuthenticated() === true` with both the CDN and
      `supabase.co` unreachable). That was the §4 failure mode.)*

      <details><summary>Original problem statement</summary>
      `index.html:141` loads supabase-js from `cdn.jsdelivr.net`, and
      `service-worker.js:67` caches only *same-origin* responses with
      `networkResponse.ok` — so that script is **never** in the SW cache (an
      opaque cross-origin response has `ok === false` regardless). If it fails to
      load, `initializeAuth()` bails at `auth/auth.js:47`, `isAuthenticated()`
      returns false, and `main.js:356` redirects to `/landing/` — *regardless of
      what's in localStorage*. Verified in the audit: a device seeded with a team
      and a pending queue still got bounced, data intact but unreachable. The only
      thing preventing this in the wild is the browser HTTP cache holding the CDN
      script (the SW uses a plain `fetch` for cross-origin, so the HTTP cache
      still applies) — a finite, unverified, evictable window.
      *Suggested:* vendor supabase-js next to `vendor/xlsx.mini.min.js` so it's
      same-origin and SW-cacheable. Small change, removes the whole failure mode,
      and makes the README claim true. Pin the version and note the update
      procedure alongside it.

      </details>

- [x] **1c. Nothing requests persistent storage.** ***(DONE 2026-08-16, same
      branch.*** `requestPersistentStorage()` in `store/storage.js`, called from
      `saveAllTeamsData()` — so it fires on the **first real data write**, not at
      load: browsers weigh site engagement when deciding (Firefox prompts
      outright), so asking at the moment the user first has something to lose both
      scores better and reads better. Once per session, no-ops when already
      persisted, never throws — a failed request must not disturb a save. The
      Online/About toast now also reports the tier ("Storage: durable" vs
      "Storage: best-effort (may be evicted)"), which is the diagnostic you want
      when someone says their data vanished. Verified in a browser: not requested
      on load, requested exactly once on the first team creation, not re-requested
      on later writes, and the toast reflects the real state. Headless Chromium
      denies the grant, which the log reports honestly rather than glossing.)*

      <details><summary>Original problem statement</summary>

      No `navigator.storage.persist()`
      call exists anywhere in the codebase, so all local data is best-effort and
      evictable — and on iOS Safari a non-installed PWA's storage is subject to
      ITP's 7-day eviction. This is the quiet one: it costs nothing until a coach
      opens the app after a two-week gap and finds an empty roster.
      *Suggested:* call `navigator.storage.persist()` on first data write (not on
      load — the prompt lands better once the user has something to lose), and
      surface `navigator.storage.persisted()` in the Online/About toast so the
      state is diagnosable. Trivial to add.

      </details>

- [x] **1d. The manual update button can reload mid-game.** ***(DONE 2026-08-16,
      same branch.*** `forceAppUpdate()` (`main.js`) now consults the same
      `isReloadUnsafe()` the automatic path uses, and raises a confirm rather than
      reloading silently. **Note the wording deliberately does not promise an
      automatic later install:** `__breaksideUpdatePending` is set by the
      automatic deferral but **read nowhere**, so nothing re-tries the reload when
      the game ends — the honest promise is "applied next time you open the app",
      which is true because the new worker has already claimed the clients.
      (Wiring that flag up to actually re-try on game end is a possible follow-up;
      it isn't a correctness gap, just an unused signal.))*

      <details><summary>Original problem statement</summary>

      The *automatic*
      service-worker reload is correctly gated on `isReloadUnsafe()`
      (`main.js:190`), which defers while a game is on screen or narration is
      recording. `forceAppUpdate()` (`main.js:268`), reached from About →
      "Update Now", has **no such guard**, and `confirmAppUpdate()`
      (`syncStatusUI.js:250`) deliberately skips confirmation. Committed events
      survive (game state is persisted on every change — 53 `saveAllTeamsData()`
      call sites), but in-memory uncommitted point state doesn't.
      *Suggested:* have `forceAppUpdate()` consult `isReloadUnsafe()` and, when
      unsafe, warn rather than silently reload — the automatic path's deferral
      logic and `window.__breaksideUpdatePending` already exist to build on.

      </details>

  **All four of 1a–1d are now done**, with the guards covered by a new e2e spec
  (`tests/scenarios/09-data-loss-guards.spec.ts`, 6 tests) — both failure modes
  are "no prompt appeared", which looks like success until someone loses a
  tournament, so they're worth pinning. Suites: 27 e2e, 198 unit, 339 backend.

  **Worth knowing about the upgrade path generally:** upgrading does *not* itself
  delete data. `forceAppUpdate()` clears Cache Storage only, and the SW's
  `activate` handler deletes stale *caches*, never localStorage. The risk is
  indirect: the reload re-runs `initializeApp()`, and if the session can't be
  restored at that moment (1b, or an expired refresh token), the user lands on
  `/landing/` with data stranded — and 1a is then one tap away.

#### 2. Solo, offline, no account

- [ ] **Problem: there is no anonymous path into the app at all.** Three
      independent gates, any one of which blocks it:
      (i) `main.js:356` redirects a sessionless visitor to `/landing/`, and its
      two "running in offline mode" fallbacks (lines 374, 379) are **dead code** —
      `initializeAuth()` catches every failure internally and never throws, and
      `auth/auth.js` is a static import so `window.breakside.auth` is always
      defined;
      (ii) `/landing/` has no non-auth entry — `loginBtn`, `getStartedBtn` and
      `quickstartBtn` all open the sign-in modal (`landing/landing.js:66-68`);
      (iii) `showSelectTeamScreen()` logs `"(cloud-only mode)"` and early-returns
      with "Please sign in to access your teams and games" (`teams/teamList.js:34-54`).

  The good news is that the hard part already exists. The offline
  create-and-queue path is built and exercised (`createTeamOffline`,
  `addToSyncQueue`, `processSyncQueue`), and `syncUserTeams()` (`store/sync.js:1309`)
  **merges rather than clobbers** — so a locally-created team already survives a
  later sign-in, and its queued entry uploads. What's missing is a way to *reach*
  any of it without a session. Sub-items, in dependency order:

  - [ ] **2a. An entry point.** A "Continue without an account" affordance on the
        landing page setting a `breakside_local_mode` flag, and a `main.js` check
        for it (or for existing local data) before the redirect. Deliberately
        *not* a reuse of `canActOffline()` (`auth/auth.js:175`) — that predicate
        means "we can't confirm your auth state", which is a different question
        from "this user chose to work locally". Needs a real `isLocalMode()`.
  - [ ] **2b. A local team list.** Restore a local-teams renderer behind
        `showSelectTeamScreen()`'s early return and as a branch in
        `populateCloudTeamsAndGames()`. This is the bulk of the work — the
        cloud-only rewrite removed the path that used to exist, so check the
        history before rebuilding it from scratch.
  - [ ] **2c. Gate by capability, not by session.** The scattered "Please sign in"
        checks in `teams/teamSettings.js` (invites, members),
        `teams/activeGamePolling.js`, `game/shareGame.js` and
        `game/controllerState.js` should read "needs an account" and hide
        cleanly. This is exactly where the docs claim's second half — *"cloud
        sync, multi-coach, and share links need one"* — stops being aspirational.
  - [ ] **2d. Don't burn the sync queue while anonymous.** `processSyncQueue()`
        (`store/sync.js:314`) is gated on `isOnline` but **not** on
        `isAuthenticated()`. An anonymous-but-online user's queued items would
        401, retry five times at 5s intervals (`MAX_SYNC_RETRIES`, line 255), and
        be quarantined into `syncDeadLetter` — destroying precisely the data
        they'd want uploaded at sign-up. Add an auth check so the queue holds
        instead. Small, but a hard prerequisite for 2a.
  - [ ] **2e. Sign-in migration.** When a local user signs in, do their local
        teams get adopted by the new account? The client-side merge is already
        additive; what's missing is the prompt and the server-side ownership
        handoff. This is a product decision before it's code.

  Sizing: 2a and 2d are each an afternoon. 2b and 2c are the real project. 2e
  needs a decision first.

  **Until this ships, the docs should say an account is required.** Suggested
  wording, accurate today subject to 1b: *"Breakside needs a free account. Once
  you're signed in it works offline — record a whole tournament with no signal
  and it syncs when you're back."*

---

## Multi-Coach Line Selection: Intent Rule & LC-Viewing Label — ✅ SHIPPED

> **Status: implemented and merged to main (May 2026).** Server-side
> sync fix landed earlier in `9fadda1`; the client-side intent rule,
> LC-viewing label, dual-role greying, and live mid-point refresh landed
> via the `intent-rule-lc-label` branch, then were simplified by
> `simplify-line-selection` (split view removed; Lineup Ready reduced to
> a fire-and-forget ping). Both merged together.
>
> **What's live now** (so a future on-deck/"next next line" session has the
> current shape, not the original design):
> - `getEffectiveLineForNextPoint` picks the next line with the **side
>   fixed by who-scored** (never flipped). Priority: (1) LC's current
>   view (`lineCoachViewing`) if newer than every `*ModifiedAt` — `'od'`
>   → odLine, else the determined side's line; (2) per-axis most-recent
>   edit; (3) same-side fallback; (4) last-point safety net.
> - **LC-viewing label** on the AC's panel ("Line Coach: viewing the X
>   line") via synced `lineCoachViewing` / `lineCoachViewingAt`.
> - **Greying:** line panel editable iff the current user holds the Line
>   Coach role (solo coaching unrestricted). O|D toggle stays interactive
>   even when greyed.
> - **Lineup Ready** is a fire-and-forget ping (toast on both ends); no
>   persistent badge, no latch, no `lineupReadyMode`. Visible only to a
>   pure LC.
> - The `!isPointInProgress()` refresh gate is gone — the AC sees LC
>   edits + the viewing label live during a point.
> - **Split view removed.** `activeType` is `'o' | 'd' | 'od'` only.
>
> **Conventions for new `pendingNextLine` fields** (e.g. on-deck): pair
> each value field with its own `*ModifiedAt`/`*At` timestamp and extend
> `merge_pending_next_line` in `ultistats_server/storage/game_storage.py`
> (+ the read-merge in `store/sync.js` and serialize/deserialize in
> `store/storage.js`) to resolve it last-writer-wins. Apply the same
> role-based greying to any new line-selection surface.

<details>
<summary>Original design notes (superseded — kept for history)</summary>

### Context

The Line Coach (LC) plans the next line; the Active Coach (AC) records play. Today the AC has no clear signal of what the LC is currently doing, and the auto-pick rule for the "intended next line" is per-axis only (compares `oLine` vs `odLine` for an O-point, `dLine` vs `odLine` for a D-point), with no explicit "I'm done — use this" override. Field testing surfaced that the AC has to manually toggle views to discover whether the LC has prepared a separate O / D line, and the LC can't directly express the intent "use separate lines" vs "use the combined line."

### Goals

- The AC always knows what the LC is currently doing without having to ask, without forcing the AC's own view to mirror the LC's.
- The "intended next line" at point-end follows a clear rule that honors both the LC's most recent action and an explicit "Lineup Ready" intent signal.
- Solo coaching behavior is unchanged — these rules only activate when two coaches hold distinct roles.

### Design

1. **LC-viewing label, not view-following.** The AC's line panel header shows a small sub-line — e.g. `"Line Coach: viewing the D line"` — whenever the LC's view differs from the AC's local view. The AC's view is never auto-switched between points (except at point-end via the intent rule below). This replaces an earlier "AC view follows LC view" design that introduced a follow / manual-override state machine; the label gives the same information without coercion and naturally collapses to silence when nobody uses anything but O/D.

2. **Label is hidden in three cases:**
   - The AC's local view already matches the LC's view (no signal to convey).
   - No LC role is currently claimed.
   - The AC and LC are the same user (solo / dual-role).

3. **Viewing vs. editing distinction.** If the LC has edited any line in the last ~10s, the label reads `"Line Coach: editing the D line"`. Otherwise `"Line Coach: viewing the D line"`. The editing variant is a stronger nudge for the AC to look. The `*ModifiedAt` timestamps already on each line make this free.

4. **Intent rule (corrected) for point-end auto-switch.** When a point ends, `autoSelectActiveTypeForNextPoint` picks which line the AC's panel jumps to. Rule, in priority order:
   1. **Lineup Ready latch.** If the LC pressed Lineup Ready since the last point ended, use the line type they were viewing when they pressed it (new field `lineupReadyMode`). Strongest signal — explicit "I'm done, this is the line."
   2. **Most recent edit, per axis.** For an upcoming O-point, compare `oLineModifiedAt` vs `odLineModifiedAt`; for a D-point, compare `dLineModifiedAt` vs `odLineModifiedAt`. Newer non-empty side wins. (This is the current code — per-axis comparison is intentional and stays.)
   3. **Empty-axis fallback.** If the choice above is empty, fall through: typed-for-axis (non-empty) → `odLine` (non-empty) → whatever's non-empty → empty.

   Rejected alternative: a "global separate-intent" rule (any edit to *either* of `oLine`/`dLine` means the LC intends separate lines regardless of which axis was touched). That surfaces empty rosters when the LC only prepared one side — e.g. prepping D for the next defense point shouldn't make the AC see an empty O line if the team scores instead.

5. **Lineup Ready latch lifecycle.**
   - **Set** when the LC presses the Lineup Ready button. Records `lineupReadyAt`, `lineupReadyBy`, and (new) `lineupReadyMode` ∈ `'o' | 'd' | 'od'` capturing the LC's view at press time.
   - **Cleared** by: (a) the LC editing any line (the edit supersedes), (b) the LC pressing Lineup Ready again from a different view (new latch overwrites), (c) the next point starting (current behavior, already in `startNextPoint`).

6. **Greying / read-only rules for the line panel.**
   - **Editable** iff the current user holds the Line Coach role. Editing is always tied to the LC role; the AC observes via the LC-viewing label.
   - Concretely:
     - **Two users, AC ≠ LC** → LC user edits; AC user observes (greyed).
     - **Dual-role** (same user holds both, e.g. coming out of `auto_assign_roles_if_unclaimed`) → editable (holds LC).
     - **LC vacant while AC is claimed** → AC sees the panel greyed until they explicitly claim LC (single tap). Handles "LC went AFK" cleanly: AC claims LC, edits, optionally releases.
   - Solo coaching (no multi-coach detection) is unchanged — no role enforcement, panel always editable.
   - The O|D toggle stays interactive in the greyed state — viewing different line types is independent of editability.
   - **Historical note:** an earlier draft of this design said "editable iff `isActiveCoach && isLineCoach`" (i.e. dual-role only). That was a misstatement — it would have prevented the LC from editing in the most common multi-coach case (AC ≠ LC), which is the very situation the LC role exists for. The rule above is the corrected version.

7. **Drop the `!isPointInProgress()` refresh gate.** With the server-side merge from `9fadda1`, it's safe to pull `pendingNextLine` during a live point too. This lets the LC-viewing label and any line edits update live for the AC instead of waiting for the next between-points window. The gate exists at [`game/gameScreen.js:5397`](game/gameScreen.js#L5397) — remove the `!isPointInProgress()` condition around `refreshPendingLineFromCloud`.

### Data model additions

In `Game.pendingNextLine` ([store/models.js](store/models.js)) and the server-side payload. The server's `merge_pending_next_line` in [ultistats_server/storage/game_storage.py](ultistats_server/storage/game_storage.py) already preserves unknown keys, but it needs to be extended to merge the new timestamp-keyed fields the same way it handles `oLine` / `dLine` / `odLine`:

```
lineCoachViewing:     'o' | 'd' | 'od' | 'split' | null   // LC writes their activeType
lineCoachViewingAt:   ISO timestamp                       // merge key — most recent writer wins
lineupReadyMode:      'o' | 'd' | 'od' | null             // alongside existing lineupReadyAt/By
```

**Convention for any new fields** (including any added by the on-deck feature): pair each value field with a `*ModifiedAt` ISO timestamp, and extend `merge_pending_next_line` to compare timestamps. That keeps the multi-coach sync robust for free.

### Implementation pointers

- **LC writes `lineCoachViewing`** wherever they change `activeType` — currently `enterSplitMode`, `exitSplitMode`, and the O|D toggle handler in [game/gameScreen.js](game/gameScreen.js). Gate on `isLineCoach` so the AC's local activeType never leaks into the synced field.
- **AC reads `lineCoachViewing`** in the panel header render path (alongside `updateSelectLineSubtitle`). Render the label per #1–#3 above.
- **Greying logic** lives in `canEditSelectLinePanel` ([game/gameScreen.js](game/gameScreen.js)). Today: editable when "Line Coach OR Active Coach OR both roles unclaimed." Replace with: editable iff the current user holds the Line Coach role (`state.isLineCoach`) in multi-coach mode; always editable in solo. Update `updateSelectLinePanelState` to surface the new condition in the read-only overlay. The `.panel-selectLine.readonly .select-line-od-toggle` CSS rule in [ui/panelSystem.css](ui/panelSystem.css) needs to be removed so the O|D toggle stays interactive in the greyed state.
- **Intent rule corrections** go in `getEffectiveLineForNextPoint` at [game/gameScreen.js:4164](game/gameScreen.js#L4164). Add the Lineup Ready latch check before the timestamp comparison; add the empty-axis fallback after.
- **Lineup Ready cleared on line edit** — augment `handleSplitCheckboxChange`, `savePanelSelectionsToPendingNextLine`, and `saveSplitPanelSelections` to clear `lineupReadyAt`/`lineupReadyMode` when the LC modifies any line.
- **Refresh-gate removal** at [game/gameScreen.js:5397](game/gameScreen.js#L5397).

### Out of scope (deliberately)

- **Tap-to-switch on the label** (one-tap mirror of the LC's view). Easy to add later if coaches ask; start informational only.
- **Spectator / viewer behavior** stays unchanged — they continue to see the AC's view.
- **The "AC view follows LC view" design** discussed earlier (with manual-override breaking the follow until point-end + a "resume sync" affordance) is **rejected** in favor of the simpler label-based approach.

</details>

---

## Voice lineup (Lines-tab mic) — follow-ups

Shipped through build 1105 / commit 35aa1f1 (2026-07-28): tap-equivalent
contract (model returns only voiced in/out changes + verified clear; server
does the set arithmetic — it structurally cannot pick or fill a line),
wholesale/everybody-off idiom, additive partial utterances, numbers-in-names
matching, short delta toasts. Field-verified on production. Remaining:

- [x] **Make the 18-scenario lineup eval permanent.** *(DONE — ported by commit
      `0eeba34`; this entry was stale. It lives in
      `ultistats_server/test_narration_lineup.py` as
      `test_live_lineup_eval_matrix`: all 18 scenarios (W1–W3, C1–C3, S1–S5,
      A1–A5, M1–M2) parametrized over `claude-haiku-4-5` +
      `claude-sonnet-4-5-20250929`, each running end-to-end — real prompt →
      real model → `_derive_players` → the real `narration/lineupResolve.js`
      matcher under node — behind the `NARRATION_LIVE_TESTS=1` gate. S1 is
      constraint-graded rather than exact-matched; every other scenario asserts
      an exact resolved set, and all of them assert no unmatched-name leak.*

      **First actual run 2026-08-06: 36/36 green, twice consecutively, ~80s
      and a few cents per pass.** The gate had never been executed since it was
      written, so this is its first confirmation that it both runs and passes.
      Model coverage checks out against `_lineup_model()`: the built-in default
      (`claude-sonnet-4-5-20250929`) and production's Haiku override are both in
      the matrix. Run it before shipping any lineup prompt or model change:

      ```bash
      cd ultistats_server && NARRATION_LIVE_TESTS=1 python3 -m pytest test_narration_lineup.py -k live -q
      ```
- [ ] **Field-watch two deliberate behavior choices** (revisit only if they
      annoy in practice): reciting a full line over a non-empty selection
      UNIONS (e.g. 9/7 warning toast; wholesale first is the intended flow),
      and same-normalized roster names ("Jamal 23" vs "Jamal 40") refuse
      fuzzy matching — the model must emit the exact spelling.
- [ ] **If Haiku lineup quality regresses** (watch retraction-style compound
      subs), pin `NARRATION_LINEUP_MODEL=claude-sonnet-4-5-20250929` in
      `/etc/breakside/env` + restart — the per-pass override exists for
      exactly this; Sonnet was 18/18 on every eval round.
- [ ] Optional: Playwright e2e over the `window.lineupNarration._applyResult`
      seam (unit tests + live eval + manual field tests covered everything
      so far; the seam was built for this).

Ops note: agent sessions currently cannot deploy to EC2 — after the Mac
reboot the ssh-agent has no identity (`Permission denied (publickey)`).
Re-establish once inside `tmux new -s breakside` (ssh to the EC2 host from
that pane) and agent-driven deploys via send-keys work again.

## AI Narration — improvements

Improvements deferred from the initial implementation (see Active section above for the architecture summary).

### ✅ FIXED — narration broken everywhere since OpenAI's GA cutover (G5; root-caused + fixed 2026-07-19, branch `g5-narration-fix`)
- [x] **Root cause (proven by a three-variant live WS experiment):** the browser still
      offered the retired `openai-beta.realtime-v1` WebSocket **subprotocol**; since the
      GA cutover OpenAI accepts the handshake and then kills the session (error + close
      4000 `beta_api_shape_disabled`) before any audio flows. Narration died in the field
      (~early July) with **no client deploy involved** — the 6/27–28 GA migration cleaned
      the URL/payload shapes but left this vestigial third subprotocol, and the Python
      test runner (header auth, no subprotocols) couldn't catch it. The client then
      masked the death: the fatal close lands during the (multi-second on iOS)
      getUserMedia permission prompt, `handleSocketClose` ignores closes while
      `!sessionActive`, `send()` silently drops frames on a closed socket, and
      `startRecording()`'s continuation stomps the error-reset — hence Dave's exact
      symptom: green mic button, mic permission granted, empty transcript forever, and
      **zero `/api/narration/finalize` POSTs in the EC2 logs** (7/04 shows 5 successful
      token mints, no finalize, matching "it's broken, try again").
- [x] Shipped on `g5-narration-fix` (client + server): subprotocol removed (pinned by
      `tests/unit/narrationRealtimeSocket.test.mjs` source tripwires); socket death
      during mic setup now fails loudly (and capture failure closes the socket instead
      of leaking it); **id-era roster fix** — `getOnFieldPlayers` now era-resolves via
      `buildPointPlayerLookup` (narration was missed by G11.1's resolver sweep, so on
      id-era games the slow pass got an empty roster and silently dropped every event;
      verified live on the real Team-E game: old resolution `[]`, new resolution all 7);
      and **every silent failure path now toasts** (finalize non-200, finalize
      200-with-`error` — previously never read — dropped-event counts, no-speech,
      live-session death, plus a positive "N events added" ack).
- [ ] **Field-verify on staging with a real mic (Dave)** — everything up to the
      microphone is verified (live WS experiment + in-app browser probe + finalize
      round-trip); the mic leg needs a human. Then merge + EC2 restart (the
      `narration.py` prompt fix is server-side).

### Quality / accuracy
- [x] **Remove vocabulary-mapping dead code from slow-pass prompt.** A/B test across the test corpus (commit `e24098e`) showed `NARRATION_VOCAB_GUIDANCE=off` (no explicit jargon→flag map) outperformed `=on` by +0.082 mean F1 with no regressions. Deleted the `vocab_section` branch in `_build_finalize_prompt`, the `NARRATION_VOCAB_GUIDANCE` env var, and the structurally-identical "Event-to-function mapping" block in the dead `buildInstructions()` in `narration/narrationEngine.js`.
- [ ] **Improve transcription accuracy**
  - [x] Switch to OpenAI's dedicated **Realtime transcription session** (`?intent=transcription` + `session.type=transcription` minted via `/v1/realtime/client_secrets`). No LLM in the loop, no `response.*` events, kills the "Transcription complete." ack-text spam, cheaper (no output-token billing). Legacy conversational path still reachable via `NARRATION_USE_LEGACY_SESSIONS=1` env var or `mode: 'conversation'` (used when fast-pass is re-enabled).
  - [x] Adopt `semantic_vad` (eagerness `medium` by default — keeps multi-clause narrations like "Alice throws — short pass to Bob — score" together rather than fragmenting on every breath) and `noise_reduction: near_field`.
  - [x] **Advanced Settings UI** (header menu → Advanced Settings) exposes the per-device narration knobs without devtools: VAD eagerness, noise reduction, transcription model (mini ↔ `gpt-4o-transcribe`), vocabulary hint (biases ASR toward roster names + ultimate jargon via the transcription `prompt` field), force-English, and browser audio constraints (echo cancellation / noise suppression / auto-gain — AGC defaults on but can be turned off to test wind handling). Stored in `localStorage` via `settings/advancedSettings.js`; legacy `window.NARRATION_*` globals still win as dev overrides. Also added a Sync group with the cloud refresh interval (applies on reload).
  - [ ] **Field-test `gpt-4o-transcribe` vs mini** — now a one-tap toggle in Advanced Settings. Measure accuracy/cost on the corpus + real audio and decide whether to flip the default.
  - [ ] **Measure the vocabulary hint's effect** — A/B the new transcription `prompt` biasing (names + jargon) against off, on the corpus. Watch for the failure mode where biasing toward a term makes the recognizer over-produce it.
  - [ ] Stronger client-side noise suppression / windscreen mic recommendation in coach docs
- [ ] **Outdoor / multi-speaker robustness**
  - Field-test transcript word error rate against wind, crowd, and bystander voices
  - Now that transcription is decoupled from event extraction, this is a focused, measurable problem
- [ ] **Possession-boundary handling**
  - Current slow-pass prompt is told only the starting offense/defense state; doesn't explicitly handle multi-possession narrations
  - May need prompt strengthening or a more structured event-stream format to track team-side flips

### Cost at scale

**Measured datum (2026-08-05).** A real 3-day / 6-game tournament with lineup narration on and
event narration off: **$0.43 all-in** — $0.28 Claude (Haiku 4.5) + $0.15 OpenAI STT, over ~120
lineup calls. That's **$0.0036 per lineup call, $0.072 per game, ~$3.58 per team-season** (50
games). Event narration would add ~$0.0078/point (~$7.81/team-season). Extrapolated: 1,000 teams
≈ $3.6k/yr lineups-only, ≈ $11k/yr with events. **Conclusion: API cost is not a reason to meter,
paywall, or usage-cap narration at any near-term scale.** The levers below are worth knowing, not
worth doing yet.

Cost splits ~65% Claude / 35% STT. Within the STT half, only 57% is audio ($1.25/1M audio tokens
≈ 2,400 tok/min; the tournament ran ~14s of mic-open per line call). The other 43% is *text* — the
vocabulary-bias `prompt` from `advancedSettings.js` (`buildNarrationVocabularyPrompt`), which
OpenAI re-applies to every VAD-segmented utterance (~2.3 per line call), plus transcript output.

- [ ] **Trim the vocabulary hint on the lineup path** — the ~186-token prompt is 46% ultimate
      jargon (`callahan`, `huck`, `bookends`, `footblock`…) that a coach never says while *calling
      a line*; only the roster names and a few terms (`handler`, `cutter`, `strike`, `deep`) earn
      their place there. A lineup-specific subset would cut ~7% of all-in cost. Interacts with
      "Measure the vocabulary hint's effect" above — measure accuracy first, then trim.
- [ ] **Prompt caching is unused** (`grep cache_control ultistats_server/` is empty). Moot today:
      the lineup prompt is 1,825 tokens, below Haiku 4.5's 4,096-token minimum cacheable prefix.
      It's also ordered cache-hostile — the ~1,200-token static instruction block sits *last*, after
      the volatile roster and transcript. Reorder static-first if the prompt ever grows past the
      minimum or the model changes (Sonnet's minimum is 1,024).
- Model choice is the biggest lever and is already exercised — the Haiku flip cut the Claude half
      ~3x (see `NARRATION_SLOW_MODEL`). Note that flipping the default to `gpt-4o-transcribe`
      (field-test item above) **doubles** the audio rate: $2.50 vs $1.25 per 1M audio tokens.
- To re-measure: Console usage pages give the totals (Anthropic's Admin/Usage API needs an
      *organization* — it's unavailable for individual accounts, which is why
      `platform.claude.com/settings/admin-keys` 404s). Divide the OpenAI audio-token count by 2,400
      for audio-minutes rather than dividing dollars by the published $/min, which bundles text.

### Coverage
- [x] **Add `swing` to the slow-pass throw schema** *(done 2026-07-19, branch
      `narration-swing-reset` — swing in the schema + `applyThrow`, with an explicit
      rule that the spoken verb "swing"/"swings it" always sets the flag. Rode along:
      the **dump→reset rename** per Dave's design call — "reset" is canonical in code,
      logs, and stats: `Throw.reset_flag` (constructor param `reset`), summarize/log
      "reset", Key Play button relabeled, Full/Field chip props, Field
      `classifyThrow` return keys, viewer (prints reset+swing, reads
      `reset_flag||dump_flag`). Legacy stored `dump_flag` aliases to `reset_flag` at
      `deserializeEvent` (single chokepoint; verified live) and re-saves emit the
      clean key. Narration prompt: spoken "dump" and "reset" BOTH set `reset`. Corpus
      012/015/015b/020 expectations updated; runner key fields gain reset+swing (dump
      kept so strays surface). Full corpus 20/0 twice (one unreproduced stochastic
      single-scenario flip across four runs — inherent LLM variance at the F1
      threshold, see test_scenarios.py docstring). ARCHITECTURE.md § AI Narration
      documents the terminology.)*
- [x] **Add `record_pull` to the slow-pass schema** *(done 2026-08-06, branch
      `narration-record-pull`) — `kind: "pull"` in the schema
      (`puller`, `flick`, `roller`, `io`, `oi`, `brick`, `quality`) plus
      `applyPull` in `narration/narrationEngine.js`. Three guards make it safe
      to narrate a pull the dialog already collected: **a named puller is
      required** (a bare `{"kind":"pull"}` is dropped client-side and the
      prompt shows it as a WRONG example); **one Pull per point, checked from
      both sides** via `pointHasPull()` in `utils/helpers.js` — narration skips
      if the dialog got there first AND the dialog skips (with a toast) if
      narration did, since the slow pass lands seconds after the coach stops
      talking and either order is reachable; and **a narrated pull closes the
      pull dialog**, so the coach isn't left filling in a form for an event
      already in the log. Rationale: `showPullDialog()` fires automatically at
      every D-point start, so an unattributed narrated pull is pure duplicate.
      End-to-end this makes the flow hands-free: Start Point → dialog opens →
      tap mic, speak, stop → event lands, dialog closes itself.
      Hardening the puller rule was driven by live probing — Haiku emitted a
      pullerless pull for "we pulled it" and "they pull" until the rule got
      an explicit REQUIRED gate; after it, 7/7 probe cases twice consecutively
      (named pull, named pull after a mid-narration score, named pull with
      flags, plus the four unattributed/opponent-pull negatives from the
      corpus). Corpus: 018's expected gains the Daniel pull; 007/010/011/015
      stay unchanged as the negatives. New deterministic suite
      `ultistats_server/test_narration_finalize.py` (11 tests) pins the prompt
      rules and gives `score_events`/`_event_signature` their first coverage
      in the default run — the live corpus module is entirely
      `NARRATION_LIVE_TESTS`-gated, so they had none;
      `tests/unit/pointHasPull.test.mjs` (9 tests) pins the duplicate guard.
      Suites: backend 346, unit 157, e2e 21/21.*
  - [ ] **Still needs a human: the mic leg.** Everything up to the microphone
        is verified, but nobody has confirmed on a real device that the mic
        button actually takes the tap while the pull dialog is up (it should —
        `z-index` 2000 over the modal's 1000, and `startRecording` has no
        dialog gate — but that's read off the CSS, not observed), nor timed
        how long the dialog lingers while the slow pass runs. Worth folding
        into the next staging field test.
- [ ] **Re-evaluate streaming events (fast pass)**
  - Currently disabled via `FAST_PASS_EVENTS_ENABLED = false` in `narrationEngine.js`
  - All code is preserved — flip the flag to re-enable
  - Worth revisiting when we have a story for noisy-environment confidence (e.g. confidence-gating, transcript-stability checks)
  - **Before turning back on**: the "Event-to-function mapping" section in the dead `buildInstructions()` was already dropped along with the slow-pass vocab map (same failure modes). Still worth A/B'ing whether the per-property `description` fields on the tool definitions (e.g. `huck: "A long/deep throw"`) are pulling weight or are just a stealth vocab map.

### New voice-driven flows

Today the mic only narrates plays *during* a point. Two adjacent flows would extend voice control into the moments around each point:

- [ ] **Speech-driven point start (incl. pull recording)**
  - Tap mic on the pre-point screen and speak: "Alice, Bob, Carol, Dan, Eve, Frank, Grace — Bob hucks a flick OI pull, brick" → app selects those 7 players, transitions to in-point, and records the pull with puller + flags in one shot.
  - ~~Requires the `record_pull` schema gap to be closed first~~ — **unblocked
    2026-08-06**: `kind: "pull"` and `applyPull` exist (see Coverage above), so
    the pull leg of this flow has somewhere to land. Note the puller-required
    rule: "Bob hucks a flick OI pull" works, a bare "we pull" records nothing.
  - Touch points: `narration/narrationEngine.js` (new pre-point intent + applier), new pull schema in `ultistats_server/narration.py`, `pointManagement.js` (programmatic line-select + start-point hook), `game/gameScreen.js` (mic surfaced on Line tab when between points).
  - Open question: one mic-tap or two? Single tap that handles "line + pull" feels natural orally but mixes two state transitions; safer to gate the pull narration behind the line being confirmed first.

- [x] ~~**Speech-driven line selection (oral roll-call)**~~ **SHIPPED** as the
      Lines-tab mic (build 1105 / `35aa1f1`, 2026-07-28) — tap mic on the Line
      tab, speak names, checkboxes tick. Name resolution was extracted into
      `narration/lineupResolve.js` (shared helper, unit-tested in
      `tests/unit/lineupResolve.test.mjs`); the model returns only voiced
      in/out deltas and the server does the set arithmetic. Wholesale-first is
      the intended flow for a full line. The edge cases listed here were
      resolved as deliberate behavior choices — see **Voice lineup (Lines-tab
      mic) — follow-ups** above for what remains (permanent eval, field-watch
      items) and ARCHITECTURE.md § Lineup Narration for the contract.

### UX
- [ ] **Transcript panel UI polish**
  - Fade older text so most recent stays prominent
  - Highlight player names as they're recognized (would need light-weight name detection client-side)
  - Optionally show a "this will become events when you stop" hint

### Test suite

The audio-driven test harness is implemented in `ultistats_server/tests/narration/`. Skeleton works end-to-end. Scenarios `001`–`003` are the original baseline; `004`–`020` were scaffolded in a corpus-expansion pass and their synthetic `audio.flac` is **generated and committed** (20 of the 25 scenario dirs have audio). The five without audio are the hand-record variants (`004b`, `008b`, `015b`, `019b`, `021`) — those need a human, a phone, and a windy field.

Corpus structure:

| Theme | Scenarios |
|---|---|
| Baseline | 001 single throw • 002 multi-throw possession • 003 drop + interception + score |
| Self-correction | 004 name correction • 005 event-type downgrade (huck → throwaway) • 006 score → drop in endzone |
| Possession flips | 007 D-line layout block → score • 008 multi-flip yo-yo • 009 stall + opp score |
| End-of-point | 010 Callahan • 011 opp-score-only |
| Ultimate jargon | 012 reset/swing/IO • 013 hammer + sky combo • 014 footblock + bookends |
| Side commentary | 015 mid-narration coach chatter • 016 coach uncertainty |
| Numbers | 017 jersey-number-only references |
| Long form | 018 multi-possession spanning a point boundary |
| Alt roster (nicknames + phonetic + name=vocab) | 019 nickname recognition • 020 phonetic similarity + name "Sky" |
| Real audio (hand-record) | 004b name correction outdoor • 008b yo-yo outdoor • 015b commentary outdoor • 019b nickname short outdoor • 021 adversarial / coach-on-tilt |

Remaining work:

- [x] **Generate audio for 004–020** via `tools/generate_synthetic_audio.py` *(done — all 20
      synthetic scenarios have a committed `audio.flac`)*
- [ ] **Hand-record 004b / 008b / 015b / 019b / 021** in noisy outdoor conditions; same expected.json, different audio.flac. Built-in regression for outdoor robustness. *(These five are the only scenario dirs still without audio.)*
- [ ] **Re-record a live-conditions scenario to replace the deleted `022_live_field_point`.** The original was a phone recording of a real game point — wind, sideline chatter, dead-air gaps that fragmented the transcript into subject-less clauses ("Upfield to the handler.Turns it over…"). It caught four prompt gaps clean TTS never did. It was deleted in the name scrub because the recording *speaks real player names*, which no text edit can fix. Narrate a fresh point calling the generic roster (Alice/Bob/Charlie/Dana/Eve/Hank/Iris) and rebuild roster/transcript/expected alongside it.
- [ ] **Schema gap: opponent unforced turnover.** Several scenarios above (007, 008, 014) gloss over what happens when the opponent throws it away to us — the narration schema in `ultistats_server/narration.py` has no event for "they turnover". The Full-PBP requirements doc models this as `Defense{unforcedError, defender=null}`. Decide whether to add it to the narration schema or handle implicitly via the next throw being from us.
- [x] **Schema gap: `record_pull`.** *(closed 2026-08-06 — see the Coverage
      section above.)* Worth knowing how it landed, because the answer was not
      what this entry assumed: the "they pull" / "we pull" openers **stay**
      dropped on the floor, deliberately. They name no puller, and an
      unattributed pull duplicates what the pull dialog already collects at
      point start. Only a pull that names one of our players becomes an event.
      So 007/010/011/015 keep their expectations as negative cases, and 018
      ("Daniel pulls") is the positive one.
- [ ] **Noise injection** — mix in wind/crowd samples to simulate field conditions, run the same scenarios at varying SNR.
- [ ] **CI integration** — run on PRs that touch `narration/` or `ultistats_server/narration.py`. Fail on metric regression beyond a threshold. Cost note: ~$0.10 per scenario per run.

---

## Backlog

- [ ] **Code health: fold duplicated game-screen helpers** (deferred from the `gameScreen.js` split, D1). When `game/gameScreen.js` was split into `gameScreenPanels/Events/Timer/selectLine/gameScreenSync.js`, the split was kept a pure verbatim move for verifiability, so three already-identified, behavior-identical duplications were left in place. Fold them when convenient: `endGameFlow()` (the near-identical `handleEndGame` in `gameScreenEvents.js` vs `handleGameEventEndGame`), `installPollInterval()` (the clear-interval / `setInterval(ping)` idiom repeated ~3× across `controllerState.js`), and `stopPointTimerInto(point)` (the "add elapsed to `totalPointTime`, null `startTimestamp`" block duplicated in both score handlers in `gameScreenEvents.js`). Purely mechanical; do behind the e2e suite.
- [x] **Code health: `ui/activePlayersDisplay.js`'s sticky active-players table is dead code** *(DONE 2026-08-06, branch `dead-active-players-table`
  — deleted; the file went 429 → 53 lines. Confirmed unreachable first: neither
  `#activePlayersTable` nor `#tableContainer` exists in `index.html` or is built
  at runtime (the `tableContainer` hits in `game/selectLine.js` are local
  variables holding `#panelTableContainer`), and every removed function was
  referenced only from inside the file. `#statsToggle`, which `togglePlayerStats`
  targeted, is likewise absent. **Two live exports were kept**: `getRunningScores`
  (used by `game/selectLine.js` for the Line-tab score header) and
  `clearNextLineSelections` (called by `gameLogic.js`, `pointManagement.js`,
  `selectLine.js`). **Finding worth acting on:** `clearNextLineSelections` is now
  provably inert — its variable's only writer was `captureNextLineSelections`,
  itself dead and deleted, so `nextLineSelections` is permanently null. Removing
  it plus its four call sites is a safe follow-up, left undone so the deletion
  stayed contained to one file. **CSS:** only the two provably-dead id-scoped
  rules went (`#tableContainer`, `#activePlayersTable`). The unscoped `.active-*`
  rules were deliberately left — see the rewritten comment above them in
  `css/tables.css`; all six classes are worn by three live tables, and while the
  Line tab overrides every sticky declaration from `ui/panelSystem.css`,
  confirming they're inert for `#subPlayersTable` and the roster table needs eyes
  on those surfaces mid-game. Verified: unit 148/148, e2e 21/21 (covers the Line
  tab, pull dialog, and line selection). The CSS deletions target ids that exist
  nowhere, so no visual regression is reachable from them.)*

  <details><summary>Original analysis (kept — the CSS half is still open)</summary>

  (found during the `teams/` refactor, D2). `updateActivePlayersList` / `createActivePlayersTable` / `makeColumnsSticky` target `#activePlayersTable` / `#tableContainer`, but neither element exists anywhere in `index.html` — the whole codepath is unreachable from any live screen. The live in-game "before point" table is `game/selectLine.js`'s panel-based system (`#panelActivePlayersTable`; its sticky styling is the id-scoped `.active-*` rules in `ui/panelSystem.css` plus the `makePanelColumnsSticky()` width-sync). Either delete the dead table code in `activePlayersDisplay.js`, or confirm there's a reason it's still there and wire it up. If deleting, the *unscoped* `.active-*` rules in `css/tables.css` (formerly main.css) can be pruned — but carefully, not wholesale: they're shared, not dead. `.active-checkbox-column` (text-align/padding) styles the live team-roster table's checkbox cells (`teams/rosterManagement.js`), and `.active-time-column`'s `font-style: italic` styles the live Line-tab time cells. Only the `position: sticky`/background/box-shadow/border/z-index declarations added for the dead table are safe to drop from the unscoped rules; the `#rosterTable`-scoped and `#panelActivePlayersTable`-scoped sticky rules serve live tables and must stay.

  </details>

- [x] **Code health: merge the duplicated game-log renderers** *(DONE 2026-07-19, G6: the two frontend copies now delegate to `utils/gameLogRenderer.js` — `buildGameLogText` + `renderGameLogHTML`, pure leaf module, unit-tested in `tests/unit/gameLogRenderer.test.mjs`. Per-surface differences are parameters (version/roster header lines, score badges); the Turnover possession-boundary drift was reconciled, so the post-game summary now shows the O/D delimiters too. The public viewer stays bespoke — separate origin, can't import PWA modules, card layout — with a keep-in-sync header comment at its `renderPossessions`/`renderEvent`. Format changes now land in exactly one place; only `Event.summarize()` phrasing changes still need hand-mirroring in the viewer.)*
- [ ] **Major refactor (someday, probably not soon): point lifecycle — create the next Point the moment the last one ends.** Technically a new point begins when the previous one ends (that's when between-point timeouts, switch sides, halftime happen), but the code creates a `Point` only at Start Point (`pointManagement.startNextPoint`) because its roster and starting position aren't knowable earlier — the line hasn't been picked and an intervening switch-sides can still flip O/D. Today between-point events therefore attach to the *completed* point's last possession, flagged `betweenPoints: true`, and the log renderers re-order them after the score lines — a display-level fix that works fine. Moving to always-materialized points would mean: placeholder Points with null players/startingPosition that `startNextPoint` fills in; reworking `isPointInProgress()` (its `possessions.length` fallback would misfire on a placeholder holding a timeout); auditing every `getLatestPoint()` consumer (~16 files: undo — including the empty-point double-tap backout — stats, narration, timers, all PBP surfaces) for "real point or placeholder?"; suppressing the phantom per-point column in the Line-tab table and the empty `Point N roster:` header in the log; end-game cleanup of a trailing placeholder; and sync back-compat (older clients and the deployed viewer would render the placeholder as a real point). Sized on 2026-07-05 as days of work with regression risk across the core game flow, versus the shipped render-order fix; revisit only if between-point *timing* data (e.g. actual time between points, timeout durations) becomes a feature goal.
- [ ] **Low-power / reduced-motion mode** (long-term). A toggle (and/or honoring the OS `prefers-reduced-motion`) that disables non-essential animations to save battery during long sideline sessions. One-shot transitions (e.g. the Field tab's 5s possession-change fade) are cheap, but *continuous/looping* animations and per-frame JS (`requestAnimationFrame`/`setInterval`) keep the GPU/CPU from idling and do drain battery — so the rule of thumb is: avoid always-running animations, and let this mode strip any that exist. Audit current usage (e.g. pull hangtime `setInterval`, any CSS loops) when implementing. Noted while building the Field tab.
- [ ] **Rare / administrative events** (long-term). Capture uncommon events that don't fit the main offense/defense/pull flows: offsides on the pull (O or D), cards (yellow / blue / red), and similar officiating/administrative calls. Likely surfaces via the "⋯ more" overflow on the Field/Full tabs (and the existing Game Events modal). Will need new event model support + summarize/serialization, and a decision on whether they affect possession (most don't). Noted while building the Field tab; out of scope for that effort.
- [ ] **Stats: "50-50" drop/throwaway flag** (someday). Add a `50-50` chip to the `TURNOVER_MODIFIERS` set in `playByPlay/fullPbp.js` — the "Last turnover was a:" row, currently `{huck, good D}` — for turnovers where the blame genuinely splits: a tough but catchable disc, a throw into coverage the receiver got hands on, a miscommunication. Motivated by the turnover fault-attribution fix (2026-08-05): a drop is now charged to the receiver *alone* and a throwaway to the thrower alone, which makes fault a binary call at the moment of entry. The 50-50 flag is the escape hatch for plays that aren't binary, so coaches aren't forced to libel one player or the other.
  - **Model**: new `fiftyFifty` constructor arg → `fifty_flag` on `Turnover` (`store/models.js`), following the `receiverError` → `drop_flag` pattern. Serialization is automatic (`deserializeEvent` copies unknown props), but `summarize()` needs phrasing ("50-50 between X and Y"), and the viewer's bespoke event renderer (`ultistats_server/static/viewer/viewer.js`) needs the same line.
  - **Open question — how it scores.** Options: (a) half a turnover to each player, which makes TOs fractional and ugly in a table; (b) a full turnover to both, which double-counts against the team total; (c) a turnover to neither, tracked only as its own count; (d) its own bucket so `TAs + Drops + 50-50s = TOs`, preserving the "every turnover is charged once" invariant that `utils/statAccumulator.js` now maintains. (d) looks cleanest and fits the existing Full-level column set — add a `50-50` column next to TAs/Drops, and mirror it in `utils/xlsxExport.js` + `utils/statsHelp.js`.
  - Whatever is chosen, keep `utils/statAccumulator.js` and the viewer's `computePlayerStatsFromGame` in step — they compute turnovers independently and must agree.
- [x] **Feature**: When Active Coach ends game, all coaches/viewers navigate to game summary. *(Wake recovery + foreground 3-second refresh both detect `gameEndTimestamp` and navigate away.)*
- [x] O/D line view persistence between points (combined O/D stays; separate O/D auto-switches based on who scored; split preserved).
- [x] **Feature**: Line selection mode toggle (Manual / Wholesale / Auto) *(later superseded — the cycling mode toggle was replaced by one-shot Wholesale/Auto buttons on `line-selection-rework`; see "Wholesale/Auto icon UI redesign" under Future Enhancements → Line Selection.)*
  - Tappable text element in each player-selection table header that cycles through three states:
    - **Manual** (default): Whatever the user has checked. This is the normal behavior today.
    - **Wholesale**: All players unchecked (clean slate for building a line from scratch).
    - **Auto**: App suggests a lineup — picks players with fewest points played while respecting the game's gender ratio rules. Falls back gracefully when available players can't meet the ratio.
  - Tap cycles: Manual → Wholesale → Auto → Manual.
  - Toggling away from Manual saves the current checked set as a snapshot. Toggling back to Manual restores that snapshot.
  - Any manual checkbox change while in Wholesale or Auto immediately returns to Manual state, and the modified set becomes the new snapshot.
  - Resets to Manual at the start of each new point.
  - Present in all three player-selection contexts: main Select Next Line panel, O/D split panels, and injury substitution dialog.
- [x] Hide role buttons when only one coach on team or only one coach polling (more room for panels).
- [x] O/D split panels: O/D button splits "Select Next Line" into two separate panels ("Select Next O Line" / "Select Next D Line").
- [x] **Bug**: Line panel checkboxes are editable by non-Line-Coach in multi-coach games
  - Fixed in `canEditSelectLinePanel` (`game/gameScreen.js`): early-allow now checks the `_multiCoachDetected` latch (exposed via `window.isMultiCoachDetected`) instead of "no role claimed yet", so once a second coach has been seen this session the panel requires holding Line Coach (during point) or Line/Active Coach (between points). The existing `updateSelectLinePanelState` plumbing handles the rest — checkboxes get `disabled=true`, the `.readonly` class greys out the Manual/Wholesale/Auto toggle and the lines/OD buttons, and the "View Only" overlay appears. `cycleSelectionMode` was already gated by `canEditSelectLinePanel`. The injury-sub dialog is gated upstream by Active Coach (`canEditPlayByPlayPanel`) so no changes were needed there.
- [x] **Stats & Analytics** (breaks/holds, hockey assists, event phases, .xlsx export). Shipped together:
  - **Breaks / clean+dirty holds.** `classifyPoint` + `getGameTeamStats` / `getEventTeamStats` in `utils/eventStats.js`; per-point badges in the game log; per-game and per-event summary line; reported per D-point *and* per D-possession.
  - **Hockey assists + huck hockey assists** in `accumulateGameStats` (thrower of the pass before the assist); HA / Huck HA columns on both stats tables.
  - **Event phases.** `TournamentEvent.phases` + `Game.phase`; phases editor + auto-label-by-day in the event settings dialog; inline per-game phase picker; `PATCH /api/games/{id}/phase` (metadata-only); phase-filtered event stats; phase grouping in the event games list.
  - **Stats-screen polish.** Long-press column-header help modal (`utils/statsHelp.js`); two-line team-stats summary; points-played team total; sticky header row + sticky leftmost columns on both tables.
  - **Excel (.xlsx) export** replacing CSV on game summary, event roster (phase tabs), and team roster (event tabs); SheetJS vendored in `vendor/`; scoped AutoFilter for click-to-sort; real number/percent/time cell types. See `utils/xlsxExport.js`.

- [ ] **Analytics**: Honor per-point / per-possession recording-mode flags (`Point.modes` / `Possession.modes`)
  - **What exists now.** Every `Point` and `Possession` records which PBP recording modes were active during it, as a deduped array of `'simple'` / `'full'` / `'field'`. A possession's `modes` is stamped when an event is actually *recorded* into it (`Possession.addEvent` in `store/models.js`, reading `window.getCurrentMode()` from `ui/panelSystem.js`; the pull stamps itself in `playByPlay/pullDialog.js`) — NOT on creation or tab switches, so merely browsing/mis-tapping tabs leaves no trace. `Point.getModes()` derives the point's union from its possessions. Serialized/deserialized in `store/storage.js` and `store/sync.js`; legacy games (and points/possessions with no recorded events) have an empty `modes` array. The backend stores them as opaque JSON — no schema changes needed.
  - **Why.** These tell analytics how completely each point/possession was tracked, so stats can be included, excluded, or caveated:
    - `'simple'` present on a point ⇒ the coach likely *didn't* capture every throw; per-throw stats (completions, touches, hockey assists, etc.) for that point are unreliable. Only PT and goals/assists should be trusted.
    - `'field'` for the *entirety* of a possession (`modes` === `['field']`) ⇒ we have accurate location data for every throw in it; safe to feed into spatial/field analytics.
    - `'full'` ⇒ every throw recorded but without (reliable) location data.
    - Mixed arrays (e.g. `['simple','field']`) ⇒ mode changed mid-point/possession; treat the lower-fidelity floor as the trust level.
  - **TODO.** Update the stats computations (`utils/eventStats.js` — `accumulateGameStats`, `classifyPoint`, `getGameTeamStats`/`getEventTeamStats`) and the `.xlsx` export (`utils/xlsxExport.js`) to read `modes` and exclude/flag low-fidelity points & possessions accordingly. Decide on UI: a per-point badge or a footnote on the stats screen indicating which rows are mode-limited. Handle empty-`modes` legacy games (treat as unknown — probably "include but flag", matching how pre-existing tournament data is kept elsewhere).

- [ ] **Refinement**: Hockey assists as an explicit judgment call (not auto-derived)
  - **Problem with current behavior.** Today a hockey assist is awarded automatically to whoever threw the pass *before* the scoring pass (`accumulateGameStats` in `utils/eventStats.js` walks back through the possession). But like hockey / other sports that track pre-assists, a hockey assist is really a judgment call — was the goal *notably enabled* by that prior pass, or was it just the previous touch? Auto-derivation over-counts (every dump-swing-score gets one) and can't be recorded at all in Simple mode where the prior pass usually isn't entered.
  - **Proposed model.** Make the hockey assist an explicit attribution captured in the Score Attribution dialog (`playByPlay/scoreAttribution.js`), alongside the existing goal + assist pickers:
    - Add a "Hockey assist" control: a player dropdown.
    - **Full mode**: pre-select the thrower of the recorded pass-before-the-assist (the current auto-derivation result) but leave it editable — and allow clearing it to "no hockey assist."
    - **Simple mode**: default the dropdown to a placeholder like "Select HA passer" (the prior pass usually wasn't recorded, so there's nothing to pre-fill); coach picks from the roster or leaves it unset.
  - **Storage.** Record the chosen HA player on the scoring `Throw` event (e.g. `hockeyAssistId` / `hockeyAssist` name) rather than re-deriving it. Honor the huck case: a separate flag (or derive huck-HA from whether the recorded HA pass was a huck — only possible in Full mode where that pass exists).
  - **Stat computation.** `accumulateGameStats` reads the explicit HA attribution instead of walking the possession. **Backwards compat:** games played before this change have no explicit field — decide whether to (a) fall back to the existing auto-derivation for those, or (b) show them as having no HA. Leaning toward (a) so the tournament data already collected keeps its (approximate) HA numbers.
  - **Touch points:** `playByPlay/scoreAttribution.js` (dialog UI + new picker), `store/models.js` (Throw field), `store/storage.js` (serialize/deserialize the field), `utils/eventStats.js` (read explicit field, fall back to derivation), and the AI narration path (`narration/narrationEngine.js` + `ultistats_server/narration.py`) if we want narrated scores to capture HA too.

- [x] **Feature**: Per-possession defensive/offensive set flag (zone tracking, etc.)
  - **STATUS 2026-08-06 (branch `possession-sets-stage6`): COMPLETE through
    stage 6.** Stages 1–5 shipped 2026-07-26 — schema/serialization (unit +
    API round-trip tests), Team Settings opt-in (toggle + comma-separated
    lists with dedupe/length caps), the set pickers, and set tags in the log
    (`— Team on defense (Zone) —`, renderer tests) + public-viewer
    possession headers.
  - **Stage 6 (2026-08-06): per-set breakdown in team stats.** Landed as a
    breakdown block rather than a filter dropdown — you see every set at once
    and compare them side by side, instead of picking one and re-reading:

    ```
    Breaks: 2/3 D-points (2/5 D-possessions)
    Holds: 2 clean + 0 dirty / 3 O-points
    By set:
    • Zone (D): 2/4 stops, 1 break
    • Ho (O): 3/5 scored
    ```

    Reported per possession (sets live on possessions; breaks/holds are
    per point), so each set is judged on its own terms. Two attribution
    rules — a defensive possession is a stop unless it's the last one of a
    point we lost (a won point ending on D is a Callahan, so still a stop),
    and a break is credited only to the set of the **last** defensive
    possession of a won D-point, i.e. the stop we actually converted. Both
    documented in ARCHITECTURE.md § Possession Sets.

    Rides on the team-stats object so both stats screens and all three xlsx
    exports (game summary, event roster, team roster) pick it up with no
    call-site changes; the xlsx gets it as footer rows under the existing
    breaks/holds footer, outside the AutoFilter range. `rosterManagement`'s
    hand-rolled team-stats re-sum was replaced by the shared
    `getGamesTeamStats` — a numeric-only merge silently dropped the new
    field. 13 unit tests in `tests/unit/setStats.test.mjs` (161/161 suite).
    Emits nothing when no possession is tagged, so opted-out teams are
    unaffected on every surface.
  - **Field-test round, 2026-08-09** (same branch). Fixed: Team Settings'
    Set Tracking fields were white-on-white and unfindable (unscoped
    `.form-group` rules from `auth/auth.css` — see ARCHITECTURE.md § CSS
    Styling Gotchas); the game log silently dropped a defensive set tagged
    mid-point (the inline post-Turnover delimiter has to carry the *next*
    possession's tag); and the Full chip only rendered on offence, so a
    defensive-only team saw no control anywhere. Changed: the pull-dialog
    defensive picker was **removed** (overflowed on a phone, and the set
    usually isn't knowable at pull time); tagging moved to a `Set:` control
    on the Full tab's top line and in the Field tab's action row, with a
    second copy beside "Last turnover was a:" / "Last D was a:" bound to
    that possession; tap cycles, long-press opens a light anchored popover.
    Both primary controls key off the **live mode**, not the last
    possession — those diverge at a change of possession, which is exactly
    when a coach names the set they're switching into.
  - **Not built (deliberate):** a per-point set badge in the game log, and
    the set-vs-phase composition (`{set}` alongside `{phase}` in
    `filterGames`) — the breakdown block answers the v1 question without
    either. Revisit if coaches ask to slice a single set across a phase.
  - **Known limitation: one set per possession.** `Possession.set` is a
    single label, so a defence that starts in zone and calls "Fire!" partway
    through can only be re-tagged — the possession then reads as man for its
    whole length, and the zone that forced the situation gets no credit. See
    the set-transition item under Backlog.
  - Tag each possession with the set being played (zone, ho-stack, vert-stack, force-middle, junk…). Primary v1 use case is marking which defensive possessions were played in zone, so that "breaks while running zone" type splits become possible later. Must stay invisible for teams that don't opt in.
  - **Data model**:
    - `Team.setsEnabled: boolean` (default `false`) — team-level opt-in.
    - `Team.sets: { offensive: string[], defensive: string[] }` — team-configurable label lists.
    - `Possession.set: string | null` — single label per possession; null = unspecified.
  - **Serialization** (`store/storage.js`): round-trip `setsEnabled` + `sets` in `serializeTeam`/`deserializeTeams`; round-trip `set` on each possession in `serializeGame`/`deserializeGame`. `Possession` constructor takes optional `set = null`. Server payloads are schema-loose, so no API changes.
  - **Backwards compat**: missing fields default to `false` / `[]` / `null`; UI hidden everywhere unless `setsEnabled` is on.
  - **UI surfaces** (all guarded by `team.setsEnabled === true`):
    1. **Team settings opt-in** (`teams/teamSettings.js`): toggle + two editable lists (offensive sets, defensive sets).
    2. ~~**Defensive picker — pull dialog**~~ — built, then **removed 2026-08-09**: it overflowed the dialog on a phone, and at pull time the coach usually can't know yet what set the D will run. Defensive sets are tagged from the Full/Field control instead (see 3).
    3. **Set picker — Full + Field tabs** (`playByPlay/fullPbp.js`, `playByPlay/fieldPbp.js`): a cycling control that tags the live possession, offering the label list for the side in play (offensive labels on offence, defensive on defence). Shared logic in `utils/possessionSets.js`. Simple mode deliberately not tagged. *Originally offensive-only on Full — that meant a defensive-only team saw no control anywhere; fixed 2026-08-09 along with the pull-dialog removal.*
    4. **Display in event log** (`ui/eventLogDisplay.js` and game summary log): prepend possession blocks with `[Zone]` etc. when `possession.set` is set.
    5. **Aggregation** — *shipped 2026-08-06, but as a breakdown block rather than the filter sketched here.* `getGameTeamStats(game).sets` returns per-set records and `formatTeamStatsLine` renders them all at once ("Zone (D): 2/4 stops, 1 break"), so no `{set}` option and no composition with the phase filter was needed. See the stage-6 note at the top of this item.
  - **Undo**: set lives on the possession itself, so existing undo handling needs no changes.
  - **Ship order**: schema + serialization → team settings opt-in → defensive picker (zone use case) → offensive chip → event-log display → aggregation filters.
  - **Cross-cutting**: bump `cacheName` in `service-worker.js` on any deploy touching CSS or top-level files; add a round-trip test for `setsEnabled`/`sets` in the server test suite.

- [ ] **Extension**: Record a *transition* between sets within one possession ("Fire!")
  - **Problem.** `Possession.set` holds a single label, so a defence that starts
    in zone and switches to man partway through — the classic "Fire!" call —
    can only be re-tagged. The possession then reads as man for its whole
    length: the zone that forced the stall or the panic throw gets no credit,
    and a coach reviewing "is our zone working?" sees a possession that never
    mentions it. The same applies on offence (a vert set that breaks into ho).
  - **UI.** The set control's long-press popover
    ([ui/setPicker.js](ui/setPicker.js)) is the natural home: alongside the
    plain list of labels, a checkbox or toggle — "switched to this set" vs
    "correct the set" — so a tap that means *we changed* is distinguishable
    from a tap that means *I mistagged it*. Plain tap-to-cycle should keep
    meaning "correct it" (it's the fast path, used to fix a mis-tap), which
    means the transition can only be recorded from the popover.
  - **Model.** Either `Possession.set` becomes a sequence
    (`[{label, at}]`, first entry = the set it started in) with the current
    string kept as a read-side alias for back-compat, or a set-change lands on
    the possession's own event stream like any other event (which gets undo,
    serialization and log rendering for free — probably the cheaper route).
    Legacy possessions keep a bare string and must read as a one-entry
    sequence.
  - **Stats — the real design question.** `getGameTeamStats().sets` currently
    credits a whole possession to one label, so the attribution rules
    (ARCHITECTURE.md § Possession Sets) need a per-segment answer: which
    segment owns the **stop**, and which owns the **break**? Most defensible
    is probably "the set in play when the possession ended" for the stop, with
    earlier segments counted as *played* but not *credited* — otherwise a team
    that always bails to man would show man doing all the work. Whatever is
    chosen, `possessions` (denominator) and `stops`/`breaks` (numerator) stop
    being the same unit, so the display line needs rethinking too.
  - **Touch points:** [store/models.js](store/models.js) (Possession),
    [store/storage.js](store/storage.js) (serialize/deserialize),
    [utils/statAccumulator.js](utils/statAccumulator.js) (per-set records +
    `formatSetStatsLines`), [utils/gameLogRenderer.js](utils/gameLogRenderer.js)
    and the viewer's bespoke renderer (a possession header showing one label
    would need to show the sequence), plus the set control itself.

- [ ] **Extension**: Richer modifier flags on `Turnover` events
  - The Full PBP "Last turnover was a:" panel currently exposes only `huck` and `good D` because those are the only orthogonal flags on the `Turnover` model today. To support "threw it away while attempting a *break* / *hammer* / *dump*" (and `sky` / `layout` for drops, e.g. receiver tried to layout but missed), add `break_flag`, `hammer_flag`, `dump_flag`, `sky_flag`, `layout_flag` to the `Turnover` constructor in `store/models.js` and surface them in `summarize()`.
  - Touch points: `store/models.js` (constructor + summarize), `playByPlay/fullPbp.js` (extend `TURNOVER_MODIFIERS`), `ultistats_server/narration.py` slow-pass schema (add fields to the turnover event spec), `narration/narrationEngine.js` `applyTurnover` (forward the flags), and possibly `teams/gameSummary.js` if CSV columns enumerate flags.
  - Backwards compat: existing serialized turnovers without these flags should default false on load — no migration needed.
- [ ] **Feature**: Undo across point boundaries
  - Today the global Undo (`undoEvent` in `gameLogic.js`) handles in-point events and rolls back possessions/scores within the current point, but there's no UI affordance to undo *backwards* across a point boundary (e.g. "the previous point's last event was actually wrong"). Once a point ends, its events are effectively read-only from the UI even though they're still in the data model.
  - Two interaction ideas — **either could be the v1**, or both can ship together:
    1. Extend the existing `Undo` button so when the current point has no events, it walks back into the previous point's last event. Confirm-prompt before crossing the boundary.
    2. **"Undo to this row" in Log view.** Long-press (or context-menu / kebab) on any event row in the Game Log to expose `Undo to here`. Tapping it pops every event after that row, restoring scores / possession state / point structure. Confirm-prompt with a count if more than 3–4 events would be removed: "This will undo 7 events, including the end of point 4. Continue?"
  - Touch points: `gameLogic.js` (extend `undoEvent` to optionally cross point boundaries; new `undoToEvent(eventRef)` helper), `ui/eventLogDisplay.js` (long-press handler, confirm modal), score/possession rollback already exists for in-point undo and would extend naturally. Watch for: stat re-derivation, narration provisional events that may be tied to specific possessions, and `moveToNextPoint` side effects (timer, sync) that need to be reversed when popping a "Point ended" event.

- [ ] **Bug**: `point.startTimestamp` is null at score time despite being set at point start
  - **Symptom**: `gameLogic.js` logs `Warning: point.startTimestamp is null; setting to now` during `updateScore()`, then sets it to the current time (score time, not point start time).
  - **Root cause (suspected)**: `pointManagement.js:78` sets `point.startTimestamp = new Date()` immediately after pushing the point to `game.points`. However, `saveAllTeamsData()` serializes the game to localStorage as JSON shortly after. When the game object is later read back (via sync cycle, cloud refresh, or localStorage reload), the `Date` object may not survive deserialization — JSON.stringify converts Dates to ISO strings, but the deserializer may not reconvert them, or the in-memory game reference may get replaced by a freshly deserialized copy that lost the Date.
  - **Impact**: Any code comparing `point.startTimestamp` to other timestamps during the point gets the wrong value. The `transitionToBetweenPoints()` "reset to ending line" logic used `pointStartTime` to decide whether the pending line was modified during the point — but since `pointStartTime` was actually score time, modifications made during the point appeared to be "before" the point started, causing them to be overwritten. (Worked around in the line-selection-mode branch by also checking `lineSelectionModes.main`.)
  - **Where to look**: `pointManagement.js` (startNextPoint), `store/storage.js` (serialization), `store/sync.js` (syncGameToCloud / refreshPendingLineFromCloud / refreshGameStateFromCloud), `store/models.js` (Point constructor / serialization). Check whether the in-memory `game` object gets replaced by a deserialized copy after sync, and whether Date fields survive the round-trip.

---

## Future Enhancements

Bigger asks, deferred until current themes settle.

### Visual polish
- [ ] **Light-mode contrast pass.** The dark-mode work added a contrast auditor
      (`tests/sweep/`) that measures every visible text run and border against
      its real composited backdrop. Dark mode came out clean — 0 findings that
      are dark-only or worse-in-dark — but it surfaced ~147 *pre-existing*
      light-mode findings that nobody has ever swept for. Nothing here is new
      or urgent; it is a standing list of places the app is harder to read on
      a bright sideline than it needs to be. The recurring ones:
      - every orange dialog header (`.prominent-dialog-header h2`) is 2.53:1
        on white. Fixing it means a darker orange for text specifically —
        `--brand-orange-ink` existed for this and was pruned as unused.
      - the in-game point-timer warning colors are 2.52:1 (`--timer-warning`)
        and 3.84:1 (`--timer-danger`) on the white header — the one place a
        coach glances at mid-point. (`--timer-negative` clears 4.5 at rest;
        note both danger and negative *pulse*, so they spend part of every
        second below their measured value. The auditor freezes animations, so
        these numbers are the best case.)
      - MMP green on its pastel surface is 3.51:1 app-wide (the FMP/MMP
        buttons in edit-player and the roster, and the select-line ratio
        badge, which was migrated onto that pair in Aug 2026). FMP purple is
        fine at 5.13:1; the green is the weak half of the pair.
      - disabled buttons (`Score`, `Callahan`, `Continue Game`) sit at
        2.0–3.6:1. Arguably intentional for a disabled control, but the Score
        button is the primary action of its dialog.
      Run `BREAKSIDE_THEME=light` in `tests/sweep` for the current full list;
      see ARCHITECTURE.md § Theming.

### User & Auth
- [ ] User profile settings (update display name)
- [x] Google OAuth login
- [ ] Apple OAuth login
- [ ] Custom SMTP for Supabase emails (branded sender)
- [ ] **Brand the OAuth consent screen (before going wide).** Google sign-in
      currently shows the raw Supabase project domain
      (`mfuziqztsfqaqnnxjcrr.supabase.co`), surfaced as a "Will appear as…" note
      on the landing-page auth modal (`landing/index.html` `.google-note`). Needs a
      custom auth domain (e.g. `auth.breakside.pro`), which requires the paid
      Supabase tier. Once configured, drop the apologetic `.google-note` line.

### Team Management
- [ ] QR code generation for invites
- [ ] Role change (promote viewer to coach)
- [ ] Invite via email (send directly from app)
- [ ] Bulk invite (upload CSV of emails)
- [ ] Team admin role (separate from coach)
- [ ] Invite analytics dashboard

### Player Features
- [ ] Player ↔ User account linking
- [ ] Player self-service (edit own stats, profile photo)
- [ ] O-line / D-line presets with auto-promotion
- [ ] Refactor player references to use ID instead of name
  - Currently `Point.players`, `pendingNextLine`, etc. store player names
  - Using `player.id` (e.g., "Alice-7f3a") would handle duplicate names
  - Requires updating all `includes(playerName)` checks, serialization, data migration

### Infrastructure
- [ ] WebSocket upgrade for real-time sync
- [ ] Rate limiting and abuse prevention
- [ ] "Publish" games to make them searchable/discoverable
- [ ] Git-based backup and version history
- [x] **e2e tests: stop hardcoding ports 3099/8100.** Done (G7): `tests/helpers/constants.ts` now derives per-worktree ports from a hash of the repo root path (frontend 3100–3899, backend 8200–8999, same slot), overridable via `BREAKSIDE_E2E_FRONTEND_PORT`/`BREAKSIDE_E2E_BACKEND_PORT`; the config, helpers, and specs all import from it, and global-setup logs the derived ports each run. `scripts/dev-server.sh` now honors `$BREAKSIDE_PORT` (CLI arg still wins; bare invocation still defaults to 3000).

### Battery

Field reports: phones don't last a full day of 3–4 games. Battery sinks ranked by suspected impact (no instrumentation yet — confirm before optimizing):

1. **Screen-on time for hours** — by far the dominant drain. CPU, radio, and display all stay warm any time the screen is lit.
2. **In-game polling for non-Active-Coach roles** — Line Coach / Viewer poll the game state on a short cadence even when nothing has changed. Active Coach is push-only, so this only hits the secondary devices.
3. **Audio pipeline while mic is active** — `ScriptProcessorNode` resampling + base64 PCM frames over WebSocket every ~170ms. Modest when running, zero when idle. Worth measuring before changing anything; AudioWorklet may be more efficient than the deprecated ScriptProcessor we use now.
4. **Light HTTP polling between games** — what the Advanced Settings "Cloud refresh interval" controls. Almost certainly noise compared to (1) and (2), but exposing it means a power-user can dial it down.

Higher-leverage interventions, in roughly priority order:

- [ ] **Screen Wake Lock API + brightness guidance**
  - Acquire a wake lock during active game so the OS keeps the screen on even at very low brightness — coaches can then dim aggressively (the dominant battery saver) without their session dying.
  - Show a small "screen lock active" indicator + an explicit unlock affordance for when the user wants to pocket the phone.
  - Falls back gracefully on browsers that don't support the API.

- [ ] **Pause polling when tab is backgrounded / phone is pocketed**
  - The Page Visibility API hook already exists for wake recovery — extend it to suspend all setInterval polling loops while `document.visibilityState === 'hidden'`.
  - Resume + immediate-refresh on visibility change.
  - Risk: a backgrounded Line Coach misses an Active Coach handoff. Acceptable — wake recovery already handles re-sync on resume.

- [ ] **Audit Full PBP for persistent repaints / animations**
  - Long-running CSS animations and frequent DOM mutation force the compositor to stay active. Audit for: animated icons that never stop, the mini-log auto-scroll on each event, gradient/box-shadow that triggers full-layer repaints.

- [ ] **AudioWorklet migration for the narration mic path**
  - `ScriptProcessorNode` runs on the main thread and is deprecated; AudioWorklet runs on the audio thread and is the documented modern replacement. Should reduce per-frame CPU + main-thread jank during narration.
  - Bundled with the speech-driven flows when those land (less churn to do it once).

- [ ] **WebSockets for non-Active-Coach in-game sync** — see `### Infrastructure` above
  - Less polling overhead on the secondary devices. Modest savings; only worth it after (1) and (2) above are shipped.

- [ ] **Instrument before you optimize**
  - Add a lightweight battery-impact log: timestamp + `navigator.getBattery()` snapshots at session start, point boundaries, and game end. Even rough deltas across 2–3 games would tell us which intervention matters before we build it.

### Line Selection
- [x] Auto fill algorithm (priority-ordered) — shipped on `auto-line`
  - `computeAutoLine` / `buildAutoLineStats` in [game/gameScreen.js](game/gameScreen.js). Auto only *fills empty slots* up to the field count (7 for 7v7, 5 for 5v5, …); already-checked players are kept, and a full line fills nothing. Wholesale clears so Auto can repopulate from scratch.
  - Strict decreasing priority: (1) satisfy the active gender ratio's per-gender targets; (2) prefer players **not on the last point**; (3) prefer **less time played**, bucketed into **quintiles** (equal-time players share a bucket) so "about the same time" is one equivalence class; within a quintile tiebreak by (4) **fewer points played**, then (5) **longest current bench streak** (out the most points in a row).
  - All metrics are **current-game** scope. Time = `getPlayerGameTime`; roster = `getActiveRoster()` (event-aware, includes pickups).
- [x] Handlers / cutters + O/D-line preference in Auto — shipped on `auto-line-2`
  - Player `position` (handler / cutter / hybrid) and `defaultLine` (O / D / Crossover) attributes on the Player model (unset ⇒ hybrid / crossover); editable in the roster player dialog, and **inherited-but-overridable per event** (tap a team player in the event roster → "Event Position / Line"; overrides stored in `event.roster.overrides`). Resolvers `getEffectivePosition` / `getEffectiveDefaultLine` (store/storage.js).
  - Auto priority is now: gender ratio → **rest (not on last point)** → **position** (aim ≥ floor(n/2) handler-capable, ≥ ceil(n/2) cutter-capable; hybrids/unlabeled satisfy both) → **O/D-line preference** (by resolved point side; skipped in combined mode mid-point and On Deck) → PT quintile → fewer points → bench streak → name. Position/O-D are **soft** (never override rest); only gender pulls in a just-played player. Need-aware greedy in `computeAutoLine` (game/selectLine.js).
  - Warning toast "Auto line may have too few handlers/cutters" when the minimums can't be met (silent when players are unlabeled).
  - **Still open**: explicit per-line **minimum** counts the coach can set (current rule is a fixed half/half target, not a configurable minimum).
- [ ] AI/stats-driven "moneyball" auto-subbing
  - Use accumulated game/event stats (and/or an AI model) to pick players who **play well together** and suggest matchup-aware lines, beyond simple fatigue/rotation balancing.
- [ ] Reward-workhorses tiebreak (optional)
  - A deeper tiebreak that, all else equal, can prefer players with more total points played — deferred; current final tiebreak is name for determinism.
- [x] Wholesale/Auto icon UI redesign — shipped on `line-selection-rework`
  - Replaced the cycling Manual/Wholesale/Auto text toggle with two one-shot actions: **Wholesale** (clear) and **Auto** (fill empty slots). No persistent "mode" — selection is always manual.
  - Empty-checkbox icon for Wholesale, now living in a **table controls header row** (over the checkbox column); a lightning-bolt icon for **Auto** in the toolbar. The Game/Event time toggle also moved into that header row.
  - Snapshot/double-tap-restore was dropped along with modes (no longer meaningful — Auto augments the current selection rather than replacing it, and Wholesale is a deliberate one-shot clear).
  - Also added the **Combined / Separate** planning-mode control (per-game, synced): Combined = Next + On Deck; Separate = distinct O/D lines. See README and ARCHITECTURE § *Combined vs Separate line planning*.
- [ ] "Suggest lineups every point" toggle in pre-game/roster screen (auto mode as default each point)

### UI/UX
- [ ] Comprehensive UI redesign
- [ ] **Dark mode support** — *in progress in its own session (2026-08-09)*.
      Note the battery angle: on an OLED phone (iPhone X and later except XR/11,
      most flagship Androids) a black pixel is simply off, so dark mode is a
      real power saving for the whole session — no interaction, no gating, no
      way for it to cost a coach a tap. Our current UI is mostly white, which is
      the worst case on OLED. It does nothing on an LCD phone (SE, XR, 11),
      where the backlight is uniform regardless of what's drawn. Worth saying
      that plainly wherever it's offered rather than implying a universal win.
- [ ] **Rename "Advanced Settings" → "App Settings", split basic vs advanced.**
      The screen has grown well past "advanced" (display density, player
      numbers, field geometry, sync cadence, battery) and the name now
      discourages coaches from finding settings they'd actually want. Keep one
      screen, organised into a basic section (the things a normal coach should
      touch — display, battery, dark mode) and an advanced section (narration
      A/B knobs, auto-line priority order, field thresholds). Touches
      `settings/advancedSettings.js` (the declarative `SCHEMA` array already
      groups fields, so this is mostly regrouping plus a section divider) and
      the menu label in `game/gameScreenPanels.js` (`#menuSettings`). Pairs
      naturally with the dark-mode session, since that adds a setting.
- [ ] **Black standby screen between/during points** (design settled 2026-08-09,
      not built). The biggest OLED saving available, and a better between-points
      display than the full UI anyway.
  - **Trigger:** repurpose the ☀ indicator in the game header (added by the
    `battery` branch) to enable/disable standby, with a toast confirming the new
    state on each tap.
  - **During a point:** show the score and "Tap to return", nothing else. No
    game clock, no point clock — the less lit area the better, and neither is
    needed while standing on the line.
  - **Between points:** also show the countdown timer for starting the next
    point, which is the one number that matters in that window.
  - **Tap anywhere returns** to the full UI, and that first tap must be
    *swallowed* — it exits standby without also firing whatever control sits
    underneath, or coaches will record phantom events on wake.
  - Dim toward true black (`#000`), not grey: on OLED the saving scales with how
    little light is emitted, and a grey scrim over a white UI leaves most of it
    lit.
  - **Open question:** what puts it *into* standby — only an explicit tap on the
    ☀, or an idle timeout once enabled? An idle timeout is the bigger win but
    needs gating (never for the Active Coach mid-point on offense; fine between
    points, on defense, or for a Line Coach / viewer). Start with the explicit
    tap, which has no failure mode, and consider the timeout after field use.
  - Composes with the wake lock rather than replacing it: the lock keeps the
    screen alive, standby makes keeping it alive cheap.
- [x] **Compact / roomy density toggle for Full PBP**
  - Inline icon button in the Full PBP header (between mode pill and Undo) toggles between "roomy" (default — build-207 numbers: min-height 48, margin 6, name padding 8/10, action padding 7/10) and "compact" (build-206: min-height 40, margin 4, name padding 6/8, action padding 5/10).
  - Persisted per-device in localStorage as `breakside_full_pbp_density`, applied as a `density-compact` class on `.panel-playByPlayFull`.
  - Mini-log absorbs the resulting slack either way (`.full-pbp-log-reserve` is `flex: 1 1 auto`).

---

## Quick Reference

### Testing Auth Locally

```bash
# Auth is REQUIRED by default (since the review program's F1 hardening).
# For local dev with auth disabled, either use the helper (recommended —
# isolated data copy + free port + CORS *):
./scripts/dev-backend.sh

# ...or disable auth explicitly:
cd ultistats_server && ULTISTATS_AUTH_REQUIRED=false python3 main.py

# Test with auth enabled
ULTISTATS_AUTH_REQUIRED=true SUPABASE_JWT_SECRET=your-secret python3 main.py

# Run auth tests
pytest test_auth.py -v
```

### Deploy Commands

```bash
# Local dev server
./scripts/dev-server.sh            # serves on http://localhost:3000

# Deploy to staging (working directory, no commit needed)
# ALWAYS pass a short version description as the argument — it's written
# into version.json as `deployLabel` and shown in the staging Online/About
# overlay so you and other testers can visually confirm which build is
# live (especially useful when rapidly iterating).
./scripts/deploy-staging.sh "test audio narration v2"

# Deploy PWA to production (via GitHub Actions)
git push origin main

# Force PWA cache refresh
# Edit service-worker.js: increment cacheName (e.g., 'v8' → 'v9')

# Deploy API to EC2
ssh ec2-user@3.212.138.180
cd /opt/breakside && sudo git pull && sudo systemctl restart breakside
```

### Supabase Dashboard

- Project: https://mfuziqztsfqaqnnxjcrr.supabase.co
- Auth settings: Dashboard → Authentication → Settings
- User management: Dashboard → Authentication → Users
- **Important:** Set Site URL to `https://www.breakside.pro` for email redirects

### Backend: CORS headers on unhandled 500s (from staging shakedown, 2026-07-03)

Both shipped as G2 (branch `g2-backend-hardening`; tests in
`ultistats_server/test_error_handling.py`; ops rule documented in
ARCHITECTURE.md § Data Directory Structure). Requires the usual EC2 backend
restart to take effect after merge.

- [x] An unhandled exception in FastAPI returns a bare 500 **without CORS
      headers** (Starlette's ServerErrorMiddleware sits outside CORSMiddleware),
      so browsers block the response and fetch rejects with a TypeError
      ("Load failed" on Safari) — the client can't tell a server bug from a
      network drop. Add an exception handler / middleware ordering fix so
      error responses carry CORS headers. Confirmed in the wild 2026-07-03:
      a PermissionError 500 on game sync surfaced in Safari as "Load failed"
      with no status code, costing three diagnosis round-trips.
      → Done: `Exception` handler in `main.py` returns 500 JSON with CORS
      headers mirroring the middleware config (origin allowlist + credentials).
- [x] **Version-backup write failure shouldn't 500 the whole sync.** The
      2026-07-03 staging incident was a root-owned `versions/` dir under one
      old game in `/var/lib/breakside/data/games/` (PermissionError in
      `atomic_write_json`) failing every sync of that game. Consider: log
      loudly + still accept the game state (or return a structured error),
      and add a startup ownership/writability check over the data tree.
      → Done: backup write degrades (loud `VERSION BACKUP FAILED` log, sync
      still succeeds); `assert_data_dir_writable()` runs at startup (fail-fast
      on the data dir, prominent ERROR for unwritable nested dirs).
