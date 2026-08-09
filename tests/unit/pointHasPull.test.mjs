/*
 * Tests for utils/helpers.js pointHasPull().
 *
 * This predicate is the whole duplicate-pull defense. Two independent paths
 * record the pull for a point — the pull dialog, which opens itself whenever
 * a point starts on defense (game/pointManagement.js), and narration's
 * applyPull — and each checks this before writing so the point ends up with
 * one pull rather than two. If it ever returns a false negative, a coach who
 * both taps and narrates the pull gets a duplicate.
 *
 * helpers.js expects a browser: stub the globals it touches at module load
 * BEFORE importing (same pattern as setsSerialization.test.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
};
globalThis.alert = () => {};
globalThis.document = {
    addEventListener: () => {},
    getElementById: () => null,
    querySelectorAll: () => [],
};

const { pointHasPull } = await import('../../utils/helpers.js');
const { Point, Possession, Pull, Throw } = await import('../../store/models.js');

function pointWith(...possessions) {
    const pt = new Point([], 'defense');
    possessions.forEach(p => pt.addPossession(p));
    return pt;
}

function possessionWith(offensive, ...events) {
    const poss = new Possession(offensive);
    events.forEach(e => poss.addEvent(e));
    return poss;
}

test('a point with no possessions has no pull', () => {
    assert.equal(pointHasPull(pointWith()), false);
});

test('a point whose possessions are empty has no pull', () => {
    assert.equal(pointHasPull(pointWith(new Possession(false))), false);
});

test('a point with only non-pull events has no pull', () => {
    const poss = possessionWith(true, new Throw({ thrower: null, receiver: null }));
    assert.equal(pointHasPull(pointWith(poss)), false);
});

test('a point with a pull in its first possession has a pull', () => {
    const poss = possessionWith(false, new Pull({ puller: null }));
    assert.equal(pointHasPull(pointWith(poss)), true);
});

test('a pull is found in a later possession too', () => {
    // The dialog unshifts the pull into possession 0, but applyPull routes
    // through ensurePossessionExists, which can land it elsewhere — so the
    // scan must not assume position.
    const first = possessionWith(true, new Throw({ thrower: null, receiver: null }));
    const second = possessionWith(false, new Pull({ puller: null }));
    assert.equal(pointHasPull(pointWith(first, second)), true);
});

test('a pull is found when it is not the first event in its possession', () => {
    const poss = possessionWith(false,
        new Throw({ thrower: null, receiver: null }),
        new Pull({ puller: null }));
    assert.equal(pointHasPull(pointWith(poss)), true);
});

test('null / undefined / malformed points are false, not throws', () => {
    // applyPull calls this with getLatestPoint(), which is null before the
    // first point exists.
    assert.equal(pointHasPull(null), false);
    assert.equal(pointHasPull(undefined), false);
    assert.equal(pointHasPull({}), false);
    assert.equal(pointHasPull({ possessions: null }), false);
});

test('possessions with a null events array do not throw', () => {
    assert.equal(pointHasPull({ possessions: [{ events: null }] }), false);
});

test('deserialized-shape events match on type, not instanceof', () => {
    // Points coming back from the server are rebuilt by deserializeEvent;
    // the guard must key on the `type` string so it works either way.
    assert.equal(pointHasPull({ possessions: [{ events: [{ type: 'Pull' }] }] }), true);
    assert.equal(pointHasPull({ possessions: [{ events: [{ type: 'Throw' }] }] }), false);
});
