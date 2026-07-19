/*
 * Unit tests pinning the era-paired per-player live-counter updates
 * (game/pointStats.js), extracted from gameLogic.updateScore /
 * revertPointScore in the G11.1-.2 item-3 fix.
 *
 * The pairing contract under test:
 *  - apply matches via buildPointMembership (id-era point.players count) and
 *    stamps point.playerStatsCounted
 *  - revert with the stamp uses the same membership matching (symmetric)
 *  - revert WITHOUT the stamp (point scored under pre-fix code) uses raw-name
 *    matching: correct decrement for legacy name-era points, deliberate no-op
 *    for legacy id-era points (their score never incremented anything — undo
 *    chaining back through a reopened Nov-2025 game must not corrupt career
 *    counters)
 *
 * Run: node --test tests/unit/*.test.mjs
 * (no deps — plain node:test against the ES modules)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPointPlayerStats, revertPointPlayerStats } from '../../game/pointStats.js';
import { Role } from '../../store/models.js';

// ── helpers ─────────────────────────────────────────────────────────────

function makePlayer(name, id, overrides = {}) {
    return {
        name, id,
        totalPointsPlayed: 5, consecutivePointsPlayed: 2,
        totalTimePlayed: 600000, pointsWon: 3, pointsLost: 2,
        ...overrides,
    };
}

function makePoint({ winner = Role.TEAM, players = [], substitutedOutPlayers = [],
                     totalPointTime = 60000, playerStatsCounted } = {}) {
    const point = { winner, players, substitutedOutPlayers, totalPointTime };
    if (playerStatsCounted !== undefined) point.playerStatsCounted = playerStatsCounted;
    return point;
}

// Mirrors buildPointMembership's matching contract (utils/helpers.js): an
// entry matches on raw name, raw id, or via resolve(entry) → id. resolveMap
// covers the renamed-player arm (stored old name → stable id).
function makeMembership(resolveMap = {}) {
    const resolve = entry => resolveMap[entry] || entry;
    const has = (list, player) => !!player && (list || []).some(entry =>
        entry === player.name || entry === player.id || resolve(entry) === player.id);
    return {
        played: (point, player) => !!point && (has(point.players, player) ||
            has(point.substitutedOutPlayers, player)),
    };
}

function statsOf(player) {
    const { totalPointsPlayed, consecutivePointsPlayed, totalTimePlayed, pointsWon, pointsLost } = player;
    return { totalPointsPlayed, consecutivePointsPlayed, totalTimePlayed, pointsWon, pointsLost };
}

// ── apply ───────────────────────────────────────────────────────────────

test('apply: name-era point increments played players, resets consec for the rest', () => {
    const alice = makePlayer('Alice', 'Alice-7f3a');
    const bob = makePlayer('Bob', 'Bob-11aa');
    const point = makePoint({ winner: Role.TEAM, players: ['Alice'] });

    applyPointPlayerStats(point, [alice, bob], makeMembership());

    assert.deepEqual(statsOf(alice), {
        totalPointsPlayed: 6, consecutivePointsPlayed: 3,
        totalTimePlayed: 660000, pointsWon: 4, pointsLost: 2,
    });
    assert.equal(bob.consecutivePointsPlayed, 0);
    assert.equal(bob.totalPointsPlayed, 5);
    assert.equal(point.playerStatsCounted, true);
});

test('apply: id-era point.players (ids) increments the id-matched player', () => {
    const alice = makePlayer('Alice', 'Alice-7f3a');
    const bob = makePlayer('Bob', 'Bob-11aa');
    const point = makePoint({ winner: Role.OPPONENT, players: ['Alice-7f3a'] });

    applyPointPlayerStats(point, [alice, bob], makeMembership());

    assert.equal(alice.totalPointsPlayed, 6);
    assert.equal(alice.pointsLost, 3);
    assert.equal(alice.pointsWon, 3);
    assert.equal(bob.totalPointsPlayed, 5);
    assert.equal(point.playerStatsCounted, true);
});

test('apply: substituted-out player still counts as having played', () => {
    const alice = makePlayer('Alice', 'Alice-7f3a');
    const point = makePoint({ winner: Role.TEAM, players: ['Bob-11aa'],
        substitutedOutPlayers: ['Alice-7f3a'] });

    applyPointPlayerStats(point, [alice], makeMembership());

    assert.equal(alice.totalPointsPlayed, 6);
    assert.equal(alice.pointsWon, 4);
});

test('apply: renamed player matches through the resolver arm', () => {
    // Point stored the old name; the roster player has since been renamed.
    const alice = makePlayer('Alice', 'Al-7f3a');
    const point = makePoint({ winner: Role.TEAM, players: ['Al'] });

    applyPointPlayerStats(point, [alice], makeMembership({ Al: 'Al-7f3a' }));

    assert.equal(alice.totalPointsPlayed, 6);
});

// ── revert, marked points (scored under the membership code) ────────────

test('apply then revert is symmetric on an id-era point', () => {
    const alice = makePlayer('Alice', 'Alice-7f3a');
    const bob = makePlayer('Bob', 'Bob-11aa');
    const before = { alice: statsOf(alice), bob: statsOf(bob) };
    const point = makePoint({ winner: Role.TEAM, players: ['Alice-7f3a'] });
    const membership = makeMembership();

    applyPointPlayerStats(point, [alice, bob], membership);
    revertPointPlayerStats(point, [alice, bob], membership);

    assert.deepEqual(statsOf(alice), before.alice);
    // Bob's consec reset by apply is unrecoverable (pre-existing quirk) —
    // everything else is restored.
    assert.deepEqual(statsOf(bob), { ...before.bob, consecutivePointsPlayed: 0 });
    assert.equal(point.playerStatsCounted, false);
});

test('revert on a marked point decrements via membership (id-era)', () => {
    const alice = makePlayer('Alice', 'Alice-7f3a');
    const point = makePoint({ winner: Role.OPPONENT, players: ['Alice-7f3a'],
        playerStatsCounted: true });

    revertPointPlayerStats(point, [alice], makeMembership());

    assert.equal(alice.totalPointsPlayed, 4);
    assert.equal(alice.pointsLost, 1);
    assert.equal(point.playerStatsCounted, false);
});

// ── revert, unmarked points (scored under the pre-fix code) ─────────────

test('revert on an unmarked id-era point decrements NOBODY (legacy no-op preserved)', () => {
    const alice = makePlayer('Alice', 'Alice-7f3a');
    const before = statsOf(alice);
    const point = makePoint({ winner: Role.TEAM, players: ['Alice-7f3a'] });

    revertPointPlayerStats(point, [alice], makeMembership());

    // The old code's increment never fired on id-era points, so the revert
    // must not fire either — undoing a reopened old game stays harmless.
    assert.deepEqual(statsOf(alice), before);
});

test('revert on an unmarked name-era point decrements by raw name (legacy symmetric)', () => {
    const alice = makePlayer('Alice', 'Alice-7f3a');
    const sub = makePlayer('Carol', 'Carol-9b2c');
    const point = makePoint({ winner: Role.TEAM, players: ['Alice'],
        substitutedOutPlayers: ['Carol'] });

    revertPointPlayerStats(point, [alice, sub], makeMembership());

    assert.equal(alice.totalPointsPlayed, 4);
    assert.equal(alice.pointsWon, 2);
    assert.equal(sub.totalPointsPlayed, 4);
});

test('revert on an unmarked renamed-name point does not use the resolver (exact legacy matching)', () => {
    // Pre-fix code matched player.name verbatim; the era-paired revert must
    // reproduce that exactly, resolver or not.
    const alice = makePlayer('Alice', 'Al-7f3a');
    const before = statsOf(alice);
    const point = makePoint({ winner: Role.TEAM, players: ['Al'] });

    revertPointPlayerStats(point, [alice], makeMembership({ Al: 'Al-7f3a' }));

    assert.deepEqual(statsOf(alice), before);
});

// ── clamping ────────────────────────────────────────────────────────────

test('revert clamps all counters at zero', () => {
    const alice = makePlayer('Alice', 'Alice-7f3a', {
        totalPointsPlayed: 0, consecutivePointsPlayed: 0,
        totalTimePlayed: 1000, pointsWon: 0, pointsLost: 0,
    });
    const point = makePoint({ winner: Role.TEAM, players: ['Alice'],
        totalPointTime: 60000, playerStatsCounted: true });

    revertPointPlayerStats(point, [alice], makeMembership());

    assert.deepEqual(statsOf(alice), {
        totalPointsPlayed: 0, consecutivePointsPlayed: 0,
        totalTimePlayed: 0, pointsWon: 0, pointsLost: 0,
    });
});

test('chained undo across a sat-out point clamps consecutive at zero', () => {
    // Alice played P1 (consec 1) then sat P2 (apply resets consec to 0).
    // Undoing back past P2 and reverting P1 must not take consec to -1.
    const alice = makePlayer('Alice', 'Alice-7f3a',
        { totalPointsPlayed: 1, consecutivePointsPlayed: 1, totalTimePlayed: 60000, pointsWon: 1, pointsLost: 0 });
    const membership = makeMembership();
    const p1 = makePoint({ winner: Role.TEAM, players: ['Alice'], playerStatsCounted: true });
    const p2 = makePoint({ winner: Role.TEAM, players: ['Bob'] });

    applyPointPlayerStats(p2, [alice], membership);   // Alice sat: consec → 0
    revertPointPlayerStats(p2, [alice], membership);  // Alice untouched (didn't play)
    revertPointPlayerStats(p1, [alice], membership);  // played P1: decrement, clamped

    assert.equal(alice.consecutivePointsPlayed, 0);
    assert.equal(alice.totalPointsPlayed, 0);
});
