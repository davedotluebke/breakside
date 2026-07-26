/*
 * Round-trip tests for the per-possession set tagging schema
 * (Team.setsEnabled / Team.sets, Possession.set) through
 * store/storage.js serialize/deserialize.
 *
 * storage.js expects a browser: stub the handful of globals it touches at
 * module load (localStorage read, window survivors) BEFORE importing.
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

const { serializeTeam, deserializeTeams, serializeGame, deserializeGame } =
    await import('../../store/storage.js');
const { Team, Game, Point, Possession } = await import('../../store/models.js');

function roundTripTeam(team) {
    return deserializeTeams(JSON.stringify([JSON.parse(serializeTeam(team))]))[0];
}

test('Team defaults: sets disabled with empty lists', () => {
    const team = new Team('Sets Test Team', []);
    assert.equal(team.setsEnabled, false);
    assert.deepEqual(team.sets, { offensive: [], defensive: [] });
});

test('Team round-trip preserves setsEnabled and label lists', () => {
    const team = new Team('Sets Test Team', []);
    team.setsEnabled = true;
    team.sets = { offensive: ['Vert', 'Ho'], defensive: ['Zone', 'Match'] };

    const back = roundTripTeam(team);
    assert.equal(back.setsEnabled, true);
    assert.deepEqual(back.sets, { offensive: ['Vert', 'Ho'], defensive: ['Zone', 'Match'] });
});

test('Legacy team JSON without sets fields deserializes to defaults', () => {
    const team = new Team('Legacy Team', []);
    const legacy = JSON.parse(serializeTeam(team));
    delete legacy.setsEnabled;
    delete legacy.sets;

    const back = deserializeTeams(JSON.stringify([legacy]))[0];
    assert.equal(back.setsEnabled, false);
    assert.deepEqual(back.sets, { offensive: [], defensive: [] });
});

test('Possession.set round-trips through game serialization', () => {
    const game = new Game('Us', 'Them', 'offense');
    const point = new Point(['Alice', 'Bob'], 'offense');
    const tagged = new Possession(false, 'Zone');
    const untagged = new Possession(true);
    point.possessions.push(tagged, untagged);
    game.points.push(point);

    const back = deserializeGame(serializeGame(game));
    assert.equal(back.points[0].possessions[0].set, 'Zone');
    assert.equal(back.points[0].possessions[1].set, null);
});

test('Legacy possession JSON without set deserializes to null', () => {
    const game = new Game('Us', 'Them', 'offense');
    const point = new Point(['Alice'], 'offense');
    point.possessions.push(new Possession(true));
    game.points.push(point);

    const data = serializeGame(game);
    data.points[0].possessions.forEach(p => delete p.set);

    const back = deserializeGame(data);
    assert.equal(back.points[0].possessions[0].set, null);
});
