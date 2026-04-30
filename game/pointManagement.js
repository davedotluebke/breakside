/*
 * Point Management
 * Handles point creation, transitions, and timing controls.
 */
let countdownInterval = null;
let countdownSeconds = 90;
let isCountdownRunning = false;
let isPaused = false;


const pauseResumeBtn = document.getElementById('pauseResumeBtn');
const pauseResumeText = pauseResumeBtn ? pauseResumeBtn.querySelector('.pause-resume-text') : null;
const pauseResumeIcon = pauseResumeBtn ? pauseResumeBtn.querySelector('i') : null;

function moveToNextPoint() {
    console.log('moveToNextPoint() called');

    logEvent("New point started");

    // Enter panel UI in between-points state
    if (typeof enterGameScreen === 'function') {
        enterGameScreen();
    }
    if (typeof transitionToBetweenPoints === 'function') {
        transitionToBetweenPoints();
    }

    // Start the countdown timer
    startCountdown();

    // Auto-switch to the Line tab for the Line Coach so they immediately
    // see the lineup-selection UI for the next point. This applies whether
    // the score came from Simple mode (We Score / They Score / Key Play),
    // Full mode (score throw / Callahan), or narration. We only switch if
    // the current user actually holds the Line Coach role — other coaches
    // and viewers stay on whatever tab they were already on.
    if (typeof window.isLineCoach === 'function' && window.isLineCoach()
        && typeof window.switchTab === 'function'
        && typeof window.getActiveTab === 'function'
        && window.getActiveTab() !== 'line') {
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

    // Get selected players from panel table
    let activePlayersForThisPoint = [];
    const panelCheckboxes = document.querySelectorAll('#panelActivePlayersTable input[type="checkbox"]');
    panelCheckboxes.forEach(checkbox => {
        if (checkbox.checked && checkbox.dataset.playerName) {
            activePlayersForThisPoint.push(checkbox.dataset.playerName);
        }
    });
    console.log('📋 Got players from panel table:', activePlayersForThisPoint);

    // Clear the stored next line selections since we're now using them
    console.log('About to clear next line selections in startNextPoint after using them');
    clearNextLineSelections();

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
    if (typeof enterGameScreen === 'function') {
        enterGameScreen();
    }

    // For defense points, show Pull dialog on top of game screen
    if (startPointOn === 'defense' && typeof showPullDialog === 'function') {
        showPullDialog();
    }

    // If the user started this point from the Line tab (e.g. they're a
    // solo coach who just finished setting the lineup), switch back to
    // their preferred play-by-play surface so they can immediately enter
    // events. The lastPbpTab preference is maintained by panelSystem.js.
    if (typeof window.getActiveTab === 'function'
        && typeof window.switchTab === 'function'
        && window.getActiveTab() === 'line') {
        const target = (typeof window.getLastPbpTab === 'function')
            ? window.getLastPbpTab() : 'simple';
        window.switchTab(target);
    }

    // Save and Sync on point start
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

function proceedToDefenseScreen() {
    // Panel UI handles defense display — no legacy screen navigation needed
    console.log('proceedToDefenseScreen() called — panel UI active, no-op');
}

const startPointBtn = document.getElementById('startPointBtn');
if (startPointBtn) {
    startPointBtn.addEventListener('click', startNextPoint);
}

function updateTimerDisplay(seconds) {
    const display = document.getElementById('timerDisplay');
    const minutes = Math.floor(Math.abs(seconds) / 60);
    const remainingSeconds = Math.abs(seconds) % 60;
    const sign = seconds < 0 ? '-' : '';
    display.textContent = `${sign}${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;

    // Update color based on remaining time
    display.className = '';
    if (seconds < 0) {
        display.classList.add('timer-danger');
    } else if (seconds <= 30) {
        display.classList.add('timer-warning');
    } else {
        display.classList.add('timer-normal');
    }
}

function startCountdown() {
    // Show the timer when starting countdown
    document.getElementById('countdownTimer').style.display = 'flex';

    // Clear any existing interval
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }

    let timeRemaining = countdownSeconds;
    isCountdownRunning = true;

    updateTimerDisplay(timeRemaining);

    countdownInterval = setInterval(() => {
        timeRemaining--;
        updateTimerDisplay(timeRemaining);
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

if (pauseResumeBtn) {
    pauseResumeBtn.addEventListener('click', () => {
    const point = getLatestPoint();
    if (!point) {
        console.warn("Warning: pause/resume button clicked, but no current point");
        return;
    }

    isPaused = !isPaused;
    if (isPaused) {
        // Pause logic
        point.lastPauseTime = new Date();
        if (point.startTimestamp) {
            point.totalPointTime += (point.lastPauseTime - point.startTimestamp);
            point.startTimestamp = null;
        }
        if (pauseResumeIcon) {
            pauseResumeIcon.className = 'fas fa-play';
        }
        if (pauseResumeText) {
            pauseResumeText.textContent = 'Resume';
        }
    } else {
        // Resume logic
        point.startTimestamp = new Date();
        point.lastPauseTime = null;
        if (pauseResumeIcon) {
            pauseResumeIcon.className = 'fas fa-pause';
        }
        if (pauseResumeText) {
            pauseResumeText.textContent = 'Pause';
        }
    }
});
}

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
