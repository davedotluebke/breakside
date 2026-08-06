/*
 * Unit tests for the per-possession set (zone/ho-stack/…) breakdown in
 * utils/statAccumulator.js — getGameTeamStats().sets, its merge across games,
 * and the display lines formatTeamStatsLine appends.
 *
 * The contract under test:
 *  - a DEFENSIVE possession is a "stop" unless it is the last possession of a
 *    point we lost (that is the one the opponent scored on). A defensive
 *    possession that ends a point we WON is a Callahan — a stop, not a score-on
 *  - a break is credited to the set of the LAST defensive possession of a won
 *    D-point (the stop we converted), and to that one only
 *  - an OFFENSIVE possession "scored" when it is the last possession of a point
 *    we won
 *  - a label listed under both sides stays two separate records, because the
 *    denominators mean different things
 *  - nothing is emitted for untagged possessions, so teams that never opted
 *    into set tracking see no change anywhere
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure leaf (see fullStats.test.mjs) — stub the module-scope window hooks its
// import chain publishes, then import.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { getGameTeamStats, getGamesTeamStats, formatTeamStatsLine, formatSetStatsLines } =
    await import('../../utils/statAccumulator.js');

// ── helpers ─────────────────────────────────────────────────────────────

/** A completed point. `poss` entries are [offensive, set] pairs. */
function point(startingPosition, winner, poss) {
    return {
        winner,
        players: [],
        totalPointTime: 60000,
        startingPosition,
        possessions: poss.map(([offensive, set]) => ({ offensive, set: set ?? null, events: [] }))
    };
}

function gameOf(...points) {
    return { rosterSnapshot: { players: [] }, points };
}

/** The record for one set, or undefined. side is 'o' | 'd'. */
function rec(stats, side, label) {
    return stats.sets[`${side}:${label}`];
}

const O = true, D = false;

// ── stops, breaks and scores within one point ───────────────────────────

test('D-point broken after two different defensive sets', () => {
    // Zone gets a stop, we turn it over, Man gets the stop we score off.
    const stats = getGameTeamStats(gameOf(point('defense', 'team', [
        [D, 'Zone'], [O, 'Ho'], [D, 'Man'], [O, 'Ho']
    ])));

    assert.equal(stats.breaks, 1);
    assert.equal(stats.breakOpps, 1);
    assert.equal(stats.breakPossOpps, 2, 'both defensive possessions still counted');

    assert.deepEqual(rec(stats, 'd', 'Zone'), {
        label: 'Zone', offensive: false, possessions: 1, stops: 1, breaks: 0, scores: 0
    });
    // The break is credited to Man alone — Zone got a stop but we gave it back.
    assert.deepEqual(rec(stats, 'd', 'Man'), {
        label: 'Man', offensive: false, possessions: 1, stops: 1, breaks: 1, scores: 0
    });
    assert.deepEqual(rec(stats, 'o', 'Ho'), {
        label: 'Ho', offensive: true, possessions: 2, stops: 0, breaks: 0, scores: 1
    });
});

test('a defensive possession the opponent scores on is not a stop', () => {
    const stats = getGameTeamStats(gameOf(point('defense', 'opponent', [[D, 'Zone']])));
    assert.equal(stats.breaks, 0);
    assert.equal(rec(stats, 'd', 'Zone').possessions, 1);
    assert.equal(rec(stats, 'd', 'Zone').stops, 0);
    assert.equal(rec(stats, 'd', 'Zone').breaks, 0);
});

test('Callahan — a won point ending on defense is a stop, not a score-on', () => {
    const stats = getGameTeamStats(gameOf(point('defense', 'team', [[D, 'Zone']])));
    assert.equal(stats.breaks, 1);
    assert.equal(rec(stats, 'd', 'Zone').stops, 1);
    assert.equal(rec(stats, 'd', 'Zone').breaks, 1);
});

test('offensive set counts the possession it scored on', () => {
    const stats = getGameTeamStats(gameOf(point('offense', 'team', [[O, 'Vert']])));
    assert.equal(stats.cleanHolds, 1);
    assert.equal(rec(stats, 'o', 'Vert').scores, 1);
});

test('offensive set gets no score when we are broken', () => {
    const stats = getGameTeamStats(gameOf(point('offense', 'opponent', [[O, 'Vert'], [D, 'Zone']])));
    assert.equal(stats.opponentBreaks, 1);
    assert.equal(rec(stats, 'o', 'Vert').possessions, 1);
    assert.equal(rec(stats, 'o', 'Vert').scores, 0);
    assert.equal(rec(stats, 'd', 'Zone').stops, 0, 'they scored on this one');
});

test('a label used on both sides stays two records', () => {
    const stats = getGameTeamStats(gameOf(point('offense', 'team', [[O, 'Junk'], [D, 'Junk'], [O, 'Junk']])));
    assert.equal(rec(stats, 'o', 'Junk').possessions, 2);
    assert.equal(rec(stats, 'd', 'Junk').possessions, 1);
});

test('in-progress points contribute nothing', () => {
    const stats = getGameTeamStats(gameOf({
        winner: null, players: [], startingPosition: 'defense',
        possessions: [{ offensive: D, set: 'Zone', events: [] }]
    }));
    assert.equal(stats.total, 0);
    assert.deepEqual(stats.sets, {});
});

// ── merging across games ────────────────────────────────────────────────

test('getGamesTeamStats merges set records and keeps counters correct', () => {
    const g1 = gameOf(point('defense', 'team', [[D, 'Zone'], [O, 'Ho']]));
    const g2 = gameOf(
        point('defense', 'opponent', [[D, 'Zone']]),
        point('offense', 'team', [[O, 'Ho']])
    );
    const stats = getGamesTeamStats([g1, g2]);

    assert.equal(stats.total, 3);
    assert.equal(stats.breaks, 1);
    assert.equal(stats.cleanHolds, 1);
    assert.equal(stats.breakPossOpps, 2);

    assert.equal(rec(stats, 'd', 'Zone').possessions, 2);
    assert.equal(rec(stats, 'd', 'Zone').stops, 1, 'stopped in g1, scored on in g2');
    assert.equal(rec(stats, 'd', 'Zone').breaks, 1);
    assert.equal(rec(stats, 'o', 'Ho').possessions, 2);
    assert.equal(rec(stats, 'o', 'Ho').scores, 2);
});

test('merging does not mutate the per-game records', () => {
    const g1 = gameOf(point('defense', 'team', [[D, 'Zone']]));
    const before = getGameTeamStats(g1);
    getGamesTeamStats([g1, g1]);
    assert.equal(before.sets['d:Zone'].possessions, 1);
});

// ── formatting ──────────────────────────────────────────────────────────

test('set lines order D first, then most-used, then alphabetical', () => {
    const stats = getGamesTeamStats([gameOf(
        point('defense', 'team', [[D, 'Man'], [O, 'Ho'], [D, 'Zone'], [O, 'Ho']]),
        point('defense', 'opponent', [[D, 'Zone']]),
        point('offense', 'team', [[O, 'Vert']])
    )]);
    const lines = formatSetStatsLines(stats.sets);
    assert.deepEqual(lines.map(l => l.replace('• ', '').split(' ')[0]), ['Zone', 'Man', 'Ho', 'Vert']);
    assert.match(lines[0], /Zone \(D\): 1\/2 stops, 1 break$/);
    assert.match(lines[1], /Man \(D\): 1\/1 stops, 0 breaks$/);
    assert.match(lines[2], /Ho \(O\): 1\/2 scored$/);
});

test('formatTeamStatsLine appends a By set block under breaks/holds', () => {
    const stats = getGameTeamStats(gameOf(point('defense', 'team', [[D, 'Zone'], [O, 'Ho']])));
    const text = formatTeamStatsLine(stats);
    const lines = text.split('\n');
    assert.match(lines[0], /^Breaks:/);
    assert.match(lines[1], /^Holds:/);
    assert.equal(lines[2], 'By set:');
    assert.match(lines[3], /Zone \(D\)/);
});

test('untagged games are byte-identical to before — no By set block', () => {
    const stats = getGameTeamStats(gameOf(
        point('defense', 'team', [[D, null], [O, null]]),
        point('offense', 'team', [[O, null]])
    ));
    assert.deepEqual(stats.sets, {});
    assert.deepEqual(formatSetStatsLines(stats.sets), []);
    const text = formatTeamStatsLine(stats);
    assert.ok(!text.includes('By set'));
    assert.equal(text.split('\n').length, 2);
});

test('formatSetStatsLines tolerates a missing sets map (legacy callers)', () => {
    assert.deepEqual(formatSetStatsLines(undefined), []);
    assert.deepEqual(formatSetStatsLines({}), []);
});
