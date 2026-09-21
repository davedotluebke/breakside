/*
 * Unit tests for the state helpers in ui/summarySections.js — the per-device
 * memory behind the collapsible Review-screen sections.
 *
 * The contract under test:
 *  - with nothing saved, stats and log are open and Game Flow is collapsed
 *  - a saved choice overrides its default; unknown keys and non-booleans are
 *    ignored; junk JSON reads as the defaults
 *  - saving one section keeps the others' saved states and round-trips
 *  - a storage that throws never breaks the caller
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    readSectionStates, saveSectionState, STORAGE_KEY, DEFAULT_OPEN,
} from '../../ui/summarySections.js';

function fakeStorage(initial = {}) {
    const data = { ...initial };
    return {
        getItem: k => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: k => { delete data[k]; },
        dump: () => data,
    };
}

test('defaults: stats and log open, Game Flow collapsed', () => {
    assert.deepEqual(DEFAULT_OPEN, { stats: true, flow: false, log: true });
    assert.deepEqual(readSectionStates(fakeStorage()), { stats: true, flow: false, log: true });
    assert.deepEqual(readSectionStates(null), { stats: true, flow: false, log: true });
});

test('a saved choice overrides its default; the rest stay default', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ flow: true }) });
    assert.deepEqual(readSectionStates(storage), { stats: true, flow: true, log: true });
});

test('unknown keys and non-boolean values are ignored', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ flow: 'yes', bogus: false, stats: false }) });
    assert.deepEqual(readSectionStates(storage), { stats: false, flow: false, log: true });
});

test('junk JSON reads as the defaults', () => {
    assert.deepEqual(readSectionStates(fakeStorage({ [STORAGE_KEY]: '{not json' })), DEFAULT_OPEN);
    assert.deepEqual(readSectionStates(fakeStorage({ [STORAGE_KEY]: '[1,2]' })), DEFAULT_OPEN);
    assert.deepEqual(readSectionStates(fakeStorage({ [STORAGE_KEY]: 'null' })), DEFAULT_OPEN);
});

test('saving one section keeps the others and round-trips', () => {
    const storage = fakeStorage();
    assert.deepEqual(saveSectionState(storage, 'flow', true), { stats: true, flow: true, log: true });
    assert.deepEqual(saveSectionState(storage, 'log', false), { stats: true, flow: true, log: false });
    assert.deepEqual(JSON.parse(storage.dump()[STORAGE_KEY]), { stats: true, flow: true, log: false });
    assert.deepEqual(readSectionStates(storage), { stats: true, flow: true, log: false });
    assert.equal(saveSectionState(storage, 'stats', 0).stats, false);   // coerced to boolean
});

test('a throwing storage never breaks the caller', () => {
    const broken = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
    assert.deepEqual(readSectionStates(broken), DEFAULT_OPEN);
    assert.deepEqual(saveSectionState(broken, 'flow', true), { stats: true, flow: true, log: true });
});
