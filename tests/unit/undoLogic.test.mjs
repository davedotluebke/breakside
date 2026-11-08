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

test('pop a scoring throw with an explicit assist holder → that holder loses the assist, not the thrower', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob'), dana = makePlayer('Dana');
    const { deps } = makeDeps();
    const scoreThrow = new Throw({ thrower: alice, receiver: bob, score: true, assist: dana });
    const point = makePoint({ winner: Role.TEAM, possessions: [makePossession([scoreThrow])] });

    applyUndoToGame(makeGame({ points: [point] }), deps);

    assert.equal(alice.completedPasses, 2, 'the thrower still loses the completed pass');
    assert.equal(alice.assists, 2, 'the thrower never held the assist');
    assert.equal(dana.assists, 1);
    assert.equal(bob.goals, 1);
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
        injury: true, description: 'Sub: Hank in for Alice',
        playersBefore, subbedOutBefore,
    });
}

test('pop an injury sub → roster restored from the event snapshots', () => {
    const { deps } = makeDeps();
    const pull = new Throw({ thrower: makePlayer('X'), receiver: makePlayer('Y') });
    const sub = makeInjurySub({ playersBefore: ['Alice', 'Bob'], subbedOutBefore: [] });
    const point = makePoint({ possessions: [makePossession([pull, sub])], players: ['Bob', 'Hank'] });
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
    const point = makePoint({ possessions: [makePossession([sub])], players: ['Bob', 'Hank'] });
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
    const sub2 = makeInjurySub({ playersBefore: ['Bob', 'Hank'], subbedOutBefore: ['Alice'] });
    sub2.description = 'Sub: Grace in for Bob';
    const point = makePoint({ possessions: [makePossession([sub1, sub2])], players: ['Hank', 'Grace'] });
    point.substitutedOutPlayers = ['Alice', 'Bob'];
    const game = makeGame({ points: [point] });

    applyUndoToGame(game, deps);
    assert.deepEqual(point.players, ['Bob', 'Hank']);
    assert.deepEqual(point.substitutedOutPlayers, ['Alice']);

    applyUndoToGame(game, deps);
    assert.deepEqual(point.players, ['Alice', 'Bob']);
    assert.deepEqual(point.substitutedOutPlayers, []);
});

test('legacy injury sub without snapshots → event popped, roster left alone', () => {
    const { deps } = makeDeps();
    const legacy = new Other({ injury: true, description: 'Sub: Hank in for Alice' });
    const pull = new Throw({ thrower: makePlayer('X'), receiver: makePlayer('Y') });
    const point = makePoint({ possessions: [makePossession([pull, legacy])], players: ['Bob', 'Hank'] });
    point.substitutedOutPlayers = ['Alice'];
    const game = makeGame({ points: [point] });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.deepEqual(point.players, ['Bob', 'Hank']);          // unchanged
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

test('pop the only event of an OFFENSIVE point → possession removed, point KEPT (pull not yet received again)', () => {
    const alice = makePlayer('Alice');
    const pickup = { type: 'Pickup', receiver: alice, pullCatch_flag: true };
    const point = Object.assign(makePoint({ possessions: [makePossession([pickup])] }), { startingPosition: 'offense' });
    const game = makeGame({ points: [point] });
    const { deps, calls } = makeDeps({ Alice: alice });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.undoneEvent, pickup);
    assert.equal(result.pointRemoved, false);
    assert.equal(game.points.length, 1, 'the live point survives its first touch being undone');
    assert.equal(point.possessions.length, 0);
    assert.equal(calls.revertPointScore.length, 0, 'unscored — nothing to revert');
});

test('pop the only event of a scored OFFENSIVE point → score reverted, point KEPT and live', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const goal = new Throw({ thrower: alice, receiver: bob, score: true });
    const point = Object.assign(makePoint({ winner: Role.TEAM, possessions: [makePossession([goal])] }), { startingPosition: 'offense' });
    const game = makeGame({ points: [point] });
    const { deps, calls } = makeDeps({ Alice: alice, Bob: bob });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.pointRemoved, false);
    assert.equal(game.points.length, 1);
    assert.equal(point.winner, '', 'revertPointScore ran');
    assert.equal(calls.revertPointScore.length, 1);
    assert.equal(bob.goals, 1);
    assert.equal(alice.assists, 1);
});

test('pop the only event of a DEFENSIVE point → point removed, as before', () => {
    const alice = makePlayer('Alice');
    const pull = { type: 'Pull', puller: alice };
    const point = Object.assign(makePoint({ possessions: [makePossession([pull])] }), { startingPosition: 'defense' });
    const game = makeGame({ points: [point] });
    const { deps } = makeDeps({ Alice: alice });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.pointRemoved, true);
    assert.equal(game.points.length, 0);
});

// ── Branch 0: between-points events ──────────────────────────────────────

import { targetAfterEntry, undoToTarget, describeUndoTo } from '../../game/undoLogic.js';

test('between-points timeout on a scored point → the timeout is popped, the score stays', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const goal = new Throw({ thrower: alice, receiver: bob, score: true });
    const timeout = new Other({ timeout: true, calledBy: 'us', betweenPoints: true });
    const point = makePoint({ winner: Role.TEAM, possessions: [makePossession([goal, timeout])] });
    const game = makeGame({ points: [point] });
    const { deps, calls } = makeDeps({ Alice: alice, Bob: bob });

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.undoneEvent, timeout);
    assert.equal(result.pointRemoved, false);
    assert.equal(point.winner, Role.TEAM, 'the point stays scored');
    assert.equal(calls.revertPointScore.length, 0);
    assert.deepEqual(point.possessions[0].events, [goal]);
    assert.equal(bob.goals, 2, 'no stats touched');
});

test('between-points halftime hosted by its own possession ("They Score" point) → event and possession dropped, point kept', () => {
    const halftime = new Other({ halftime: true, betweenPoints: true });
    const point = makePoint({ winner: Role.OPPONENT, possessions: [makePossession([halftime])] });
    const game = makeGame({ points: [point] });
    const { deps, calls } = makeDeps();

    const result = applyUndoToGame(game, deps);

    assert.equal(result.outcome, 'event-undone');
    assert.equal(result.undoneEvent, halftime);
    assert.equal(point.possessions.length, 0);
    assert.equal(point.winner, Role.OPPONENT);
    assert.equal(game.points.length, 1);
    assert.equal(calls.revertPointScore.length, 0);
});

// ── Undo across point boundaries ─────────────────────────────────────────

function makeRealDeps(roster) {
    // revertPointScore as gameLogic.revertPointScoreData would: score, winner, live again
    return {
        getActivePossession: (point) => point.possessions[point.possessions.length - 1],
        resolvePlayer: (name) => roster[name] || null,
        revertPointScore: (point, game) => { point.winner = ''; point.startTimestamp = new Date(); },
    };
}

/** Two finished points: p1 (throw, scoring throw; ours), p2 ("They Score", no events) + a between-points timeout. */
function twoPointGame() {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const pass = new Throw({ thrower: alice, receiver: bob });
    const goal = new Throw({ thrower: bob, receiver: alice, score: true });
    const p1 = Object.assign(makePoint({ winner: Role.TEAM, possessions: [makePossession([pass, goal])], players: ['Alice', 'Bob'] }),
        { startingPosition: 'offense' });
    const timeout = new Other({ timeout: true, calledBy: 'them', betweenPoints: true });
    const p2 = Object.assign(makePoint({ winner: Role.OPPONENT, possessions: [makePossession([timeout])], players: ['Alice', 'Bob'] }),
        { startingPosition: 'defense' });
    const game = makeGame({ points: [p1, p2] });
    game.scores = { [Role.TEAM]: 1, [Role.OPPONENT]: 1 };
    return { game, p1, p2, pass, goal, timeout, alice, bob };
}

test('targetAfterEntry: the pressed line stays, the first thing after it is the target', () => {
    const { game } = twoPointGame();
    const e = (kind, pointIdx, possIdx = null, eventIdx = null) => ({ kind, pointIdx, possIdx, eventIdx });
    // Point 1: pass, scoring throw. Point 2: a between-points timeout only ("They Score").
    assert.deepEqual(targetAfterEntry(game, e('event', 0, 0, 0)), { kind: 'event', pointIdx: 0, possIdx: 0, eventIdx: 1 },
        'the pass stays; the goal after it is the target');
    assert.deepEqual(targetAfterEntry(game, e('event', 0, 0, 1)), { kind: 'point', pointIdx: 1 },
        'a scoring play keeps its score: the next point is what goes');
    assert.deepEqual(targetAfterEntry(game, e('score', 0)), { kind: 'point', pointIdx: 1 });
    assert.deepEqual(targetAfterEntry(game, e('currentscore', 0)), { kind: 'point', pointIdx: 1 });
    assert.deepEqual(targetAfterEntry(game, e('possession', 0, 0)), { kind: 'event', pointIdx: 0, possIdx: 0, eventIdx: 0 },
        'a possession delimiter keeps the possession open: its first play goes');
    assert.deepEqual(targetAfterEntry(game, e('roster', 0)), { kind: 'possession', pointIdx: 0, possIdx: 0 },
        'a roster line keeps the point started: its first possession goes');
    assert.deepEqual(targetAfterEntry(game, e('pullnote', 1)), { kind: 'possession', pointIdx: 1, possIdx: 0 });
    assert.deepEqual(targetAfterEntry(game, e('score', 1)), { kind: 'event', pointIdx: 1, possIdx: 0, eventIdx: 0 },
        'the score stays; the timeout after it goes');
    assert.equal(targetAfterEntry(game, e('after', 1, 0, 0)), null, 'the last thing recorded — nothing after it');
    assert.deepEqual(targetAfterEntry(game, e('currentscore', 1)), { kind: 'event', pointIdx: 1, possIdx: 0, eventIdx: 0 },
        'the running-score line sits before the between-points timeout in the log, so the timeout is after it');
    assert.equal(targetAfterEntry(game, e('header', null)), null);
    assert.equal(targetAfterEntry(game, e('possession', 0, null)), null, 'inline turnover delimiter with no possession yet');
    assert.equal(targetAfterEntry(game, null), null);
    assert.equal(targetAfterEntry(null, e('event', 0, 0, 0)), null);

    // A "They Score" after plays: the last play keeps, the score goes (reopen).
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const pass = new Throw({ thrower: alice, receiver: bob });
    const scoredOnUs = makeGame({ points: [makePoint({ winner: Role.OPPONENT, possessions: [makePossession([pass])] })] });
    assert.deepEqual(targetAfterEntry(scoredOnUs, e('event', 0, 0, 0)), { kind: 'score', pointIdx: 0 });
    // A started-but-empty point's roster line: nothing after it.
    const empty = makeGame({ points: [makePoint({ possessions: [] })] });
    assert.equal(targetAfterEntry(empty, e('roster', 0)), null);
});

test('undo to the scoring throw of point 1 → point 2 removed (timeout, score), point 1 reopened with its pass', () => {
    const { game, p1, pass, goal, timeout, alice, bob } = twoPointGame();
    const deps = makeRealDeps({ Alice: alice, Bob: bob });

    const r = undoToTarget(game, { kind: 'event', pointIdx: 0, possIdx: 0, eventIdx: 1 }, deps);

    assert.equal(r.done, true);
    assert.equal(r.eventsUndone, 3, 'timeout, the They Score, the scoring throw');
    assert.equal(r.pointsRemoved, 1);
    assert.equal(r.targetPointReopened, true);
    assert.deepEqual(r.removedEvents, [timeout, goal]);
    assert.equal(game.points.length, 1);
    assert.equal(game.points[0], p1);
    assert.equal(p1.winner, '');
    assert.deepEqual(p1.possessions[0].events, [pass]);
    assert.equal(alice.goals, 1, 'goal reverted');
    assert.equal(bob.assists, 1, 'assist reverted');
    assert.equal(bob.completedPasses, 2, 'the scoring throw was a completion too');
    assert.equal(alice.completedPasses, 3, 'the surviving pass keeps its completion');
});

test('undo to the point-2 roster line → only point 2 goes; point 1 untouched', () => {
    const { game, p1, p2, alice, bob } = twoPointGame();
    const deps = makeRealDeps({ Alice: alice, Bob: bob });

    const r = undoToTarget(game, { kind: 'point', pointIdx: 1 }, deps);

    assert.equal(r.done, true);
    assert.equal(r.eventsUndone, 2, 'the timeout and the They Score');
    assert.equal(r.pointsRemoved, 1);
    assert.equal(r.targetPointReopened, false);
    assert.deepEqual(game.points, [p1]);
    assert.equal(p1.winner, Role.TEAM);
    assert.equal(p2.winner, '', 'the removed point was reverted before removal');
});

test('undo to the score line of a "They Score" point with nothing recorded → timeout gone, point removed (its just-started state is no point)', () => {
    const { game, p1, p2, alice, bob } = twoPointGame();
    const deps = makeRealDeps({ Alice: alice, Bob: bob });

    const r = undoToTarget(game, { kind: 'score', pointIdx: 1 }, deps);

    assert.equal(r.done, true);
    assert.equal(r.eventsUndone, 2);
    assert.equal(r.pointsRemoved, 1, 'a scored point with no possessions is removed on revert (branch 1), as a single Undo does');
    assert.equal(r.targetPointReopened, false);
    assert.deepEqual(game.points, [p1]);
    assert.equal(p2.winner, '');
});

test('undo to the score line of a point with plays → score reverted, point live, plays kept', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const pass = new Throw({ thrower: alice, receiver: bob });
    const point = makePoint({ winner: Role.OPPONENT, possessions: [makePossession([pass])] });   // They Score after our pass
    const game = makeGame({ points: [point] });

    const r = undoToTarget(game, { kind: 'score', pointIdx: 0 }, makeRealDeps({ Alice: alice, Bob: bob }));

    assert.equal(r.done, true);
    assert.equal(r.eventsUndone, 1);
    assert.equal(r.pointsRemoved, 0);
    assert.equal(r.targetPointReopened, true);
    assert.equal(point.winner, '');
    assert.deepEqual(point.possessions[0].events, [pass]);
});

test('a started-but-empty point in the way is backed out by the loop (the double-tap, pre-confirmed)', () => {
    const { game, p1, alice, bob } = twoPointGame();
    const p3 = Object.assign(makePoint({ possessions: [], players: ['Alice'] }), { startingPosition: 'offense', startTimestamp: new Date() });
    game.points.push(p3);
    const deps = makeRealDeps({ Alice: alice, Bob: bob });

    const r = undoToTarget(game, { kind: 'point', pointIdx: 1 }, deps);

    assert.equal(r.done, true);
    assert.equal(r.pointsRemoved, 2, 'the empty point 3 and point 2');
    assert.deepEqual(game.points, [p1]);
});

test('undo inside the live point reaches the first touch of an offensive point and keeps the point', () => {
    const alice = makePlayer('Alice'), bob = makePlayer('Bob');
    const pickup = { type: 'Pickup', receiver: alice, pullCatch_flag: true };
    const pass = new Throw({ thrower: alice, receiver: bob });
    const live = Object.assign(makePoint({ possessions: [makePossession([pickup, pass])] }), { startingPosition: 'offense', startTimestamp: new Date() });
    const game = makeGame({ points: [live] });
    const deps = makeRealDeps({ Alice: alice, Bob: bob });

    const r = undoToTarget(game, { kind: 'event', pointIdx: 0, possIdx: 0, eventIdx: 0 }, deps);

    assert.equal(r.done, true);
    assert.equal(r.eventsUndone, 2);
    assert.equal(r.pointsRemoved, 0);
    assert.equal(r.targetPointReopened, false, 'it was never scored');
    assert.equal(game.points.length, 1, 'an offensive point with no first touch is its just-started state');
    assert.equal(live.possessions.length, 0);
});

test('a target that is already gone is a no-op', () => {
    const { game, alice, bob } = twoPointGame();
    const r = undoToTarget(game, { kind: 'event', pointIdx: 5, possIdx: 0, eventIdx: 0 }, makeRealDeps({ Alice: alice, Bob: bob }));
    assert.equal(r.done, true);
    assert.equal(r.steps, 0);
    assert.equal(game.points.length, 2);
});

test('describeUndoTo reports the same counts without touching the game or its players', () => {
    const { game, p1, p2, alice, bob } = twoPointGame();
    const before = JSON.stringify(game);
    const statsBefore = JSON.stringify([alice, bob]);

    const d = describeUndoTo(game, { kind: 'event', pointIdx: 0, possIdx: 0, eventIdx: 1 });

    assert.equal(d.done, true);
    assert.equal(d.eventsUndone, 3);
    assert.equal(d.pointsRemoved, 1);
    assert.equal(d.targetPointReopened, true);
    assert.equal(JSON.stringify(game), before, 'game untouched');
    assert.equal(JSON.stringify([alice, bob]), statsBefore, 'player counters untouched');
    assert.equal(game.points.length, 2);
    assert.equal(p1.winner, Role.TEAM);
    assert.equal(p2.winner, Role.OPPONENT);

    // And the real thing agrees with the description.
    const r = undoToTarget(game, { kind: 'event', pointIdx: 0, possIdx: 0, eventIdx: 1 }, makeRealDeps({ Alice: alice, Bob: bob }));
    assert.equal(r.eventsUndone, d.eventsUndone);
    assert.equal(r.pointsRemoved, d.pointsRemoved);
    assert.equal(r.targetPointReopened, d.targetPointReopened);
});
