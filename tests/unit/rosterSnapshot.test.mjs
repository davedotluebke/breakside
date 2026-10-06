/*
 * store/models.js — a game's roster snapshot and the event roster.
 *
 * createRosterSnapshot captures who was on the roster when a game started;
 * eventSnapshotPlayers is the event-game half of that (checked team players
 * with their effective position/line, then the pickups); mergeRosterSnapshot
 * grows a running game's snapshot after the event roster is edited in-game
 * (teams/eventRoster.js applyEventRosterToLiveGame) — additive, re-stamped
 * only when something was added, so the server keeps the grown snapshot
 * whoever syncs it.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    Player, Gender, PlayerPosition, DefaultLine,
    createRosterSnapshot, eventSnapshotPlayers, mergeRosterSnapshot,
} from '../../store/models.js';

function team() {
    const alice = new Player('Alice', 'Ace', Gender.FMP, '7', 'Alice-0001');
    alice.position = PlayerPosition.HANDLER;
    alice.defaultLine = DefaultLine.O;
    const bob = new Player('Bob', '', Gender.MMP, '11', 'Bob-0002');
    const dana = new Player('Dana', '', Gender.FMP, null, 'Dana-0003');
    return { teamRoster: [alice, bob, dana] };
}

function event(playerIds, extra = {}) {
    return { id: 'Ev-1', roster: { playerIds, pickupPlayers: [], overrides: {}, ...extra } };
}

test('eventSnapshotPlayers: the checked team players, then the pickups', () => {
    const players = eventSnapshotPlayers(team(), event(['Alice-0001', 'Dana-0003'], {
        pickupPlayers: [{ id: 'Zed-9999', name: 'Zed', gender: Gender.MMP, number: '99' }],
    }));
    assert.deepEqual(players.map(p => p.id), ['Alice-0001', 'Dana-0003', 'Zed-9999']);
    assert.deepEqual(players[0], {
        id: 'Alice-0001', name: 'Alice', nickname: 'Ace', number: '7', gender: Gender.FMP,
        position: PlayerPosition.HANDLER, defaultLine: DefaultLine.O,
    });
    // A pickup carries its own position/line (null here) and no nickname.
    assert.deepEqual(players[2], {
        id: 'Zed-9999', name: 'Zed', nickname: '', number: '99', gender: Gender.MMP,
        position: null, defaultLine: null,
    });
});

test('eventSnapshotPlayers: a per-event override wins over the player\'s own position/line', () => {
    const players = eventSnapshotPlayers(team(), event(['Alice-0001', 'Bob-0002'], {
        overrides: { 'Alice-0001': { position: PlayerPosition.CUTTER, defaultLine: DefaultLine.D } },
    }));
    assert.equal(players[0].position, PlayerPosition.CUTTER);
    assert.equal(players[0].defaultLine, DefaultLine.D);
    // Bob has neither: null, as createRosterSnapshot always wrote.
    assert.equal(players[1].position, null);
    assert.equal(players[1].defaultLine, null);
});

test('eventSnapshotPlayers: tolerates a bare event and a bare team', () => {
    assert.deepEqual(eventSnapshotPlayers(team(), { roster: {} }), []);
    assert.deepEqual(eventSnapshotPlayers(null, event(['Alice-0001'])), []);
});

test('createRosterSnapshot: an event game captures the event roster, unchanged', () => {
    const snap = createRosterSnapshot(team(), event(['Bob-0002']));
    assert.deepEqual(snap.players.map(p => p.name), ['Bob']);
    assert.ok(snap.capturedAt);
    // An event roster that checks nobody captures nothing (null, not {players: []}).
    assert.equal(createRosterSnapshot(team(), event([])), null);
});

test('mergeRosterSnapshot: adds the players the snapshot lacks and re-stamps it', () => {
    const game = { rosterSnapshot: createRosterSnapshot(team(), event(['Alice-0001'])) };
    game.rosterSnapshot.capturedAt = '2026-10-03T14:00:00.000Z';
    const now = new Date('2026-10-04T09:30:00.000Z');

    const players = eventSnapshotPlayers(team(), event(['Alice-0001', 'Dana-0003']));
    const added = mergeRosterSnapshot(game, players, now);

    assert.deepEqual(added.map(p => p.name), ['Dana']);
    assert.deepEqual(game.rosterSnapshot.players.map(p => p.name), ['Alice', 'Dana']);
    assert.equal(game.rosterSnapshot.capturedAt, now.toISOString());
    // The snapshot holds its own copies, not the caller's objects.
    assert.notEqual(game.rosterSnapshot.players[1], players[1]);
});

test('mergeRosterSnapshot: never removes anyone, and leaves the stamp alone when nothing changed', () => {
    const game = { rosterSnapshot: createRosterSnapshot(team(), event(['Alice-0001', 'Bob-0002'])) };
    game.rosterSnapshot.capturedAt = '2026-10-03T14:00:00.000Z';

    // Bob was unchecked mid-game: he stays listed (he may have played), and
    // with nothing to add the snapshot is untouched.
    const added = mergeRosterSnapshot(game, eventSnapshotPlayers(team(), event(['Alice-0001'])));
    assert.deepEqual(added, []);
    assert.deepEqual(game.rosterSnapshot.players.map(p => p.name), ['Alice', 'Bob']);
    assert.equal(game.rosterSnapshot.capturedAt, '2026-10-03T14:00:00.000Z');
});

test('mergeRosterSnapshot: a game with no snapshot gets one; bad input is a no-op', () => {
    const game = { rosterSnapshot: null };
    const added = mergeRosterSnapshot(game, eventSnapshotPlayers(team(), event(['Dana-0003'])));
    assert.deepEqual(added.map(p => p.name), ['Dana']);
    assert.deepEqual(game.rosterSnapshot.players.map(p => p.name), ['Dana']);
    assert.ok(game.rosterSnapshot.capturedAt);

    assert.deepEqual(mergeRosterSnapshot(game, []), []);
    assert.deepEqual(mergeRosterSnapshot(null, [{ id: 'x', name: 'x' }]), []);
    // Entries without an id, and duplicates within one call, are skipped.
    assert.deepEqual(mergeRosterSnapshot(game, [{ name: 'Nobody' }, { id: 'Eve-5', name: 'Eve' }, { id: 'Eve-5', name: 'Eve' }]).map(p => p.name), ['Eve']);
});
