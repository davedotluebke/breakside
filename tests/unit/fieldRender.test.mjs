/*
 * playByPlay/fieldRender.js — the shared, non-interactive field renderer
 * (extracted from fieldPbp.js for the replay viewer,
 * docs/replay-viewer-plan.md § 5).
 *
 * Covers: the normalized <-> yards bridge and its endzone-depth
 * independence, pct()/toField() for both orientations and both flips,
 * possession segmentation, per-instance fade trackers, and the event /
 * chip / actor HTML.
 *
 * The renderer imports utils/helpers.js (showPlayerNumbers), which expects a
 * browser: stub the globals it touches at module load BEFORE importing (same
 * recipe as setsSerialization.test.mjs).
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

const R = await import('../../playByPlay/fieldRender.js');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} != ${b}`);
const view = (o, flipAD, flipHA) => ({ o, flipAD, flipHA });

test('toNorm/fromNorm round-trip and return fresh objects', () => {
    R.refreshGeometry(20);
    const loc = { l: 45, w: 10 };
    const n = R.toNorm(loc);
    near(n.x, 25 / 70);
    near(n.y, 0.25);
    const back = R.fromNorm(n);
    near(back.l, 45);
    near(back.w, 10);
    assert.notStrictEqual(R.toNorm(loc), R.toNorm(loc));
    assert.notStrictEqual(R.fromNorm(n), R.fromNorm(n));
    // Legacy canonical {l, w} passes through; null stays null.
    assert.deepEqual(R.fromNorm({ l: 3, w: 4 }), { l: 3, w: 4 });
    assert.equal(R.fromNorm(null), null);
    assert.equal(R.toNorm(null), null);
});

test('a stored normalized point does not move relative to the playing field when EZ changes', () => {
    R.refreshGeometry(20);
    assert.equal(R.geom.EZ, 20);
    assert.equal(R.geom.L, 110);
    const n = R.toNorm({ l: 20 + 35, w: 20 });    // midfield, 35 yd past our goal line
    near(n.x, 0.5);

    R.refreshGeometry(25);
    assert.equal(R.geom.EZ, 25);
    assert.equal(R.geom.L, 120);
    assert.deepEqual(R.geom.RZ, [45, 75]);
    assert.deepEqual(R.geom.BRICK, [45, 75]);
    const back = R.fromNorm(n);
    near(back.l - R.geom.EZ, 35);                // still 35 yd past the goal line
    near(R.toNorm(back).x, 0.5);
    // Endzone membership is a normalized-frame test, independent of depth.
    assert.equal(R.inAttackEZ({ x: 1, y: 0.5 }), true);
    assert.equal(R.inAttackEZ({ x: 0.999, y: 0.5 }), false);
    assert.equal(R.inAttackEZ(null), false);
    R.refreshGeometry(20);
});

test('refreshGeometry() without an argument reads window.advancedSettings.getEndzoneYards', () => {
    globalThis.window.advancedSettings = { getEndzoneYards: () => 25 };
    R.refreshGeometry();
    assert.equal(R.geom.EZ, 25);
    globalThis.window.advancedSettings = { getEndzoneYards: () => NaN };
    R.refreshGeometry();
    assert.equal(R.geom.EZ, 20);
    delete globalThis.window.advancedSettings;
    R.refreshGeometry();
    assert.equal(R.geom.EZ, 20);
});

test('pct(): both orientations and both flips', () => {
    R.refreshGeometry(20);                        // L = 110
    const attackLine = 90, homeSide = 0;          // l = L - EZ, w = 0
    // Portrait, no flips: attack up (top), Home on the right edge.
    let p = R.pct(view('portrait', false, false), attackLine, homeSide);
    near(p.x, 100); near(p.y, (20 / 110) * 100);
    // flipAD: attack down.
    p = R.pct(view('portrait', true, false), attackLine, homeSide);
    near(p.x, 100); near(p.y, (90 / 110) * 100);
    // flipHA: Home on the left edge.
    p = R.pct(view('portrait', false, true), attackLine, homeSide);
    near(p.x, 0); near(p.y, (20 / 110) * 100);
    // Landscape, no flips: attack right, Home along the top edge.
    p = R.pct(view('landscape', false, false), attackLine, homeSide);
    near(p.x, (90 / 110) * 100); near(p.y, 0);
    p = R.pct(view('landscape', true, false), attackLine, homeSide);
    near(p.x, (20 / 110) * 100); near(p.y, 0);
    p = R.pct(view('landscape', false, true), attackLine, homeSide);
    near(p.x, (90 / 110) * 100); near(p.y, 100);
    p = R.pct(view('landscape', true, true), attackLine, homeSide);
    near(p.x, (20 / 110) * 100); near(p.y, 100);
});

test('toField() inverts pct() for every orientation/flip combination', () => {
    R.refreshGeometry(20);
    for (const o of ['portrait', 'landscape']) {
        for (const flipAD of [false, true]) {
            for (const flipHA of [false, true]) {
                const v = view(o, flipAD, flipHA);
                const p = R.pct(v, 37, 11);
                const back = R.toField(v, p.x / 100, p.y / 100);
                near(back.l, 37, `${o} ad=${flipAD} ha=${flipHA} l`);
                near(back.w, 11, `${o} ad=${flipAD} ha=${flipHA} w`);
            }
        }
    }
});

test('clampLoc keeps a yard inside the lines', () => {
    R.refreshGeometry(20);
    assert.deepEqual(R.clampLoc(-5, 200), { l: 1, w: 39 });
    assert.deepEqual(R.clampLoc(500, -1), { l: 109, w: 1 });
    assert.deepEqual(R.clampLoc(50, 20), { l: 50, w: 20 });
});

test('homeSideRotation: portrait ±90, landscape 0/180', () => {
    assert.equal(R.homeSideRotation(view('portrait', false, false)), 90);
    assert.equal(R.homeSideRotation(view('portrait', false, true)), -90);
    assert.equal(R.homeSideRotation(view('landscape', false, false)), 0);
    assert.equal(R.homeSideRotation(view('landscape', false, true)), 180);
});

const ev = (type, extra) => Object.assign({ type }, extra || {});

test('computeSegments: trailing run is current, run before it is previous', () => {
    const flat = [ev('Pull'), ev('Defense'), ev('Throw'), ev('Throw')];
    assert.deepEqual(R.computeSegments(flat, 'offense'), { curStart: 2, prevStart: 0 });
});

test('computeSegments: a flip-causing last event stays solid on its own', () => {
    // Block while we're now on offense with no O event yet: only the block
    // is current; the rest of its D run fades.
    const flat = [ev('Throw'), ev('Turnover'), ev('Defense'), ev('Defense')];
    assert.deepEqual(R.computeSegments(flat, 'offense'), { curStart: 3, prevStart: 2 });
    // A lone flip event: nothing older in its run to fade.
    assert.deepEqual(R.computeSegments([ev('Throw'), ev('Turnover'), ev('Defense')], 'offense'),
        { curStart: 2, prevStart: -1 });
});

test('computeSegments: Other/Violation events are transparent; empty list has no segments', () => {
    const flat = [ev('Throw'), ev('Other'), ev('Throw')];
    assert.deepEqual(R.computeSegments(flat, 'offense'), { curStart: 0, prevStart: -1 });
    assert.deepEqual(R.computeSegments([], 'offense'), { curStart: 0, prevStart: -1 });
    assert.deepEqual(R.computeSegments([ev('Other')], 'defense'), { curStart: 1, prevStart: -1 });
    assert.equal(R.eventSide(ev('Violation')), null);
    assert.equal(R.eventSide(ev('Pull')), 'D');
    assert.equal(R.eventSide(ev('Turnover')), 'O');
});

test('stablePointKey keys on game id + point index, not identity', () => {
    const p0 = {}, p1 = {};
    const game = { id: 'g1', points: [p0, p1] };
    assert.equal(R.stablePointKey(game, p1), 'g1#1');
    assert.equal(R.stablePointKey(game, {}), 'g1#-1');
    assert.equal(R.stablePointKey(null, p0), null);
    assert.equal(R.stablePointKey(game, null), null);
});

test('two fade trackers are independent', () => {
    const a = R.createFadeTracker(null);
    const b = R.createFadeTracker(null);
    a.advance('p1', 0, 1000);
    a.advance('p1', 2, 2000);                     // indices 0..1 demoted → cohort at t=2000
    const fa = a.advance('p1', 2, 2500);
    assert.equal(fa.shown(0), true);
    assert.equal(fa.shown(2), true);
    assert.match(fa.fadeAnimFor(0), /fpFadeOut 5000ms linear -500ms forwards/);
    assert.equal(fa.fadeAnimFor(2), '');

    // b sees the same boundary for the first time: no ghosts, nothing fading.
    const fb = b.advance('p1', 2, 2500);
    assert.equal(fb.shown(0), false);
    assert.equal(fb.fadeAnimFor(0), '');
    assert.equal(fb.shown(2), true);
    // ...and a's cohort is untouched by b's render.
    assert.equal(a.advance('p1', 2, 2600).shown(0), true);

    // Cohorts drop for good after FADE_MS.
    assert.equal(a.advance('p1', 2, 2000 + R.FADE_MS).shown(0), false);
    a.dispose(); b.dispose();
});

test('fade tracker: undo drops overlapping cohorts; point change resets', () => {
    const t = R.createFadeTracker(null);
    t.advance('p1', 0, 0);
    t.advance('p1', 2, 100);                      // cohort [0,2)
    t.advance('p1', 4, 200);                      // cohort [2,4)
    const f = t.advance('p1', 1, 300);            // boundary back to 1 (undo)
    assert.equal(f.fadeAnimFor(1), '');           // solid again
    assert.equal(f.shown(0), false);              // cohort [0,2) overlapped → dropped
    const g = t.advance('p2', 3, 400);            // new point: indices mean something else
    assert.equal(g.shown(0), false);
    assert.equal(g.fadeAnimFor(0), '');
    t.dispose();
});

test('fade tracker schedules exactly one cleanup at the last cohort end', () => {
    const origSet = globalThis.setTimeout, origClear = globalThis.clearTimeout;
    const calls = [];
    globalThis.setTimeout = (fn, ms) => { calls.push(ms); return 99; };
    globalThis.clearTimeout = () => {};
    try {
        const onCleanup = () => {};
        const t = R.createFadeTracker(onCleanup);
        t.advance('p1', 0, 1000);
        assert.deepEqual(calls, []);              // nothing fading yet
        t.advance('p1', 2, 2000);
        assert.deepEqual(calls, [R.FADE_MS + 60]);
        t.advance('p1', 2, 3000);
        assert.deepEqual(calls, [R.FADE_MS + 60, R.FADE_MS - 1000 + 60]);
        t.dispose();
    } finally {
        globalThis.setTimeout = origSet;
        globalThis.clearTimeout = origClear;
    }
});

test('eventLayerHTML draws arrows, indexed markers and the disc', () => {
    R.refreshGeometry(20);
    const v = view('landscape', false, false);
    const events = [
        ev('Throw', { from: { x: 0.1, y: 0.5 }, to: { x: 0.3, y: 0.5 } }),
        ev('Throw', { from: { x: 0.3, y: 0.5 }, to: { x: 1.1, y: 0.5 }, score_flag: true }),
    ];
    const html = R.eventLayerHTML(v, { events, mode: 'offense', pointKey: 'g#0', discLoc: null, fade: null });
    assert.equal((html.match(/<line /g) || []).length, 2);
    assert.match(html, /class="fp-marker completion" data-mkidx="0"/);
    assert.match(html, /class="fp-marker score" data-mkidx="1"/);
    assert.match(html, />1<\/div>/);
    assert.match(html, />G<\/div>/);
    // Disc on the last located event of the current segment: l = 20 + 77 = 97.
    assert.match(html, new RegExp(`fp-disc" style="left:${(97 / 110) * 100}%;top:50%"`));
    // An explicit disc override (pickup spot) wins.
    const html2 = R.eventLayerHTML(v, { events, mode: 'offense', pointKey: 'g#0', discLoc: { x: 0, y: 0 }, fade: null });
    assert.match(html2, new RegExp(`fp-disc" style="left:${(20 / 110) * 100}%;top:0%"`));
    // Only the solid window renders without a tracker.
    const many = Array.from({ length: 6 }, (_, i) => ev('Throw', { from: { x: 0.1 * i, y: 0.5 }, to: { x: 0.1 * (i + 1), y: 0.5 } }));
    const html3 = R.eventLayerHTML(v, { events: many, mode: 'offense', fade: null });
    assert.equal((html3.match(/fp-marker /g) || []).length, R.KEEP_SOLID);
    assert.equal(R.fieldHTML(v, { events, mode: 'offense', fade: null }), R.staticFieldHTML(v) + html);
});

test('staticFieldHTML: labels, bricks and the attack arrow follow the view', () => {
    R.refreshGeometry(20);
    const port = R.staticFieldHTML(view('portrait', false, false));
    assert.match(port, /fp-attack-arrow fp-aa-v/);
    assert.match(port, /rotate\(90deg\)/);
    assert.equal((port.match(/fp-brick/g) || []).length, 2);
    assert.equal((port.match(/fp-ezfill/g) || []).length, 2);
    const land = R.staticFieldHTML(view('landscape', true, true));
    assert.match(land, /fp-attack-arrow fp-aa-h/);
    assert.match(land, /rotate\(180deg\)/);
    assert.match(land, /data-flip="ha"/);
    assert.match(land, /data-flip="ad"/);
});

test('arrowColor / markerStyle', () => {
    assert.equal(R.arrowColor(ev('Throw', { score_flag: true })), '#34d399');
    assert.equal(R.arrowColor(ev('Turnover')), '#fca5a5');
    assert.deepEqual(R.markerStyle(ev('Defense', { interception_flag: true }), 4), { cls: 'block', glyph: 'I' });
    assert.deepEqual(R.markerStyle(ev('Throw'), 4), { cls: 'completion', glyph: '5' });
    assert.deepEqual(R.markerStyle(ev('Pull'), 0), { cls: 'pull', glyph: 'P' });
});

test('chipHTML honors display.showPlayerNumbers', () => {
    const alice = { name: 'Alice', number: 7 };
    globalThis.window.advancedSettings = { get: k => (k === 'display.showPlayerNumbers' ? false : undefined) };
    assert.equal(R.chipHTML(alice, { holder: true }),
        '<div class="fp-chip holder" data-pname="Alice"><span class="fp-nm">Alice</span></div>');
    globalThis.window.advancedSettings = { get: () => undefined };
    assert.equal(R.chipHTML(alice, { armed: true }),
        '<div class="fp-chip armed" data-pname="Alice"><span class="fp-num">7</span><span class="fp-nm">Alice</span></div>');
    assert.equal(R.chipHTML({ name: 'Unknown Player' }, { unknown: true }),
        '<div class="fp-chip unknown" data-pname="Unknown Player"><span class="fp-umark">?</span><span class="fp-nm">Unknown</span></div>');
    delete globalThis.window.advancedSettings;
});

test('actorLayerHTML positions icons with the same number rule and a per-render --fp-dur', () => {
    R.refreshGeometry(20);
    const v = view('landscape', false, false);
    const html = R.actorLayerHTML(v, { Alice: { x: 0.5, y: 0.5 }, Bob: { x: 0, y: 1 } }, {
        players: n => (n === 'Alice' ? { name: 'Alice', number: 7 } : null),
        holder: 'Alice',
        durMs: 300,
    });
    assert.match(html, /^<div class="fp-actors" style="--fp-dur:300ms">/);
    assert.match(html, /class="fp-actor holder" data-pname="Alice" style="left:50%;top:50%"><span class="fp-num">7<\/span><span class="fp-nm">Alice<\/span>/);
    assert.match(html, new RegExp(`class="fp-actor" data-pname="Bob" style="left:${(20 / 110) * 100}%;top:100%"><span class="fp-nm">Bob</span>`));
    assert.equal(R.actorLayerHTML(v, {}, {}), '<div class="fp-actors" style="--fp-dur:0ms"></div>');
});
