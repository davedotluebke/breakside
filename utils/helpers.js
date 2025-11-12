/*
 * Utility Functions
 * Pure utility functions and data accessors
 */

/**
 * Given a player name, return the corresponding Player object from the team roster
 */
function getPlayerFromName(playerName) {
    if (playerName === UNKNOWN_PLAYER) {
        return UNKNOWN_PLAYER_OBJ;  // Return the singleton instance
    }
    return currentTeam ? currentTeam.teamRoster.find(player => player.name === playerName) : null;
}

/**
 * Get the current game (most recent game in the current team's games array)
 */
function currentGame() {
    if (!currentTeam || currentTeam.games.length === 0) {
        console.log("Warning: No current game");
        return null;
    }
    return currentTeam.games[currentTeam.games.length - 1];
}

/**
 * Return the most recent point, or null if no points yet
 */
function getLatestPoint() {
    const game = currentGame();
    if (!game || game.points.length === 0) { return null; }
    return game.points[game.points.length - 1];
}

/**
 * Get the most recent possession (in most recent point); null if none
 */
function getLatestPossession() {
    const latestPoint = getLatestPoint();
    if (!latestPoint) { return null; }
    if (latestPoint.possessions.length === 0) { return null; }
    return latestPoint.possessions[latestPoint.possessions.length - 1];
}

/**
 * Get the most recent event (in most recent possession with any events); null if no possessions this point
 */
function getLatestEvent() {
    const latestPossession = getLatestPossession();
    if (!latestPossession) { return null; }
    if (latestPossession.events.length > 0) {
        return latestPossession.events[latestPossession.events.length - 1];
    }
    // no events in the current possession; return the last event of the previous possession
    const latestPoint = getLatestPoint();
    if (!latestPoint) { return null; }
    if (latestPoint.possessions.length < 2) { 
        // no previous possession; return null
        return null; 
    }
    const prevPossession = latestPoint.possessions[latestPoint.possessions.length - 2];
    return prevPossession.events[prevPossession.events.length - 1];        
}

/**
 * Find the possession containing the provided event, searching latest first
 */
function getPossessionOf(targetEvent) {
    if (!targetEvent) { return null; }

    const latestPossession = getLatestPossession();
    if (latestPossession && latestPossession.events.includes(targetEvent)) {
        return latestPossession;
    }

    const game = currentGame();
    if (!game) { return null; }

    for (let pointIndex = game.points.length - 1; pointIndex >= 0; pointIndex--) {
        const point = game.points[pointIndex];
        for (let possessionIndex = point.possessions.length - 1; possessionIndex >= 0; possessionIndex--) {
            const possession = point.possessions[possessionIndex];
            if (possession.events.includes(targetEvent)) {
                return possession;
            }
        }
    }

    return null;
}

/**
 * Find the point containing the provided event, searching latest first
 */
function getPointOf(targetEvent) {
    if (!targetEvent) { return null; }

    const latestPoint = getLatestPoint();
    if (latestPoint) {
        for (const possession of latestPoint.possessions) {
            if (possession.events.includes(targetEvent)) {
                return latestPoint;
            }
        }
    }

    const game = currentGame();
    if (!game) { return null; }

    for (let pointIndex = game.points.length - 1; pointIndex >= 0; pointIndex--) {
        const point = game.points[pointIndex];
        for (const possession of point.possessions) {
            if (possession.events.includes(targetEvent)) {
                return point;
            }
        }
    }

    return null;
}

/**
 * Check if a point is currently in progress
 */
function isPointInProgress() {
    const latestPoint = getLatestPoint();
    if (!latestPoint) { return false; }
    if (latestPoint.possessions.length === 0) { return false; }
    return latestPoint.winner === "";
}

/**
 * Get the current possession (the last one in the current point); null if none
 */
function getActivePossession(activePoint) {
    if (!activePoint) {
        console.log("getActivePossession() called, but no active point");
        return null;
    }
    if (activePoint.possessions.length === 0) {
        console.log("getActivePossession() called, but no possessions in active point");
        return null;
    }
    return activePoint.possessions[activePoint.possessions.length - 1];
}

/**
 * Helper function to calculate player's time in current game
 * Note: This function references isPaused which is defined in main.js
 */
function getPlayerGameTime(playerName) {
    let totalTime = 0;
    const game = currentGame();
    if (game) {
        game.points.forEach(point => {
            if (point.players.includes(playerName)) {
                if (point.endTimestamp) {
                    // For completed points, just use the totalPointTime
                    totalTime += point.totalPointTime;
                } else if (point === currentPoint) {
                    // For the current point, handle paused state
                    // Note: isPaused is a global variable defined in main.js
                    if (typeof isPaused !== 'undefined' && isPaused) {
                        // If paused, just use the accumulated time
                        totalTime += point.totalPointTime;
                    } else if (point.startTimestamp) {
                        // If running, calculate current running time and update totalPointTime
                        const currentRunningTime = new Date() - point.startTimestamp;
                        totalTime += currentRunningTime;
                    } else {
                        // Point not started yet
                        totalTime += 0;
                    }
                } else {
                    // This shouldn't happen, but if it does, just use totalPointTime
                    totalTime += point.totalPointTime;
                }
            }
        });
    }
    return totalTime;
}

/**
 * Format play time from milliseconds to MM:SS format
 */
function formatPlayTime(totalTimePlayed) {
    const timeDifferenceInMilliseconds = totalTimePlayed;
    const timeDifferenceInSeconds = Math.floor(timeDifferenceInMilliseconds / 1000);
    const minutes = Math.floor(timeDifferenceInSeconds / 60);
    const seconds = timeDifferenceInSeconds % 60;
    // Function to format a number as two digits with leading zeros
    const formatTwoDigits = (num) => (num < 10 ? `0${num}` : num);
    return `${formatTwoDigits(minutes)}:${formatTwoDigits(seconds)}`;
}

/**
 * Capitalize the first letter of a word
 */
function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Format player name with jersey number for display
 * Returns "Name (#)" if number exists, otherwise just "Name"
 */
function formatPlayerName(player) {
    if (!player) return '';
    if (player.number !== null && player.number !== undefined) {
        return `${player.name} (${player.number})`;
    }
    return player.name;
}

/**
 * Extract player name from displayed text that may include number
 * Strips "(#)" suffix if present
 */
function extractPlayerName(displayText) {
    if (!displayText) return '';
    // Match pattern: "Name (#)" and extract just "Name"
    const match = displayText.match(/^(.+?)\s*\(\d+\)$/);
    return match ? match[1].trim() : displayText.trim();
}

