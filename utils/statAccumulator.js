/*
 * Pure player/team stat aggregation.
 *
 * Everything here is a plain function over already-loaded Game objects: no
 * network, no DOM, no app state. utils/eventStats.js layers the cloud-loading
 * event/team wrappers on top and re-exports all of this, so existing callers
 * can keep importing either module. Keeping the pure half free of the
 * store/sync.js import is what lets it be unit-tested (and imported by leaf
 * consumers) without pulling in the whole app graph.
 */

import { Role } from '../store/models.js';
import { buildPlayerNameResolver } from './helpers.js';

/**
 * Accumulate stats from a single game into an existing stats map.
 * Shared by getGamePlayerStats and getEventPlayerStats.
 * @param {object} game - Deserialized Game object
 * @param {object} stats - Mutable map of playerId → stats (will be populated)
 */
function accumulateGameStats(game, stats) {
    const resolveName = buildPlayerNameResolver(game);

    function ensurePlayer(id, name) {
        if (!stats[id]) {
            stats[id] = {
                name,
                pointsPlayed: 0,
                timePlayed: 0,
                goals: 0,
                assists: 0,
                hockeyAssists: 0,
                huckHockeyAssists: 0,
                turnovers: 0,
                plusMinus: 0,
                pointsWon: 0,
                pointsLost: 0,
                completions: 0,
                huckCompletions: 0,
                totalThrows: 0,
                totalHucks: 0,
                dPlays: 0,
                // "Full" stats level breakdowns. throwaways + drops split the
                // turnover total by fault: throwaways are charged to the
                // thrower (including stalls), drops to the intended receiver.
                // They don't sum to `turnovers` — a dropped pass charges the
                // thrower a turnover too (but not a throwaway).
                throwaways: 0,
                drops: 0,
                pulls: 0,
                pullsGood: 0,
                pullsOkay: 0,
                pullsPoor: 0,
                pullsBrick: 0
            };
        }
        return stats[id];
    }

    // Resolve a player reference that may be a resolved object ({name, id, ...})
    // or (legacy/live) a bare name string, to a {name, id} pair.
    function resolveRef(ref) {
        if (ref && typeof ref === 'object') {
            return { name: ref.name, id: ref.id || (ref.name ? resolveName(ref.name) : null) };
        }
        if (ref) return { name: ref, id: resolveName(ref) };
        return { name: null, id: null };
    }

    const points = game.points || [];
    points.forEach(point => {
        if (!point.winner) return; // skip in-progress points

        const pointPlayers = point.players || [];
        const pointDuration = point.totalPointTime || 0;
        const isWin = point.winner === 'team' || point.winner === Role.TEAM;

        pointPlayers.forEach(playerName => {
            const id = resolveName(playerName);
            // playerName may itself be an id (id-era games) — prefer the
            // resolver's known display name so stats-only rows stay readable.
            const s = ensurePlayer(id, resolveName.nameOf(id) || playerName);
            s.pointsPlayed++;
            s.timePlayed += pointDuration;
            if (isWin) {
                s.pointsWon++;
                s.plusMinus++;
            } else {
                s.pointsLost++;
                s.plusMinus--;
            }
        });

        // Count goals, assists, turnovers, completions, hucks, dPlays from events
        (point.possessions || []).forEach(poss => {
            const events = poss.events || [];
            events.forEach((event, idx) => {
                if (event.type === 'Throw') {
                    const thrower = resolveRef(event.thrower);
                    if (thrower.name) {
                        const s = ensurePlayer(thrower.id, thrower.name);
                        s.totalThrows++;
                        s.completions++;
                        if (event.huck_flag) {
                            s.totalHucks++;
                            s.huckCompletions++;
                        }
                        if (event.score_flag) s.assists++;
                    }
                    if (event.score_flag) {
                        const receiver = resolveRef(event.receiver);
                        if (receiver.name) ensurePlayer(receiver.id, receiver.name).goals++;

                        // Hockey assist: previous Throw in this possession.
                        // Walk back, skipping non-Throw events (Violations etc).
                        for (let j = idx - 1; j >= 0; j--) {
                            const prev = events[j];
                            if (prev.type === 'Throw') {
                                const ha = resolveRef(prev.thrower);
                                if (ha.name) {
                                    const s = ensurePlayer(ha.id, ha.name);
                                    s.hockeyAssists++;
                                    if (prev.huck_flag) s.huckHockeyAssists++;
                                }
                                break;
                            }
                        }
                    }
                } else if (event.type === 'Turnover') {
                    // Fault attribution: exactly one player is charged, and a
                    // drop goes wholly on the receiver. The throw itself was
                    // good, so a dropped pass touches NOTHING on the thrower —
                    // not the turnover, and not Throws/Hucks either, so it
                    // neither helps nor hurts their Comp%/Huck%. (Their Throws
                    // count is therefore completions + throwaways + stalls,
                    // which can be fewer than the passes they released.)
                    if (event.drop_flag) {
                        const receiver = resolveRef(event.receiver);
                        if (receiver.name) {
                            const s = ensurePlayer(receiver.id, receiver.name);
                            s.turnovers++;
                            s.drops++;
                        }
                    } else {
                        const thrower = resolveRef(event.thrower);
                        if (thrower.name) {
                            const s = ensurePlayer(thrower.id, thrower.name);
                            s.turnovers++;
                            s.throwaways++;
                            s.totalThrows++;
                            if (event.huck_flag) s.totalHucks++;
                        }
                    }
                } else if (event.type === 'Defense') {
                    const defender = resolveRef(event.defender);
                    if (defender.name) ensurePlayer(defender.id, defender.name).dPlays++;
                } else if (event.type === 'Pull') {
                    const puller = resolveRef(event.puller);
                    if (puller.name) {
                        const s = ensurePlayer(puller.id, puller.name);
                        s.pulls++;
                        // Field mode records a brick via brick_flag without
                        // setting `quality`; the pull dialog sets `quality`.
                        if (event.quality === 'Good Pull') s.pullsGood++;
                        else if (event.quality === 'Okay Pull') s.pullsOkay++;
                        else if (event.quality === 'Poor Pull') s.pullsPoor++;
                        else if (event.quality === 'Brick' || event.brick_flag) s.pullsBrick++;
                    }
                }
            });
        });
    });
}

// Every additive per-player counter accumulateGameStats maintains. Rate
// columns (Comp%, +/- per pt) are recomputed from these sums rather than
// averaged, so a Team row built by sumPlayerStats is correct for both.
const SUMMABLE_STAT_FIELDS = [
    'pointsPlayed', 'timePlayed', 'goals', 'assists',
    'hockeyAssists', 'huckHockeyAssists',
    'completions', 'totalThrows', 'huckCompletions', 'totalHucks',
    'dPlays', 'turnovers', 'throwaways', 'drops', 'plusMinus',
    'pointsWon', 'pointsLost',
    'pulls', 'pullsGood', 'pullsOkay', 'pullsPoor', 'pullsBrick'
];

/**
 * Sum a list of per-player stats objects into one Team-row stats object.
 * @param {Array<object>} psList
 * @returns {object} stats object with the same summable fields
 */
function sumPlayerStats(psList) {
    const tot = {};
    SUMMABLE_STAT_FIELDS.forEach(f => { tot[f] = 0; });
    (psList || []).forEach(ps => {
        if (!ps) return;
        SUMMABLE_STAT_FIELDS.forEach(f => { tot[f] += ps[f] || 0; });
    });
    return tot;
}

/**
 * Classify a completed point from the tracking team's perspective.
 * @param {object} point - Point with startingPosition, winner, possessions
 * @returns {'break' | 'cleanHold' | 'hold' | 'broken' | 'opponentHold' | null}
 *   - 'break'        — started on D, we scored
 *   - 'cleanHold'    — started on O, we scored with no turnovers
 *   - 'hold'         — started on O, we scored after at least one turnover
 *   - 'broken'       — started on O, opponent scored
 *   - 'opponentHold' — started on D, opponent scored (we failed to break)
 *   - null           — point is not yet complete or data is missing
 */
function classifyPoint(point) {
    if (!point || !point.winner) return null;
    const startedOnO = point.startingPosition === 'offense';
    const weWon = point.winner === 'team' || point.winner === Role.TEAM;
    const numPoss = (point.possessions || []).length;

    if (startedOnO && weWon) return numPoss <= 1 ? 'cleanHold' : 'hold';
    if (startedOnO && !weWon) return 'broken';
    if (!startedOnO && weWon) return 'break';
    return 'opponentHold';
}

/**
 * Aggregate team-level point classifications for a single game.
 * @param {object} game - Deserialized Game object
 * @returns {object} { breaks, opponentBreaks, cleanHolds, dirtyHolds,
 *                     holdOpps, breakOpps, breakPossOpps, total }
 *   - holdOpps = number of points started on O (chances to hold)
 *   - breakOpps = number of points started on D (chances to break)
 *   - breakPossOpps = number of defensive possessions across all completed
 *     points (a D-point can contain multiple D-possessions if the team
 *     gives the disc back; per-possession break rate is the truer measure
 *     of D-line conversion efficiency)
 *   - opponentBreaks = points we started on O but lost (= got broken)
 */
function getGameTeamStats(game) {
    const totals = {
        breaks: 0, opponentBreaks: 0,
        cleanHolds: 0, dirtyHolds: 0,
        holdOpps: 0, breakOpps: 0, breakPossOpps: 0,
        total: 0
    };
    if (!game) return totals;
    (game.points || []).forEach(point => {
        const kind = classifyPoint(point);
        if (!kind) return;
        totals.total++;
        if (point.startingPosition === 'offense') totals.holdOpps++;
        else totals.breakOpps++;
        (point.possessions || []).forEach(p => {
            if (p && p.offensive === false) totals.breakPossOpps++;
        });
        if (kind === 'break') totals.breaks++;
        else if (kind === 'cleanHold') totals.cleanHolds++;
        else if (kind === 'hold') totals.dirtyHolds++;
        else if (kind === 'broken') totals.opponentBreaks++;
    });
    return totals;
}

/**
 * Restrict an already-loaded game list to a phase and/or a single game.
 * Callers that load an event's games once (see loadEventGames) can then switch
 * filters without re-fetching. Both options null/undefined → everything.
 * @param {Array<object>} games
 * @param {object} [options] - { phase: string|null, gameId: string|null }
 * @returns {Array<object>}
 */
function filterGames(games, options = {}) {
    const { phase = null, gameId = null } = options;
    return (games || []).filter(game => {
        if (phase !== undefined && phase !== null && game.phase !== phase) return false;
        if (gameId !== undefined && gameId !== null && game.id !== gameId) return false;
        return true;
    });
}

/**
 * Aggregate player stats across an already-loaded list of games.
 * @param {Array<object>} games
 * @returns {Object} Map of playerId → stats
 */
function getGamesPlayerStats(games) {
    const stats = {};
    (games || []).forEach(game => accumulateGameStats(game, stats));
    return stats;
}

/**
 * Aggregate team-level point classifications across an already-loaded list of
 * games. Same shape as getGameTeamStats.
 * @param {Array<object>} games
 */
function getGamesTeamStats(games) {
    const totals = {
        breaks: 0, opponentBreaks: 0,
        cleanHolds: 0, dirtyHolds: 0,
        holdOpps: 0, breakOpps: 0, breakPossOpps: 0,
        total: 0
    };
    (games || []).forEach(game => {
        const g = getGameTeamStats(game);
        Object.keys(totals).forEach(k => { totals[k] += g[k] || 0; });
    });
    return totals;
}

/**
 * W/L/T record across an already-loaded list of games.
 * @param {Array<object>} games
 * @returns {{ wins: number, losses: number, ties: number }}
 */
function getGamesRecord(games) {
    let wins = 0, losses = 0, ties = 0;
    (games || []).forEach(game => {
        const teamScore = game.scores?.[Role.TEAM] || game.scores?.team || 0;
        const oppScore = game.scores?.[Role.OPPONENT] || game.scores?.opponent || 0;
        if (teamScore > oppScore) wins++;
        else if (oppScore > teamScore) losses++;
        else if (game.gameEndTimestamp) ties++;
    });
    return { wins, losses, ties };
}

/** "v. Storm" — how a single game is labelled in menus and sheet tabs. */
function formatGameLabel(game) {
    const opponent = (game && game.opponent) ? String(game.opponent).trim() : '';
    return opponent ? `v. ${opponent}` : 'v. (unnamed)';
}

/**
 * Format a team-stats object as a human-readable summary, one stat per line
 * so the breakdown doesn't wrap mid-stat on narrow phone screens.
 * @param {object} t - team stats from getGameTeamStats / getEventTeamStats
 * @returns {string} newline-separated lines (render with CSS white-space: pre-line)
 */
function formatTeamStatsLine(t) {
    if (!t || t.total === 0) return '';
    const lines = [];
    lines.push(`Breaks: ${t.breaks}/${t.breakOpps} D-point${t.breakOpps === 1 ? '' : 's'}` +
               (t.breakPossOpps > 0
                    ? ` (${t.breaks}/${t.breakPossOpps} D-possession${t.breakPossOpps === 1 ? '' : 's'})`
                    : ''));
    lines.push(`Holds: ${t.cleanHolds} clean + ${t.dirtyHolds} dirty / ${t.holdOpps} O-point${t.holdOpps === 1 ? '' : 's'}`);
    return lines.join('\n');
}

/**
 * Get player stats for a single game.
 * @param {object} game - Deserialized Game object
 * @returns {Object} Map of playerId → stats
 */
function getGamePlayerStats(game) {
    if (!game) return {};
    const stats = {};
    accumulateGameStats(game, stats);
    return stats;
}

// --- ES-module exports ---
export {
    accumulateGameStats,
    sumPlayerStats,
    classifyPoint,
    getGameTeamStats,
    filterGames,
    getGamesPlayerStats,
    getGamesTeamStats,
    getGamesRecord,
    formatGameLabel,
    formatTeamStatsLine,
    getGamePlayerStats
};
