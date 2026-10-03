/*
 * Fun stats — the youth "shout-outs" level (StatsLevel.FUN).
 *
 * The other levels are tables: every player, every column, sortable. That is
 * what a coach wants and what a twelve-year-old should not have to read, since
 * the first thing anyone does with a table is find their own row and compare
 * it. Fun keeps only what is worth celebrating and lists only who earned it:
 *
 *   Goals & Assists   every player with at least one, most first. Nobody
 *                     appears with a zero.
 *   Shout-outs        the top N (`topN`, default TOP_N; ties at the cutoff
 *                     all included) in Hockey assists, Ds, Completions, Comp%
 *                     and Hucks. A category nobody has scored in is left out.
 *
 * Nothing negative (turnovers, drops, throwaways, +/-) and nothing a kid can't
 * control (points played, playing time). Comp% needs a minimum number of
 * throws to qualify (`minCompThrows`); left unset it is
 * defaultMinCompThrows(): max(3, the 15th-percentile throw count among the
 * players who threw at all) — never fewer than 3, more on a bigger sample.
 *
 * Pure: reads accumulateGameStats objects, so the screens (ui/funStatsView.js)
 * and the exports (utils/exportWorkbook.js) share it and it runs under
 * node --test.
 */
import { formatPlayerName } from './helpers.js';

const TOP_N = 5;
const MIN_COMP_THROWS_DEFAULT = 3;
const COMP_THROWS_PERCENTILE = 0.15;

/**
 * The shout-out categories, in display order. `value(ps, ctx)` is the ranking
 * number (0 or null = not listed; ctx = {minCompThrows}); `display` formats
 * it; `tiebreak` orders equal values (higher first) before the name does;
 * `hint` may be a function of ctx.
 */
const SHOUTOUT_CATEGORIES = [
    { key: 'ha', label: 'Hockey assists', icon: 'fa-hands-helping',
      hint: 'The pass before the assist',
      value: ps => ps.hockeyAssists || 0 },
    { key: 'ds', label: 'Ds', icon: 'fa-hand-paper',
      hint: 'Blocks and interceptions',
      value: ps => ps.dPlays || 0 },
    { key: 'completions', label: 'Completions', icon: 'fa-check-double',
      hint: 'Throws caught by a teammate',
      value: ps => ps.completions || 0 },
    { key: 'compPct', label: 'Completion %', icon: 'fa-crosshairs',
      hint: ctx => `At least ${ctx.minCompThrows} throw${ctx.minCompThrows === 1 ? '' : 's'}`,
      value: (ps, ctx) => ((ps.totalThrows || 0) > 0 && ps.totalThrows >= ctx.minCompThrows
          ? (ps.completions || 0) / ps.totalThrows : 0),
      display: v => `${Math.round(v * 100)}%`,
      tiebreak: ps => ps.completions || 0 },
    { key: 'hucks', label: 'Hucks', icon: 'fa-rocket',
      hint: 'Long throws completed',
      value: ps => ps.huckCompletions || 0 },
];

function nameOf(player) {
    return formatPlayerName(player) || player.name || '';
}

/**
 * The top `n` entries by value, keeping everyone tied with the n-th. Entries
 * with a zero value are never listed.
 * @param {Array<{value: number, tie?: number, name: string}>} entries
 */
function topWithTies(entries, n) {
    const ranked = entries
        .filter(e => e.value > 0)
        .sort((a, b) => (b.value - a.value) || ((b.tie || 0) - (a.tie || 0)) || a.name.localeCompare(b.name));
    if (ranked.length <= n) return ranked;
    const cut = ranked[n - 1];
    return ranked.filter((e, i) => i < n || (e.value === cut.value && (e.tie || 0) === (cut.tie || 0)));
}

/**
 * The default Comp% minimum: max(3, the 15th-percentile throw count, nearest
 * rank, among players with at least one throw). 3 when nobody threw.
 * @param {Array<object>} players
 * @param {object} playerStats - playerId → accumulated stats
 */
function defaultMinCompThrows(players, playerStats) {
    const throws = (players || [])
        .map(p => ((playerStats && p && playerStats[p.id]) || {}).totalThrows || 0)
        .filter(n => n > 0)
        .sort((a, b) => a - b);
    if (!throws.length) return MIN_COMP_THROWS_DEFAULT;
    const p15 = throws[Math.max(0, Math.ceil(COMP_THROWS_PERCENTILE * throws.length) - 1)];
    return Math.max(MIN_COMP_THROWS_DEFAULT, p15);
}

/** Clamp a user-entered count to a whole number >= 1, or null when blank/invalid. */
function positiveIntOrNull(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Build the Fun view of a set of players' stats.
 *
 * Ranks always run over the whole `players` list. `onlyPlayerId` then narrows
 * what is returned to that one player's lines, for the single-player export:
 * their shout-outs, in the context they were earned.
 *
 * @param {Array<object>} players - {id, name, ...}
 * @param {object} playerStats - playerId → accumulated stats
 * @param {object} [opts]
 * @param {number} [opts.topN] - default TOP_N
 * @param {number|null} [opts.minCompThrows] - null = defaultMinCompThrows
 * @param {string} [opts.onlyPlayerId]
 * @returns {{topN, minCompThrows, scorers: Array<{player, name, goals, assists}>,
 *            shoutouts: Array<{key, label, icon, hint, entries: Array<{player, name, value, text}>}>}}
 */
function buildFunStats(players, playerStats, { topN = TOP_N, minCompThrows = null, onlyPlayerId = '' } = {}) {
    const roster = (players || []).filter(p => p && p.id);
    topN = positiveIntOrNull(topN) || TOP_N;
    const ctx = { minCompThrows: positiveIntOrNull(minCompThrows) || defaultMinCompThrows(roster, playerStats) };
    const statsOf = p => (playerStats && playerStats[p.id]) || {};
    const keep = e => !onlyPlayerId || e.player.id === onlyPlayerId;

    const scorers = roster
        .map(p => ({ player: p, name: nameOf(p), goals: statsOf(p).goals || 0, assists: statsOf(p).assists || 0 }))
        .filter(e => e.goals > 0 || e.assists > 0)
        .sort((a, b) => (b.goals - a.goals) || (b.assists - a.assists) || a.name.localeCompare(b.name))
        .filter(keep);

    const shoutouts = SHOUTOUT_CATEGORIES.map(cat => {
        const entries = topWithTies(roster.map(p => ({
            player: p,
            name: nameOf(p),
            value: cat.value(statsOf(p), ctx),
            tie: cat.tiebreak ? cat.tiebreak(statsOf(p)) : 0,
        })), topN)
            .filter(keep)
            .map(({ player, name, value }) => ({
                player, name, value, text: cat.display ? cat.display(value) : String(value),
            }));
        const hint = typeof cat.hint === 'function' ? cat.hint(ctx) : cat.hint;
        return { key: cat.key, label: cat.label, icon: cat.icon, hint, entries };
    }).filter(s => s.entries.length > 0);

    return { topN, minCompThrows: ctx.minCompThrows, scorers, shoutouts };
}

/** True when there is nothing to celebrate yet (no goals, no shout-outs). */
function funStatsEmpty(fun) {
    return !fun || (!fun.scorers.length && !fun.shoutouts.length);
}

// --- ES-module exports ---
export {
    buildFunStats, funStatsEmpty, defaultMinCompThrows, positiveIntOrNull,
    SHOUTOUT_CATEGORIES, TOP_N,
};
