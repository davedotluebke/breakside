/*
 * Event-Level Statistics
 * Computes aggregate player stats across all games in a TournamentEvent.
 * Loads games from cloud via loadGameFromCloud since games aren't bulk-loaded
 * onto the team object until individually opened.
 */

import { Role } from '../store/models.js';
import { currentTeam } from '../store/storage.js';
import { loadGameFromCloud, listServerGames } from '../store/sync.js';

/**
 * Load all games for an event from cloud storage.
 * @param {object} event - TournamentEvent with gameIds array
 * @returns {Promise<Array>} Array of deserialized Game objects
 */
async function loadEventGames(event) {
    const gameIds = event?.gameIds || [];
    if (gameIds.length === 0) return [];

    if (typeof loadGameFromCloud !== 'function') {
        console.warn('loadGameFromCloud not available');
        return [];
    }

    const games = [];
    for (const gameId of gameIds) {
        try {
            const game = await loadGameFromCloud(gameId);
            if (game) games.push(game);
        } catch (e) {
            console.debug('Skipping unavailable game', gameId);
        }
    }
    return games;
}

/**
 * Build a name → id resolver scoped to one game.
 *
 * `point.players` has only ever stored player *names* (see the Point
 * constructor in store/models.js) — unlike events, it carries no id. To key
 * stats by id we still need to resolve those names, so we build a map from
 * the best historically-accurate source available:
 *   1. `game.rosterSnapshot` — the roster as it stood when the game was
 *      played; the correct source for a renamed/since-removed player.
 *   2. ids already embedded on this game's own events (thrower/receiver/
 *      puller/defender/assist carry both name and id once resolved — see
 *      store/storage.js resolvePlayerReference).
 *   3. the current team roster, as a last resort (logged — a player renamed
 *      since this game was played could resolve to the wrong id here).
 * A name that maps to more than one distinct id across these sources is
 * ambiguous and is NOT guessed at; it gets its own per-name bucket so stats
 * don't silently merge into the wrong player.
 * @param {object} game - Deserialized Game object
 * @returns {function(string): string} resolve(name) → a stable stats key
 */
function buildPlayerNameResolver(game) {
    const byName = {};
    function add(name, id) {
        if (!name || !id) return;
        if (byName[name] && byName[name] !== id) {
            byName[name] = 'AMBIGUOUS';
        } else if (!byName[name]) {
            byName[name] = id;
        }
    }

    (game?.rosterSnapshot?.players || []).forEach(p => add(p.name, p.id));

    (game?.points || []).forEach(point => {
        (point.possessions || []).forEach(poss => {
            (poss.events || []).forEach(event => {
                ['thrower', 'receiver', 'puller', 'defender', 'assist'].forEach(role => {
                    const ref = event[role];
                    if (ref && typeof ref === 'object') add(ref.name, ref.id);
                });
            });
        });
    });

    if (typeof currentTeam !== 'undefined' && currentTeam?.teamRoster) {
        currentTeam.teamRoster.forEach(p => add(p.name, p.id));
    }

    return function resolve(name) {
        const id = byName[name];
        if (!id) {
            console.warn('[eventStats] Could not resolve player name to id — stats will be keyed by name as a fallback:', name);
            return `unresolved:${name}`;
        }
        if (id === 'AMBIGUOUS') {
            console.warn('[eventStats] Ambiguous player name (matches multiple ids) — keeping separate to avoid merging stats:', name);
            return `ambiguous:${name}`;
        }
        return id;
    };
}

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
                dPlays: 0
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
            const s = ensurePlayer(id, playerName);
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
                    const thrower = resolveRef(event.thrower);
                    if (thrower.name) {
                        const s = ensurePlayer(thrower.id, thrower.name);
                        s.turnovers++;
                        s.totalThrows++;
                        if (event.huck_flag) s.totalHucks++;
                    }
                    if (event.drop_flag) {
                        const receiver = resolveRef(event.receiver);
                        if (receiver.name) ensurePlayer(receiver.id, receiver.name).turnovers++;
                    }
                } else if (event.type === 'Defense') {
                    const defender = resolveRef(event.defender);
                    if (defender.name) ensurePlayer(defender.id, defender.name).dPlays++;
                }
            });
        });
    });
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
 * Aggregate team-level point classifications across an event.
 * @param {object} event - TournamentEvent
 * @param {object} [options] - { phase: string | null } to filter by phase
 * @returns {Promise<object>} Same shape as getGameTeamStats
 */
async function getEventTeamStats(event, options = {}) {
    const totals = {
        breaks: 0, opponentBreaks: 0,
        cleanHolds: 0, dirtyHolds: 0,
        holdOpps: 0, breakOpps: 0, breakPossOpps: 0,
        total: 0
    };
    if (!event) return totals;
    const games = await loadEventGames(event);
    const phaseFilter = options.phase;
    games.forEach(game => {
        if (phaseFilter !== undefined && phaseFilter !== null && game.phase !== phaseFilter) return;
        const g = getGameTeamStats(game);
        totals.breaks += g.breaks;
        totals.opponentBreaks += g.opponentBreaks;
        totals.cleanHolds += g.cleanHolds;
        totals.dirtyHolds += g.dirtyHolds;
        totals.holdOpps += g.holdOpps;
        totals.breakOpps += g.breakOpps;
        totals.breakPossOpps += g.breakPossOpps;
        totals.total += g.total;
    });
    return totals;
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

/**
 * Get lifetime (all-time) aggregate player stats for a team, across every game
 * the team has played. Mirrors getEventPlayerStats but spans the whole team
 * rather than one event.
 *
 * Stats are derived from game events — the legacy per-player counters
 * (totalPointsPlayed, totalTimePlayed, …) are NOT maintained in the current
 * model, so we must aggregate the actual games. In-memory games (the live
 * session, including the current game) are used directly; the rest are loaded
 * from cloud by id and deduped.
 *
 * @param {object} team - Team object (needs id; games[] used when present)
 * @returns {Promise<Object>} Map of playerId → stats
 */
async function getTeamPlayerStats(team) {
    if (!team) return {};
    const stats = {};
    const seen = new Set();

    // 1. In-memory games (current session — full data, incl. the live game).
    (team.games || []).forEach(g => {
        if (g && Array.isArray(g.points) && g.points.length > 0) {
            accumulateGameStats(g, stats);
            if (g.id) seen.add(g.id);
        }
    });

    // 2. Every other game the cloud lists for this team.
    let summaries = [];
    if (typeof listServerGames === 'function') {
        try { summaries = await listServerGames(); } catch (e) { summaries = []; }
    }
    const ids = summaries
        .filter(g => g && g.teamId === team.id && g.game_id && !seen.has(g.game_id))
        .map(g => g.game_id);

    for (const gid of ids) {
        if (seen.has(gid)) continue;
        try {
            const game = (typeof loadGameFromCloud === 'function') ? await loadGameFromCloud(gid) : null;
            if (game) { accumulateGameStats(game, stats); seen.add(gid); }
        } catch (e) {
            console.debug('Skipping unavailable game', gid);
        }
    }
    return stats;
}

/**
 * Get aggregate player stats for an event across all its games.
 * @param {object} event - TournamentEvent object (must have gameIds)
 * @param {object} [options] - { phase: string } to restrict to one phase label
 * @returns {Promise<Object>} Map of playerId → stats
 */
async function getEventPlayerStats(event, options = {}) {
    if (!event) return {};

    const games = await loadEventGames(event);
    const stats = {};
    const phaseFilter = options.phase;
    games.forEach(game => {
        if (phaseFilter !== undefined && phaseFilter !== null && game.phase !== phaseFilter) return;
        accumulateGameStats(game, stats);
    });
    return stats;
}

/**
 * Get event W/L record
 * @param {object} event - TournamentEvent object (must have gameIds)
 * @param {object} [options] - { phase: string } to restrict to one phase label
 * @returns {Promise<{ wins: number, losses: number, ties: number }>}
 */
async function getEventRecord(event, options = {}) {
    if (!event) return { wins: 0, losses: 0, ties: 0 };

    const games = await loadEventGames(event);
    let wins = 0, losses = 0, ties = 0;
    const phaseFilter = options.phase;
    games.forEach(game => {
        if (phaseFilter !== undefined && phaseFilter !== null && game.phase !== phaseFilter) return;
        const teamScore = game.scores?.[Role.TEAM] || game.scores?.team || 0;
        const oppScore = game.scores?.[Role.OPPONENT] || game.scores?.opponent || 0;
        if (teamScore > oppScore) wins++;
        else if (oppScore > teamScore) losses++;
        else if (game.gameEndTimestamp) ties++;
    });
    return { wins, losses, ties };
}

// --- ES-module exports; window.* shims below are transitional for
// --- not-yet-converted classic scripts (removed at end of migration).
export {
    loadEventGames,
    accumulateGameStats,
    classifyPoint,
    getGameTeamStats,
    getEventTeamStats,
    formatTeamStatsLine,
    getGamePlayerStats,
    getTeamPlayerStats,
    getEventPlayerStats,
    getEventRecord
};
window.getGamePlayerStats = getGamePlayerStats;
window.getEventPlayerStats = getEventPlayerStats;
window.getTeamPlayerStats = getTeamPlayerStats;
window.getEventRecord = getEventRecord;
window.loadEventGames = loadEventGames;
window.getGameTeamStats = getGameTeamStats;
window.getEventTeamStats = getEventTeamStats;
window.classifyPoint = classifyPoint;
window.formatTeamStatsLine = formatTeamStatsLine;
window.accumulateGameStats = accumulateGameStats;
