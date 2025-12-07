/*
 * Point Management
 * Handles point creation, transitions, and timing controls.
 */
let countdownInterval = null;
let countdownSeconds = 90;
let isCountdownRunning = false;
let isPaused = false;

if (typeof window.isSimpleMode === 'undefined') {
    window.isSimpleMode = true;
}

const pauseResumeBtn = document.getElementById('pauseResumeBtn');
const pauseResumeText = pauseResumeBtn ? pauseResumeBtn.querySelector('.pause-resume-text') : null;
const pauseResumeIcon = pauseResumeBtn ? pauseResumeBtn.querySelector('i') : null;

function moveToNextPoint() {
    console.log('moveToNextPoint() called, current nextLineSelections:', nextLineSelections);

    // If we're in next line selection mode, exit it
    if (document.body.classList.contains('next-line-mode')) {
        console.log('Exiting next line mode from moveToNextPoint');
        exitNextLineSelectionMode();
    }

    // Don't clear next line selections here - we want them to persist to the next point's Before Point screen
    // They will be cleared when the point actually starts in startNextPoint()

    updateActivePlayersList();
    logEvent("New point started");
    // make contiueGameBtn active to enable changing roster between points
    document.getElementById('continueGameBtn').classList.remove('inactive');
    showScreen('beforePointScreen');
    checkPlayerCount();  // to update the "Start Point" button style
    makeColumnsSticky(); // once the table is rendered, make the left columns sticky

    // Start the countdown timer
    startCountdown();
    
    // Sync to cloud when point ends (for live viewer updates)
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

function startNextPoint() {
    // Stop the countdown when point starts
    stopCountdown();

    // Get the checkboxes and player names
    const checkboxes = [...document.querySelectorAll('#activePlayersTable input[type="checkbox"]')];

    const activePlayersForThisPoint = [];
    checkboxes.forEach((checkbox, index) => {
        if (checkbox.checked) {
            const player = currentTeam.teamRoster[index];
            activePlayersForThisPoint.push(player.name);
        }
    });

    // Clear the stored next line selections since we're now using them
    console.log('About to clear next line selections in startNextPoint after using them');
    clearNextLineSelections();

    // determine starting position: check point winners and switchside events
    const startPointOn = determineStartingPosition();

    // Create a new Point with the active players and starting position
    currentPoint = new Point(activePlayersForThisPoint, startPointOn);
    currentGame().points.push(currentPoint);

    // Update the simple mode toggle to match isSimpleMode before showing the screen
    document.getElementById('simpleModeToggle').checked = window.isSimpleMode;

    // For defense points, show Pull dialog first (regardless of simple mode)
    // The dialog will handle proceeding to the appropriate screen
    if (startPointOn === 'defense') {
        if (typeof showPullDialog === 'function') {
            showPullDialog();
        } else {
            // Fallback if dialog not available
            proceedToDefenseScreen();
        }
    } else {
        // Offense points go directly to their screen
        if (window.isSimpleMode) {
            showScreen('simpleModeScreen');
            // Start timing immediately in simple mode
            if (currentPoint.startTimestamp !== null) {
                console.warn("Warning: startTimestamp was already set when starting point in simple mode");
            }
            currentPoint.startTimestamp = new Date();
        } else {
            updateOffensivePossessionScreen();
            showScreen('offensePlayByPlayScreen');
        }
    }
    
    // Save and Sync on point start
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

function proceedToDefenseScreen() {
    console.log('proceedToDefenseScreen() called, isSimpleMode:', window.isSimpleMode, 'possessions.length:', currentPoint ? currentPoint.possessions.length : 'no currentPoint');
    if (window.isSimpleMode) {
        showScreen('simpleModeScreen');
        // Start timing immediately in simple mode
        if (currentPoint.startTimestamp !== null) {
            console.warn("Warning: startTimestamp was already set when starting defensive point in simple mode");
        }
        currentPoint.startTimestamp = new Date();
    } else {
        updateDefensivePossessionScreen();
        showScreen('defensePlayByPlayScreen');
        // Ensure we have a defensive possession
        if (currentPoint.possessions.length === 0) {
            currentPoint.addPossession(new Possession(false));
        }
        if (currentPoint.startTimestamp !== null) {
            console.warn("Warning: startTimestamp was already set when starting defensive point");
        }
        currentPoint.startTimestamp = new Date();
    }
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
    if (!currentPoint) {
        console.warn("Warning: pause/resume button clicked, but currentPoint is null");
        return;
    }

    isPaused = !isPaused;
    if (isPaused) {
        // Pause logic
        currentPoint.lastPauseTime = new Date();
        if (currentPoint.startTimestamp) {
            currentPoint.totalPointTime += (currentPoint.lastPauseTime - currentPoint.startTimestamp);
            currentPoint.startTimestamp = null;
        }
        if (pauseResumeIcon) {
            pauseResumeIcon.className = 'fas fa-play';
        }
        if (pauseResumeText) {
            pauseResumeText.textContent = 'Resume';
        }
    } else {
        // Resume logic
        currentPoint.startTimestamp = new Date();
        currentPoint.lastPauseTime = null;
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
    if (!currentPoint) return;

    let elapsedTime = currentPoint.totalPointTime;
    if (currentPoint.startTimestamp && !isPaused) {
        elapsedTime += (new Date() - currentPoint.startTimestamp);
    }

    const minutes = Math.floor(elapsedTime / 60000);
    const seconds = Math.floor((elapsedTime % 60000) / 1000);
    const formattedTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Update both the main and mini timers
    document.getElementById('pointTimer').textContent = formattedTime;

    // Also update mini timer if in next line selection mode
    if (document.body.classList.contains('next-line-mode')) {
        document.getElementById('pointTimerMini').textContent = formattedTime;

        // In next line selection mode, also update the time displays for active players
        if (currentPoint && currentPoint.players) {
            const timeCells = document.querySelectorAll('.active-time-column');

            currentTeam.teamRoster.forEach((player, idx) => {
                if (idx < timeCells.length) {
                    // Only update time for players currently in the game
                    if (currentPoint.players.includes(player.name)) {
                        const totalTime = getPlayerGameTime(player.name);
                        timeCells[idx].textContent = formatPlayTime(totalTime);
                    }
                }
            });
        }
    }
}

setInterval(updatePointTimer, 1000);
