/*
 * Statistics Calculation Functions
 * Functions for calculating player and team statistics from game events
 */

/**
 * Calculate player statistics from game events
 * Returns a map of player name -> stats object
 * Stats include: completions, huckCompletions, totalThrows, totalHucks, turnovers, dPlays
 */
function calculatePlayerStatsFromEvents(game) {
    const stats = {};
    
    // Initialize stats for all players
    currentTeam.teamRoster.forEach(player => {
        stats[player.name] = {
            completions: 0,
            huckCompletions: 0,
            totalThrows: 0,
            totalHucks: 0,
            turnovers: 0,
            dPlays: 0
        };
    });
    
    // If no game provided, return empty stats
    if (!game || !game.points) {
        return stats;
    }
    
    // Walk through all points and possessions
    game.points.forEach(point => {
        point.possessions.forEach(possession => {
            possession.events.forEach(event => {
                if (event.type === 'Throw') {
                    // Count completed passes
                    if (event.thrower && event.thrower.name) {
                        const throwerName = event.thrower.name;
                        if (stats[throwerName]) {
                            stats[throwerName].totalThrows++;
                            stats[throwerName].completions++;
                            
                            // Count hucks separately
                            if (event.huck_flag) {
                                stats[throwerName].totalHucks++;
                                stats[throwerName].huckCompletions++;
                            }
                        }
                    }
                } else if (event.type === 'Turnover') {
                    // Count turnovers
                    if (event.thrower && event.thrower.name) {
                        const throwerName = event.thrower.name;
                        if (stats[throwerName]) {
                            stats[throwerName].turnovers++;
                            stats[throwerName].totalThrows++;
                            
                            // Count incomplete hucks
                            if (event.huck_flag) {
                                stats[throwerName].totalHucks++;
                            }
                        }
                    }
                    // Count drops as turnovers for the receiver
                    if (event.drop_flag && event.receiver && event.receiver.name) {
                        const receiverName = event.receiver.name;
                        if (stats[receiverName]) {
                            stats[receiverName].turnovers++;
                        }
                    }
                } else if (event.type === 'Defense') {
                    // Count defensive plays
                    if (event.defender && event.defender.name) {
                        const defenderName = event.defender.name;
                        if (stats[defenderName]) {
                            stats[defenderName].dPlays++;
                        }
                    }
                }
            });
        });
    });
    
    return stats;
}

