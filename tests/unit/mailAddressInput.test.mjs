import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmailList } from '../../teams/mailAddressInput.js';

test('splits on commas, semicolons and whitespace; lowercases; dedupes; keeps order', () => {
    const r = parseEmailList(' Mom@Example.org, dad@example.org;mom@example.org\n gran@example.org ');
    assert.deepEqual(r.valid, ['mom@example.org', 'dad@example.org', 'gran@example.org']);
    assert.deepEqual(r.invalid, []);
    assert.equal(r.normalized, 'mom@example.org, dad@example.org, gran@example.org');
});

test('reports malformed entries as typed and keeps the good ones', () => {
    const r = parseEmailList('mom@example.org, not-an-address, dad@example, @x.org, ok@y.co');
    assert.deepEqual(r.valid, ['mom@example.org', 'ok@y.co']);
    assert.deepEqual(r.invalid, ['not-an-address', 'dad@example', '@x.org']);
});

test('empty and null input parse to nothing', () => {
    for (const v of ['', '   ', null, undefined, ', ;']) {
        assert.deepEqual(parseEmailList(v), { valid: [], invalid: [], normalized: '' });
    }
});
