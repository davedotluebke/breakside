/*
 * Unit tests pinning the shared game-log renderer (utils/gameLogRenderer.js),
 * extracted in the G6 merge from the three drifting copies (gameLogic
 * summarizeGame, gameScreenSync updateGameLogEvents, gameSummary
 * renderGameSummaryEventLog).
 *
 * Run: node --test tests/unit/*.test.mjs
 * (no deps — plain node:test against the ES modules; the renderer is a pure
 * leaf module with no DOM, so no shimming is needed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildGameLogText, classifyGameLogLine, renderGameLogHTML, escapeHtml,
} from '../../utils/gameLogRenderer.js';
import { Throw, Turnover, Other, Pull } from '../../store/models.js';

// ── helpers ─────────────────────────────────────────────────────────────

/** Minimal stand-in event: fixed summarize() text. */
function stubEvent(text, type = 'Stub') {
    return { type, summarize: () => text };
}

function makePoint({ players = [], startingPosition = 'offense', winner = '', possessions = [] } = {}) {
    return { players, startingPosition, winner, possessions };
}

function makePossession(offensive, events = []) {
    return { offensive, events };
}

function makeGame({ team = 'Us', opponent = 'Them', startingPosition = 'offense', points = [] } = {}) {
    return { team, opponent, startingPosition, points };
}

const OPTS = { teamName: 'Us', opponentName: 'Them' };

// ── header composition ──────────────────────────────────────────────────

test('empty game → header line only', () => {
    const text = buildGameLogText(makeGame(), OPTS);
    assert.equal(text, 'Game Summary: Us vs. Them.\n');
});

test('versionInfo and rosterNames prepend the in-game/clipboard header', () => {
    const text = buildGameLogText(makeGame(), {
        ...OPTS,
        versionInfo: 'App Version: 1.9.0 (Build 42)\n',
        rosterNames: ['Alice', 'Bob'],
    });
    assert.equal(text,
        'App Version: 1.9.0 (Build 42)\n'
        + 'Game Summary: Us vs. Them.\n'
        + 'Us roster: Alice Bob');
});

// ── per-point structure ─────────────────────────────────────────────────

test('offense point: roster, pull line, possession delimiter, event, score lines', () => {
    const game = makeGame({
        points: [makePoint({
            players: ['Alice', 'Bob'],
            startingPosition: 'offense',
            winner: 'team',
            possessions: [makePossession(true, [stubEvent('Alice scoober to Bob.')])],
        })],
    });
    assert.equal(buildGameLogText(game, OPTS),
        'Game Summary: Us vs. Them.\n'
        + '\nPoint 1 roster: Alice Bob'
        + '\nThem pulls to Us.'
        + '\n— Us on offense —'
        + '\nAlice scoober to Bob.'
        + '\nUs scores! '
        + '\nCurrent score: Us 1, Them 0');
});

test('defense start uses the mirrored pull line and defense delimiter', () => {
    const game = makeGame({
        points: [makePoint({
            startingPosition: 'defense',
            winner: 'opponent',
            possessions: [makePossession(false, [stubEvent('Pull by Alice')])],
        })],
    });
    const text = buildGameLogText(game, OPTS);
    assert.match(text, /\nUs pulls to Them\./);
    assert.match(text, /\n— Us on defense —/);
    assert.match(text, /\nThem scores! /);
    assert.match(text, /\nCurrent score: Us 0, Them 1/);
});

test('running score accumulates across points', () => {
    const game = makeGame({
        points: [
            makePoint({ winner: 'team' }),
            makePoint({ winner: 'opponent' }),
            makePoint({ winner: 'team' }),
        ],
    });
    const text = buildGameLogText(game, OPTS);
    assert.match(text, /Current score: Us 1, Them 0/);
    assert.match(text, /Current score: Us 1, Them 1/);
    assert.match(text, /Current score: Us 2, Them 1/);
});

test('unscored (in-progress) point emits no score or Current score lines', () => {
    const game = makeGame({
        points: [makePoint({ possessions: [makePossession(true, [stubEvent('Alice throws ')])] })],
    });
    const text = buildGameLogText(game, OPTS);
    assert.ok(!text.includes(' scores!'));
    assert.ok(!text.includes('Current score:'));
});

// ── Turnover possession-boundary logic (the drift that was only in
//    summarizeGame and never reached the post-game summary) ─────────────

test('Turnover emits an inline defense boundary and suppresses the next possession delimiter', () => {
    const turnover = new Turnover({ thrower: { name: 'Alice' }, throwaway: true });
    const game = makeGame({
        points: [makePoint({
            winner: 'opponent',
            possessions: [
                makePossession(true, [stubEvent('Alice throws to Bob '), turnover]),
                makePossession(false, [stubEvent('They work it up.')]),
            ],
        })],
    });
    const text = buildGameLogText(game, OPTS);
    const boundaries = text.match(/— Us on defense —/g) || [];
    // exactly one defense boundary: the inline one; the defensive
    // possession's own delimiter is suppressed
    assert.equal(boundaries.length, 1);
    // and it appears between the turnover and the next possession's event
    const lines = text.split('\n');
    const idxTurn = lines.findIndex(l => l.includes('throws it away'));
    assert.equal(lines[idxTurn + 1], '— Us on defense —');
    assert.equal(lines[idxTurn + 2], 'They work it up.');
});

test('Turnover-only possession (no Defense event yet) still shows the boundary', () => {
    const turnover = new Turnover({ thrower: { name: 'Alice' }, throwaway: true });
    const game = makeGame({
        points: [makePoint({
            possessions: [makePossession(true, [turnover])],
        })],
    });
    const text = buildGameLogText(game, OPTS);
    assert.match(text, /— Us on defense —$/);
});

// ── betweenPoints deferral (the fix that had to be written twice) ───────

test('betweenPoints events are deferred past the score lines', () => {
    const timeout = new Other({ timeout: true, calledByName: 'Us', betweenPoints: true });
    const game = makeGame({
        points: [makePoint({
            winner: 'team',
            possessions: [makePossession(true, [stubEvent('Alice hucks to Bob for the score!'), timeout])],
        })],
    });
    const lines = buildGameLogText(game, OPTS).split('\n');
    const idxScore = lines.findIndex(l => l === 'Current score: Us 1, Them 0');
    assert.ok(idxScore >= 0);
    assert.equal(lines[idxScore + 1], 'Timeout called by Us. ');
});

// ── period-break bookkeeping ────────────────────────────────────────────

test('halftime flips period opening: offense start → "will pull and play D" note', () => {
    const halftime = new Other({ halftime: true, betweenPoints: true });
    const game = makeGame({
        startingPosition: 'offense',
        points: [makePoint({
            winner: 'team',
            possessions: [makePossession(true, [halftime])],
        })],
    });
    const text = buildGameLogText(game, OPTS);
    assert.match(text, /\nUs will pull to Them and play D\. $/);
});

test('halftime from a defense-opened period → "will receive the pull" note', () => {
    const halftime = new Other({ halftime: true, betweenPoints: true });
    const game = makeGame({
        startingPosition: 'defense',
        points: [makePoint({
            winner: 'team',
            possessions: [makePossession(true, [halftime])],
        })],
    });
    assert.match(buildGameLogText(game, OPTS), /\nUs will receive the pull and play O\. $/);
});

test('two period breaks on the same point cancel (accidental tap + correction)', () => {
    const ht1 = new Other({ halftime: true, betweenPoints: true });
    const ht2 = new Other({ switchsides: true, betweenPoints: true });
    const game = makeGame({
        points: [makePoint({
            winner: 'team',
            possessions: [makePossession(true, [ht1, ht2])],
        })],
    });
    const text = buildGameLogText(game, OPTS);
    assert.ok(!text.includes('will receive the pull'));
    assert.ok(!text.includes('will pull to'));
});

test('forceswap flips the period bookkeeping a later halftime reads from', () => {
    const swap = new Other({ forceswap: true, betweenPoints: true });
    const halftime = new Other({ halftime: true, betweenPoints: true });
    const game = makeGame({
        startingPosition: 'offense',
        points: [
            makePoint({ winner: 'team', possessions: [makePossession(true, [swap])] }),
            makePoint({ winner: 'team', possessions: [makePossession(true, [halftime])] }),
        ],
    });
    // offense → forceswap → defense → halftime flips back to offense
    assert.match(buildGameLogText(game, OPTS), /\nUs will receive the pull and play O\. $/);
});

// ── score badges (post-game summary surface) ────────────────────────────

test('scoreBadge callback labels scored points; null label leaves line unchanged', () => {
    const game = makeGame({
        points: [
            makePoint({ winner: 'team' }),
            makePoint({ winner: 'opponent' }),
        ],
    });
    const text = buildGameLogText(game, {
        ...OPTS,
        scoreBadge: (point) => point.winner === 'team' ? 'clean hold' : null,
    });
    assert.match(text, /\nUs scores!  \[clean hold\] /);
    assert.match(text, /\nThem scores! \n/);
});

// ── line classification ─────────────────────────────────────────────────

test('classifyGameLogLine covers every branch', () => {
    const team = 'Us';
    assert.equal(classifyGameLogLine('Us scores!  [break] ', team),
        'game-log-line game-log-score-event game-log-us-scores');
    assert.equal(classifyGameLogLine('Them scores! ', team),
        'game-log-line game-log-score-event game-log-them-scores');
    assert.equal(classifyGameLogLine('Point 3 roster: Alice Bob', team),
        'game-log-line game-log-point-header');
    assert.equal(classifyGameLogLine('Current score: Us 1, Them 0', team),
        'game-log-line game-log-current-score');
    assert.equal(classifyGameLogLine('Them pulls to Us.', team),
        'game-log-line game-log-pull');
    assert.equal(classifyGameLogLine('— Us on offense —', team),
        'game-log-line game-log-possession-header game-log-possession-offense');
    assert.equal(classifyGameLogLine('— Us on defense —', team),
        'game-log-line game-log-possession-header game-log-possession-defense');
    assert.equal(classifyGameLogLine('App Version: 1.9.0 (Build 42)', team),
        'game-log-line game-log-header');
    assert.equal(classifyGameLogLine('Game Summary: Us vs. Them.', team),
        'game-log-line game-log-header');
    assert.equal(classifyGameLogLine('Us roster: Alice Bob', team),
        'game-log-line game-log-roster');
    assert.equal(classifyGameLogLine('Alice throws to Bob ', team),
        'game-log-line');
});

// ── HTML rendering ──────────────────────────────────────────────────────

test('renderGameLogHTML wraps non-blank lines in classed divs and escapes HTML', () => {
    const html = renderGameLogHTML('Game Summary: Us vs. Them.\n\nA <b>bold</b> & risky play', 'Us');
    assert.equal(html,
        '<div class="game-log-line game-log-header">Game Summary: Us vs. Them.</div>'
        + '<div class="game-log-line">A &lt;b&gt;bold&lt;/b&gt; &amp; risky play</div>');
});

test('escapeHtml escapes &, <, > (ampersand first) and maps null/undefined to empty', () => {
    assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});

// ── golden integration test: real model events, real scenario ───────────
// Mirrors the browser scenario used for the G6 before/after capture: the
// expected text below is exactly what the pre-merge summarizeGame() produced
// (captured live on build da052d4), minus the App Version line.

test('golden: full three-point game matches the pre-merge summarizeGame output', () => {
    const roster = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace'];
    const p = Object.fromEntries(roster.map(n => [n, { name: n }]));

    const point1 = makePoint({
        players: roster, startingPosition: 'offense', winner: 'team',
        possessions: [makePossession(true, [
            new Throw({ thrower: p.Alice, receiver: p.Bob, score: true }),
            new Other({ timeout: true, calledBy: 'us', calledByName: 'LogDiff', betweenPoints: true }),
            new Other({ halftime: true, betweenPoints: true }),
        ])],
    });
    const point2 = makePoint({
        players: roster, startingPosition: 'defense', winner: 'opponent',
        possessions: [makePossession(false, [
            new Pull({ puller: p.Alice, quality: 'Good Pull' }),
        ])],
    });
    const point3 = makePoint({
        players: roster, startingPosition: 'offense', winner: 'team',
        possessions: [makePossession(true, [
            new Throw({ thrower: p.Carol, receiver: p.Dave, score: true }),
        ])],
    });
    const game = makeGame({
        team: 'LogDiff', opponent: 'Bad Guys',
        startingPosition: 'offense',
        points: [point1, point2, point3],
    });

    const text = buildGameLogText(game, {
        teamName: 'LogDiff', opponentName: 'Bad Guys', rosterNames: roster,
    });

    assert.equal(text, [
        'Game Summary: LogDiff vs. Bad Guys.',
        'LogDiff roster: Alice Bob Carol Dave Eve Frank Grace',
        'Point 1 roster: Alice Bob Carol Dave Eve Frank Grace',
        'Bad Guys pulls to LogDiff.',
        '— LogDiff on offense —',
        'Alice throws to Bob for the score!',
        'LogDiff scores! ',
        'Current score: LogDiff 1, Bad Guys 0',
        'Timeout called by LogDiff. ',
        'Halftime — teams switch ends. ',
        'LogDiff will pull to Bad Guys and play D. ',
        'Point 2 roster: Alice Bob Carol Dave Eve Frank Grace',
        'LogDiff pulls to Bad Guys.',
        '— LogDiff on defense —',
        'Pull by Alice (Good Pull)',
        'Bad Guys scores! ',
        'Current score: LogDiff 1, Bad Guys 1',
        'Point 3 roster: Alice Bob Carol Dave Eve Frank Grace',
        'Bad Guys pulls to LogDiff.',
        '— LogDiff on offense —',
        'Carol throws to Dave for the score!',
        'LogDiff scores! ',
        'Current score: LogDiff 2, Bad Guys 1',
    ].join('\n'));
});
