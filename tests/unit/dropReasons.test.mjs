/*
 * Tests for narration/dropReasons.js summarizeDrops().
 *
 * This is the text a coach reads mid-game when narration didn't record
 * something. It replaced a single catch-all — "couldn't be matched to
 * on-field players" — that was applied to every failure cause and was wrong
 * in the case that actually shipped: a narrated pull became a throw with no
 * receiver, and the coach was told to check a roster that was fine.
 *
 * Pure leaf, no globals to stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeDrops } from '../../narration/dropReasons.js';

test('nothing dropped produces no clause', () => {
    assert.equal(summarizeDrops([]), '');
    assert.equal(summarizeDrops(null), '');
    assert.equal(summarizeDrops(undefined), '');
});

test('an unmatched name is quoted so the coach knows who to look for', () => {
    const out = summarizeDrops([{ reason: 'unmatched-name', detail: 'Inez' }]);
    assert.equal(out, '"Inez" is not on the field');
});

test('several unmatched names collapse into one phrase', () => {
    const out = summarizeDrops([
        { reason: 'unmatched-name', detail: 'Inez' },
        { reason: 'unmatched-name', detail: 'Bob' },
    ]);
    assert.equal(out, '"Inez", "Bob" are not on the field');
});

test('a repeated name is not listed twice', () => {
    const out = summarizeDrops([
        { reason: 'unmatched-name', detail: 'Inez' },
        { reason: 'unmatched-name', detail: 'Inez' },
    ]);
    assert.equal(out, '"Inez" is not on the field');
});

test('the real field-test case: a throw with no receiver says so', () => {
    // What main produced for "Good flick pull by Inez" before kind=pull
    // existed: {kind: throw, thrower: Inez} — Inez matched fine, the event
    // was simply incomplete. The old message blamed player matching.
    const out = summarizeDrops([{ reason: 'incomplete', detail: 'throw with no receiver' }]);
    assert.equal(out, 'throw with no receiver');
    assert.ok(!out.includes('not on the field'), 'must not blame player matching');
});

test('a duplicate pull reads as already recorded, not as a matching failure', () => {
    const out = summarizeDrops([{ reason: 'duplicate-pull' }]);
    assert.equal(out, 'the pull was already recorded');
});

test('mixed reasons are joined, in first-seen order', () => {
    const out = summarizeDrops([
        { reason: 'incomplete', detail: 'throw with no receiver' },
        { reason: 'unmatched-name', detail: 'Zed' },
        { reason: 'duplicate-pull' },
    ]);
    assert.equal(out, 'throw with no receiver; "Zed" is not on the field; the pull was already recorded');
});

test('unsupported kinds name the kind when known', () => {
    assert.equal(summarizeDrops([{ reason: 'unsupported', detail: 'timeout' }]),
        'unsupported event (timeout)');
    assert.equal(summarizeDrops([{ reason: 'unsupported' }]),
        '1 event could not be recorded');
});

test('unknown/missing reason falls back rather than throwing', () => {
    assert.equal(summarizeDrops([{}]), '1 event could not be recorded');
    assert.equal(summarizeDrops([null]), '1 event could not be recorded');
    assert.equal(summarizeDrops([{ reason: 'brand-new-thing' }]), '1 event could not be recorded');
});

test('pluralization holds for counted fallbacks', () => {
    assert.equal(summarizeDrops([{ reason: 'unsupported' }, { reason: 'unsupported' }]),
        '2 events could not be recorded');
    assert.equal(summarizeDrops([{ reason: 'unmatched-name' }, { reason: 'unmatched-name' }]),
        '2 names not on the field');
});
