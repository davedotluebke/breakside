/*
 * Unit tests pinning the behavior of the undo decision tree
 * (game/undoLogic.js), extracted from gameLogic.undoEvent in the F3 sweep.
 *
 * Run: node --test tests/unit/*.test.mjs
 * (no deps — plain node:test against the ES modules)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyUndoToGame } from '../../game/undoLogic.js';
import { Role, Throw, Defense, Other } from '../../store/models.js';

// ── helpers ─────────────────────────────────────────────────────────────

function makePlayer(name) {
    return {
        name,
        completedPasses: 3, goals: 2, assists: 2,
        totalPointsPlayed: 5, consecutivePointsPlayed: 2,
        totalTimePlayed: 600000, pointsWon: 3, pointsLost: 2,
    };
}

function makeGame({ points = [] } = {}) {
    return { points, scores: { [Role.TEAM]: 3, [Role.OPPONENT]: 2 } };
}

function makePoint({ winner = '', possessions = [], players = [], totalPointTime = 60000 } = {}) {
    return { winner, possessions, players, totalPointTime, substitutedOutPlayers: [] };
}

function makePossession(events = []) {
    return { offensive: true, events, endTimestamp: new Date() };
}

function makeDeps(roster = {}) {
    const calls = { revertPointScore: [] };
    return {
        calls,
        deps: {
            getActivePossession: (point) => point.possessions[point.possessions.length - 1],
            resolvePlayer: (name) => roster[name] || null,
            revertPointScore: (point) => {
                calls.revertPointScore.push(point);
                point.winner = '';   // mirror the real function's visible effect
            },
        },
    };
}

// ── no-op cases ─────────────────────────────────────────────────────────

test('empty game → outcome none', () => {
    const { deps } = makeDeps();
    const game = makeGame();
    const result = applyUndoToGame(game, deps);
    assert.equal(result.outcome, 'none');
    assert.equal(result.pointRemoved, false);
});

test('unscored point with no possessions → outcome none', () => {
    const { deps } = makeDeps();
    const game = makeGame({ points: [makePoint()] });
    const result = applyUndoToGame(game, deps);
    assert.equal(result.outcome, 'none');
    assert.equal(game.points.length, 1);
});

// ── branch 1: score-reverted (winner set, last event not a score event) ──

test('scored point, last event not a score → revert score only, point kept', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const { deps, calls } = makeDeps();
    const throwEvt = new Throw({ thrower: alice, receiver: bob });
    const point = makePoint({ winner: Role.OPPONENT, possessions: [makePossession([throwEvt])] });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'score-reverted');
    assert.equal(result.pointRemoved, false);
    assert.equal(calls.revertPointScore.length, 1);
    assert.equal(game.points.length, 1);
    // the non-score event is untouched
    assert.equal(point.possessions[0].events.length, 1);
    assert.equal(alice.completedPasses, 3);
});

test('scored point with zero possessions ("They Score") → revert + remove point', () => {
    const { deps, calls } = makeDeps();
    const point = makePoint({ winner: Role.OPPONENT, possessions: [] });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'score-reverted');
    assert.equal(result.pointRemoved, true);
    assert.equal(calls.revertPointScore.length, 1);
    assert.equal(game.points.length, 0);
});

// ── branch 2: event-undone ──────────────────────────────────────────────

test('pop a plain throw → thrower completedPasses decremented, possession kept', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const { deps, calls } = makeDeps();
    const first = new Throw({ thrower: bob, receiver: alice });
    const last = new Throw({ thrower: alice, receiver: bob });
    const point = makePoint({ possessions: [makePossession([first, last])] });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.undoneEvent, last);
    assert.equal(result.pointRemoved, false);
    assert.equal(alice.completedPasses, 2);
    assert.equal(alice.goals, 2);        // not a score — goals untouched
    assert.equal(point.possessions[0].events.length, 1);
    assert.equal(calls.revertPointScore.length, 0);
});

test('pop a scoring throw → goals/assists reverted, score reverted, lone possession+point removed', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const { deps, calls } = makeDeps();
    const scoreThrow = new Throw({ thrower: alice, receiver: bob, score: true });
    const point = makePoint({ winner: Role.TEAM, possessions: [makePossession([scoreThrow])] });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.pointRemoved, true);
    assert.equal(alice.completedPasses, 2);
    assert.equal(alice.assists, 1);
    assert.equal(bob.goals, 1);
    assert.equal(calls.revertPointScore.length, 1);
    assert.equal(game.points.length, 0);
});

test('stat clamping: decrements never go below zero', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    alice.completedPasses = 0; alice.assists = 0; bob.goals = 0;
    const { deps } = makeDeps();
    const scoreThrow = new Throw({ thrower: alice, receiver: bob, score: true });
    const point = makePoint({ winner: Role.TEAM, possessions: [makePossession([scoreThrow])] });
    const game = makeGame({ points: [point] });

    applyUndoToGame(game, deps);

    assert.equal(alice.completedPasses, 0);
    assert.equal(alice.assists, 0);
    assert.equal(bob.goals, 0);
});

test('pop last event of a later possession → step back to previous possession', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const { deps } = makeDeps();
    const prev = makePossession([new Throw({ thrower: alice, receiver: bob })]);
    prev.endTimestamp = new Date();
    const cur = makePossession([new Throw({ thrower: bob, receiver: alice })]);
    const point = makePoint({ possessions: [prev, cur] });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.pointRemoved, false);
    assert.equal(point.possessions.length, 1);
    assert.equal(point.possessions[0], prev);
    assert.equal(prev.endTimestamp, null);   // previous possession re-opened
    assert.equal(game.points.length, 1);
});

test('pop a Callahan → defender goals decremented and score reverted', () => {
    const dana = makePlayer('Dana');
    const { deps, calls } = makeDeps();
    const callahan = new Defense({ defender: dana, Callahan: true });
    const point = makePoint({ winner: Role.TEAM, possessions: [makePossession([callahan])] });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(dana.goals, 1);
    assert.equal(calls.revertPointScore.length, 1);
    assert.equal(result.pointRemoved, true);  // lone possession emptied
});

// ── branch 2: injury-sub events ─────────────────────────────────────────

function makeInjurySub({ playersBefore, subbedOutBefore } = {}) {
    return new Other({
        injury: true, description: 'Sub: Henry in for Alice',
        playersBefore, subbedOutBefore,
    });
}

test('pop an injury sub → roster restored from the event snapshots', () => {
    const { deps } = makeDeps();
    const pull = new Throw({ thrower: makePlayer('X'), receiver: makePlayer('Y') });
    const sub = makeInjurySub({ playersBefore: ['Alice', 'Bob'], subbedOutBefore: [] });
    const point = makePoint({ possessions: [makePossession([pull, sub])], players: ['Bob', 'Henry'] });
    point.substitutedOutPlayers = ['Alice'];
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.pointRemoved, false);
    assert.deepEqual(point.players, ['Alice', 'Bob']);
    assert.deepEqual(point.substitutedOutPlayers, []);
    assert.equal(point.possessions[0].events.length, 1);   // pull remains
});

test('injury sub as the point\'s only event → possession removed, point KEPT', () => {
    // confirmSubstitution creates a possession just to host the sub on a
    // Simple-mode offense point; undoing it must not remove the live point
    // (a mid-point with zero possessions is the normal fresh-offense state).
    const { deps } = makeDeps();
    const sub = makeInjurySub({ playersBefore: ['Alice', 'Bob'], subbedOutBefore: [] });
    const point = makePoint({ possessions: [makePossession([sub])], players: ['Bob', 'Henry'] });
    point.substitutedOutPlayers = ['Alice'];
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.pointRemoved, false);
    assert.equal(game.points.length, 1);
    assert.deepEqual(point.possessions, []);
    assert.deepEqual(point.players, ['Alice', 'Bob']);
});

test('second sub then undo → restores to the FIRST sub\'s roster (chained snapshots)', () => {
    const { deps } = makeDeps();
    const sub1 = makeInjurySub({ playersBefore: ['Alice', 'Bob'], subbedOutBefore: [] });
    const sub2 = makeInjurySub({ playersBefore: ['Bob', 'Henry'], subbedOutBefore: ['Alice'] });
    sub2.description = 'Sub: Grace in for Bob';
    const point = makePoint({ possessions: [makePossession([sub1, sub2])], players: ['Henry', 'Grace'] });
    point.substitutedOutPlayers = ['Alice', 'Bob'];
    const game = makeGame({ points: [point] });

    applyUndoToGame(game, deps);
    assert.deepEqual(point.players, ['Bob', 'Henry']);
    assert.deepEqual(point.substitutedOutPlayers, ['Alice']);

    applyUndoToGame(game, deps);
    assert.deepEqual(point.players, ['Alice', 'Bob']);
    assert.deepEqual(point.substitutedOutPlayers, []);
});

test('legacy injury sub without snapshots → event popped, roster left alone', () => {
    const { deps } = makeDeps();
    const legacy = new Other({ injury: true, description: 'Sub: Henry in for Alice' });
    const pull = new Throw({ thrower: makePlayer('X'), receiver: makePlayer('Y') });
    const point = makePoint({ possessions: [makePossession([pull, legacy])], players: ['Bob', 'Henry'] });
    point.substitutedOutPlayers = ['Alice'];
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.deepEqual(point.players, ['Bob', 'Henry']);          // unchanged
    assert.deepEqual(point.substitutedOutPlayers, ['Alice']);   // unchanged
});

// ── branch 3: possession-popped ─────────────────────────────────────────

test('empty possession with a previous one → pop it, re-open previous', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const { deps } = makeDeps();
    const prev = makePossession([new Throw({ thrower: alice, receiver: bob })]);
    prev.endTimestamp = new Date();
    const cur = makePossession([]);
    const point = makePoint({ possessions: [prev, cur] });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'possession-popped');
    assert.equal(result.pointRemoved, false);
    assert.equal(point.possessions.length, 1);
    assert.equal(prev.endTimestamp, null);
});

test('lone empty possession, unscored point → point removed, stats untouched', () => {
    const alice = makePlayer('Alice');
    const { deps } = makeDeps({ Alice: alice });
    const point = makePoint({ possessions: [makePossession([])], players: ['Alice'] });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'possession-popped');
    assert.equal(result.pointRemoved, true);
    assert.equal(game.points.length, 0);
    // unscored point was never counted — stats must NOT be decremented
    assert.equal(alice.totalPointsPlayed, 5);
    assert.equal(game.scores[Role.TEAM], 3);
});

test('lone EMPTY possession on a scored point resolves via branch 1, not branch 3', () => {
    // Documents an invariant of the tree (present in the original
    // gameLogic.undoEvent too): a winner-set point whose active possession
    // has no events always hits the branch-1 "revert score only" path —
    // hasScoreEvent can't be true without events. Branch 3's own
    // winner-set stat-reversion code is therefore unreachable in practice;
    // it's retained as a faithful extraction / defensive mirror.
    const alice = makePlayer('Alice');
    const { deps, calls } = makeDeps({ Alice: alice });
    const point = makePoint({
        winner: Role.TEAM, possessions: [makePossession([])],
        players: ['Alice'], totalPointTime: 60000,
    });
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'score-reverted');
    assert.equal(result.pointRemoved, false);       // possession still there
    assert.equal(calls.revertPointScore.length, 1); // score handled by injected revert
    assert.equal(game.points.length, 1);
    // branch-3's manual stat reversion did NOT run
    assert.equal(alice.totalPointsPlayed, 5);
    assert.equal(game.scores[Role.TEAM], 3);
});
