/*
 * buildGameLogEntries (utils/gameLogRenderer.js): the structured form of the
 * game log that the replay viewer scrubs through (docs/replay-viewer-plan.md
 * step 2). Pins the entry kinds, the index/event back-references, the timing
 * derivation rules, and that the text output is unchanged — the existing
 * gameLogRenderer.test.mjs golden still pins the text itself.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildGameLogEntries, buildGameLogText, renderGameLogEntriesHTML, renderGameLogHTML,
} from '../../utils/gameLogRenderer.js';
import { Throw, Turnover, Other, Pull } from '../../store/models.js';

const roster = ['Alice', 'Bob'];
const p = Object.fromEntries(roster.map(n => [n, { name: n }]));
const OPTS = { teamName: 'Us', opponentName: 'Them' };

function makePoint(over = {}) {
    return Object.assign({ players: roster, startingPosition: 'offense', winner: '', possessions: [],
        startTimestamp: null, endTimestamp: null }, over);
}
function makePossession(offensive, events = [], over = {}) {
    return Object.assign({ offensive, events }, over);
}
function makeGame(points) {
    return { team: 'Us', opponent: 'Them', startingPosition: 'offense', points };
}
function stamped(event, at) { event.at = at; return event; }

/** A timed two-point game: an O point we score, a D point they score. */
function timedGame() {
    const t1 = stamped(new Throw({ thrower: p.Alice, receiver: p.Bob }), 1000);
    const t2 = stamped(new Turnover({ thrower: p.Bob, throwaway: true }), 2000);
    const t3 = stamped(new Throw({ thrower: p.Alice, receiver: p.Bob, score: true }), 5000);
    const point1 = makePoint({
        winner: 'team', endTimestamp: new Date(6000),
        possessions: [
            makePossession(true, [t1, t2], { startedAt: 900 }),
            makePossession(false, [], { startedAt: 2500 }),
            makePossession(true, [t3], { startedAt: 4000 }),
        ],
    });
    const pull = stamped(new Pull({ puller: p.Alice, quality: 'Good Pull' }), 9000);
    const to = stamped(new Other({ timeout: true, calledBy: 'us', calledByName: 'Us', betweenPoints: true }), 12000);
    const point2 = makePoint({
        startingPosition: 'defense', winner: 'opponent', endTimestamp: new Date(11000),
        possessions: [makePossession(false, [pull, to], { startedAt: 8500 })],
    });
    return makeGame([point1, point2]);
}

test('joined entry text equals buildGameLogText (with and without header options)', () => {
    const game = timedGame();
    const plain = buildGameLogEntries(game, OPTS).map(e => e.text).join('\n');
    assert.equal(plain, buildGameLogText(game, OPTS));

    const rich = { ...OPTS, versionInfo: 'App Version: 1 (Build 2)\n', rosterNames: roster };
    assert.equal(buildGameLogEntries(game, rich).map(e => e.text).join('\n'), buildGameLogText(game, rich));
    assert.equal(buildGameLogEntries(makeGame([]), OPTS).map(e => e.text).join('\n'), buildGameLogText(makeGame([]), OPTS));
});

test('kind sequence for a timed game', () => {
    const kinds = buildGameLogEntries(timedGame(), OPTS).map(e => e.kind);
    assert.deepEqual(kinds, [
        'header', 'teamroster',
        'roster', 'pullnote', 'possession', 'event', 'event', 'possession', 'possession', 'event',
        'score', 'currentscore',
        'roster', 'pullnote', 'possession', 'event', 'score', 'currentscore', 'after',
    ]);
});

test('versionInfo lines become header entries, one per line', () => {
    const e = buildGameLogEntries(makeGame([]), { ...OPTS, versionInfo: 'A\nB\n' });
    assert.deepEqual(e.map(x => [x.kind, x.text]), [['header', 'A'], ['header', 'B'],
        ['header', 'Game Summary: Us vs. Them.'], ['teamroster', '']]);
});

test('event entries reference their event and indices', () => {
    const game = timedGame();
    const entries = buildGameLogEntries(game, OPTS);
    const ev = entries.filter(e => e.kind === 'event');
    assert.equal(ev.length, 4);
    assert.equal(ev[0].event, game.points[0].possessions[0].events[0]);
    assert.deepEqual([ev[0].pointIdx, ev[0].possIdx, ev[0].eventIdx], [0, 0, 0]);
    assert.deepEqual([ev[2].pointIdx, ev[2].possIdx, ev[2].eventIdx], [0, 2, 0]);
    assert.deepEqual([ev[3].pointIdx, ev[3].possIdx, ev[3].eventIdx], [1, 0, 0]);
    const after = entries.find(e => e.kind === 'after');
    assert.equal(after.event, game.points[1].possessions[0].events[1]);
    assert.equal(after.at, 12000);
});

test('timing: events carry at; possessions carry startedAt; roster uses first timed event; score uses endTimestamp', () => {
    const entries = buildGameLogEntries(timedGame(), OPTS);
    const at = kind => entries.filter(e => e.kind === kind).map(e => e.at);
    assert.deepEqual(at('event'), [1000, 2000, 5000, 9000]);
    assert.deepEqual(at('roster'), [1000, 9000]);
    assert.deepEqual(at('pullnote'), [1000, 9000]);
    assert.deepEqual(at('score'), [6000, 11000]);
    assert.deepEqual(at('currentscore'), [6000, 11000]);
    assert.deepEqual(at('header'), [null]);
});

test('inline Turnover boundary takes the NEXT possession startedAt, else the turnover at; side is opp', () => {
    const entries = buildGameLogEntries(timedGame(), OPTS);
    const poss = entries.filter(e => e.kind === 'possession');
    // point 1: O (900) → inline boundary after the turnover (next possession
    // started 2500) → the third possession's own delimiter (4000)
    assert.deepEqual(poss.slice(0, 3).map(e => [e.at, e.side, e.possIdx]), [[900, 'us', 0], [2500, 'opp', 1], [4000, 'us', 2]]);

    const lone = makeGame([makePoint({ possessions: [makePossession(true, [
        stamped(new Turnover({ thrower: p.Bob, throwaway: true }), 777),
    ], { startedAt: 700 })] })]);
    const lp = buildGameLogEntries(lone, OPTS).filter(e => e.kind === 'possession');
    assert.deepEqual(lp.map(e => [e.at, e.possIdx]), [[700, 0], [777, null]]);
});

test('legacy data (no at, no startedAt, no timestamps) yields at = null everywhere — never synthesized', () => {
    const game = makeGame([makePoint({
        winner: 'team',
        possessions: [makePossession(true, [new Throw({ thrower: p.Alice, receiver: p.Bob, score: true })])],
    })]);
    const entries = buildGameLogEntries(game, OPTS);
    assert.ok(entries.length > 4);
    assert.ok(entries.every(e => e.at === null));
});

test('roster falls back to point.startTimestamp only when no event is timed', () => {
    const inProgress = makeGame([makePoint({
        startTimestamp: new Date(3000),
        possessions: [makePossession(true, [new Throw({ thrower: p.Alice, receiver: p.Bob })])],
    })]);
    assert.equal(buildGameLogEntries(inProgress, OPTS).find(e => e.kind === 'roster').at, 3000);

    const timed = makeGame([makePoint({
        startTimestamp: new Date(3000),
        possessions: [makePossession(true, [stamped(new Throw({ thrower: p.Alice, receiver: p.Bob }), 4444)])],
    })]);
    assert.equal(buildGameLogEntries(timed, OPTS).find(e => e.kind === 'roster').at, 4444);
});

test('score side and periodnote kind', () => {
    const game = timedGame();
    game.points[0].possessions[0].events.push(new Other({ halftime: true, betweenPoints: true }));
    const entries = buildGameLogEntries(game, OPTS);
    assert.deepEqual(entries.filter(e => e.kind === 'score').map(e => e.side), ['us', 'opp']);
    const note = entries.find(e => e.kind === 'periodnote');
    assert.equal(note.text, 'Us will pull to Them and play D. ');
    assert.equal(note.pointIdx, 0);
});

test('renderGameLogEntriesHTML matches renderGameLogHTML plus data-entry indices', () => {
    const game = timedGame();
    const entries = buildGameLogEntries(game, { ...OPTS, rosterNames: roster });
    const html = renderGameLogEntriesHTML(entries, 'Us');
    const stripped = html.replace(/ data-entry="\d+"/g, '');
    assert.equal(stripped, renderGameLogHTML(buildGameLogText(game, { ...OPTS, rosterNames: roster }), 'Us'));
    // indices point at the right entries, and the blank teamroster placeholder is skipped
    const idx = [...html.matchAll(/data-entry="(\d+)"/g)].map(m => +m[1]);
    assert.deepEqual(idx.slice(0, 3), [0, 1, 2]);
    const noRoster = renderGameLogEntriesHTML(buildGameLogEntries(game, OPTS), 'Us');
    const idx2 = [...noRoster.matchAll(/data-entry="(\d+)"/g)].map(m => +m[1]);
    assert.deepEqual(idx2.slice(0, 2), [0, 2]);
    assert.ok(noRoster.includes('data-entry="2">Point 1 roster:'));
});
