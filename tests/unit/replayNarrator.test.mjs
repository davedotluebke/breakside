/*
 * playByPlay/replayNarrator.js — the spoken phrasing of every log-entry kind
 * (from real model events through buildGameLogEntries), and the mount's queue
 * policy against a fake speechSynthesis: Speedy holds, fast-replay keeps only
 * the newest line, Live keeps scores when it drops plays, seeks and pauses
 * cancel, the toggle persists.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { phraseEntry, mountReplayNarrator } from '../../playByPlay/replayNarrator.js';
import { buildGameLogEntries } from '../../utils/gameLogRenderer.js';
import { createReplayEngine } from '../../playByPlay/replayEngine.js';
import { createReplayController } from '../../playByPlay/replayController.js';
import { Throw, Turnover, Defense, Pull, Pickup, Other, Violation } from '../../store/models.js';

const P = Object.fromEntries(['Alice', 'Bob', 'Cara', 'Dev'].map(n => [n, { name: n, id: n.toLowerCase() }]));
const CTX = { teamName: 'Us', opponentName: 'Them' };
const at = (e, t) => { e.at = t; return e; };
const poss = (offensive, events, startedAt = null) => ({ offensive, events, startedAt });
const point = over => Object.assign({ players: Object.keys(P), startingPosition: 'defense', winner: '', possessions: [] }, over);

function sampleGame(t0 = 100000) {
    return { team: 'Us', opponent: 'Them', startingPosition: 'defense', points: [
        point({ winner: 'team', endTimestamp: new Date(t0 + 40000), possessions: [
            poss(false, [
                at(new Pull({ puller: P.Alice, quality: 'Good Pull', from: { x: 0, y: .5 }, to: { x: .8, y: .4 } }), t0),
                at(new Defense({ defender: P.Bob, block: true, to: { x: .5, y: .5 } }), t0 + 21000),
            ], t0),
            poss(true, [
                at(new Throw({ thrower: P.Bob, receiver: P.Cara, reset: true, from: { x: .5, y: .5 }, to: { x: .45, y: .4 } }), t0 + 27000),
                at(new Throw({ thrower: P.Cara, receiver: P.Dev, huck: true, score: true, from: { x: .45, y: .4 }, to: { x: 1.05, y: .5 } }), t0 + 30000),
            ], t0 + 21500),
        ] }),
        point({ startingPosition: 'offense', winner: 'opponent', endTimestamp: new Date(t0 + 90000), possessions: [
            poss(true, [
                at(new Pickup({ receiver: P.Dev, pullCatch: true, to: { x: .2, y: .5 } }), t0 + 60000),
                at(new Turnover({ thrower: P.Dev, receiver: P.Alice, receiverError: true, from: { x: .2, y: .5 }, to: { x: .4, y: .5 } }), t0 + 65000),
            ], t0 + 60000),
        ] }),
    ] };
}

const spoken = (game, opts = CTX) => buildGameLogEntries(game, opts).map(e => phraseEntry(e, opts));

test('phrasing: furniture is silent, plays come from the event flags, scores read as a scoreline', () => {
    const lines = spoken(sampleGame());
    assert.deepEqual(lines.filter(Boolean), [
        'Point 1. On the line: Alice Bob Cara Dev.',   // no rosterNames in ctx → the line's own text
        'Us pulls to Them.',
        'Good pull by Alice.',
        'Block by Bob!',
        'Bob dumps it to Cara.',
        'Cara to Dev deep for the goal!',
        'Us scores!',
        'Us lead, 1 to 0.',
        'Point 2. On the line: Alice Bob Cara Dev.',
        'Them pulls to Us.',
        'Dev catches the pull.',
        'Alice drops it. Turnover.',
        'Them scores!',
        'Tied at 1.',
    ]);
    // Header, team roster and every possession delimiter are silent.
    const entries = buildGameLogEntries(sampleGame(), CTX);
    entries.filter(e => ['header', 'teamroster', 'possession'].includes(e.kind))
        .forEach(e => assert.equal(phraseEntry(e, CTX), '', e.kind));
});

test('phrasing: roster names from ctx are read as a spoken list; score badges and point values are voiced', () => {
    const roster = { kind: 'roster', text: 'Point 3 roster: a b c', pointIdx: 2 };
    assert.equal(phraseEntry(roster, { rosterNames: ['Alice', 'Bob', 'Cara'] }), 'Point 3. On the line: Alice, Bob, and Cara.');
    assert.equal(phraseEntry(roster, { rosterNames: ['Alice', 'Bob'] }), 'Point 3. On the line: Alice and Bob.');
    assert.equal(phraseEntry({ kind: 'score', text: 'Us scores!  [break] ' }), 'Us scores! A break.');
    assert.equal(phraseEntry({ kind: 'score', text: 'Us scores! (2 points)  [upwind hold] ' }), "Us scores! That's worth 2 points. An upwind hold.");
    assert.equal(phraseEntry({ kind: 'score', text: 'Point over — no score ' }), 'Point over, no score.');
    assert.equal(phraseEntry({ kind: 'currentscore', text: 'Current score: Team 7 1, Them 3' }), 'Them lead, 3 to 1.');
    assert.equal(phraseEntry({ kind: 'periodnote', text: 'Us will pull to Them and play D. ' }), 'Us will pull to Them and play defense.');
});

test('phrasing: every event type has a sentence, inferred prefixes are dropped', () => {
    const ev = (e, ctx = CTX) => phraseEntry({ kind: 'event', text: e.summarize(), event: e }, ctx);
    assert.equal(ev(new Throw({ thrower: P.Alice, receiver: P.Bob })), 'Alice to Bob.');
    assert.equal(ev(new Throw({ thrower: P.Alice, receiver: P.Bob, huck: true, sky: true })), 'Alice hucks it to Bob, who skies for it.');
    assert.equal(ev(new Throw({ thrower: P.Alice, receiver: P.Bob, hammer: true, score: true })), 'Alice to Bob with the hammer for the goal!');
    const inferred = new Throw({ thrower: P.Alice, receiver: P.Bob, swing: true }); inferred.inferred_flag = true;
    assert.equal(ev(inferred), 'Alice swings it to Bob.');
    assert.equal(ev(new Turnover({ thrower: P.Alice, throwaway: true, huck: true })), 'Alice throws it away on the huck. Turnover.');
    assert.equal(ev(new Turnover({ receiver: P.Bob, receiverError: true })), 'Bob drops the pull. Turnover.');
    assert.equal(ev(new Turnover({ thrower: P.Alice, stall: true })), 'Alice gets stalled out. Turnover.');
    assert.equal(ev(new Defense({ defender: P.Cara, interception: true })), 'Cara with the interception!');
    assert.equal(ev(new Defense({ defender: P.Cara, layout: true })), 'Layout D by Cara!');
    assert.equal(ev(new Defense({ defender: P.Cara })), 'Cara gets the D!');
    assert.equal(ev(new Defense({ unforcedError: true })), 'Them turns it over.');
    assert.equal(ev(new Pull({ puller: P.Alice, quality: 'Brick' })), "Alice's pull is out. Brick.");
    assert.equal(ev(new Pull({ puller: P.Alice, quality: 'Poor Pull' })), "Alice pulls, and it's a short one.");
    assert.equal(ev(new Pull({ puller: P.Alice })), 'Alice pulls.');
    assert.equal(ev(new Pickup({ receiver: P.Bob })), 'Bob picks it up.');
    assert.equal(ev(new Violation({ pick: true })), 'Pick called.');
    assert.equal(ev(new Other({ timeout: true, calledBy: 'us' })), 'Timeout called by us.');
});

// ---- mount: fake DOM + fake speechSynthesis ----

function fakeDom() {
    const listeners = {};
    const doc = {
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
        createElement: () => {
            const classes = new Set(['rv-tbtn']), attrs = {}, handlers = {};
            return {
                className: '', innerHTML: '', type: '', title: '', parentNode: null,
                classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); }, contains: c => classes.has(c) },
                setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k],
                addEventListener: (t, fn) => { handlers[t] = fn; }, click: () => handlers.click && handlers.click(),
                remove() { this.removed = true; },
            };
        },
    };
    const transport = { ownerDocument: doc, children: [], insertBefore(el) { this.children.push(el); el.parentNode = this; } };
    return { doc, transport, fire: (t, ev) => (listeners[t] || []).slice().forEach(fn => fn(ev)) };
}

function fakeSynth({ autoStart = true } = {}) {
    const spoken = [], live = new Set();
    const synth = {
        spoken, cancelled: 0,
        get speaking() { return live.size > 0; },
        getVoices: () => [{ name: 'Samantha', lang: 'en-US', localService: true, default: true }, { name: 'Zarvox', lang: 'en-US', localService: true }],
        resume() {},
        speak(u) { spoken.push(u); live.add(u); if (autoStart && u.onstart) u.onstart(); },
        cancel() { synth.cancelled++; [...live].forEach(u => { live.delete(u); u.onerror && u.onerror({ error: 'canceled' }); }); },
        /** finish the oldest live utterance */
        end() { const u = [...live][0]; if (!u) return; live.delete(u); u.onend && u.onend(); },
    };
    class Utterance { constructor(text) { this.text = text; } }
    return { synth, Utterance };
}

function mountOn(game, { settings = null, synthOpts = {} } = {}) {
    const engine = createReplayEngine(game, CTX);
    const controller = createReplayController(engine);
    const { doc, transport, fire } = fakeDom();
    const { synth, Utterance } = fakeSynth(synthOpts);
    const store = settings || { m: {}, get(k) { return this.m[k]; }, set(k, v) { this.m[k] = v; } };
    const n = mountReplayNarrator({ controller, engine, transportEl: transport, getEntryOptions: () => CTX, settings: store, synth, Utterance });
    return { engine, controller, n, synth, transport, doc, fire, store };
}
const texts = synth => synth.spoken.map(u => u.text);

test('mount: nothing mounts without speech synthesis; the toggle persists and lights the button', () => {
    const engine = createReplayEngine(sampleGame(), CTX);
    const controller = createReplayController(engine);
    const { transport } = fakeDom();
    assert.equal(mountReplayNarrator({ controller, engine, transportEl: transport, synth: null }), null);

    const { n, synth, transport: t2, store } = mountOn(sampleGame());
    assert.equal(n.enabled, false);
    assert.equal(t2.children.length, 1);
    n.button.click();
    assert.equal(n.enabled, true);
    assert.equal(store.get('replay.narrate'), true);
    assert.ok(n.button.classList.contains('on'));
    assert.deepEqual(texts(synth), ['Narration on.']);
    assert.equal(synth.spoken[0].voice.name, 'Samantha');   // the cue goes through the same queue and voice pick
});

test('mount: disabled → silent; enabled → each played entry is spoken with the picked voice', () => {
    const { controller, n, synth } = mountOn(sampleGame());
    controller.stepForward(); controller.stepForward(); controller.stepForward();
    assert.deepEqual(texts(synth), []);
    n.setEnabled(true);
    controller.stepForward();   // 'pullnote'
    controller.stepForward();   // possession (silent)
    controller.stepForward();   // pull
    assert.deepEqual(texts(synth), ['Us pulls to Them.', 'Good pull by Alice.'].slice(0, 1));
    synth.end();
    assert.deepEqual(texts(synth), ['Us pulls to Them.', 'Good pull by Alice.']);
    assert.equal(synth.spoken[0].voice.name, 'Samantha');
});

test('mount: Speedy waits for the sentence before the next play', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { controller, n, synth } = mountOn(sampleGame());
        n.setEnabled(true);
        controller.seek(1);                        // parked on the team-roster line
        controller.setSpeed('pap');
        controller.play();
        mock.timers.tick(700);                     // the engine's pap hold (600 ms default) before the first entry
        assert.deepEqual(texts(synth), ['Point 1. On the line: Alice, Bob, Cara, and Dev.']);
        mock.timers.tick(3000);                    // well past the pap hold, under the 8 s ceiling
        assert.equal(synth.spoken.length, 1, 'the next entry waits for the voice');
        synth.end();
        await Promise.resolve(); await Promise.resolve();   // Promise.all(holds).then(finish) → arm()
        mock.timers.tick(2000);
        assert.deepEqual(texts(synth), ['Point 1. On the line: Alice, Bob, Cara, and Dev.', 'Us pulls to Them.']);
        controller.pause();
    } finally {
        mock.timers.reset();
    }
});

test('mount: at 2× only the newest line survives; at 1× scores are kept when plays are dropped', () => {
    const { controller, n, synth } = mountOn(sampleGame());
    n.setEnabled(true);
    controller.setSpeed(2);
    controller.seek(1);
    controller.stepForward(); controller.stepForward(); controller.stepForward(); controller.stepForward();
    // roster, pullnote, possession(silent), pull: each new line cancelled the last
    assert.equal(synth.spoken[synth.spoken.length - 1].text, 'Good pull by Alice.');
    assert.ok(synth.cancelled >= 2);

    const run = mountOn(sampleGame());
    run.n.setEnabled(true);
    run.controller.setSpeed(1);
    run.controller.seek(1);
    // Play straight through without ending any utterance: the queue fills.
    for (let i = 0; i < 12; i++) run.controller.stepForward();
    const first = run.synth.spoken[0].text;
    assert.equal(first, 'Point 1. On the line: Alice, Bob, Cara, and Dev.');   // engine passes the roster
    // Drain: what was kept behind the current line.
    const drained = [];
    while (run.synth.speaking) { run.synth.end(); const u = run.synth.spoken[run.synth.spoken.length - 1]; if (!drained.includes(u.text)) drained.push(u.text); }
    assert.ok(drained.includes('Us scores!') && drained.includes('Us lead, 1 to 0.'), drained.join(' | '));
    assert.ok(drained.length <= 5, drained.join(' | '));
});

test('mount: a seek or a pause in place cancels the voice; a step forward does not', () => {
    const { controller, n, synth } = mountOn(sampleGame());
    n.setEnabled(true);
    controller.seek(1);
    controller.stepForward();                 // roster → speaking
    assert.equal(synth.speaking, true);
    controller.stepForward();                 // pullnote → queued, roster still speaking
    assert.equal(synth.cancelled, 0);
    controller.seek(0);
    assert.equal(synth.speaking, false);
    assert.ok(synth.cancelled >= 1);

    const c = synth.cancelled;
    controller.setSpeed(1); controller.seek(1); controller.play();
    controller.stepForward();                 // from playing: flips playing off but advances
    assert.equal(synth.cancelled, c);         // nothing was queued at the seek; the step did not cancel
    assert.equal(synth.speaking, true);
    controller.play(); controller.pause();    // pause in place
    assert.equal(synth.speaking, false);
});

test('mount: an utterance that never starts is parked and retried on the next tap; destroy removes everything', async () => {
    const { controller, n, synth, fire, transport } = mountOn(sampleGame(), { synthOpts: { autoStart: false } });
    n.setEnabled(true);
    controller.seek(1);
    controller.stepForward();
    assert.equal(synth.spoken.length, 1);
    await new Promise(r => setTimeout(r, 1700));
    fire('pointerdown', {});                  // the primer re-speaks the parked line
    assert.equal(synth.spoken.length, 2);
    assert.equal(synth.spoken[1].text, synth.spoken[0].text);
    n.destroy();
    assert.ok(transport.children[0].removed);
    controller.stepForward();
    assert.equal(synth.spoken.length, 2);
});
