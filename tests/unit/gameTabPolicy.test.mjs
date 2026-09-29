/*
 * Unit tests pinning the in-game tab rules (utils/gameTabPolicy.js).
 *
 * Contract under test:
 *  - a game opens on the Line tab between points, whatever tab was active
 *    last; re-opened mid-point it comes back on the last tab, else the
 *    tracking preference, else Simple; a viewer keeps the last tab (All)
 *  - Start Point leaves the Line tab for the tracking preference; with none
 *    picked yet it is a coach's first point: Simple, and the hint fires
 *  - the tracking tabs are Simple, Full, Field and All; Line and Log never
 *    become the preference; the legacy 'play' name reads as Simple; junk
 *    reads as nothing
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    TRACKING_TABS, GAME_TABS, DEFAULT_TRACKING_TAB, LAUNCH_TAB,
    isTrackingTab, normalizeGameTab, normalizeTrackingTab,
    launchTab, trackingTabAtPointStart,
    FIRST_POINT_HINT_ID, FIRST_POINT_HINT,
} from '../../utils/gameTabPolicy.js';

// ─── tab names ──────────────────────────────────────────────────────────────

test('the tracking tabs are Simple, Full, Field and All; Line and Log are the rest', () => {
    assert.deepEqual([...TRACKING_TABS], ['simple', 'full', 'field', 'all']);
    assert.deepEqual([...GAME_TABS], ['simple', 'full', 'field', 'all', 'line', 'log']);
    for (const tab of TRACKING_TABS) assert.equal(isTrackingTab(tab), true, tab);
    assert.equal(isTrackingTab('line'), false);
    assert.equal(isTrackingTab('log'), false);
    assert.equal(DEFAULT_TRACKING_TAB, 'simple');
    assert.equal(LAUNCH_TAB, 'line');
});

test('normalize: every tab passes, the legacy play name reads as simple, junk reads as null', () => {
    for (const tab of GAME_TABS) assert.equal(normalizeGameTab(tab), tab);
    assert.equal(normalizeGameTab('play'), 'simple');
    for (const raw of [null, undefined, '', 'Simple', 'PLAY', 'panel', 42, {}, [], true]) {
        assert.equal(normalizeGameTab(raw), null, `raw=${String(raw)}`);
    }
});

test('normalizeTrackingTab: only a tracking tab passes; line and log read as null', () => {
    for (const tab of TRACKING_TABS) assert.equal(normalizeTrackingTab(tab), tab);
    assert.equal(normalizeTrackingTab('play'), 'simple');
    assert.equal(normalizeTrackingTab('line'), null);
    assert.equal(normalizeTrackingTab('log'), null);
    assert.equal(normalizeTrackingTab(undefined), null);
});

// ─── launchTab ──────────────────────────────────────────────────────────────

test('between points a game opens on the Line tab, whatever was active last', () => {
    for (const lastTab of [null, ...GAME_TABS, 'play', 'junk']) {
        for (const preferredTab of [null, 'full', 'all']) {
            assert.equal(launchTab({ pointInProgress: false, viewer: false, lastTab, preferredTab }), 'line',
                `lastTab=${lastTab} preferredTab=${preferredTab}`);
        }
    }
    assert.equal(launchTab(), 'line', 'no context at all is a fresh device between points');
});

test('re-opened mid-point, a game comes back on the tab it was left on', () => {
    for (const lastTab of GAME_TABS) {
        assert.equal(launchTab({ pointInProgress: true, lastTab, preferredTab: 'full' }), lastTab);
    }
    assert.equal(launchTab({ pointInProgress: true, lastTab: 'play' }), 'simple', 'legacy name');
});

test('mid-point with no last tab: the tracking preference, else Simple', () => {
    assert.equal(launchTab({ pointInProgress: true, lastTab: null, preferredTab: 'field' }), 'field');
    assert.equal(launchTab({ pointInProgress: true, lastTab: 'junk', preferredTab: 'all' }), 'all');
    assert.equal(launchTab({ pointInProgress: true, lastTab: null, preferredTab: 'line' }), 'simple',
        'a non-tracking preference is ignored');
    assert.equal(launchTab({ pointInProgress: true, lastTab: null, preferredTab: null }), 'simple');
});

test('a viewer keeps the last tab, defaulting to All, between points or not', () => {
    for (const pointInProgress of [false, true]) {
        assert.equal(launchTab({ pointInProgress, viewer: true, lastTab: null }), 'all');
        assert.equal(launchTab({ pointInProgress, viewer: true, lastTab: 'junk' }), 'all');
        assert.equal(launchTab({ pointInProgress, viewer: true, lastTab: 'log' }), 'log');
        assert.equal(launchTab({ pointInProgress, viewer: true, lastTab: 'line', preferredTab: 'full' }), 'line');
    }
});

// ─── trackingTabAtPointStart ────────────────────────────────────────────────

test('no preference yet: the first point ever goes to Simple and the hint fires', () => {
    for (const raw of [null, undefined, '', 'line', 'log', 'junk']) {
        assert.deepEqual(trackingTabAtPointStart(raw), { tab: 'simple', firstEver: true }, `raw=${String(raw)}`);
    }
});

test('with a preference, Start Point returns to it and the hint stays quiet', () => {
    for (const tab of TRACKING_TABS) {
        assert.deepEqual(trackingTabAtPointStart(tab), { tab, firstEver: false });
    }
    assert.deepEqual(trackingTabAtPointStart('play'), { tab: 'simple', firstEver: false },
        'a coach who tracked on the old play tab is not new');
});

test('the first-point hint names Full and Field and has a stable id', () => {
    assert.equal(FIRST_POINT_HINT_ID, 'first-tracking-tab');
    assert.match(FIRST_POINT_HINT, /Simple/);
    assert.match(FIRST_POINT_HINT, /Full/);
    assert.match(FIRST_POINT_HINT, /Field/);
});
