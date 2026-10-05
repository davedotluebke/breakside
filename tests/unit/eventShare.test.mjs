/*
 * Unit tests for utils/eventShare.js — the pure half of an event share link.
 *
 * The contract under test:
 *  - cards bucket by the event's phases in order, unknown phases go last
 *    under "Unassigned", and an event without phases is one bucket
 *  - a card is final / live / in progress the way the game guest's badge is
 *  - after a poll, exactly the games whose stamp moved are refetched and
 *    the ones no longer listed are dropped
 *  - the ?game= parameter is read strictly and written without losing the
 *    other query parameters
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    groupCardsByPhase, cardStatus, statusLabel, diffEventGames,
    shareGameParam, shareGuestUrl, LIVE_RECENCY_MS,
} = await import('../../utils/eventShare.js');

const card = (id, phase, extra = {}) => ({ id, phase, ...extra });

test('cards bucket by phase in the event\'s order, Unassigned last', () => {
    const cards = [card('a', 'Bracket'), card('b', 'Pool'), card('c', null), card('d', 'Pool'), card('e', 'Old phase')];
    const groups = groupCardsByPhase(cards, ['Pool', 'Bracket', 'Finals']);
    assert.deepEqual(groups.map(g => [g.label, g.games.map(c => c.id), g.unassigned]), [
        ['Pool', ['b', 'd'], false],
        ['Bracket', ['a'], false],
        ['Unassigned', ['c', 'e'], true],
    ]);
});

test('an event without phases is one unlabelled bucket; no cards, no buckets', () => {
    assert.deepEqual(groupCardsByPhase([card('a', 'Pool')], []), [{ label: null, games: [card('a', 'Pool')], unassigned: false }]);
    assert.deepEqual(groupCardsByPhase([], ['Pool']), []);
    assert.deepEqual(groupCardsByPhase(undefined, undefined), []);
});

test('a card is final once ended, live while recently changed, in progress otherwise', () => {
    const now = Date.parse('2026-10-04T15:00:00Z');
    const recent = new Date(now - 5 * 60 * 1000).toISOString();
    const old = new Date(now - LIVE_RECENCY_MS - 1).toISOString();
    assert.equal(cardStatus({ gameEndTimestamp: '2026-10-04T14:00:00Z', updatedAt: recent }, now), 'final');
    assert.equal(cardStatus({ gameEndTimestamp: null, updatedAt: recent }, now), 'live');
    assert.equal(cardStatus({ gameEndTimestamp: null, updatedAt: old }, now), 'stale');
    assert.equal(cardStatus({ gameEndTimestamp: null }, now), 'stale');
    assert.deepEqual(['final', 'live', 'stale'].map(statusLabel), ['Final', 'Live', 'In progress']);
});

test('a poll refetches only the games whose stamp moved and drops unlisted ones', () => {
    const held = { a: '1', b: '2', gone: '9' };
    const fresh = [card('a', null, { version: '1' }), card('b', null, { version: '3' }), card('new', null, { version: '1' })];
    assert.deepEqual(diffEventGames(held, fresh), { fetch: ['b', 'new'], drop: ['gone'] });
    assert.deepEqual(diffEventGames(null, fresh), { fetch: ['a', 'b', 'new'], drop: [] });
    assert.deepEqual(diffEventGames(held, []), { fetch: [], drop: ['a', 'b', 'gone'] });
});

test('the ?game= parameter is read strictly', () => {
    assert.equal(shareGameParam('?share=abc&game=2026-07-01_Riverside_vs_Storm_ab12'), '2026-07-01_Riverside_vs_Storm_ab12');
    assert.equal(shareGameParam('?share=abc'), null);
    assert.equal(shareGameParam('?share=abc&game=..%2F..%2Fetc'), null);
    assert.equal(shareGameParam('?share=abc&game='), null);
});

test('guest URLs keep the other query parameters and toggle the game', () => {
    assert.equal(shareGuestUrl('?api=http%3A%2F%2Flocalhost%3A8000&share=old', 'abc', 'g-1'),
        '/?api=http%3A%2F%2Flocalhost%3A8000&share=abc&game=g-1');
    assert.equal(shareGuestUrl('?share=abc&game=g-1', 'abc', null), '/?share=abc');
    assert.equal(shareGuestUrl('', 'abc', null), '/?share=abc');
});
