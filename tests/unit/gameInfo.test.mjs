/*
 * store/gameInfo.js — the optional game facts (game-to, caps, scheduled
 * start, field) and the status the share viewer's badge derives from a game
 * (ARCHITECTURE.md § Game info and status).
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeGameInfo, applyGameInfo, capTimes, gameInfoParts, gameStatus,
} from '../../store/gameInfo.js';

const T0 = Date.parse('2026-11-14T18:00:00Z');
const min = n => n * 60000;
const fmt = ms => new Date(ms).toISOString().slice(11, 16);   // HH:MM, zone-free

/** A finished point: winner, minutes from T0 it ran, extra trailing events. */
function point(winner, startMin, endMin, extra = []) {
    return {
        winner,
        startTimestamp: new Date(T0 + min(startMin)).toISOString(),
        endTimestamp: endMin == null ? null : new Date(T0 + min(endMin)).toISOString(),
        possessions: [{ events: [{ type: 'Throw', score_flag: !!winner }, ...extra] }],
    };
}

function game(points, extra = {}) {
    const scores = { team: 0, opponent: 0 };
    points.forEach(p => { if (p.winner) scores[p.winner]++; });
    return { gameStartTimestamp: new Date(T0).toISOString(), gameEndTimestamp: null, scores, points, ...extra };
}

test('normalizeGameInfo keeps valid values and nulls the rest', () => {
    assert.deepEqual(normalizeGameInfo({}), {
        gameTo: null, softCapMinutes: null, hardCapMinutes: null, scheduledStart: null, fieldName: null,
    });
    const info = normalizeGameInfo({
        gameTo: '13', softCapMinutes: 75, hardCapMinutes: '90',
        scheduledStart: '2026-11-14T18:00:00Z', fieldName: '  4 ',
    });
    assert.equal(info.gameTo, 13);
    assert.equal(info.softCapMinutes, 75);
    assert.equal(info.hardCapMinutes, 90);
    assert.equal(info.scheduledStart, '2026-11-14T18:00:00.000Z');
    assert.equal(info.fieldName, '4');
    assert.equal(normalizeGameInfo({ gameTo: 0 }).gameTo, null);
    assert.equal(normalizeGameInfo({ gameTo: 'x' }).gameTo, null);
    assert.equal(normalizeGameInfo({ scheduledStart: 'nope' }).scheduledStart, null);
    assert.equal(normalizeGameInfo({ fieldName: '   ' }).fieldName, null);
});

test('applyGameInfo writes all five fields', () => {
    const g = applyGameInfo({ gameTo: 15 }, { hardCapMinutes: 60 });
    assert.equal(g.gameTo, null);
    assert.equal(g.hardCapMinutes, 60);
});

test('caps count from the scheduled start when set, else from game start', () => {
    const g = game([], { softCapMinutes: 45, hardCapMinutes: 60 });
    assert.equal(capTimes(g).softAt, T0 + min(45));
    assert.equal(capTimes(g).scheduled, false);
    g.scheduledStart = new Date(T0 - min(10)).toISOString();
    assert.equal(capTimes(g).softAt, T0 + min(35));
    assert.equal(capTimes(g).hardAt, T0 + min(50));
    assert.equal(capTimes(g).scheduled, true);
    assert.equal(capTimes(game([])).hardAt, null);
});

test('gameInfoParts shows only what is filled in', () => {
    assert.deepEqual(gameInfoParts(game([]), fmt), []);
    assert.deepEqual(gameInfoParts(game([], { hardCapMinutes: 60 }), fmt),
        [{ key: 'hardCap', text: 'Hard cap 60 min', small: null }]);
});

test('gameInfoParts adds clock times once there is a scheduled start', () => {
    const g = game([], {
        gameTo: 13, softCapMinutes: 75, hardCapMinutes: 90,
        scheduledStart: new Date(T0).toISOString(), fieldName: '4',
    });
    assert.deepEqual(gameInfoParts(g, fmt), [
        { key: 'gameTo', text: 'Game to 13', small: null },
        { key: 'scheduled', text: '18:00 – 19:30', small: null },
        { key: 'softCap', text: 'Soft cap 75 min', small: '19:15' },
        { key: 'hardCap', text: 'Hard cap 90 min', small: '19:30' },
        { key: 'field', text: 'Field 4', small: null },
    ]);
    const noCap = game([], { scheduledStart: new Date(T0).toISOString(), fieldName: 'Stadium field' });
    assert.deepEqual(gameInfoParts(noCap, fmt).map(p => p.text), ['Starts 18:00', 'Stadium field']);
});

test('a finished game is Final whatever else is true', () => {
    const g = game([point('team', 0, 3, [{ type: 'Other', halftime_flag: true }])],
        { gameEndTimestamp: '2026-11-14T19:00:00Z' });
    assert.equal(gameStatus(g, T0).label, 'Final');
});

test('Live until a halftime is recorded, then Halftime, then 2nd half', () => {
    const first = point('team', 0, 3);
    assert.equal(gameStatus(game([first]), T0 + min(4)).label, 'Live');
    assert.equal(gameStatus(game([]), T0).label, 'Live');
    const half = point('opponent', 4, 8, [{ type: 'Other', halftime_flag: true }]);
    const atHalf = gameStatus(game([first, half]), T0 + min(9));
    assert.equal(atHalf.label, 'Halftime');
    assert.equal(atHalf.tone, 'stopped');
    const g = game([first, half, point(null, 12, null)]);
    assert.equal(gameStatus(g, T0 + min(13)).label, '2nd half');
});

test('the point clock stop reason names the stoppage and clears with it', () => {
    const live = point(null, 0, null);
    live.clockStopped = 'injury';
    assert.equal(gameStatus(game([live]), T0 + min(1)).label, 'Injury');
    live.clockStopped = 'timeout';
    assert.equal(gameStatus(game([live]), T0 + min(1)).label, 'Timeout');
    live.clockStopped = 'manual';
    assert.equal(gameStatus(game([live]), T0 + min(1)).label, 'Paused');
    // Restarted: the injury event is still the last thing logged, but the
    // clock runs, so play is on.
    live.possessions[0].events.push({ type: 'Other', injury_flag: true });
    live.clockStopped = null;
    assert.equal(gameStatus(game([live]), T0 + min(2)).label, 'Live');
});

test('without a published stop reason the log decides', () => {
    const live = point(null, 0, null, [{ type: 'Other', injury_flag: true }]);
    assert.equal(gameStatus(game([live]), T0 + min(1)).label, 'Injury');
    live.possessions[0].events.push({ type: 'Throw' });
    assert.equal(gameStatus(game([live]), T0 + min(2)).label, 'Live');
    const to = point(null, 0, null, [{ type: 'Other', timeout_flag: true }]);
    assert.equal(gameStatus(game([to]), T0 + min(1)).label, 'Timeout');
});

test('a timeout between points shows until the next point starts', () => {
    const scored = point('team', 0, 3, [{ type: 'Other', timeout_flag: true }]);
    assert.equal(gameStatus(game([scored]), T0 + min(4)).label, 'Timeout');
    assert.equal(gameStatus(game([scored, point(null, 5, null)]), T0 + min(6)).label, 'Live');
});

test('universe point from the game-to score', () => {
    const pts = [];
    for (let i = 0; i < 12; i++) pts.push(point('team', i, i + 0.5));
    for (let i = 0; i < 12; i++) pts.push(point('opponent', 12 + i, 12.5 + i));
    assert.equal(gameStatus(game(pts, { gameTo: 13 }), T0 + min(30)).label, 'Universe');
    assert.equal(gameStatus(game(pts, { gameTo: 15 }), T0 + min(30)).label, 'Live');
    assert.equal(gameStatus(game(pts), T0 + min(30)).label, 'Live');
});

test('soft cap: finish the point, then play to the leader plus one', () => {
    // 5-4 when the cap falls at 45 min, mid-point.
    const pts = [];
    for (let i = 0; i < 5; i++) pts.push(point('team', i * 4, i * 4 + 3));
    for (let i = 0; i < 4; i++) pts.push(point('opponent', 20 + i * 4, 23 + i * 4));
    const inProgress = point(null, 40, null);
    const g = game([...pts, inProgress], { gameTo: 13, softCapMinutes: 45 });
    assert.equal(gameStatus(g, T0 + min(44)).label, 'Live');
    assert.equal(gameStatus(g, T0 + min(46)).label, 'Soft cap');
    // The capped point goes to the opponent: 5-5, target 6, so universe.
    const tied = game([...pts, point('opponent', 40, 47), point(null, 48, null)],
        { gameTo: 13, softCapMinutes: 45 });
    assert.equal(gameStatus(tied, T0 + min(49)).label, 'Universe');
    // It goes to the team instead: 6-4, target 7, not universe.
    const ahead = game([...pts, point('team', 40, 47), point(null, 48, null)],
        { gameTo: 13, softCapMinutes: 45 });
    assert.equal(gameStatus(ahead, T0 + min(49)).label, 'Soft cap');
});

test('soft cap between points uses the score as it stood', () => {
    const pts = [point('team', 0, 10), point('opponent', 11, 20)];
    const g = game([...pts, point(null, 50, null)], { softCapMinutes: 45 });
    // 1-1 at the cap, target 2: the point after the cap is universe.
    assert.equal(gameStatus(g, T0 + min(51)).label, 'Universe');
});

test('hard cap, and a tie after it is universe', () => {
    const pts = [point('team', 0, 10), point('opponent', 11, 20)];
    const playing = game([...pts, point(null, 55, null)], { hardCapMinutes: 60 });
    assert.equal(gameStatus(playing, T0 + min(59)).label, 'Live');
    assert.equal(gameStatus(playing, T0 + min(61)).label, 'Hard cap');
    const tied = game([point('team', 0, 10), point(null, 55, null)], { hardCapMinutes: 60 });
    tied.points[1] = point('opponent', 55, 62);
    tied.scores = { team: 1, opponent: 1 };
    tied.points.push(point(null, 63, null));
    assert.equal(gameStatus(tied, T0 + min(64)).label, 'Universe');
    const hardOnly = game([point('team', 0, 10)], { hardCapMinutes: 60 });
    assert.equal(gameStatus(hardOnly, T0 + min(70)).label, 'Hard cap');
});

test('a stoppage outranks the caps', () => {
    const live = point(null, 40, null);
    live.clockStopped = 'timeout';
    const g = game([live], { softCapMinutes: 45 });
    assert.equal(gameStatus(g, T0 + min(50)).label, 'Timeout');
});

test('two-point plays: no capped target is claimed when winners do not add up', () => {
    const g = game([point('team', 0, 50), point(null, 51, null)], { softCapMinutes: 45 });
    g.scores = { team: 0, opponent: 0 };   // e.g. the scores were edited down
    assert.equal(gameStatus(g, T0 + min(52)).label, 'Soft cap');
});
