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
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 * (no deps — plain node:test against the ES modules)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LOOPS, loopPlan, diffPlan, shouldHoldWakeLock } from '../../utils/powerPolicy.js';

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
    assert.equal(plan[LOOPS.POINT_TIMER], true);

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
    assert.equal(plan[LOOPS.POINT_TIMER], false);
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
        LOOPS.GAME_TIMER, LOOPS.POINT_TIMER,
    ].sort());
});

test('entering a game swaps team-screen loops for in-game ones', () => {
    const out = loopPlan({ visible: true, inGame: false });
    const inGame = loopPlan({ visible: true, inGame: true });
    const { start, stop } = diffPlan(out, inGame);

    assert.deepEqual(start.sort(), [
        LOOPS.CONTROLLER_PING, LOOPS.GAME_STATE_REFRESH,
        LOOPS.GAME_TIMER, LOOPS.POINT_TIMER,
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
