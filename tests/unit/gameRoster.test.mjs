/*
 * utils/gameRoster.js — who a game lists (Review and its export), and what
 * to tell a coach when the event roster changes under a running game.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    summaryRosterPlayers, eventRosterDiffers, describeEventRosterChange,
} from '../../utils/gameRoster.js';

const TEAM = [
    { id: 'Alice-0001', name: 'Alice', gender: 'FMP' },
    { id: 'Bob-0002', name: 'Bob', gender: 'MMP' },
    { id: 'Dana-0003', name: 'Dana', gender: 'FMP' },
];
const snap = (...names) => ({
    players: names.map(n => ({ id: `${n}-000${TEAM.findIndex(p => p.name === n) + 1}`, name: n })),
    capturedAt: '2026-10-04T14:47:00.000Z',
});

test('summaryRosterPlayers: the snapshot, then anyone with stats the snapshot lacks', () => {
    // The Day 2 game that captured the Day 1 roster: Dana played but was
    // never in the snapshot.
    const game = { rosterSnapshot: snap('Alice', 'Bob') };
    const stats = { 'Alice-0001': { name: 'Alice', goals: 1 }, 'Dana-0003': { name: 'Dana', goals: 2 } };
    const players = summaryRosterPlayers(game, stats, TEAM);
    assert.deepEqual(players.map(p => p.name), ['Alice', 'Bob', 'Dana']);
    // A team player is listed as their live record (it carries the gender).
    assert.equal(players[2], TEAM[2]);
});

test('summaryRosterPlayers: a name the resolver could not place is listed by that name', () => {
    const game = { rosterSnapshot: snap('Alice') };
    const stats = { 'unresolved:Zed': { name: 'Zed', goals: 1 }, 'ambiguous:Kris': { name: 'Kris' } };
    const players = summaryRosterPlayers(game, stats, TEAM);
    assert.deepEqual(players.map(p => [p.id, p.name]), [
        ['Alice-0001', 'Alice'], ['ambiguous:Kris', 'Kris'], ['unresolved:Zed', 'Zed'],
    ]);
    // Without a stats name, the key minus its prefix is the display name.
    assert.deepEqual(summaryRosterPlayers(game, { 'unresolved:Zed': {} }, []).map(p => p.name), ['Alice', 'Zed']);
});

test('summaryRosterPlayers: no snapshot → the live roster plus whoever has stats', () => {
    const stats = { 'Bob-0002': { name: 'Bob' }, 'Zed-9999': { name: 'Zed' } };
    assert.deepEqual(summaryRosterPlayers({ rosterSnapshot: null }, stats, TEAM).map(p => p.name),
        ['Alice', 'Bob', 'Dana', 'Zed']);
    assert.deepEqual(summaryRosterPlayers({ rosterSnapshot: { players: [] } }, stats, TEAM).map(p => p.name),
        ['Alice', 'Bob', 'Dana', 'Zed']);
    // Nothing at all: just whoever has stats.
    assert.deepEqual(summaryRosterPlayers({}, stats).map(p => p.name), ['Bob', 'Zed']);
    assert.deepEqual(summaryRosterPlayers({ rosterSnapshot: snap('Alice') }, null, TEAM).map(p => p.name), ['Alice']);
});

test('eventRosterDiffers: checked players, pickups and overrides count; order does not', () => {
    const a = { playerIds: ['Alice-0001', 'Bob-0002'], pickupPlayers: [], overrides: {} };
    assert.equal(eventRosterDiffers(a, { playerIds: ['Bob-0002', 'Alice-0001'] }), false);
    assert.equal(eventRosterDiffers(a, { playerIds: ['Alice-0001'] }), true);
    assert.equal(eventRosterDiffers(a, { ...a, pickupPlayers: [{ id: 'Zed-9999', name: 'Zed' }] }), true);
    assert.equal(eventRosterDiffers(a, { ...a, overrides: { 'Alice-0001': { position: 'handler' } } }), true);
    assert.equal(eventRosterDiffers(a, { ...a, overrides: { 'Alice-0001': {} } }), false);
    assert.equal(eventRosterDiffers(null, null), false);
    assert.equal(eventRosterDiffers(null, a), true);
});

test('describeEventRosterChange: names who was added and removed, by team or pickup name', () => {
    const before = { playerIds: ['Alice-0001', 'Dana-0003'], pickupPlayers: [] };
    const after = {
        playerIds: ['Alice-0001', 'Bob-0002'],
        pickupPlayers: [{ id: 'Zed-9999', name: 'Zed' }],
    };
    assert.equal(describeEventRosterChange(before, after, TEAM),
        'Event roster updated: Bob and Zed added; Dana removed');
    assert.equal(describeEventRosterChange(before, { playerIds: ['Alice-0001', 'Dana-0003', 'Bob-0002'] }, TEAM),
        'Event roster updated: Bob added');
    // An id the team roster does not know is shown as the id.
    assert.equal(describeEventRosterChange(before, { playerIds: ['Alice-0001', 'Dana-0003', 'Who-0000'] }, TEAM),
        'Event roster updated: Who-0000 added');
});

test('describeEventRosterChange: a change that adds or removes nobody, and no change at all', () => {
    const before = { playerIds: ['Alice-0001'], pickupPlayers: [], overrides: {} };
    assert.equal(describeEventRosterChange(before, { ...before, overrides: { 'Alice-0001': { defaultLine: 'O' } } }, TEAM),
        'Event roster updated');
    assert.equal(describeEventRosterChange(before, { playerIds: ['Alice-0001'] }, TEAM), null);
    assert.equal(describeEventRosterChange(null, null, TEAM), null);
});
