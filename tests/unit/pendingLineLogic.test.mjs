/*
 * Unit tests pinning the pendingNextLine machine (store/pendingLineLogic.js),
 * extracted from store/sync.js, game/selectLine.js, and
 * game/gameScreenEvents.js in the F3 sweep.
 *
 * Run: node --test tests/unit/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    toMs, mergePendingNextLine, resolveEffectiveLine, resetPendingLinesAtPointEnd,
} from '../../store/pendingLineLogic.js';

const T0 = 1700000000000;   // arbitrary epoch base
const MIN = 60000;

// ── toMs ────────────────────────────────────────────────────────────────

test('toMs: numbers pass through, ISO strings parse, junk → 0', () => {
    assert.equal(toMs(T0), T0);
    assert.equal(toMs(new Date(T0).toISOString()), T0);
    assert.equal(toMs(new Date(T0)), T0);
    assert.equal(toMs(null), 0);
    assert.equal(toMs(undefined), 0);
    assert.equal(toMs('not-a-date'), 0);
});

// ── mergePendingNextLine ────────────────────────────────────────────────

test('merge: newer server line wins, older is ignored, per line type', () => {
    const local = {
        odLine: ['L1'], odLineModifiedAt: T0 + MIN,
        oLine: ['L2'], oLineModifiedAt: T0,
    };
    const server = {
        odLine: ['S1'], odLineModifiedAt: T0,           // older — ignored
        oLine: ['S2'], oLineModifiedAt: T0 + 2 * MIN,   // newer — wins
    };
    const merged = mergePendingNextLine(server, local);
    assert.equal(merged, local);                        // mutates + returns local
    assert.deepEqual(merged.odLine, ['L1']);
    assert.deepEqual(merged.oLine, ['S2']);
    assert.equal(merged.oLineModifiedAt, T0 + 2 * MIN);
});

test('merge: signal groups (lineupReady, lcViewing, useSeparateLines) each on own timestamp', () => {
    const local = {
        lineupReadyAt: T0, lineupReadyBy: 'Old LC',
        lineCoachViewingAt: T0 + MIN, lineCoachViewing: 'od',
        useSeparateLinesAt: T0, useSeparateLines: false,
    };
    const server = {
        lineupReadyAt: T0 + MIN, lineupReadyBy: 'New LC',   // newer
        lineCoachViewingAt: T0, lineCoachViewing: 'o',      // older — ignored
        useSeparateLinesAt: T0 + MIN, useSeparateLines: true, // newer
    };
    const merged = mergePendingNextLine(server, local);
    assert.equal(merged.lineupReadyBy, 'New LC');
    assert.equal(merged.lineCoachViewing, 'od');
    assert.equal(merged.useSeparateLines, true);
});

test('merge: missing timestamps always lose', () => {
    const local = { odLine: ['keep'], odLineModifiedAt: T0 };
    const merged = mergePendingNextLine({ odLine: ['srv'] }, local);
    assert.deepEqual(merged.odLine, ['keep']);
});

// ── resolveEffectiveLine ────────────────────────────────────────────────

function gameWith(pending, lastPlayers = []) {
    return {
        pendingNextLine: pending,
        points: lastPlayers.length ? [{ players: lastPlayers }] : [],
    };
}

test('resolve: no pendingNextLine → empty od', () => {
    assert.deepEqual(resolveEffectiveLine(null, true), { source: 'od', line: [] });
    assert.deepEqual(resolveEffectiveLine({ points: [] }, true), { source: 'od', line: [] });
});

test('resolve priority 2: newer non-empty typed line wins over odLine', () => {
    const game = gameWith({
        oLine: ['A'], oLineModifiedAt: T0 + MIN,
        odLine: ['B'], odLineModifiedAt: T0,
    });
    assert.deepEqual(resolveEffectiveLine(game, true), { source: 'o', line: ['A'] });
    // For a D point the oLine is irrelevant — odLine wins (dLine unset → 0)
    assert.deepEqual(resolveEffectiveLine(game, false), { source: 'od', line: ['B'] });
});

test('resolve priority 1: fresher LC view overrides timestamps (od view)', () => {
    const game = gameWith({
        oLine: ['A'], oLineModifiedAt: T0 + MIN,
        odLine: ['B'], odLineModifiedAt: T0,
        lineCoachViewing: 'od', lineCoachViewingAt: T0 + 2 * MIN,
    });
    assert.deepEqual(resolveEffectiveLine(game, true), { source: 'od', line: ['B'] });
});

test('resolve priority 1: LC view never flips the side (o view on a D point → dLine)', () => {
    const game = gameWith({
        dLine: ['D'], dLineModifiedAt: T0,
        odLine: ['B'], odLineModifiedAt: T0,
        lineCoachViewing: 'o', lineCoachViewingAt: T0 + MIN,
    });
    // view 'o' on a defense point resolves to the DETERMINED side's line
    assert.deepEqual(resolveEffectiveLine(game, false), { source: 'd', line: ['D'] });
});

test("resolve priority 1: 'odOnDeck' view is not a Next-line preference", () => {
    const game = gameWith({
        oLine: ['A'], oLineModifiedAt: T0 + MIN,
        odLine: ['B'], odLineModifiedAt: T0,
        lineCoachViewing: 'odOnDeck', lineCoachViewingAt: T0 + 2 * MIN,
    });
    // falls through to priority 2 — newer oLine wins
    assert.deepEqual(resolveEffectiveLine(game, true), { source: 'o', line: ['A'] });
});

test('resolve priority 3: most-recent winner empty → same-side fallback, never opposite side', () => {
    const game = gameWith({
        oLine: [], oLineModifiedAt: T0 + MIN,     // newest but empty
        dLine: ['D'], dLineModifiedAt: T0,        // opposite side — must NOT be used
        odLine: ['B'], odLineModifiedAt: T0,
    });
    assert.deepEqual(resolveEffectiveLine(game, true), { source: 'od', line: ['B'] });
});

test('resolve priority 4: all same-side lines empty → last point players, tagged with side', () => {
    const game = gameWith({ oLine: [], odLine: [] }, ['P1', 'P2']);
    const result = resolveEffectiveLine(game, true);
    assert.deepEqual(result, { source: 'o', line: ['P1', 'P2'] });
    // and a fresh copy, not the point's own array
    assert.notEqual(result.line, game.points[0].players);
});

test('resolve priority 4: nothing anywhere → empty line, side-tagged', () => {
    assert.deepEqual(resolveEffectiveLine(gameWith({}), false), { source: 'd', line: [] });
});

// ── resetPendingLinesAtPointEnd ─────────────────────────────────────────

function gameAtPointEnd({ pending, points, gameStart = T0 } = {}) {
    return {
        gameStartTimestamp: new Date(gameStart),
        points,
        pendingNextLine: pending,
    };
}

test('reset: no points / no players / no pending → no-op', () => {
    const pending = { odLine: ['X'] };
    resetPendingLinesAtPointEnd(gameAtPointEnd({ pending, points: [] }));
    assert.deepEqual(pending.odLine, ['X']);
    resetPendingLinesAtPointEnd(gameAtPointEnd({ pending, points: [{ players: [] }] }));
    assert.deepEqual(pending.odLine, ['X']);
    // no pendingNextLine — must not throw
    resetPendingLinesAtPointEnd(gameAtPointEnd({ pending: null, points: [{ players: ['A'] }] }));
});

test('reset: odLine not modified during the point window → overwritten with ending 7', () => {
    const pending = { odLine: ['Old'], odLineModifiedAt: T0 + MIN };
    const points = [
        { players: ['A'], endTimestamp: new Date(T0 + 2 * MIN) },  // previous point end
        { players: ['P1', 'P2'] },                                  // just finished
    ];
    resetPendingLinesAtPointEnd(gameAtPointEnd({ pending, points }));
    assert.deepEqual(pending.odLine, ['P1', 'P2']);
});

test('reset: odLine modified during the point window → preserved', () => {
    const pending = { odLine: ['Keep'], odLineModifiedAt: T0 + 3 * MIN };
    const points = [
        { players: ['A'], endTimestamp: new Date(T0 + 2 * MIN) },
        { players: ['P1'] },
    ];
    resetPendingLinesAtPointEnd(gameAtPointEnd({ pending, points }));
    assert.deepEqual(pending.odLine, ['Keep']);
});

test('reset: modified-but-EMPTY odLine still overwritten (empty-line fallback)', () => {
    const pending = { odLine: [], odLineModifiedAt: T0 + 3 * MIN };
    const points = [
        { players: ['A'], endTimestamp: new Date(T0 + 2 * MIN) },
        { players: ['P1'] },
    ];
    resetPendingLinesAtPointEnd(gameAtPointEnd({ pending, points }));
    assert.deepEqual(pending.odLine, ['P1']);
});

test('reset: o/d lines only overwritten if never modified this game (or empty)', () => {
    const pending = {
        oLine: ['KeepO'], oLineModifiedAt: T0 + MIN,   // modified after game start — kept
        dLine: ['OldD'], dLineModifiedAt: T0 - MIN,    // predates game start — reset
    };
    const points = [{ players: ['P1'] }];   // first point of the game
    resetPendingLinesAtPointEnd(gameAtPointEnd({ pending, points }));
    assert.deepEqual(pending.oLine, ['KeepO']);
    assert.deepEqual(pending.dLine, ['P1']);
});

test('reset: first point uses gameStartTimestamp as the window reference', () => {
    // odLine modified BEFORE game start → overwritten
    const pending = { odLine: ['Stale'], odLineModifiedAt: T0 - MIN };
    const points = [{ players: ['P1'] }];
    resetPendingLinesAtPointEnd(gameAtPointEnd({ pending, points }));
    assert.deepEqual(pending.odLine, ['P1']);
});
