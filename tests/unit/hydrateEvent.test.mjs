/*
 * store/models.js hydrateEvent / hydrateGame — serialized JSON → model
 * instances for surfaces that cannot use the device-roster deserializer
 * (the public share viewer's replay, docs/replay-viewer-plan.md).
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hydrateEvent, hydrateGame, Throw, Pull, Event } from '../../store/models.js';
import { buildGameLogEntries } from '../../utils/gameLogRenderer.js';
import { createReplayEngine } from '../../playByPlay/replayEngine.js';

const rawThrow = { type: 'Throw', thrower: 'Alice', throwerId: 'Alice-1a2b', receiver: 'Bob', receiverId: 'Bob-3c4d',
    huck_flag: true, score_flag: true, from: { x: .2, y: .5 }, to: { x: 1.05, y: .5 }, at: 1700000000000 };

test('hydrateEvent builds the right class with {name, id} player refs and keeps flags / locations / at', () => {
    const t = hydrateEvent(rawThrow);
    assert.ok(t instanceof Throw);
    assert.deepEqual(t.thrower, { name: 'Alice', id: 'Alice-1a2b' });
    assert.deepEqual(t.receiver, { name: 'Bob', id: 'Bob-3c4d' });
    assert.equal(t.throwerId, undefined, 'id fields fold into the refs');
    assert.equal(t.huck_flag, true); assert.equal(t.score_flag, true);
    assert.deepEqual(t.to, { x: 1.05, y: .5 });
    assert.equal(t.at, 1700000000000);
    assert.equal(t.summarize(), 'Alice hucks to Bob for the score!');
    assert.equal(rawThrow.thrower, 'Alice', 'input not mutated');
});

test('hydrateEvent: absent refs stay null, assist only when present, ids resolve to names via the hook', () => {
    const turn = hydrateEvent({ type: 'Turnover', throwaway_flag: true, thrower: 'Cara' });
    assert.deepEqual(turn.thrower, { name: 'Cara', id: null });
    assert.equal(turn.receiver, null);
    const d = hydrateEvent({ type: 'Defense', block_flag: true });
    assert.equal(d.defender, null);
    assert.match(d.summarize(), /Unforced turnover|Defensive play|Block/);
    const t = hydrateEvent({ type: 'Throw', throwerId: 'Dev-9z9z', receiver: 'Eve' }, (id, name) => name || (id === 'Dev-9z9z' ? 'Dev' : null));
    assert.deepEqual(t.thrower, { name: 'Dev', id: 'Dev-9z9z' });
    assert.equal(t.assist, null);
    const scored = hydrateEvent({ ...rawThrow, assist: 'Finn' });
    assert.deepEqual(scored.assist, { name: 'Finn', id: null });
});

test('hydrateEvent: legacy dump_flag aliases to reset, unknown types degrade to a generic Event', () => {
    const t = hydrateEvent({ type: 'Throw', thrower: 'A', receiver: 'B', dump_flag: true });
    assert.equal(t.reset_flag, true); assert.equal('dump_flag' in t, false);
    assert.equal(t.summarize(), 'A throws a reset to B ');   // summarize()'s trailing space is the log format
    const u = hydrateEvent({ type: 'Mystery', foo: 1 });
    assert.ok(u instanceof Event); assert.equal(u.type, 'Mystery'); assert.equal(u.summarize(), 'Event of type: Mystery');
    assert.equal(hydrateEvent(null), null);
});

test('hydrateGame feeds buildGameLogEntries and the replay engine like a deserialized game', () => {
    const raw = {
        team: 'Us', opponent: 'Them', scores: { team: 1, opponent: 0 },
        points: [{
            players: ['Alice', 'Bob'], startingPosition: 'defense', winner: 'team', endTimestamp: '2026-09-04T18:00:40Z',
            possessions: [
                { offensive: false, startedAt: 1700000000000, events: [
                    { type: 'Pull', puller: 'Alice', from: { x: 0, y: .5 }, to: { x: .8, y: .4 }, hang: 1500, at: 1700000000000 },
                    { type: 'Defense', defender: 'Bob', block_flag: true, to: { x: .5, y: .5 }, at: 1700000021000 },
                ] },
                { offensive: true, startedAt: 1700000021500, events: [rawThrow] },
            ],
        }],
    };
    const game = hydrateGame(raw);
    assert.notEqual(game, raw); assert.notEqual(game.points[0], raw.points[0]);
    assert.ok(game.points[0].possessions[0].events[0] instanceof Pull);
    assert.equal(raw.points[0].possessions[0].events[0].type, 'Pull', 'raw untouched');
    const entries = buildGameLogEntries(game, { teamName: 'Us', opponentName: 'Them' });
    const texts = entries.map(e => e.text);
    assert.ok(texts.includes('Pull by Alice (1.5s hang)'), texts.join('|'));
    assert.ok(texts.includes('Alice hucks to Bob for the score!'));
    const eng = createReplayEngine(game, { teamName: 'Us', opponentName: 'Them' });
    assert.equal(eng.gameHasLocations(), true);
    const last = eng.entries.length - 1;
    const st = eng.fieldStateAt(eng.entries.findIndex(e => e.event && e.event.type === 'Throw'));
    assert.deepEqual(st.players.Bob, { x: 1.05, y: .5 });
    assert.equal(st.holder, 'Bob');
    assert.ok(eng.pointSummaries()[0].startAt === 1700000000000);
    assert.ok(last > 0);
});
