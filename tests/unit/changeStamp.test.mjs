/*
 * Unit tests for utils/changeStamp.js — the "has the server's copy moved?"
 * comparison behind the in-game refresh gate.
 *
 * The only way this optimization can lose data is by reading "unknown" as
 * "unchanged", so most of what's below pins the null cases rather than the
 * obvious equal/not-equal ones.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeStamp, stampSaysChanged } from '../../utils/changeStamp.js';

// ─── normalizeStamp ─────────────────────────────────────────────────────────

test('absent stamps normalize to null', () => {
    assert.equal(normalizeStamp(null), null);
    assert.equal(normalizeStamp(undefined), null);
    assert.equal(normalizeStamp(''), null);
});

test('stamps normalize to strings so number/string wire changes are not changes', () => {
    assert.equal(normalizeStamp(1754800000000000000), '1754800000000000000');
    assert.equal(normalizeStamp('1754800000000000000'), '1754800000000000000');
    assert.equal(
        normalizeStamp(1754800000000000000),
        normalizeStamp('1754800000000000000')
    );
});

test('zero is a stamp, not an absence', () => {
    // Falsy but real. A game whose mtime_ns is 0 is absurd in practice, but a
    // `!stamp` test here would silently mean "refetch forever".
    assert.equal(normalizeStamp(0), '0');
});

// ─── stampSaysChanged ───────────────────────────────────────────────────────

test('same stamp means nothing to pull', () => {
    assert.equal(stampSaysChanged('abc', 'abc'), false);
});

test('different stamp means pull', () => {
    assert.equal(stampSaysChanged('abc', 'abd'), true);
});

test('an unknown CURRENT stamp always means pull', () => {
    // Old server without the field, failed poll, ping not landed yet. We have
    // no evidence our copy is still good — the whole optimization is only safe
    // because this direction fails toward refetching.
    for (const unknown of [null, undefined, '']) {
        assert.equal(stampSaysChanged('abc', unknown), true,
            `current=${JSON.stringify(unknown)} must force a pull`);
    }
});

test('an unknown LAST-SEEN stamp always means pull', () => {
    // First pull of a session, or the deliberate reset after a resume.
    for (const unknown of [null, undefined, '']) {
        assert.equal(stampSaysChanged(unknown, 'abc'), true,
            `lastSeen=${JSON.stringify(unknown)} must force a pull`);
    }
});

test('both unknown means pull', () => {
    assert.equal(stampSaysChanged(null, null), true);
});

test('a number/string mismatch is not treated as a change', () => {
    // The client stores what it was handed; the server may serialize the same
    // mtime differently across a deploy. Refetching every 3s because of that
    // would quietly undo the entire change.
    assert.equal(stampSaysChanged('1754800000000000000', 1754800000000000000), false);
    assert.equal(stampSaysChanged(1754800000000000000, '1754800000000000000'), false);
});
