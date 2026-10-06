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
    startPointClockOnSurface,
    isPointClockStopped, stopReasonOf, stopPointClock, restartPointClock,
    touchPointClock, resumePointClockFromStop, clockStoppedForMs,
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

test('clockWaitsForFirstTouch: offense on the Full / Field surfaces; defense everywhere (the pull is always recorded)', () => {
    const o = makePoint('offense'), d = makePoint('defense');
    assert.equal(clockWaitsForFirstTouch(o, 'full'), true);
    assert.equal(clockWaitsForFirstTouch(o, 'field'), true);
    assert.equal(clockWaitsForFirstTouch(o, 'simple'), false, 'Simple mode has no pickup tap');
    assert.equal(clockWaitsForFirstTouch(o, 'all'), false);
    assert.equal(clockWaitsForFirstTouch(o, undefined), false);
    for (const mode of ['full', 'field', 'simple', 'all', undefined]) {
        assert.equal(clockWaitsForFirstTouch(d, mode), true, `a D point waits for the pull on ${mode}`);
    }
    assert.equal(clockWaitsForFirstTouch(null, 'full'), false);
    assert.equal(clockWaitsForFirstTouch(makePoint(undefined), 'full'), false, 'unknown side starts at Start Point');
});

test('a pull timed with the stopwatch starts the clock at the release tap, not at Proceed', () => {
    const point = makePoint('defense');
    armPointClock(point);
    const release = new Date('2026-09-26T18:00:00Z');
    assert.equal(startPointClock(point, release), true);
    assert.equal(point.startTimestamp, release, 'the segment starts back at the release tap');
    assert.equal(point.clockPending, false);
    assert.equal(startPointClock(point), false, 'Proceed / dismissal afterwards is a no-op');
    assert.equal(point.startTimestamp, release);
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
    const dUntouched = makePoint('defense', [], { startTimestamp: t0, totalPointTime: 900 });
    assert.equal(rearmPointClockIfUntouched(dUntouched, 'simple'), true, 'a D point left with no pull waits for it again, on any surface');
    assert.equal(dUntouched.totalPointTime, 0);
});

test('moving to the Simple surface starts an armed offensive clock, and nothing else', () => {
    const now = new Date('2026-09-22T18:00:07Z');
    for (const mode of ['simple', 'all']) {
        const armed = makePoint('offense');
        armPointClock(armed);
        assert.equal(startPointClockOnSurface(armed, mode, now), true, mode);
        assert.equal(armed.clockPending, false);
        assert.equal(armed.startTimestamp, now, `${mode}: the clock starts on arrival`);
    }

    const stillFull = makePoint('offense');
    armPointClock(stillFull);
    for (const mode of ['full', 'field']) {
        assert.equal(startPointClockOnSurface(stillFull, mode, now), false, `${mode} keeps waiting for the first touch`);
    }
    assert.equal(stillFull.clockPending, true);

    const t0 = new Date('2026-09-22T18:00:00Z');
    const pickedUp = makePoint('offense', [new Pickup({ receiver: P.Bob })], { startTimestamp: t0, totalPointTime: 1500 });
    assert.equal(startPointClockOnSurface(pickedUp, 'simple', now), false, 'a running clock is not overwritten');
    assert.equal(pickedUp.startTimestamp, t0);
    assert.equal(pickedUp.totalPointTime, 1500);

    const paused = makePoint('offense', [new Pickup({ receiver: P.Bob })], { startTimestamp: null, totalPointTime: 1500, lastPauseTime: t0 });
    assert.equal(startPointClockOnSurface(paused, 'simple', now), false, 'a paused clock stays paused');
    assert.equal(paused.startTimestamp, null);

    const dPoint = makePoint('defense');
    armPointClock(dPoint);
    assert.equal(startPointClockOnSurface(dPoint, 'simple', now), false, 'a D point waits for its pull');
    assert.equal(dPoint.clockPending, true);

    const scored = makePoint('offense', [], { clockPending: true, winner: 'team', endTimestamp: t0 });
    assert.equal(startPointClockOnSurface(scored, 'simple', now), false);
    assert.equal(startPointClockOnSurface(null, 'simple', now), false);
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

// ─── Stoppages (timeout / injury sub / pause) ───────────────────────────────

const T = (secs) => new Date(Date.parse('2026-10-05T18:00:00Z') + secs * 1000);
/** Date-valued fields compared by instant: T(n) returns a fresh Date each call. */
const at = (d) => (d ? new Date(d).getTime() : d);

test('stopReasonOf: a timeout or injury sub is a stoppage; a lineup correction, a period break or a touch is not', () => {
    assert.equal(stopReasonOf(new Other({ timeout: true, calledBy: 'them' })), 'timeout');
    assert.equal(stopReasonOf(new Other({ injury: true, description: 'Sub: Bob in for Alice' })), 'injury');
    assert.equal(stopReasonOf(new Other({ lineupCorrection: true })), null);
    assert.equal(stopReasonOf(new Other({ halftime: true, betweenPoints: true })), null);
    assert.equal(stopReasonOf(new Throw({ thrower: P.Alice, receiver: P.Bob })), null);
    assert.equal(stopReasonOf(new Violation({ pick: true })), null);
    assert.equal(stopReasonOf(null), null);
});

test('stop banks the running segment, keeps the stop moment and the reason; restart opens a fresh segment', () => {
    const point = makePoint('offense', [new Pickup({ receiver: P.Bob })], { startTimestamp: T(0), totalPointTime: 2000 });
    assert.equal(isPointClockStopped(point), false);

    assert.equal(stopPointClock(point, 'timeout', T(30)), true);
    assert.equal(point.totalPointTime, 32000, '2 s banked before + 30 s of this segment');
    assert.equal(point.startTimestamp, null);
    assert.equal(at(point.lastPauseTime), at(T(30)), 'the stop moment');
    assert.equal(point.clockStopped, 'timeout');
    assert.equal(isPointClockStopped(point), true);
    assert.equal(clockStoppedForMs(point, T(75).getTime()), 45000);

    assert.equal(restartPointClock(point, T(75)), true);
    assert.equal(point.clockStopped, null);
    assert.equal(at(point.startTimestamp), at(T(75)), 'a fresh segment from the restart');
    assert.equal(point.lastPauseTime, null);
    assert.equal(point.totalPointTime, 32000, 'the 45 s stoppage is not play');
    assert.equal(clockStoppedForMs(point), 0);
    assert.equal(restartPointClock(point, T(80)), false, 'already running');
    assert.equal(at(point.startTimestamp), at(T(75)));
});

test('stop is a no-op unless the clock is running: armed, already stopped, idle, concluded', () => {
    const armed = makePoint('offense');
    armPointClock(armed);
    assert.equal(stopPointClock(armed, 'timeout', T(5)), false, 'a timeout before the first touch leaves the clock armed');
    assert.equal(armed.clockPending, true);
    assert.equal(armed.clockStopped, null);

    const stopped = makePoint('offense', [], { startTimestamp: T(0) });
    assert.equal(stopPointClock(stopped, 'manual', T(10)), true);
    assert.equal(stopPointClock(stopped, 'timeout', T(20)), false, 'the first stop wins');
    assert.equal(stopped.clockStopped, 'manual', 'its reason stands');
    assert.equal(at(stopped.lastPauseTime), at(T(10)), 'and so does its moment');
    assert.equal(stopped.totalPointTime, 10000);

    const idle = makePoint('offense', [], { startTimestamp: null, totalPointTime: 7000 });
    assert.equal(stopPointClock(idle, 'timeout', T(5)), false, 'no running segment');
    assert.equal(idle.clockStopped, null);

    const scored = makePoint('offense', [], { startTimestamp: T(0), winner: 'team', endTimestamp: T(40) });
    assert.equal(stopPointClock(scored, 'timeout', T(50)), false, 'a between-points timeout stops nothing');
    assert.equal(at(scored.startTimestamp), at(T(0)), 'and touches nothing');
    assert.equal(stopPointClock(null, 'timeout'), false);

    const unknownReason = makePoint('offense', [], { startTimestamp: T(0) });
    assert.equal(stopPointClock(unknownReason, 'weather', T(1)), true);
    assert.equal(unknownReason.clockStopped, 'manual', 'an unknown reason is recorded as a manual stop');
});

test('isPointClockStopped is false once the point is over, whatever the flag says', () => {
    const point = makePoint('offense', [], { clockStopped: 'timeout', winner: 'team', endTimestamp: T(1) });
    assert.equal(isPointClockStopped(point), false);
    assert.equal(restartPointClock(point, T(2)), false);
    assert.equal(point.startTimestamp, null);
    assert.equal(isPointClockStopped(null), false);
});

test('touchPointClock: starts an armed clock, restarts a stopped one, else nothing', () => {
    const armed = makePoint('offense');
    armPointClock(armed);
    assert.equal(touchPointClock(armed, T(3)), 'started');
    assert.equal(at(armed.startTimestamp), at(T(3)));
    assert.equal(touchPointClock(armed, T(4)), null, 'a running clock is left alone');
    assert.equal(at(armed.startTimestamp), at(T(3)));

    assert.equal(stopPointClock(armed, 'injury', T(60)), true);
    assert.equal(touchPointClock(armed, T(130)), 'restarted');
    assert.equal(at(armed.startTimestamp), at(T(130)));
    assert.equal(armed.clockStopped, null);
    assert.equal(armed.totalPointTime, 57000, '3 s → 60 s banked; the 70 s stoppage is not');
    assert.equal(touchPointClock(null), null);
});

test('undoing the stop event resumes the clock from the moment it stopped — only for that event\'s reason', () => {
    const point = makePoint('offense', [], { startTimestamp: T(0) });
    stopPointClock(point, 'timeout', T(20));
    assert.equal(resumePointClockFromStop(point, 'injury'), false, 'an injury sub undone does not restart a timeout stop');
    assert.equal(point.clockStopped, 'timeout');
    assert.equal(resumePointClockFromStop(point, null), false);
    assert.equal(resumePointClockFromStop(point, 'timeout'), true);
    assert.equal(point.clockStopped, null);
    assert.equal(at(point.startTimestamp), at(T(20)), 'the segment runs from the stop, so the mis-tap cost no time');
    assert.equal(point.lastPauseTime, null);
    assert.equal(point.totalPointTime, 20000);
    assert.equal(resumePointClockFromStop(point, 'timeout'), false, 'not stopped any more');

    const manual = makePoint('offense', [], { startTimestamp: T(0) });
    stopPointClock(manual, 'manual', T(5));
    assert.equal(resumePointClockFromStop(manual, 'timeout'), false, 'a timeout recorded on top of a manual stop, then undone, leaves the manual stop');
    assert.equal(manual.clockStopped, 'manual');
});

test('arming (an undo of the first touch) clears a stopped state too', () => {
    const point = makePoint('offense', [], { startTimestamp: T(0) });
    stopPointClock(point, 'timeout', T(9));
    armPointClock(point);
    assert.equal(point.clockPending, true);
    assert.equal(point.clockStopped, null);
    assert.equal(point.lastPauseTime, null);
    assert.equal(point.totalPointTime, 0);
});
