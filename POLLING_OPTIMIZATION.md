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

## F4 — idle backoff *(not done; the target moved)*

The brief treated F4 as speculative pending measurement. Measurement has now
happened, and it says something more specific than "back off when idle".

**After F1, all remaining in-game traffic is the controller ping.** The measured
idle minute above is 30 pings and literally nothing else. There is no diffuse
remainder left to shave — there is one loop.

Note what that means for the radio, which is the thing that costs battery:
request *bytes* fell roughly 7× (a real game averages 5.85 KB, so ~136 KB/min →
~19 KB/min), but radio *wakes* only went 50/min → 30/min, because the 2s ping
sets the floor. Everything cheap has been taken.

That loop can't simply be stretched: roles expire server-side after 30 seconds
without a ping, and since F1 the ping is also the change-detection channel, so
slowing it slows how fast one coach sees another's edits.

But those constraints both weaken in the case that matters most:

> **A solo coach has no second coach to hand off to and no second coach whose
> edits to detect.** `PING_INTERVAL_ACTIVE` is 2s because the holder holds a
> role — but a coach alone in a game is pinging 30×/minute to keep a role
> nobody is contesting and to detect changes nobody is making.

The app already knows when this is true: role buttons stay hidden until
multi-coach is detected, and the ping response carries `connectedCoaches`. A
solo coach could ping at 5–10s (comfortably inside the 30s expiry) and snap back
to 2s the moment a second coach appears — costing at most one backed-off
interval of extra latency in the transition, at a moment when nothing is being
recorded yet.

That would be a 3–5× cut in the *only* remaining in-game request stream. It is
also the highest-risk change in this whole sequence — role expiry, handoff
timing and change propagation all hang off that one interval — which is why it
was left for a decision rather than done overnight. **Verify against a real
game's battery report first**, per the brief's own gate.

A second, smaller one deliberately not taken: the client could adopt the change
stamp from its *own* sync response and skip the refetch that follows each of its
own writes (the Active Coach's dominant remaining case). It's declined because
`save_game_version` may merge a *different* `pendingNextLine` into what we
pushed, so the stored state isn't always what we sent — adopting the stamp would
silently skip the merged result. Doing it safely needs the server to report
whether it stored the body verbatim.

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
- **Backend:** `pytest ultistats_server/ -q` — 357 pass.
- **e2e:** full suite from `tests/` with `CI=1` — 26 pass, including
  `04-sleep-wake-recovery` (asserts ping behavior directly) and
  `03-multi-coach-roles`. 03 and 07 re-run in isolation with
  `--retries=0 --repeat-each=4`: 28/28, no flake.

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
