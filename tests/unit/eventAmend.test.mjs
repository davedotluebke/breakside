/*
 * playByPlay/eventAmend.js — the pure rules behind editing a recorded play
 * (docs/replay-viewer-plan.md step 8): modifier tables, throw geometry,
 * the catch-spot cascade, the receiver chain conflict and its two
 * resolutions, and the live-counter moves.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Throw, Turnover, Defense, Pull } from '../../store/models.js';
import {
    THROW_MODIFIERS, TURNOVER_MODIFIERS, DEFENSE_MODIFIERS, modifiersFor,
    classifyThrowGeometry, reclassifyThrow,
    flattenPointEvents, locateEvent, pointOfEvent, nextInPossession,
    receiverChainConflict, applyEventPatch, insertUnknownBridge,
    adjustPlayerCounters, snapshotEvent,
} from '../../playByPlay/eventAmend.js';

const player = (name, extra) => Object.assign({ name, id: name.toLowerCase(), completedPasses: 0, goals: 0, assists: 0 }, extra);
const P = Object.fromEntries(['Alice', 'Bob', 'Cara', 'Dev'].map(n => [n, player(n)]));
const UNKNOWN = { name: 'Unknown Player', id: null };
const poss = (offensive, events) => ({ offensive, events, startedAt: null });

/** D point: pull, block, then Bob→Cara, Cara→Dev, Dev→Alice (score). */
function makePoint() {
    return {
        players: Object.keys(P), startingPosition: 'defense', winner: 'team',
        possessions: [
            poss(false, [
                new Pull({ puller: P.Alice, from: { x: 0, y: .5 }, to: { x: .8, y: .4 } }),
                new Defense({ defender: P.Bob, block: true, to: { x: .5, y: .5 } }),
            ]),
            poss(true, [
                new Throw({ thrower: P.Bob, receiver: P.Cara, from: { x: .5, y: .5 }, to: { x: .6, y: .5 } }),
                new Throw({ thrower: P.Cara, receiver: P.Dev, from: { x: .6, y: .5 }, to: { x: .7, y: .5 } }),
                new Throw({ thrower: P.Dev, receiver: P.Alice, score: true, from: { x: .7, y: .5 }, to: { x: 1.05, y: .5 } }),
            ]),
        ],
    };
}
const throws = point => point.possessions[1].events;

test('modifier tables: one per editable type, none for Pull / Other', () => {
    assert.equal(modifiersFor(new Throw({ thrower: P.Alice, receiver: P.Bob })), THROW_MODIFIERS);
    assert.equal(modifiersFor(new Turnover({ thrower: P.Alice })), TURNOVER_MODIFIERS);
    assert.equal(modifiersFor(new Defense({ defender: P.Bob })), DEFENSE_MODIFIERS);
    assert.deepEqual(modifiersFor(new Pull({ puller: P.Alice })), []);
    assert.deepEqual(modifiersFor(null), []);
    // Every prop names a real flag on its event class.
    THROW_MODIFIERS.forEach(m => assert.ok(m.prop in new Throw({}), m.prop));
    TURNOVER_MODIFIERS.forEach(m => assert.ok(m.prop in new Turnover({}), m.prop));
    DEFENSE_MODIFIERS.forEach(m => assert.ok(m.prop in new Defense({}), m.prop));
});

test('classifyThrowGeometry: huck / reset / swing thresholds, settings override', () => {
    assert.deepEqual(classifyThrowGeometry(null, { x: 1, y: 0 }), {});
    assert.deepEqual(classifyThrowGeometry({ x: .1, y: .5 }, { x: .7, y: .5 }), { huck: true, reset: false, swing: false });
    assert.deepEqual(classifyThrowGeometry({ x: .5, y: .5 }, { x: .45, y: .5 }), { huck: false, reset: true, swing: false });
    assert.deepEqual(classifyThrowGeometry({ x: .5, y: .2 }, { x: .55, y: .6 }), { huck: false, reset: false, swing: true });
    // A huck is never also a swing; a 1-yard backwards pass is not a reset.
    assert.equal(classifyThrowGeometry({ x: .1, y: .1 }, { x: .8, y: .9 }).swing, false);
    assert.equal(classifyThrowGeometry({ x: .5, y: .5 }, { x: .49, y: .5 }).reset, false);
    assert.equal(classifyThrowGeometry({ x: .1, y: .5 }, { x: .4, y: .5 }, { huckFraction: .25 }).huck, true);
    assert.equal(classifyThrowGeometry({ x: .5, y: .2 }, { x: .55, y: .6 }, { swingFraction: .5 }).swing, false);
});

test('reclassifyThrow overwrites exactly the three geometry flags and reports change', () => {
    const t = new Throw({ thrower: P.Alice, receiver: P.Bob, breakmark: true, huck: true, from: { x: .5, y: .5 }, to: { x: .45, y: .5 } });
    assert.equal(reclassifyThrow(t), true);
    assert.equal(t.huck_flag, false); assert.equal(t.reset_flag, true); assert.equal(t.break_flag, true);
    assert.equal(reclassifyThrow(t), false);
    assert.equal(reclassifyThrow(new Throw({ thrower: P.Alice, receiver: P.Bob })), false);   // unlocated: untouched
});

test('flatten / locate / pointOfEvent / nextInPossession', () => {
    const point = makePoint();
    const flat = flattenPointEvents(point);
    assert.equal(flat.length, 5);
    assert.deepEqual(locateEvent(point, throws(point)[1]), { flatIdx: 3, event: throws(point)[1], possIdx: 1, eventIdx: 1 });
    assert.equal(locateEvent(point, new Throw({})), null);
    const game = { points: [{ possessions: [] }, point] };
    assert.deepEqual(pointOfEvent(game, throws(point)[0]), { point, pointIdx: 1 });
    assert.equal(pointOfEvent(game, new Throw({})), null);
    assert.equal(nextInPossession(point, throws(point)[0]), throws(point)[1]);
    assert.equal(nextInPossession(point, throws(point)[2]), null);
    // The chain never crosses a possession: the block is not "next" after the pull's successor.
    assert.equal(nextInPossession(point, point.possessions[0].events[1]), null);
});

test('receiverChainConflict: only a Throw whose next play is thrown by someone else', () => {
    const point = makePoint();
    const [t0, t1, t2] = throws(point);
    assert.equal(receiverChainConflict(point, t0, P.Cara), null);             // unchanged receiver
    assert.deepEqual(receiverChainConflict(point, t0, P.Alice), { next: t1, thrower: 'Cara' });
    assert.equal(receiverChainConflict(point, t2, P.Bob), null);              // a score has no successor
    assert.equal(receiverChainConflict(point, t1, 'Alice').next, t2);         // name strings work too
    // Next is a Turnover: still a chain (its thrower must be this receiver).
    const turn = new Turnover({ thrower: P.Dev, throwaway: true });
    point.possessions[1].events = [t0, t1, turn];
    assert.equal(receiverChainConflict(point, t1, P.Alice).next, turn);
    // Next is a Defense (no thrower) → nothing to contradict.
    point.possessions[1].events = [t0, t1, new Defense({ defender: P.Bob, block: true })];
    assert.equal(receiverChainConflict(point, t1, P.Alice), null);
});

test('applyEventPatch: players, flags, and the catch-spot cascade with reclassification', () => {
    const point = makePoint();
    const [t0, t1] = throws(point);
    const r = applyEventPatch(point, t0, { receiver: P.Dev, break_flag: true, score_flag: true });
    assert.equal(r.previousEvent.receiver, P.Cara);
    assert.equal(typeof r.previousEvent.summarize, 'function');
    assert.equal(t0.receiver, P.Dev);
    assert.equal(t0.break_flag, true);
    assert.equal(t0.score_flag, false, 'score_flag is not patchable');
    assert.deepEqual(r.changed, [t0]);
    assert.equal(r.cascaded, null);

    // Moving the catch spot moves the next throw's release and re-derives both.
    const r2 = applyEventPatch(point, t0, { to: { x: .1, y: .9 } });
    assert.deepEqual(t0.to, { x: .1, y: .9 });
    assert.deepEqual(t1.from, { x: .1, y: .9 });
    assert.notEqual(t0.to, t1.from, 'fresh objects, never aliased');
    assert.equal(r2.cascaded, t1);
    assert.deepEqual(r2.changed, [t0, t1]);
    assert.equal(t0.reset_flag, true);     // .5 → .1 is backwards
    assert.equal(t1.huck_flag, true);      // .1 → .7 is a huck now

    // A Defense has no `from` to cascade into; a Pull's `to` moves alone.
    const pull = point.possessions[0].events[0];
    const r3 = applyEventPatch(point, pull, { to: { x: .3, y: .3 } });
    assert.deepEqual(pull.to, { x: .3, y: .3 });
    assert.equal(r3.cascaded, null);
    // Clearing a location.
    applyEventPatch(point, pull, { to: null });
    assert.equal(pull.to, null);
});

test('insertUnknownBridge: two inferred, unlocated, untimed passes after the edited throw', () => {
    const point = makePoint();
    const [t0, t1] = throws(point);
    assert.deepEqual(insertUnknownBridge(point, t0, UNKNOWN), [], 'consistent chain → nothing inserted');
    applyEventPatch(point, t0, { receiver: P.Alice });
    const ins = insertUnknownBridge(point, t0, UNKNOWN);
    assert.equal(ins.length, 2);
    const evs = point.possessions[1].events;
    assert.deepEqual(evs.slice(0, 4), [t0, ins[0], ins[1], t1]);
    assert.equal(ins[0].thrower, P.Alice); assert.equal(ins[0].receiver, UNKNOWN);
    assert.equal(ins[1].thrower, UNKNOWN); assert.equal(ins[1].receiver, P.Cara);
    ins.forEach(e => {
        assert.equal(e.inferred_flag, true);
        assert.equal(e.from, null); assert.equal(e.to, null); assert.equal(e.at, null);
        assert.equal(e.score_flag, false);
    });
    assert.match(ins[0].summarize(), /^\(inferred\) Alice throws /);
    assert.equal(receiverChainConflict(point, t0, t0.receiver), null, 'bridged chain is consistent');
    assert.equal(insertUnknownBridge(point, t0, null).length, 0, 'no Unknown ref → no insert');
});

test('adjustPlayerCounters moves completedPasses / goals / assists with the players', () => {
    const point = makePoint();
    const [, , score] = throws(point);
    Object.values(P).forEach(p => { p.completedPasses = 2; p.goals = 1; p.assists = 1; });
    const before = snapshotEvent(score);
    assert.equal(adjustPlayerCounters(before, score), false, 'no change → no move');
    applyEventPatch(point, score, { thrower: P.Bob, receiver: P.Cara });
    assert.equal(adjustPlayerCounters(before, score), true);
    assert.equal(P.Dev.completedPasses, 1); assert.equal(P.Bob.completedPasses, 3);
    assert.equal(P.Alice.goals, 0);        assert.equal(P.Cara.goals, 2);
    assert.equal(P.Dev.assists, 0);        assert.equal(P.Bob.assists, 2);     // assist follows the thrower when unset
    // An explicit assist holder is the one credited, not the thrower.
    const b2 = snapshotEvent(score);
    applyEventPatch(point, score, { assist: P.Alice });
    adjustPlayerCounters(b2, score);
    assert.equal(P.Bob.assists, 1); assert.equal(P.Alice.assists, 2);
    // Counters clamp at zero and stubs without counters are tolerated.
    const stub = { name: 'Ghost', id: null };
    const t = new Throw({ thrower: stub, receiver: P.Cara });
    const b3 = snapshotEvent(t);
    applyEventPatch(point, t, { thrower: P.Dev });
    adjustPlayerCounters(b3, t);
    assert.equal(stub.completedPasses, 0); assert.equal(P.Dev.completedPasses, 2);
    // Callahan credit follows the defender.
    const cal = new Defense({ defender: P.Bob, Callahan: true });
    const b4 = snapshotEvent(cal);
    applyEventPatch(point, cal, { defender: P.Cara });
    adjustPlayerCounters(b4, cal);
    assert.equal(P.Bob.goals, 0); assert.equal(P.Cara.goals, 3);
});
