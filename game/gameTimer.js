/*
 * Game screen — point/game timer display.
 * Point-timer pause/resume + header timer display and the per-second update loop.
 * Split from the former monolithic gameScreen.js (refactor, no behavior change).
 */
import { saveAllTeamsData } from '../store/storage.js';
import {
    startPointClock, stopPointClock, restartPointClock,
} from '../store/pointClock.js';
import { currentGame, getLatestPoint } from '../utils/helpers.js';
import { isGameScreenVisible } from '../ui/panelSystem.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { updateSelectLineTimeCells } from './selectLine.js';
import { refreshClockStoppedToast } from './clockStoppedToast.js';
import { log } from '../utils/logger.js';

let timerMode = 'point'; // 'point' or 'game'
// The clock state the chip last rendered (clockState below). The clock is
// started, stopped and restarted by whichever surface records the play, so
// the display loop watches for transitions itself and refreshes the pause
// button on change.
let shownState = null;

// Timer warning bands (seconds). Point timer counts up: orange past
// POINT_WARNING_SECS, red past POINT_DANGER_SECS. Cap countdown counts
// down: shown only under CAP_COUNTDOWN_SECS remaining, orange under
// CAP_WARNING_SECS, red under CAP_DANGER_SECS; past the cap the negative
// time shows for CAP_OVERRUN_GRACE_SECS before reverting to elapsed time.
const POINT_WARNING_SECS = 120;        // 2+ minute point
const POINT_DANGER_SECS = 180;         // 3+ minute point
const CAP_COUNTDOWN_SECS = 300;        // show countdown under 5 min to cap
const CAP_WARNING_SECS = 180;          // under 3 min to cap
const CAP_DANGER_SECS = 60;            // under 1 min to cap
const CAP_OVERRUN_GRACE_SECS = 1800;   // show negative time up to 30 min past cap
// Only use cap countdown for active games (started within the last 3 hours)
const ACTIVE_GAME_WINDOW_MS = 3 * 60 * 60 * 1000;

// `point.totalPointTime` is the accumulated *active* play time (ms) for the
// point, banked from each running segment as it ends; `point.startTimestamp`
// is the start of the currently-running segment (null while stopped). This is
// the single source of truth shared with updateScore() (gameLogic.js — adds
// the final running segment into totalPointTime and reads it as play time).
// startTimestamp must stay a Date object (storage/sync serialize it via
// .toISOString()), so always assign `new Date()`, never an ISO string.
// The clock's states are all point fields owned by store/pointClock.js:
// armed (`clockPending`: the point started but nobody has touched the pull
// yet; the first recorded touch starts the segment) and stopped
// (`clockStopped`: a timeout, an injury sub or the pause button banked the
// segment; the next recorded play, the toast or the button restarts it).
// Persisted with the point, so a reload or the other coach's device shows
// the same clock. Here they only shape the chip and the pause button.

/**
 * The live point's clock state, for the chip and the pause button.
 * @returns {'none'|'pending'|'stopped'|'running'|'idle'} — 'idle' is a live
 *   point whose clock is neither running, armed nor stopped (a cancelled
 *   score attribution leaves one); the button starts it.
 */
function clockState(point) {
    if (!point || point.winner || point.endTimestamp) return 'none';
    if (point.clockPending) return 'pending';
    if (point.clockStopped) return 'stopped';
    return point.startTimestamp ? 'running' : 'idle';
}

function handleTimerToggle() {
    timerMode = timerMode === 'point' ? 'game' : 'point';
    updateTimerDisplay();
    updateTimerPauseButton();
}

/**
 * Handle timer pause/resume button click: the manual control for every
 * clock state. Armed → start now (the override for a point started on
 * Full/Field and then recorded in Simple mode); running → stop (a stoppage
 * with no event of its own: an injury with no sub, theirs or ours, weather,
 * a long call); stopped → restart; idle → start.
 */
function handleTimerPauseClick(e) {
    e.stopPropagation(); // Don't trigger timer mode toggle

    if (timerMode !== 'point') {
        // Game clock cannot be paused
        return;
    }

    const point = getLatestPoint();
    switch (clockState(point)) {
        case 'pending':
            startPointClock(point);
            logEvent('Point clock started');
            break;
        case 'running':
            if (!stopPointClock(point, 'manual')) return;
            logEvent('Point clock stopped');
            log('⏱ Point clock stopped — pause button');
            break;
        case 'stopped':
            if (!restartPointClock(point)) return;
            logEvent('Point clock restarted');
            log('⏱ Point clock restarted — pause button');
            break;
        case 'idle':
            point.startTimestamp = new Date();
            logEvent('Point clock started');
            break;
        default:
            return;   // no live point: nothing to do
    }

    updateTimerPauseButton();
    updateTimerDisplay();   // also reconciles the stopped-clock toast

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
    // A play icon whenever a live clock isn't running: stopped, armed and
    // waiting for the first touch, or idle (tapping it then starts the clock).
    const state = clockState(getLatestPoint());
    const icon = pauseBtn.querySelector('i');
    if (icon) {
        const play = state === 'stopped' || state === 'pending' || state === 'idle';
        icon.className = play ? 'fas fa-play' : 'fas fa-pause';
    }
    pauseBtn.classList.toggle('paused', state === 'stopped');
    pauseBtn.classList.toggle('pending', state === 'pending');
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
    valueEl.classList.remove('timer-warning', 'timer-danger', 'timer-negative', 'timer-paused', 'timer-pending');
    
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
        const state = clockState(point);
        // The clock is started, stopped and restarted by whichever surface
        // records the play; refresh the pause button when the state changes
        // under us.
        if (state !== shownState) {
            shownState = state;
            updateTimerPauseButton();
        }
        // Elapsed = accumulated active time (totalPointTime) plus the current
        // running segment. A completed point (endTimestamp set) or a stopped
        // point has its full active time already banked into totalPointTime,
        // so it shows that frozen value rather than ticking against `now`.
        // An armed clock (nobody has touched the pull yet) shows 0:00 in the
        // waiting style.
        let elapsedMs = null;
        if (point) {
            if (state === 'pending') {
                elapsedMs = null;   // waits for the first touch
            } else if (point.endTimestamp) {
                elapsedMs = point.totalPointTime || 0;
            } else if (point.startTimestamp) {
                elapsedMs = (point.totalPointTime || 0) +
                    (Date.now() - new Date(point.startTimestamp).getTime());
            } else if (state === 'stopped' || point.totalPointTime) {
                elapsedMs = point.totalPointTime || 0;
            }
        }

        if (elapsedMs !== null) {
            const elapsed = Math.floor(elapsedMs / 1000);
            if (state === 'stopped') {
                valueEl.classList.add('timer-paused');
            }
            valueEl.textContent = formatTime(elapsed);

            // Add warning colors for long points
            if (elapsed > POINT_DANGER_SECS) {
                valueEl.classList.add('timer-danger');
            } else if (elapsed > POINT_WARNING_SECS) {
                valueEl.classList.add('timer-warning');
            }
        } else {
            valueEl.textContent = '0:00';
            if (state === 'pending') valueEl.classList.add('timer-pending');
        }

        // The stopped-clock toast follows the same state (game/clockStoppedToast.js).
        refreshClockStoppedToast();
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
                let capTime = null;

                if (elapsedMs < ACTIVE_GAME_WINDOW_MS) {
                    if (game.roundEndTime) {
                        capTime = new Date(game.roundEndTime).getTime();
                    } else if (game.gameDurationMinutes) {
                        capTime = startTime + (game.gameDurationMinutes * 60 * 1000);
                    }
                }
                
                if (capTime) {
                    const remainingMs = capTime - now;
                    const remainingSeconds = Math.floor(remainingMs / 1000);
                    
                    if (remainingSeconds <= -CAP_OVERRUN_GRACE_SECS) {
                        // Long past the cap - just show elapsed time
                        valueEl.textContent = formatTime(elapsedSeconds);
                    } else if (remainingSeconds <= 0) {
                        // Cap exceeded but within grace - show negative time in red
                        valueEl.textContent = formatTime(remainingSeconds);
                        valueEl.classList.add('timer-negative');
                    } else if (remainingSeconds <= CAP_COUNTDOWN_SECS) {
                        // Show countdown
                        valueEl.textContent = formatTime(remainingSeconds);
                        if (remainingSeconds <= CAP_DANGER_SECS) {
                            valueEl.classList.add('timer-danger');
                        } else if (remainingSeconds <= CAP_WARNING_SECS) {
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
        window.powerLog?.countWakeup?.('gameTimer');
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

// Power plan: a display-only 1s loop — there is nothing to redraw for a screen
// nobody is looking at. Resume repaints immediately so the timer never shows a
// stale value for up to a second after the coach comes back.
document.addEventListener('breakside:power-plan', (e) => {
    if (e.detail?.plan?.gameTimer) {
        updateTimerDisplay();
        startGameScreenTimerLoop();
    } else {
        stopGameScreenTimerLoop();
    }
});

// --- ES-module exports ---
export {
    updateTimerDisplay, updateTimerPauseButton,
    handleTimerToggle, handleTimerPauseClick,
    startGameScreenTimerLoop, stopGameScreenTimerLoop,
};
// window survivor: late-bound back-edge hook (called window-qualified by
// game/pointManagement.js, which evaluates before this file, and by the
// play recorders below this layer — playByPlay/pbpPossession.js and
// narration/narrationEngine.js — after a touch starts or restarts the clock)
window.updateTimerDisplay = updateTimerDisplay;
