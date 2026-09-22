/*
 * Unit tests for utils/connections.js — thrower→receiver pair aggregation
 * behind the Connections block on the Review and Event Roster + Stats screens.
 *
 * The contract under test:
 *  - a Throw with both refs is a completion for the pair; goals and hucks
 *    ride along
 *  - a drop is an attempt the pair did not complete; so is a throwaway that
 *    recorded an intended receiver; a receiver-less turnover touches no pair
 *  - refs may be objects or legacy name strings, and both resolve to the same
 *    id through the game's roster snapshot (as accumulateGameStats does)
 *  - multi-game aggregation merges pairs across games
 *  - in-progress points are skipped
 *  - the matrix orders throwers by passes thrown and receivers by catches
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// utils/helpers.js publishes window hooks via store/storage.js at import time.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { buildConnections, buildConnectionMatrix, favouriteTargets } =
    await import('../../utils/connections.js');
// With no stored teams, storage.js builds a "Sample Team" whose roster reuses
// the canonical fixture names under other ids; the name resolver would read
// them as ambiguous. Review a game the way a share guest does: no team.
const { setCurrentTeam } = await import('../../store/storage.js');
setCurrentTeam(null);

// ── helpers ─────────────────────────────────────────────────────────────

const ROSTER = [
    { id: 'Alice-7f3a', name: 'Alice' }, { id: 'Bob-1b2c', name: 'Bob' },
    { id: 'Charlie-9d0e', name: 'Charlie' }, { id: 'Dana-4e5f', name: 'Dana' },
];
const ref = name => { const p = ROSTER.find(r => r.name === name); return { name, id: p.id }; };

const throwTo = (t, r, flags = {}) => ({ type: 'Throw', thrower: ref(t), receiver: ref(r), ...flags });
const drop = (t, r) => ({ type: 'Turnover', thrower: ref(t), receiver: ref(r), drop_flag: true });
const throwaway = (t, r, flags = {}) => ({ type: 'Turnover', thrower: ref(t), receiver: r ? ref(r) : null, throwaway_flag: true, ...flags });

function gameOf(points, { snapshot = true } = {}) {
    return {
        team: 'Team A', opponent: 'Team B',
        rosterSnapshot: snapshot ? { players: ROSTER } : null,
        points: points.map(events => ({
            winner: 'team', startingPosition: 'offense', players: [],
            possessions: [{ offensive: true, events }],
        })),
    };
}

const pairOf = (conn, t, r) => conn.pairs.find(p => p.throwerName === t && p.receiverName === r);

// ── pairs ───────────────────────────────────────────────────────────────

test('completions, goals and hucks accrue to the pair', () => {
    const conn = buildConnections(gameOf([[
        throwTo('Alice', 'Bob'), throwTo('Bob', 'Alice'), throwTo('Alice', 'Bob', { huck_flag: true }),
        throwTo('Alice', 'Charlie', { score_flag: true }),
    ]]));
    const ab = pairOf(conn, 'Alice', 'Bob');
    assert.deepEqual([ab.completions, ab.attempts, ab.hucks, ab.huckAttempts, ab.goals], [2, 2, 1, 1, 0]);
    assert.equal(ab.throwerId, 'Alice-7f3a');
    assert.equal(ab.receiverId, 'Bob-1b2c');
    assert.equal(pairOf(conn, 'Alice', 'Charlie').goals, 1);
    assert.equal(pairOf(conn, 'Bob', 'Alice').completions, 1);
    assert.deepEqual(conn.totals, { completions: 4, attempts: 4, goals: 1 });
});

test('pairs sort by completions, then attempts, then name', () => {
    const conn = buildConnections(gameOf([[
        throwTo('Charlie', 'Dana'), throwTo('Alice', 'Bob'), throwTo('Alice', 'Bob'),
        throwTo('Bob', 'Alice'), drop('Bob', 'Alice'),
    ]]));
    assert.deepEqual(conn.pairs.map(p => `${p.throwerName}→${p.receiverName}`),
        ['Alice→Bob', 'Bob→Alice', 'Charlie→Dana']);
});

test('a drop and a targeted throwaway are attempts the pair did not complete', () => {
    const conn = buildConnections(gameOf([[
        throwTo('Alice', 'Bob'), drop('Alice', 'Bob'), throwaway('Alice', 'Bob', { huck_flag: true }),
        throwaway('Alice', null),   // no receiver: no pair
        { type: 'Turnover', thrower: ref('Bob'), stall_flag: true },
    ]]));
    const ab = pairOf(conn, 'Alice', 'Bob');
    assert.deepEqual([ab.completions, ab.attempts, ab.drops, ab.throwaways, ab.huckAttempts, ab.hucks], [1, 3, 1, 1, 1, 0]);
    assert.equal(conn.pairs.length, 1);
    assert.deepEqual(conn.totals, { completions: 1, attempts: 3, goals: 0 });
});

test('per-player involvement counts passes thrown and caught, assists and goals', () => {
    const conn = buildConnections(gameOf([[
        throwTo('Alice', 'Bob'), throwTo('Bob', 'Charlie'), throwTo('Charlie', 'Bob', { score_flag: true }), drop('Bob', 'Dana'),
    ]]));
    const bob = conn.players.find(p => p.name === 'Bob');
    assert.deepEqual([bob.thrown, bob.caught, bob.attemptsThrown, bob.attemptsCaught, bob.assists, bob.goals], [1, 2, 2, 2, 0, 1]);
    const charlie = conn.players.find(p => p.name === 'Charlie');
    assert.equal(charlie.assists, 1);
    // Most involved first: Bob (3), then Charlie (2), Alice (1), Dana (0 completions, but an attempt)
    assert.deepEqual(conn.players.map(p => p.name), ['Bob', 'Charlie', 'Alice', 'Dana']);
});

// ── refs and resolution ─────────────────────────────────────────────────

test('legacy name-string refs resolve to the same pair as object refs', () => {
    const g = gameOf([[
        throwTo('Alice', 'Bob'),
        { type: 'Throw', thrower: 'Alice', receiver: 'Bob' },
    ]]);
    const conn = buildConnections(g);
    assert.equal(conn.pairs.length, 1);
    assert.equal(conn.pairs[0].completions, 2);
    assert.equal(conn.pairs[0].throwerId, 'Alice-7f3a');
});

test('an object ref carrying only a name still resolves through the snapshot', () => {
    const conn = buildConnections(gameOf([[
        { type: 'Throw', thrower: { name: 'Alice' }, receiver: { name: 'Bob' } },
    ]]));
    assert.equal(conn.pairs[0].throwerId, 'Alice-7f3a');
    assert.equal(conn.pairs[0].receiverId, 'Bob-1b2c');
});

test('unknown names fall back to name-keyed ids rather than being dropped', () => {
    const conn = buildConnections(gameOf([[
        { type: 'Throw', thrower: 'Zoe', receiver: 'Wes' },
    ]], { snapshot: false }));
    assert.equal(conn.pairs.length, 1);
    assert.equal(conn.pairs[0].throwerName, 'Zoe');
    assert.equal(conn.pairs[0].throwerId, 'unresolved:Zoe');
});

test('a throw missing either side belongs to no pair', () => {
    const conn = buildConnections(gameOf([[
        { type: 'Throw', thrower: ref('Alice'), receiver: null },
        { type: 'Throw', thrower: null, receiver: ref('Bob') },
    ]]));
    assert.equal(conn.pairs.length, 0);
});

// ── scope ───────────────────────────────────────────────────────────────

test('in-progress points are skipped, like the player stats', () => {
    const g = gameOf([[throwTo('Alice', 'Bob')], [throwTo('Alice', 'Bob')]]);
    g.points[1].winner = '';
    assert.equal(buildConnections(g).pairs[0].completions, 1);
});

test('a list of games merges pairs across games', () => {
    const g1 = gameOf([[throwTo('Alice', 'Bob'), throwTo('Alice', 'Bob')]]);
    const g2 = gameOf([[throwTo('Alice', 'Bob', { score_flag: true }), throwTo('Charlie', 'Dana')]]);
    const conn = buildConnections([g1, g2]);
    assert.equal(pairOf(conn, 'Alice', 'Bob').completions, 3);
    assert.equal(pairOf(conn, 'Alice', 'Bob').goals, 1);
    assert.equal(conn.pairs.length, 2);
    assert.deepEqual(buildConnections([]).pairs, []);
    assert.deepEqual(buildConnections(null).pairs, []);
});

// ── matrix and favourites ───────────────────────────────────────────────

test('the matrix orders throwers by thrown and receivers by caught, with max for shading', () => {
    const conn = buildConnections(gameOf([[
        throwTo('Alice', 'Bob'), throwTo('Alice', 'Bob'), throwTo('Alice', 'Charlie'),
        throwTo('Bob', 'Charlie'), drop('Dana', 'Alice'),
    ]]));
    const m = buildConnectionMatrix(conn);
    assert.deepEqual(m.throwers.map(p => p.name), ['Alice', 'Bob', 'Dana']);      // Dana threw only an incompletion
    assert.deepEqual(m.receivers.map(p => p.name), ['Bob', 'Charlie', 'Alice']);  // Alice only had a drop aimed at her
    assert.equal(m.cells['Alice-7f3a']['Bob-1b2c'].completions, 2);
    assert.equal(m.cells['Dana-4e5f']['Alice-7f3a'].drops, 1);
    assert.equal(m.max, 2);
});

test('favouriteTargets picks the top pair per thrower and per receiver', () => {
    const conn = buildConnections(gameOf([[
        throwTo('Alice', 'Bob'), throwTo('Alice', 'Bob'), throwTo('Alice', 'Charlie'),
        throwTo('Dana', 'Charlie'), throwTo('Dana', 'Charlie'), drop('Charlie', 'Dana'),
    ]]));
    const { targetOf, sourceOf } = favouriteTargets(conn);
    assert.equal(targetOf.get('Alice-7f3a').receiverName, 'Bob');
    assert.equal(targetOf.get('Dana-4e5f').receiverName, 'Charlie');
    assert.equal(targetOf.has('Charlie-9d0e'), false);   // only an incompletion thrown
    assert.equal(sourceOf.get('Charlie-9d0e').throwerName, 'Dana');
    assert.equal(sourceOf.get('Bob-1b2c').throwerName, 'Alice');
});
