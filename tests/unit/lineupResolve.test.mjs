/*
 * Unit tests for narration/lineupResolve.js — the pure half of lineup
 * narration: mapping backend-returned names onto roster players and
 * building the applied-lineup toast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeName,
    matchRosterPlayer,
    resolveLineupPlayers,
    displayFirstName,
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

test('buildLineupToast: clean full line is a short success', () => {
    const { message, type } = buildLineupToast(
        { selectedCount: 7, expectedCount: 7, added: ['Cyrus', 'Max'] });
    assert.equal(type, 'success');
    assert.equal(message, '7/7 selected. Added: Cyrus, Max');
});

test('buildLineupToast: partial add warns with count and delta', () => {
    const { message, type } = buildLineupToast(
        { selectedCount: 5, expectedCount: 7, added: ['Priya'] });
    assert.equal(type, 'warning');
    assert.equal(message, '5/7 selected. Added: Priya');
});

test('buildLineupToast: substitution shows Off list', () => {
    const { message, type } = buildLineupToast(
        { selectedCount: 7, expectedCount: 7, added: ['Cyrus'], removed: ['Nate'] });
    assert.equal(type, 'success');
    assert.equal(message, '7/7 selected. Added: Cyrus. Off: Nate');
});

test('buildLineupToast: unmatched forces warning, quoted, capped at three', () => {
    const { message, type } = buildLineupToast(
        { selectedCount: 7, expectedCount: 7, unmatched: ['a', 'b', 'c', 'd'] });
    assert.equal(type, 'warning');
    assert.ok(message.includes('No match: "a", "b", "c", …'), message);
});

test('buildLineupToast: no delta parts when nothing changed', () => {
    const { message } = buildLineupToast({ selectedCount: 7, expectedCount: 7 });
    assert.equal(message, '7/7 selected');
});

test('normalizeName strips digits and decoration', () => {
    assert.equal(normalizeName('Jamal 23'), 'jamal');
    assert.equal(normalizeName('23 Jamal'), 'jamal');
    assert.equal(normalizeName('Jamal #23'), 'jamal');
    assert.equal(normalizeName('Everett Halberg'), 'everett halberg');
});

test('matchRosterPlayer: model-cleaned name matches number-embedded roster name', () => {
    const r = [{ name: 'Jamal 23' }, { name: 'Keisha 7' }];
    assert.equal(matchRosterPlayer('Jamal', r).name, 'Jamal 23');
    assert.equal(matchRosterPlayer('keisha', r).name, 'Keisha 7');
});

test('matchRosterPlayer: leading and hash number formats match too', () => {
    assert.equal(matchRosterPlayer('Jamal', [{ name: '23 Jamal' }]).name, '23 Jamal');
    assert.equal(matchRosterPlayer('Jamal', [{ name: 'Jamal #23' }]).name, 'Jamal #23');
});

test('matchRosterPlayer: decorated returned name matches clean roster name', () => {
    assert.equal(matchRosterPlayer('Jamal 23', [{ name: 'Jamal' }]).name, 'Jamal');
});

test('matchRosterPlayer: nickname-decorated model output still matches', () => {
    // Haiku occasionally emits the full roster line decoration
    const r = [{ name: 'Everett Halberg', nickname: 'HB' }];
    assert.equal(matchRosterPlayer('Everett Halberg "HB"', r).name, 'Everett Halberg');
    assert.equal(matchRosterPlayer('Everett Halberg "HB" #8', r).name, 'Everett Halberg');
});

test('matchRosterPlayer: ambiguous normalized names do not match', () => {
    const r = [{ name: 'Jamal 23' }, { name: 'Jamal 40' }];
    assert.equal(matchRosterPlayer('Jamal', r), null);
    // exact spelling still resolves
    assert.equal(matchRosterPlayer('Jamal 40', r).name, 'Jamal 40');
});

test('displayFirstName picks the first non-decoration token', () => {
    assert.equal(displayFirstName('Jamal 23'), 'Jamal');
    assert.equal(displayFirstName('23 Jamal'), 'Jamal');
    assert.equal(displayFirstName('Everett Halberg'), 'Everett');
    assert.equal(displayFirstName('42'), '42');
});
