/*
 * Pins that nothing sends a browser to /app/.
 *
 * That path is not a route. S3's 404 fallback answers it with index.html,
 * whose relative asset URLs then resolve under /app/ and 404 in turn (each
 * answered with the whole page again), so the app never boots there. It
 * was nonetheless the redirect target of the in-app reset email, the in-app
 * Google sign-in and the invite join page until 2026-09. See
 * docs/dev-notes/password-change.md § Things that bit.
 *
 * Comments may still mention the path by way of warning; only code and
 * markup are checked.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = [
    'auth/auth.js',
    'auth/loginScreen.js',
    'main.js',
    'index.html',
    'landing/landing.js',
    'landing/join.js',
    'landing/join.html',
    'landing/index.html',
];

function withoutComments(source) {
    return source
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('no code or markup points at /app/', () => {
    for (const file of FILES) {
        const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
        const lines = withoutComments(source).split('\n');
        const hits = lines
            .map((line, i) => (line.includes('/app/') ? `${file}:${i + 1}: ${line.trim()}` : null))
            .filter(Boolean);
        assert.deepEqual(hits, [], `still points at /app/:\n${hits.join('\n')}`);
    }
});
