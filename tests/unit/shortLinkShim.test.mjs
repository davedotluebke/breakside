/*
 * Pins the inline <head> short-link shim in index.html — the client half of
 * BOTH short links:
 *
 *   /join/<code>  → /landing/join.html?code=<code>        (added 2026-07-22, 32a51ed)
 *   /view/<hash>  → left alone: the app opens it as a guest session
 *                   (teams/shareGuest.js; until 2026-09 → /viewer/?share=)
 *
 * Why a test at all: on www/staging neither path exists as a route. The S3
 * website config's ErrorDocument serves the PWA's index.html instead, and
 * this shim is what turns that 404-with-app-body into the right page. It
 * runs before the app boots, has no module to import, and can't be reached
 * from the e2e suite's happy paths — so it is exactly the kind of code that
 * silently rots. The server-side halves are pinned separately
 * (test_invite_redeem.py::TestJoinShortLink, test_shares.py::TestViewShortLink).
 *
 * The shim source is EXTRACTED FROM index.html rather than duplicated here,
 * so this test exercises the shipped code, not a copy of it.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(repoRoot, 'index.html'), 'utf8');

/** Pull the shim IIFE out of index.html's <head>. */
function extractShim() {
    const match = html.match(/\(function \(\) \{\s*\n\s*var m = location\.pathname[\s\S]*?\n\s*\}\)\(\);/);
    assert.ok(
        match,
        'Could not find the short-link shim in index.html. If it was intentionally '
        + 'reworded or moved, update this extractor — do not delete the test: it is '
        + 'the only coverage for /join and /view redirects on the static origins.'
    );
    return match[0];
}

const SHIM_SOURCE = extractShim();

/**
 * Run the real shim against a URL, returning the location it redirected to
 * (or null when it left the page alone so the app boots normally).
 */
function resolve(href) {
    const url = new URL(href);
    let replacedWith = null;
    const location = {
        pathname: url.pathname,
        hostname: url.hostname,
        search: url.search,
        replace: (to) => { replacedWith = to; },
    };
    new Function('location', 'URLSearchParams', SHIM_SOURCE)(location, URLSearchParams);
    return replacedWith;
}

// ── /join/<code> — the 2026-07-22 invite-URL fix ────────────────────────

test('invite short link bounces to the canonical join page (same origin)', () => {
    assert.equal(
        resolve('https://www.breakside.pro/join/ABC12'),
        '/landing/join.html?code=ABC12'
    );
    // Staging behaves identically — its bucket gained the SPA ErrorDocument
    // fallback in the same era.
    assert.equal(
        resolve('https://staging.breakside.pro/join/ABC12'),
        '/landing/join.html?code=ABC12'
    );
});

test('invite codes keep their case (redemption is case-insensitive server-side)', () => {
    assert.equal(resolve('https://www.breakside.pro/join/abc12'),
        '/landing/join.html?code=abc12');
});

// ── /view/<hash> — share links ──────────────────────────────────────────

test('share link boots the app from the root with the hash as ?share=', () => {
    // Since 2026-09 the app renders share links itself (teams/shareGuest.js,
    // checked before auth) — but index.html's asset URLs are relative, so it
    // must boot from `/`, not from under /view/. Same origin, every origin.
    for (const host of [
        'www.breakside.pro', 'breakside.pro', 'staging.breakside.pro',
        'www.breakside.us', 'breakside.us', 'luebke.us', 'localhost:3019',
    ]) {
        assert.equal(
            resolve(`https://${host}/view/a8f3e2b1c9d4`),
            '/?share=a8f3e2b1c9d4',
            `wrong redirect for ${host}`
        );
    }
});

test('share link redirect keeps the rest of the query (a dev ?api= override)', () => {
    const to = resolve('http://localhost:3019/view/a8f3e2b1c9d4?api=http://localhost:8005');
    assert.ok(to && to.startsWith('/?'), to);
    const q = new URLSearchParams(to.slice(2));
    assert.equal(q.get('share'), 'a8f3e2b1c9d4');
    assert.equal(q.get('api'), 'http://localhost:8005');
});

// ── everything else must boot the app untouched ─────────────────────────

test('non-short-link paths are left alone', () => {
    for (const path of ['/', '/app/', '/index.html', '/view/', '/join/', '/viewer/']) {
        assert.equal(resolve(`https://www.breakside.pro${path}`), null,
            `${path} should not redirect`);
    }
});

test('malformed codes/hashes do not redirect', () => {
    // Non-alphanumerics and extra segments fall through to the app rather
    // than building a bogus destination URL.
    for (const path of [
        '/view/bad$hash', '/join/bad$code',
        '/view/abc/extra', '/join/abc/extra',
        '/view/viewer.js', '/join/join.js',
    ]) {
        assert.equal(resolve(`https://www.breakside.pro${path}`), null,
            `${path} should not redirect`);
    }
});

test('a trailing slash is tolerated on both links', () => {
    assert.equal(resolve('https://www.breakside.pro/view/a8f3e2b1c9d4/'),
        '/?share=a8f3e2b1c9d4');
    assert.equal(resolve('https://www.breakside.pro/join/ABC12/'),
        '/landing/join.html?code=ABC12');
});
