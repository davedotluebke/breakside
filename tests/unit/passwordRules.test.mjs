/*
 * Unit tests for auth/passwordRules.js — the pure half of the change-password
 * dialog (teams/accountPassword.js): field validation, "does this account
 * even have a password", and the Supabase error → sentence mapping.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MIN_PASSWORD_LENGTH,
    validatePasswordChange,
    userProviders,
    userHasPasswordIdentity,
    describeProviders,
    describePasswordError,
} from '../../auth/passwordRules.js';

// ── validatePasswordChange ──────────────────────────────────────────────

test('accepts a well-formed change', () => {
    assert.equal(validatePasswordChange({ current: 'old-one', next: 'new-one', confirm: 'new-one' }), null);
});

test('change mode needs the current password first', () => {
    assert.match(validatePasswordChange({ current: '', next: 'new-one', confirm: 'new-one' }), /current password/i);
});

test('recovery mode skips the current password', () => {
    assert.equal(validatePasswordChange({ next: 'new-one', confirm: 'new-one', requireCurrent: false }), null);
});

test('rejects an empty or short new password', () => {
    assert.match(validatePasswordChange({ current: 'x', next: '', confirm: '' }), /enter a new password/i);
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    assert.match(validatePasswordChange({ current: 'x', next: short, confirm: short }), /at least/);
    const exact = 'a'.repeat(MIN_PASSWORD_LENGTH);
    assert.equal(validatePasswordChange({ current: 'x', next: exact, confirm: exact }), null);
});

test('rejects a mismatched confirmation', () => {
    assert.match(validatePasswordChange({ current: 'x', next: 'new-one', confirm: 'new-two' }), /don't match/);
});

test('rejects reusing the current password (change mode only)', () => {
    assert.match(validatePasswordChange({ current: 'same-1', next: 'same-1', confirm: 'same-1' }), /different/);
    // In recovery mode there is no current password to compare against.
    assert.equal(validatePasswordChange({ current: 'same-1', next: 'same-1', confirm: 'same-1', requireCurrent: false }), null);
});

// ── providers / identity ────────────────────────────────────────────────

const emailUser = { identities: [{ provider: 'email' }] };
const googleUser = { identities: [{ provider: 'google' }], app_metadata: { providers: ['google'] } };
const linkedUser = { identities: [{ provider: 'email' }, { provider: 'google' }] };

test('reads providers from identities, then app_metadata', () => {
    assert.deepEqual(userProviders(emailUser), ['email']);
    assert.deepEqual(userProviders(googleUser), ['google']);
    assert.deepEqual(userProviders({ app_metadata: { providers: ['google'] } }), ['google']);
    assert.deepEqual(userProviders({ identities: [], app_metadata: { providers: ['email'] } }), ['email']);
    assert.deepEqual(userProviders(null), []);
});

test('a password identity is required for the change-password link', () => {
    assert.equal(userHasPasswordIdentity(emailUser), true);
    assert.equal(userHasPasswordIdentity(linkedUser), true);
    assert.equal(userHasPasswordIdentity(googleUser), false);
    assert.equal(userHasPasswordIdentity(null), false);
});

test('an unknown user shape counts as a password account', () => {
    // The test-mode fake user (auth/auth.js enableTestMode) has neither
    // identities nor app_metadata; hiding the link there would just hide it
    // from every local preview.
    assert.equal(userHasPasswordIdentity({ id: 'test-user', email: 'test-user@breakside.test' }), true);
});

test('describes the non-password providers', () => {
    assert.equal(describeProviders(googleUser), 'Google');
    assert.equal(describeProviders(emailUser), '');
    assert.equal(describeProviders({ identities: [{ provider: 'zzz' }] }), 'Zzz');
});

// ── describePasswordError ───────────────────────────────────────────────

test('maps the GoTrue codes the dialog can trigger', () => {
    assert.match(describePasswordError({ code: 'invalid_credentials', message: 'Invalid login credentials' }), /incorrect/);
    assert.match(describePasswordError({ code: 'same_password', message: 'x' }), /different/);
    assert.match(describePasswordError({ code: 'reauthentication_needed', message: 'x' }), /reset link/);
    assert.match(describePasswordError({ code: 'over_request_rate_limit', message: 'x' }), /Too many/);
    assert.match(describePasswordError({ code: 'session_expired', message: 'x' }), /expired/);
});

test('weak_password shows the server reason verbatim', () => {
    const msg = 'Password should be at least 8 characters.';
    assert.equal(describePasswordError({ code: 'weak_password', message: msg }), msg);
});

test('falls back on status and name when there is no code', () => {
    assert.match(describePasswordError({ status: 429, message: 'x' }), /Too many/);
    assert.match(describePasswordError({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }), /connection/);
    assert.equal(describePasswordError({ message: 'Server said no' }), 'Server said no');
    assert.equal(describePasswordError({}), 'Something went wrong. Please try again.');
    assert.equal(describePasswordError(null, 'nope'), 'nope');
});

test('ignores a numeric code (GoTrue puts the HTTP status there)', () => {
    assert.equal(describePasswordError({ code: 400, message: 'Bad request' }), 'Bad request');
});
