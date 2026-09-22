/*
 * Unit tests pinning the standby timer's pure rules (utils/standbyPolicy.js).
 *
 * Contract under test:
 *  - the gate: standby may enter by itself only in a visible game, with the
 *    timer on, no standby already up, no dialog open, no mic running, and —
 *    for the Active Coach only — not mid-point and not on the Full/Field
 *    tabs. Anyone who is not the Active Coach is never held for those two.
 *  - the first blocking reason wins, and an allowed result carries no reason
 *  - the idle-time setting normalises: strings from the select, 0/garbage as
 *    "never", a cap rather than a rejection
 *  - the toast wording: idle time, bold countdown, singular/plural, the
 *    long-press hint on a smaller second line
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    idleStandbyGate, normalizeIdleSeconds, idleToastMarkup,
    COUNTDOWN_SECONDS, DEFAULT_IDLE_SECONDS, MAX_IDLE_SECONDS,
} from '../../utils/standbyPolicy.js';

/** A context in which standby is allowed; tests flip one field at a time. */
const OPEN = Object.freeze({
    enabled: true, inGame: true, visible: true, standbyActive: false,
    dialogOpen: false, micBusy: false,
    activeCoach: true, pointInProgress: false, activeTab: 'all',
});

// ─── gate ───────────────────────────────────────────────────────────────────

test('the open context is allowed, with no reason', () => {
    assert.deepEqual(idleStandbyGate(OPEN), { allowed: true, reason: null });
});

test('each guard blocks on its own with a named reason', () => {
    const cases = [
        [{ enabled: false }, 'disabled'],
        [{ inGame: false }, 'not-in-game'],
        [{ visible: false }, 'hidden'],
        [{ standbyActive: true }, 'already-in-standby'],
        [{ dialogOpen: true }, 'dialog-open'],
        [{ micBusy: true }, 'mic-busy'],
        [{ pointInProgress: true }, 'active-coach-mid-point'],
        [{ activeTab: 'full' }, 'active-coach-pbp-tab'],
        [{ activeTab: 'field' }, 'active-coach-pbp-tab'],
    ];
    for (const [override, reason] of cases) {
        const r = idleStandbyGate({ ...OPEN, ...override });
        assert.equal(r.allowed, false, JSON.stringify(override));
        assert.equal(r.reason, reason, JSON.stringify(override));
    }
});

test('the Active Coach is allowed between points on the other tabs', () => {
    for (const tab of ['simple', 'line', 'log', 'all']) {
        assert.equal(idleStandbyGate({ ...OPEN, activeTab: tab }).allowed, true, tab);
    }
});

test('a coach who is not Active Coach is never held for the point or the tab', () => {
    for (const tab of ['full', 'field', 'simple', 'line', 'log', 'all']) {
        for (const pointInProgress of [true, false]) {
            const r = idleStandbyGate({ ...OPEN, activeCoach: false, pointInProgress, activeTab: tab });
            assert.equal(r.allowed, true, `${tab} pointInProgress=${pointInProgress}`);
        }
    }
});

test('the earliest guard names the reason when several apply', () => {
    const r = idleStandbyGate({ ...OPEN, dialogOpen: true, micBusy: true, pointInProgress: true });
    assert.equal(r.reason, 'dialog-open');
    assert.equal(idleStandbyGate({ ...OPEN, enabled: false, inGame: false }).reason, 'disabled');
    assert.equal(idleStandbyGate({ ...OPEN, micBusy: true, activeTab: 'full' }).reason, 'mic-busy');
});

test('a missing context blocks rather than throws', () => {
    assert.equal(idleStandbyGate().allowed, false);
    assert.equal(idleStandbyGate({}).allowed, false);
    assert.equal(idleStandbyGate(null).reason, 'disabled');
});

// ─── normalizeIdleSeconds ───────────────────────────────────────────────────

test('idle seconds: select strings parse, nonsense means never, big values clamp', () => {
    assert.equal(normalizeIdleSeconds('60'), 60);
    assert.equal(normalizeIdleSeconds(90), 90);
    assert.equal(normalizeIdleSeconds('2'), 2);
    assert.equal(normalizeIdleSeconds(0), 0);
    assert.equal(normalizeIdleSeconds(-5), 0);
    assert.equal(normalizeIdleSeconds('off'), 0);
    assert.equal(normalizeIdleSeconds(undefined), 0);
    assert.equal(normalizeIdleSeconds(null), 0);
    assert.equal(normalizeIdleSeconds(NaN), 0);
    assert.equal(normalizeIdleSeconds(99999), MAX_IDLE_SECONDS);
    assert.equal(normalizeIdleSeconds(DEFAULT_IDLE_SECONDS), DEFAULT_IDLE_SECONDS);
});

// ─── idleToastMarkup ────────────────────────────────────────────────────────

test('toast wording: idle time, bold countdown, hint line', () => {
    const html = idleToastMarkup(60, COUNTDOWN_SECONDS);
    assert.match(html, /^Idle for 60 seconds, entering standby in <strong>5<\/strong> seconds/);
    assert.match(html, /<br><small class="toast-sub">Long-press ☀ to toggle standby timer<\/small>$/);
});

test('toast wording: singular forms and the final tick', () => {
    assert.match(idleToastMarkup(1, 1), /^Idle for 1 second, entering standby in <strong>1<\/strong> second</);
    assert.match(idleToastMarkup(45, 0), /in <strong>0<\/strong> seconds/);
    // Fractions and negatives are tidied, never shown raw.
    assert.match(idleToastMarkup(89.6, -1), /^Idle for 90 seconds, entering standby in <strong>0<\/strong> seconds/);
});

test('countdown length is the documented five seconds', () => {
    assert.equal(COUNTDOWN_SECONDS, 5);
});
