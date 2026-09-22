/*
 * Unit tests for the teams-screen arrangement rules (store/teamListPrefs.js):
 * a pinned group on top in pin order, then most recently opened first, with
 * the pre-pins order (most recent game, then name) as the fallback for teams
 * never opened on this device.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    TEAM_LIST_PREFS_KEY, emptyTeamListPrefs, normalizeTeamListPrefs,
    readTeamListPrefs, writeTeamListPrefs,
    isTeamPinned, pinTeam, unpinTeam, markTeamViewed, arrangeTeams,
} from '../../store/teamListPrefs.js';

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

/** A team entry as /api/auth/teams returns it. */
function entry(id, name = id, role = 'coach') {
    return { team: { id, name }, role };
}

const T0 = 1757000000000;   // arbitrary epoch base
const HOUR = 3600000;

// ── read / write ────────────────────────────────────────────────────────

test('read: nothing stored → empty prefs', () => {
    assert.deepEqual(readTeamListPrefs(fakeStorage()), emptyTeamListPrefs());
});

test('read: corrupt or wrongly-typed values → empty prefs, never a throw', () => {
    for (const raw of ['{not json', '42', '"str"', '[]', 'null']) {
        const s = fakeStorage({ [TEAM_LIST_PREFS_KEY]: raw });
        assert.deepEqual(readTeamListPrefs(s), emptyTeamListPrefs(), `raw=${raw}`);
    }
});

test('read: a storage that throws reads as empty', () => {
    const s = { getItem: () => { throw new Error('SecurityError'); } };
    assert.deepEqual(readTeamListPrefs(s), emptyTeamListPrefs());
});

test('normalize: keeps string ids (deduplicated, order kept) and positive numeric timestamps only', () => {
    const prefs = normalizeTeamListPrefs({
        pinned: ['A', 7, null, 'B', 'A', '', 'C'],
        lastViewed: { A: T0, B: 'yesterday', C: -1, D: NaN, E: Infinity, F: 0 },
        junk: true,
    });
    assert.deepEqual(prefs, { pinned: ['A', 'B', 'C'], lastViewed: { A: T0 } });
});

test('normalize: an array where the lastViewed object should be is ignored', () => {
    const prefs = normalizeTeamListPrefs({ pinned: [], lastViewed: [T0] });
    assert.deepEqual(prefs.lastViewed, {});
});

test('write then read round-trips, normalizing on the way in', () => {
    const s = fakeStorage();
    assert.equal(writeTeamListPrefs(s, { pinned: ['A', 'A'], lastViewed: { A: T0, B: 'x' } }), true);
    assert.deepEqual(JSON.parse(s.getItem(TEAM_LIST_PREFS_KEY)), { pinned: ['A'], lastViewed: { A: T0 } });
    assert.deepEqual(readTeamListPrefs(s), { pinned: ['A'], lastViewed: { A: T0 } });
});

test('write: a storage that throws (quota) reports false instead of throwing', () => {
    const s = { setItem: () => { throw new Error('QuotaExceededError'); } };
    assert.equal(writeTeamListPrefs(s, emptyTeamListPrefs()), false);
});

// ── pin / unpin / view ──────────────────────────────────────────────────

test('pinTeam puts the team at the top of the pinned group', () => {
    let prefs = emptyTeamListPrefs();
    prefs = pinTeam(prefs, 'A');
    prefs = pinTeam(prefs, 'B');
    assert.deepEqual(prefs.pinned, ['B', 'A']);
    assert.equal(isTeamPinned(prefs, 'A'), true);
    assert.equal(isTeamPinned(prefs, 'Z'), false);
});

test('pinning an already pinned team moves it to the top (the only reorder there is)', () => {
    const prefs = pinTeam({ pinned: ['C', 'B', 'A'], lastViewed: {} }, 'A');
    assert.deepEqual(prefs.pinned, ['A', 'C', 'B']);
});

test('unpinTeam removes the team and leaves the rest in order; unknown id is a no-op', () => {
    const prefs = { pinned: ['C', 'B', 'A'], lastViewed: {} };
    assert.deepEqual(unpinTeam(prefs, 'B').pinned, ['C', 'A']);
    assert.deepEqual(unpinTeam(prefs, 'Z').pinned, ['C', 'B', 'A']);
});

test('markTeamViewed stamps the team with the given time', () => {
    const prefs = markTeamViewed(emptyTeamListPrefs(), 'A', T0);
    assert.deepEqual(prefs.lastViewed, { A: T0 });
    assert.equal(typeof markTeamViewed(emptyTeamListPrefs(), 'A').lastViewed.A, 'number');
});

test('pin, unpin and view never mutate their input', () => {
    const original = { pinned: ['A'], lastViewed: { A: T0 } };
    const snapshot = JSON.stringify(original);
    pinTeam(original, 'B');
    unpinTeam(original, 'A');
    markTeamViewed(original, 'C', T0);
    assert.equal(JSON.stringify(original), snapshot);
});

test('an empty team id is ignored by pin and view', () => {
    assert.deepEqual(pinTeam(emptyTeamListPrefs(), '').pinned, []);
    assert.deepEqual(markTeamViewed(emptyTeamListPrefs(), undefined, T0).lastViewed, {});
});

// ── arrangeTeams ────────────────────────────────────────────────────────

test('nothing pinned, nothing viewed: the old order (most recent game first, then name)', () => {
    const teams = [entry('Zed'), entry('Alpha'), entry('Mid')];
    const activity = { Zed: T0, Alpha: 0, Mid: T0 + HOUR };
    const { pinned, others } = arrangeTeams(teams, emptyTeamListPrefs(), id => activity[id]);
    assert.deepEqual(pinned, []);
    assert.deepEqual(others.map(e => e.team.id), ['Mid', 'Zed', 'Alpha']);
});

test('ties on activity (including no games at all) break on name, then id', () => {
    const teams = [entry('t2', 'Bravo'), entry('t1', 'Alpha'), entry('t3', 'Alpha')];
    const { others } = arrangeTeams(teams, emptyTeamListPrefs());
    assert.deepEqual(others.map(e => e.team.id), ['t1', 't3', 't2']);
});

test('a team opened on this device outranks a never-opened one, however recent its games', () => {
    const teams = [entry('Busy'), entry('Quiet')];
    const prefs = markTeamViewed(emptyTeamListPrefs(), 'Quiet', T0 - 30 * 24 * HOUR);
    const activity = { Busy: T0, Quiet: 0 };
    const { others } = arrangeTeams(teams, prefs, id => activity[id]);
    assert.deepEqual(others.map(e => e.team.id), ['Quiet', 'Busy']);
});

test('opened teams come most recent first', () => {
    const teams = [entry('A'), entry('B'), entry('C')];
    let prefs = emptyTeamListPrefs();
    prefs = markTeamViewed(prefs, 'A', T0);
    prefs = markTeamViewed(prefs, 'B', T0 + 2 * HOUR);
    prefs = markTeamViewed(prefs, 'C', T0 + HOUR);
    const { others } = arrangeTeams(teams, prefs);
    assert.deepEqual(others.map(e => e.team.id), ['B', 'C', 'A']);
});

test('pinned teams form their own group in pin order and leave the other group', () => {
    const teams = [entry('A'), entry('B'), entry('C'), entry('D')];
    let prefs = emptyTeamListPrefs();
    prefs = markTeamViewed(prefs, 'A', T0 + HOUR);   // most recently opened...
    prefs = pinTeam(prefs, 'C');
    prefs = pinTeam(prefs, 'A');                       // ...and pinned last, so top
    const { pinned, others } = arrangeTeams(teams, prefs);
    assert.deepEqual(pinned.map(e => e.team.id), ['A', 'C']);
    assert.deepEqual(others.map(e => e.team.id), ['B', 'D']);
});

test('a pinned id with no team in the list is skipped, not an error', () => {
    const teams = [entry('A')];
    const prefs = pinTeam(pinTeam(emptyTeamListPrefs(), 'A'), 'Erased-0000');
    const { pinned, others } = arrangeTeams(teams, prefs);
    assert.deepEqual(pinned.map(e => e.team.id), ['A']);
    assert.deepEqual(others, []);
});

test('the arranged entries are the same objects that went in (role and all)', () => {
    const viewer = entry('V', 'Viewed Team', 'viewer');
    const coach = entry('C', 'Coached Team', 'coach');
    const { pinned, others } = arrangeTeams([viewer, coach], pinTeam(emptyTeamListPrefs(), 'V'));
    assert.equal(pinned[0], viewer);
    assert.equal(others[0], coach);
});

test('malformed entries and a non-array list are tolerated', () => {
    const { pinned, others } = arrangeTeams([null, {}, { team: {} }, entry('A')], emptyTeamListPrefs());
    assert.deepEqual(others.map(e => e.team.id), ['A']);
    assert.deepEqual(pinned, []);
    assert.deepEqual(arrangeTeams(undefined, emptyTeamListPrefs()), { pinned: [], others: [] });
});

test('arrangeTeams copes with prefs that are missing or malformed', () => {
    const teams = [entry('B'), entry('A')];
    for (const prefs of [undefined, null, 'junk', { pinned: 'A' }]) {
        const { others } = arrangeTeams(teams, prefs);
        assert.deepEqual(others.map(e => e.team.id), ['A', 'B'], `prefs=${JSON.stringify(prefs)}`);
    }
});
