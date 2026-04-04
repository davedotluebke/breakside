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
 * Get aggregate player stats for an event across all its games.
 * @param {object} event - TournamentEvent object (must have gameIds)
 * @returns {Promise<Object>} Map of playerName → stats
 */
async function getEventPlayerStats(event) {
    if (!event) return {};

    const games = await loadEventGames(event);
    const stats = {};

    function ensurePlayer(name) {
        if (!stats[name]) {
            stats[name] = {
                pointsPlayed: 0,
                timePlayed: 0,
                goals: 0,
                assists: 0,
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

    games.forEach(game => {
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
                (poss.events || []).forEach(event => {
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
    });

    return stats;
}

/**
 * Get event W/L record
 * @param {object} event - TournamentEvent object (must have gameIds)
 * @returns {Promise<{ wins: number, losses: number, ties: number }>}
 */
async function getEventRecord(event) {
    if (!event) return { wins: 0, losses: 0, ties: 0 };

    const games = await loadEventGames(event);
    let wins = 0, losses = 0, ties = 0;
    games.forEach(game => {
        const teamScore = game.scores?.[Role.TEAM] || game.scores?.team || 0;
        const oppScore = game.scores?.[Role.OPPONENT] || game.scores?.opponent || 0;
        if (teamScore > oppScore) wins++;
        else if (oppScore > teamScore) losses++;
        else if (game.gameEndTimestamp) ties++;
    });
    return { wins, losses, ties };
}

window.getEventPlayerStats = getEventPlayerStats;
window.getEventRecord = getEventRecord;
window.loadEventGames = loadEventGames;
