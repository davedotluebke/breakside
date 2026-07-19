/*
 * Unit tests for narration/lineupResolve.js — the pure half of lineup
 * narration: mapping backend-returned names onto roster players and
 * building the applied-lineup toast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    matchRosterPlayer,
    resolveLineupPlayers,
    buildLineupToast,
} from '../../narration/lineupResolve.js';

const roster = [
    { name: 'Cyrus', nickname: '', number: '12' },
    { name: 'Everett Halberg', nickname: 'HB', number: '8' },
    { name: 'Max', nickname: null, number: '3' },
    { name: 'max miller', nickname: null, number: '31' },
];

test('matchRosterPlayer: exact name wins', () => {
    assert.equal(matchRosterPlayer('Cyrus', roster).number, '12');
});

test('matchRosterPlayer: exact match beats case-insensitive collision', () => {
    // 'Max' exactly matches the #3 player even though 'max miller' also
    // case-collides on the first pass token.
    assert.equal(matchRosterPlayer('Max', roster).number, '3');
    assert.equal(matchRosterPlayer('max miller', roster).number, '31');
});

test('matchRosterPlayer: case-insensitive name fallback', () => {
    assert.equal(matchRosterPlayer('cyrus', roster).number, '12');
    assert.equal(matchRosterPlayer('EVERETT HALBERG', roster).number, '8');
});

test('matchRosterPlayer: nickname fallback, case-insensitive', () => {
    assert.equal(matchRosterPlayer('HB', roster).name, 'Everett Halberg');
    assert.equal(matchRosterPlayer('hb', roster).name, 'Everett Halberg');
});

test('matchRosterPlayer: trims whitespace', () => {
    assert.equal(matchRosterPlayer('  Cyrus  ', roster).number, '12');
});

test('matchRosterPlayer: unknown / empty / null return null', () => {
    assert.equal(matchRosterPlayer('Zebediah', roster), null);
    assert.equal(matchRosterPlayer('', roster), null);
    assert.equal(matchRosterPlayer(null, roster), null);
    assert.equal(matchRosterPlayer('Cyrus', []), null);
});

test('resolveLineupPlayers: splits matched and unmatched, keeps order', () => {
    const { players, unmatched } = resolveLineupPlayers(
        ['Max', 'Zeb', 'Cyrus'], roster);
    assert.deepEqual(players.map(p => p.name), ['Max', 'Cyrus']);
    assert.deepEqual(unmatched, ['Zeb']);
});

test('resolveLineupPlayers: dedupes across name and nickname references', () => {
    const { players, unmatched } = resolveLineupPlayers(
        ['Everett Halberg', 'HB', 'Cyrus', 'cyrus'], roster);
    assert.deepEqual(players.map(p => p.name), ['Everett Halberg', 'Cyrus']);
    assert.deepEqual(unmatched, []);
});

test('resolveLineupPlayers: tolerates null/empty input', () => {
    assert.deepEqual(resolveLineupPlayers(null, roster),
        { players: [], unmatched: [] });
    assert.deepEqual(resolveLineupPlayers([], roster),
        { players: [], unmatched: [] });
});

test('buildLineupToast: clean full line is a success', () => {
    const { message, type } = buildLineupToast(
        { appliedCount: 7, expectedCount: 7 });
    assert.equal(type, 'success');
    assert.match(message, /7\/7/);
});

test('buildLineupToast: count mismatch is a warning', () => {
    const { message, type } = buildLineupToast(
        { appliedCount: 4, expectedCount: 7 });
    assert.equal(type, 'warning');
    assert.match(message, /4\/7/);
});

test('buildLineupToast: unmatched names are quoted and force a warning', () => {
    const { message, type } = buildLineupToast(
        { appliedCount: 7, expectedCount: 7, unmatched: ['Leif?', 'zeb'] });
    assert.equal(type, 'warning');
    assert.ok(message.includes('"Leif?", "zeb"'), message);
});

test('buildLineupToast: note is appended', () => {
    const { message } = buildLineupToast(
        { appliedCount: 6, expectedCount: 7, note: 'only six were named' });
    assert.ok(message.endsWith('— only six were named'), message);
});
