/*
 * The role predicates are the only place the app decides what a stat keeper
 * may touch; every team-list button and settings section keys off them. Pin
 * the three roles plus the local-only (null) case, which must read as a
 * coach or an offline device loses its own buttons.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { roleLabel, canRecordGames, canManageTeam } from '../../store/roles.js';

test('coach records and manages', () => {
    assert.equal(canRecordGames('coach'), true);
    assert.equal(canManageTeam('coach'), true);
});

test('stat keeper records but does not manage', () => {
    assert.equal(canRecordGames('statkeeper'), true);
    assert.equal(canManageTeam('statkeeper'), false);
});

test('viewer neither records nor manages', () => {
    assert.equal(canRecordGames('viewer'), false);
    assert.equal(canManageTeam('viewer'), false);
});

test('a local-only team (no membership) is the device owner: a coach', () => {
    assert.equal(canRecordGames(null), true);
    assert.equal(canManageTeam(undefined), true);
});

test('labels', () => {
    assert.equal(roleLabel('coach'), 'Coach');
    assert.equal(roleLabel('statkeeper'), 'Stat Keeper');
    assert.equal(roleLabel('viewer'), 'Viewer');
    assert.equal(roleLabel(undefined), 'member');
});
