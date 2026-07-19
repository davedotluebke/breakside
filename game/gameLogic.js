/*
 * Game Logic
 * Handles game initialization, scoring, and high-level game state transitions.
 * 
 * Phase 4 update: Games use teamId and create rosterSnapshot
 */
import { Role, Game, createRosterSnapshot, isTestGame } from '../store/models.js';
import { currentTeam, currentEvent, saveAllTeamsData, serializeTeam } from '../store/storage.js';
import { syncGameToCloud, deleteGameFromCloud } from '../store/sync.js';
import { currentGame, getLatestPoint, getActivePossession, getPlayerFromName } from '../utils/helpers.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { updatePanelsForGameState } from '../ui/panelSystem.js';
import { clearNextLineSelections } from '../ui/activePlayersDisplay.js';
import { showScreen, returnToGameFromRoster } from '../screens/navigation.js';
import { updateTeamRosterDisplay } from '../teams/rosterManagement.js';
import { populateGenderRatioDropdown } from './genderRatioDropdown.js';
import {
    moveToNextPoint, stopCountdown, countdownSeconds,
    setIsPaused, setCountdownSeconds,
} from './pointManagement.js';
import { showControllerToast } from './controllerState.js';
import { applyUndoToGame } from './undoLogic.js';
import { log } from '../utils/logger.js';

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
        log('📸 Created roster snapshot:', newGame.rosterSnapshot);
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
        dLineModifiedAt: null,
        useSeparateLines: false,
        useSeparateLinesAt: null
    };
    
    // Save and Sync Immediately
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }

    logEvent(`New game started against ${opponentName}`);

    // Set countdown seconds before moving to next point
    setCountdownSeconds(seconds);

    // Enter the panel-based game screen
    // late-bound back-edge (gameScreenSync/gameScreenEvents live "above" this
    // layer); see ARCHITECTURE.md § ES modules — the window shim at the owner
    // is kept deliberately.
    if (typeof window.enterGameScreen === 'function') {
        window.enterGameScreen();
    }
    if (typeof window.transitionToBetweenPoints === 'function') {
        window.transitionToBetweenPoints();
    }
    log('🎮 New game started with panel UI');
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

/**
 * Configure the Start/Continue Game screen for either new-game or mid-game mode.
 * In mid-game mode the inputs are prefilled from the live game, the "Start Game
 * on Offense/Defense" buttons are replaced by an "Apply & Continue" button, and
 * the title reads "Game Settings".
 * @param {boolean} midGame
 */
function configureStartGameMode(midGame) {
    const titleEl = document.getElementById('startGameHeader');
    const startButtons = document.querySelector('#startGameSubscreen .start-game-buttons');
    const applyBtn = document.getElementById('applyGameSettingsBtn');
    const continueBtn = document.getElementById('continueGameBtn');
    const game = (typeof currentGame === 'function') ? currentGame() : null;

    if (midGame && game) {
        if (titleEl) titleEl.textContent = 'Game Settings';

        // Prefill controls from the live game / timer state
        const opp = document.getElementById('opponentNameInput');
        if (opp) opp.value = game.opponent || '';

        const ratioSel = document.getElementById('enforceGenderRatioSelect');
        if (ratioSel) {
            if (typeof populateGenderRatioDropdown === 'function') populateGenderRatioDropdown();
            if (game.alternateGenderRatio) ratioSel.value = game.alternateGenderRatio;
        }

        const pulls = document.getElementById('alternateGenderPullsCheckbox');
        if (pulls) pulls.checked = !!game.alternateGenderPulls;

        const timer = document.getElementById('pointTimerInput');
        if (timer && typeof countdownSeconds !== 'undefined' && countdownSeconds != null) {
            timer.value = countdownSeconds;
        }

        if (startButtons) startButtons.style.display = 'none';
        if (applyBtn) applyBtn.style.display = '';
        if (continueBtn) continueBtn.classList.remove('inactive');
    } else {
        if (titleEl) titleEl.textContent = 'Start Game';
        if (startButtons) startButtons.style.display = '';
        if (applyBtn) applyBtn.style.display = 'none';
    }
}

/**
 * Apply edited settings from the Game Settings screen to the current game so
 * they take effect on the next point. Players-on-field is read live from the
 * DOM during play, so it needs no copy here.
 */
function applyGameSettingsToCurrentGame() {
    const game = (typeof currentGame === 'function') ? currentGame() : null;
    if (!game) return;

    const opp = document.getElementById('opponentNameInput');
    if (opp && opp.value.trim()) game.opponent = opp.value.trim();

    const ratioSel = document.getElementById('enforceGenderRatioSelect');
    if (ratioSel) game.alternateGenderRatio = ratioSel.value;

    const pulls = document.getElementById('alternateGenderPullsCheckbox');
    if (pulls) game.alternateGenderPulls = pulls.checked;

    const timer = document.getElementById('pointTimerInput');
    if (timer) {
        const secs = parseInt(timer.value, 10);
        if (!isNaN(secs)) setCountdownSeconds(secs);
    }

    if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    if (typeof syncGameToCloud === 'function' && game.id) syncGameToCloud(game);
}

document.getElementById('applyGameSettingsBtn')?.addEventListener('click', function() {
    applyGameSettingsToCurrentGame();
    if (typeof returnToGameFromRoster === 'function') {
        returnToGameFromRoster();
    }
});

function updateScore(winner) {
    if (winner !== Role.TEAM && winner !== Role.OPPONENT) {
        throw new Error("inactive role");
    }

    const point = getLatestPoint();
    if (!point) {
        throw new Error("No current point");
    }

    // `startTimestamp` doubles as the running-timer segment marker: the score
    // handlers (stopPointTimeAccrual and the Full/Field inline copies) fold the
    // elapsed segment into totalPointTime and null it BEFORE this runs. A null
    // here therefore means "already accounted for" — don't fabricate a start
    // time (the old fallback stamped score time as the point's start, which is
    // why pendingLineLogic can't trust startTimestamp for point-start).
    if (point.startTimestamp !== null) {
        point.totalPointTime += (new Date() - point.startTimestamp);
        point.startTimestamp = null;
    }
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
    // late-bound back-edge (gameScreenSync lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.updateGameScreenScore === 'function') {
        const game = currentGame();
        window.updateGameScreenScore(game.scores[Role.TEAM], game.scores[Role.OPPONENT]);
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
    setIsPaused(false);
    clearNextLineSelections();

    // Phase 6b: Exit game screen if visible
    // late-bound back-edge (gameScreenSync lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.exitGameScreen === 'function') {
        window.exitGameScreen();
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
    // How the current period opened — flips at each period break (halftime /
    // switch sides), driving the "who pulls next" note below. Mirrors
    // determineStartingPosition().
    let periodOpening = currentGame().startingPosition;
    currentGame().points.forEach(point => {
        let switchsides = false;
        let forceswap = false;
        numPoints += 1;
        summary += `\nPoint ${numPoints} roster:`;
        point.players.forEach(player => summary += ` ${player}`);
        // indicate which team pulls and which receives (thus starting on offense)
        if (point.startingPosition === 'offense') {
            summary += `\n${currentGame().opponent} pulls to ${currentGame().team}.`;
        } else {
            summary += `\n${currentGame().team} pulls to ${currentGame().opponent}.`;
        }
        // O/D delimiter is emitted per logical possession boundary, not per
        // Possession object — a Turnover event lives inside the offensive
        // Possession that just ended (since ensurePossessionExists(true) is
        // called for it everywhere), so without an inline emission a
        // possession turned over by Turnover-only events (no following
        // Defense event yet) wouldn't show the boundary at all. Inline
        // emission after each Turnover, paired with suppression of the
        // very next possession's delimiter, gives a correct boundary
        // either way (Turnover-then-Defense or Turnover-only-so-far).
        let suppressNextPossessionDelimiter = false;
        // Events recorded AFTER the point ended (between-points timeouts,
        // switch sides) are deferred past the score lines below so the log
        // reads in real-world order.
        const afterPointLines = [];
        point.possessions.forEach(possession => {
            if (!suppressNextPossessionDelimiter) {
                const role = possession.offensive ? 'offense' : 'defense';
                summary += `\n— ${currentGame().team} on ${role} —`;
            }
            suppressNextPossessionDelimiter = false;
            possession.events.forEach(event => {
                // Halftime implies the side switch; two breaks on the same
                // point cancel (accidental tap + correction), so toggle.
                if (event.type === 'Other' && (event.switchsides_flag || event.halftime_flag)) {
                    switchsides = !switchsides;
                }
                if (event.type === 'Other' && event.forceswap_flag) {
                    forceswap = !forceswap;
                }
                if (event.type === 'Other' && event.betweenPoints) {
                    afterPointLines.push(event.summarize());
                    return;
                }
                summary += `\n${event.summarize()}`;
                if (event.type === 'Turnover') {
                    // Possession just ended — emit the boundary so the log
                    // shows it even when no Defense event has yet been
                    // recorded (e.g. inferred Turnover from the pill,
                    // or a Turnover before the user logs any D events).
                    summary += `\n— ${currentGame().team} on defense —`;
                    suppressNextPossessionDelimiter = true;
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
        afterPointLines.forEach(line => summary += `\n${line}`);
        // Manual Swap O & D corrections flip the period bookkeeping too
        // (matches determineStartingPosition), so the note below and any
        // later halftime read from the corrected orientation.
        if (forceswap) {
            periodOpening = (periodOpening === 'offense') ? 'defense' : 'offense';
        }
        if (switchsides) {
            // Period break: the next point opens with the period-opening
            // roles swapped — the team that pulled to open the previous
            // period receives — regardless of who won this point.
            periodOpening = (periodOpening === 'offense') ? 'defense' : 'offense';
            if (periodOpening === 'offense') {
                summary += `\n${currentGame().team} will receive the pull and play O. `;
            } else {
                summary += `\n${currentGame().team} will pull to ${currentGame().opponent} and play D. `;
            }
        }
    });
    log(summary);
    return summary;
}

// logEvent is now in ui/eventLogDisplay.js

let undoPastStartTimestamp = null;
// Separate double-tap window for backing out a freshly-started point (zero
// possessions). Can't share undoPastStartTimestamp: that one is reset at the
// top of every undoEvent() call that finds points to undo.
let undoEmptyPointTimestamp = null;

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

    // late-bound back-edge (gameScreenSync lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.updateGameScreenScore === 'function') {
        const game = currentGame();
        window.updateGameScreenScore(game.scores[Role.TEAM], game.scores[Role.OPPONENT]);
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
            // Skip the confirm for test games (throwaway dev data).
            const skipDeleteConfirm = typeof isTestGame === 'function' && isTestGame(currentGame());
            if (skipDeleteConfirm || confirm('This will delete the current game and return to the new game screen. Are you sure?')) {
                const gameId = currentGame().id;
                currentTeam.games.pop();
                // Delete from cloud
                if (typeof deleteGameFromCloud === 'function') {
                    deleteGameFromCloud(gameId);
                }
                stopCountdown();
                setIsPaused(false);
                clearNextLineSelections();
                // late-bound back-edge (gameScreenSync lives "above" this layer);
                // see ARCHITECTURE.md § ES modules — owner keeps the shim.
                if (typeof window.exitGameScreen === 'function') {
                    window.exitGameScreen();
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

    // The decision tree lives in undoLogic.js (pure, unit-tested); this
    // function handles the UI/persistence side effects it prescribes.
    const result = applyUndoToGame(currentGame(), {
        getActivePossession,
        resolvePlayer: getPlayerFromName,
        revertPointScore,
    });

    if (result.outcome === 'score-reverted') {
        if (result.pointRemoved) moveToNextPoint();
        logEvent("Undo: score reverted");
        saveAllTeamsData();
        return;
    }

    if (result.outcome === 'none') {
        // Point started (Start Point tapped) but nothing recorded yet —
        // possessions is empty, so the decision tree has nothing to pop.
        // Back out the point start itself, double-tap guarded (like the
        // delete-game path) so a stray Undo can't quietly kill the point.
        // point.winner is never set here: winner-without-score-event
        // resolves to 'score-reverted' above, and a winner WITH a score
        // event implies a possession exists.
        const now = Date.now();
        if (undoEmptyPointTimestamp && (now - undoEmptyPointTimestamp) < 4000) {
            undoEmptyPointTimestamp = null;
            currentGame().points.pop();
            logEvent('Undo: point start reverted');
            // Back to the between-points state (panels, countdown, line select)
            moveToNextPoint();
            if (typeof showControllerToast === 'function') {
                showControllerToast('Point start undone', 'info');
            }
            saveAllTeamsData();
        } else {
            undoEmptyPointTimestamp = now;
            if (typeof showControllerToast === 'function') {
                showControllerToast('Nothing recorded yet — tap Undo again to back out of this point', 'warning');
            }
        }
        return;
    }
    if (result.outcome === 'event-undone') {
        logEvent(`Undid event: ${result.undoneEvent.summarize()}`);
    }
    if (result.pointRemoved) {
        // display the "before point screen"
        moveToNextPoint();
    }
    // logEvent refreshes the on-screen log from summarizeGame(); the
    // possession-pop branch doesn't log anything itself, so this final
    // call is what keeps the display in sync on that path.
    logEvent("Undo applied");
    saveAllTeamsData(); // Save and Sync
}

// Set up undo button event listener
document.addEventListener('DOMContentLoaded', function() {
    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) {
        undoBtn.addEventListener('click', undoEvent);
    }
});

// --- ES-module exports ---
export {
    updateScore, summarizeGame, downloadJSON, undoEvent,
    configureStartGameMode, appVersion,
};
// window survivor: late-bound back-edge hook (called by ui/eventLogDisplay.js,
// which evaluates before this file — importing from here would add a
// gameLogic↔eventLogDisplay cycle)
window.summarizeGame = summarizeGame;
// window survivor: late-bound back-edge hook (called by screens/navigation.js,
// which evaluates before this file — importing from here would create a
// gameLogic↔navigation cycle)
window.configureStartGameMode = configureStartGameMode;
