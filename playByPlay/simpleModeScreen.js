/*
 * Simple Mode Screen
 * Handles simple mode scoring and score attribution dialog
 */

// Track selected players for score attribution
let selectedThrower = null;
let selectedReceiver = null;

/**
 * Initialize simple mode screen event handlers
 * Should be called after DOM is ready
 */
function initializeSimpleModeScreen() {
    // Simple Mode Event Handlers
    const weScoreBtn = document.getElementById('weScoreBtn');
    const theyScoreBtn = document.getElementById('theyScoreBtn');
    const callahanBtn = document.getElementById('callahanBtn');
    const skipAttributionBtn = document.getElementById('skipAttributionBtn');
    const scoreAttributionDialogClose = document.querySelector('#scoreAttributionDialog .close');

    if (weScoreBtn) {
        weScoreBtn.addEventListener('click', function() {
            // Immediately stop the timer when "We Score" is pressed
            if (currentPoint && currentPoint.startTimestamp) {
                currentPoint.totalPointTime += (new Date() - currentPoint.startTimestamp);
                currentPoint.startTimestamp = null;
            }
            showScoreAttributionDialog();
        });
    }

    if (theyScoreBtn) {
        theyScoreBtn.addEventListener('click', function() {
            // Immediately stop the timer when "They Score" is pressed
            if (currentPoint && currentPoint.startTimestamp) {
                currentPoint.totalPointTime += (new Date() - currentPoint.startTimestamp);
                currentPoint.startTimestamp = null;
            }
            updateScore(Role.OPPONENT);
            moveToNextPoint();
        });
    }

    if (callahanBtn) {
        callahanBtn.addEventListener('click', function() {
            const dialog = document.getElementById('scoreAttributionDialog');
            // Use whichever player is selected (receiver or thrower) as the defender who caught the Callahan
            const defender = selectedReceiver || selectedThrower || null;
            const callahanEvent = new Defense({
                defender: defender,
                Callahan: true
            });
            currentPoint.addPossession(new Possession(false));
            getActivePossession(currentPoint).addEvent(callahanEvent);
            
            // Award goal to the defender who caught the Callahan
            if (defender) {
                defender.goals++;
            } else {
                console.log("Warning: no defender selected for Callahan");
            }
            
            updateScore(Role.TEAM);
            dialog.style.display = 'none';
            moveToNextPoint();
        });
    }

    if (skipAttributionBtn) {
        skipAttributionBtn.addEventListener('click', function() {
            const dialog = document.getElementById('scoreAttributionDialog');
            updateScore(Role.TEAM);
            dialog.style.display = 'none';
            moveToNextPoint();
        });
    }

    // Close dialog when clicking the X
    if (scoreAttributionDialogClose) {
        scoreAttributionDialogClose.addEventListener('click', function() {
            document.getElementById('scoreAttributionDialog').style.display = 'none';
        });
    }

    // Close dialog when clicking outside
    window.addEventListener('click', function(event) {
        const dialog = document.getElementById('scoreAttributionDialog');
        if (event.target === dialog) {
            dialog.style.display = 'none';
        }
    });
}

function showScoreAttributionDialog() {
    const dialog = document.getElementById('scoreAttributionDialog');
    const throwerButtons = document.getElementById('throwerButtons');
    const receiverButtons = document.getElementById('receiverButtons');
    
    // Reset selections
    selectedThrower = null;
    selectedReceiver = null;
    
    // Reset checkbox flags
    document.getElementById('huckFlag').checked = false;
    document.getElementById('breakFlag').checked = false;
    document.getElementById('skyFlag').checked = false;
    document.getElementById('layoutFlag').checked = false;
    document.getElementById('hammerFlag').checked = false;
    
    // Clear existing buttons
    throwerButtons.innerHTML = '';
    receiverButtons.innerHTML = '';
    
    // Add Unknown Player buttons
    const unknownThrowerBtn = createPlayerButton(UNKNOWN_PLAYER);
    const unknownReceiverBtn = createPlayerButton(UNKNOWN_PLAYER);
    throwerButtons.appendChild(unknownThrowerBtn);
    receiverButtons.appendChild(unknownReceiverBtn);
    
    // Add player buttons
    currentPoint.players.forEach(playerName => {
        const throwerBtn = createPlayerButton(playerName);
        const receiverBtn = createPlayerButton(playerName);
        throwerButtons.appendChild(throwerBtn);
        receiverButtons.appendChild(receiverBtn);
    });
    
    // Initialize Callahan button state (disabled until a player is selected)
    updateCallahanButtonState();
    
    // Show dialog
    dialog.style.display = 'block';
}

function createPlayerButton(playerName) {
    const button = document.createElement('button');
    button.textContent = playerName;
    button.classList.add('player-button');
    if (playerName === UNKNOWN_PLAYER) {
        button.classList.add('unknown-player');
    }
    button.addEventListener('click', function() {
        handleScoreAttribution(playerName, this.parentElement.id === 'throwerButtons', this);
    });
    return button;
}

function updateCallahanButtonState() {
    const callahanBtn = document.getElementById('callahanBtn');
    // Callahan button should only be enabled when exactly one player is selected (the receiver/defender)
    // It should be disabled if no one is selected OR if both thrower and receiver are selected
    if (callahanBtn) {
        if (selectedReceiver && !selectedThrower) {
            // Exactly one player selected in receiver column - enable Callahan
            callahanBtn.disabled = false;
            callahanBtn.classList.remove('inactive');
        } else if (selectedThrower && !selectedReceiver) {
            // Only thrower selected - also enable (they could be the defender)
            callahanBtn.disabled = false;
            callahanBtn.classList.remove('inactive');
        } else {
            // No one selected OR both selected - disable Callahan
            callahanBtn.disabled = true;
            callahanBtn.classList.add('inactive');
        }
    }
}

function handleScoreAttribution(playerName, isThrower, buttonElement) {
    const dialog = document.getElementById('scoreAttributionDialog');
    const player = getPlayerFromName(playerName);
    
    // Check if this button is already selected
    if (buttonElement.classList.contains('selected')) {
        // Unselect the button
        buttonElement.classList.remove('selected');
        // Reset the appropriate selection
        if (isThrower) {
            selectedThrower = null;
            // Re-enable this player's button in the receiver column
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        } else {
            selectedReceiver = null;
            // Re-enable this player's button in the thrower column
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        }
        updateCallahanButtonState();
        return;
    }
    
    // Update selection
    if (isThrower) {
        // If there was a previous thrower, re-enable their button in the receiver column
        if (selectedThrower) {
            const previousThrowerName = selectedThrower.name;
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.textContent === previousThrowerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        }
        selectedThrower = player;
        // Update button styles
        document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
            btn.classList.remove('selected');
        });
        buttonElement.classList.add('selected');
        // Disable this player's button in the receiver column
        document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
            if (btn.textContent === playerName) {
                btn.disabled = true;
                btn.classList.add('inactive');
            }
        });
    } else {
        // If there was a previous receiver, re-enable their button in the thrower column
        if (selectedReceiver) {
            const previousReceiverName = selectedReceiver.name;
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.textContent === previousReceiverName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        }
        selectedReceiver = player;
        // Update button styles
        document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
            btn.classList.remove('selected');
        });
        buttonElement.classList.add('selected');
        // Disable this player's button in the thrower column
        document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
            if (btn.textContent === playerName) {
                btn.disabled = true;
                btn.classList.add('inactive');
            }
        });
    }
    
    // Update Callahan button state based on current selections
    updateCallahanButtonState();
    
    // If both players are selected, create the event and move to next point
    if (selectedThrower && selectedReceiver) {
        const scoreEvent = new Throw({
            thrower: selectedThrower,
            receiver: selectedReceiver,
            score: true,
            huck: document.getElementById('huckFlag').checked,
            breakmark: document.getElementById('breakFlag').checked,
            sky: document.getElementById('skyFlag').checked,
            layout: document.getElementById('layoutFlag').checked,
            hammer: document.getElementById('hammerFlag').checked
        });
        currentPoint.addPossession(new Possession(true));
        getActivePossession(currentPoint).addEvent(scoreEvent);
        selectedThrower.assists++;
        selectedReceiver.goals++;
        
        // Update score and move to next point
        updateScore(Role.TEAM);
        dialog.style.display = 'none';
        moveToNextPoint();
    }
}

