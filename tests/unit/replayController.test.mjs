/*
 * playByPlay/replayController.js — the clock around the replay engine
 * (docs/replay-viewer-plan.md step 4), under node's mock timers: play/pause
 * pacing, the animation floor, live follow + refresh, unseen counting and
 * goLive, seek/step dropping follow, undo clamping, and play-after-play
 * waiting on narration holds (with the ceiling).
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createReplayEngine } from '../../playByPlay/replayEngine.js';
import { createReplayController } from '../../playByPlay/replayController.js';
import { Throw, Defense, Pull } from '../../store/models.js';

const P = Object.fromEntries(['Alice', 'Bob', 'Cara'].map(n => [n, { name: n }]));
const OPTS = { teamName: 'Us', opponentName: 'Them' };
const at = (e, t) => { e.at = t; return e; };
const poss = (offensive, events, startedAt = null) => ({ offensive, events, startedAt });

/** D point with pull (t0), block (+21 s), throw (+27 s), score throw (+30 s). */
function makeGame(t0 = 0, finished = false) {
    const pt = {
        players: Object.keys(P), startingPosition: 'defense', winner: 'team', endTimestamp: new Date(t0 + 32000),
        possessions: [
            poss(false, [
                at(new Pull({ puller: P.Alice, quality: 'Good Pull', from: { x: 0, y: .5 }, to: { x: .8, y: .4 } }), t0),
                at(new Defense({ defender: P.Bob, block: true, to: { x: .5, y: .5 } }), t0 + 21000),
            ], t0),
            poss(true, [
                at(new Throw({ thrower: P.Bob, receiver: P.Cara, from: { x: .5, y: .5 }, to: { x: .7, y: .5 } }), t0 + 27000),
                at(new Throw({ thrower: P.Cara, receiver: P.Alice, score: true, from: { x: .7, y: .5 }, to: { x: 1.05, y: .5 } }), t0 + 30000),
            ], t0 + 21500),
        ],
    };
    return { team: 'Us', opponent: 'Them', startingPosition: 'defense', points: [pt],
        gameEndTimestamp: finished ? new Date(t0 + 40000) : null };
}

function harness(game = makeGame(), engineOpts = {}, ctlDeps = {}) {
    const engine = createReplayEngine(game, { ...OPTS, ...engineOpts });
    const ctl = createReplayController(engine, ctlDeps);
    const fired = [];
    const transports = [];
    ctl.on('field', ({ index, animate }) => { fired.push([index, animate]); return animate ? 500 : 0; });
    ctl.on('transport', s => transports.push(s));
    return { engine, ctl, fired, transports };
}
const kindAt = (engine, i) => engine.entries[i].kind;

test('play walks the entries at engine pacing with the animation floor; stops at the end', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { engine, ctl, fired } = harness();
        const n = engine.entries.length;
        ctl.play();
        const last = () => (fired.length ? fired[fired.length - 1][0] : -1);
        const expect = (ms, idx) => {
            mock.timers.tick(ms - 1); assert.notEqual(last(), idx, `fired ${idx} early`);
            mock.timers.tick(1);      assert.equal(last(), idx, `expected ${idx} after ${ms}ms`);
        };
        // header, teamroster, roster: no timed predecessor → the hold (600), plus the
        // previous entry's animation (500) once one has fired
        expect(600, 0); expect(1100, 1); expect(1100, 2);
        // pullnote / delimiter / pull all share the point's t0 → zero gap → animation floor (500)
        expect(500, 3); expect(500, 4); expect(500, 5);
        assert.equal(engine.entries[5].event.type, 'Pull');
        expect(4000, 6);                  // block: 21 s clipped to capWithinMs
        assert.equal(engine.entries[6].event.type, 'Defense');
        expect(500, 7);                   // "— Us on offense —" 500 ms later → floor
        expect(4000, 8);                  // throw 5.5 s later → clipped
        expect(3000, 9);                  // score throw 3 s later
        expect(2000, 10);                 // "Us scores!" at endTimestamp, 2 s later
        expect(500, 11);                  // current score: same instant → floor
        mock.timers.tick(60000);
        assert.equal(fired[fired.length - 1][0], n - 1);
        assert.equal(ctl.snapshot().playing, false);
        assert.equal(ctl.snapshot().atTail, true);
    } finally { mock.timers.reset(); }
});

test('speed changes reschedule; pause stops the clock; play from the end restarts', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { ctl, fired } = harness();
        ctl.seek(5);                       // sitting on the pull; the block is a 4 s (clipped) gap away
        ctl.play();
        ctl.setSpeed(4);                   // 4 s / 4 = 1 s
        mock.timers.tick(999); assert.equal(fired[fired.length - 1][0], 5);
        mock.timers.tick(1);   assert.equal(fired[fired.length - 1][0], 6);
        ctl.pause();
        mock.timers.tick(100000);
        assert.equal(fired[fired.length - 1][0], 6);
        ctl.seek(10 ** 6);                 // clamps to the tail
        assert.equal(ctl.snapshot().atTail, true);
        ctl.play();
        assert.equal(ctl.index, -1);       // restarted from the top
        mock.timers.tick(600);
        assert.equal(fired[fired.length - 1][0], 0);
    } finally { mock.timers.reset(); }
});

test('stepForward animates one entry and pauses; stepBack does not animate', () => {
    const { ctl, fired } = harness();
    ctl.stepForward(); ctl.stepForward();
    assert.deepEqual(fired.slice(-2), [[0, true], [1, true]]);
    assert.equal(ctl.snapshot().playing, false);
    ctl.stepBack();
    assert.deepEqual(fired[fired.length - 1], [0, false]);
    ctl.stepBack(); ctl.stepBack();
    assert.equal(ctl.index, -1);
});

test('live: goLive jumps to the tail and new entries animate on refresh; seeking back drops to 1× and counts unseen', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const game = makeGame();
        game.points[0].winner = '';
        game.points[0].possessions[1].events.pop();     // in progress: no score yet
        const { engine, ctl, fired } = harness(game);
        ctl.goLive();
        const tail = engine.entries.length - 1;
        assert.deepEqual(fired[fired.length - 1], [tail, false]);
        assert.equal(ctl.snapshot().speed, 'live');
        assert.equal(ctl.snapshot().playing, true);

        // a new throw syncs in → animates right away (the last fire was a seek, no animation pending)
        game.points[0].possessions[1].events.push(at(new Throw({ thrower: P.Cara, receiver: P.Bob, from: { x: .7, y: .5 }, to: { x: .9, y: .5 } }), 29000));
        ctl.refresh();
        mock.timers.tick(1);   assert.deepEqual(fired[fired.length - 1], [tail + 1, true]);
        assert.equal(ctl.snapshot().unseen, 0);
        // the next one waits only for that animation (500 ms), not for the real 500 ms gap
        game.points[0].possessions[1].events.push(at(new Throw({ thrower: P.Bob, receiver: P.Alice, from: { x: .9, y: .5 }, to: { x: .95, y: .6 } }), 29500));
        ctl.refresh();
        mock.timers.tick(499); assert.equal(fired[fired.length - 1][0], tail + 1);
        mock.timers.tick(1);   assert.deepEqual(fired[fired.length - 1], [tail + 2, true]);

        // scrub back: follow drops, speed 1×; the next sync counts as unseen
        ctl.seek(3);
        assert.equal(ctl.snapshot().follow, false);
        assert.equal(ctl.snapshot().speed, 1);
        game.points[0].winner = 'team';
        ctl.refresh();
        assert.equal(ctl.snapshot().unseen, 2);          // score + current-score lines
        // goLive clears it and lands on the new tail
        ctl.goLive();
        assert.equal(ctl.snapshot().unseen, 0);
        assert.equal(ctl.index, engine.entries.length - 1);
    } finally { mock.timers.reset(); }
});

test('refresh after an undo clamps a playhead that ran past the end', () => {
    const game = makeGame();
    const { engine, ctl, fired } = harness(game);
    ctl.seek(engine.entries.length - 1);
    game.points[0].winner = '';
    game.points[0].possessions[1].events.pop();
    ctl.refresh();
    assert.equal(ctl.index, engine.entries.length - 1);
    assert.deepEqual(fired[fired.length - 1], [engine.entries.length - 1, false]);
});

test('entry listeners get saidSoFar; play-after-play waits for holds, bounded by the ceiling', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { engine, ctl, fired } = harness(makeGame(), {}, { holdCeilingMs: 3000 });
        const seen = [];
        let release = null;
        ctl.on('entry', ({ entry, saidSoFar }) => {
            seen.push([entry.text, saidSoFar.length]);
            if (entry.kind === 'event' && entry.event.type === 'Defense') {
                return new Promise(res => { release = res; });
            }
            return undefined;
        });
        ctl.setSpeed('pap');
        ctl.play();
        // first fire after the bare 600 ms hold, then animation (500) + hold (600) = 1100 per entry
        mock.timers.tick(600);
        assert.equal(fired[fired.length - 1][0], 0);
        for (let i = 1; i <= 6; i++) mock.timers.tick(1100);
        assert.equal(fired[fired.length - 1][0], 6);
        assert.equal(engine.entries[6].event.type, 'Defense');
        assert.equal(seen[seen.length - 1][1], 5);             // everything before it was "said" — except the blank teamroster line
        // held: no progress until the narration promise settles
        mock.timers.tick(2000);
        assert.equal(fired[fired.length - 1][0], 6);
        release();
        await Promise.resolve(); await Promise.resolve();
        mock.timers.tick(1100);
        assert.equal(fired[fired.length - 1][0], 7);
    } finally { mock.timers.reset(); }
});

test('play-after-play hold ceiling releases a stuck narration', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { ctl, fired } = harness(makeGame(), {}, { holdCeilingMs: 3000 });
        ctl.on('entry', () => new Promise(() => {}));          // never resolves
        ctl.setSpeed('pap');
        ctl.seek(5);
        ctl.play();
        mock.timers.tick(600);                                  // pull → block after the bare hold
        assert.equal(fired[fired.length - 1][0], 6);
        mock.timers.tick(2999);                                 // ceiling (3000) not yet reached
        await Promise.resolve();
        assert.equal(fired[fired.length - 1][0], 6);
        mock.timers.tick(1);                                    // ceiling fires → arms the 1100 ms delay
        await Promise.resolve();
        mock.timers.tick(1099); assert.equal(fired[fired.length - 1][0], 6);
        mock.timers.tick(1);    assert.equal(fired[fired.length - 1][0], 7);
    } finally { mock.timers.reset(); }
});

test('editing is refused while playing and cleared by play/goLive', () => {
    const { ctl } = harness();
    assert.equal(ctl.setEditing(true), true);
    ctl.play();
    assert.equal(ctl.snapshot().editing, false);
    assert.equal(ctl.setEditing(true), false);
    ctl.pause();
    assert.equal(ctl.setEditing(true), true);
    ctl.destroy();
});
