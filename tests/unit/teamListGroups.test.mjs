/*
 * Unit tests for store/teamListGroups.js — which collapsible groups on the
 * teams screen (events, the Scrimmages group, each scrimmage) start open.
 *
 * The contract: the most recent group and every group with a live game start
 * open, the rest collapsed; a choice the coach made holds across redraws; a
 * group first seen later starts open when it is the newest, without closing
 * the one that was open.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    defaultOpenKeys, seedGroupStates, isGroupOpen, setGroupOpen,
} from '../../store/teamListGroups.js';

const T0 = 1758000000000;
const DAY = 86400000;

const groups = [
    { key: 'T1|event:spring', sortTs: T0 - 30 * DAY },
    { key: 'T1|event:fall', sortTs: T0 },
    { key: 'T1|scrimmages', sortTs: T0 - 2 * DAY },
];

test('defaults: only the most recent group starts open', () => {
    assert.deepEqual([...defaultOpenKeys(groups)], ['T1|event:fall']);
});

test('defaults: a group with a live game starts open as well', () => {
    const live = groups.map(g => (g.key === 'T1|scrimmages' ? { ...g, active: true } : g));
    assert.deepEqual([...defaultOpenKeys(live)].sort(), ['T1|event:fall', 'T1|scrimmages']);
});

test('defaults: a tie on recency opens the first one given; nothing opens an empty list', () => {
    const tied = [{ key: 'a', sortTs: 0 }, { key: 'b', sortTs: 0 }];
    assert.deepEqual([...defaultOpenKeys(tied)], ['a']);
    assert.deepEqual([...defaultOpenKeys([])], []);
    assert.deepEqual([...defaultOpenKeys(null)], []);
    // Junk entries are skipped rather than opening anything.
    assert.deepEqual([...defaultOpenKeys([null, { sortTs: 5 }, { key: 'c', sortTs: 'x' }])], ['c']);
});

test('seeding fills in every unseen group and returns a new Map', () => {
    const states = new Map();
    const seeded = seedGroupStates(states, groups);
    assert.notEqual(seeded, states);
    assert.equal(states.size, 0);
    assert.equal(isGroupOpen(seeded, 'T1|event:fall'), true);
    assert.equal(isGroupOpen(seeded, 'T1|event:spring'), false);
    assert.equal(isGroupOpen(seeded, 'T1|scrimmages'), false);
    assert.equal(isGroupOpen(seeded, 'never-seen'), false);
    assert.equal(isGroupOpen(null, 'T1|event:fall'), false);
});

test("the coach's choice holds across redraws", () => {
    let states = seedGroupStates(new Map(), groups);
    states = setGroupOpen(states, 'T1|event:fall', false);
    states = setGroupOpen(states, 'T1|event:spring', true);
    const redrawn = seedGroupStates(states, groups);
    assert.equal(isGroupOpen(redrawn, 'T1|event:fall'), false);
    assert.equal(isGroupOpen(redrawn, 'T1|event:spring'), true);
    assert.equal(isGroupOpen(redrawn, 'T1|scrimmages'), false);
});

test('a group that appears later starts open when newest, and the open one stays open', () => {
    let states = seedGroupStates(new Map(), groups);
    const withNew = [...groups, { key: 'T1|event:regionals', sortTs: T0 + DAY }];
    states = seedGroupStates(states, withNew);
    assert.equal(isGroupOpen(states, 'T1|event:regionals'), true);
    assert.equal(isGroupOpen(states, 'T1|event:fall'), true);
    assert.equal(isGroupOpen(states, 'T1|event:spring'), false);
});

test('a group that appears later and is not the newest starts collapsed', () => {
    let states = seedGroupStates(new Map(), groups);
    states = seedGroupStates(states, [...groups, { key: 'T1|event:old', sortTs: T0 - 90 * DAY }]);
    assert.equal(isGroupOpen(states, 'T1|event:old'), false);
});

test('groups of different teams are independent (keys carry the team)', () => {
    const two = [
        { key: 'T1|event:fall', sortTs: T0 },
        { key: 'T2|event:fall', sortTs: T0 - DAY },
    ];
    // Each team seeds its own list, so each team's newest opens.
    let states = seedGroupStates(new Map(), [two[0]]);
    states = seedGroupStates(states, [two[1]]);
    assert.equal(isGroupOpen(states, 'T1|event:fall'), true);
    assert.equal(isGroupOpen(states, 'T2|event:fall'), true);
});

test('setGroupOpen ignores an empty key and never mutates its input', () => {
    const states = new Map([['a', true]]);
    const next = setGroupOpen(states, '', false);
    assert.deepEqual([...next], [['a', true]]);
    const flipped = setGroupOpen(states, 'a', false);
    assert.equal(states.get('a'), true);
    assert.equal(flipped.get('a'), false);
});
