# Polling optimisation and the solo-coach backoff

Status: shipped (branch `polling-opt`, F1 to F4 merged and deployed; verified from git 2026-08-24). Mechanism in ARCHITECTURE.md § Power Management and POLLING_OPTIMIZATION.md. This note is what those do not say.

## The correction that unlocked F4

The brief and the `ping_controller` docstring both said roles expire 30 s after the last ping. They expire at **120 s** (`STALE_TIMEOUT_SECONDS`, raised from 30 because mobile browsers freeze `setInterval` on hidden pages and pocketed phones were losing roles). That made a 10 s solo cadence twelve times under the floor rather than three, which turned the solo-coach backoff from speculative into the best remaining item. Both docstrings were corrected.

## Three constraints the backoff forced

All three are now in ARCHITECTURE § Power Management; the short form so nobody re-derives them:

1. Cadence must be chosen atomically with recording the ping, or the coach who just made the game multi-coach is the one told to poll slowly.
2. Handoff expiry cannot be a constant; it is twice the holder's recorded interval, or a backed-off holder can lose a role without ever seeing the prompt.
3. One user on two devices is guarded, not supported. Connected coaches are keyed by user id, so two instances collapse to one and both would back off. The user chose to keep user-id keying; TODO.md carries the item.

## The e2e trap this created

Specs that drive "coach B" purely through the API never make B a *connected* coach, so the page under test stays backed off and any assertion about reacting quickly is really measuring discovery latency. That silently broke scenarios 03 and 09. Fix: ping as B and synchronise on `waitForMultiCoachSeen()` in `tests/helpers/controllerApi.ts`. Also, the e2e backend runs `BREAKSIDE_STALE_TIMEOUT=5`, so production's 10 s solo cadence would expire roles every interval there; the cadences are scaled to 1500/300 ms in `tests/helpers/constants.ts` and fed to the backend from `playwright.config.ts`.

## Tuning knob

If discovery latency (a solo coach is up to one slow interval late noticing an arrival) matters in the field, `BREAKSIDE_PING_INTERVAL_SOLO` tunes it server-side with no client deploy.
