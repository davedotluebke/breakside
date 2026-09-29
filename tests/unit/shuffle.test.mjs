/*
 * Unit tests for utils/shuffle.js — the shuffle behind every random tiebreak.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shuffled } from '../../utils/shuffle.js';

function seededRandom(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

test('a permutation of the input, as a new array; the input is untouched', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffled(input, seededRandom(3));
    assert.notEqual(out, input);
    assert.deepEqual(input, ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual([...out].sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('deterministic under the same random, and different under different ones', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    assert.deepEqual(shuffled(input, seededRandom(11)), shuffled(input, seededRandom(11)));
    const distinct = new Set([1, 2, 3, 4, 5, 6].map(seed => JSON.stringify(shuffled(input, seededRandom(seed)))));
    assert.ok(distinct.size > 1);
});

test('every element lands in every position about equally often', () => {
    const n = 5, trials = 20000;
    const counts = Array.from({ length: n }, () => new Array(n).fill(0));
    const random = seededRandom(99);
    for (let t = 0; t < trials; t++) {
        shuffled([0, 1, 2, 3, 4], random).forEach((v, pos) => { counts[v][pos]++; });
    }
    const expected = trials / n;
    counts.flat().forEach(c => assert.ok(Math.abs(c - expected) < expected * 0.08, `count ${c} vs ${expected}`));
});

test('copes with empty, null and iterables', () => {
    assert.deepEqual(shuffled([]), []);
    assert.deepEqual(shuffled(null), []);
    assert.deepEqual([...shuffled(new Set([1]))], [1]);
});
