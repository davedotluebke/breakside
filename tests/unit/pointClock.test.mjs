/*
 * store/pointClock.js — the point clock's "first touch" rules (ARCHITECTURE.md
 * § Point clock and the first touch): what counts as a touch, when Start
 * Point arms the clock instead of starting it, and how the first touch and
 * an undo of it move the point between armed / running.
 *
 * Also pins the two event-model conventions the surfaces rely on: a Pickup
 * summarizes as a pull catch or a pick-up, and a drop with no thrower is a
 * dropped pull (Turnover.isPullDrop).
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    TOUCH_EVENT_TYPES, isTouchEvent, pointHasTouch, awaitingPull,
    clockWaitsForFirstTouch, armPointClock, startPointClock, rearmPointClockIfUntouched,
} from '../../store/pointClock.js';
import {
    Point, Possession, Throw, Turnover, Defense, Pull, Pickup, Other, Violation, UNKNOWN_PLAYER,
} from '../../store/models.js';

const P = Object.fromEntries(['Alice', 'Bob', 'Cara'].map(n => [n, { name: n, id: n.toLowerCase() }]));
const unknown = { name: UNKNOWN_PLAYER, id: null };

/** A started point with the given events in one offensive possession. */
function makePoint(startOn, events = [], over = {}) {
    const point = new Point(['Alice', 'Bob', 'Cara'], startOn);
    if (events.length) {
        const poss = new Possession(true);
        events.forEach(e => poss.events.push(e));
        point.addPossession(poss);
    }
    return Object.assign(point, over);
}

test('touch events: everything that puts a hand on the disc; annotations are not touches', () => {
    assert.deepEqual([...TOUCH_EVENT_TYPES], ['Throw', 'Turnover', 'Defense', 'Pull', 'Pickup']);
    for (const e of [
        new Throw({ thrower: P.Alice, receiver: P.Bob }),
        new Turnover({ thrower: P.Alice, throwaway: true }),
        new Defense({ defender: P.Bob, block: true }),
        new Pull({ puller: P.Cara }),
        new Pickup({ receiver: P.Alice }),
    ]) assert.equal(isTouchEvent(e), true, e.type);
    assert.equal(isTouchEvent(new Other({ timeout: true })), false);
    assert.equal(isTouchEvent(new Violation({ travel: true })), false);
    assert.equal(isTouchEvent(null), false);
});

test('awaitingPull: an offensive point with no touch yet, whatever annotations it carries', () => {
    assert.equal(awaitingPull(makePoint('offense')), true);
    assert.equal(awaitingPull(makePoint('offense', [new Other({ timeout: true })])), true, 'a timeout before the pull is not a touch');
    assert.equal(awaitingPull(makePoint('offense', [new Pickup({ receiver: P.Alice, pullCatch: true })])), false);
    assert.equal(awaitingPull(makePoint('offense', [new Turnover({ receiver: P.Alice, receiverError: true })])), false, 'a dropped pull is a touch');
    assert.equal(awaitingPull(makePoint('defense')), false, 'D points receive nothing');
    assert.equal(awaitingPull(null), false);
    assert.equal(pointHasTouch(makePoint('offense', [new Other({ injury: true })])), false);
});

test('clockWaitsForFirstTouch: offense on the Full / Field surfaces only', () => {
    const o = makePoint('offense'), d = makePoint('defense');
    assert.equal(clockWaitsForFirstTouch(o, 'full'), true);
    assert.equal(clockWaitsForFirstTouch(o, 'field'), true);
    assert.equal(clockWaitsForFirstTouch(o, 'simple'), false, 'Simple mode has no pickup tap');
    assert.equal(clockWaitsForFirstTouch(o, 'all'), false);
    assert.equal(clockWaitsForFirstTouch(o, undefined), false);
    assert.equal(clockWaitsForFirstTouch(d, 'full'), false, 'D points start the clock at Start Point');
    assert.equal(clockWaitsForFirstTouch(null, 'full'), false);
});

test('arm, then the first touch starts the running segment exactly once', () => {
    const point = makePoint('offense');
    armPointClock(point);
    assert.equal(point.clockPending, true);
    assert.equal(point.startTimestamp, null);
    assert.equal(point.lastPauseTime, null);
    assert.equal(point.totalPointTime, 0);

    const now = new Date('2026-09-22T18:00:00Z');
    assert.equal(startPointClock(point, now), true);
    assert.equal(point.clockPending, false);
    assert.equal(point.startTimestamp, now, 'the segment marker is the Date passed in');
    assert.equal(startPointClock(point, new Date('2026-09-22T18:00:05Z')), false, 'already running');
    assert.equal(point.startTimestamp, now, 'a second touch does not restart the segment');

    const running = makePoint('offense', [], { startTimestamp: now });
    assert.equal(startPointClock(running), false, 'a clock started at Start Point (Simple mode) is untouched');
    assert.equal(running.startTimestamp, now);
    assert.equal(startPointClock(null), false);
});

test('rearm after undo: only an untouched, unconcluded offensive point on a deferring surface', () => {
    const t0 = new Date('2026-09-22T18:00:00Z');
    const undone = makePoint('offense', [], { startTimestamp: t0, totalPointTime: 4200 });
    assert.equal(rearmPointClockIfUntouched(undone, 'full'), true);
    assert.equal(undone.clockPending, true);
    assert.equal(undone.startTimestamp, null);
    assert.equal(undone.totalPointTime, 0, 'time since the mistaken touch is dropped, not banked');

    const touched = makePoint('offense', [new Pickup({ receiver: P.Bob })], { startTimestamp: t0 });
    assert.equal(rearmPointClockIfUntouched(touched, 'full'), false);
    assert.equal(touched.startTimestamp, t0);

    const simple = makePoint('offense', [], { startTimestamp: t0, totalPointTime: 4200 });
    assert.equal(rearmPointClockIfUntouched(simple, 'simple'), false, 'Simple mode keeps its running clock');
    assert.equal(simple.totalPointTime, 4200);

    const scored = makePoint('offense', [], { winner: 'team', endTimestamp: t0 });
    assert.equal(rearmPointClockIfUntouched(scored, 'full'), false);
    const armed = makePoint('offense', [], { clockPending: true });
    assert.equal(rearmPointClockIfUntouched(armed, 'full'), false, 'already armed');
    assert.equal(rearmPointClockIfUntouched(makePoint('defense', [], { startTimestamp: t0 }), 'field'), false);
});

test('Pickup summarizes as a pull catch or a pick-up; Unknown when unseen', () => {
    assert.equal(new Pickup({ receiver: P.Alice, pullCatch: true }).summarize(), 'Alice catches the pull');
    assert.equal(new Pickup({ receiver: P.Bob }).summarize(), 'Bob picks up the disc');
    assert.equal(new Pickup({}).summarize(), `${UNKNOWN_PLAYER} picks up the disc`);
    const inferred = new Pickup({ receiver: P.Cara });
    inferred.inferred_flag = true;
    assert.equal(inferred.summarize(), '(inferred) Cara picks up the disc');
    assert.equal(new Pickup({ receiver: P.Alice, to: { x: .2, y: .5 } }).to.x, .2);
});

test('a drop with no thrower is a dropped pull; a drop from Unknown Player is an ordinary drop', () => {
    const pullDrop = new Turnover({ receiver: P.Cara, receiverError: true });
    assert.equal(pullDrop.isPullDrop(), true);
    assert.equal(pullDrop.summarize(), 'Cara drops the pull');
    const drop = new Turnover({ thrower: unknown, receiver: P.Cara, receiverError: true });
    assert.equal(drop.isPullDrop(), false);
    assert.match(drop.summarize(), /^Cara misses the catch from Unknown Player/);
    assert.equal(new Turnover({ thrower: null, throwaway: true }).isPullDrop(), false, 'not a drop');
});
