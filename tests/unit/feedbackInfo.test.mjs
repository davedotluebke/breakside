/*
 * Give Feedback's pure half: the diagnostics block, the mailto: fallback, and
 * the wording of a failed send.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    FEEDBACK_EMAIL, MAILTO_MAX_CHARS,
    buildDiagnostics, formatDiagnostics, buildMailtoUrl, describeFailure,
} from '../../utils/feedbackInfo.js';

const SNAPSHOT = {
    version: '2.29.0', build: '1234', deployLabel: null,
    host: 'www.breakside.pro', standalone: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    viewport: { width: 390, height: 844, dpr: 3 },
    online: true, screen: 'game',
    team: { name: 'Alice Team', id: 'Alice-Team-7f3a' }, role: 'coach',
    game: { id: '2026-11-20_Alice-Team_vs_Bob-Team_1', us: 7, them: 5, points: 12, ended: false },
    pendingSync: 2, quarantinedSync: 0,
    now: new Date('2026-11-20T18:30:00Z'), timeZone: 'America/Denver',
};

test('diagnostics carry what a report needs, in a fixed order', () => {
    const d = buildDiagnostics(SNAPSHOT);
    assert.deepEqual(Object.keys(d), [
        'App', 'Site', 'Running as', 'Device', 'Viewport', 'Online', 'Screen',
        'Team', 'Role', 'Game', 'Score', 'Unsynced changes', 'Local time',
    ]);
    assert.equal(d.App, '2.29.0 (build 1234)');
    assert.equal(d['Running as'], 'installed app');
    assert.equal(d.Viewport, '390x844 @3x');
    assert.equal(d.Team, 'Alice Team (Alice-Team-7f3a)');
    assert.equal(d.Score, '7-5 after 12 points');
    assert.equal(d['Unsynced changes'], '2');
    assert.equal(d['Local time'], '2026-11-20T18:30:00.000Z (America/Denver)');
});

test('a staging deploy label and an ended game say so', () => {
    const d = buildDiagnostics({
        ...SNAPSHOT, deployLabel: 'feedback v1',
        game: { ...SNAPSHOT.game, points: 1, ended: true }, quarantinedSync: 3,
    });
    assert.equal(d.App, '2.29.0 (build 1234) [feedback v1]');
    assert.equal(d.Score, '7-5 after 1 point, ended');
    assert.equal(d['Unsynced changes'], '2 (3 set aside after errors)');
});

test('missing state is left out rather than reported as blank', () => {
    const d = buildDiagnostics({ version: '2.29.0', team: null, game: null, now: new Date('nope') });
    assert.deepEqual(d, { App: '2.29.0' });
    assert.deepEqual(buildDiagnostics(), {});
});

test('formatDiagnostics is one line per entry', () => {
    assert.equal(formatDiagnostics({ App: '2.29.0', Online: 'yes' }), 'App: 2.29.0\nOnline: yes');
    assert.equal(formatDiagnostics({}), '');
});

test('the mailto link carries the message and the diagnostics', () => {
    const d = buildDiagnostics(SNAPSHOT);
    const url = buildMailtoUrl('Undo moved the score backwards', d);
    assert.ok(url.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=Breakside%20feedback&body=`));
    const body = decodeURIComponent(url.split('&body=')[1]);
    assert.ok(body.startsWith('Undo moved the score backwards\n\n---\nApp: 2.29.0 (build 1234)\n'));
    assert.ok(body.includes('Game: 2026-11-20_Alice-Team_vs_Bob-Team_1'));
});

test('an empty message still opens a mail with the diagnostics', () => {
    const body = decodeURIComponent(buildMailtoUrl('', { App: '2.29.0' }).split('&body=')[1]);
    assert.equal(body, '---\nApp: 2.29.0');
    assert.equal(buildMailtoUrl('', {}), `mailto:${FEEDBACK_EMAIL}?subject=Breakside%20feedback`);
});

test('a long report drops diagnostics before it cuts the message', () => {
    const d = buildDiagnostics({ ...SNAPSHOT, userAgent: 'x'.repeat(900) });
    const message = 'm'.repeat(1000);
    const url = buildMailtoUrl(message, d);
    assert.ok(url.length <= MAILTO_MAX_CHARS);
    const body = decodeURIComponent(url.split('&body=')[1]);
    assert.equal(body, `${message}\n\n---\nApp: 2.29.0 (build 1234)`);
});

test('a message too long for any mailto link is shortened to fit', () => {
    const url = buildMailtoUrl('🥏 '.repeat(2000), buildDiagnostics(SNAPSHOT));
    assert.ok(url.length <= MAILTO_MAX_CHARS);
    assert.ok(decodeURIComponent(url.split('&body=')[1]).endsWith('…'));
});

test('failure wording', () => {
    assert.match(describeFailure({ offline: true }), /offline/);
    assert.equal(describeFailure({ status: 429, detail: 'Slow down.' }), 'Slow down.');
    assert.equal(describeFailure({ status: 400, detail: 'Please write a message.' }), 'Please write a message.');
    assert.match(describeFailure({ status: 401 }), /sign-in/);
    assert.match(describeFailure({ status: 502 }), /right now/);
    assert.match(describeFailure({ status: 429 }), /right now/);   // no detail: the generic line
});
