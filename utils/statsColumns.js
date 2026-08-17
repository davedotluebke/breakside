/*
 * The stats columns — one definition, every surface.
 *
 * Three screens show a roster + stats table (the Event Roster + Stats screen,
 * the Review screen for a single completed game, and the team Roster + Stats
 * screen) and all three can export the same table to .xlsx. They used to carry
 * their own hand-maintained column lists, which drifted: Review shipped a
 * hard-coded 13-column set that ignored the Stats menu entirely. This module is
 * the single source of truth they all read from.
 *
 * Two lists, deliberately:
 *   STATS_COLUMNS        what the on-screen tables render — display strings
 *                        ("12:30", "67%", "+3"), sortable via `type`.
 *   SHEET_STATS_COLUMNS  what the xlsx exports write — real Excel values, so a
 *                        spreadsheet can do arithmetic on them. It differs from
 *                        the screen list on purpose: Minutes (decimal) instead
 *                        of Time (mm:ss), spelled-out Throwaways instead of
 *                        TAs, pull quality split into four sortable columns
 *                        instead of one "G/O/P/B" string, and unsigned numbers
 *                        instead of "+3".
 * They are kept adjacent, in the same order, so any drift between them is
 * visible in one screenful.
 *
 * `level` matches the Stats menu (see utils/statsLevel.js); a column with no
 * level always shows. `value(ps)` reads an accumulateGameStats stats object —
 * the Team row passes the summed object, so rate columns recompute from the
 * totals rather than averaging per-player rates.
 */
import { StatsLevel, columnsForLevel } from './statsLevel.js';
import { formatPlayTime } from './helpers.js';

// ── shared cell formatters ──────────────────────────────────────────────
// Pure display helpers used by the column definitions below and by the team
// roster screen, which builds its own row shape around the same numbers.

/** "+3" / "0" / "-2" — leading "+" for positive values, used by every +/- column. */
function formatSigned(value) {
    return value > 0 ? `+${value}` : `${value}`;
}

/** Same as formatSigned, but for values that need a fixed decimal count (e.g. per-point +/-). */
function formatSignedFixed(value, digits) {
    const fixed = value.toFixed(digits);
    return value > 0 ? `+${fixed}` : fixed;
}

/** "67%" when attempts were made, otherwise `dash`. Shared Comp%/Huck% formatting. */
function formatPercentOrDash(made, attempted, dash = '-') {
    return attempted > 0 ? `${((made / attempted) * 100).toFixed(0)}%` : dash;
}

/**
 * "+0.33" / "0.0" — a +/- rate over the points it was earned in, preserving the
 * historical zero-points text. Used for the overall rate and both O/D splits.
 */
function formatPerPoint(plusMinus, points) {
    return (points || 0) > 0 ? ((plusMinus || 0) / points).toFixed(2) : '0.0';
}

/** "3/1/0/1" — good/okay/poor/brick pull counts, or `dash` when none were rated. */
function formatPullQuality(ps, dash = '-') {
    const rated = (ps.pullsGood || 0) + (ps.pullsOkay || 0) + (ps.pullsPoor || 0) + (ps.pullsBrick || 0);
    if (!rated) return dash;
    return `${ps.pullsGood || 0}/${ps.pullsOkay || 0}/${ps.pullsPoor || 0}/${ps.pullsBrick || 0}`;
}

/** The xlsx flavour of a rate: a real number to 3 decimals, 0 when no points. */
function perPointNumber(plusMinus, points) {
    return (points || 0) > 0 ? +((plusMinus || 0) / points).toFixed(3) : 0;
}

/** The xlsx flavour of a percentage: a 0–1 fraction, or null when no attempts. */
function percentFraction(made, attempted) {
    return (attempted || 0) > 0 ? +((made || 0) / attempted).toFixed(4) : null;
}

// ── on-screen columns, in table order ───────────────────────────────────
// Callers prepend their own identity columns (a checkbox and/or Name), which
// carry per-row click handlers and gender styling, so those stay local.

const STATS_COLUMNS = [
    { key: 'pts',      label: 'Pts',      level: StatsLevel.BASIC,    type: 'number',
      value: ps => ps.pointsPlayed || 0 },
    { key: 'time',     label: 'Time',     level: StatsLevel.BASIC,    type: 'time',
      value: ps => formatPlayTime(ps.timePlayed || 0) },
    { key: 'goals',    label: 'Goals',    level: StatsLevel.BASIC,    type: 'number',
      value: ps => ps.goals || 0 },
    { key: 'assists',  label: 'Assists',  level: StatsLevel.BASIC,    type: 'number',
      value: ps => ps.assists || 0 },
    { key: 'ha',       label: 'HA',       level: StatsLevel.ADVANCED, type: 'number',
      value: ps => ps.hockeyAssists || 0 },
    { key: 'huckHa',   label: 'Huck HA',  level: StatsLevel.ADVANCED, type: 'number',
      value: ps => ps.huckHockeyAssists || 0 },
    { key: 'throws',   label: 'Throws',   level: StatsLevel.FULL,     type: 'number',
      value: ps => ps.totalThrows || 0 },
    { key: 'compPct',  label: 'Comp%',    level: StatsLevel.ADVANCED, type: 'percentage',
      value: ps => formatPercentOrDash(ps.completions || 0, ps.totalThrows || 0) },
    { key: 'huckPct',  label: 'Huck%',    level: StatsLevel.ADVANCED, type: 'percentage',
      value: ps => formatPercentOrDash(ps.huckCompletions || 0, ps.totalHucks || 0) },
    { key: 'ds',       label: 'Ds',       level: StatsLevel.ADVANCED, type: 'number',
      value: ps => ps.dPlays || 0 },
    { key: 'tos',      label: 'TOs',      level: StatsLevel.ADVANCED, type: 'number',
      value: ps => ps.turnovers || 0 },
    { key: 'tas',      label: 'TAs',      level: StatsLevel.FULL,     type: 'number',
      value: ps => ps.throwaways || 0 },
    { key: 'drops',    label: 'Drops',    level: StatsLevel.FULL,     type: 'number',
      value: ps => ps.drops || 0 },
    { key: 'plusMinus', label: '+/-',     level: StatsLevel.ADVANCED, type: 'number',
      value: ps => formatSigned(ps.plusMinus || 0) },
    { key: 'pmPerPt',  label: '..per pt', level: StatsLevel.ADVANCED, type: 'number',
      value: ps => formatSigned(formatPerPoint(ps.plusMinus, ps.pointsPlayed)) },
    // The O/D split: the same two numbers restricted to points that started on
    // offense / on defense. A player who takes both lines has their O-line and
    // D-line contribution read separately here.
    { key: 'plusMinusO', label: 'O +/-',      level: StatsLevel.FULL, type: 'number',
      value: ps => formatSigned(ps.plusMinusO || 0) },
    { key: 'pmPerPtO',   label: '..per O pt', level: StatsLevel.FULL, type: 'number',
      value: ps => formatSigned(formatPerPoint(ps.plusMinusO, ps.pointsPlayedO)) },
    { key: 'plusMinusD', label: 'D +/-',      level: StatsLevel.FULL, type: 'number',
      value: ps => formatSigned(ps.plusMinusD || 0) },
    { key: 'pmPerPtD',   label: '..per D pt', level: StatsLevel.FULL, type: 'number',
      value: ps => formatSigned(formatPerPoint(ps.plusMinusD, ps.pointsPlayedD)) },
    { key: 'pulls',    label: 'Pulls',    level: StatsLevel.FULL,     type: 'number',
      value: ps => ps.pulls || 0 },
    { key: 'pullQuality', label: 'G/O/P/B', level: StatsLevel.FULL,   type: 'string',
      value: ps => formatPullQuality(ps) }
];

/** The on-screen stats columns the given (or active) level shows. */
function screenStatsColumns(level) {
    return columnsForLevel(STATS_COLUMNS, level);
}

// ── xlsx columns, in sheet order ────────────────────────────────────────
// `width` feeds !cols; `fmt` drives the Excel number format ('pct', 'dec2').

const SHEET_STATS_COLUMNS = [
    { label: 'Name',        width: 22, value: (ps, name) => name },
    { label: 'Pts',         width: 6,  level: StatsLevel.BASIC,    value: ps => ps.pointsPlayed || 0 },
    { label: 'Minutes',     width: 9,  level: StatsLevel.BASIC,    fmt: 'dec2',
      value: ps => (ps.timePlayed || 0) > 0 ? +((ps.timePlayed || 0) / 60000).toFixed(2) : 0 },
    { label: 'Goals',       width: 7,  level: StatsLevel.BASIC,    value: ps => ps.goals || 0 },
    { label: 'Assists',     width: 8,  level: StatsLevel.BASIC,    value: ps => ps.assists || 0 },
    { label: 'HA',          width: 5,  level: StatsLevel.ADVANCED, value: ps => ps.hockeyAssists || 0 },
    { label: 'Huck HA',     width: 9,  level: StatsLevel.ADVANCED, value: ps => ps.huckHockeyAssists || 0 },
    { label: 'Throws',      width: 8,  level: StatsLevel.FULL,     value: ps => ps.totalThrows || 0 },
    { label: 'Comp%',       width: 8,  level: StatsLevel.ADVANCED, fmt: 'pct',
      value: ps => percentFraction(ps.completions, ps.totalThrows) },
    { label: 'Huck%',       width: 8,  level: StatsLevel.ADVANCED, fmt: 'pct',
      value: ps => percentFraction(ps.huckCompletions, ps.totalHucks) },
    { label: 'Ds',          width: 5,  level: StatsLevel.ADVANCED, value: ps => ps.dPlays || 0 },
    { label: 'TOs',         width: 5,  level: StatsLevel.ADVANCED, value: ps => ps.turnovers || 0 },
    { label: 'Throwaways',  width: 11, level: StatsLevel.FULL,     value: ps => ps.throwaways || 0 },
    { label: 'Drops',       width: 7,  level: StatsLevel.FULL,     value: ps => ps.drops || 0 },
    { label: '+/-',         width: 6,  level: StatsLevel.ADVANCED, value: ps => ps.plusMinus || 0 },
    { label: '+/- per pt',  width: 11, level: StatsLevel.ADVANCED,
      value: ps => perPointNumber(ps.plusMinus, ps.pointsPlayed) },
    // The O/D split. O pts / D pts ship alongside so the sheet carries the
    // denominators the two rates are built from.
    { label: 'O pts',        width: 7,  level: StatsLevel.FULL,    value: ps => ps.pointsPlayedO || 0 },
    { label: 'O +/-',        width: 7,  level: StatsLevel.FULL,    value: ps => ps.plusMinusO || 0 },
    { label: 'O +/- per pt', width: 12, level: StatsLevel.FULL,
      value: ps => perPointNumber(ps.plusMinusO, ps.pointsPlayedO) },
    { label: 'D pts',        width: 7,  level: StatsLevel.FULL,    value: ps => ps.pointsPlayedD || 0 },
    { label: 'D +/-',        width: 7,  level: StatsLevel.FULL,    value: ps => ps.plusMinusD || 0 },
    { label: 'D +/- per pt', width: 12, level: StatsLevel.FULL,
      value: ps => perPointNumber(ps.plusMinusD, ps.pointsPlayedD) },
    { label: 'Pulls',       width: 7,  level: StatsLevel.FULL,     value: ps => ps.pulls || 0 },
    { label: 'Good',        width: 6,  level: StatsLevel.FULL,     value: ps => ps.pullsGood || 0 },
    { label: 'Okay',        width: 6,  level: StatsLevel.FULL,     value: ps => ps.pullsOkay || 0 },
    { label: 'Poor',        width: 6,  level: StatsLevel.FULL,     value: ps => ps.pullsPoor || 0 },
    { label: 'Brick',       width: 6,  level: StatsLevel.FULL,     value: ps => ps.pullsBrick || 0 }
];

/** The xlsx column specs the given (or active) level exports. */
function sheetStatsColumns(level) {
    return columnsForLevel(SHEET_STATS_COLUMNS, level);
}

// --- ES-module exports ---
export {
    STATS_COLUMNS, screenStatsColumns,
    SHEET_STATS_COLUMNS, sheetStatsColumns,
    formatSigned, formatSignedFixed, formatPercentOrDash,
    formatPerPoint, formatPullQuality,
};
