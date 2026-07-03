/*
 * Game screen — point/game timer display.
 * Point-timer pause/resume + header timer display and the per-second update loop.
 * Split from the former monolithic gameScreen.js (refactor, no behavior change).
 */
import { saveAllTeamsData } from '../store/storage.js';
import { currentGame, getLatestPoint } from '../utils/helpers.js';
import { isGameScreenVisible } from '../ui/panelSystem.js';
import { updateSelectLineTimeCells } from './selectLine.js';

// =============================================================================
// Settings Dialog
// =============================================================================

/**
 * Show the in-game settings dialog
 */
/**
 * Handle timer toggle click (tapping on timer value)
 */
let timerMode = 'point'; // 'point' or 'game'
let pointTimerPaused = false;

// `point.totalPointTime` is the accumulated *active* play time (ms) for the
// point, banked from each running segment as it ends; `point.startTimestamp`
// is the start of the currently-running segment (null while paused). This is
// the single source of truth shared with updateScore() (gameLogic.js — adds
// the final running segment into totalPointTime and reads it as play time) and
// updatePointTimer() (pointManagement.js). Pausing banks the running segment
// into totalPointTime and nulls startTimestamp; resuming starts a fresh
// segment. startTimestamp must stay a Date object (storage/sync serialize it
// via .toISOString()), so always assign `new Date()`, never an ISO string.

function handleTimerToggle() {
    timerMode = timerMode === 'point' ? 'game' : 'point';
    updateTimerDisplay();
    updateTimerPauseButton();
}

/**
 * Bank the currently-running segment into totalPointTime and stop the clock.
 * Safe to call when already paused (no running segment) — it's a no-op then.
 */
function pausePointTimer(point) {
    if (point && point.startTimestamp) {
        point.totalPointTime = (point.totalPointTime || 0) +
            (Date.now() - new Date(point.startTimestamp).getTime());
        point.startTimestamp = null;
    }
    if (point) point.lastPauseTime = new Date();
    pointTimerPaused = true;
}

/**
 * Resume timing by starting a fresh running segment.
 */
function resumePointTimer(point) {
    if (point) {
        point.startTimestamp = new Date();
        point.lastPauseTime = null;
    }
    pointTimerPaused = false;
}

/**
 * Handle timer pause/resume button click
 */
function handleTimerPauseClick(e) {
    e.stopPropagation(); // Don't trigger timer mode toggle

    if (timerMode !== 'point') {
        // Game clock cannot be paused
        return;
    }

    const point = getLatestPoint();
    if (!point || (!point.startTimestamp && !pointTimerPaused)) {
        // No active point (and not currently paused), nothing to do
        return;
    }

    if (pointTimerPaused) {
        resumePointTimer(point);
    } else {
        pausePointTimer(point);
    }

    updateTimerPauseButton();
    updateTimerDisplay();

    // Save the change
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

/**
 * Update pause button visibility and state
 */
function updateTimerPauseButton() {
    const pauseBtn = document.getElementById('gameTimerPauseBtn');
    if (!pauseBtn) return;
    
    // Only show pause button for point timer
    if (timerMode !== 'point') {
        pauseBtn.style.display = 'none';
        return;
    }
    
    pauseBtn.style.display = 'flex';
    const icon = pauseBtn.querySelector('i');
    if (icon) {
        icon.className = pointTimerPaused ? 'fas fa-play' : 'fas fa-pause';
    }
    pauseBtn.classList.toggle('paused', pointTimerPaused);
}

/**
 * Auto-resume point timer when a play-by-play event is recorded
 * Call this from event handlers
 */
function autoResumePointTimer() {
    if (pointTimerPaused) {
        resumePointTimer(getLatestPoint());
        updateTimerPauseButton();
    }
}

/**
 * Update the timer display
 * Shows either point timer or game clock (with cap countdown)
 */
function updateTimerDisplay() {
    const valueEl = document.getElementById('gameTimerValue');
    const labelEl = document.getElementById('gameTimerLabel');
    const containerEl = document.getElementById('gameTimerContainer');
    
    if (!valueEl || !labelEl) return;
    
    // Remove all timer state classes
    valueEl.classList.remove('timer-warning', 'timer-danger', 'timer-negative', 'timer-paused');
    
    // Get game for cap calculation
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    
    if (timerMode === 'point') {
        // Show point timer
        labelEl.textContent = 'point';
        
        const point = getLatestPoint();
        // Elapsed = accumulated active time (totalPointTime) plus the current
        // running segment. A completed point (endTimestamp set) or a paused
        // point has its full active time already banked into totalPointTime,
        // so it shows that frozen value rather than ticking against `now`.
        let elapsedMs = null;
        if (point) {
            if (point.endTimestamp) {
                elapsedMs = point.totalPointTime || 0;
            } else if (point.startTimestamp && !pointTimerPaused) {
                elapsedMs = (point.totalPointTime || 0) +
                    (Date.now() - new Date(point.startTimestamp).getTime());
            } else if (pointTimerPaused || point.totalPointTime || point.startTimestamp) {
                elapsedMs = point.totalPointTime || 0;
            }
        }

        if (elapsedMs !== null) {
            const elapsed = Math.floor(elapsedMs / 1000);
            if (pointTimerPaused) {
                valueEl.classList.add('timer-paused');
            }
            valueEl.textContent = formatTime(elapsed);

            // Add warning colors for long points
            if (elapsed > 180) { // 3+ minutes
                valueEl.classList.add('timer-danger');
            } else if (elapsed > 120) { // 2+ minutes
                valueEl.classList.add('timer-warning');
            }
        } else {
            valueEl.textContent = '0:00';
        }
    } else {
        // Show game clock (with cap countdown if applicable)
        labelEl.textContent = 'game';
        
        if (game && game.gameStartTimestamp) {
            const startTime = new Date(game.gameStartTimestamp).getTime();
            const now = Date.now();
            const elapsedMs = now - startTime;
            const elapsedSeconds = Math.floor(elapsedMs / 1000);
            
            // If game has ended, just show total game time
            if (game.gameEndTimestamp) {
                const endTime = new Date(game.gameEndTimestamp).getTime();
                const totalSeconds = Math.floor((endTime - startTime) / 1000);
                valueEl.textContent = formatTime(totalSeconds);
            } else {
                // Check if we should show countdown to cap
                // Only use cap countdown for active games (started within last 3 hours)
                const threeHoursMs = 3 * 60 * 60 * 1000;
                let capTime = null;
                
                if (elapsedMs < threeHoursMs) {
                    if (game.roundEndTime) {
                        capTime = new Date(game.roundEndTime).getTime();
                    } else if (game.gameDurationMinutes) {
                        capTime = startTime + (game.gameDurationMinutes * 60 * 1000);
                    }
                }
                
                if (capTime) {
                    const remainingMs = capTime - now;
                    const remainingSeconds = Math.floor(remainingMs / 1000);
                    
                    if (remainingSeconds <= -1800) {
                        // More than 30 min past cap - just show elapsed time
                        valueEl.textContent = formatTime(elapsedSeconds);
                    } else if (remainingSeconds <= 0) {
                        // Cap exceeded but within 30 min - show negative time in red
                        valueEl.textContent = formatTime(remainingSeconds);
                        valueEl.classList.add('timer-negative');
                    } else if (remainingSeconds <= 300) { // Under 5 minutes
                        // Show countdown
                        valueEl.textContent = formatTime(remainingSeconds);
                        if (remainingSeconds <= 60) {
                            valueEl.classList.add('timer-danger');
                        } else if (remainingSeconds <= 180) {
                            valueEl.classList.add('timer-warning');
                        }
                    } else {
                        // Show elapsed time
                        valueEl.textContent = formatTime(elapsedSeconds);
                    }
                } else {
                    // No cap or old game - just show elapsed time
                    valueEl.textContent = formatTime(elapsedSeconds);
                }
            }
        } else {
            valueEl.textContent = '0:00';
        }
    }
}

/**
 * Format seconds as M:SS or MM:SS
 * @param {number} seconds - Total seconds
 * @returns {string}
 */
function formatTime(seconds) {
    const mins = Math.floor(Math.abs(seconds) / 60);
    const secs = Math.abs(seconds) % 60;
    const sign = seconds < 0 ? '-' : '';
    return `${sign}${mins}:${secs.toString().padStart(2, '0')}`;
}

// =============================================================================
// Timer Update Loop
// =============================================================================

let timerUpdateInterval = null;

/**
 * Start the timer update loop
 */
function startGameScreenTimerLoop() {
    if (timerUpdateInterval) return;
    
    timerUpdateInterval = setInterval(() => {
        if (isGameScreenVisible()) {
            updateTimerDisplay();
            // Also update player time cells in Select Line panel
            updateSelectLineTimeCells();
        }
    }, 1000);
}

/**
 * Stop the timer update loop
 */
function stopGameScreenTimerLoop() {
    if (timerUpdateInterval) {
        clearInterval(timerUpdateInterval);
        timerUpdateInterval = null;
    }
}

// Setter for module-scoped mutable state — the converted writer
// (game/gameScreenSync.js) imports this instead of assigning the bare global.
function setPointTimerPaused(v) { pointTimerPaused = v; }

// --- ES-module exports ---
export {
    updateTimerDisplay, updateTimerPauseButton,
    handleTimerToggle, handleTimerPauseClick,
    autoResumePointTimer,
    startGameScreenTimerLoop, stopGameScreenTimerLoop,
    setPointTimerPaused,
};
// window survivor: late-bound back-edge hook (called window-qualified by
// game/pointManagement.js, which evaluates before this file)
window.updateTimerDisplay = updateTimerDisplay;
// Dropped shim (zero external references found): autoResumePointTimer — its
// only consumer, game/gameScreenEvents.js, imports it now.
