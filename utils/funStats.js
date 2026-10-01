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
 *   Shout-outs        the top few (TOP_N, ties at the cutoff all included) in
 *                     Hockey assists, Ds, Completions, Comp% and Hucks. A
 *                     category nobody has scored in is left out.
 *
 * Nothing negative (turnovers, drops, throwaways, +/-) and nothing a kid can't
 * control (points played, playing time). Comp% needs MIN_COMP_THROWS attempts
 * to qualify, so a 1-for-1 doesn't top the list.
 *
 * Pure: reads accumulateGameStats objects, so the screens (ui/funStatsView.js)
 * and the exports (utils/exportWorkbook.js) share it and it runs under
 * node --test.
 */
import { formatPlayerName } from './helpers.js';

const TOP_N = 5;
const MIN_COMP_THROWS = 10;

/**
 * The shout-out categories, in display order. `value(ps)` is the ranking
 * number (0 or null = not listed); `display` formats it; `tiebreak` orders
 * equal values (higher first) before the name does.
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
      hint: `At least ${MIN_COMP_THROWS} throws`,
      value: ps => ((ps.totalThrows || 0) >= MIN_COMP_THROWS ? (ps.completions || 0) / ps.totalThrows : 0),
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
 * Build the Fun view of a set of players' stats.
 *
 * Ranks always run over the whole `players` list. `onlyPlayerId` then narrows
 * what is returned to that one player's lines, for the single-player export:
 * their shout-outs, in the context they were earned.
 *
 * @param {Array<object>} players - {id, name, ...}
 * @param {object} playerStats - playerId → accumulated stats
 * @param {object} [opts]
 * @param {number} [opts.topN]
 * @param {string} [opts.onlyPlayerId]
 * @returns {{scorers: Array<{player, name, goals, assists}>,
 *            shoutouts: Array<{key, label, icon, hint, entries: Array<{player, name, value, text}>}>}}
 */
function buildFunStats(players, playerStats, { topN = TOP_N, onlyPlayerId = '' } = {}) {
    const roster = (players || []).filter(p => p && p.id);
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
            value: cat.value(statsOf(p)),
            tie: cat.tiebreak ? cat.tiebreak(statsOf(p)) : 0,
        })), topN)
            .filter(keep)
            .map(({ player, name, value }) => ({
                player, name, value, text: cat.display ? cat.display(value) : String(value),
            }));
        return { key: cat.key, label: cat.label, icon: cat.icon, hint: cat.hint, entries };
    }).filter(s => s.entries.length > 0);

    return { scorers, shoutouts };
}

/** True when there is nothing to celebrate yet (no goals, no shout-outs). */
function funStatsEmpty(fun) {
    return !fun || (!fun.scorers.length && !fun.shoutouts.length);
}

// --- ES-module exports ---
export { buildFunStats, funStatsEmpty, SHOUTOUT_CATEGORIES, TOP_N, MIN_COMP_THROWS };
