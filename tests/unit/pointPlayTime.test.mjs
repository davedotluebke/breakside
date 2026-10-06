/*
 * store/pointPlayTime.js — a point's play time split by its injury subs
 * (ARCHITECTURE.md § Point clock → Stoppages → "Split by the sub"), and the
 * two consumers that are pure enough to pin here: the live per-player
 * counters (game/pointStats.js) and the Review / export accumulator
 * (utils/statAccumulator.js).
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// statAccumulator reaches utils/helpers.js, which publishes window hooks at
// module scope; stub them before the dynamic imports (as fullStats.test.mjs).
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { subEventsOf, rosterSegments, everyoneOn, playTimeFor } = await import('../../store/pointPlayTime.js');
const { Point, Possession, Other, Throw, Role } = await import('../../store/models.js');
const { applyPointPlayerStats, revertPointPlayerStats } = await import('../../game/pointStats.js');
const { accumulateGameStats } = await import('../../utils/statAccumulator.js');

const ALICE = { name: 'Alice', id: 'Alice-1111' };
const BOB = { name: 'Bob', id: 'Bob-2222' };
const CARA = { name: 'Cara', id: 'Cara-3333' };
const DANA = { name: 'Dana', id: 'Dana-4444' };
const ROSTER = [ALICE, BOB, CARA, DANA];

/** A name-era membership (entries are names), as buildPointMembership builds. */
const membership = {
    onList: (list, player) => (list || []).some(e => e === player.name || e === player.id),
    played: (point, player) => membership.onList(point.players, player) || membership.onList(point.substitutedOutPlayers, player),
};
const onListFor = (player) => (list) => membership.onList(list, player);

/** A concluded point with the given subs applied in order. */
function pointWithSubs(line, subs, totalPointTime, over = {}) {
    const point = new Point([...line], 'offense');
    const poss = new Possession(true);
    point.addPossession(poss);
    let players = [...line];
    subs.forEach(({ out = [], inn = [], at }) => {
        const before = [...players];
        players = players.filter(p => !out.includes(p)).concat(inn);
        out.forEach(p => { if (!point.substitutedOutPlayers.includes(p)) point.substitutedOutPlayers.push(p); });
        inn.forEach(p => { if (!point.substitutedInPlayers.includes(p)) point.substitutedInPlayers.push(p); });
        poss.events.push(new Other({
            injury: true, description: 'Sub', playersBefore: before,
            subbedOutBefore: [], subbedInBefore: [], playTimeAtSub: at,
        }));
    });
    point.players = players;
    point.totalPointTime = totalPointTime;
    return Object.assign(point, { winner: 'team', endTimestamp: new Date() }, over);
}

test('no subs: one segment, the whole point to the line', () => {
    const point = pointWithSubs(['Alice', 'Bob'], [], 90000);
    assert.deepEqual(rosterSegments(point, 90000), [{ from: 0, to: 90000, players: ['Alice', 'Bob'] }]);
    assert.deepEqual(everyoneOn(point), ['Alice', 'Bob']);
    assert.equal(playTimeFor(point, 90000, onListFor(ALICE)), 90000);
    assert.equal(playTimeFor(point, 90000, onListFor(CARA)), 0);
    assert.equal(subEventsOf(point).length, 0);
});

test('one sub: the outgoing player up to the sub, the incoming player from it on', () => {
    const point = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], inn: ['Cara'], at: 30000 }], 90000);
    assert.deepEqual(rosterSegments(point, 90000), [
        { from: 0, to: 30000, players: ['Alice', 'Bob'] },
        { from: 30000, to: 90000, players: ['Bob', 'Cara'] },
    ]);
    assert.equal(playTimeFor(point, 90000, onListFor(ALICE)), 30000, 'out at 0:30');
    assert.equal(playTimeFor(point, 90000, onListFor(CARA)), 60000, 'in from 0:30');
    assert.equal(playTimeFor(point, 90000, onListFor(BOB)), 90000, 'on throughout');
    assert.equal(playTimeFor(point, 90000, onListFor(DANA)), 0);
    assert.deepEqual(everyoneOn(point), ['Alice', 'Bob', 'Cara']);
});

test('two subs, and a player who goes out and comes back', () => {
    const point = pointWithSubs(['Alice', 'Bob'], [
        { out: ['Alice'], inn: ['Cara'], at: 20000 },
        { out: ['Cara'], inn: ['Alice'], at: 50000 },
    ], 80000);
    assert.equal(playTimeFor(point, 80000, onListFor(ALICE)), 50000, '0–20 s and 50–80 s');
    assert.equal(playTimeFor(point, 80000, onListFor(CARA)), 30000, '20–50 s');
    assert.equal(playTimeFor(point, 80000, onListFor(BOB)), 80000);
});

test('a sub before the first touch (play clock 0) credits the outgoing player nothing; one removed with nobody in', () => {
    const point = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], inn: ['Cara'], at: 0 }], 60000);
    assert.equal(playTimeFor(point, 60000, onListFor(ALICE)), 0);
    assert.equal(playTimeFor(point, 60000, onListFor(CARA)), 60000);
    assert.ok(everyoneOn(point).includes('Alice'), 'still on the point: they were on the line');

    const removed = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], at: 45000 }], 60000);
    assert.equal(playTimeFor(removed, 60000, onListFor(ALICE)), 45000);
    assert.equal(playTimeFor(removed, 60000, onListFor(BOB)), 60000);
});

test('the live point: the total passed in is banked plus running, and the last segment runs to it', () => {
    const point = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], inn: ['Cara'], at: 30000 }], 30000,
        { winner: '', endTimestamp: null });
    // 30 s banked at the sub, the clock restarted and 12 s have run since.
    assert.equal(playTimeFor(point, 42000, onListFor(CARA)), 12000);
    assert.equal(playTimeFor(point, 42000, onListFor(ALICE)), 30000);
    assert.equal(playTimeFor(point, 42000, onListFor(BOB)), 42000);
});

test('clamping: a sub recorded past the total, or out of order, never yields a negative segment', () => {
    const past = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], inn: ['Cara'], at: 99000 }], 60000);
    assert.equal(playTimeFor(past, 60000, onListFor(ALICE)), 60000);
    assert.equal(playTimeFor(past, 60000, onListFor(CARA)), 0);
    const disordered = pointWithSubs(['Alice', 'Bob'], [
        { out: ['Alice'], inn: ['Cara'], at: 40000 },
        { out: ['Bob'], inn: ['Dana'], at: 10000 },
    ], 60000);
    const segs = rosterSegments(disordered, 60000);
    assert.ok(segs.every(s => s.to >= s.from));
    assert.equal(segs.reduce((n, s) => n + (s.to - s.from), 0), 60000, 'segments still cover the point');
});

test('legacy sub events (no play clock, or no snapshot) credit everyone on the point in full', () => {
    const point = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], inn: ['Cara'], at: 30000 }], 90000);
    subEventsOf(point)[0].playTimeAtSub = null;
    assert.equal(rosterSegments(point, 90000), null);
    assert.deepEqual(everyoneOn(point), ['Bob', 'Cara', 'Alice'], 'players ∪ substitutedOutPlayers');
    assert.equal(playTimeFor(point, 90000, onListFor(ALICE)), 90000);
    assert.equal(playTimeFor(point, 90000, onListFor(CARA)), 90000);
    assert.equal(playTimeFor(point, 90000, onListFor(DANA)), 0);

    const noSnapshot = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], inn: ['Cara'], at: 30000 }], 90000);
    subEventsOf(noSnapshot)[0].playersBefore = null;
    assert.equal(rosterSegments(noSnapshot, 90000), null);
    assert.equal(playTimeFor(null, 90000, onListFor(ALICE)), 0);
    assert.equal(playTimeFor(point, 90000, null), 0);
});

test('live counters: apply credits each player their stretch, revert takes exactly that back', () => {
    const point = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], inn: ['Cara'], at: 30000 }], 90000);
    const roster = ROSTER.map(p => ({ ...p, totalPointsPlayed: 0, consecutivePointsPlayed: 0, totalTimePlayed: 100000, pointsWon: 0, pointsLost: 0 }));
    const [alice, bob, cara, dana] = roster;
    applyPointPlayerStats(point, roster, membership);
    assert.equal(alice.totalTimePlayed, 130000);
    assert.equal(cara.totalTimePlayed, 160000);
    assert.equal(bob.totalTimePlayed, 190000);
    assert.equal(dana.totalTimePlayed, 100000);
    assert.equal(alice.totalPointsPlayed, 1, 'a subbed-out player played the point');
    assert.equal(cara.totalPointsPlayed, 1);
    assert.equal(point.playerStatsCounted, true);

    revertPointPlayerStats(point, roster, membership);
    assert.deepEqual(roster.map(p => p.totalTimePlayed), [100000, 100000, 100000, 100000]);
    assert.deepEqual(roster.map(p => p.totalPointsPlayed), [0, 0, 0, 0]);
});

test('live counters: a membership without onList (older callers) still credits the whole point', () => {
    const point = pointWithSubs(['Alice', 'Bob'], [{ out: ['Alice'], inn: ['Cara'], at: 30000 }], 90000);
    const roster = ROSTER.map(p => ({ ...p, totalPointsPlayed: 0, consecutivePointsPlayed: 0, totalTimePlayed: 0, pointsWon: 0, pointsLost: 0 }));
    applyPointPlayerStats(point, roster, { played: membership.played });
    assert.deepEqual(roster.map(p => p.totalTimePlayed), [90000, 90000, 90000, 0]);
});

test('accumulator (Review / export): subbed players split the time and both count the point', () => {
    const point = pointWithSubs([ALICE.id, BOB.id], [{ out: [ALICE.id], inn: [CARA.id], at: 30000 }], 90000);
    point.startingPosition = 'offense';
    const game = { rosterSnapshot: { players: ROSTER }, points: [point] };
    const stats = {};
    accumulateGameStats(game, stats);
    assert.equal(stats[ALICE.id].timePlayed, 30000);
    assert.equal(stats[CARA.id].timePlayed, 60000);
    assert.equal(stats[BOB.id].timePlayed, 90000);
    assert.equal(stats[DANA.id], undefined);
    assert.equal(stats[ALICE.id].pointsPlayed, 1, 'subbed out, but played the point');
    assert.equal(stats[ALICE.id].plusMinus, 1, 'and shares its result, as the live counters do');
    assert.equal(stats[CARA.id].pointsPlayed, 1);
    assert.equal(stats[BOB.id].pointsPlayed, 1);
    assert.equal(stats[ALICE.id].name, 'Alice', 'id-era entries still get display names');
});

test('accumulator: a legacy sub (no play clock) credits everyone on the point in full', () => {
    const point = pointWithSubs([ALICE.id, BOB.id], [{ out: [ALICE.id], inn: [CARA.id], at: 30000 }], 90000);
    subEventsOf(point)[0].playTimeAtSub = null;
    const game = { rosterSnapshot: { players: ROSTER }, points: [point] };
    const stats = {};
    accumulateGameStats(game, stats);
    assert.equal(stats[ALICE.id].timePlayed, 90000);
    assert.equal(stats[CARA.id].timePlayed, 90000);
    assert.equal(stats[BOB.id].timePlayed, 90000);
    assert.equal(stats[ALICE.id].pointsPlayed, 1);
});

test('accumulator: a point with no subs is unchanged — the line, the whole point', () => {
    const point = pointWithSubs([ALICE.id, BOB.id], [], 45000);
    const poss = point.possessions[0];
    poss.events.push(new Throw({ thrower: ALICE, receiver: BOB, score: true }));
    const game = { rosterSnapshot: { players: ROSTER }, points: [point] };
    const stats = {};
    accumulateGameStats(game, stats);
    assert.equal(stats[ALICE.id].timePlayed, 45000);
    assert.equal(stats[BOB.id].timePlayed, 45000);
    assert.equal(stats[ALICE.id].pointsPlayed, 1);
    assert.equal(stats[BOB.id].goals, 1);
    assert.equal(Object.keys(stats).length, 2);
    assert.equal(point.winner, Role.TEAM);
});
