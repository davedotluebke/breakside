/*
 * Unit tests pinning the post-erasure local cleanup (store/erasureCleanup.js).
 *
 * The failure this exists to prevent: a coach erases a player, and a stale
 * queue item on their device keeps trying to re-POST that person forever. The
 * server refuses it (410), so nothing is resurrected — but the retried payload
 * carries the erased name, sitting in localStorage, which is exactly what the
 * coach asked to be rid of.
 *
 * The opposite failure is asserted too, and matters more: nothing here may
 * throw away a coach's unsynced work. A queued game is a tournament that never
 * reached the cloud.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    stripPlayerFromTeamRecord,
    stripPlayerFromEventRecord,
    purgePlayerFromQueue,
    purgeTeamFromQueue,
    dropFromEntityMap,
    purgeDeadLetter,
} from '../../store/erasureCleanup.js';

// ── fixtures ────────────────────────────────────────────────────────────

const ALICE = 'Alice-7f3a';
const BOB = 'Bob-1c2d';

/** A team shaped like the real serialized payload (store/storage.js serializeTeam). */
function team(overrides = {}) {
    return {
        id: 'Riverside-aa11',
        name: 'Riverside',
        playerIds: [ALICE, BOB],
        teamRoster: [
            { id: ALICE, name: 'Alice', number: '7' },
            { id: BOB, name: 'Bob', number: '3' },
        ],
        // lines[].players holds display strings: IDs in modern data, bare names
        // in older data. Both have to go.
        lines: [
            { name: 'O', players: [ALICE, BOB] },
            { name: 'D', players: ['Alice', 'Bob'] },
        ],
        ...overrides,
    };
}

// ── stripPlayerFromTeamRecord ───────────────────────────────────────────

test('strips the player from playerIds, roster and ID-keyed lines', () => {
    const t = team();
    assert.equal(stripPlayerFromTeamRecord(t, ALICE, 'Alice'), true);

    assert.deepEqual(t.playerIds, [BOB]);
    assert.deepEqual(t.teamRoster.map(p => p.id), [BOB]);
    assert.deepEqual(t.lines[0].players, [BOB]);
});

test('strips name-keyed line entries only when the name is supplied', () => {
    const withName = team();
    stripPlayerFromTeamRecord(withName, ALICE, 'Alice');
    assert.deepEqual(withName.lines[1].players, ['Bob']);

    // No name given: the ID-keyed line is cleaned, the legacy name-keyed one is
    // left alone rather than guessed at.
    const withoutName = team();
    stripPlayerFromTeamRecord(withoutName, ALICE);
    assert.deepEqual(withoutName.lines[0].players, [BOB]);
    assert.deepEqual(withoutName.lines[1].players, ['Alice', 'Bob']);
});

test('leaves a team that never had the player untouched, and reports no change', () => {
    const t = team({ playerIds: [BOB], teamRoster: [{ id: BOB, name: 'Bob' }], lines: [] });
    assert.equal(stripPlayerFromTeamRecord(t, ALICE, 'Alice'), false);
    assert.deepEqual(t.playerIds, [BOB]);
});

test('survives malformed teams instead of throwing mid-cleanup', () => {
    assert.equal(stripPlayerFromTeamRecord(null, ALICE), false);
    assert.equal(stripPlayerFromTeamRecord({}, ALICE), false);
    assert.equal(stripPlayerFromTeamRecord({ playerIds: null, lines: [null] }, ALICE), false);
    assert.equal(stripPlayerFromTeamRecord(team(), ''), false);
});

// ── stripPlayerFromEventRecord ──────────────────────────────────────────

test('strips the player from an event roster and its per-event overrides', () => {
    const event = {
        id: 'Regionals-99',
        teamId: 'Riverside-aa11',
        playerIds: [ALICE, BOB],
        playerOverrides: { [ALICE]: { position: 'handler' }, [BOB]: { position: 'cutter' } },
    };
    assert.equal(stripPlayerFromEventRecord(event, ALICE), true);
    assert.deepEqual(event.playerIds, [BOB]);
    assert.deepEqual(Object.keys(event.playerOverrides), [BOB]);
});

// ── purgePlayerFromQueue ────────────────────────────────────────────────

test('drops the erased player own queued write — the re-POST that would 410', () => {
    const queue = [
        { type: 'player', action: 'update', id: ALICE, data: { name: 'Alice' } },
        { type: 'player', action: 'update', id: BOB, data: { name: 'Bob' } },
    ];
    const result = purgePlayerFromQueue(queue, ALICE, 'Alice');

    assert.equal(result.dropped, 1);
    assert.deepEqual(result.queue.map(i => i.id), [BOB]);
});

test('scrubs the player out of queued team and event payloads without dropping them', () => {
    const queue = [
        { type: 'team', action: 'update', id: 'Riverside-aa11', data: team() },
        { type: 'event', action: 'update', id: 'Regionals-99', data: { playerIds: [ALICE, BOB] } },
    ];
    const result = purgePlayerFromQueue(queue, ALICE, 'Alice');

    // Both survive — the rest of each update is legitimate work.
    assert.equal(result.queue.length, 2);
    assert.equal(result.dropped, 0);
    assert.equal(result.scrubbed, 2);
    assert.deepEqual(result.queue[0].data.playerIds, [BOB]);
    assert.deepEqual(result.queue[1].data.playerIds, [BOB]);
    // And the name is genuinely gone from the payload that stays on the device.
    assert.equal(JSON.stringify(result.queue).includes('Alice'), false);
});

test('never drops a queued game — unsynced work outranks a local tidy-up', () => {
    const queue = [
        { type: 'game', action: 'update', id: 'g-1', data: { teamId: 'Riverside-aa11' } },
        { type: 'player', action: 'update', id: ALICE, data: {} },
    ];
    const result = purgePlayerFromQueue(queue, ALICE, 'Alice');

    assert.deepEqual(result.queue.map(i => i.type), ['game']);
    // Reported, so the receipt can say the server will scrub them on arrival.
    assert.equal(result.queuedGames, 1);
});

test('an empty or absent queue is not an error', () => {
    assert.deepEqual(purgePlayerFromQueue([], ALICE).queue, []);
    assert.deepEqual(purgePlayerFromQueue(undefined, ALICE).queue, []);
    assert.equal(purgePlayerFromQueue(null, ALICE).dropped, 0);
});

// ── purgeTeamFromQueue ──────────────────────────────────────────────────

test('drops the team, its listed games, and its events', () => {
    const queue = [
        { type: 'team', action: 'update', id: 'Riverside-aa11', data: {} },
        { type: 'game', action: 'update', id: 'g-1', data: {} },
        { type: 'event', action: 'update', id: 'e-1', data: { teamId: 'Riverside-aa11' } },
        { type: 'team', action: 'update', id: 'Other-bb22', data: {} },
        { type: 'game', action: 'update', id: 'g-9', data: { teamId: 'Other-bb22' } },
    ];
    const result = purgeTeamFromQueue(queue, 'Riverside-aa11', ['g-1']);

    assert.equal(result.dropped, 3);
    assert.deepEqual(result.queue.map(i => i.id), ['Other-bb22', 'g-9']);
});

test('catches a game the caller could not name, via its payload teamId', () => {
    const queue = [
        { type: 'game', action: 'update', id: 'g-unlisted', data: { teamId: 'Riverside-aa11' } },
    ];
    // gameIds is empty — this device queued a game the caller never listed.
    const result = purgeTeamFromQueue(queue, 'Riverside-aa11', []);
    assert.equal(result.dropped, 1);
    assert.deepEqual(result.queue, []);
});

test('leaves another team entirely alone', () => {
    const queue = [
        { type: 'team', action: 'update', id: 'Other-bb22', data: {} },
        { type: 'game', action: 'update', id: 'g-9', data: { teamId: 'Other-bb22' } },
        { type: 'player', action: 'update', id: ALICE, data: {} },
    ];
    const result = purgeTeamFromQueue(queue, 'Riverside-aa11', []);
    assert.equal(result.dropped, 0);
    assert.equal(result.queue.length, 3);
});

// ── dropFromEntityMap ───────────────────────────────────────────────────

test('drops matching entries from an offline entity cache', () => {
    const localGames = {
        'g-1': { teamId: 'Riverside-aa11' },
        'g-2': { teamId: 'Other-bb22' },
    };
    const removed = dropFromEntityMap(
        localGames, (id, g) => g.teamId === 'Riverside-aa11');

    assert.equal(removed, 1);
    assert.deepEqual(Object.keys(localGames), ['g-2']);
});

test('a missing entity map is not an error', () => {
    assert.equal(dropFromEntityMap(null, () => true), 0);
    assert.equal(dropFromEntityMap(undefined, () => true), 0);
});

// ── purgeDeadLetter ─────────────────────────────────────────────────────

test('drops quarantined payloads for the erased player', () => {
    const entries = [
        { type: 'player', id: ALICE, data: { name: 'Alice' } },
        { type: 'player', id: BOB, data: { name: 'Bob' } },
    ];
    const result = purgeDeadLetter(entries, { playerId: ALICE });

    assert.equal(result.dropped, 1);
    assert.equal(JSON.stringify(result.entries).includes('Alice'), false);
});

test('drops quarantined payloads for the erased team, its games and its events', () => {
    const entries = [
        { type: 'team', id: 'Riverside-aa11', data: {} },
        { type: 'event', id: 'e-1', data: { teamId: 'Riverside-aa11' } },
        { type: 'game', id: 'g-1', data: {} },
        { type: 'team', id: 'Other-bb22', data: {} },
    ];
    const result = purgeDeadLetter(entries, { teamId: 'Riverside-aa11', gameIds: ['g-1'] });

    assert.equal(result.dropped, 3);
    assert.deepEqual(result.entries.map(e => e.id), ['Other-bb22']);
});

test('an empty dead-letter list is not an error', () => {
    assert.deepEqual(purgeDeadLetter([], { playerId: ALICE }).entries, []);
    assert.equal(purgeDeadLetter(undefined, {}).dropped, 0);
    assert.equal(purgeDeadLetter([{ type: 'player', id: ALICE }], {}).dropped, 0);
});
