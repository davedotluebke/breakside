/*
 * Round-trip of the hockey-assist fields on a scoring Throw
 * (Throw.hockeyAssist / hockeyAssistHuck_flag / noHockeyAssist_flag, set by
 * the Score Attribution dialog) through store/storage.js serialize /
 * deserialize, by the same stubbing recipe as setsSerialization.test.mjs.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.alert = () => {};
globalThis.document = { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] };

const { serializeGame, deserializeGame, setCurrentTeam } = await import('../../store/storage.js');
const { Team, Game, Point, Possession, Throw } = await import('../../store/models.js');

const team = new Team('HA Round Trip', ['Alice', 'Bob', 'Cara']);
const [alice, bob, cara] = team.teamRoster;
setCurrentTeam(team);

function roundTripScore(throwOpts) {
    const game = new Game('Us', 'Them', 'offense');
    const point = new Point([alice.name, bob.name, cara.name], 'offense');
    const poss = new Possession(true);
    poss.addEvent(new Throw({ thrower: alice, receiver: bob }));
    poss.addEvent(new Throw({ thrower: bob, receiver: cara, score: true, ...throwOpts }));
    point.addPossession(poss);
    game.points.push(point);
    const json = serializeGame(game);
    const back = deserializeGame(JSON.parse(JSON.stringify(json)));
    return { json, score: back.points[0].possessions[0].events[1] };
}

test('an explicit hockey assist serializes as name + id and resolves back to the roster player', () => {
    const { json, score } = roundTripScore({ hockeyAssist: alice, hockeyAssistHuck: true });
    const raw = json.points[0].possessions[0].events[1];
    assert.equal(raw.hockeyAssist, 'Alice');
    assert.equal(raw.hockeyAssistId, alice.id);
    assert.equal(raw.hockeyAssistHuck_flag, true);
    assert.equal(raw.noHockeyAssist_flag, undefined, 'defaults are not written');
    assert.equal(score.hockeyAssist, alice, 'resolved to the roster Player');
    assert.equal(score.hockeyAssistHuck_flag, true);
    assert.equal(score.noHockeyAssist_flag, false);
});

test('an explicit "none" round-trips as the flag alone', () => {
    const { json, score } = roundTripScore({ noHockeyAssist: true });
    const raw = json.points[0].possessions[0].events[1];
    assert.equal(raw.hockeyAssist, undefined);
    assert.equal(raw.noHockeyAssist_flag, true);
    assert.equal(score.hockeyAssist, null);
    assert.equal(score.noHockeyAssist_flag, true);
});

test('a score with no decision carries neither field, so the stats fallback applies', () => {
    const { json, score } = roundTripScore({});
    const raw = json.points[0].possessions[0].events[1];
    assert.equal(raw.hockeyAssist, undefined);
    assert.equal(raw.noHockeyAssist_flag, undefined);
    assert.equal(score.hockeyAssist, null);
    assert.equal(score.noHockeyAssist_flag, false);
});
