/*
 * Event `at` / Possession `startedAt` timestamps (replay viewer step 1,
 * docs/replay-viewer-plan.md): stamped at record time, round-tripped through
 * store/storage.js, and never invented for legacy data.
 *
 * storage.js expects a browser: stub the handful of globals it touches at
 * module load BEFORE importing (same recipe as setsSerialization.test.mjs).
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

const { serializeGame, deserializeGame } = await import('../../store/storage.js');
const { Game, Point, Possession, Throw, Pull, Defense, stampEvent } = await import('../../store/models.js');

function gameWith(possessions) {
    const game = new Game('Us', 'Them', 'offense');
    const point = new Point(['Alice', 'Bob'], 'offense');
    point.possessions.push(...possessions);
    game.points.push(point);
    return game;
}

test('a freshly constructed event has at = null', () => {
    assert.equal(new Throw({}).at, null);
    assert.equal(new Pull({}).at, null);
    assert.equal(new Defense({}).at, null);
});

test('Possession.addEvent stamps at with the current time', () => {
    const before = Date.now();
    const poss = new Possession(true);
    const evt = new Throw({});
    poss.addEvent(evt);
    const after = Date.now();
    assert.equal(typeof evt.at, 'number');
    assert.ok(evt.at >= before && evt.at <= after);
});

test('stampEvent keeps an existing at (idempotent)', () => {
    const evt = new Throw({});
    evt.at = 1234567890123;
    stampEvent(evt);
    assert.equal(evt.at, 1234567890123);
    const poss = new Possession(true);
    poss.addEvent(evt);
    assert.equal(evt.at, 1234567890123);
});

test('a new Possession records startedAt', () => {
    const before = Date.now();
    const poss = new Possession(false);
    assert.ok(poss.startedAt >= before && poss.startedAt <= Date.now());
});

test('at and startedAt round-trip through game serialization', () => {
    const poss = new Possession(true);
    poss.startedAt = 1700000000000;
    const evt = new Throw({});
    evt.at = 1700000005000;
    poss.addEvent(evt);

    const back = deserializeGame(serializeGame(gameWith([poss])));
    assert.equal(back.points[0].possessions[0].startedAt, 1700000000000);
    assert.equal(back.points[0].possessions[0].events[0].at, 1700000005000);
});

test('serialized JSON carries at only when set', () => {
    const stamped = new Possession(true);
    stamped.addEvent(new Throw({}));
    const data = serializeGame(gameWith([stamped]));
    assert.equal(typeof data.points[0].possessions[0].events[0].at, 'number');

    // An event that somehow has no stamp serializes without the key at all
    // (serializeEvent diffs against a default instance, whose at is null).
    const bare = new Possession(true);
    bare.events.push(new Throw({}));
    const data2 = serializeGame(gameWith([bare]));
    assert.equal('at' in data2.points[0].possessions[0].events[0], false);
});

test('legacy JSON without timestamps deserializes to null, never to load time', () => {
    const poss = new Possession(true);
    poss.addEvent(new Throw({}));
    const data = serializeGame(gameWith([poss]));
    delete data.points[0].possessions[0].startedAt;
    delete data.points[0].possessions[0].events[0].at;

    const back = deserializeGame(data);
    assert.equal(back.points[0].possessions[0].startedAt, null);
    assert.equal(back.points[0].possessions[0].events[0].at, null);
});
