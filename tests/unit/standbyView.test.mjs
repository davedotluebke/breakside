/*
 * Unit tests pinning the standby screen's pure read rules (utils/standbyView.js).
 *
 * Contract under test:
 *  - the labels under the score follow the header's identity priority minus
 *    the icon: symbol → short name → "Us", short opponent → "Them"
 *  - a name over the cap falls back rather than being truncated (a cut-off
 *    name reads as a different name)
 *  - the countdown is "running" exactly when the game's countdown box has a
 *    visible inline display, and its text is passed through untouched
 *  - `urgent` can only be true while running
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 * (no deps — plain node:test against the ES modules)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { standbyLabels, countdownState, LABEL_MAX } from '../../utils/standbyView.js';

// ─── standbyLabels ──────────────────────────────────────────────────────────

test('symbol wins over name for our side', () => {
    const l = standbyLabels({ team: { teamSymbol: 'VR', name: 'Velvet Revolution' }, opponent: 'Bad Guys' });
    assert.deepEqual(l, { us: 'VR', them: 'Bad Guys' });
});

test('a short team name is used when there is no symbol', () => {
    const l = standbyLabels({ team: { name: 'Night Owls' }, opponent: 'Bad Guys' });
    assert.equal(l.us, 'Night Owls');
});

test('a long team name falls back to Us rather than being cut off', () => {
    const longName = 'x'.repeat(LABEL_MAX + 1);
    const l = standbyLabels({ team: { name: longName }, opponent: 'Bad Guys' });
    assert.equal(l.us, 'Us');
    // Exactly at the cap still shows.
    assert.equal(standbyLabels({ team: { name: 'y'.repeat(LABEL_MAX) } }).us, 'y'.repeat(LABEL_MAX));
});

test('opponent: short name shows, long name and missing name read Them', () => {
    assert.equal(standbyLabels({ opponent: 'Bad Guys' }).them, 'Bad Guys');
    assert.equal(standbyLabels({ opponent: 'z'.repeat(LABEL_MAX + 1) }).them, 'Them');
    assert.equal(standbyLabels({ opponent: null }).them, 'Them');
    assert.equal(standbyLabels({}).them, 'Them');
    assert.equal(standbyLabels().them, 'Them');
});

test('blank and whitespace-only values are treated as absent', () => {
    const l = standbyLabels({ team: { teamSymbol: '   ', name: '' }, opponent: '  ' });
    assert.deepEqual(l, { us: 'Us', them: 'Them' });
    // A padded but real symbol is trimmed, not discarded.
    assert.equal(standbyLabels({ team: { teamSymbol: ' VR ' } }).us, 'VR');
});

test('the cap is configurable', () => {
    assert.equal(standbyLabels({ team: { name: 'Eight..' }, maxLen: 4 }).us, 'Us');
    assert.equal(standbyLabels({ team: { name: 'Four' }, maxLen: 4 }).us, 'Four');
    // Nonsense caps fall back to the default rather than hiding every name.
    assert.equal(standbyLabels({ team: { name: 'Night Owls' }, maxLen: 0 }).us, 'Night Owls');
});

// ─── countdownState ─────────────────────────────────────────────────────────

test('running exactly when the countdown box has a visible inline display', () => {
    assert.equal(countdownState({ display: 'flex', text: '01:30' }).running, true);
    assert.equal(countdownState({ display: 'block', text: '01:30' }).running, true);
    assert.equal(countdownState({ display: 'none', text: '01:30' }).running, false);
    // No inline style at all (before the first point ends) is not running.
    assert.equal(countdownState({ display: '', text: '01:30' }).running, false);
    assert.equal(countdownState({}).running, false);
    assert.equal(countdownState().running, false);
});

test('text passes through untouched while running and is empty otherwise', () => {
    assert.equal(countdownState({ display: 'flex', text: '00:07' }).text, '00:07');
    assert.equal(countdownState({ display: 'flex', text: ' 00:07 ' }).text, '00:07');
    assert.equal(countdownState({ display: 'none', text: '00:07' }).text, '');
});

test('urgent only while running', () => {
    assert.equal(countdownState({ display: 'flex', text: '00:05', danger: true }).urgent, true);
    assert.equal(countdownState({ display: 'flex', text: '01:05', danger: false }).urgent, false);
    assert.equal(countdownState({ display: 'none', text: '00:05', danger: true }).urgent, false);
});
