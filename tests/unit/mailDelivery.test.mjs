import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration, deliverySummary, recipientStatus, recipientWho, REPORTS_EXPECTED_WITHIN_MS } from '../../teams/mailDelivery.js';

const counts = (over = {}) => ({ sent: 53, delivered: 0, delayed: 0, bounced: 0, complaint: 0, rejected: 0, pending: 0, slowestSeconds: null, ...over });

test('fmtDuration: seconds, minutes, hours', () => {
    assert.equal(fmtDuration(0.4), '1 s');
    assert.equal(fmtDuration(40), '40 s');
    assert.equal(fmtDuration(95), '2 min');
    assert.equal(fmtDuration(3600), '1 h');
    assert.equal(fmtDuration(11400), '3 h 10 min');
});

test('deliverySummary: nothing for an untracked row', () => {
    assert.equal(deliverySummary(null), null);
    assert.equal(deliverySummary(undefined, 5), null);
    assert.equal(deliverySummary(counts({ sent: 0 })), null);
});

test('deliverySummary: everyone delivered quickly keeps the row icon', () => {
    assert.deepEqual(deliverySummary(counts({ delivered: 53, slowestSeconds: 4.2 })),
        { text: 'all delivered', icon: null, quiet: false });
});

test('deliverySummary: a slow delivery is called out', () => {
    assert.deepEqual(deliverySummary(counts({ delivered: 53, slowestSeconds: 11400 })),
        { text: 'all delivered, slowest took 3 h 10 min', icon: '⏳', quiet: false });
});

test('deliverySummary: mixed outcome lists each state, failures win the icon', () => {
    const s = deliverySummary(counts({ delivered: 49, delayed: 1, bounced: 1, complaint: 1, pending: 1 }));
    assert.equal(s.text, '49 delivered, 1 delayed, 1 bounced, 1 marked as spam, 1 with no report');
    assert.equal(s.icon, '⚠️');
    assert.equal(deliverySummary(counts({ delivered: 52, delayed: 1 })).icon, '⏳');
    assert.equal(deliverySummary(counts({ delivered: 52, rejected: 1 })).text, '52 delivered, 1 not sent');
});

test('deliverySummary: no report yet is a wait, then a quiet note', () => {
    assert.deepEqual(deliverySummary(counts({ pending: 53 }), 30_000),
        { text: 'waiting for delivery reports', icon: '⏳', quiet: false });
    assert.deepEqual(deliverySummary(counts({ pending: 53 }), REPORTS_EXPECTED_WITHIN_MS + 1),
        { text: 'no delivery reports', icon: null, quiet: true });
});

test('recipientStatus: delivered fast, delivered slow with the reason, and the rest', () => {
    assert.deepEqual(recipientStatus({ status: 'delivered', seconds: 1.8 }), { label: 'Delivered in 2 s', detail: '', tone: 'ok' });
    assert.deepEqual(recipientStatus({ status: 'delivered', seconds: 11400, delay: '421 4.7.0 Try again later' }),
        { label: 'Delivered after 3 h 10 min', detail: 'Their mail server first answered: 421 4.7.0 Try again later', tone: 'slow' });
    assert.deepEqual(recipientStatus({ status: 'delivered', seconds: null }), { label: 'Delivered', detail: '', tone: 'ok' });
    assert.deepEqual(recipientStatus({ status: 'delayed', detail: '421 busy' }), { label: 'Delayed, still trying', detail: '421 busy', tone: 'wait' });
    assert.deepEqual(recipientStatus({ status: 'bounced', detail: 'hard: 550 no such user' }), { label: 'Bounced', detail: 'hard: 550 no such user', tone: 'bad' });
    assert.equal(recipientStatus({ status: 'complaint' }).tone, 'bad');
    assert.equal(recipientStatus({ status: 'rejected', detail: 'Bad content' }).label, 'Not sent');
    assert.deepEqual(recipientStatus({ status: 'pending' }), { label: 'No report yet', detail: '', tone: 'wait' });
});

// Fictional names per ARCHITECTURE.md § Names in examples.
test('recipientWho: role and players, several carriers, nobody', () => {
    assert.equal(recipientWho([{ name: 'Gran Q', kind: 'guardian', playerNames: ['Dana', 'Alice'] }]), 'Gran Q (parent of Dana, Alice)');
    assert.equal(recipientWho([{ name: 'Coach Alex', kind: 'coach', playerNames: [] }, { name: 'Alex', kind: 'guardian', playerNames: [] }]),
        'Coach Alex (coach) / Alex (parent)');
    assert.equal(recipientWho([{ name: 'Bob', kind: 'player', playerNames: [] }, { name: 'Venue', kind: 'other' }]), 'Bob (player) / Venue');
    assert.equal(recipientWho([]), '');
    assert.equal(recipientWho(undefined), '');
});
