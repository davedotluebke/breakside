/*
 * Unit tests for utils/deepLink.js — the `/?open=<screen>&team=<id>` links
 * the held-mail notice mints (breakside_server/mail/relay.py review_url).
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDeepLink, stripDeepLink } from '../../utils/deepLink.js';

test('parses the held-mail notice link', () => {
    assert.deepEqual(parseDeepLink('?open=mail&team=Velvet-Revolution-7f3a'),
        { screen: 'mail', teamId: 'Velvet-Revolution-7f3a' });
    // With or without the leading '?', and in either order.
    assert.deepEqual(parseDeepLink('team=Cudo-ab12&open=mail'), { screen: 'mail', teamId: 'Cudo-ab12' });
});

test('is null for anything else', () => {
    assert.equal(parseDeepLink(''), null);
    assert.equal(parseDeepLink('?api=http://localhost:8000'), null);
    assert.equal(parseDeepLink('?open=mail'), null);                 // no team
    assert.equal(parseDeepLink('?team=Cudo-ab12'), null);            // no screen
    assert.equal(parseDeepLink('?open=settings&team=Cudo-ab12'), null); // unknown screen
    assert.equal(parseDeepLink('?open=mail&team=../x'), null);       // not an id
    assert.equal(parseDeepLink('?open=mail&team=<script>'), null);
    assert.equal(parseDeepLink(`?open=mail&team=${'a'.repeat(65)}`), null);
});

test('strips only its own keys', () => {
    assert.equal(stripDeepLink('?open=mail&team=Cudo-ab12'), '');
    assert.equal(stripDeepLink('?api=http%3A%2F%2Flocalhost%3A8000&open=mail&team=Cudo-ab12'),
        '?api=http%3A%2F%2Flocalhost%3A8000');
    assert.equal(stripDeepLink(''), '');
    assert.equal(stripDeepLink('?testMode=true'), '?testMode=true');
});
