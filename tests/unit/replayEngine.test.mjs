/*
 * playByPlay/replayEngine.js — pure replay core (docs/replay-viewer-plan.md
 * step 3): the pacing table, live/pap, cap = Off, mixed timed/untimed data,
 * the collapse rule, and field-state derivation per event type.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReplayEngine } from '../../playByPlay/replayEngine.js';
import { Throw, Turnover, Defense, Pull } from '../../store/models.js';

const P = Object.fromEntries(['Alice', 'Bob', 'Cara', 'Dev'].map(n => [n, { name: n, id: n.toLowerCase() }]));
const roster = Object.keys(P);
const OPTS = { teamName: 'Us', opponentName: 'Them' };
const at = (e, t) => { e.at = t; return e; };
const point = (over) => Object.assign({ players: roster, startingPosition: 'defense', winner: '', possessions: [] }, over);
const poss = (offensive, events, startedAt = null) => ({ offensive, events, startedAt });
const game = (points, over) => Object.assign({ team: 'Us', opponent: 'Them', startingPosition: 'defense', points }, over);

/** D point: pull, block, two throws, score — every event timed and located. */
function locatedPoint(t0 = 100000) {
    return point({
        winner: 'team', endTimestamp: new Date(t0 + 40000),
        possessions: [
            poss(false, [
                at(new Pull({ puller: P.Alice, quality: 'Good Pull', from: { x: 0, y: .5 }, to: { x: .82, y: .38 } }), t0),
                at(new Defense({ defender: P.Bob, block: true, to: { x: .58, y: .68 } }), t0 + 21000),
            ], t0),
            poss(true, [
                at(new Throw({ thrower: P.Bob, receiver: P.Cara, reset: true, from: { x: .58, y: .68 }, to: { x: .52, y: .42 } }), t0 + 27000),
                at(new Throw({ thrower: P.Cara, receiver: P.Dev, huck: true, from: { x: .52, y: .42 }, to: { x: .86, y: .55 } }), t0 + 31500),
                at(new Throw({ thrower: P.Dev, receiver: P.Alice, score: true, from: { x: .86, y: .55 }, to: { x: 1.06, y: .5 } }), t0 + 36000),
            ], t0 + 21500),
        ],
    });
}
/** Legacy O point: no timestamps, no locations. */
function legacyPoint() {
    return point({
        startingPosition: 'offense', winner: 'team',
        possessions: [poss(true, [
            new Throw({ thrower: P.Alice, receiver: P.Bob }),
            new Throw({ thrower: P.Bob, receiver: P.Cara, score: true }),
        ])],
    });
}

const kinds = eng => eng.entries.map(e => e.kind);
const idxOf = (eng, pred) => eng.entries.findIndex(pred);

test('entries mirror buildGameLogEntries and point ranges index them', () => {
    const eng = createReplayEngine(game([legacyPoint(), locatedPoint()]), OPTS);
    assert.equal(kinds(eng)[0], 'header');
    assert.deepEqual(eng.pointRange(0), { first: 2, last: idxOf(eng, e => e.kind === 'currentscore') });
    assert.equal(eng.pointOf(0), null);
    assert.equal(eng.pointOf(2), 0);
    assert.equal(eng.pointRange(5), null);
});

test('hasLocations / gameHasLocations drive the collapse rule', () => {
    const eng = createReplayEngine(game([legacyPoint(), locatedPoint()]), OPTS);
    assert.equal(eng.hasLocations(0), false);
    assert.equal(eng.hasLocations(1), true);
    assert.equal(eng.gameHasLocations(), true);
    assert.equal(createReplayEngine(game([legacyPoint()]), OPTS).gameHasLocations(), false);
});

test('pacing: timed gaps divide by speed and clip to the within/between caps', () => {
    const eng = createReplayEngine(game([locatedPoint(0), locatedPoint(90000)]), OPTS);
    const block = idxOf(eng, e => e.kind === 'event' && e.event.type === 'Defense');
    // pull at 0 → possession delimiter (opp, startedAt 0)… the block is 21 s after the pull
    assert.equal(eng.entries[block].at, 21000);
    assert.equal(eng.delayBefore(block), 4000);                     // capped at capWithinMs
    eng.setOptions({ speed: 2 }); assert.equal(eng.delayBefore(block), 2000);
    eng.setOptions({ speed: 4 }); assert.equal(eng.delayBefore(block), 1000);
    eng.setOptions({ speed: 1, capWithinMs: 0 }); assert.equal(eng.delayBefore(block), 21000);   // Off
    // a short real gap is not padded up to the cap
    eng.setOptions({ capWithinMs: 4000 });
    const throw2 = idxOf(eng, e => e.kind === 'event' && e.event.huck_flag);
    assert.equal(eng.delayBefore(throw2), 4000);                    // 4.5 s real gap, clipped
    // between points: the second roster line is 50 s after point 1's last timed line (score at 40 s)
    const roster2 = eng.pointRange(1).first;
    assert.equal(eng.entries[roster2].kind, 'roster');
    assert.equal(eng.delayBefore(roster2), 8000);
    eng.setOptions({ capBetweenMs: 0 }); assert.equal(eng.delayBefore(roster2), 50000);
});

test('pacing: the animation floor wins over a short gap', () => {
    const eng = createReplayEngine(game([locatedPoint(0)]), OPTS);
    const block = idxOf(eng, e => e.kind === 'event' && e.event.type === 'Defense');
    assert.equal(eng.delayBefore(block, 6000), 6000);
    eng.setOptions({ speed: 'live' });
    assert.equal(eng.delayBefore(block, 700), 700);
    assert.equal(eng.delayBefore(block), 0);
});

test('pacing: play-after-play and untimed neighbours use the hold, never a synthesized gap', () => {
    const eng = createReplayEngine(game([legacyPoint(), locatedPoint(50000)]), OPTS);
    const legacyThrow = idxOf(eng, e => e.kind === 'event');
    assert.equal(eng.entries[legacyThrow].at, null);
    assert.equal(eng.delayBefore(legacyThrow, 300), 900);
    // first timed entry after an untimed one is still "untimed" relative to its predecessor
    const roster2 = eng.pointRange(1).first;
    assert.equal(eng.entries[roster2 - 1].at, null);
    assert.equal(eng.delayBefore(roster2), 600);
    eng.setOptions({ speed: 'pap' });
    const block = idxOf(eng, e => e.kind === 'event' && e.event.type === 'Defense');
    assert.equal(eng.delayBefore(block, 500), 1100);
    assert.equal(eng.delayBefore(0), 600);
});

test('field state: pull, block, throws, score', () => {
    const eng = createReplayEngine(game([locatedPoint(0)]), OPTS);
    const E = eng.entries;
    const i = pred => idxOf(eng, pred);

    const atRoster = eng.fieldStateAt(eng.pointRange(0).first);
    assert.deepEqual(atRoster.roster, roster);
    assert.deepEqual(Object.values(atRoster.players), [null, null, null, null]);
    assert.equal(atRoster.disc, null);
    assert.equal(atRoster.who, null);

    const pull = i(e => e.kind === 'event' && e.event.type === 'Pull');
    let st = eng.fieldStateAt(pull);
    assert.deepEqual(st.players.Alice, { x: 0, y: .5 });
    assert.deepEqual(st.disc, { x: .82, y: .38 });
    assert.equal(st.holder, null);
    assert.equal(st.arrows.length, 1); assert.equal(st.arrows[0].kind, 'pull');

    assert.equal(E[pull - 1].kind, 'possession');   // "— Us on defense —" precedes the pull
    assert.equal(eng.fieldStateAt(pull - 1).who, 'opp');
    assert.equal(st.who, 'opp');

    const block = i(e => e.kind === 'event' && e.event.type === 'Defense');
    st = eng.fieldStateAt(block);
    assert.deepEqual(st.players.Bob, { x: .58, y: .68 });
    assert.deepEqual(st.disc, { x: .58, y: .68 });
    assert.equal(st.holder, null);            // a block leaves no holder
    assert.equal(st.spots.length, 1);

    const reset = i(e => e.kind === 'event' && e.event.reset_flag);
    st = eng.fieldStateAt(reset);
    assert.equal(st.who, 'us');
    assert.equal(st.holder, 'Cara');
    assert.deepEqual(st.players.Cara, { x: .52, y: .42 });
    assert.equal(st.arrows.length, 2);
    assert.equal(st.arrows[1].poss, 2);       // second possession delimiter of the point

    const score = i(e => e.kind === 'score');
    st = eng.fieldStateAt(score);
    assert.equal(st.goal, true);
    assert.equal(st.who, null);
    assert.equal(st.arrows[st.arrows.length - 1].kind, 'score');
    assert.deepEqual(st.players.Alice, { x: 1.06, y: .5 });   // moved from the pull spot to the catch
});

test('field state: interception holds; turnover flips the disc; unlocated events move nobody', () => {
    const t = 1000;
    const pt = point({
        possessions: [
            poss(false, [at(new Defense({ defender: P.Bob, interception: true, to: { x: .4, y: .3 } }), t)]),
            poss(true, [
                at(new Throw({ thrower: P.Bob, receiver: P.Cara }), t + 1000),                       // no locations
                at(new Turnover({ thrower: P.Cara, throwaway: true, from: { x: .4, y: .3 }, to: { x: .9, y: .1 } }), t + 2000),
            ]),
        ],
    });
    const eng = createReplayEngine(game([pt]), OPTS);
    const int = idxOf(eng, e => e.kind === 'event');
    let st = eng.fieldStateAt(int);
    assert.equal(st.holder, 'Bob');
    const throwIdx = idxOf(eng, e => e.kind === 'event' && e.event.type === 'Throw');
    st = eng.fieldStateAt(throwIdx);
    assert.equal(st.holder, 'Cara');                 // attribution known…
    assert.equal(st.players.Cara, null);             // …position not
    assert.deepEqual(st.disc, { x: .4, y: .3 });     // disc stays where it was
    const turn = idxOf(eng, e => e.kind === 'event' && e.event.type === 'Turnover');
    st = eng.fieldStateAt(turn);
    assert.equal(st.holder, null);
    assert.deepEqual(st.disc, { x: .9, y: .1 });
    assert.equal(st.arrows[st.arrows.length - 1].kind, 'turn');
    st = eng.fieldStateAt(turn + 1);                 // inline "— Us on defense —"
    assert.equal(st.who, 'opp');
});

test('field state: a new point resets everyone; header entries have no point', () => {
    const eng = createReplayEngine(game([locatedPoint(0), locatedPoint(90000)]), OPTS);
    assert.equal(eng.fieldStateAt(0).pointIdx, null);
    const r2 = eng.pointRange(1).first;
    const st = eng.fieldStateAt(r2);
    assert.equal(st.pointIdx, 1);
    assert.deepEqual(Object.values(st.players), [null, null, null, null]);
    assert.equal(st.arrows.length, 0);
});

test('resolvePlayerName maps id-era rosters for the strip', () => {
    const pt = locatedPoint(0); pt.players = ['alice', 'bob'];
    const eng = createReplayEngine(game([pt]), { ...OPTS, resolvePlayerName: id => id[0].toUpperCase() + id.slice(1) });
    assert.deepEqual(eng.fieldStateAt(eng.pointRange(0).first).roster, ['Alice', 'Bob']);
});

test('pointSummaries: timing span, winner, located; rebuild picks up new events', () => {
    const g = game([legacyPoint(), locatedPoint(0)]);
    const eng = createReplayEngine(g, OPTS);
    let s = eng.pointSummaries();
    assert.deepEqual(s.map(x => [x.startAt, x.endAt, x.winner, x.located]), [[null, null, 'us', false], [0, 40000, 'us', true]]);
    const before = eng.entries.length;
    g.points.push(point({ possessions: [poss(false, [at(new Pull({ puller: P.Alice, quality: 'Okay Pull', from: { x: 0, y: .5 }, to: { x: .9, y: .6 } }), 200000)], 200000)] }));
    eng.rebuild();
    assert.ok(eng.entries.length > before);
    s = eng.pointSummaries();
    assert.equal(s[2].winner, null);
    assert.equal(s[2].startAt, 200000);
    assert.equal(eng.isFinished(), false);
    eng.rebuild(game([legacyPoint()], { gameEndTimestamp: new Date() }));
    assert.equal(eng.isFinished(), true);
});
