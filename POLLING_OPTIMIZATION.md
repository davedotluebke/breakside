# Polling & Radio-Wake Optimization — status

Branch `polling-opt`, built on `battery` (which had not merged yet, so this
branch carries it — see *Merging* below). **F1, F2 and F3 are done. F4 is not,
and the case for it has changed shape.**

The design rationale now lives where it belongs, in **ARCHITECTURE.md § Power
Management** (§ The shared base tick, § In-game change gating). This file is
the record of what was measured and what's left.

---

## Why any of this mattered

The battery cost of polling isn't the CPU work in the callbacks — updating a
text node is free. It's the radio: after any network request a phone's radio
stays in a high-power state for several seconds before dropping to idle. Poll
every 2–3 seconds and it never idles. The cost tracks *how often you woke the
radio*, not how many bytes you sent. Ten requests bunched together cost about
one tail; ten spread out cost ten.

So there were two levers: send fewer requests, and make the ones you send
happen at the same moment. F1 and F2 are the first; F3 is the second.

---

## F1 — the in-game poll no longer downloads the game *(done)*

`startGameStateRefresh` ran every 3 seconds and called `GET /api/games/{id}`,
which returns the complete game payload — every point, every event. Twenty full
payloads a minute per device, whether or not anything had changed, for a game
state that only moves when a coach records something.

It now pulls only when a change stamp says the server's copy moved:

- `POST /api/games/{id}/ping` carries `gameStamp`. Coaches already send this
  every 2s for role keepalive, so for them change detection costs **nothing**
  and the poll goes away entirely rather than merely shrinking.
- `GET /api/games/{id}/poll` returns the same stamp on its own, for in-game
  clients that hold no controller session and so never ping — viewers. ~30
  bytes against ~6 KB.

Both use `get_game_current_mtime_ns`, the same token the public share poll has
used since sharing shipped. The coach's own app was the one doing it the
expensive way.

**Measured.** `powerLog.snapshot()` deltas over one idle in-game minute against
a real server, taken twice — once normally, once with `gameStamp` stripped from
the ping and `/poll` forced to 404 (i.e. an old server, which is also the
backward-compatibility path):

| | `requests.games` | `requests.controller` |
|---|---|---|
| Old server / pre-F1 | **20** full payloads | 30 pings |
| New | **0** | 30 pings |

That's the signature the original brief predicted, exactly. `wakeups` are
unchanged (`gameStateRefresh` still ticks 20×/min — it just makes no request),
and the old-server run confirms the fallback degrades to the old behavior
rather than to silence.

`tests/scenarios/09-in-game-change-gate.spec.ts` pins the same result at
four-ticks granularity, and is a verified discriminator: stub the gate out and
the window goes back to 4 pulls.

**Latency went down, not up.** The ping fires `breakside:game-stamp-changed`
when its stamp moves and the refresh runs on that event instead of waiting out
the next 3s tick, so an Active Coach sees a Line Coach's line edit within a ping
(≤2s) rather than within a poll (≤3s). That was the risk the original brief
flagged — the `pendingNextLine` merge assumes near-live refresh — and it's now
strictly better than before. Both halves are asserted together in one spec,
because either alone is trivially satisfiable by breaking the other.

## F2 — the second 1s display timer was dead *(done)*

The brief called the two 1s in-game timers duplicates to be merged. They
weren't. `updatePointTimer()` formatted elapsed point time into `#pointTimer`,
an element removed in `1f36e0d` (Feb 2026, "Remove legacy screen-based in-game
UI"). From then until now it woke the phone once a second for the whole of every
game to build a string and hand it to a `getElementById` that returned null.

So there was nothing to merge — just a loop to delete. In-game display wakeups
halved exactly as predicted, with no behavior change at all.

## F3 — the out-of-game polls share one tick *(done)*

Team auto-refresh, auto-sync, roster poll and the active-game poll each
installed their own `setInterval` whenever their module happened to start —
sign-in, opening the roster screen, leaving a game — so their phases scattered.
They now ride a single base tick owned by `powerManager`, which dispatches
`breakside:power-tick` with the ids that are due. At the defaults this
reproduces the old cadences exactly (base 10s; three loops every tick, the 30s
poll every third) — only in phase.

One correction to the original brief: the roster poll already followed the Cloud
refresh interval, not a fixed 10s. Three loops track that setting; only the
active-game poll is fixed.

Scheduling choices and the traps behind them are in ARCHITECTURE.md.

---

## F4 — solo-coach ping backoff *(done)*

**After F1, all remaining in-game traffic is the controller ping.** The measured
idle minute above is 30 pings and literally nothing else. There is no diffuse
remainder left to shave — there is one loop.

Note what that means for the radio, which is the thing that costs battery:
request *bytes* fell roughly 7× (a real game averages 5.85 KB, so ~136 KB/min →
~19 KB/min), but radio *wakes* only went 50/min → 30/min, because the 2s ping
set the floor. Everything cheap had been taken.

That loop can't simply be stretched, for two reasons — except that both weaken
in the case that matters most:

> **A solo coach has no second coach to hand off to and no second coach whose
> edits to detect.** `PING_INTERVAL_ACTIVE` is 2s because the holder holds a
> role — but a coach alone in a game is pinging 30×/minute to keep a role
> nobody is contesting and to detect changes nobody is making.

### One correction to the brief

The brief (and `ping_controller`'s docstring) said roles expire 30 seconds after
the last ping. **They expire at 120 seconds** — `STALE_TIMEOUT_SECONDS`, raised
from 30 deliberately because mobile browsers freeze `setInterval` on hidden
pages and a pocketed phone was losing roles. Both have been corrected.

This is why F4 turned out to be the best remaining item rather than a
speculative one: a 10s cadence sits 12× under the expiry, not 3×.

### What landed

The server names the cadence; the client obeys. `POST /ping` returns
`pingInterval` — 10s solo, 2s once a second coach is connected — and the client
latches multi-coach stickily, so once it has seen one it returns to role-based
timing for the rest of the game.

In-game requests while solo: **30/min → 6/min**, in the only loop that was left.

Three things were needed to make it safe, each covered in ARCHITECTURE.md
§ Power Management and in tests:

1. **Cadence is decided atomically with recording the ping**, or the second
   coach's first ping is answered from a list it isn't in yet and the coach who
   just made the game multi-coach is told to poll slowly.
2. **Handoff expiry is sized to the holder's cadence** (2× their recorded
   interval), because a fixed 10s window can elapse inside one gap of a
   backed-off holder — auto-approving a role away from someone never shown the
   prompt.
3. **One user on two devices is detected and warned about**, and holds both
   copies fast. Coaches are keyed by user id, so two instances of one account
   look solo — the one case where backing off is actively wrong. Supporting it
   properly is a TODO.md item; this only guards it.

### The cost, stated plainly

A solo coach learns that a second coach arrived **on its next ping — so up to
10s late**. Nothing is lost in that window (the widened handoff expiry covers
the one case that could silently take something away), but the first cross-coach
interaction after a join can feel a beat slow.

That gap is asserted as a bound in `tests/scenarios/11-solo-ping-backoff.spec.ts`
rather than hidden. It also broke two existing specs, which is worth knowing:
03 and 09 drove "coach B" purely through the API and never made B a *connected*
coach, so the page under test stayed backed off. They now ping as B like a real
second app would and synchronize on `waitForMultiCoachSeen()`.

**If 10s proves too slow in the field, `BREAKSIDE_PING_INTERVAL_SOLO` tunes it
server-side with no client deploy.** 5s would halve the discovery gap and still
cut requests 30/min → 12/min, which is most of the win; the step from 12 to 6
is the smaller half.

**Still worth verifying against a real game's battery report**, per the brief's
own gate: expect `requests.controller` to fall by ~5× while solo, with
`requests.games` still near zero.

A second, smaller one deliberately not taken: the client could adopt the change
stamp from its *own* sync response and skip the refetch that follows each of its
own writes (the Active Coach's dominant remaining case). It's declined because
`save_game_version` may merge a *different* `pendingNextLine` into what we
pushed, so the stored state isn't always what we sent — adopting the stamp would
silently skip the merged result. Doing it safely needs the server to report
whether it stored the body verbatim.

---

## F5 — one resume, one pull *(done)*

Found by field-testing F1–F4, not by reading the code, and worth recording
because the *measurement* was what misled us first.

The first two field reports showed `games` climbing ~6/min while the coach sat
idle, which reads as "the change gate isn't working". It was working. Both
readings had been taken by backgrounding the app to copy the report to the
clipboard — and taking a reading is itself an event that generates traffic. A
local probe settled it: an idle minute with no backgrounding is **59 pings and
nothing else**; the same minute with one background/restore adds two full-game
pulls and a controller fetch.

Two, not one, and the second was pure waste. Wake recovery re-fetches the game,
then restarts the refresh loop; the restart clears the loop's stamp on purpose
(a stamp from before a sleep is untrustworthy), so its first tick re-pulled the
identical payload three seconds later.

`GET /api/games/{id}` now carries `X-Game-Stamp`, and recovery hands it to
`noteGameStateRefreshed()`. See ARCHITECTURE.md § One resume, one pull for the
four details that make it safe — chiefly that the server stats *before* reading
(so a race costs a redundant pull, never a missed update) and that the seed must
come from the same response as the payload.

**Two lessons for the next person measuring this:**

1. **Read the battery report without leaving the app,** and discard any delta
   that spans a `Backgrounded` increment. The instrument perturbs what it
   measures.
2. **`games` vs `gameSync` matters.** They were one bucket at first, so a coach
   recording a point looked identical to a broken gate. If a report predates
   that split, it can't answer the question.

---

## Measuring

`utils/powerLog.js` counts wakeups per loop and requests per subsystem. Read it
at **Online/About → "Battery report…"** (copy button included).

Its request classification was wrong in a way that would have hidden this work:
the role keepalive lives at `/api/games/{id}/ping` and was being counted as
`games`, burying the 20/min full-game poll inside a bucket three times its size.
Pings are `controller` now, and stamp polls get their own `gamePoll` class.

**The signature to look for in a field report:** in a game with nothing being
recorded, `requests.games` at or near zero while `requests.controller` continues
at the ping cadence. If `games` is still climbing, the change gate isn't
working.

---

## Verification

All green on this branch:

- **Unit:** `node --test 'tests/unit/*.test.mjs'` — 230 pass (note the glob
  form; the bare directory form fails on Node 25).
- **Backend:** `pytest ultistats_server/ -q` — 372 pass.
- **e2e:** full suite from `tests/` with `CI=1` — 30 pass, including
  `04-sleep-wake-recovery` (asserts ping behavior directly),
  `03-multi-coach-roles`, and the new `11-solo-ping-backoff`. 11 re-run in
  isolation with `--retries=0 --repeat-each=3`: 12/12, no flake.

### Three e2e traps this created

Each one cost a full test cycle. They are all consequences of cadence no
longer being a constant, and they will bite anyone touching this again.

1. **A "coach B" driven purely through the API is not a *connected* coach.**
   Specs 03 and 09 claimed a second coach by calling `/claim` and `/sync`
   without ever pinging. That was equivalent when cadence was fixed; now the
   page under test stays backed off, and any assertion about reacting quickly
   is silently re-measuring discovery latency instead. Ping as B, then
   synchronize on `waitForMultiCoachSeen()`.
2. **The harness runs a compressed timescale, and the margins don't compress
   evenly.** The test backend sets `BREAKSIDE_STALE_TIMEOUT=5`, so
   production's 10s solo cadence would expire roles every interval there. The
   cadences are scaled to match in `tests/helpers/constants.ts` — keep the
   cadence-to-expiry margin generous, because the expiry is compressed 24×
   while the cadences are compressed 10×.
3. **Team ids hash from the team name.** Two runs of one test share a team, so
   the second resumes the first's in-progress game — two live instances of one
   account, which correctly trips the duplicate-instance guard and hands both
   the *fast* cadence. A spec about being solo then fails with a baffling
   "expected 10000, received 2000". Spec 11 suffixes team names per worker and
   repeat so `--repeat-each` stays usable.

## Deploying

- `ultistats_server/routers/{controller,games}.py` changed, so this needs the
  **EC2 restart**: `sudo git pull && sudo systemctl restart breakside`.
- Old client against new server, and new client against old server, both work:
  a missing `gameStamp` reads as "no opinion" and falls back to unconditional
  refreshes.

## Merging

`battery` had not merged to `main` when this started, so per the brief this
branched from `battery` and then merged current `main` in. **Merging
`polling-opt` therefore brings the `battery` work along with it.** If you'd
rather land them separately, merge `battery` first — this branch will then
fast-forward cleanly.
