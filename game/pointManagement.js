/*
 * Point Management
 * Handles point creation, transitions, and timing controls.
 */
import { Point } from '../store/models.js';
import { saveAllTeamsData } from '../store/storage.js';
import { currentGame, getLatestPoint, determineStartingPosition } from '../utils/helpers.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { matchButtonWidths } from '../ui/buttonLayout.js';
import { clearNextLineSelections } from '../ui/activePlayersDisplay.js';
import { canEditPlayByPlay, showControllerToast } from './controllerState.js';
// Cycle note: pullDialog's import chain (models/helpers/storage/
// eventLogDisplay/panelSystem) never reaches back into this file, and
// showPullDialog is only called at point-start time — safe back-edge import.
import { showPullDialog } from '../playByPlay/pullDialog.js';

let countdownInterval = null;
let countdownSeconds = 90;
let isCountdownRunning = false;
let isPaused = false;

function moveToNextPoint() {
    console.log('moveToNextPoint() called');

    logEvent("New point started");

    // Enter panel UI in between-points state
    // late-bound back-edge (gameScreenSync/gameScreenEvents live "above" this
    // layer); see ARCHITECTURE.md § ES modules — the window shim at the owner
    // is kept deliberately.
    if (typeof window.enterGameScreen === 'function') {
        window.enterGameScreen();
    }
    if (typeof window.transitionToBetweenPoints === 'function') {
        window.transitionToBetweenPoints();
    }

    // Start the countdown timer
    startCountdown();

    // Auto-switch to the Line tab for the Line Coach so they immediately
    // see the lineup-selection UI for the next point. This applies whether
    // the score came from Simple mode (We Score / They Score / Key Play),
    // Full mode (score throw / Callahan), or narration. We only switch if
    // the current user actually holds the Line Coach role — other coaches
    // and viewers stay on whatever tab they were already on. Also skip if
    // they're already on the All tab, which shows the Select Line panel
    // alongside PBP — switching would be a regression for that workflow.
    if (typeof window.isLineCoach === 'function' && window.isLineCoach()
        && typeof window.switchTab === 'function'
        && typeof window.getActiveTab === 'function'
        && window.getActiveTab() !== 'line'
        && window.getActiveTab() !== 'all') {
        // Snapshot the surface we're leaving so the next Start Point returns
        // here (e.g. back to Field for the in-field pull) rather than a stale
        // default.
        if (typeof window.rememberCurrentPbpTab === 'function') window.rememberCurrentPbpTab();
        window.switchTab('line');
    }

    // Sync to cloud when point ends (for live viewer updates)
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

function startNextPoint() {
    // Check if user has permission to start a point
    // Only Active Coach (or local user with implicit control) can start points
    if (typeof canEditPlayByPlay === 'function' && !canEditPlayByPlay()) {
        console.warn('User does not have Active Coach role - cannot start point');
        if (typeof showControllerToast === 'function') {
            showControllerToast('Only the Active Coach can start a new point', 'warning');
        } else {
            alert('Only the Active Coach can start a new point.');
        }
        return;
    }
    
    // Stop the countdown when point starts
    stopCountdown();

    // Use the effective line for the upcoming point — typically the line
    // type the user is currently viewing (auto-selected to match), but
    // the source-of-truth is `getEffectiveLineForNextPoint` so an Active
    // Coach who happens to be browsing a *different* line at tap time
    // still starts the right one. The view should already match in the
    // common case via autoSelectActiveTypeForNextPoint.
    const game = currentGame();
    let activePlayersForThisPoint = [];
    // late-bound back-edge (selectLine lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (game && typeof window.getEffectiveLineForNextPoint === 'function') {
        const effective = window.getEffectiveLineForNextPoint(game);
        activePlayersForThisPoint = [...(effective.line || [])];
        console.log(`📋 Effective line for next point: source=${effective.source}, players=`,
            activePlayersForThisPoint);
    } else {
        // Fallback: read from the visible panel checkboxes (legacy path).
        const panelCheckboxes = document.querySelectorAll('#panelActivePlayersTable input[type="checkbox"]');
        panelCheckboxes.forEach(checkbox => {
            if (checkbox.checked && checkbox.dataset.playerName) {
                activePlayersForThisPoint.push(checkbox.dataset.playerName);
            }
        });
        console.log('📋 Got players from panel table (fallback):', activePlayersForThisPoint);
    }

    // Promote the On Deck line into Next (side-agnostic). Done AFTER reading
    // the effective line above so THIS point still fields the current Next —
    // promotion seeds the line for the point *after* this one. Stamping odLine
    // with `now` (during this point) keeps it from being overwritten by the
    // ending-7 reseed in transitionToBetweenPoints (whose reference time is the
    // previous point's end), so the promoted line survives to become Next.
    // Empty On Deck = no-op. Clearing it lets the On Deck view re-render to its
    // empty default for fresh planning.
    if (game && game.pendingNextLine
        && Array.isArray(game.pendingNextLine.odOnDeckLine)
        && game.pendingNextLine.odOnDeckLine.length > 0) {
        const nowIso = new Date().toISOString();
        game.pendingNextLine.odLine = [...game.pendingNextLine.odOnDeckLine];
        game.pendingNextLine.odLineModifiedAt = nowIso;
        game.pendingNextLine.odOnDeckLine = [];
        game.pendingNextLine.odOnDeckLineModifiedAt = nowIso;
        console.log('📋 Promoted On Deck line into Next (odLine):', game.pendingNextLine.odLine);
    }

    // Clear the stored next line selections since we're now using them
    console.log('About to clear next line selections in startNextPoint after using them');
    clearNextLineSelections();

    // No need to clear lineupReadyAt/By on point start — the toast-only
    // ping fires on `serverReadyAt > prevReadyAt && now-newReadyAt < 60s`
    // in the AC's polling, so a ping from the previous between-points
    // window naturally falls out of the 60-second relevance window
    // without an explicit clear (which wouldn't propagate cross-device
    // anyway, since null < value in the merge).

    // determine starting position: check point winners and switchside events
    const startPointOn = determineStartingPosition();

    // Create a new Point with the active players and starting position
    const point = new Point(activePlayersForThisPoint, startPointOn);
    currentGame().points.push(point);

    // Start timing
    if (point.startTimestamp !== null) {
        console.warn("Warning: startTimestamp was already set when starting point");
    }
    point.startTimestamp = new Date();

    // Enter the panel-based game screen
    // late-bound back-edge (gameScreenSync lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.enterGameScreen === 'function') {
        window.enterGameScreen();
    }

    // If the user started this point from the Line tab (e.g. they're a
    // solo coach who just finished setting the lineup, or were auto-switched
    // to Line when the previous point scored), switch back to their preferred
    // play-by-play surface so they can immediately enter events. Do this
    // BEFORE capturing the pull below, so the pull decision sees the surface
    // we're actually returning to (e.g. Field). lastPbpTab is maintained by
    // panelSystem.js (and snapshotted in moveToNextPoint before the Line jump).
    if (typeof window.getActiveTab === 'function'
        && typeof window.switchTab === 'function'
        && window.getActiveTab() === 'line') {
        const target = (typeof window.getLastPbpTab === 'function')
            ? window.getLastPbpTab() : 'simple';
        window.switchTab(target);
    }

    // For defense points, capture the pull. The Field tab records the pull
    // in-field (pick puller, time the hang, tap the landing spot) so it can
    // store pull location + hangtime; every other tab uses the modal pull
    // dialog. When the Field tab is the active surface we suppress the modal
    // and let fieldPbp drive the in-field pull flow instead.
    const fieldTabActiveForPull = (typeof window.getActiveTab === 'function') && window.getActiveTab() === 'field';
    if (startPointOn === 'defense' && fieldTabActiveForPull
        && window.fieldPbp && typeof window.fieldPbp.beginPull === 'function') {
        window.fieldPbp.beginPull();
    } else if (startPointOn === 'defense' && typeof showPullDialog === 'function') {
        showPullDialog();
    }

    // Save and Sync on point start
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

const startPointBtn = document.getElementById('startPointBtn');
if (startPointBtn) {
    startPointBtn.addEventListener('click', startNextPoint);
}

// This file's local updateTimerDisplay(seconds) was DELETED here: it had been
// shadowed dead code since game/gameTimer.js was introduced (its zero-arg
// global overwrote this one at load time, so every runtime call already ran
// gameTimer's version — including this file's own calls below).

function startCountdown() {
    // Show the timer when starting countdown
    document.getElementById('countdownTimer').style.display = 'flex';

    // Clear any existing interval
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }

    let timeRemaining = countdownSeconds;
    isCountdownRunning = true;

    // late-bound back-edge (updateTimerDisplay's owner game/gameTimer.js lives
    // "above" this layer); see ARCHITECTURE.md § ES modules — the window shim
    // at the owner is kept deliberately.
    window.updateTimerDisplay(timeRemaining);

    countdownInterval = setInterval(() => {
        timeRemaining--;
        window.updateTimerDisplay(timeRemaining); // late-bound back-edge (see above)
    }, 1000);
}

function stopCountdown() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    isCountdownRunning = false;
    // Hide the timer when stopping countdown
    document.getElementById('countdownTimer').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
    // Hide countdown timer initially
    document.getElementById('countdownTimer').style.display = 'none';

    // Match button widths
    matchButtonWidths();
    setTimeout(matchButtonWidths, 100);
});

function updatePointTimer() {
    const point = getLatestPoint();
    if (!point) return;

    let elapsedTime = point.totalPointTime;
    if (point.startTimestamp && !isPaused) {
        elapsedTime += (new Date() - point.startTimestamp);
    }

    const minutes = Math.floor(elapsedTime / 60000);
    const seconds = Math.floor((elapsedTime % 60000) / 1000);
    const formattedTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Update the point timer display
    const pointTimerEl = document.getElementById('pointTimer');
    if (pointTimerEl) {
        pointTimerEl.textContent = formattedTime;
    }
}

setInterval(updatePointTimer, 1000);

// Setters for module-scoped mutable state — converted writers (game/gameLogic.js)
// import these instead of assigning the bare globals.
function setIsPaused(v) { isPaused = v; }
function setCountdownSeconds(v) { countdownSeconds = v; }

// --- ES-module exports ---
export {
    moveToNextPoint, startNextPoint, stopCountdown,
    isPaused, countdownSeconds, setIsPaused, setCountdownSeconds,
};
// window survivor: late-bound state accessor (read by utils/helpers.js
// getPlayerGameTime — helpers evaluates before this file and cannot import
// from it). Live accessor: a static copy would go stale on reassignment.
Object.defineProperty(window, 'isPaused', { configurable: true, get: () => isPaused, set: v => { isPaused = v; } });
