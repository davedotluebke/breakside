/*
 * Unit tests pinning the zombie point-timer repair
 * (store/pointTimerNormalizer.js), the G11.1 item-4 fix.
 *
 * Contract under test:
 *  - a startTimestamp is nulled when the point is concluded (winner or
 *    endTimestamp set), or a later point exists, or the marker is >12h from
 *    `now` in either direction (abandoned point / device clock moved)
 *  - a genuinely live point — last, unconcluded, fresh marker — is untouched,
 *    so mid-game reloads and cloud refreshes keep their running timer
 *  - the stale segment is dropped, never banked: totalPointTime is never
 *    modified
 *  - both Date-object markers (Point instances) and ISO-string markers (raw
 *    serialized entries) are handled
 *
 * Run: node --test tests/unit/*.test.mjs
 * (no deps — plain node:test against the ES modules)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizePointTimers,
    STALE_RUNNING_TIMER_MS,
} from '../../store/pointTimerNormalizer.js';

// Fixed "now" for determinism: 2026-07-19T18:00:00Z
const NOW = Date.parse('2026-07-19T18:00:00.000Z');
const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;

function makePoint(overrides = {}) {
    return {
        players: ['Alice-7f3a'],
        startingPosition: 'offense',
        winner: '',
        startTimestamp: null,
        endTimestamp: null,
        totalPointTime: 0,
        possessions: [],
        ...overrides,
    };
}

test('nulls the SWW-2-shaped zombie: unconcluded non-last point running since November', () => {
    const zombie = makePoint({
        startTimestamp: new Date('2025-11-16T18:38:08.399Z'),
        totalPointTime: 0,
        possessions: [{}],
    });
    const later = makePoint({
        winner: 'opponent',
        endTimestamp: new Date('2025-11-16T18:45:46.913Z'),
        totalPointTime: 285589,
    });
    const repaired = normalizePointTimers([zombie, later], NOW);

    assert.equal(repaired, 1);
    assert.equal(zombie.startTimestamp, null);
    assert.equal(zombie.totalPointTime, 0); // dropped, not banked
    assert.equal(later.startTimestamp, null); // was already null
});

test('nulls a concluded point even when it is the last point', () => {
    // SWW-2 points 2–13 shape: old updateScore stamped score time as
    // startTimestamp, so start === end and the marker survived serialization.
    const scoreTime = new Date('2025-11-16T20:41:10.781Z');
    const point = makePoint({
        winner: 'opponent',
        startTimestamp: new Date(scoreTime),
        endTimestamp: new Date(scoreTime),
        totalPointTime: 2711898,
    });
    const repaired = normalizePointTimers([point], NOW);

    assert.equal(repaired, 1);
    assert.equal(point.startTimestamp, null);
    assert.equal(point.totalPointTime, 2711898); // banked time untouched
});

test('endTimestamp alone (no winner) counts as concluded', () => {
    const point = makePoint({
        startTimestamp: new Date(NOW - 5 * MINUTES),
        endTimestamp: new Date(NOW - 1 * MINUTES),
    });
    assert.equal(normalizePointTimers([point], NOW), 1);
    assert.equal(point.startTimestamp, null);
});

test('preserves a genuinely live last point (mid-game reload / cloud refresh)', () => {
    const done = makePoint({
        winner: 'team',
        endTimestamp: new Date(NOW - 10 * MINUTES),
        totalPointTime: 120000,
    });
    const start = new Date(NOW - 3 * MINUTES);
    const live = makePoint({ startTimestamp: start, possessions: [{}] });
    const repaired = normalizePointTimers([done, live], NOW);

    assert.equal(repaired, 0);
    assert.equal(live.startTimestamp, start); // same object, untouched
});

test('nulls an abandoned last point whose marker is older than the stale threshold', () => {
    const point = makePoint({
        startTimestamp: new Date(NOW - STALE_RUNNING_TIMER_MS - 1 * HOURS),
    });
    assert.equal(normalizePointTimers([point], NOW), 1);
    assert.equal(point.startTimestamp, null);
});

test('small clock skew is tolerated; far-future markers are nulled', () => {
    const slightlyAhead = makePoint({
        startTimestamp: new Date(NOW + 5 * MINUTES),
    });
    assert.equal(normalizePointTimers([slightlyAhead], NOW), 0);
    assert.notEqual(slightlyAhead.startTimestamp, null);

    const farFuture = makePoint({
        startTimestamp: new Date(NOW + STALE_RUNNING_TIMER_MS + 1 * HOURS),
    });
    assert.equal(normalizePointTimers([farFuture], NOW), 1);
    assert.equal(farFuture.startTimestamp, null);
});

test('an unparseable marker is nulled', () => {
    const point = makePoint({ startTimestamp: 'not-a-date' });
    assert.equal(normalizePointTimers([point], NOW), 1);
    assert.equal(point.startTimestamp, null);
});

test('ISO-string markers (raw serialized entries) are handled like Dates', () => {
    const zombie = makePoint({ startTimestamp: '2025-11-16T18:38:08.399Z' });
    const live = makePoint({
        startTimestamp: new Date(NOW - 2 * MINUTES).toISOString(),
    });
    const repaired = normalizePointTimers([zombie, live], NOW);

    assert.equal(repaired, 1);
    assert.equal(zombie.startTimestamp, null);
    assert.equal(typeof live.startTimestamp, 'string'); // untouched
});

test('no-ops: null markers, empty arrays, non-arrays, holes', () => {
    const idle = makePoint(); // startTimestamp already null
    assert.equal(normalizePointTimers([idle], NOW), 0);
    assert.equal(normalizePointTimers([], NOW), 0);
    assert.equal(normalizePointTimers(null, NOW), 0);
    assert.equal(normalizePointTimers(undefined, NOW), 0);
    assert.equal(normalizePointTimers([null, undefined, idle], NOW), 0);
});

test('full SWW-2 replay: every stored marker is repaired, banked times survive', () => {
    // Shape of the real 2025-11-16 CUDO Mixed vs SWW 2 game as stored:
    // point 1 unconcluded with a running Nov-16 marker, points 2–13 concluded
    // with score-time markers (start === end).
    const points = [
        makePoint({
            startTimestamp: new Date('2025-11-16T18:38:08.399Z'),
            possessions: [{}],
        }),
    ];
    const endTimes = [
        '18:45:46.913', '18:49:57.108', '18:56:59.652', '19:08:43.812',
        '19:18:02.424', '19:22:33.323', '19:27:18.944', '19:31:28.697',
        '19:37:19.750', '19:47:26.033', '19:52:57.970', '20:41:10.781',
    ];
    const bankedTimes = [
        285589, 112923, 272806, 496894, 356992, 105650,
        116662, 57878, 145531, 48826, 173882, 2711898,
    ];
    endTimes.forEach((t, i) => {
        const stamp = new Date(`2025-11-16T${t}Z`);
        points.push(makePoint({
            winner: i % 2 === 0 ? 'opponent' : 'team',
            startTimestamp: new Date(stamp),
            endTimestamp: new Date(stamp),
            totalPointTime: bankedTimes[i],
        }));
    });

    const repaired = normalizePointTimers(points, NOW);

    assert.equal(repaired, 13);
    for (const point of points) {
        assert.equal(point.startTimestamp, null);
    }
    assert.deepEqual(
        points.slice(1).map(p => p.totalPointTime),
        bankedTimes,
    );
    // Idempotent: a second pass finds nothing left to repair.
    assert.equal(normalizePointTimers(points, NOW), 0);
});
