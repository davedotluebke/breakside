/*
 * Unit tests pinning the sign-out backup lifecycle (auth/signOutBackup.js).
 *
 * These are data-destruction paths in both directions: too eager and a coach
 * loses a tournament that never reached the cloud, too lazy and the next coach
 * on a shared club tablet can read the previous coach's rosters out of
 * localStorage. Both directions are asserted here.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    makeSignOutBackup,
    SIGNOUT_BACKUP_KEY,
    SIGNOUT_BACKUP_MAX_AGE_MS,
} from '../../auth/signOutBackup.js';

// ── helpers ─────────────────────────────────────────────────────────────

/** Minimal Storage stand-in: string values, null for absent, nothing else. */
function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        keys: () => [...map.keys()],
        dump: () => Object.fromEntries(map),
    };
}

const DATA_KEYS = [
    'teamsData',
    'ultistats_sync_queue',
    'syncDeadLetter',
];

// A roster payload shaped like the real thing — the strings these tests hunt
// for when asserting that nothing leaked.
const ROSTER = JSON.stringify([{ name: 'Riverside', players: [{ name: 'Alice Kwan', number: 7 }] }]);
const QUEUE = JSON.stringify([{ type: 'game', id: 'g-1' }]);

function harness({ storage = fakeStorage(), nowMs = Date.parse('2026-08-24T12:00:00Z') } = {}) {
    const logs = [];
    const warns = [];
    const clock = { nowMs };
    const backup = makeSignOutBackup({
        storage,
        now: () => clock.nowMs,
        log: (...args) => logs.push(args.join(' ')),
        warn: (...args) => warns.push(args.join(' ')),
    });
    return { backup, storage, clock, logs, warns };
}

function readBackup(storage) {
    const raw = storage.getItem(SIGNOUT_BACKUP_KEY);
    return raw === null ? null : JSON.parse(raw);
}

// ── stash ───────────────────────────────────────────────────────────────

test('stash snapshots the named keys with a timestamp and an owner', () => {
    const storage = fakeStorage({ teamsData: ROSTER, ultistats_sync_queue: QUEUE });
    const { backup, clock } = harness({ storage });

    assert.equal(backup.stash(DATA_KEYS, { userId: 'user-a' }), true);

    const stored = readBackup(storage);
    assert.equal(stored.userId, 'user-a');
    assert.equal(Date.parse(stored.savedAt), clock.nowMs);
    assert.deepEqual(stored.data, { teamsData: ROSTER, ultistats_sync_queue: QUEUE });
    // Absent keys are simply not in the snapshot — no null placeholders.
    assert.equal('syncDeadLetter' in stored.data, false);
});

test('stash round-trips: the documented hand-recovery actually restores', () => {
    const storage = fakeStorage({ teamsData: ROSTER, syncDeadLetter: QUEUE });
    const { backup } = harness({ storage });

    backup.stash(DATA_KEYS, { userId: 'user-a' });
    DATA_KEYS.forEach((k) => storage.removeItem(k));
    assert.equal(storage.getItem('teamsData'), null);

    for (const [key, value] of Object.entries(readBackup(storage).data)) {
        storage.setItem(key, value);
    }
    assert.equal(storage.getItem('teamsData'), ROSTER);
    assert.equal(storage.getItem('syncDeadLetter'), QUEUE);
});

test('stash replaces the previous snapshot rather than stacking', () => {
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup } = harness({ storage });

    backup.stash(DATA_KEYS, { userId: 'user-a' });
    storage.setItem('teamsData', 'second-tournament');
    backup.stash(DATA_KEYS, { userId: 'user-b' });

    const backupKeys = storage.keys().filter((k) => k.startsWith(SIGNOUT_BACKUP_KEY));
    assert.deepEqual(backupKeys, [SIGNOUT_BACKUP_KEY]);
    const stored = readBackup(storage);
    assert.equal(stored.userId, 'user-b');
    assert.equal(stored.data.teamsData, 'second-tournament');
});

test('stash with nothing to save still clears a previous coach\'s snapshot', () => {
    // The regression this replaces: the old code returned early when it found
    // no data, leaving an earlier snapshot in place across the wipe.
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup } = harness({ storage });
    backup.stash(DATA_KEYS, { userId: 'user-a' });
    storage.removeItem('teamsData');

    assert.equal(backup.stash(DATA_KEYS, { userId: 'user-b' }), false);
    assert.equal(storage.getItem(SIGNOUT_BACKUP_KEY), null);
});

test('stash survives a storage that throws (quota) without propagating', () => {
    const storage = fakeStorage({ teamsData: ROSTER });
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    const { backup, warns } = harness({ storage });

    assert.equal(backup.stash(DATA_KEYS, { userId: 'user-a' }), false);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /Could not stash/);
});

// ── expireIfStale ───────────────────────────────────────────────────────

test('expireIfStale keeps a snapshot inside the retention window', () => {
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup, clock } = harness({ storage });
    backup.stash(DATA_KEYS, { userId: 'user-a' });

    clock.nowMs += SIGNOUT_BACKUP_MAX_AGE_MS - 1000;
    assert.equal(backup.expireIfStale(), false);
    assert.notEqual(storage.getItem(SIGNOUT_BACKUP_KEY), null);
});

test('expireIfStale drops a snapshot at or past the retention window', () => {
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup, clock } = harness({ storage });
    backup.stash(DATA_KEYS, { userId: 'user-a' });
    DATA_KEYS.forEach((k) => storage.removeItem(k));   // as clearLocalData() does

    clock.nowMs += SIGNOUT_BACKUP_MAX_AGE_MS;
    assert.equal(backup.expireIfStale(), true);
    assert.equal(storage.getItem(SIGNOUT_BACKUP_KEY), null);
    // And the roster string is gone from storage entirely.
    assert.equal(JSON.stringify(storage.dump()).includes('Alice Kwan'), false);
});

test('expireIfStale drops snapshots it cannot date or parse', () => {
    for (const raw of ['{not json', '"a string"', JSON.stringify({ data: { teamsData: ROSTER } }),
                       JSON.stringify({ savedAt: 'whenever', data: {} })]) {
        const storage = fakeStorage({ [SIGNOUT_BACKUP_KEY]: raw });
        const { backup } = harness({ storage });
        assert.equal(backup.expireIfStale(), true, `should have dropped: ${raw}`);
        assert.equal(storage.getItem(SIGNOUT_BACKUP_KEY), null);
    }
});

test('expireIfStale leaves a future-dated snapshot alone', () => {
    // Clock moved backwards; don't read that as infinitely old and delete
    // work the user may still need. reconcileSignIn still bounds it.
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup, clock } = harness({ storage });
    backup.stash(DATA_KEYS, { userId: 'user-a' });

    clock.nowMs -= 5 * SIGNOUT_BACKUP_MAX_AGE_MS;
    assert.equal(backup.expireIfStale(), false);
});

test('expireIfStale is a no-op when there is no snapshot', () => {
    const { backup, warns } = harness();
    assert.equal(backup.expireIfStale(), false);
    assert.deepEqual(warns, []);
});

// ── reconcileSignIn ─────────────────────────────────────────────────────

test('reconcileSignIn keeps the snapshot when the same coach signs back in', () => {
    // The mis-tap the backup exists for: sign out, realise, sign straight
    // back in. Deleting here would destroy the only copy of the work.
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup } = harness({ storage });
    backup.stash(DATA_KEYS, { userId: 'user-a' });

    assert.equal(backup.reconcileSignIn('user-a'), false);
    assert.equal(readBackup(storage).data.teamsData, ROSTER);
});

test('reconcileSignIn destroys the snapshot when a different coach signs in', () => {
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup } = harness({ storage });
    backup.stash(DATA_KEYS, { userId: 'user-a' });
    DATA_KEYS.forEach((k) => storage.removeItem(k));

    assert.equal(backup.reconcileSignIn('user-b'), true);
    assert.equal(storage.getItem(SIGNOUT_BACKUP_KEY), null);
    // The shared-tablet invariant: nothing of coach A's is left anywhere.
    assert.equal(JSON.stringify(storage.dump()).includes('Alice Kwan'), false);
});

test('reconcileSignIn destroys a snapshot with no recorded owner', () => {
    // Snapshots written by builds before ownership was recorded, and any
    // stash taken with no session. Unattributable → not worth keeping.
    const storage = fakeStorage({
        [SIGNOUT_BACKUP_KEY]: JSON.stringify({
            savedAt: new Date().toISOString(),
            data: { teamsData: ROSTER },
        }),
    });
    const { backup } = harness({ storage });

    assert.equal(backup.reconcileSignIn('user-a'), true);
    assert.equal(storage.getItem(SIGNOUT_BACKUP_KEY), null);
});

test('reconcileSignIn destroys the snapshot when the signing-in user is unknown', () => {
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup } = harness({ storage });
    backup.stash(DATA_KEYS, { userId: 'user-a' });

    assert.equal(backup.reconcileSignIn(null), true);
    assert.equal(storage.getItem(SIGNOUT_BACKUP_KEY), null);
});

test('reconcileSignIn is a no-op when there is no snapshot', () => {
    const { backup, storage } = harness();
    assert.equal(backup.reconcileSignIn('user-a'), false);
    assert.deepEqual(storage.keys(), []);
});

// ── discard ─────────────────────────────────────────────────────────────

test('discard reports whether it actually removed anything', () => {
    const storage = fakeStorage({ teamsData: ROSTER });
    const { backup, logs } = harness({ storage });

    assert.equal(backup.discard('no snapshot yet'), false);
    assert.deepEqual(logs, []);

    backup.stash(DATA_KEYS, { userId: 'user-a' });
    assert.equal(backup.discard('signed out with nothing pending'), true);
    assert.equal(storage.getItem(SIGNOUT_BACKUP_KEY), null);
    assert.ok(logs.some((l) => l.includes('signed out with nothing pending')));
});

test('discard never throws when storage does', () => {
    const storage = fakeStorage({ [SIGNOUT_BACKUP_KEY]: '{}' });
    storage.removeItem = () => { throw new Error('storage disabled'); };
    const { backup, warns } = harness({ storage });

    assert.equal(backup.discard('whatever'), false);
    assert.equal(warns.length, 1);
});
