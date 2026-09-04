/*
 * Unit tests for the ultistats_ -> breakside_ localStorage key rename
 * (store/storageKeyMigration.js).
 *
 * This is a data-destruction path: it deletes the original after copying it,
 * and the sync queue it moves holds writes that exist nowhere else. Every
 * branch that could drop a value is pinned here.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateStorageKeys } from '../../store/storageKeyMigration.js';

/** Minimal Storage stand-in: string values, null for absent, nothing else. */
function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        dump: () => Object.fromEntries(map),
    };
}

const QUEUE = JSON.stringify([{ type: 'game', id: 'g1' }]);

test('moves a legacy key onto the new name and drops the original', () => {
    const s = fakeStorage({ ultistats_sync_queue: QUEUE });
    const moved = migrateStorageKeys(s);

    assert.deepEqual(moved, ['breakside_sync_queue']);
    assert.deepEqual(s.dump(), { breakside_sync_queue: QUEUE });
});

test('migrates every key independently', () => {
    const s = fakeStorage({
        ultistats_sync_queue: QUEUE,
        ultistats_local_players: '{"p1":{}}',
        ultistats_local_teams: '{"t1":{}}',
        ultistats_local_games: '{"g1":{}}',
        ultistats_api_url: 'http://localhost:8000',
    });
    const moved = migrateStorageKeys(s);

    assert.equal(moved.length, 5);
    assert.equal(Object.keys(s.dump()).filter((k) => k.startsWith('ultistats_')).length, 0);
    assert.equal(s.getItem('breakside_api_url'), 'http://localhost:8000');
});

test('is idempotent — a second run is a no-op', () => {
    const s = fakeStorage({ ultistats_sync_queue: QUEUE });
    migrateStorageKeys(s);
    const before = s.dump();

    assert.deepEqual(migrateStorageKeys(s), []);
    assert.deepEqual(s.dump(), before);
});

test('never overwrites current data with a stale legacy copy', () => {
    // Both names present: the new one is live, the old one is left over. The
    // live value must survive, and the legacy value must not be silently
    // deleted — it is evidence that something still writes the old name.
    const s = fakeStorage({
        breakside_sync_queue: QUEUE,
        ultistats_sync_queue: JSON.stringify([{ type: 'game', id: 'STALE' }]),
    });

    assert.deepEqual(migrateStorageKeys(s), []);
    assert.equal(s.getItem('breakside_sync_queue'), QUEUE);
    assert.ok(s.getItem('ultistats_sync_queue') !== null);
});

test('keeps the original when the copy does not verify', () => {
    // Simulates a browser that accepts setItem but does not persist it —
    // deleting the source here would destroy the only copy.
    const s = fakeStorage({ ultistats_sync_queue: QUEUE });
    s.setItem = () => {};

    assert.deepEqual(migrateStorageKeys(s), []);
    assert.equal(s.getItem('ultistats_sync_queue'), QUEUE);
});

test('one failing key does not stop the others', () => {
    const s = fakeStorage({
        ultistats_sync_queue: QUEUE,
        ultistats_local_games: '{"g1":{}}',
    });
    const realSet = s.setItem;
    s.setItem = (k, v) => {
        if (k === 'breakside_sync_queue') throw new DOMException('QuotaExceededError');
        realSet(k, v);
    };

    assert.deepEqual(migrateStorageKeys(s), ['breakside_local_games']);
    assert.equal(s.getItem('ultistats_sync_queue'), QUEUE, 'unmigrated key must survive');
    assert.equal(s.getItem('breakside_local_games'), '{"g1":{}}');
});

test('does nothing when there is nothing to migrate', () => {
    const s = fakeStorage({ teamsData: '{}' });
    assert.deepEqual(migrateStorageKeys(s), []);
    assert.deepEqual(s.dump(), { teamsData: '{}' });
});
