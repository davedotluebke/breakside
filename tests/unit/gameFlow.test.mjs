/*
 * Unit tests for utils/gameFlow.js — the point-by-point shape of a game that
 * the Review screen's Game Flow chart and headline lines are built from.
 *
 * The contract under test:
 *  - running scores are recounted from point winners (in-progress points are
 *    skipped, and flagged), and each point carries its classification
 *  - runs are maximal streaks by one side; only streaks of 2+ are reported,
 *    and the biggest per side is null below that
 *  - a tie never changes the leader; a lead change is the other side being in
 *    front after a point
 *  - the first point carrying a halftime marker splits the halves
 *  - describeGameFlow prints nothing for a game with fewer than two points
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// utils/statAccumulator.js (for classifyPoint) reaches utils/helpers.js and
// store/storage.js, which publish window hooks at import time — stub them the
// way setStats.test.mjs does.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { buildGameFlow, describeGameFlow, pointBreakEvents, formatDuration } =
    await import('../../utils/gameFlow.js');

// ── helpers ─────────────────────────────────────────────────────────────

const other = flags => ({ type: 'Other', ...flags });

/**
 * A completed point. `winner` is 'team' | 'opponent'; `startedOn` 'offense' |
 * 'defense'; `extras` are Other events appended to the last possession.
 */
function point(startedOn, winner, { duration = 0, extras = [], possessions = null } = {}) {
    const poss = possessions || [{ offensive: startedOn === 'offense', events: [] }];
    if (extras.length) poss[poss.length - 1].events.push(...extras);
    return { startingPosition: startedOn, winner, players: ['Alice', 'Bob'], totalPointTime: duration, possessions: poss };
}

/** Points from a compact string: 'W' = we won, 'L' = they won; alternate O/D by result. */
function game(sequence, { startOn = 'offense' } = {}) {
    let side = startOn;
    const points = [];
    for (const ch of sequence) {
        const winner = ch === 'W' ? 'team' : 'opponent';
        points.push(point(side, winner));
        // Loser receives next: we start on O after they score, on D after we score.
        side = winner === 'team' ? 'defense' : 'offense';
    }
    return { team: 'Team A', opponent: 'Team B', points };
}

// ── running score and classification ────────────────────────────────────

test('running scores recount from winners and skip an in-progress point', () => {
    const g = game('WLW');
    g.points.push({ startingPosition: 'defense', winner: '', players: [], possessions: [] });
    const flow = buildGameFlow(g);
    assert.equal(flow.points.length, 3);
    assert.deepEqual(flow.points.map(p => [p.number, p.us, p.them, p.diff]), [[1, 1, 0, 1], [2, 1, 1, 0], [3, 2, 1, 1]]);
    assert.deepEqual(flow.final, { us: 2, them: 1 });
    assert.equal(flow.inProgress, true);
});

test('each point carries its side and classification', () => {
    const g = { points: [
        point('offense', 'team'),                                   // clean hold
        point('defense', 'team'),                                   // break
        point('offense', 'opponent'),                               // broken
        point('defense', 'opponent'),                               // opponent hold
        point('offense', 'team', { possessions: [
            { offensive: true, events: [] }, { offensive: false, events: [] }, { offensive: true, events: [] }] }), // dirty hold
    ] };
    const flow = buildGameFlow(g);
    assert.deepEqual(flow.points.map(p => p.startedOn), ['O', 'D', 'O', 'D', 'O']);
    assert.deepEqual(flow.points.map(p => p.kind), ['cleanHold', 'break', 'broken', 'opponentHold', 'hold']);
    assert.equal(flow.inProgress, false);
});

test('an empty or missing game yields an empty flow', () => {
    const flow = buildGameFlow(null);
    assert.deepEqual(flow.points, []);
    assert.deepEqual(flow.final, { us: 0, them: 0 });
    assert.equal(flow.leadChanges, 0);
    assert.deepEqual(flow.biggestRun, { us: null, them: null });
    assert.deepEqual(describeGameFlow(flow), []);
});

// ── runs ────────────────────────────────────────────────────────────────

test('runs are maximal streaks; singles are not runs', () => {
    const flow = buildGameFlow(game('WWWLLWLLLL'));
    assert.deepEqual(flow.runs, [
        { side: 'us', from: 0, to: 2, length: 3 },
        { side: 'them', from: 3, to: 4, length: 2 },
        { side: 'them', from: 6, to: 9, length: 4 },
    ]);
    assert.deepEqual(flow.biggestRun.us, { side: 'us', from: 0, to: 2, length: 3 });
    assert.deepEqual(flow.biggestRun.them, { side: 'them', from: 6, to: 9, length: 4 });
});

test('a side that never won twice in a row has no biggest run', () => {
    const flow = buildGameFlow(game('WLWLWL'));
    assert.deepEqual(flow.runs, []);
    assert.equal(flow.biggestRun.us, null);
    assert.equal(flow.biggestRun.them, null);
});

test('the first of two equal-length runs is the biggest', () => {
    const flow = buildGameFlow(game('WWLLWW'));
    assert.deepEqual(flow.biggestRun.us, { side: 'us', from: 0, to: 1, length: 2 });
});

// ── leads and ties ──────────────────────────────────────────────────────

test('lead changes ignore ties; ties count points that ended level', () => {
    // 1-0, 1-1, 1-2, 2-2, 3-2, 3-3, 3-4
    const flow = buildGameFlow(game('WLLWWLL'));
    assert.equal(flow.leadChanges, 3);   // us → them (1-2), them → us (3-2), us → them (3-4)
    assert.equal(flow.ties, 3);          // 1-1, 2-2, 3-3
    assert.deepEqual(flow.largestLead, { us: 1, them: 1 });
});

test('a wire-to-wire game has no lead changes and no ties', () => {
    const flow = buildGameFlow(game('WWWLWW'));
    assert.equal(flow.leadChanges, 0);
    assert.equal(flow.ties, 0);
    assert.deepEqual(flow.largestLead, { us: 4, them: 0 });
});

// ── halftime, timeouts, durations ───────────────────────────────────────

test('pointBreakEvents reads halftime, hard cap and timeouts by side', () => {
    const p = point('offense', 'team', { extras: [
        other({ timeout_flag: true, calledBy: 'us' }),
        other({ timeout_flag: true, calledBy: 'them' }),
        other({ timeout_flag: true }),                  // legacy, unattributed
        other({ halftime_flag: true, betweenPoints: true }),
        other({ timecap_flag: true }),
    ] });
    assert.deepEqual(pointBreakEvents(p), { halftime: true, hardCap: true, timeoutsUs: 1, timeoutsThem: 1, timeoutsUnknown: 1 });
    assert.deepEqual(pointBreakEvents({ possessions: [] }), { halftime: false, hardCap: false, timeoutsUs: 0, timeoutsThem: 0, timeoutsUnknown: 0 });
});

test('halftime splits the halves at the point that carries the marker', () => {
    const g = game('WWLWLLL');
    g.points[3].possessions[0].events.push(other({ halftime_flag: true, betweenPoints: true }));
    const flow = buildGameFlow(g);
    assert.equal(flow.halftimeAfter, 3);
    assert.equal(flow.points[3].halftimeAfter, true);
    assert.deepEqual(flow.halfScores, { first: { us: 3, them: 1 }, second: { us: 0, them: 3 } });
});

test('no halftime marker means no halves', () => {
    const flow = buildGameFlow(game('WWL'));
    assert.equal(flow.halftimeAfter, null);
    assert.equal(flow.halfScores, null);
});

test('timeouts total across points and the longest timed point is found', () => {
    const g = game('WLW');
    g.points[0].possessions[0].events.push(other({ timeout_flag: true, calledBy: 'us' }));
    g.points[2].possessions[0].events.push(other({ timeout_flag: true, calledBy: 'them' }), other({ timeout_flag: true, calledBy: 'us' }));
    g.points[0].totalPointTime = 90000;
    g.points[1].totalPointTime = 372000;
    const flow = buildGameFlow(g);
    assert.deepEqual(flow.timeouts, { us: 2, them: 1, unknown: 0 });
    assert.equal(flow.longestPoint.number, 2);
    assert.equal(flow.longestPoint.durationMs, 372000);
});

test('untimed points have no longest point', () => {
    assert.equal(buildGameFlow(game('WLW')).longestPoint, null);
});

test('formatDuration prints m:ss and h:mm:ss', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(372000), '6:12');
    assert.equal(formatDuration(3723000), '1:02:03');
    assert.equal(formatDuration(null), '0:00');
});

// ── headline lines ──────────────────────────────────────────────────────

test('describeGameFlow prints runs, leads, halves, longest point and timeouts', () => {
    const g = game('WWWLLWLLLL');
    g.points[4].possessions[0].events.push(other({ halftime_flag: true, betweenPoints: true }));
    g.points[7].possessions[0].events.push(other({ timeout_flag: true, calledBy: 'them' }));
    g.points[1].totalPointTime = 245000;
    const lines = describeGameFlow(buildGameFlow(g), { teamName: 'Team A', opponentName: 'Team B' });
    assert.deepEqual(lines, [
        'Biggest run: Team B 4–0 (points 7–10) · Team A 3–0 (points 1–3)',
        'Lead changes: 1 · Tied once · Largest lead: Team A +3, Team B +2',
        'Halftime: 3–2 Team A · Second half: Team A 1, Team B 4',
        'Longest point: #2, 4:05',
        'Timeouts: Team B 1',
    ]);
});

test('describeGameFlow: a level half reads as a bare score, and no runs line without a run', () => {
    const g = game('WLWL');
    g.points[1].possessions[0].events.push(other({ halftime_flag: true }));
    const lines = describeGameFlow(buildGameFlow(g), { teamName: 'A', opponentName: 'B' });
    assert.deepEqual(lines, [
        'Lead changes: 0 · Tied 2 times · Largest lead: A +1',
        'Halftime: 1–1 · Second half: A 1, B 1',
    ]);
});

test('describeGameFlow is silent for a one-point game', () => {
    assert.deepEqual(describeGameFlow(buildGameFlow(game('W'))), []);
});
