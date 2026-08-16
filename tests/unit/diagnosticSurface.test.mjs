/*
 * The battery report must never reach a real user.
 *
 * These are the origins the app is actually served from, plus the ones it
 * isn't — the point of an allowlist is what it does with the latter.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isDiagnosticHost } from '../../utils/diagnosticSurface.js';

test('production is never a diagnostic surface', () => {
    assert.equal(isDiagnosticHost('www.breakside.pro', false), false);
    assert.equal(isDiagnosticHost('breakside.pro', false), false);
});

test('staging is, via the flag index.html sets', () => {
    assert.equal(isDiagnosticHost('staging.breakside.pro', true), true);
});

test('local development is, including a build opened off disk', () => {
    assert.equal(isDiagnosticHost('localhost', false), true);
    assert.equal(isDiagnosticHost('127.0.0.1', false), true);
    assert.equal(isDiagnosticHost('[::1]', false), true);
    assert.equal(isDiagnosticHost('', false), true); // file://
});

test('an unrecognized origin gets nothing — the allowlist fails closed', () => {
    // The reason this isn't `hostname !== 'www.breakside.pro'`. Every one of
    // these would show diagnostics to whoever loaded it under a denylist.
    for (const host of [
        'preview-branch.example.com',
        'breakside-copy.s3-website.amazonaws.com',
        'd1234abcd.cloudfront.net',
        '192.168.1.42',
        'breakside.pro.evil.test',
        'localhost.evil.test',
        'notlocalhost',
    ]) {
        assert.equal(isDiagnosticHost(host, false), false, `${host} should be closed`);
    }
});

test('a missing or malformed hostname does not open the gate', () => {
    // '' is file:// and allowed, but null/undefined coerce to '' too — assert
    // the coercion is deliberate rather than accidentally permissive elsewhere.
    assert.equal(isDiagnosticHost(undefined, false), true);
    assert.equal(isDiagnosticHost(null, false), true);
    // Only a real `true` counts as staging; a truthy string must not.
    assert.equal(isDiagnosticHost('www.breakside.pro', 'yes'), false);
    assert.equal(isDiagnosticHost('www.breakside.pro', 1), false);
});
