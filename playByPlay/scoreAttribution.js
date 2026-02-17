/*
 * Score Attribution Dialog
 * Handles the "We Score" player attribution dialog (thrower/receiver selection).
 * Extracted from simpleModeScreen.js during legacy screen cleanup.
 */

// Track selected players for score attribution
let selectedThrower = null;
let selectedReceiver = null;

/**
 * Initialize score attribution dialog event handlers
 * Should be called after DOM is ready
 */
function initializeScoreAttributionDialog() {
    const callahanBtn = document.getElementById('callahanBtn');
    const skipAttributionBtn = document.getElementById('skipAttributionBtn');
    const scoreAttributionDialogClose = document.querySelector('#scoreAttributionDialog .close');

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
    if (callahanBtn) {
        if (selectedReceiver && !selectedThrower) {
            callahanBtn.disabled = false;
            callahanBtn.classList.remove('inactive');
        } else if (selectedThrower && !selectedReceiver) {
            callahanBtn.disabled = false;
            callahanBtn.classList.remove('inactive');
        } else {
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
        buttonElement.classList.remove('selected');
        if (isThrower) {
            selectedThrower = null;
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        } else {
            selectedReceiver = null;
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

    if (isThrower) {
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
        document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
            btn.classList.remove('selected');
        });
        buttonElement.classList.add('selected');
        if (playerName !== UNKNOWN_PLAYER) {
            document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
        }
    } else {
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
        document.querySelectorAll('#receiverButtons .player-button').forEach(btn => {
            btn.classList.remove('selected');
        });
        buttonElement.classList.add('selected');
        if (playerName !== UNKNOWN_PLAYER) {
            document.querySelectorAll('#throwerButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
        }
    }

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

        updateScore(Role.TEAM);
        dialog.style.display = 'none';
        moveToNextPoint();
    }
}
