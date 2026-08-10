/*
 * Unit tests pinning the power policy (utils/powerPolicy.js).
 *
 * Contract under test:
 *  - nothing recurring runs while the page is hidden — this is the whole
 *    point of the module, and the one rule no future edit should quietly
 *    weaken
 *  - in-game loops run only in a game; team-screen loops only outside one
 *  - auto-sync is deliberately NOT gated on `inGame` (it has its own
 *    in-callback guard that must keep covering the just-ended-game window)
 *  - diffPlan reports only transitions, so listeners aren't churned on every
 *    recompute
 *  - the wake lock is held only when supported, enabled, in a game, visible,
 *    and not released by the coach
 *  - the shared base tick keeps same-cadence loops firing together (the whole
 *    point of aligning them) and never ticks faster or polls harder than the
 *    loops did on their own intervals
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 * (no deps — plain node:test against the ES modules)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LOOPS, loopPlan, diffPlan, shouldHoldWakeLock,
    TICK_DRIVEN_LOOPS, ACTIVE_GAME_POLL_MS, DEFAULT_REFRESH_MS,
    loopPeriods, tickSchedule, loopsDueOnTick,
} from '../../utils/powerPolicy.js';

const ALL = Object.values(LOOPS);

// ─── loopPlan ───────────────────────────────────────────────────────────────

test('hidden page runs nothing, in a game or out of one', () => {
    for (const inGame of [true, false]) {
        const plan = loopPlan({ visible: false, inGame });
        for (const loop of ALL) {
            assert.equal(plan[loop], false, `${loop} should be off while hidden (inGame=${inGame})`);
        }
    }
});

test('in a game: in-game loops run, team-screen loops do not', () => {
    const plan = loopPlan({ visible: true, inGame: true });

    assert.equal(plan[LOOPS.CONTROLLER_PING], true);
    assert.equal(plan[LOOPS.GAME_STATE_REFRESH], true);
    assert.equal(plan[LOOPS.GAME_TIMER], true);

    assert.equal(plan[LOOPS.TEAM_AUTO_REFRESH], false);
    assert.equal(plan[LOOPS.ACTIVE_GAME_POLL], false);
    assert.equal(plan[LOOPS.ROSTER_POLL], false);
});

test('outside a game: team-screen loops run, in-game loops do not', () => {
    const plan = loopPlan({ visible: true, inGame: false });

    assert.equal(plan[LOOPS.TEAM_AUTO_REFRESH], true);
    assert.equal(plan[LOOPS.ACTIVE_GAME_POLL], true);
    assert.equal(plan[LOOPS.ROSTER_POLL], true);

    assert.equal(plan[LOOPS.CONTROLLER_PING], false);
    assert.equal(plan[LOOPS.GAME_STATE_REFRESH], false);
    assert.equal(plan[LOOPS.GAME_TIMER], false);
});

test('auto-sync tracks visibility only, not game state', () => {
    // Its own callback skips while a game is live, and that guard is what
    // keeps syncing in the window after a game ends but before the coach
    // leaves the game screen. Gating on !inGame here would break that.
    assert.equal(loopPlan({ visible: true, inGame: true })[LOOPS.AUTO_SYNC], true);
    assert.equal(loopPlan({ visible: true, inGame: false })[LOOPS.AUTO_SYNC], true);
    assert.equal(loopPlan({ visible: false, inGame: false })[LOOPS.AUTO_SYNC], false);
});

test('missing or partial context is treated as hidden and out of game', () => {
    for (const ctx of [undefined, null, {}, { inGame: true }]) {
        const plan = loopPlan(ctx);
        assert.equal(plan[LOOPS.CONTROLLER_PING], false);
        assert.equal(plan[LOOPS.AUTO_SYNC], false);
    }
});

// ─── diffPlan ───────────────────────────────────────────────────────────────

test('first plan starts everything that is on and stops nothing', () => {
    const plan = loopPlan({ visible: true, inGame: false });
    const { start, stop } = diffPlan(null, plan);

    assert.deepEqual(stop, []);
    assert.deepEqual(start.sort(), [
        LOOPS.ACTIVE_GAME_POLL, LOOPS.AUTO_SYNC, LOOPS.ROSTER_POLL, LOOPS.TEAM_AUTO_REFRESH,
    ].sort());
});

test('hiding the page stops every running loop', () => {
    const visible = loopPlan({ visible: true, inGame: true });
    const hidden = loopPlan({ visible: false, inGame: true });
    const { start, stop } = diffPlan(visible, hidden);

    assert.deepEqual(start, []);
    assert.deepEqual(stop.sort(), [
        LOOPS.AUTO_SYNC, LOOPS.CONTROLLER_PING, LOOPS.GAME_STATE_REFRESH,
        LOOPS.GAME_TIMER,
    ].sort());
});

test('entering a game swaps team-screen loops for in-game ones', () => {
    const out = loopPlan({ visible: true, inGame: false });
    const inGame = loopPlan({ visible: true, inGame: true });
    const { start, stop } = diffPlan(out, inGame);

    assert.deepEqual(start.sort(), [
        LOOPS.CONTROLLER_PING, LOOPS.GAME_STATE_REFRESH,
        LOOPS.GAME_TIMER,
    ].sort());
    assert.deepEqual(stop.sort(), [
        LOOPS.ACTIVE_GAME_POLL, LOOPS.ROSTER_POLL, LOOPS.TEAM_AUTO_REFRESH,
    ].sort());
    // Auto-sync spans the transition and must not be churned.
    assert.ok(!start.includes(LOOPS.AUTO_SYNC));
    assert.ok(!stop.includes(LOOPS.AUTO_SYNC));
});

test('an unchanged plan produces no transitions', () => {
    const plan = loopPlan({ visible: true, inGame: true });
    const { start, stop } = diffPlan(plan, loopPlan({ visible: true, inGame: true }));
    assert.deepEqual(start, []);
    assert.deepEqual(stop, []);
});

// ─── shouldHoldWakeLock ─────────────────────────────────────────────────────

const HOLDING = Object.freeze({
    supported: true, enabled: true, inGame: true, visible: true, userReleased: false,
});

test('wake lock is held in a visible game when supported and enabled', () => {
    assert.equal(shouldHoldWakeLock(HOLDING), true);
});

test('every precondition is individually necessary', () => {
    const negations = {
        supported: false,      // no navigator.wakeLock (Firefox, older Safari)
        enabled: false,        // coach turned the setting off
        inGame: false,         // not on the game screen
        visible: false,        // browser has already released it for us
        userReleased: true,    // coach tapped the header indicator off
    };
    for (const [key, value] of Object.entries(negations)) {
        assert.equal(
            shouldHoldWakeLock({ ...HOLDING, [key]: value }), false,
            `expected no wake lock when ${key}=${value}`
        );
    }
});

test('missing context never claims a lock', () => {
    assert.equal(shouldHoldWakeLock(undefined), false);
    assert.equal(shouldHoldWakeLock(null), false);
    assert.equal(shouldHoldWakeLock({}), false);
});

// ─── Shared base tick ───────────────────────────────────────────────────────

test('only the out-of-game polls ride the shared tick', () => {
    // The in-game loops are deliberately excluded: the 1s display timer sends
    // nothing, and after the change-stamp gate the 2s controller ping is the
    // only in-game network loop left — there is nothing to align it with.
    assert.deepEqual([...TICK_DRIVEN_LOOPS].sort(), [
        LOOPS.ACTIVE_GAME_POLL, LOOPS.AUTO_SYNC,
        LOOPS.ROSTER_POLL, LOOPS.TEAM_AUTO_REFRESH,
    ].sort());
});

test('an unreadable refresh setting falls back rather than producing NaN', () => {
    for (const bad of [undefined, null, NaN, 0, -5, 'soon']) {
        const periods = loopPeriods({ refreshIntervalMs: bad });
        assert.equal(periods[LOOPS.AUTO_SYNC], DEFAULT_REFRESH_MS,
            `refreshIntervalMs=${String(bad)} should fall back`);
    }
    assert.equal(loopPeriods()[LOOPS.AUTO_SYNC], DEFAULT_REFRESH_MS);
});

test('the active-game poll does not follow the refresh setting', () => {
    // It is a "someone else started a game" notification, not a data refresh.
    for (const refresh of [3000, 10_000, 120_000]) {
        assert.equal(loopPeriods({ refreshIntervalMs: refresh })[LOOPS.ACTIVE_GAME_POLL],
            ACTIVE_GAME_POLL_MS);
    }
});

test('at the defaults the schedule reproduces the old intervals exactly', () => {
    const { baseMs, everyNTicks } = tickSchedule(loopPeriods({ refreshIntervalMs: 10_000 }));
    assert.equal(baseMs, 10_000);
    assert.equal(everyNTicks[LOOPS.TEAM_AUTO_REFRESH], 1);
    assert.equal(everyNTicks[LOOPS.AUTO_SYNC], 1);
    assert.equal(everyNTicks[LOOPS.ROSTER_POLL], 1);
    assert.equal(everyNTicks[LOOPS.ACTIVE_GAME_POLL], 3);   // 30s
});

test('the base tick is never faster than the fastest loop already ticked', () => {
    // A gcd-based base would drop to 1s for a 7s refresh — ten times today's
    // timer wakeups to serve loops that wanted 7 and 30 seconds.
    for (const refresh of [3000, 7000, 10_000, 45_000, 120_000]) {
        const periods = loopPeriods({ refreshIntervalMs: refresh });
        const { baseMs } = tickSchedule(periods);
        assert.equal(baseMs, Math.min(...Object.values(periods)),
            `refresh=${refresh}`);
    }
});

test('no loop ever runs faster than its own period', () => {
    // Rounding the other way would quietly poll the API harder than the
    // user's own setting allows.
    for (const refresh of [3000, 7000, 10_000, 45_000, 120_000]) {
        const periods = loopPeriods({ refreshIntervalMs: refresh });
        const { baseMs, everyNTicks } = tickSchedule(periods);
        for (const loop of TICK_DRIVEN_LOOPS) {
            assert.ok(everyNTicks[loop] * baseMs >= periods[loop],
                `${loop} at refresh=${refresh}: ${everyNTicks[loop]}×${baseMs} < ${periods[loop]}`);
        }
    }
});

test('a very slow refresh setting does not drag the active-game poll with it', () => {
    // base falls back to the 30s poll, so the notification keeps its cadence.
    const { baseMs, everyNTicks } = tickSchedule(loopPeriods({ refreshIntervalMs: 120_000 }));
    assert.equal(baseMs, ACTIVE_GAME_POLL_MS);
    assert.equal(everyNTicks[LOOPS.ACTIVE_GAME_POLL], 1);
    assert.equal(everyNTicks[LOOPS.AUTO_SYNC] * baseMs, 120_000);
});

test('same-cadence loops fire on the same tick — the entire point', () => {
    const schedule = tickSchedule(loopPeriods({ refreshIntervalMs: 10_000 }));
    let state = {};
    const sameTickEveryTime = [];

    for (let tick = 0; tick <= 6; tick++) {
        const result = loopsDueOnTick(tick, schedule, state);
        state = result.lastRunIndex;
        sameTickEveryTime.push(result.due);
    }

    // The three refresh loops are due on every tick, together, always.
    for (const due of sameTickEveryTime) {
        assert.ok(due.includes(LOOPS.AUTO_SYNC));
        assert.ok(due.includes(LOOPS.ROSTER_POLL));
        assert.ok(due.includes(LOOPS.TEAM_AUTO_REFRESH));
    }
    // The 30s poll joins them on every third tick, never on its own tick.
    const activeTicks = sameTickEveryTime
        .map((due, tick) => (due.includes(LOOPS.ACTIVE_GAME_POLL) ? tick : null))
        .filter(t => t !== null);
    assert.deepEqual(activeTicks, [0, 3, 6]);
});

test('a tick skipped by browser throttling is caught up, not lost', () => {
    // Due-ness is "N ticks since it last ran", not "tickIndex % N === 0" —
    // the modulo form silently drops a loop whose multiple lands on a tick the
    // browser threw away, and a backgrounded phone throttles plenty.
    const schedule = tickSchedule(loopPeriods({ refreshIntervalMs: 10_000 }));

    let state = loopsDueOnTick(0, schedule, {}).lastRunIndex;
    // Ticks 1..4 never fire; the clock jumps straight to 5. Under `% 3` the
    // active-game poll's tick 3 would simply have been missed.
    const { due } = loopsDueOnTick(5, schedule, state);
    assert.ok(due.includes(LOOPS.ACTIVE_GAME_POLL), 'the skipped 30s poll catches up');
});

test('a loop that just ran is not due again on the next tick', () => {
    const schedule = tickSchedule(loopPeriods({ refreshIntervalMs: 10_000 }));
    const first = loopsDueOnTick(0, schedule, {});
    assert.ok(first.due.includes(LOOPS.ACTIVE_GAME_POLL));

    const second = loopsDueOnTick(1, schedule, first.lastRunIndex);
    assert.ok(!second.due.includes(LOOPS.ACTIVE_GAME_POLL));
    assert.ok(second.due.includes(LOOPS.AUTO_SYNC), 'but the 1-tick loops still are');
});

test('the first tick after a (re)start runs everything', () => {
    // Empty bookkeeping means "never run" — a resume should not sit on its
    // hands waiting out a multiple it has no memory of.
    const schedule = tickSchedule(loopPeriods({ refreshIntervalMs: 10_000 }));
    const { due } = loopsDueOnTick(0, schedule, {});
    assert.deepEqual([...due].sort(), [...TICK_DRIVEN_LOOPS].sort());
});
