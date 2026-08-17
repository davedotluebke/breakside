/*
 * Unit tests for the O/D split of +/- (utils/statAccumulator.js
 * accumulateGameStats): pointsPlayedO/D and plusMinusO/D, which back the
 * "O +/-", "..per O pt", "D +/-" and "..per D pt" columns in the Full stats
 * view and the matching xlsx columns.
 *
 * The contract:
 *  - a point counts as an O point when its startingPosition is 'offense', and
 *    as a D point otherwise — the same reading classifyPoint uses, so the two
 *    halves always add back up to the whole
 *  - plusMinusO + plusMinusD == plusMinus, and pointsPlayedO + pointsPlayedD
 *    == pointsPlayed, for every player
 *  - only players on the field for a point are credited, and in-progress
 *    points count for neither side
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same stubbing as fullStats.test.mjs: import the pure leaf so no network,
// DOM, or app wiring gets evaluated.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { accumulateGameStats, sumPlayerStats } = await import('../../utils/statAccumulator.js');

const ALICE = { name: 'Alice', id: 'Alice-1111' };
const BOB = { name: 'Bob', id: 'Bob-2222' };

/** One completed (or, with winner: null, in-progress) point. */
function point(startingPosition, winner, players = [ALICE.id, BOB.id]) {
    return { startingPosition, winner, players, totalPointTime: 60000, possessions: [] };
}

function statsFor(points) {
    const stats = {};
    accumulateGameStats({ rosterSnapshot: { players: [ALICE, BOB] }, points }, stats);
    return stats;
}

test('O and D points are tallied separately', () => {
    const s = statsFor([
        point('offense', 'team'),      // held
        point('offense', 'opponent'),  // got broken
        point('defense', 'team'),      // broke
        point('defense', 'opponent'),  // they held
        point('defense', 'opponent')   // they held again
    ]);
    const a = s[ALICE.id];
    assert.equal(a.pointsPlayedO, 2);
    assert.equal(a.pointsPlayedD, 3);
    assert.equal(a.plusMinusO, 0);   // +1 -1
    assert.equal(a.plusMinusD, -1);  // +1 -1 -1
});

test('the two halves always add back up to the whole', () => {
    const s = statsFor([
        point('offense', 'team'),
        point('defense', 'team'),
        point('defense', 'opponent'),
        point('offense', 'opponent'),
        point('offense', 'team')
    ]);
    Object.values(s).forEach(ps => {
        assert.equal(ps.plusMinusO + ps.plusMinusD, ps.plusMinus);
        assert.equal(ps.pointsPlayedO + ps.pointsPlayedD, ps.pointsPlayed);
    });
});

test('a point with no startingPosition counts as a D point', () => {
    // Matches classifyPoint, which reads anything that is not 'offense' as a
    // point started on defense — so the split never silently loses a point.
    const s = statsFor([point(undefined, 'team')]);
    const a = s[ALICE.id];
    assert.equal(a.pointsPlayedD, 1);
    assert.equal(a.pointsPlayedO, 0);
    assert.equal(a.pointsPlayedO + a.pointsPlayedD, a.pointsPlayed);
});

test('an in-progress point counts for neither side', () => {
    const s = statsFor([point('offense', 'team'), point('defense', null)]);
    const a = s[ALICE.id];
    assert.equal(a.pointsPlayed, 1);
    assert.equal(a.pointsPlayedO, 1);
    assert.equal(a.pointsPlayedD, 0);
});

test('only the players on the field for a point are credited', () => {
    const s = statsFor([
        point('offense', 'team', [ALICE.id]),
        point('defense', 'opponent', [BOB.id])
    ]);
    assert.equal(s[ALICE.id].plusMinusO, 1);
    assert.equal(s[ALICE.id].pointsPlayedD, 0);
    assert.equal(s[BOB.id].plusMinusD, -1);
    assert.equal(s[BOB.id].pointsPlayedO, 0);
});

test('sumPlayerStats carries the split into the Team row', () => {
    const s = statsFor([
        point('offense', 'team'),
        point('defense', 'opponent')
    ]);
    const tot = sumPlayerStats([s[ALICE.id], s[BOB.id]]);
    assert.equal(tot.pointsPlayedO, 2);   // two players, one O point each
    assert.equal(tot.pointsPlayedD, 2);
    assert.equal(tot.plusMinusO, 2);
    assert.equal(tot.plusMinusD, -2);
    assert.equal(tot.plusMinusO + tot.plusMinusD, tot.plusMinus);
});
