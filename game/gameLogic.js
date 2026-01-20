/*
 * Game Logic
 * Handles game initialization, scoring, and high-level game state transitions.
 * 
 * Phase 4 update: Games use teamId and create rosterSnapshot
 */
let currentPoint = null;
let currentEvent = null;
let currentPlayer = null;
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
    
    // Generate ID immediately for the new game
    if (typeof window.generateGameId === 'function') {
        newGame.id = window.generateGameId(newGame);
    }
    
    // Phase 4: Create roster snapshot from current team roster
    if (typeof createRosterSnapshot === 'function') {
        newGame.rosterSnapshot = createRosterSnapshot(currentTeam);
        console.log('📸 Created roster snapshot:', newGame.rosterSnapshot);
    }
    
    // Set mixed rules flags from dropdown and checkbox
    const enforceGenderRatioSelect = document.getElementById('enforceGenderRatioSelect');
    const alternateGenderPullsCheckbox = document.getElementById('alternateGenderPullsCheckbox');
    newGame.alternateGenderRatio = enforceGenderRatioSelect ? enforceGenderRatioSelect.value : 'No';
    newGame.alternateGenderPulls = alternateGenderPullsCheckbox ? alternateGenderPullsCheckbox.checked : false;
    
    // Phase 6b: Initialize pendingNextLine for panel UI
    newGame.pendingNextLine = {
        activeType: 'od',
        odLine: [],
        oLine: [],
        dLine: [],
        odLineModifiedAt: null,
        oLineModifiedAt: null,
        dLineModifiedAt: null
    };
    
    currentTeam.games.push(newGame);
    
    // Save and Sync Immediately
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }

    logEvent(`New game started against ${opponentName}`);

    // Set countdown seconds before moving to next point
    countdownSeconds = seconds;

    // Phase 6b: Use panel-based game screen if enabled
    if (window.useNewGameScreen && typeof enterGameScreen === 'function') {
        // Enter the panel UI directly for new games
        enterGameScreen();
        
        // Update displays for the new game
        if (typeof updateSelectLinePanel === 'function') {
            updateSelectLinePanel();
        }
        if (typeof updateGameLogPanel === 'function') {
            updateGameLogPanel();
        }
        
        return;
    }
    
    // Legacy behavior
    moveToNextPoint();
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

    if (!currentPoint) {
        throw new Error("No current point");
    }

    if (currentPoint.startTimestamp === null) {
        console.warn("Warning: currentPoint.startTimestamp is null; setting to now");
        currentPoint.startTimestamp = new Date();
    }

    // Add any remaining time to totalPointTime before ending
    currentPoint.totalPointTime += (new Date() - currentPoint.startTimestamp);
    currentPoint.endTimestamp = new Date();
    currentPoint.winner = winner; // Setting the winning team for the current point
    currentGame().scores[winner]++;

    // Update event log
    logEvent(`${currentPoint.winner} scores!`);

    // Update player stats for those who played this point
    // Phase 6b: Include substituted-out players (injury subs) in points-played count
    currentTeam.teamRoster.forEach(player => {
        const playedPoint = currentPoint.players.includes(player.name) ||
            (currentPoint.substitutedOutPlayers && currentPoint.substitutedOutPlayers.includes(player.name));
        
        if (playedPoint) { // the player played this point (or was subbed out during it)
            player.totalPointsPlayed++;
            player.consecutivePointsPlayed++;
            player.totalTimePlayed += currentPoint.totalPointTime;
            if (winner === Role.TEAM) {
                player.pointsWon++;
            } else {
                player.pointsLost++;
            }
        } else {                                    // the player did not play this point
            player.consecutivePointsPlayed = 0;
        }
    });

    currentPoint = null;  // Reset the temporary point object
    currentEvent = null;  // Reset the temporary event object
    currentPlayer = null; // Reset the temporary player object

    // Check if we're in next line selection mode and exit if we are
    if (document.body.classList.contains('next-line-mode')) {
        exitNextLineSelectionMode();
    }

    // Un-select all player buttons so O action buttons will be inactive next point
    document.querySelectorAll('.player-button').forEach(button => {
        button.classList.remove('selected');
    });

    // Phase 6b: Update game screen score display
    if (typeof updateGameScreenScore === 'function') {
        const game = currentGame();
        updateGameScreenScore(game.scores[Role.TEAM], game.scores[Role.OPPONENT]);
    }

    summarizeGame();
    updateActivePlayersList();  // Update the table with the new point data
    saveAllTeamsData(); // Save and Sync
}

document.getElementById('endGameBtn').addEventListener('click', function() {
    if (confirm('Are you sure you want to end the game?')) {
        stopCountdown();
        currentGame().gameEndTimestamp = new Date(); // Set end timestamp (fixed: was incorrectly using endTimestamp)

        // Phase 6b: Exit game screen if visible
        if (typeof exitGameScreen === 'function') {
            exitGameScreen();
        }

        // Populate the gameSummaryScreen with statistics, then show it
        document.getElementById('teamName').textContent = currentGame().team;
        document.getElementById('teamFinalScore').textContent = currentGame().scores[Role.TEAM];
        document.getElementById('opponentName').textContent = currentGame().opponent;
        document.getElementById('opponentFinalScore').textContent = currentGame().scores[Role.OPPONENT];
        updateGameSummaryRosterDisplay(); // Populate the roster stats table
        showScreen('gameSummaryScreen');
        saveAllTeamsData();
    }
});

document.getElementById('switchSidesBtn').addEventListener('click', function() {
    const inNextLineMode = document.body.classList.contains('next-line-mode');
    const startPointBtn = document.getElementById('startPointBtn');

    const game = currentGame();
    const lastPoint = getLatestPoint();

    if (!game || !lastPoint) {
        currentGame().startingPosition = currentGame().startingPosition === 'offense' ? 'defense' : 'offense';
        logEvent(`Switching starting position to ${currentGame().startingPosition}`);

        if (!inNextLineMode && startPointBtn) {
            const newStart = determineStartingPosition();
            startPointBtn.textContent = `Start Point (${capitalize(newStart)})`;
        }

        if (typeof checkPlayerCount === 'function') {
            checkPlayerCount();
        }
        return;
    }

    let possessionIndex = -1;
    let eventIndex = -1;

    for (let pIdx = lastPoint.possessions.length - 1; pIdx >= 0 && possessionIndex === -1; pIdx--) {
        const possession = lastPoint.possessions[pIdx];
        for (let eIdx = possession.events.length - 1; eIdx >= 0; eIdx--) {
            const event = possession.events[eIdx];
            if (event.type === 'Other' && event.switchsides_flag) {
                possessionIndex = pIdx;
                eventIndex = eIdx;
                break;
            }
        }
    }

    if (possessionIndex !== -1) {
        const possession = lastPoint.possessions[possessionIndex];
        possession.events.splice(eventIndex, 1);
        if (possession.events.length === 0) {
            lastPoint.possessions.splice(possessionIndex, 1);
        }
        logEvent("Removed most recent switch sides event");
    } else {
        let targetPossession = lastPoint.possessions.length > 0
            ? lastPoint.possessions[lastPoint.possessions.length - 1]
            : null;

        if (!targetPossession) {
            targetPossession = new Possession(false);
            lastPoint.addPossession(targetPossession);
        }

        const switchSidesEvent = new Other({ switchsides: true });
        targetPossession.addEvent(switchSidesEvent);
        logEvent(switchSidesEvent.summarize());
    }

    if (!inNextLineMode && startPointBtn) {
        const newStart = determineStartingPosition();
        startPointBtn.textContent = `Start Point (${capitalize(newStart)})`;
    }

    if (typeof checkPlayerCount === 'function') {
        checkPlayerCount();
    }
});

document.getElementById('timeOutBtn').addEventListener('click', function() {
    // create Other event with timeout flag set; append to most recent point
    currentEvent = new Other({timeout: true});
    const currentPossession = getActivePossession(currentPoint);
    currentPossession.addEvent(currentEvent);
    logEvent(currentEvent.summarize());
});

document.getElementById('halftimeBtn').addEventListener('click', function() {
    // create Other event with halftime flag set; append to most recent point
    currentEvent = new Other({halftime: true});
    const currentPossession = getActivePossession(currentPoint);
    currentPossession.addEvent(currentEvent);
    logEvent(currentEvent.summarize());
});

document.getElementById('oSubPlayersBtn').addEventListener('click', function() {
    updateActivePlayersList();
    showScreen('beforePointScreen');
    // enable the "continue game" button
    document.getElementById('continueGameBtn').classList.remove('inactive');
});

document.getElementById('dSubPlayersBtn').addEventListener('click', function() {
    updateActivePlayersList();
    showScreen('beforePointScreen');
    // enable the "continue game" button
    document.getElementById('continueGameBtn').classList.remove('inactive');
});

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
    currentPoint = null;
    currentEvent = null;
    currentPlayer = null;
    
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

/**
 * Undo the most recent event
 */
function undoEvent() {
    // XXX add logic to remove the most recent event from the current possession
    if (currentGame().points.length > 0) {
        // currentPoint is a global, reset it
        currentPoint = currentGame().points[currentGame().points.length - 1];
        if (currentPoint.possessions.length > 0) {
            let currentPossession = getActivePossession(currentPoint);
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
                // XXX we allocate but don't currently maintain turnover stats for players
                if (currentPossession.offensive) {
                    updateOffensivePossessionScreen();
                } else {
                    updateDefensivePossessionScreen();
                }
            } else {
                // no events in this possession, remove the possession
                currentPoint.possessions.pop();
                if (currentPoint.possessions.length === 0) {
                    // no possessions left in this point, update player stats then remove the point 
                    currentPoint.players.forEach(playerName => {
                        let player = getPlayerFromName(playerName);
                        player.totalPointsPlayed--;
                        player.consecutivePointsPlayed--;
                        // Decrement time played for this point
                        if (currentPoint.totalPointTime) {
                            player.totalTimePlayed -= currentPoint.totalPointTime;
                            // Ensure totalTimePlayed doesn't go negative
                            if (player.totalTimePlayed < 0) {
                                player.totalTimePlayed = 0;
                            }
                        }
                        // Decrement pointsWon or pointsLost based on winner
                        if (currentPoint.winner === Role.TEAM) {
                            player.pointsWon--;
                            if (player.pointsWon < 0) {
                                player.pointsWon = 0;
                            }
                        } else if (currentPoint.winner === Role.OPPONENT) {
                            player.pointsLost--;
                            if (player.pointsLost < 0) {
                                player.pointsLost = 0;
                            }
                        }
                    });
                    // Decrement game score if winner is set
                    if (currentPoint.winner) {
                        currentGame().scores[currentPoint.winner]--;
                    }
                    currentGame().points.pop();
                    currentPoint = null;
                    // display the "before point screen" 
                    moveToNextPoint();
                } else {
                    // update and display screen for the previous possession
                    currentPossession = getActivePossession(currentPoint);
                    currentPossession.endTimestamp = null;
                    currentEvent = currentPossession.events[currentPossession.events.length - 1];
                    if (currentPossession.offensive) {
                        updateOffensivePossessionScreen();
                        showScreen('offensePlayByPlayScreen');
                    } else {
                        updateDefensivePossessionScreen();
                        showScreen('defensePlayByPlayScreen');
                    }
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
