import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, looksLikeAddress, matches, contactFields, playerFields, highlight, joinLabels } from '../../teams/mailSearch.js';

// Fictional roster per ARCHITECTURE.md § Names in examples.
const roster = [{ id: 'Dana-1a2b', name: 'Dana' }, { id: 'Alice-7f3a', name: 'Alice' }];
const gran = {
    id: 'mc_1', kind: 'guardian', name: 'Gran Q',
    emails: ['gran.q@example.org', 'steve.r@example.org'], email: 'gran.q@example.org',
    playerIds: ['Dana-1a2b'], notes: 'carpools from the north side',
};

test('tokens: lowercases, splits on any whitespace, ignores blanks', () => {
    assert.deepEqual(tokens('  Gran   Q '), ['gran', 'q']);
    assert.deepEqual(tokens(''), []);
    assert.deepEqual(tokens(null), []);
});

test('looksLikeAddress: one address, with surrounding space; not a name or a fragment', () => {
    assert.equal(looksLikeAddress(' Eve@Example.org '), true);
    assert.equal(looksLikeAddress('eve'), false);
    assert.equal(looksLikeAddress('eve@'), false);
    assert.equal(looksLikeAddress('a@b.c d@e.f'), false);
});

test('a second address on a contact named for someone else is found by a fragment of it', () => {
    const fields = contactFields(gran, roster, 'Parent / guardian');
    assert.equal(matches(fields, 'steve'), true);
    assert.equal(matches(fields, 'STEVE.R@example.org'), true);
    assert.equal(matches(fields, 'gran.q'), true);
});

test('name, linked player, role label and notes all count; every token must land somewhere', () => {
    const fields = contactFields(gran, roster, 'Parent / guardian');
    assert.equal(matches(fields, 'dana'), true);            // linked player, not on the contact itself
    assert.equal(matches(fields, 'guardian'), true);        // role label
    assert.equal(matches(fields, 'carpool'), true);         // notes
    assert.equal(matches(fields, 'gran dana'), true);       // tokens across fields
    assert.equal(matches(fields, 'gran alice'), false);     // one token with no home
    assert.equal(matches(fields, ''), true);                // blank query matches everything
});

test('contactFields tolerates the legacy single-email shape and missing players', () => {
    const legacy = { name: 'Uncle', email: 'uncle@example.org', playerIds: ['Gone-0000'] };
    assert.deepEqual(contactFields(legacy, roster), ['Uncle', 'uncle@example.org', 'Gone-0000']);
});

test('player rows match on name, alias, address, own email and guardian names', () => {
    const player = { id: 'Dana-1a2b', name: 'Dana', alias: 'dana', address: 'dana-cudo@example.org' };
    const contact = { kind: 'player', alias: 'dana', emails: ['dq@example.org'], email: 'dq@example.org' };
    const fields = playerFields(player, contact, ['Gran Q']);
    for (const q of ['dan', 'dana-cudo', 'dq@', 'gran q']) assert.equal(matches(fields, q), true, q);
    assert.equal(matches(fields, 'alice'), false);
    assert.deepEqual(playerFields({ name: 'New Kid' }, null, []), ['New Kid']);
});

test('highlight wraps every token hit, merges adjacent hits, and escapes', () => {
    assert.equal(highlight('steve.r@example.org', 'eve'), 'st<mark class="mail-hit">eve</mark>.r@example.org');
    assert.equal(highlight('Eve P <eve@x>', 'eve'), '<mark class="mail-hit">Eve</mark> P &lt;<mark class="mail-hit">eve</mark>@x&gt;');
    assert.equal(highlight('aaa', 'aa'), '<mark class="mail-hit">aaa</mark>');            // overlapping hits merge
    assert.equal(highlight('Gran Q', 'gran q'), '<mark class="mail-hit">Gran</mark> <mark class="mail-hit">Q</mark>');
    assert.equal(highlight('plain', 'zzz'), 'plain');
    assert.equal(highlight('a & b', ''), 'a &amp; b');
});

test('joinLabels reads as a sentence', () => {
    assert.equal(joinLabels([]), '');
    assert.equal(joinLabels(['Parents']), 'Parents');
    assert.equal(joinLabels(['Everyone', 'Parents']), 'Everyone and Parents');
    assert.equal(joinLabels(['Everyone', 'Parents', "Dana's address"]), "Everyone, Parents and Dana's address");
});
