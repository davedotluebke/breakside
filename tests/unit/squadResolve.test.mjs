/*
 * Unit tests for narration/squadResolve.js — the pure half of squad
 * narration: turning the backend's answer into the scrimmage picker's next
 * state (assignment, who is not here, who the coach placed), picking the
 * players for a narrated count, and the applied-squads toast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSquadResult, buildSquadToast } from '../../narration/squadResolve.js';

const F = 'FMP', M = 'MMP';
const roster = [
    { id: 'Alice-1', name: 'Alice', nickname: '', number: '7', gender: F },
    { id: 'Bob-2', name: 'Bob', nickname: 'Bobby', number: '11', gender: M },
    { id: 'Charlie-3', name: 'Charlie', nickname: null, number: '3', gender: M },
    { id: 'Dana-4', name: 'Dana', nickname: null, number: '22', gender: F },
    { id: 'Eve-5', name: 'Eve', nickname: null, number: '9', gender: F },
    { id: 'Hank-6', name: 'Hank', nickname: null, number: '5', gender: M },
    { id: 'Iris-7', name: 'Iris', nickname: null, number: '14', gender: F },
    { id: 'Jamal-8', name: 'Jamal 23', nickname: null, number: '23', gender: M },
];
const names = { X: 'Orange', Y: 'Black' };
const ctx = (assignment = [], extra = {}) => ({
    roster, assignment: new Map(assignment), absent: new Set(), pinned: new Set(), ...extra,
});
// A fixed "random" keeps the tie-break order of a fill deterministic.
const fixed = { random: () => 0.5 };

test('resolveSquadResult: replaces the assignment with the derived squads', () => {
    const r = resolveSquadResult(
        { squads: { X: ['Alice', 'Bob'], Y: ['Dana'] }, out: ['Charlie'] },
        ctx([['Alice-1', 'Y'], ['Charlie-3', 'X']]));
    assert.deepEqual([...r.assignment], [['Alice-1', 'X'], ['Bob-2', 'X'], ['Dana-4', 'Y']]);
    assert.deepEqual(r.moved, { X: ['Alice', 'Bob'], Y: ['Dana'] });
    assert.deepEqual(r.removed, ['Charlie']);
    assert.deepEqual(r.unmatched, []);
    assert.deepEqual(r.counts, { X: 2, Y: 1 });
    assert.deepEqual(r.shortfalls, []);
});

test('resolveSquadResult: unchanged players are not reported', () => {
    const r = resolveSquadResult({ squads: { X: ['Alice'], Y: ['Bob'] } }, ctx([['Alice-1', 'X'], ['Bob-2', 'Y']]));
    assert.deepEqual(r.moved, { X: [], Y: [] });
    assert.deepEqual(r.removed, []);
});

test('resolveSquadResult: nickname and number-tolerant matching; unknowns reported', () => {
    const r = resolveSquadResult(
        { squads: { X: ['bobby', 'Jamal'], Y: ['Zeb'] }, unmatched: ['Priya'] }, ctx());
    assert.deepEqual([...r.assignment], [['Bob-2', 'X'], ['Jamal-8', 'X']]);
    assert.deepEqual(r.unmatched, ['Priya', 'Zeb']);
    assert.deepEqual(r.moved.X, ['Bob', 'Jamal']);
});

test('resolveSquadResult: a name on both lists lands on the first', () => {
    const r = resolveSquadResult({ squads: { X: ['Alice'], Y: ['Alice'] } }, ctx());
    assert.deepEqual([...r.assignment], [['Alice-1', 'X']]);
});

test('resolveSquadResult: tolerates a missing squads object', () => {
    const r = resolveSquadResult({}, ctx([['Alice-1', 'X']]));
    assert.equal(r.assignment.size, 0);
    assert.deepEqual(r.removed, ['Alice']);
});

// ── who is not here ─────────────────────────────────────────────────────

test('a narrated sit-out marks the player not here; a placed player is here', () => {
    const r = resolveSquadResult(
        { squads: { X: ['Alice'], Y: ['Iris'] }, out: ['Eve'] },
        ctx([['Eve-5', 'X']], { absent: new Set(['Iris-7', 'Hank-6']) }));
    assert.deepEqual([...r.absent].sort(), ['Eve-5', 'Hank-6']);   // Eve out, Hank still out, Iris back
    assert.deepEqual(r.removed, ['Eve']);
});

test('a sit-out of a player on neither squad is still reported', () => {
    const r = resolveSquadResult({ squads: { X: ['Alice'], Y: [] }, out: ['Hank'] }, ctx([['Alice-1', 'X']]));
    assert.deepEqual(r.removed, ['Hank']);
    assert.ok(r.absent.has('Hank-6'));
    // …but not twice, when they were already marked out.
    const again = resolveSquadResult({ squads: { X: ['Alice'], Y: [] }, out: ['Hank'] },
        ctx([['Alice-1', 'X']], { absent: new Set(['Hank-6']) }));
    assert.deepEqual(again.removed, []);
});

test('an out the server did not take off a squad does not make them absent', () => {
    const r = resolveSquadResult({ squads: { X: ['Eve'], Y: [] }, out: ['Eve'] }, ctx());
    assert.equal(r.absent.has('Eve-5'), false);
});

// ── who the coach placed ────────────────────────────────────────────────

test('named players are pinned; earlier pins survive while still on a squad', () => {
    const r = resolveSquadResult(
        { squads: { X: ['Alice', 'Bob'], Y: ['Dana'] }, voiced_assign: [{ name: 'Dana', squad: 'Y' }] },
        ctx([['Alice-1', 'X'], ['Charlie-3', 'X']], { pinned: new Set(['Alice-1', 'Charlie-3']) }));
    assert.deepEqual([...r.pinned].sort(), ['Alice-1', 'Dana-4']);   // Charlie left the squads
});

test('a voiced clear un-pins everyone before the new names are pinned', () => {
    const r = resolveSquadResult(
        { squads: { X: ['Bob'], Y: [] }, voiced_clear: true, voiced_assign: [{ name: 'Bob', squad: 'X' }] },
        ctx([['Alice-1', 'X']], { pinned: new Set(['Alice-1']) }));
    assert.deepEqual([...r.pinned], ['Bob-2']);
});

// ── narrated counts ─────────────────────────────────────────────────────

test('a fill picks from players sitting out, of the group, and pins them', () => {
    const r = resolveSquadResult(
        { squads: { X: ['Alice'], Y: ['Bob'] }, fills: [{ squad: 'X', group: 'FMP', count: 2 }] },
        ctx([['Alice-1', 'X'], ['Bob-2', 'Y']]), fixed);
    const onX = [...r.assignment].filter(([, s]) => s === 'X').map(([id]) => id);
    assert.equal(onX.length, 3);
    const picked = onX.filter(id => id !== 'Alice-1');
    picked.forEach(id => {
        assert.equal(roster.find(p => p.id === id).gender, F);
        assert.ok(r.pinned.has(id));
    });
    assert.deepEqual(r.shortfalls, []);
    assert.equal(r.moved.X.length, 2);
});

test('a fill never takes an absent player or one the coach placed', () => {
    const r = resolveSquadResult(
        { squads: { X: [], Y: ['Dana'] }, fills: [{ squad: 'X', group: 'FMP', count: 4 }] },
        ctx([['Dana-4', 'Y']], { absent: new Set(['Iris-7']), pinned: new Set(['Dana-4']) }), fixed);
    const onX = [...r.assignment].filter(([, s]) => s === 'X').map(([id]) => id).sort();
    assert.deepEqual(onX, ['Alice-1', 'Eve-5']);          // Iris is out, Dana was placed by the coach
    assert.equal(r.assignment.get('Dana-4'), 'Y');
    assert.deepEqual(r.shortfalls, [{ squad: 'X', group: 'FMP', wanted: 4, got: 2 }]);
});

test('with nobody sitting out, a fill moves auto-dealt players off the other squad', () => {
    const dealt = [['Alice-1', 'X'], ['Dana-4', 'Y'], ['Eve-5', 'Y'], ['Iris-7', 'Y'], ['Bob-2', 'X'],
        ['Charlie-3', 'Y'], ['Hank-6', 'X'], ['Jamal-8', 'Y']];
    const r = resolveSquadResult(
        { squads: { X: ['Alice', 'Bob', 'Hank'], Y: ['Dana', 'Eve', 'Iris', 'Charlie', 'Jamal 23'] },
          fills: [{ squad: 'X', group: 'FMP', count: 2 }] },
        ctx(dealt), fixed);
    const fOnX = [...r.assignment].filter(([id, s]) => s === 'X' && roster.find(p => p.id === id).gender === F);
    assert.equal(fOnX.length, 3);
    assert.equal(r.counts.X, 5);
    assert.equal(r.counts.Y, 3);
});

test('an ANY fill takes either gender, balancing the squad', () => {
    const r = resolveSquadResult(
        { squads: { X: ['Alice', 'Dana'], Y: [] }, fills: [{ squad: 'X', group: 'ANY', count: 2 }] },
        ctx([['Alice-1', 'X'], ['Dana-4', 'X']]), fixed);
    const picked = [...r.assignment].filter(([id, s]) => s === 'X' && !['Alice-1', 'Dana-4'].includes(id));
    assert.equal(picked.length, 2);
    // The squad already leads the other in FMPs by two, so the picks are MMPs.
    picked.forEach(([id]) => assert.equal(roster.find(p => p.id === id).gender, M));
});

test('fills apply in order, each seeing the last one\'s picks', () => {
    const r = resolveSquadResult(
        { squads: { X: [], Y: [] }, fills: [
            { squad: 'X', group: 'MMP', count: 2 }, { squad: 'Y', group: 'MMP', count: 3 }] },
        ctx(), fixed);
    assert.deepEqual(r.counts, { X: 2, Y: 2 });   // four MMPs in all; the second fill is one short
    assert.deepEqual(r.shortfalls, [{ squad: 'Y', group: 'MMP', wanted: 3, got: 2 }]);
});

test('malformed fills are ignored', () => {
    const r = resolveSquadResult(
        { squads: { X: [], Y: [] }, fills: [null, { squad: 'Z', group: 'FMP', count: 2 }, { squad: 'X', group: 'FMP', count: 0 }] },
        ctx(), fixed);
    assert.equal(r.assignment.size, 0);
});

// ── the toast ───────────────────────────────────────────────────────────

test('buildSquadToast: counts, moves, outs, no-match', () => {
    assert.deepEqual(
        buildSquadToast({ names, counts: { X: 5, Y: 4 }, moved: { X: ['Alice', 'Bob'], Y: ['Dana'] } }),
        { message: 'Orange 5 · Black 4. To Orange: Alice, Bob. To Black: Dana', type: 'success' });
    assert.deepEqual(
        buildSquadToast({ names, counts: { X: 4, Y: 4 }, removed: ['Eve'] }),
        { message: 'Orange 4 · Black 4. Out: Eve', type: 'success' });
    assert.deepEqual(
        buildSquadToast({ names, counts: { X: 5, Y: 3 }, moved: { X: ['Alice'] }, unmatched: ['Zeb'] }),
        { message: 'Orange 5 · Black 3. To Orange: Alice. No match: "Zeb"', type: 'warning' });
});

test('buildSquadToast: long lists collapse to a count', () => {
    const { message } = buildSquadToast({
        names, counts: { X: 7, Y: 0 }, moved: { X: ['A', 'B', 'C', 'D', 'E'] } });
    assert.equal(message, 'Orange 7 · Black 0. To Orange: 5 players');
});

test('buildSquadToast: a count that could not be filled is a warning', () => {
    assert.deepEqual(
        buildSquadToast({ names, counts: { X: 5, Y: 3 }, moved: { X: ['Mia'] },
            shortfalls: [{ squad: 'X', group: 'FMP', wanted: 2, got: 1 }] }),
        { message: 'Orange 5 · Black 3. To Orange: Mia. Only 1 of 2 FMPs free for Orange', type: 'warning' });
    assert.equal(
        buildSquadToast({ names, counts: { X: 5, Y: 3 },
            shortfalls: [{ squad: 'Y', group: 'ANY', wanted: 2, got: 0 }] }).message,
        'Orange 5 · Black 3. No players free for Black');
});
