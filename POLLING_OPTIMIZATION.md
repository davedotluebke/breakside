# Polling & Radio-Wake Optimization — session handoff

Self-contained brief for a session picking up the *next* stage of the battery
work. Everything below was verified against the code on 2026-08-09; line
numbers are from branch `battery`.

> **Dependency: branch `battery`.** This builds directly on
> `utils/powerManager.js` / `utils/powerPolicy.js` / `utils/powerLog.js`, which
> exist only on that branch. If `battery` has been merged to `main`, branch from
> `main` as usual. If it hasn't, branch from `battery`. Read
> **ARCHITECTURE.md § Power Management** before touching anything — it documents
> the plan-broadcast pattern and three traps that will bite otherwise.

---

## Why this is worth doing

The battery cost of polling is not the CPU work in the callbacks — updating a
text node is free. It's two other effects:

- **Radio tail.** After any network request a phone's radio stays in a
  high-power state for several seconds before dropping to idle. Poll every 2–3
  seconds and it never idles. The cost tracks *how often you woke the radio*,
  not how many bytes you sent. Ten requests bunched together cost about one
  tail; ten spread out cost ten.
- **Deep-idle fragmentation.** Scattered wakeups stop the SoC settling into low
  power states at all.

So there are two levers: **send fewer requests**, and **make the ones you send
happen at the same moment**. The findings below are ordered by how much they
move those.

---

## Verified loop inventory

Everything recurring in the app, post-`battery`. All are gated on page
visibility already; that work is done.

| Loop | Cadence | Network? | Site |
|---|---|---|---|
| controller ping | 2s w/ role, 5s idle | **yes** | `game/controllerState.js:478` |
| game state refresh | 3s | **yes** | `game/gameScreenSync.js:466` |
| game screen timer | 1s | no | `game/gameTimer.js:287` |
| point timer | 1s | no | `game/pointManagement.js:318` |
| team auto-refresh | 10s (cfg) | **yes** | `teams/activeGamePolling.js:100` |
| auto-sync | 10s (cfg) | **yes** | `store/sync.js:1670` |
| roster poll | 10s | **yes** | `teams/rosterManagement.js:1565` |
| active-game poll | 30s | **yes** | `teams/activeGamePolling.js:26` |
| SW update check | 5 min | yes | `main.js:206` |
| countdown (between points) | 1s | no | `game/pointManagement.js:257` |
| handoff countdown | 50ms | no | `game/controllerState.js:1357` |
| pull hangtime | 100ms | no | `playByPlay/pullDialog.js:78` |

The last three are transient and bounded by a dialog or a between-points
window. Leave them alone.

Cadence constants: `PING_INTERVAL_ACTIVE`/`PING_INTERVAL_IDLE`
(`controllerState.js:37-38`), `AUTO_SYNC_INTERVAL` (`sync.js:1594`),
`ROSTER_POLL_INTERVAL` (`rosterManagement.js:1555`).

---

## F1 — The 3-second in-game poll downloads the entire game

**This is the whole ballgame. Do this one even if you do nothing else.**

`startGameStateRefresh` (`game/gameScreenSync.js:452`) runs every 3 seconds
while in a game and calls one of:

- `refreshPendingLineFromCloud` (`store/sync.js:1172`) — Active Coach
- `refreshGameStateFromCloud` (`store/sync.js:1227`) — everyone else

**Both issue `GET /api/games/{game_id}`, which returns the complete game
payload** (`ultistats_server/routers/games.py:104` → `get_game_current`) — every
point, every event, the lot. There is no conditional-fetch machinery on that
route: no change stamp, no ETag, no `If-None-Match`.

So each device in a game pulls the full game roughly **20 times a minute**,
whether or not anything changed. Average game is 5.85 KB (ARCHITECTURE.md §
Performance Characteristics) and grows as it goes, so this is a steady stream of
non-trivial payloads keeping the radio hot — and game state only actually
changes when a coach records something.

**The app already solves this correctly elsewhere.** The public share viewer
polls `GET /api/share/{hash}/poll` (`ultistats_server/routers/shares.py:178`),
which returns only `{"version": "<mtime_ns>"}`, and refetches the full game only
when the stamp differs. The coach's own app — the one whose battery we care
about — is the one doing it the expensive way.

### Preferred fix: put the stamp on the ping response

`POST /api/games/{game_id}/ping` (`ultistats_server/routers/controller.py:236`)
**already runs every 2 seconds and already returns full controller state**
(`controllerState`, `hasPendingHandoffForMe`, `connectedCoaches`, `serverTime`).
Add a game change stamp to that response and the 3-second poll can be dropped
entirely: the client refetches the full game only when the stamp it holds
differs from the one the ping just handed it.

That removes a request rather than merely shrinking it — strictly better than
adding a parallel `/poll` route for the authenticated path.

- Reuse `get_game_current_mtime_ns()` — already used by the share poll.
- Client side: `gameScreenSync.js` keeps the last-seen stamp; `controllerState`'s
  ping handler surfaces the new field. Refetch on mismatch, and on the first
  ping after a resume.
- Fall back to an unconditional refetch if the field is absent, so an old client
  against a new server (and vice versa) still works.

### Risks to respect

- **The AC's `pendingNextLine` merge depends on seeing Line Coach edits
  promptly.** The whole intent-rule design (TODO.md § Multi-Coach Line
  Selection) assumes near-live refresh during a point. The mtime stamp bumps on
  *any* coach's write, so this should hold — but verify explicitly that an LC
  line edit still reaches the AC within a few seconds.
- **Don't slow the ping.** Roles expire server-side after 30 seconds without one.
- Backend change ⇒ **EC2 restart on deploy** (`sudo git pull && sudo systemctl
  restart breakside`).

---

## F2 — Two 1-second display timers doing the same job

`gameTimer`'s loop (`game/gameTimer.js:287`) updates the header clock and the
Line-tab time cells. `pointTimer`'s loop (`game/pointManagement.js:318`) updates
the elapsed-point readout. Both fire every second, both only while in a game,
both only touch DOM text. They should be one loop.

Halves the in-game display wakeups. No behavior change, no network, no backend.
Collapse `LOOPS.GAME_TIMER` and `LOOPS.POINT_TIMER` in `utils/powerPolicy.js`
into a single entry and update `tests/unit/powerPolicy.test.mjs` accordingly.

Do this one first — it's the cheapest real win on the list.

---

## F3 — Phase-align the surviving loops

Out of game, `teamAutoRefresh` (10s), `autoSync` (10s) and `rosterPoll` (10s)
are on identical cadences and `activeGamePoll` (30s) is a clean multiple — but
each installs its interval whenever its module happens to start, so their phases
are scattered and the radio gets poked at unrelated moments.

Give `utils/powerManager.js` a single base tick with per-loop periods, and
dispatch everything whose period divides the current tick. Same-period loops
then fire in the same tick, share one radio wake, and — being same-origin — share
the HTTP/2 connection.

`powerManager` already owns the plan and the visibility listener, so owning the
tick is a natural extension rather than a new concept.

**Align to the device's own start epoch, not the wall clock.** Aligning every
client to :00 and :10 would hand the server a thundering herd.

After F1 the only in-game network loop left is the 2s ping, so there is nothing
in-game to align — F3 is purely an out-of-game win, which is why it ranks below
the other two.

---

## F4 — Idle backoff (only if the numbers justify it)

Between points, and on defense, nothing changes quickly. Cadences could stretch
when nothing has been recorded for a while and snap back on any interaction or
any observed change.

Hard floor: **the controller ping cannot stretch past the 30-second server-side
role expiry**, and wants comfortable margin under it. Realistically the ping
stays at 2–5s and only the other loops back off, which after F1 and F3 is a
small remainder. Treat this as speculative until measurement says otherwise.

---

## Order of work

1. **F2** — trivial, zero risk, do it first.
2. **F1** — the actual win. Backend + client + EC2 restart.
3. **F3** — moderate, client only.
4. **F4** — only if the log says there's something left worth chasing.

## Measure before and after

`utils/powerLog.js` already counts exactly what's needed: wakeups per loop and
requests per subsystem class. Read it at **Online/About → "Battery report…"**
(copy button included).

Take a baseline *before* starting — ideally a real game — and compare after F1.
The expected signature is `requests.games` collapsing from ~20/min to near zero
while nothing is being recorded, with `requests.controller` unchanged. If that
doesn't show up, F1 didn't land.

---

## Traps and constraints

Read **ARCHITECTURE.md § Power Management** first. The three that will bite:

- **`stopControllerPolling()` is destructive** — it clears the polling game id
  and resets every role flag. Use `suspendControllerPolling()` /
  `resumeControllerPolling()` for anything power-related.
- **Resume only what you suspended.** `autoSync` and `rosterPoll` are also
  stopped deliberately by sign-out and by navigation; a plain "plan says true →
  start" resurrects them. Both track a `suspendedByPower` flag — follow it.
- **Adding a loop** means: an id in `LOOPS` (`utils/powerPolicy.js`), a rule in
  `loopPlan()`, and a `breakside:power-plan` listener in the owning module. Never
  a bare `setInterval` at module scope.

Plus the usual: work in your own worktree (CLAUDE.md § Multi-Session
Development), and any `ultistats_server/` change needs the EC2 restart.

## Verification

- **Unit:** `node --test 'tests/unit/*.test.mjs'` — note the glob form; the bare
  directory form fails on Node 25.
- **e2e:** full suite from `tests/` with `CI=1`. Pay attention to
  `scenarios/04-sleep-wake-recovery.spec.ts` (the power-management tests assert
  ping behavior directly) and `scenarios/03-multi-coach-roles.spec.ts` (role
  timing). 03 and 07 are historically flaky under parallel load; re-run with
  `--retries=0 --repeat-each=4` in isolation before blaming your change.
- **Backend:** `pytest ultistats_server/ -q`.
- **Manual:** `./scripts/dev-backend.sh` + preview with
  `?api=http://localhost:<port>` (see CLAUDE.md — a localhost preview can't use
  the prod API).
- **Measured:** the before/after battery report described above.
