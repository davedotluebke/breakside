/*
 * Unit tests for store/scrimmageRules.js — the pure half of scrimmage
 * variations. What is pinned: how a stored rules object normalizes, which
 * side a drill's fixed puller puts each half on, and the decisions the
 * scoring entry points act on (scoreOutcome / turnoverOutcome) under the
 * conversion rules, the possession limits and two-point plays — plus the
 * score recount every stored game goes through on load.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    NO_SCORE, VARIATIONS, variationById, normalizeRules, gameRules,
    possessionLimit, conversionRule, twoPointPlaysEnabled, fixedPointStart,
    scoreOutcome, turnoverOutcome, manualEndControl,
    pointValueOf, recountScores, rulesSummary,
} from '../../store/scrimmageRules.js';

// ── fixtures ────────────────────────────────────────────────────────────

/** A squad-game: squad X ("Dark") under the given rules. */
function squadGame(rules, squad = 'X') {
    return {
        scrimmageId: 'Scrimmage-2026-10-25-ab12', scrimmageSquad: squad,
        team: squad === 'X' ? 'Dark' : 'Light', opponent: squad === 'X' ? 'Light' : 'Dark',
        scrimmageRules: rules,
    };
}

/** A live point with `n` possessions played and an optional pending conversion. */
function point(n = 0, pendingConversion = null) {
    return { winner: '', possessions: Array.from({ length: n }, () => ({ events: [] })), pendingConversion, pointValue: 1 };
}

const TEN_PULL = { variation: 'tenPull', twoPointPlays: false, puller: 'X' };
const TEN_POSS = { variation: 'tenPossession', twoPointPlays: false, puller: 'Y' };
const DOUBLE = { variation: 'doubleScore', twoPointPlays: false, puller: null };
const EXTRA = { variation: 'extraPoint', twoPointPlays: true, puller: null };

// ── the catalogue and normalization ─────────────────────────────────────

test('every variation has an id, a label and a hint; standard is the fallback', () => {
    VARIATIONS.forEach(v => {
        assert.ok(v.id && v.label && v.hint, v.id);
    });
    assert.equal(variationById('nonsense').id, 'standard');
    assert.equal(variationById(undefined).id, 'standard');
    assert.equal(variationById('tenPull').possessionLimit, 2);
    assert.equal(variationById('tenPossession').possessionLimit, 1);
    assert.equal(variationById('doubleScore').conversion, 'double');
    assert.equal(variationById('extraPoint').conversion, 'extraPoint');
});

test('normalizeRules: nothing varying from a plain scrimmage reads as null', () => {
    assert.equal(normalizeRules(null), null);
    assert.equal(normalizeRules(undefined), null);
    assert.equal(normalizeRules({}), null);
    assert.equal(normalizeRules({ variation: 'standard' }), null);
    assert.equal(normalizeRules({ variation: 'standard', twoPointPlays: false, puller: 'X' }), null);
});

test('normalizeRules: keeps a variation, coerces the toggle, drops a bad puller', () => {
    assert.deepEqual(normalizeRules({ variation: 'tenPull', twoPointPlays: 1, puller: 'Z' }),
        { variation: 'tenPull', twoPointPlays: true, puller: null });
    assert.deepEqual(normalizeRules({ variation: 'standard', twoPointPlays: true }),
        { variation: 'standard', twoPointPlays: true, puller: null });
    assert.deepEqual(normalizeRules({ variation: 'made-up', puller: 'Y' }), null, 'an unknown variation is standard');
    assert.equal(gameRules({}), null);
    assert.equal(gameRules(null), null);
});

test('knob readers: possession limit, conversion, two-point plays', () => {
    assert.equal(possessionLimit(squadGame(TEN_PULL)), 2);
    assert.equal(possessionLimit(squadGame(TEN_POSS)), 1);
    assert.equal(possessionLimit(squadGame(DOUBLE)), null);
    assert.equal(possessionLimit(squadGame(null)), null);
    assert.equal(conversionRule(squadGame(DOUBLE)), 'double');
    assert.equal(conversionRule(squadGame(EXTRA)), 'extraPoint');
    assert.equal(conversionRule(squadGame(TEN_PULL)), null);
    assert.equal(twoPointPlaysEnabled(squadGame(EXTRA)), true);
    assert.equal(twoPointPlaysEnabled(squadGame(DOUBLE)), false);
    assert.equal(twoPointPlaysEnabled({ scrimmageRules: { variation: 'standard', twoPointPlays: true } }), true);
});

// ── the fixed puller ────────────────────────────────────────────────────

test('fixedPointStart: the pulling squad starts every point on defense, the other on offense', () => {
    assert.equal(fixedPointStart(squadGame(TEN_PULL, 'X')), 'defense');
    assert.equal(fixedPointStart(squadGame(TEN_PULL, 'Y')), 'offense');
    assert.equal(fixedPointStart(squadGame(TEN_POSS, 'X')), 'offense');
    assert.equal(fixedPointStart(squadGame(TEN_POSS, 'Y')), 'defense');
});

test('fixedPointStart: null without a drill, a puller or a squad', () => {
    assert.equal(fixedPointStart(squadGame(DOUBLE)), null);
    assert.equal(fixedPointStart(squadGame(null)), null);
    assert.equal(fixedPointStart(squadGame({ variation: 'tenPull', puller: null })), null);
    assert.equal(fixedPointStart({ scrimmageRules: TEN_PULL }), null, 'a real game has no squad');
});

// ── scores ──────────────────────────────────────────────────────────────

test('scoreOutcome: no rules — the point ends, one point', () => {
    assert.deepEqual(scoreOutcome({}, point(), 'team'), { action: 'end', winner: 'team', value: 1 });
    assert.deepEqual(scoreOutcome(null, point(), 'opponent'), { action: 'end', winner: 'opponent', value: 1 });
});

test('scoreOutcome: a two-point play is worth two on the score that ends the point', () => {
    const game = { scrimmageRules: { variation: 'standard', twoPointPlays: true } };
    assert.deepEqual(scoreOutcome(game, point(), 'team', { twoPoint: true }), { action: 'end', winner: 'team', value: 2 });
    assert.deepEqual(scoreOutcome(game, point(), 'opponent', { twoPoint: false }), { action: 'end', winner: 'opponent', value: 1 });
    // Drills score like plain games
    assert.deepEqual(scoreOutcome(squadGame(TEN_PULL), point(1), 'opponent'), { action: 'end', winner: 'opponent', value: 1 });
});

test('scoreOutcome: double score — the first score is pending, the second ends the point for one', () => {
    const game = squadGame(DOUBLE);
    assert.deepEqual(scoreOutcome(game, point(1), 'team'), { action: 'pending', by: 'team' });
    assert.deepEqual(scoreOutcome(game, point(1, 'team'), 'team'), { action: 'end', winner: 'team', value: 1, converted: true });
    assert.deepEqual(scoreOutcome(game, point(2, 'opponent'), 'opponent'), { action: 'end', winner: 'opponent', value: 1, converted: true });
});

test('scoreOutcome: double score — the other side scoring while a conversion is pending voids it and goes pending itself', () => {
    const game = squadGame(DOUBLE);
    assert.deepEqual(scoreOutcome(game, point(2, 'team'), 'opponent'), { action: 'pending', by: 'opponent', voided: 'team' });
});

test('scoreOutcome: extra point — pending first, then two when converted', () => {
    const game = squadGame({ ...EXTRA, twoPointPlays: false });
    assert.deepEqual(scoreOutcome(game, point(1), 'team'), { action: 'pending', by: 'team' });
    assert.deepEqual(scoreOutcome(game, point(1, 'team'), 'team'), { action: 'end', winner: 'team', value: 2, converted: true });
});

test('scoreOutcome: extra point — the other side scoring while a conversion is pending ends the point at one for the pending side', () => {
    const game = squadGame(EXTRA);
    assert.deepEqual(scoreOutcome(game, point(1, 'team'), 'opponent'),
        { action: 'end', winner: 'team', value: 1, missed: true, dropped: 'opponent' });
});

test('scoreOutcome: the two-point box only counts on the ending score', () => {
    const game = squadGame(EXTRA);
    assert.deepEqual(scoreOutcome(game, point(1), 'team', { twoPoint: true }), { action: 'pending', by: 'team' });
    assert.deepEqual(scoreOutcome(game, point(1, 'team'), 'team', { twoPoint: true }),
        { action: 'end', winner: 'team', value: 3, converted: true });
});

// ── turnovers ───────────────────────────────────────────────────────────

test('turnoverOutcome: nothing happens without rules, or with possessions to spare', () => {
    assert.deepEqual(turnoverOutcome({}, point(3)), { action: 'none' });
    assert.deepEqual(turnoverOutcome(squadGame(TEN_PULL), point(1)), { action: 'none' });
    assert.deepEqual(turnoverOutcome(squadGame(DOUBLE), point(4)), { action: 'none' }, 'no pending conversion');
});

test('turnoverOutcome: the possession limit ends the rep with no score', () => {
    const dead = { action: 'end', winner: NO_SCORE, value: 0, dead: true };
    assert.deepEqual(turnoverOutcome(squadGame(TEN_PULL), point(2)), dead);
    assert.deepEqual(turnoverOutcome(squadGame(TEN_PULL), point(3)), dead, 'over the limit counts too');
    assert.deepEqual(turnoverOutcome(squadGame(TEN_POSS), point(1)), dead);
    assert.deepEqual(turnoverOutcome(squadGame(TEN_POSS), point(0)), { action: 'none' }, 'Simple mode: no possessions recorded');
});

test('turnoverOutcome: a pending double-score conversion is voided, play on', () => {
    assert.deepEqual(turnoverOutcome(squadGame(DOUBLE), point(2, 'team')), { action: 'clearPending', missedBy: 'team' });
    assert.deepEqual(turnoverOutcome(squadGame(DOUBLE), point(2, 'opponent')), { action: 'clearPending', missedBy: 'opponent' });
});

test('turnoverOutcome: a missed extra point ends the point at one', () => {
    assert.deepEqual(turnoverOutcome(squadGame(EXTRA), point(2, 'team')), { action: 'end', winner: 'team', value: 1, missed: true });
    assert.deepEqual(turnoverOutcome(squadGame(EXTRA), point(1, 'opponent')), { action: 'end', winner: 'opponent', value: 1, missed: true });
});

test('manualEndControl: Missed while a conversion is pending, No Score under a possession limit, else nothing', () => {
    assert.equal(manualEndControl(squadGame(DOUBLE), point(1)), null);
    assert.equal(manualEndControl(squadGame(DOUBLE), point(1, 'team')).kind, 'missed');
    assert.equal(manualEndControl(squadGame(EXTRA), point(1, 'opponent')).kind, 'missed');
    assert.equal(manualEndControl(squadGame(TEN_PULL), point(0)).kind, 'dead');
    assert.equal(manualEndControl(squadGame(TEN_POSS), point(1)).kind, 'dead');
    assert.equal(manualEndControl(squadGame(null), point(1)), null);
    assert.equal(manualEndControl({ scrimmageRules: { variation: 'standard', twoPointPlays: true } }, point(1)), null);
});

// ── the scoreboard ──────────────────────────────────────────────────────

test('pointValueOf: 0 while live or for a no-score rep, the stored value otherwise, 1 when absent', () => {
    assert.equal(pointValueOf(point()), 0);
    assert.equal(pointValueOf({ winner: NO_SCORE, pointValue: 0 }), 0);
    assert.equal(pointValueOf({ winner: 'team', pointValue: 2 }), 2);
    assert.equal(pointValueOf({ winner: 'team' }), 1, 'points stored before the field existed');
    assert.equal(pointValueOf({ winner: 'opponent', pointValue: 'x' }), 1);
    assert.equal(pointValueOf(null), 0);
});

test('recountScores: sums point values per side; no-score reps and live points add nothing', () => {
    const points = [
        { winner: 'team' },                       // legacy, 1
        { winner: 'opponent', pointValue: 2 },    // two-point play
        { winner: NO_SCORE, pointValue: 0 },      // dead rep
        { winner: 'team', pointValue: 2 },        // converted extra point
        { winner: '', pointValue: 1 },            // live
    ];
    assert.deepEqual(recountScores(points), { team: 3, opponent: 2 });
    assert.deepEqual(recountScores([]), { team: 0, opponent: 0 });
    assert.deepEqual(recountScores(null), { team: 0, opponent: 0 });
});

test('rulesSummary: one line per rule in play, empty without rules', () => {
    assert.equal(rulesSummary(squadGame(null)), '');
    assert.equal(rulesSummary(squadGame(TEN_PULL), { X: 'Dark', Y: 'Light' }), 'Ten-pull drill · Dark pulls');
    assert.equal(rulesSummary(squadGame(TEN_PULL)), 'Ten-pull drill · Squad X pulls');
    assert.equal(rulesSummary(squadGame(EXTRA)), 'Extra point · two-point plays');
    assert.equal(rulesSummary({ scrimmageRules: { variation: 'standard', twoPointPlays: true } }), 'two-point plays');
});
