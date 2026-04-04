/*
 * Event-Level Statistics
 * Computes aggregate player stats across all games in a TournamentEvent.
 * Stats are computed on-demand (not stored) — consistent with existing "Total" pattern.
 */

/**
 * Get aggregate player stats for an event across all its games.
 * @param {string} eventId - The event ID
 * @param {Array} [teamGames] - Optional pre-loaded list of all team games (avoids re-scanning)
 * @returns {Object} Map of playerName → { pointsPlayed, timePlayed, goals, assists, turnovers, plusMinus, pointsWon, pointsLost, completions, huckCompletions, totalThrows, totalHucks, dPlays }
 */
function getEventPlayerStats(eventId, teamGames) {
    if (!eventId) return {};

    // Collect games for this event
    const games = (teamGames || getAllTeamGames()).filter(g => g.eventId === eventId);
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
            point.possessions.forEach(poss => {
                poss.events.forEach(event => {
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
 * Get all games from the current team (helper for when teamGames isn't passed)
 */
function getAllTeamGames() {
    if (!currentTeam) return [];
    return currentTeam.games || [];
}

/**
 * Get event W/L record
 * @param {string} eventId
 * @param {Array} [teamGames]
 * @returns {{ wins: number, losses: number, ties: number }}
 */
function getEventRecord(eventId, teamGames) {
    const games = (teamGames || getAllTeamGames()).filter(g => g.eventId === eventId);
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
