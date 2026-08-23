/*
 * Unit tests for utils/apiOrigin.js — the allowlist guarding the ?api= /
 * `ultistats_api_url` API-base override.
 *
 * This is the check that stops a link like
 *   https://www.breakside.pro/?api=https://evil.example
 * from permanently redirecting every authFetch — Supabase bearer token
 * included — to an attacker's server.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedApiBase } from '../../utils/apiOrigin.js';

// ── the documented workflows that must keep working ─────────────────────

test('allows the production API origin', () => {
    assert.equal(isAllowedApiBase('https://api.breakside.pro'), true);
    assert.equal(isAllowedApiBase('https://api.breakside.pro/'), true);
});

test('allows dev backends on localhost at any port', () => {
    // scripts/dev-backend.sh picks a free port from 8000 upward.
    for (const u of [
        'http://localhost:8000',
        'http://localhost:8003',
        'http://127.0.0.1:8000',
        'https://localhost:8443',
        'http://[::1]:8000',
    ]) {
        assert.equal(isAllowedApiBase(u), true, u);
    }
});

test('allows LAN addresses for multi-device testing', () => {
    // The phone-against-laptop case the store/sync.js comment describes.
    for (const u of [
        'http://192.168.1.100:8000',
        'http://10.0.0.5:8000',
        'http://172.16.4.2:8000',
        'http://172.31.255.254:8000',
        'http://mylaptop.local:8000',
    ]) {
        assert.equal(isAllowedApiBase(u), true, u);
    }
});

// ── the attack ──────────────────────────────────────────────────────────

test('refuses arbitrary public hosts', () => {
    for (const u of [
        'https://evil.example',
        'http://evil.example:8000',
        'https://collector.attacker.tld/api',
        'https://breakside.pro.evil.example',   // suffix-confusion on the real domain
        'https://api.breakside.pro.evil.example',
        'https://notbreakside.pro',
    ]) {
        assert.equal(isAllowedApiBase(u), false, u);
    }
});

test('refuses credentials-in-URL tricks that only look private', () => {
    // In each of these the real hostname is the attacker's; URL parsing is
    // what makes the difference between reading these correctly and not.
    for (const u of [
        'http://localhost@evil.example',
        'http://127.0.0.1@evil.example:8000',
        'http://localhost:8000@evil.example',
        'https://evil.example#@localhost',
        'https://evil.example/?x=localhost',
    ]) {
        assert.equal(isAllowedApiBase(u), false, u);
    }
});

test('refuses hostnames that merely embed a private-looking prefix', () => {
    for (const u of [
        'http://127.0.0.1.evil.example',
        'http://192.168.1.1.evil.example',
        'http://localhost.evil.example',
        'http://mylaptop.local.evil.example',
    ]) {
        assert.equal(isAllowedApiBase(u), false, u);
    }
});

test('refuses non-http(s) schemes', () => {
    for (const u of [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        'ftp://evil.example',
        'blob:https://evil.example/x',
    ]) {
        assert.equal(isAllowedApiBase(u), false, u);
    }
});

test('refuses junk and non-strings', () => {
    for (const v of ['', '   ', 'not a url', '//evil.example', null, undefined, 123, {}, []]) {
        assert.equal(isAllowedApiBase(v), false, JSON.stringify(v));
    }
});

test('is not fooled by case or by a public 172.x outside the private range', () => {
    assert.equal(isAllowedApiBase('http://LOCALHOST:8000'), true);
    assert.equal(isAllowedApiBase('http://MyLaptop.Local:8000'), true);
    // 172.15 and 172.32 are public — only 172.16–172.31 is RFC1918.
    assert.equal(isAllowedApiBase('http://172.15.0.1:8000'), false);
    assert.equal(isAllowedApiBase('http://172.32.0.1:8000'), false);
});

// ── the landing/ twin must not drift ────────────────────────────────────
//
// landing/ pages are classic scripts and cannot import the module above, so
// landing/apiOrigin.js is a hand-kept copy. Duplicated security logic drifts,
// and the landing join page is the one that ships a bearer token on load — so
// run the copy through the same corpus rather than trusting the comment.

test('landing/apiOrigin.js agrees with utils/apiOrigin.js on every case', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../landing/apiOrigin.js', import.meta.url), 'utf8');

    const fakeWindow = {};
    // The file is an IIFE whose only effect is assigning onto `window`.
    new Function('window', src)(fakeWindow);
    const landingImpl = fakeWindow.BREAKSIDE_IS_ALLOWED_API_BASE;
    assert.equal(typeof landingImpl, 'function', 'landing copy did not define the global');

    const corpus = [
        'https://api.breakside.pro', 'https://api.breakside.pro/',
        'http://localhost:8000', 'http://127.0.0.1:8000', 'https://localhost:8443',
        'http://[::1]:8000', 'http://192.168.1.100:8000', 'http://10.0.0.5:8000',
        'http://172.16.4.2:8000', 'http://mylaptop.local:8000',
        'https://evil.example', 'https://api.breakside.pro.evil.example',
        'http://localhost@evil.example', 'http://127.0.0.1.evil.example',
        'http://localhost.evil.example', 'javascript:alert(1)',
        'data:text/html,x', 'file:///etc/passwd', '//evil.example',
        'http://LOCALHOST:8000', 'http://172.15.0.1:8000', 'http://172.32.0.1:8000',
        '', 'not a url', null, undefined, 123,
    ];

    for (const v of corpus) {
        assert.equal(
            landingImpl(v), isAllowedApiBase(v),
            `landing/apiOrigin.js disagrees on ${JSON.stringify(v)}`,
        );
    }
});
