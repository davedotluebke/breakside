/*
 * Event-Level Statistics
 * Computes aggregate player stats across all games in a TournamentEvent.
 * Loads games from cloud via loadGameFromCloud since games aren't bulk-loaded
 * onto the team object until individually opened.
 */

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
 * Accumulate stats from a single game into an existing stats map.
 * Shared by getGamePlayerStats and getEventPlayerStats.
 * @param {object} game - Deserialized Game object
 * @param {object} stats - Mutable map of playerName → stats (will be populated)
 */
function accumulateGameStats(game, stats) {
    function ensurePlayer(name) {
        if (!stats[name]) {
            stats[name] = {
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
        return stats[name];
    }

    const points = game.points || [];
    points.forEach(point => {
        if (!point.winner) return; // skip in-progress points

        const pointPlayers = point.players || [];
        const pointDuration = point.totalPointTime || 0;
        const isWin = point.winner === 'team' || point.winner === Role.TEAM;

        pointPlayers.forEach(playerName => {
            const s = ensurePlayer(playerName);
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
                    const throwerName = event.thrower?.name || event.thrower;
                    if (throwerName) {
                        const s = ensurePlayer(throwerName);
                        s.totalThrows++;
                        s.completions++;
                        if (event.huck_flag) {
                            s.totalHucks++;
                            s.huckCompletions++;
                        }
                        if (event.score_flag) s.assists++;
                    }
                    if (event.score_flag) {
                        const receiverName = event.receiver?.name || event.receiver;
                        if (receiverName) ensurePlayer(receiverName).goals++;

                        // Hockey assist: previous Throw in this possession.
                        // Walk back, skipping non-Throw events (Violations etc).
                        for (let j = idx - 1; j >= 0; j--) {
                            const prev = events[j];
                            if (prev.type === 'Throw') {
                                const haName = prev.thrower?.name || prev.thrower;
                                if (haName) {
                                    const s = ensurePlayer(haName);
                                    s.hockeyAssists++;
                                    if (prev.huck_flag) s.huckHockeyAssists++;
                                }
                                break;
                            }
                        }
                    }
                } else if (event.type === 'Turnover') {
                    const throwerName = event.thrower?.name || event.thrower;
                    if (throwerName) {
                        const s = ensurePlayer(throwerName);
                        s.turnovers++;
                        s.totalThrows++;
                        if (event.huck_flag) s.totalHucks++;
                    }
                    if (event.drop_flag) {
                        const receiverName = event.receiver?.name || event.receiver;
                        if (receiverName) ensurePlayer(receiverName).turnovers++;
                    }
                } else if (event.type === 'Defense') {
                    const defenderName = event.defender?.name || event.defender;
                    if (defenderName) ensurePlayer(defenderName).dPlays++;
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
 *                     holdOpps, breakOpps, total }
 *   - holdOpps = number of points started on O (chances to hold)
 *   - breakOpps = number of points started on D (chances to break)
 *   - opponentBreaks = points we started on O but lost (= got broken)
 */
function getGameTeamStats(game) {
    const totals = {
        breaks: 0, opponentBreaks: 0,
        cleanHolds: 0, dirtyHolds: 0,
        holdOpps: 0, breakOpps: 0,
        total: 0
    };
    if (!game) return totals;
    (game.points || []).forEach(point => {
        const kind = classifyPoint(point);
        if (!kind) return;
        totals.total++;
        if (point.startingPosition === 'offense') totals.holdOpps++;
        else totals.breakOpps++;
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
        holdOpps: 0, breakOpps: 0,
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
        totals.total += g.total;
    });
    return totals;
}

/**
 * Format a team-stats object as a short human-readable summary line.
 * @param {object} t - team stats from getGameTeamStats / getEventTeamStats
 * @returns {string} e.g. "Breaks: 3/5 D-points • Holds: 4 clean + 2 dirty / 6 O-points"
 */
function formatTeamStatsLine(t) {
    if (!t || t.total === 0) return '';
    const breakStr = `Breaks: ${t.breaks}/${t.breakOpps} D-point${t.breakOpps === 1 ? '' : 's'}`;
    const holdsStr = `Holds: ${t.cleanHolds} clean + ${t.dirtyHolds} dirty / ${t.holdOpps} O-point${t.holdOpps === 1 ? '' : 's'}`;
    return `${breakStr}  •  ${holdsStr}`;
}

/**
 * Get player stats for a single game.
 * @param {object} game - Deserialized Game object
 * @returns {Object} Map of playerName → stats
 */
function getGamePlayerStats(game) {
    if (!game) return {};
    const stats = {};
    accumulateGameStats(game, stats);
    return stats;
}

/**
 * Get aggregate player stats for an event across all its games.
 * @param {object} event - TournamentEvent object (must have gameIds)
 * @param {object} [options] - { phase: string } to restrict to one phase label
 * @returns {Promise<Object>} Map of playerName → stats
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

window.getGamePlayerStats = getGamePlayerStats;
window.getEventPlayerStats = getEventPlayerStats;
window.getEventRecord = getEventRecord;
window.loadEventGames = loadEventGames;
window.getGameTeamStats = getGameTeamStats;
window.getEventTeamStats = getEventTeamStats;
window.classifyPoint = classifyPoint;
window.formatTeamStatsLine = formatTeamStatsLine;
