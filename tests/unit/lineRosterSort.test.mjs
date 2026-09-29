/*
 * Unit tests for the Line-tab roster sort (utils/lineRosterSort.js): the
 * three-tap cycle per icon and the name/time orderings.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ROSTER_SORT, nextRosterSort, sortLineRoster } from '../../utils/lineRosterSort.js';

const roster = [
    { name: 'Mika', t: 300 },
    { name: 'alex', t: 120 },
    { name: 'Jo', t: 300 },
    { name: 'Bea', t: 0 },
];
const fns = {
    // Stand-in for the table's "played last point first" order: input order.
    defaultCompare: () => 0,
    timeOf: p => p.t,
};
const names = list => list.map(p => p.name);

test('nextRosterSort: asc → desc → default for the same icon', () => {
    let s = DEFAULT_ROSTER_SORT;
    s = nextRosterSort(s, 'name');
    assert.deepEqual(s, { key: 'name', dir: 'asc' });
    s = nextRosterSort(s, 'name');
    assert.deepEqual(s, { key: 'name', dir: 'desc' });
    s = nextRosterSort(s, 'name');
    assert.equal(s.key, null);
});

test('nextRosterSort: switching icons starts the new key at asc', () => {
    const s = nextRosterSort({ key: 'name', dir: 'desc' }, 'time');
    assert.deepEqual(s, { key: 'time', dir: 'asc' });
});

test('sortLineRoster: default state keeps the default comparator order', () => {
    assert.deepEqual(names(sortLineRoster(roster, DEFAULT_ROSTER_SORT, fns)), ['Mika', 'alex', 'Jo', 'Bea']);
});

test('sortLineRoster: name asc/desc, case-insensitive', () => {
    assert.deepEqual(names(sortLineRoster(roster, { key: 'name', dir: 'asc' }, fns)), ['alex', 'Bea', 'Jo', 'Mika']);
    assert.deepEqual(names(sortLineRoster(roster, { key: 'name', dir: 'desc' }, fns)), ['Mika', 'Jo', 'Bea', 'alex']);
});

test('sortLineRoster: time asc/desc, ties by name ascending', () => {
    assert.deepEqual(names(sortLineRoster(roster, { key: 'time', dir: 'asc' }, fns)), ['Bea', 'alex', 'Jo', 'Mika']);
    assert.deepEqual(names(sortLineRoster(roster, { key: 'time', dir: 'desc' }, fns)), ['Jo', 'Mika', 'alex', 'Bea']);
});

test('sortLineRoster: does not mutate the input', () => {
    const copy = [...roster];
    sortLineRoster(roster, { key: 'name', dir: 'asc' }, fns);
    assert.deepEqual(roster, copy);
});
