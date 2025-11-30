/*
 * Defense Play-by-Play Screen
 * Handles defensive possession tracking and event creation
 */

/**
 * Update the defensive possession screen with current state
 */
function updateDefensivePossessionScreen() {
    displayDPlayerButtons();
    displayDActionButtons();
    logEvent('Refresh event log');
}

/** 
 * Create the player buttons for the defensive possession screen.
 * If current point empty (no possessions) or current possession empty (no events),
 * mark all player buttons as 'inactive' (unclickable). If the most recent event is a
 * defensive turnover, mark all player buttons as 'valid' (clickable) and show the 
 * defender (if any) as 'selected'.
 */
function displayDPlayerButtons() {
    // throw an error if there is no current point
    if (!currentPoint) {
        currentPoint = getLatestPoint();
        if (!currentPoint) { 
            throw new Error("No current point");
        }
    }
    let activePlayers = currentPoint.players; // Holds the names of active players

    let playerButtonsContainer = document.getElementById('defensivePlayerButtons');
    playerButtonsContainer.innerHTML = ''; // Clear existing buttons

    // Add Unknown Player button first
    let unknownButton = document.createElement('button');
    unknownButton.textContent = UNKNOWN_PLAYER;
    unknownButton.classList.add('player-button', 'unknown-player', 'inactive'); // Start as inactive like other D buttons
    unknownButton.addEventListener('click', function() {
        handleDPlayerButton(UNKNOWN_PLAYER);
    });
    playerButtonsContainer.appendChild(unknownButton);

    // Add rest of the players
    activePlayers.forEach(playerName => {
        let playerButton = document.createElement('button');
        playerButton.textContent = playerName;
        playerButton.classList.add('player-button'); // Add a class for styling
        playerButton.classList.add('inactive'); // Player names can't be clicked at first
        playerButton.addEventListener('click', function() {
            handleDPlayerButton(playerName);
        });
        // if latest event (XXX ignore timeouts etc) is a defensive turnover:
        if (getLatestPoint() && getLatestPoint().possessions.length > 0) {
            if (getLatestPossession().events.length > 0) {
                let latest = getLatestEvent();
                if (latest && latest.type === 'Defense') {
                    playerButton.classList.remove('inactive');
                    if (latest.defender && latest.defender.name === playerName) {
                        playerButton.classList.add('selected');
                    }
                }
            }
        }
        playerButtonsContainer.appendChild(playerButton);
    });
}

/**
 * Logic to handle click on a defensive player button 
 */
function handleDPlayerButton(playerName) {
    // find the player button that matches this player name
    let thisButton = null;
    document.querySelectorAll('.player-button').forEach(button => {
        if (button.textContent === playerName) { thisButton = button; }
    });
    // if this button doesn't exist, log a warning and return
    if (!thisButton) {
        console.log(`Warning: could not find button for player ${playerName}`);
        return;
    }
    // if this button is marked inactive, ignore and return 
    if (thisButton.classList.contains('inactive')) { return; }
    // if most recent event is a defensive turnover:
    if (currentEvent && currentEvent instanceof Defense) {
        // mark this player as the defender
        currentEvent.defender = getPlayerFromName(playerName);
        if (! currentEvent.defender) {
            console.log(`Warning: could not find player for defender ${playerName}`);
        }
        logEvent(currentEvent.summarize());
        // get player button, mark as 'selected' and unselect other players
        document.querySelectorAll('.player-button').forEach(button => {
            if (button === thisButton) {
                button.classList.add('selected');
            } else {
                button.classList.remove('selected');
            }
        });
        logEvent(currentEvent.summarize());
        
        // If this is a Callahan, award the goal and end the point immediately
        if (currentEvent.Callahan_flag) {
            if (currentEvent.defender) {
                currentEvent.defender.goals++;
            }
            showActionPanel('none');
            updateScore(Role.TEAM);
            moveToNextPoint();
        }
        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    }
}

/**
 * Function to mark all buttons as 'inactive' (unclickable)
 * (to be made valid again when a defensive Turnover action is selected)
 */
function markAllDPlayerButtonsInvalid() {
    document.querySelectorAll('.player-button').forEach(button => {
        button.classList.add('inactive');
    });
}

/**
 * Function to mark all buttons as 'valid' (clickable)
 */
function markAllDPlayerButtonsValid() {
    document.querySelectorAll('.player-button').forEach(button => {
        button.classList.remove('inactive');
    });
}

/**
 * Display action buttons for defensive possession
 */
function displayDActionButtons() {
    let actionButtonsContainer = document.getElementById('defensiveActionButtons');
    actionButtonsContainer.innerHTML = ''; // Clear existing buttons

    // Main action buttons
    const dTurnoverButton = document.createElement('button');
    dTurnoverButton.textContent = 'They Turnover';
    dTurnoverButton.classList.add('main-action-btn');
    dTurnoverButton.dataset.action = 'theyTurnover'; // This will be used to identify which panel to toggle

    const dScoreButton = document.createElement('button');
    dScoreButton.textContent = 'They Score';
    dScoreButton.classList.add('main-action-btn');
    dScoreButton.dataset.action = 'TheyScore'; // This will be used to identify which panel to toggle

    // Action panels for sub-buttons, initially hidden
    const dTurnoverPanel = document.createElement('div');
    dTurnoverPanel.classList.add('action-panel');
    dTurnoverPanel.id = 'theyturnoverPanel';

    const dScorePanel = document.createElement('div');
    dScorePanel.classList.add('action-panel');
    dScorePanel.id = 'theyscorePanel';

    // Append main action buttons and panels to the container
    const defensiveActionButtons = document.getElementById('defensiveActionButtons');
    defensiveActionButtons.appendChild(dTurnoverButton);
    defensiveActionButtons.appendChild(dTurnoverPanel); // Panel for D Turnover sub-buttons
    defensiveActionButtons.appendChild(dScoreButton);
    defensiveActionButtons.appendChild(dScorePanel); // Panel for D Score sub-buttons

    // if the latest event is Defense, make the 'They Turnover' button active & unfurl the panel
    if (getLatestEvent() && getLatestEvent() instanceof Defense) {
        dTurnoverButton.classList.add('selected');
        showActionPanel('theyturnover');
        generateSubButtons('theyturnover');
        markAllDPlayerButtonsValid();   // mark all player buttons as 'valid' (clickable)
    } else {
        markAllDPlayerButtonsInvalid();  // mark all player buttons as 'inactive' (unclickable)
        showActionPanel('none');         // hide the panel
    }
    // Add event listeners to these buttons
    dTurnoverButton.addEventListener('click', function() {
        // If button already selected, unselect and remove Defense event (which should already exist)
        if (dTurnoverButton.classList.contains('selected')) {
            dTurnoverButton.classList.remove('selected');
            if (currentEvent && currentEvent instanceof Defense) {
                // remove the most recent event from the current possession
                if (getLatestEvent() && getLatestEvent().type === 'Defense') {
                    let currentPossession = getActivePossession(currentPoint);
                    currentPossession.events.pop();
                    currentEvent = null;
                } else {
                    console.log("Error: turnover button unselected, but most recent event is not a Defense event");
                }   
            }
            markAllDPlayerButtonsInvalid();  // mark all player buttons as 'inactive' (unclickable)
            showActionPanel('none');    // unfurl the "They Turnover" panel
            if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
            return;
        }
        // Button not already selected, mark as selected and create a new Defense event
        dTurnoverButton.classList.add('selected');        
        currentEvent = new Defense({defender: null, interception: false, layout: false, sky: false, Callahan: false, turnover: true});
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);        
        logEvent(currentEvent.summarize());
        showActionPanel('theyturnover');
        generateSubButtons('theyturnover');
        markAllDPlayerButtonsValid();   // mark all player buttons as 'valid' (clickable)
        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    });

    dScoreButton.addEventListener('click', function() {
        updateScore(Role.OPPONENT);
        moveToNextPoint();
    });
}


