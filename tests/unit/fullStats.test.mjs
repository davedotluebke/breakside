/*
 * Unit tests for the "full" stats level's new per-player counters
 * (utils/eventStats.js accumulateGameStats): throwaways, drops, pulls and the
 * good/okay/poor/brick pull-quality breakdown — plus the sumPlayerStats
 * aggregation the Team rows are built from.
 *
 * The fault-attribution contract under test — every turnover is charged to
 * exactly ONE player:
 *  - a throwaway (or stall) charges the thrower one turnover AND one throwaway
 *  - a drop means the throw was good, so it charges the RECEIVER a turnover
 *    and a drop, and charges the thrower nothing (per-player, throwaways +
 *    drops == turnovers)
 *  - pulls count for the puller; quality comes from `quality`, with Field
 *    mode's bare `brick_flag` counted as a Brick
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Imported from the pure leaf (utils/statAccumulator.js) rather than
// utils/eventStats.js — same functions, but no store/sync.js in the chain, so
// no network, DOM, or app wiring gets evaluated. All that's left is a couple
// of `window.*` hooks published at module scope by logger.js / storage.js;
// stub them before the dynamic import so the chain can evaluate.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { accumulateGameStats, sumPlayerStats } = await import('../../utils/statAccumulator.js');

// ── helpers ─────────────────────────────────────────────────────────────

const ALICE = { name: 'Alice', id: 'Alice-1111' };
const BOB = { name: 'Bob', id: 'Bob-2222' };

// A minimal game: one completed point whose single possession holds `events`.
// rosterSnapshot lets buildPlayerNameResolver map names → ids.
function makeGame(events, players = [ALICE.id, BOB.id]) {
    return {
        rosterSnapshot: { players: [ALICE, BOB] },
        points: [{
            winner: 'team',
            players,
            totalPointTime: 60000,
            startingPosition: 'defense',
            possessions: [{ offensive: true, events }]
        }]
    };
}

function statsFor(events) {
    const stats = {};
    accumulateGameStats(makeGame(events), stats);
    return stats;
}

// ── throwaways vs drops ─────────────────────────────────────────────────

test('a throwaway charges the thrower a turnover and a throwaway', () => {
    const s = statsFor([{ type: 'Turnover', thrower: ALICE, throwaway_flag: true }]);
    assert.equal(s[ALICE.id].turnovers, 1);
    assert.equal(s[ALICE.id].throwaways, 1);
    assert.equal(s[ALICE.id].drops, 0);
    // Throwaways still count against completion percentage.
    assert.equal(s[ALICE.id].totalThrows, 1);
    assert.equal(s[ALICE.id].completions, 0);
});

test('a stall counts as a throwaway (thrower-charged, not a drop)', () => {
    const s = statsFor([{ type: 'Turnover', thrower: ALICE, stall_flag: true }]);
    assert.equal(s[ALICE.id].throwaways, 1);
    assert.equal(s[ALICE.id].drops, 0);
});

test('a drop charges the receiver alone — the thrower gets no turnover', () => {
    const s = statsFor([{ type: 'Turnover', thrower: ALICE, receiver: BOB, drop_flag: true }]);
    assert.equal(s[ALICE.id].turnovers, 0, 'the throw was good; the drop is not the thrower\'s turnover');
    assert.equal(s[ALICE.id].throwaways, 0);
    assert.equal(s[BOB.id].turnovers, 1);
    assert.equal(s[BOB.id].drops, 1);
});

test('every turnover is charged to exactly one player', () => {
    // Alice throws one away, then has a later (good) pass dropped by Bob.
    const s = statsFor([
        { type: 'Turnover', thrower: ALICE, throwaway_flag: true },
        { type: 'Turnover', thrower: ALICE, receiver: BOB, drop_flag: true }
    ]);
    assert.equal(s[ALICE.id].turnovers, 1);
    assert.equal(s[BOB.id].turnovers, 1);
    // Two turnover events → two charged turnovers total, not three.
    const totalTOs = Object.values(s).reduce((n, ps) => n + ps.turnovers, 0);
    assert.equal(totalTOs, 2);
});

test('per player, throwaways + drops always equals turnovers', () => {
    const s = statsFor([
        { type: 'Turnover', thrower: ALICE, throwaway_flag: true },
        { type: 'Turnover', thrower: ALICE, stall_flag: true },
        { type: 'Turnover', thrower: ALICE, receiver: BOB, drop_flag: true },
        { type: 'Turnover', thrower: BOB, receiver: ALICE, drop_flag: true }
    ]);
    Object.values(s).forEach(ps => {
        assert.equal(ps.throwaways + ps.drops, ps.turnovers);
    });
    assert.equal(s[ALICE.id].turnovers, 3);  // 2 throwaway-side + 1 drop
    assert.equal(s[BOB.id].turnovers, 1);    // 1 drop, nothing for the good throw
});

// ── pulls ───────────────────────────────────────────────────────────────

test('pull quality buckets by the recorded quality string', () => {
    const s = statsFor([
        { type: 'Pull', puller: ALICE, quality: 'Good Pull' },
        { type: 'Pull', puller: ALICE, quality: 'Okay Pull' },
        { type: 'Pull', puller: ALICE, quality: 'Poor Pull' },
        { type: 'Pull', puller: ALICE, quality: 'Brick' }
    ]);
    const a = s[ALICE.id];
    assert.equal(a.pulls, 4);
    assert.deepEqual(
        [a.pullsGood, a.pullsOkay, a.pullsPoor, a.pullsBrick],
        [1, 1, 1, 1]
    );
});

test("Field mode's brick_flag counts as a Brick even with no quality set", () => {
    const s = statsFor([{ type: 'Pull', puller: ALICE, brick_flag: true }]);
    assert.equal(s[ALICE.id].pulls, 1);
    assert.equal(s[ALICE.id].pullsBrick, 1);
});

test('an unrated pull counts toward Pulls but no quality bucket', () => {
    const s = statsFor([{ type: 'Pull', puller: ALICE }]);
    const a = s[ALICE.id];
    assert.equal(a.pulls, 1);
    assert.equal(a.pullsGood + a.pullsOkay + a.pullsPoor + a.pullsBrick, 0);
});

test('a pull by Unknown Player is not attributed to anyone', () => {
    const s = statsFor([{ type: 'Pull', puller: null, quality: 'Good Pull' }]);
    Object.values(s).forEach(ps => assert.equal(ps.pulls, 0));
});

// ── aggregation ─────────────────────────────────────────────────────────

test('sumPlayerStats adds the full-level counters across players', () => {
    const s = statsFor([
        { type: 'Turnover', thrower: ALICE, throwaway_flag: true },
        { type: 'Turnover', thrower: ALICE, receiver: BOB, drop_flag: true },
        { type: 'Pull', puller: ALICE, quality: 'Good Pull' },
        { type: 'Pull', puller: BOB, quality: 'Brick' }
    ]);
    const tot = sumPlayerStats([s[ALICE.id], s[BOB.id]]);
    assert.equal(tot.throwaways, 1);
    assert.equal(tot.drops, 1);
    assert.equal(tot.pulls, 2);
    assert.equal(tot.pullsGood, 1);
    assert.equal(tot.pullsBrick, 1);
});

test('sumPlayerStats tolerates missing/empty stats objects', () => {
    const tot = sumPlayerStats([undefined, {}, { throwaways: 3 }]);
    assert.equal(tot.throwaways, 3);
    assert.equal(tot.pulls, 0);
});
