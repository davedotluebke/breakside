/*
 * Game Logic
 * Handles game initialization, scoring, and high-level game state transitions.
 * 
 * Phase 4 update: Games use teamId and create rosterSnapshot
 */
let appVersion = null;

function startNewGame(startingPosition, seconds) {
    const opponentNameInput = document.getElementById('opponentNameInput');
    const opponentName = opponentNameInput.value.trim() || "Bad Guys";

    // Store current totalPointsPlayed into pointsPlayedPreviousGames for each player
    currentTeam.teamRoster.forEach(player => {
        player.pointsPlayedPreviousGames = player.totalPointsPlayed;
    });
    
    // Phase 4: Pass teamId to Game constructor
    const newGame = new Game(currentTeam.name, opponentName, startingPosition, currentTeam.id);

    // Set eventId if starting a game within an event
    if (currentEvent) {
        newGame.eventId = currentEvent.id;
    }

    // Generate ID immediately for the new game
    if (typeof window.generateGameId === 'function') {
        newGame.id = window.generateGameId(newGame);
    }

    // Create roster snapshot — from event roster if in event, else team roster
    if (typeof createRosterSnapshot === 'function') {
        newGame.rosterSnapshot = createRosterSnapshot(currentTeam, currentEvent || undefined);
        console.log('📸 Created roster snapshot:', newGame.rosterSnapshot);
    }
    
    // Set mixed rules flags from dropdown and checkbox
    const enforceGenderRatioSelect = document.getElementById('enforceGenderRatioSelect');
    const alternateGenderPullsCheckbox = document.getElementById('alternateGenderPullsCheckbox');
    newGame.alternateGenderRatio = enforceGenderRatioSelect ? enforceGenderRatioSelect.value : 'No';
    newGame.alternateGenderPulls = alternateGenderPullsCheckbox ? alternateGenderPullsCheckbox.checked : false;
    
    currentTeam.games.push(newGame);
    
    // Initialize pendingNextLine for panel UI
    newGame.pendingNextLine = {
        activeType: 'od',
        odLine: [],
        oLine: [],
        dLine: [],
        odLineModifiedAt: null,
        oLineModifiedAt: null,
        dLineModifiedAt: null
    };
    
    // Save and Sync Immediately
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }

    logEvent(`New game started against ${opponentName}`);

    // Set countdown seconds before moving to next point
    countdownSeconds = seconds;

    // Enter the panel-based game screen
    if (typeof enterGameScreen === 'function') {
        enterGameScreen();
    }
    if (typeof transitionToBetweenPoints === 'function') {
        transitionToBetweenPoints();
    }
    console.log('🎮 New game started with panel UI');
}

document.getElementById('startGameOnOBtn').addEventListener('click', function() {
    const timerInput = document.getElementById('pointTimerInput');
    const seconds = parseInt(timerInput.value) || 90;
    startNewGame('offense', seconds);
});

document.getElementById('startGameOnDBtn').addEventListener('click', function() {
    const timerInput = document.getElementById('pointTimerInput');
    const seconds = parseInt(timerInput.value) || 90;
    startNewGame('defense', seconds);
});

function updateScore(winner) {
    if (winner !== Role.TEAM && winner !== Role.OPPONENT) {
        throw new Error("inactive role");
    }

    const point = getLatestPoint();
    if (!point) {
        throw new Error("No current point");
    }

    if (point.startTimestamp === null) {
        console.warn("Warning: point.startTimestamp is null; setting to now");
        point.startTimestamp = new Date();
    }

    // Add any remaining time to totalPointTime before ending
    point.totalPointTime += (new Date() - point.startTimestamp);
    point.endTimestamp = new Date();
    point.winner = winner; // Setting the winning team for the current point
    currentGame().scores[winner]++;

    // Update event log
    logEvent(`${point.winner} scores!`);

    // Update player stats for those who played this point
    // Include players who were substituted out mid-point (they still "played" the point)
    currentTeam.teamRoster.forEach(player => {
        const playedPoint = point.players.includes(player.name) ||
            (point.substitutedOutPlayers && point.substitutedOutPlayers.includes(player.name));
        if (playedPoint) { // the player played this point
            player.totalPointsPlayed++;
            player.consecutivePointsPlayed++;
            player.totalTimePlayed += point.totalPointTime;
            if (winner === Role.TEAM) {
                player.pointsWon++;
            } else {
                player.pointsLost++;
            }
        } else {                                    // the player did not play this point
            player.consecutivePointsPlayed = 0;
        }
    });

    // Phase 6b: Update game screen score display
    if (typeof updateGameScreenScore === 'function') {
        const game = currentGame();
        updateGameScreenScore(game.scores[Role.TEAM], game.scores[Role.OPPONENT]);
    }

    summarizeGame();
    saveAllTeamsData(); // Save and Sync
}

// Legacy end game, switch sides, timeout, halftime buttons removed —
// panel UI (gameScreen.js) handles all game events.


document.getElementById('downloadGameBtn').addEventListener('click', function() {
    const teamData = serializeTeam(currentTeam); // Assuming serializeTeam returns a JSON string
    downloadJSON(teamData, 'teamData.json');
});

document.getElementById('copySummaryBtn').addEventListener('click', function() {
    const summary = summarizeGame();
    navigator.clipboard.writeText(summary).then(() => {
        alert('Game summary copied to clipboard');
    });
});

document.getElementById('anotherGameBtn').addEventListener('click', function() {
    stopCountdown();
    isPaused = false;
    clearNextLineSelections();

    // Phase 6b: Exit game screen if visible
    if (typeof exitGameScreen === 'function') {
        exitGameScreen();
    }
    
    updateTeamRosterDisplay();
    document.getElementById('continueGameBtn').classList.add('inactive');
    showScreen('teamRosterScreen');
});

async function loadVersion() {
    try {
        const response = await fetch('./version.json');
        const versionData = await response.json();
        appVersion = versionData;
        return versionData;
    } catch (error) {
        console.warn('Could not load version information:', error);
        appVersion = { version: 'unknown', build: 'unknown' };
        return appVersion;
    }
}

loadVersion();

function downloadJSON(jsonData, filename) {
    // Create a Blob with the JSON data
    const blob = new Blob([jsonData], {type: 'application/json'});
    // Create a URL for the blob
    const url = URL.createObjectURL(blob);
    // Create a temporary anchor element and set its href to the blob URL
    const a = document.createElement('a');
    a.href = url;
    // Set the download attribute to suggest a filename for the download based on current teams and date
    a.download = filename || `${currentGame().team}_${currentGame().opponent}_${new Date().toISOString()}.json`;
    // Append the anchor to the body, click it, and then remove it
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke the blob URL to free up resources
    URL.revokeObjectURL(url);
}

function summarizeGame() {
    let versionInfo = '';
    if (appVersion) {
        versionInfo = `App Version: ${appVersion.version} (Build ${appVersion.build})\n`;
    }
    let summary = versionInfo + `Game Summary: ${currentGame().team} vs. ${currentGame().opponent}.\n`;
    summary += `${currentGame().team} roster:`;
    currentTeam.teamRoster.forEach(player => summary += ` ${player.name}`);
    let numPoints = 0;
    let runningScoreUs = 0;
    let runningScoreThem = 0;
    currentGame().points.forEach(point => {
        let switchsides = false;
        numPoints += 1;
        summary += `\nPoint ${numPoints} roster:`;
        point.players.forEach(player => summary += ` ${player}`);
        // indicate which team pulls and which receives (thus starting on offense)
        if (point.startingPosition === 'offense') {
            summary += `\n${currentGame().opponent} pulls to ${currentGame().team}.`;
        } else {
            summary += `\n${currentGame().team} pulls to ${currentGame().opponent}.`;
        }
        point.possessions.forEach(possession => {
            possession.events.forEach(event => {
                summary += `\n${event.summarize()}`;
                if (event.type === 'Other' && event.switchsides_flag) {
                    switchsides = true;
                }
            });
        });
        // if most recent event is a score, indicate which team scored
        if (point.winner === 'team') {
            summary += `\n${currentGame().team} scores! `;
            runningScoreUs++;
        }
        if (point.winner === 'opponent') {
            summary += `\n${currentGame().opponent} scores! `;
            runningScoreThem++;
        }
        if (point.winner) {
            summary += `\nCurrent score: ${currentGame().team} ${runningScoreUs}, ${currentGame().opponent} ${runningScoreThem}`;
        }
        if (switchsides) {
            summary += `\nO and D switching sides for next point. `;
            if (point.winner === 'team') {
                summary += `\n${currentGame().team} will receive pull and play O. `;
            } else {
                summary += `\n${currentGame().team} will pull to ${currentGame().opponent} and play D. `;
            }
        }
    });
    console.log(summary);
    return summary;
}

// logEvent is now in ui/eventLogDisplay.js

let undoPastStartTimestamp = null;

/**
 * Revert the score and player stats set by updateScore() for a point.
 * Used by undoEvent() when reverting a scored point.
 */
function revertPointScore(point) {
    currentGame().scores[point.winner]--;

    currentTeam.teamRoster.forEach(player => {
        const playedPoint = point.players.includes(player.name) ||
            (point.substitutedOutPlayers && point.substitutedOutPlayers.includes(player.name));
        if (playedPoint) {
            player.totalPointsPlayed--;
            player.consecutivePointsPlayed--;
            player.totalTimePlayed -= point.totalPointTime;
            if (player.totalTimePlayed < 0) player.totalTimePlayed = 0;
            if (point.winner === Role.TEAM) {
                player.pointsWon--;
                if (player.pointsWon < 0) player.pointsWon = 0;
            } else {
                player.pointsLost--;
                if (player.pointsLost < 0) player.pointsLost = 0;
            }
        }
    });

    point.winner = "";
    point.endTimestamp = null;
    point.startTimestamp = new Date();

    if (typeof updateGameScreenScore === 'function') {
        const game = currentGame();
        updateGameScreenScore(game.scores[Role.TEAM], game.scores[Role.OPPONENT]);
    }

    // Stop between-points countdown and restore in-point panel layout
    stopCountdown();
    if (typeof updatePanelsForGameState === 'function') {
        updatePanelsForGameState(true);
    }
}

/**
 * Undo the most recent event
 */
function undoEvent() {
    // Guard: no points in the game — warn, then offer to delete game on double-tap
    if (currentGame().points.length === 0) {
        const now = Date.now();
        if (undoPastStartTimestamp && (now - undoPastStartTimestamp) < 4000) {
            // Second press — offer restart
            undoPastStartTimestamp = null;
            if (confirm('This will delete the current game and return to the new game screen. Are you sure?')) {
                const gameId = currentGame().id;
                currentTeam.games.pop();
                // Delete from cloud
                if (typeof deleteGameFromCloud === 'function') {
                    deleteGameFromCloud(gameId);
                }
                stopCountdown();
                isPaused = false;
                clearNextLineSelections();
                if (typeof exitGameScreen === 'function') {
                    exitGameScreen();
                }
                updateTeamRosterDisplay();
                document.getElementById('continueGameBtn').classList.add('inactive');
                showScreen('teamRosterScreen');
                saveAllTeamsData();
            }
        } else {
            // First press — show toast, set timestamp
            undoPastStartTimestamp = now;
            if (typeof showControllerToast === 'function') {
                showControllerToast('No events to undo', 'warning');
            }
        }
        return;
    }
    undoPastStartTimestamp = null; // Reset if there are events to undo

    // XXX add logic to remove the most recent event from the current possession
    if (currentGame().points.length > 0) {
        const point = getLatestPoint();

        // If the point was scored but the last event isn't a scoring event,
        // revert only the score (handles "They Score" and "Skip" without event)
        if (point.winner) {
            let hasScoreEvent = false;
            if (point.possessions.length > 0) {
                const lastPoss = getActivePossession(point);
                if (lastPoss.events.length > 0) {
                    const lastEvent = lastPoss.events[lastPoss.events.length - 1];
                    hasScoreEvent =
                        (lastEvent instanceof Throw && lastEvent.score_flag) ||
                        (lastEvent instanceof Defense && lastEvent.Callahan_flag);
                }
            }
            if (!hasScoreEvent) {
                revertPointScore(point);
                // If the point has no possessions (e.g. "They Score" with no
                // prior events), remove the entire point and go between-points
                if (point.possessions.length === 0) {
                    currentGame().points.pop();
                    moveToNextPoint();
                }
                logEvent("Undo: score reverted");
                saveAllTeamsData();
                return;
            }
        }

        if (point.possessions.length > 0) {
            let currentPossession = getActivePossession(point);
            if (currentPossession.events.length > 0) {
                let undoneEvent = currentPossession.events.pop();
                logEvent(`Undid event: ${undoneEvent.summarize()}`);
                if (undoneEvent instanceof Throw) {
                    // update player stats for the thrower and receiver
                    if (undoneEvent.thrower) {
                        undoneEvent.thrower.completedPasses--;
                        // Ensure completedPasses doesn't go negative
                        if (undoneEvent.thrower.completedPasses < 0) {
                            undoneEvent.thrower.completedPasses = 0;
                        }
                    }
                    if (undoneEvent.score_flag) {
                        if (undoneEvent.receiver) {
                            undoneEvent.receiver.goals--;
                            // Ensure goals doesn't go negative
                            if (undoneEvent.receiver.goals < 0) {
                                undoneEvent.receiver.goals = 0;
                            }
                        }
                        if (undoneEvent.thrower) {
                            undoneEvent.thrower.assists--;
                            // Ensure assists doesn't go negative
                            if (undoneEvent.thrower.assists < 0) {
                                undoneEvent.thrower.assists = 0;
                            }
                        }
                    }
                } else if (undoneEvent instanceof Defense) {
                    // Handle Callahan: decrement defender's goals
                    if (undoneEvent.Callahan_flag && undoneEvent.defender) {
                        undoneEvent.defender.goals--;
                        // Ensure goals doesn't go negative
                        if (undoneEvent.defender.goals < 0) {
                            undoneEvent.defender.goals = 0;
                        }
                    }
                }
                // If the undone event was a score, revert updateScore() changes
                if (point.winner) {
                    const wasScoreEvent =
                        (undoneEvent instanceof Throw && undoneEvent.score_flag) ||
                        (undoneEvent instanceof Defense && undoneEvent.Callahan_flag);
                    if (wasScoreEvent) {
                        revertPointScore(point);
                    }
                }
                // Panel UI auto-updates based on game state — no legacy screen refresh needed

                // If the possession is now empty after undoing (e.g. pull was only event),
                // clean it up so the user isn't stranded mid-point with no way forward
                if (currentPossession.events.length === 0) {
                    point.possessions.pop();
                    if (point.possessions.length === 0) {
                        // No possessions left — remove the point and go to between-points.
                        // Don't decrement player point stats: updateScore() was either never
                        // called (unscored point) or already reverted by revertPointScore().
                        currentGame().points.pop();
                        moveToNextPoint();
                    } else {
                        // Go back to previous possession
                        currentPossession = getActivePossession(point);
                        currentPossession.endTimestamp = null;
                    }
                }
            } else {
                // no events in this possession, remove the possession
                point.possessions.pop();
                if (point.possessions.length === 0) {
                    // no possessions left in this point, update player stats then remove the point
                    point.players.forEach(playerName => {
                        let player = getPlayerFromName(playerName);
                        player.totalPointsPlayed--;
                        player.consecutivePointsPlayed--;
                        // Decrement time played for this point
                        if (point.totalPointTime) {
                            player.totalTimePlayed -= point.totalPointTime;
                            // Ensure totalTimePlayed doesn't go negative
                            if (player.totalTimePlayed < 0) {
                                player.totalTimePlayed = 0;
                            }
                        }
                        // Decrement pointsWon or pointsLost based on winner
                        if (point.winner === Role.TEAM) {
                            player.pointsWon--;
                            if (player.pointsWon < 0) {
                                player.pointsWon = 0;
                            }
                        } else if (point.winner === Role.OPPONENT) {
                            player.pointsLost--;
                            if (player.pointsLost < 0) {
                                player.pointsLost = 0;
                            }
                        }
                    });
                    // Decrement game score if winner is set
                    if (point.winner) {
                        currentGame().scores[point.winner]--;
                    }
                    currentGame().points.pop();
                    // display the "before point screen"
                    moveToNextPoint();
                } else {
                    // Restore state for previous possession
                    currentPossession = getActivePossession(point);
                    currentPossession.endTimestamp = null;
                    // Panel UI auto-updates — no legacy screen navigation needed
                }
            }
        }
    }
    // XXX update the event log
    logEvent("Undo button pressed!");
    saveAllTeamsData(); // Save and Sync
}

// Set up undo button event listener
document.addEventListener('DOMContentLoaded', function() {
    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) {
        undoBtn.addEventListener('click', undoEvent);
    }
});
