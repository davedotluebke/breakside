/*
 * Unit tests for narration/squadResolve.js — the pure half of squad
 * narration: mapping the backend's derived squads onto the scrimmage
 * picker's assignment, and the applied-squads toast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSquadResult, buildSquadToast } from '../../narration/squadResolve.js';

const roster = [
    { id: 'Alice-1', name: 'Alice', nickname: '', number: '7' },
    { id: 'Bob-2', name: 'Bob', nickname: 'Bobby', number: '11' },
    { id: 'Charlie-3', name: 'Charlie', nickname: null, number: '3' },
    { id: 'Dana-4', name: 'Dana', nickname: null, number: '22' },
    { id: 'Jamal-5', name: 'Jamal 23', nickname: null, number: '23' },
];
const names = { X: 'Orange', Y: 'Black' };

test('resolveSquadResult: replaces the assignment with the derived squads', () => {
    const assignment = new Map([['Alice-1', 'Y'], ['Charlie-3', 'X']]);
    const r = resolveSquadResult(
        { squads: { X: ['Alice', 'Bob'], Y: ['Dana'] }, out: ['Charlie'] },
        { roster, assignment });
    assert.deepEqual([...r.assignment], [['Alice-1', 'X'], ['Bob-2', 'X'], ['Dana-4', 'Y']]);
    assert.deepEqual(r.moved, { X: ['Alice', 'Bob'], Y: ['Dana'] });
    assert.deepEqual(r.removed, ['Charlie']);
    assert.deepEqual(r.unmatched, []);
    assert.deepEqual(r.counts, { X: 2, Y: 1 });
});

test('resolveSquadResult: unchanged players are not reported', () => {
    const assignment = new Map([['Alice-1', 'X'], ['Bob-2', 'Y']]);
    const r = resolveSquadResult({ squads: { X: ['Alice'], Y: ['Bob'] } }, { roster, assignment });
    assert.deepEqual(r.moved, { X: [], Y: [] });
    assert.deepEqual(r.removed, []);
});

test('resolveSquadResult: nickname and number-tolerant matching; unknowns reported', () => {
    const r = resolveSquadResult(
        { squads: { X: ['bobby', 'Jamal'], Y: ['Zeb'] }, unmatched: ['Priya'] },
        { roster, assignment: new Map() });
    assert.deepEqual([...r.assignment], [['Bob-2', 'X'], ['Jamal-5', 'X']]);
    assert.deepEqual(r.unmatched, ['Priya', 'Zeb']);
    assert.deepEqual(r.moved.X, ['Bob', 'Jamal']);
});

test('resolveSquadResult: a name on both lists lands on the first', () => {
    const r = resolveSquadResult({ squads: { X: ['Alice'], Y: ['Alice'] } }, { roster, assignment: new Map() });
    assert.deepEqual([...r.assignment], [['Alice-1', 'X']]);
});

test('resolveSquadResult: tolerates a missing squads object', () => {
    const r = resolveSquadResult({}, { roster, assignment: new Map([['Alice-1', 'X']]) });
    assert.equal(r.assignment.size, 0);
    assert.deepEqual(r.removed, ['Alice']);
});

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
