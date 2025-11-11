/*
 * Before Point Screen
 * Manages active player selection, line management, and next line mode.
 * Note: Active players display functions are in ui/activePlayersDisplay.js
 */
let shouldClearSelectionsInLineDialog = true;
let touchStartY = 0;
let touchSwipeListenerActive = false;

// togglePlayerStats is now in ui/activePlayersDisplay.js
document.getElementById('statsToggle').addEventListener('click', togglePlayerStats);

document.getElementById('adjustRosterBtn').addEventListener('click', function() {
    updateTeamRosterDisplay();
    showScreen('teamRosterScreen');
    document.getElementById('continueGameBtn').classList.remove('inactive');
});

// Active players display functions are now in ui/activePlayersDisplay.js
// Functions available: updateActivePlayersList, makeColumnsSticky, captureNextLineSelections, clearNextLineSelections

function determineStartingPosition() {
    if (!currentGame()) { console.log("Warning: No current game"); return 'offense'; }
    let startPointOn = currentGame().startingPosition;
    currentGame().points.forEach(point => {
        let switchsides = false; // flag to indicate if O and D switch sides after this point
        point.possessions.forEach(possession => {
            possession.events.forEach(event => {
                if (event.type === 'Other' && event.switchsides_flag) {
                    switchsides = !switchsides;
                }
            });
        });
        if (point.winner === 'team') {
            // if the team won the last point, they will start on defense unless switchsides is true
            startPointOn = switchsides ? 'offense' : 'defense';
        } else {
            //  the opponent won the last point, our team will start on offense unless switchsides is true
            startPointOn = switchsides ? 'defense' : 'offense';
        }
    });
    return startPointOn;
}

function checkPlayerCount() {
    const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
    const selectedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput').value, 10);

    // Determine which button to update based on mode
    const inNextLineMode = document.body.classList.contains('next-line-mode');
    const startPointBtn = document.getElementById('startPointBtn');
    const selectNextLineBtn = document.getElementById('selectNextLineBtn');
    const activeBtn = inNextLineMode ? selectNextLineBtn : startPointBtn;

    // Remove warning and inactive classes
    activeBtn.classList.remove('warning');
    activeBtn.classList.remove('inactive');

    // Check gender ratio if applicable
    const game = currentGame();
    let genderRatioWarning = false;
    let startingRatioRequired = false;
    
    if (game && game.alternateGenderRatio) {
        // Check if starting ratio needs to be set (first point)
        if (!game.startingGenderRatio && game.points.length === 0) {
            startingRatioRequired = true;
        } else if (selectedCount === expectedCount) {
            genderRatioWarning = !checkGenderRatio();
        }
    }

    // Apply appropriate classes based on player count and gender ratio
    if (selectedCount === 0) {
        activeBtn.classList.add('inactive');
    } else if (startingRatioRequired) {
        // Starting ratio not selected - disable button
        activeBtn.classList.add('inactive');
    } else if (selectedCount !== expectedCount) {
        activeBtn.classList.add('warning');
    } else if (genderRatioWarning) {
        // Wrong gender ratio - use orange warning
        activeBtn.classList.add('warning');
        activeBtn.style.backgroundColor = '#ff8800'; // Orange
    } else {
        // Reset to default warning color if not gender ratio issue
        activeBtn.style.backgroundColor = '';
    }

    // Update button text (only for startPointBtn when not in next line mode)
    if (!inNextLineMode) {
        // If a point is in progress, the button should say "Continue Point"
        if (isPointInProgress()) {
            startPointBtn.textContent = "Continue Point";
        } else {
            startPointBtn.textContent = "Start Point";
        }

        // Append "(Offense)" or "(Defense)" based on the next point
        const startPointOn = determineStartingPosition();
        startPointBtn.textContent += ` (${capitalize(startPointOn)})`;
    } else {
        // In next line mode, always show "Select Next Line"
        selectNextLineBtn.textContent = "Select Next Line";
    }
    
    // Update gender ratio display (pass genderRatioWarning to style it)
    updateGenderRatioDisplay(genderRatioWarning);
}

function checkGenderRatio() {
    const game = currentGame();
    if (!game || !game.alternateGenderRatio) return true; // Not checking gender ratio
    
    const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
    const selectedPlayers = [];
    checkboxes.forEach((checkbox, index) => {
        if (checkbox.checked) {
            const player = currentTeam.teamRoster[index];
            if (player) {
                selectedPlayers.push(player);
            }
        }
    });
    
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput').value, 10);
    if (selectedPlayers.length !== expectedCount) return true; // Wrong count, handled elsewhere
    
    // Count genders
    let fmpCount = 0;
    let mmpCount = 0;
    selectedPlayers.forEach(player => {
        if (player.gender === Gender.FMP) fmpCount++;
        else if (player.gender === Gender.MMP) mmpCount++;
    });
    
    // Determine expected ratio for this point
    const expectedRatio = getExpectedGenderRatio(game);
    if (!expectedRatio) return true; // No ratio set yet
    
    // Check if ratio matches (for 7 players: 4:3 or 3:4)
    if (expectedCount === 7) {
        if (expectedRatio === 'FMP') {
            return fmpCount === 4 && mmpCount === 3;
        } else {
            return fmpCount === 3 && mmpCount === 4;
        }
    }
    
    return true; // For other player counts, don't enforce ratio
}

function getExpectedGenderRatio(game) {
    if (!game || !game.alternateGenderRatio) return null;
    
    // If starting ratio not set, return null (user needs to set it)
    if (!game.startingGenderRatio) return null;
    
    // Count points to determine pattern position (ABBAABB)
    const pointCount = game.points.length;
    
    // Pattern: ABBAABB (0-indexed: 0=A, 1=B, 2=B, 3=A, 4=A, 5=B, 6=B, 7=A, ...)
    const pattern = [0, 1, 1, 0, 0, 1, 1]; // 0 = first ratio, 1 = second ratio
    const patternIndex = pointCount % 7;
    const useFirstRatio = pattern[patternIndex] === 0;
    
    return useFirstRatio ? game.startingGenderRatio : (game.startingGenderRatio === 'FMP' ? 'MMP' : 'FMP');
}

function updateGenderRatioDisplay(genderRatioWarning = false) {
    const game = currentGame();
    const display = document.getElementById('genderRatioDisplay');
    const text = document.getElementById('genderRatioText');
    const ratioSelection = document.getElementById('startingGenderRatioSelection');
    
    if (!game || !game.alternateGenderRatio) {
        if (display) display.style.display = 'none';
        if (ratioSelection) ratioSelection.style.display = 'none';
        return;
    }
    
    if (!display || !text) return;
    
    // Remove any existing gender ratio warning classes
    text.classList.remove('gender-ratio-fmp-warning', 'gender-ratio-mmp-warning');
    
    const expectedRatio = getExpectedGenderRatio(game);
    if (expectedRatio) {
        display.style.display = 'block';
        text.textContent = `+${expectedRatio} point`;
        if (ratioSelection) ratioSelection.style.display = 'none';
        
        // Always apply color styling based on expected ratio (regardless of warning state)
        if (expectedRatio === 'FMP') {
            text.classList.add('gender-ratio-fmp-warning');
        } else if (expectedRatio === 'MMP') {
            text.classList.add('gender-ratio-mmp-warning');
        }
    } else {
        // First point - need to set starting ratio
        display.style.display = 'block';
        text.textContent = 'Select starting ratio';
        if (ratioSelection) {
            ratioSelection.style.display = 'block';
            // Set up radio button handlers if not already set
            setupStartingRatioRadioButtons();
        }
    }
}

function setupStartingRatioRadioButtons() {
    const fmpRadio = document.getElementById('startingRatioFMP');
    const mmpRadio = document.getElementById('startingRatioMMP');
    const game = currentGame();
    
    if (!fmpRadio || !mmpRadio || !game) return;
    
    // Remove existing listeners by cloning
    const newFMP = fmpRadio.cloneNode(true);
    const newMMP = mmpRadio.cloneNode(true);
    fmpRadio.parentNode.replaceChild(newFMP, fmpRadio);
    mmpRadio.parentNode.replaceChild(newMMP, mmpRadio);
    
    // Set current value if already set
    if (game.startingGenderRatio === 'FMP') {
        newFMP.checked = true;
    } else if (game.startingGenderRatio === 'MMP') {
        newMMP.checked = true;
    }
    
    // Add event listeners
    newFMP.addEventListener('change', function() {
        if (this.checked) {
            game.startingGenderRatio = 'FMP';
            saveAllTeamsData();
            checkPlayerCount(); // Update display
        }
    });
    
    newMMP.addEventListener('change', function() {
        if (this.checked) {
            game.startingGenderRatio = 'MMP';
            saveAllTeamsData();
            checkPlayerCount(); // Update display
        }
    });
}

document.getElementById('selectLineBtn').addEventListener('click', showLineSelectionDialog);

document.getElementById('selectNextLineBtn').addEventListener('click', function() {
    exitNextLineSelectionMode();
});

function showLineSelectionDialog() {
    if (!currentTeam || !currentTeam.lines || currentTeam.lines.length === 0) {
        alert('No lines have been created yet. Please create lines in the roster management screen.');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'select-line-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'select-line-dialog';

    const heading = document.createElement('h3');
    heading.textContent = 'Select Line';
    dialog.appendChild(heading);

    // Add checkbox for clearing existing selections
    const checkboxContainer = document.createElement('div');
    checkboxContainer.className = 'clear-selections-checkbox-container';

    const clearCheckbox = document.createElement('input');
    clearCheckbox.type = 'checkbox';
    clearCheckbox.id = 'clearSelectionsCheckbox';
    clearCheckbox.checked = shouldClearSelectionsInLineDialog;

    const clearLabel = document.createElement('label');
    clearLabel.htmlFor = 'clearSelectionsCheckbox';
    clearLabel.textContent = 'Clear existing selections';

    checkboxContainer.appendChild(clearCheckbox);
    checkboxContainer.appendChild(clearLabel);
    dialog.appendChild(checkboxContainer);

    const radioContainer = document.createElement('div');
    radioContainer.className = 'select-line-radio-container';

    let selectedLine = null;

    currentTeam.lines.forEach((line, index) => {
        const option = document.createElement('div');
        option.className = 'select-line-radio-option';
        if (currentGame && currentGame.lastLineUsed === line.name) {
            option.classList.add('last-used');
        }

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'lineSelection';
        radio.id = `line-${index}`;
        radio.value = line.name;

        const label = document.createElement('label');
        label.htmlFor = `line-${index}`;

        const lineName = document.createElement('span');
        lineName.className = 'line-name';
        lineName.textContent = line.name;

        const players = document.createElement('span');
        players.className = 'line-players';
        players.textContent = line.players.join(', ');

        label.appendChild(lineName);
        label.appendChild(players);

        radio.addEventListener('change', () => {
            selectedLine = line;
            selectButton.disabled = false;
        });

        option.appendChild(radio);
        option.appendChild(label);
        radioContainer.appendChild(option);
    });

    dialog.appendChild(radioContainer);

    const buttons = document.createElement('div');
    buttons.className = 'select-line-buttons';

    const selectButton = document.createElement('button');
    selectButton.className = 'select-line-button select';
    selectButton.textContent = 'Select';
    selectButton.disabled = true;
    selectButton.addEventListener('click', () => {
        if (selectedLine) {
            // Only uncheck all checkboxes if the checkbox is checked
            if (clearCheckbox.checked) {
                document.querySelectorAll('#activePlayersTable input[type="checkbox"]').forEach(checkbox => {
                    checkbox.checked = false;
                });
            }

            // Check boxes for players in the selected line
            const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
            currentTeam.teamRoster.forEach((player, index) => {
                if (selectedLine.players.includes(player.name)) {
                    checkboxes[index].checked = true;
                }
            });

            // Clear any stored next line selections since we just made a new line selection
            clearNextLineSelections();

            // Update the last used line and save
            currentGame().lastLineUsed = selectedLine.name;
            saveAllTeamsData();

            // Update the Start Point button state
            checkPlayerCount();

            // Uncheck the checkbox for next time (unless we're still in the same point)
            shouldClearSelectionsInLineDialog = false;

            // Close the dialog
            overlay.remove();
        }
    });

    const cancelButton = document.createElement('button');
    cancelButton.className = 'select-line-button cancel';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => {
        overlay.remove();
    });

    buttons.appendChild(selectButton);
    buttons.appendChild(cancelButton);
    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

function updateActivePlayersDisplay() {
    const table = document.getElementById('activePlayersTable');
    if (!table) return;

    // Clear existing rows except header
    while (table.rows.length > 1) {
        table.deleteRow(1);
    }

    // Add rows for each active player
    currentGame.activePlayers.forEach(playerName => {
        const row = table.insertRow();

        // Add checkbox cell
        const checkboxCell = row.insertCell();
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'active-checkbox';
        checkbox.checked = true; // Active players are checked by default
        checkboxCell.appendChild(checkbox);

        // Add player name cell
        const nameCell = row.insertCell();
        nameCell.textContent = playerName;

        // Add time played cell
        const timeCell = row.insertCell();
        timeCell.textContent = formatPlayTime(getPlayerGameTime(playerName));

        // Add cells for each point
        const latestPoint = getLatestPoint();
        if (latestPoint) {
            const pointsPlayed = latestPoint.playingPlayers.includes(playerName) ? '✓' : '';
            const pointCell = row.insertCell();
            pointCell.textContent = pointsPlayed;
        }
    });
}

function enterNextLineSelectionMode() {
    // First, update the active players list
    updateActivePlayersList();

    // Show the next line header
    document.getElementById('nextLineHeader').style.display = 'block';

    // Add class to body to trigger the CSS changes
    document.body.classList.add('next-line-mode');

    // Update the pause/resume button icon
    updatePauseResumeIconsForNextLineMode();

    // Make table columns sticky after rendering
    setTimeout(makeColumnsSticky, 100);

    // Set up the touch events for swiping
    setupSwipeEvents();

    // Start a timer to update player times in this view
    startNextLinePlayerTimeUpdates();

    // Update the player count check for the selectNextLineBtn
    checkPlayerCount();
}

function startNextLinePlayerTimeUpdates() {
    // Make sure we don't have duplicate intervals
    if (window.nextLineTimeUpdateInterval) {
        clearInterval(window.nextLineTimeUpdateInterval);
    }

    // Update times immediately
    updatePlayerTimesInNextLineMode();

    // Set interval to update times every second
    window.nextLineTimeUpdateInterval = setInterval(function() {
        if (document.body.classList.contains('next-line-mode')) {
            updatePlayerTimesInNextLineMode();
        } else {
            // Clean up interval if we're not in next line mode
            clearInterval(window.nextLineTimeUpdateInterval);
            window.nextLineTimeUpdateInterval = null;
        }
    }, 1000);
}

function updatePlayerTimesInNextLineMode() {
    if (!currentPoint || !currentPoint.players) return;

    const timeCells = document.querySelectorAll('.active-time-column');
    currentTeam.teamRoster.forEach((player, idx) => {
        if (idx < timeCells.length) {
            // Highlight and update time for players currently in the game
            if (currentPoint.players.includes(player.name)) {
                timeCells[idx].textContent = formatPlayTime(getPlayerGameTime(player.name));
                timeCells[idx].classList.add('active-player-time');
            } else {
                timeCells[idx].classList.remove('active-player-time');
            }
        }
    });
}

function exitNextLineSelectionMode() {
    // Capture the current selections before exiting
    console.log('exitNextLineSelectionMode() capturing selections');
    captureNextLineSelections();

    // Hide the next line header
    document.getElementById('nextLineHeader').style.display = 'none';

    // Remove class from body
    document.body.classList.remove('next-line-mode');

    // Restore the Start Point button text
    const startPointOn = determineStartingPosition();
    document.getElementById('startPointBtn').textContent = `Start Point (${capitalize(startPointOn)})`;

    // Clean up any swipe event listeners
    cleanupSwipeEvents();

    // Clean up time update interval
    if (window.nextLineTimeUpdateInterval) {
        clearInterval(window.nextLineTimeUpdateInterval);
        window.nextLineTimeUpdateInterval = null;
    }

    // Update the player count check for the startPointBtn
    checkPlayerCount();
}

document.getElementById('chooseNextLineBtn').addEventListener('click', function() {
    enterNextLineSelectionMode();
});

document.getElementById('weScoreBtnMini').addEventListener('click', function() {
    // Delegate the click to the main We Score button
    document.getElementById('weScoreBtn').click();
});

document.getElementById('theyScoreBtnMini').addEventListener('click', function() {
    // Delegate the click to the main They Score button
    document.getElementById('theyScoreBtn').click();
});

document.getElementById('pauseResumeBtnMini').addEventListener('click', function() {
    // Delegate the click to the main pause/resume button
    document.getElementById('pauseResumeBtn').click();
    // Update the mini button's icon based on pause state
    updatePauseResumeIconsForNextLineMode();
});

document.querySelector('.swipe-indicator').addEventListener('click', function() {
    exitNextLineSelectionMode();
});

function syncPointTimers() {
    const mainTimer = document.getElementById('pointTimer');
    const miniTimer = document.getElementById('pointTimerMini');
    miniTimer.textContent = mainTimer.textContent;
}

function updatePauseResumeIconsForNextLineMode() {
    const iconClass = isPaused ? 'fa-play' : 'fa-pause';
    const mainIcon = document.querySelector('#pauseResumeBtn i');
    const miniIcon = document.querySelector('#pauseResumeBtnMini i');

    if (mainIcon) mainIcon.className = `fas ${iconClass}`;
    if (miniIcon) miniIcon.className = `fas ${iconClass}`;

    const pauseResumeText = document.querySelector('.pause-resume-text');
    if (pauseResumeText) {
        pauseResumeText.textContent = isPaused ? 'Resume' : 'Pause';
    }
}

function setupSwipeEvents() {
    if (touchSwipeListenerActive) return;

    const nextLineHeader = document.getElementById('nextLineHeader');

    nextLineHeader.addEventListener('touchstart', handleTouchStart, { passive: true });
    nextLineHeader.addEventListener('touchmove', handleTouchMove, { passive: true });
    nextLineHeader.addEventListener('touchend', handleTouchEnd, { passive: true });

    touchSwipeListenerActive = true;
}

function cleanupSwipeEvents() {
    if (!touchSwipeListenerActive) return;

    const nextLineHeader = document.getElementById('nextLineHeader');

    nextLineHeader.removeEventListener('touchstart', handleTouchStart);
    nextLineHeader.removeEventListener('touchmove', handleTouchMove);
    nextLineHeader.removeEventListener('touchend', handleTouchEnd);

    touchSwipeListenerActive = false;
}

function handleTouchStart(event) {
    touchStartY = event.touches[0].clientY;
}

function handleTouchMove(event) {
    if (!touchStartY) return;

    const touchY = event.touches[0].clientY;
    const diff = touchY - touchStartY;

    // If user has swiped down at least 50px, exit the next line mode
    if (diff > 50) {
        exitNextLineSelectionMode();
        touchStartY = 0; // Reset
    }
}

function handleTouchEnd() {
    touchStartY = 0; // Reset
}

// matchButtonWidths is now in ui/buttonLayout.js

const activePlayersTable = document.getElementById('activePlayersTable');
if (activePlayersTable) {
    activePlayersTable.addEventListener('change', function(event) {
        if (event.target && event.target.matches('input[type="checkbox"]')) {
            checkPlayerCount();
            if (document.body.classList.contains('next-line-mode')) {
                captureNextLineSelections();
            }
        }
    });
}

const playersOnFieldInput = document.getElementById('playersOnFieldInput');
if (playersOnFieldInput) {
    playersOnFieldInput.addEventListener('input', checkPlayerCount);
}
