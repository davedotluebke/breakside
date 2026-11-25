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

import { phraseEntry, wantsEntry, resolveVoice, gameOverSentence, mountReplayNarrator } from '../../playByPlay/replayNarrator.js';
import { buildGameLogEntries } from '../../utils/gameLogRenderer.js';
import { createReplayEngine } from '../../playByPlay/replayEngine.js';
import { createReplayController } from '../../playByPlay/replayController.js';
import { Throw, Turnover, Defense, Pull, Pickup, Other, Violation } from '../../store/models.js';

const P = Object.fromEntries(['Alice', 'Bob', 'Cara', 'Dev'].map(n => [n, { name: n, id: n.toLowerCase() }]));
const CTX = { teamName: 'Us', opponentName: 'Them' };
const at = (e, t) => { e.at = t; return e; };
const poss = (offensive, events, startedAt = null) => ({ offensive, events, startedAt });
const point = over => Object.assign({ players: Object.keys(P), startingPosition: 'defense', winner: '', possessions: [] }, over);

function sampleGame(t0 = 100000, { finished = false } = {}) {
    return { team: 'Us', opponent: 'Them', startingPosition: 'defense', gameEndTimestamp: finished ? new Date(t0 + 100000) : null, points: [
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
        'Alice drops the throw from Dev. Turnover.',
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
    assert.equal(ev(new Turnover({ thrower: P.Alice, receiver: P.Bob, receiverError: true, huck: true })), 'Bob drops the huck from Alice. Turnover.');
    assert.equal(ev(new Turnover({ thrower: P.Alice, receiver: P.Bob, receiverError: true })), 'Bob drops the throw from Alice. Turnover.');
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
                className: '', innerHTML: '', type: '', title: '', parentNode: null, hidden: false, dataset: {},
                classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); }, contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
                setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k],
                addEventListener: (t, fn) => { handlers[t] = fn; }, click: () => handlers.click && handlers.click(),
                querySelectorAll: () => [], contains: () => false,
                remove() { this.removed = true; },
            };
        },
    };
    const transport = { ownerDocument: doc, children: [], insertBefore(el) { this.children.push(el); el.parentNode = this; } };
    return { doc, transport, fire: (t, ev) => (listeners[t] || []).slice().forEach(fn => fn(ev)) };
}

const APPLE_VOICES = [
    { name: 'Samantha', lang: 'en-US', localService: true, default: true },
    { name: 'Daniel', lang: 'en-GB', localService: true },
    { name: 'Zarvox', lang: 'en-US', localService: true },
    { name: 'Karen', lang: 'en-AU', localService: true },
];
function fakeSynth({ autoStart = true, voices = APPLE_VOICES } = {}) {
    const spoken = [], live = new Set();
    const synth = {
        spoken, cancelled: 0,
        get speaking() { return live.size > 0; },
        getVoices: () => voices,
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
    assert.equal(t2.children.length, 2);                    // 🔊 and ⚙
    assert.equal(n.settingsButton.hidden, true);            // ⚙ only while narration is on
    n.button.click();
    assert.equal(n.enabled, true);
    assert.equal(store.get('replay.narrate'), true);
    assert.ok(n.button.classList.contains('on'));
    assert.equal(n.settingsButton.hidden, false);
    assert.deepEqual(texts(synth), ['Narration on.']);
    assert.equal(synth.spoken[0].voice.name, 'Samantha');   // the cue goes through the same queue and voice pick
    assert.equal(synth.spoken[0].pitch, 1);
});

test('voices: the three profiles resolve to the Apple voices, fall back by name then language, and keep the robot distinct', () => {
    const { synth } = fakeSynth();
    assert.equal(resolveVoice(synth, 'male').voice.name, 'Daniel');
    assert.equal(resolveVoice(synth, 'female').voice.name, 'Samantha');
    assert.equal(resolveVoice(synth, 'robot').voice.name, 'Zarvox');
    assert.equal(resolveVoice(synth, undefined).voice.name, 'Samantha');   // default profile
    assert.equal(resolveVoice(synth, 'Karen').voice.name, 'Karen');        // an exact name still works
    assert.ok(resolveVoice(synth, 'male').exact && resolveVoice(synth, 'robot').exact);

    // An Android-style device: Google voices, no gendered names.
    const android = fakeSynth({ voices: [
        { name: 'English United States', lang: 'en-US', localService: true, default: true },
        { name: 'English United Kingdom', lang: 'en-GB', localService: true },
    ] }).synth;
    const m = resolveVoice(android, 'male'), f = resolveVoice(android, 'female'), r = resolveVoice(android, 'robot');
    assert.equal(m.voice.lang, 'en-GB'); assert.equal(m.exact, false); assert.equal(m.pitch, 0.85);
    assert.equal(f.voice.lang, 'en-US'); assert.equal(f.pitch, 1);
    assert.equal(r.pitch, 0.5); assert.ok(r.rate < 1);
    // A Windows/Edge-style device with named neural voices.
    const edge = fakeSynth({ voices: [
        { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
        { name: 'Microsoft Guy Online (Natural) - English (United States)', lang: 'en-US' },
    ] }).synth;
    assert.match(resolveVoice(edge, 'male').voice.name, /Guy/);
    assert.match(resolveVoice(edge, 'female').voice.name, /Aria/);
    // No voices at all: nothing explodes, and the utterance keeps the browser default.
    assert.equal(resolveVoice(fakeSynth({ voices: [] }).synth, 'male').voice, null);
});

test('levels: play-by-play says everything, game events keeps lineups / scores / Other events, score only keeps the score lines', () => {
    const entries = buildGameLogEntries(sampleGame(), CTX);
    const spokenAt = lvl => entries.filter(e => wantsEntry(e, lvl) && phraseEntry(e, CTX)).map(e => e.kind);
    assert.deepEqual(spokenAt('score'), ['score', 'currentscore', 'score', 'currentscore']);
    assert.deepEqual(spokenAt('events'), ['roster', 'score', 'currentscore', 'roster', 'score', 'currentscore']);
    assert.ok(spokenAt('pbp').includes('event') && spokenAt('pbp').includes('pullnote'));
    const timeout = { kind: 'event', text: '', event: new Other({ timeout: true, calledBy: 'us' }) };
    const throwE = { kind: 'event', text: '', event: new Throw({ thrower: P.Alice, receiver: P.Bob }) };
    assert.equal(wantsEntry(timeout, 'events'), true);
    assert.equal(wantsEntry(throwE, 'events'), false);
    assert.equal(wantsEntry(timeout, 'score'), false);
    assert.equal(wantsEntry({ kind: 'periodnote', text: 'x' }, 'events'), true);
    assert.equal(wantsEntry(throwE, 'nonsense'), true);   // unknown level reads as the default (pbp)
});

test('game over: the closing line reads the last running score; spoken after the final score of a finished game, never for one in progress', () => {
    const entries = buildGameLogEntries(sampleGame(), CTX);
    assert.equal(gameOverSentence(entries), 'Game over. It ends tied at 1.');
    const win = sampleGame(); win.points[1].winner = 'team';
    assert.equal(gameOverSentence(buildGameLogEntries(win, CTX)), 'Game over. Us wins, 2 to 0.');
    const loss = sampleGame(); loss.points[0].winner = 'opponent';
    assert.equal(gameOverSentence(buildGameLogEntries(loss, CTX)), 'Game over. Them wins, 2 to 0.');
    assert.equal(gameOverSentence([]), '');

    const done = mountOn(sampleGame(100000, { finished: true }));
    done.n.setEnabled(true);
    done.controller.seek(1);
    for (let i = 0; i < 40; i++) { done.controller.stepForward(); done.synth.end(); }
    assert.deepEqual(texts(done.synth).slice(-2), ['Tied at 1.', 'Game over. It ends tied at 1.']);
    // Stepping back before the final score and through again says it again, once.
    done.controller.seek(entries.length - 4);
    for (let i = 0; i < 6; i++) { done.controller.stepForward(); done.synth.end(); }
    assert.equal(texts(done.synth).filter(t => t.startsWith('Game over')).length, 2);

    const open = mountOn(sampleGame());
    open.n.setEnabled(true);
    open.controller.seek(1);
    for (let i = 0; i < 40; i++) { open.controller.stepForward(); open.synth.end(); }
    assert.ok(!texts(open.synth).some(t => t.startsWith('Game over')));
    assert.equal(wantsEntry({ kind: 'gameover', text: 'x' }, 'score'), true);
});

test('game over: a live viewer hears it when the sync that ends the game arrives, once', () => {
    const game = sampleGame();
    const { controller, n, synth } = mountOn(game);
    n.setEnabled(true);
    controller.goLive();
    synth.end();
    const before = texts(synth).length;
    game.gameEndTimestamp = new Date(999999);
    controller.refresh(game);
    assert.deepEqual(texts(synth).slice(before), ['Game over. It ends tied at 1.']);
    controller.refresh(game);
    assert.equal(texts(synth).length, before + 1);
});

test('mount: the stored level and voice drive what is spoken and how', () => {
    const store = { m: { 'replay.narrate': true, 'replay.narrateLevel': 'score', 'replay.voice': 'robot' }, get(k) { return this.m[k]; }, set(k, v) { this.m[k] = v; } };
    const { controller, synth } = mountOn(sampleGame(), { settings: store });
    controller.seek(1);
    for (let i = 0; i < 40; i++) { controller.stepForward(); synth.end(); }   // past the end is a no-op
    assert.deepEqual(texts(synth), ['Us scores!', 'Us lead, 1 to 0.', 'Them scores!', 'Tied at 1.']);
    assert.ok(synth.spoken.every(u => u.voice.name === 'Zarvox'));
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
    assert.ok(transport.children[0].removed && transport.children[1].removed);
    controller.stepForward();
    assert.equal(synth.spoken.length, 2);
});
