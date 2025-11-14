/*
 * Offense Play-by-Play Screen
 * Handles offensive possession tracking and event creation
 */

/**
 * Update the offensive possession screen with current state
 */
function updateOffensivePossessionScreen() {
    displayOPlayerButtons();
    displayOActionButtons();
    logEvent('Refresh event log');
}

/**
 * Display player buttons for offensive possession
 */
function displayOPlayerButtons() {
    // throw an error if there is no current point
    if (!currentPoint) {
        currentPoint = getLatestPoint();
        if (!currentPoint) { 
            throw new Error("No current point");
        }
    }
    let activePlayers = currentPoint.players; // Holds the names of active players

    let playerButtonsContainer = document.getElementById('offensivePlayerButtons');
    playerButtonsContainer.innerHTML = ''; // Clear existing buttons

    // Add Unknown Player button first
    let unknownButton = document.createElement('button');
    unknownButton.textContent = UNKNOWN_PLAYER;
    unknownButton.classList.add('player-button', 'unknown-player');
    unknownButton.addEventListener('click', function() {
        handleOPlayerButton(UNKNOWN_PLAYER);
    });
    playerButtonsContainer.appendChild(unknownButton);

    // Add the rest of the player buttons
    activePlayers.forEach(playerName => {
        let playerButton = document.createElement('button');
        playerButton.textContent = playerName;
        playerButton.classList.add('player-button'); // Add a class for styling
        playerButton.addEventListener('click', function() {
            handleOPlayerButton(playerName);
        });
        // if this player has the disc, mark the button as selected:
        //     - if most recent event is a Throw and the thrower is this player
        //     - if most recent event is a Turnover interception and the defender is this player
        latestPossession = getLatestPossession();
        latestEvent = getLatestEvent();
        if (latestEvent && latestEvent.type === 'Throw' && latestEvent.thrower.name === playerName) {
            playerButton.classList.add('selected');
        }
        if (latestEvent 
            && latestEvent.type === 'Defense' 
            && latestEvent.interception_flag  
            && latestEvent.defender 
            && latestEvent.defender.name === playerName) {
            playerButton.classList.add('selected');
        }
        playerButtonsContainer.appendChild(playerButton);
    });
}

/**
 * Handle click on an offensive player button
 */
function handleOPlayerButton(playerName) {
    // Logic to handle when a player button is clicked
    if (currentPoint.startTimestamp === null) {
        currentPoint.startTimestamp = new Date();
    }
    // if no possession exists, create a new one
    if (currentPoint.possessions.length === 0) {
        currentPoint.addPossession(new Possession(true));
    }
    // unselect all player buttons and select this one
    document.querySelectorAll('.player-button').forEach(button => {
        if (button.textContent === playerName) {
            button.classList.add('selected');
        } else {
            button.classList.remove('selected');
        }
    });
    // if most recent event is a throw: 
    if (currentEvent && currentEvent instanceof Throw) {
        // mark this player as the receiver (thrower will already be set)
        currentEvent.receiver = getPlayerFromName(playerName);
        if (! currentEvent.receiver) {
            console.log(`Warning: could not find player for receiver ${playerName}`);
        }
        // close the Throw panel (maybe just clear sub-btn "selected" status instead?)
        showActionPanel('none');
        // Additional logic to handle scores 
        if (currentEvent.score_flag) {
            currentEvent.receiver.goals++;
            currentEvent.thrower.assists++;
            updateScore(Role.TEAM);
            moveToNextPoint(); 
        }
    }
    logEvent('Refresh event log');
    // set currentPlayer to this player and update the action buttons
    currentPlayer = getPlayerFromName(playerName);
    displayOActionButtons();
}

/**
 * Display action buttons for offensive possession
 */
function displayOActionButtons() {
    let actionButtonsContainer = document.getElementById('offensiveActionButtons');
    actionButtonsContainer.innerHTML = ''; // Clear existing buttons

    // Main action buttons, initially inactive
    const throwButton = document.createElement('button');
    throwButton.textContent = 'Throw';
    throwButton.classList.add('main-action-btn', 'inactive');
    throwButton.dataset.action = 'Throw'; // This will be used to identify which panel to toggle

    const turnoverButton = document.createElement('button');
    turnoverButton.textContent = 'Turnover';
    turnoverButton.classList.add('main-action-btn', 'inactive');
    turnoverButton.dataset.action = 'Turnover';

    const violationButton = document.createElement('button');
    violationButton.textContent = 'Violation';
    violationButton.classList.add('main-action-btn', 'inactive');
    violationButton.dataset.action = 'Violation';

    // Action panels for sub-buttons, initially hidden
    const throwPanel = document.createElement('div');
    throwPanel.classList.add('action-panel');
    throwPanel.id = 'throwPanel';

    const turnoverPanel = document.createElement('div');
    turnoverPanel.classList.add('action-panel');
    turnoverPanel.id = 'turnoverPanel';

    const violationPanel = document.createElement('div');
    violationPanel.classList.add('action-panel');
    violationPanel.id = 'violationPanel';

    // Append main action buttons and panels to the container
    const offensiveActionButtons = document.getElementById('offensiveActionButtons');
    offensiveActionButtons.appendChild(throwButton);
    offensiveActionButtons.appendChild(throwPanel); // Panel for Throw sub-buttons
    offensiveActionButtons.appendChild(turnoverButton);
    offensiveActionButtons.appendChild(turnoverPanel); // Panel for Turnover sub-buttons
    offensiveActionButtons.appendChild(violationButton);
    offensiveActionButtons.appendChild(violationPanel); // Panel for Violation sub-buttons

    // if a player button is selected, main action buttons are active 
    if (document.querySelector('.player-button.selected')) {
        document.querySelectorAll('.main-action-btn').forEach(button => {
            button.classList.remove('inactive');
        });
    }
    // Add event listeners to these buttons
    throwButton.addEventListener('click', function() {
        // set this button to appear selected and de-select all other main-action-btns
        document.querySelectorAll('.main-action-btn').forEach(button => {
            if (button === throwButton) {
                button.classList.add('selected');
            } else {
                button.classList.remove('selected');
            }
        });
        // Create a new Throw event and add it to the current possession
        currentEvent = new Throw({thrower: currentPlayer, receiver: null, huck: false, strike: false, dump: false, hammer: false, sky: false, layout: false, score: false});
        // special case: if the most recent event is an interception, set the thrower to the defender
        const latest = getLatestEvent();
        if (latest && latest.type === 'Defense' && (latest.interception_flag || latest.Callahan_flag)) {
            currentEvent.thrower = latest.defender;
            currentPlayer = currentEvent.thrower;
        }
        showActionPanel('throw');
        generateSubButtons('throw');
        logEvent(currentEvent.summarize());
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPlayer.completedPasses++;
    });
    turnoverButton.addEventListener('click', function() {
        // set this button to appear selected and de-select all other main-action-btns
        document.querySelectorAll('.main-action-btn').forEach(button => {
            if (button === turnoverButton) {
                button.classList.add('selected');
            } else {
                button.classList.remove('selected');
            }
        });
        // Create a new Turnover event and add it to the current possession
        currentEvent = new Turnover({thrower: currentPlayer, throwaway: true, receiverError: false, goodDefense: false, stall: false});
        logEvent(currentEvent.summarize());
        showActionPanel('turnover');
        generateSubButtons('turnover');
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPossession = new Possession(false);
        currentPoint.addPossession(currentPossession);
    });
    violationButton.addEventListener('click', function() {
        // set this button to appear selected and de-select all other main-action-btns
        document.querySelectorAll('.main-action-btn').forEach(button => {
            if (button === violationButton) {
                button.classList.add('selected');
            } else {
                button.classList.remove('selected');
            }
        });
        // Create a new Violation event and add it to the current possession
        currentEvent = new Violation({thrower: currentPlayer, receiver: null, strip: false, pick: false, travel: false, contested: false, doubleTeam: false});
        logEvent(currentEvent.summarize());
        showActionPanel('violation');
        generateSubButtons('violation');
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
    });
}

/**
 * Show action panels - call with 'none' to close all panels
 */
function showActionPanel(action) {
    // Hide all action panels
    document.querySelectorAll('.action-panel').forEach(panel => {
        panel.style.display = 'none';
    });
    
    // Show the selected action panel, if it exists
    panel = document.getElementById(`${action.toLowerCase()}Panel`)
    if (panel) {
        panel.style.display = 'grid';
    }
}

/**
 * Generate sub-buttons for action panels
 */
function generateSubButtons(action) {
    const act = action.toLowerCase();
    const panel = document.getElementById(`${act}Panel`);
    panel.innerHTML = ''; // Clear current sub-buttons

    // Get the list of flags and their values for the action
    const flags = getFlagsForAction(currentEvent);
    // Create subbuttons for every flag
    Object.keys(flags).forEach(flagKey => {
        const subButton = document.createElement('button');
        subButton.textContent = flagKey;
        subButton.classList.add('sub-action-btn');
        subButton.setAttribute('data-flag', flagKey);
        // Set the button to appear selected if the flag is true
        if (flags[flagKey]) {
            subButton.classList.add('selected'); // 'selected' is a CSS class that indicates a button is selected
        }
        subButton.onclick = () => handleSubAction(flagKey, action);
        panel.appendChild(subButton);
    });

    // Special "Defense/Offense picks up" subbuttons for O/D Turnover events to start the new possession
    if (act === 'turnover' || act === 'theyturnover') { 
        const subButton = document.createElement('button');
        subButton.textContent = `${act === 'theyturnover' ? 'Offense' : 'Defense'} picks up`;
        subButton.classList.add('sub-action-btn');
        subButton.onclick = () => {
            showActionPanel('none');  // close the panel
            currentPossession = new Possession(act === 'theyturnover'); // D Turnover --> new O possession
            currentPoint.addPossession(currentPossession);
            if (act === 'theyturnover') {
                // the defense turned it over, switch to offense UNLESS a Callahan was scored
                if (currentEvent.Callahan_flag) {
                    if (currentEvent.defender) {
                        currentEvent.defender.goals++;
                    } else {
                        console.log("Warning: no defender found for Callahan");
                    }                    
                    updateScore(Role.TEAM);
                    moveToNextPoint();
                } else {
                    updateOffensivePossessionScreen();
                    showScreen('offensePlayByPlayScreen');
                }
                
            } else {
                // the offense turned it over, switch to defense
                updateDefensivePossessionScreen();
                showScreen('defensePlayByPlayScreen');
            }
        };
        panel.appendChild(subButton);
    }
}

/**
 * Handle sub action button clicks
 */
function handleSubAction(flagKey, action) {
    console.log(`Flag ${flagKey} for action ${action} was toggled`);
    // Toggle the flag value in the currentEvent object
    currentEvent[`${flagKey}_flag`] = !currentEvent[`${flagKey}_flag`];
    // Update the event log to reflect the change in flags
    logEvent(currentEvent.summarize());
    // Toggle the "selected" class on the button to show it's been activated/deactivated
    const subButton = document.querySelector(`button[data-flag="${flagKey}"]`);
    if (subButton) {
        subButton.classList.toggle('selected');
    }
}

/**
 * Get flags for the current event
 */
function getFlagsForAction() {
    const flags = {};
    for (const key in currentEvent) {
        if (currentEvent.hasOwnProperty(key) && key.endsWith('_flag')) {
            // The key is a flag; store its value in the flags object
            let shortkey = key.slice(0, -5); // remove the '_flag' suffix
            flags[shortkey] = currentEvent[key]
        }
    }
    return flags;
}

// Event listeners for main action buttons
document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('.main-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            showActionPanel(action);
            generateSubButtons(action);
        });
    });
});


