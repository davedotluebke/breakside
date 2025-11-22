/*
 * Pull Dialog
 * Handles the pull dialog for logging pulls on defense points
 */

// Track Pull dialog state
let pullSelectedPlayer = undefined; // undefined = no selection yet, null = Unknown Player selected, Player object = specific player selected
let pullSelectedQuality = null;
let pullSelectedGender = null;

/**
 * Initialize pull dialog event handlers
 * Should be called after DOM is ready
 */
function initializePullDialog() {
    const pullDialogClose = document.querySelector('#pullDialog .close');
    const pullProceedBtn = document.getElementById('pullProceedBtn');
    const pullGenderFMP = document.getElementById('pullGenderFMP');
    const pullGenderMMP = document.getElementById('pullGenderMMP');

    // Close Pull dialog when clicking the X
    if (pullDialogClose) {
        pullDialogClose.addEventListener('click', function() {
            closePullDialog();
        });
    }

    // Close Pull dialog when clicking outside
    window.addEventListener('click', function(event) {
        const dialog = document.getElementById('pullDialog');
        if (event.target === dialog) {
            closePullDialog();
        }
    });

    // Handle Proceed button
    if (pullProceedBtn) {
        pullProceedBtn.addEventListener('click', function() {
            createPullEvent();
        });
    }

    // Handle gender radio buttons
    if (pullGenderFMP) {
        pullGenderFMP.addEventListener('change', function() {
            if (this.checked) {
                pullSelectedGender = Gender.FMP;
                refreshPullPlayerButtonStyles();
                updatePullDialogState();
            }
        });
    }

    if (pullGenderMMP) {
        pullGenderMMP.addEventListener('change', function() {
            if (this.checked) {
                pullSelectedGender = Gender.MMP;
                refreshPullPlayerButtonStyles();
                updatePullDialogState();
            }
        });
    }
}

function showPullDialog() {
    const dialog = document.getElementById('pullDialog');
    const game = currentGame();
    
    if (!dialog) {
        console.error('Cannot show pull dialog: dialog element not found');
        return;
    }
    
    if (!game || !currentPoint) {
        console.error('Cannot show pull dialog: no game or point', { game: !!game, currentPoint: !!currentPoint });
        return;
    }

    // Reset dialog state
    pullSelectedPlayer = undefined; // undefined = no selection yet, null = Unknown Player selected, Player object = specific player selected
    pullSelectedQuality = null;
    pullSelectedGender = null;
    
    // Reset quality buttons - remove selected class from all
    document.querySelectorAll('.pull-quality-btn').forEach(btn => {
        btn.classList.remove('selected');
    });

    // Check if alternating gender pulls are enabled
    const alternatePulls = game.alternateGenderPulls || false;
    
    // Determine expected pull gender
    let expectedPullGender = null;
    if (alternatePulls) {
        expectedPullGender = getExpectedPullGender(game);
    }

    // Update dialog title
    const titleElement = document.getElementById('pullDialogTitle');
    if (alternatePulls && expectedPullGender) {
        titleElement.textContent = `${expectedPullGender} Pull`;
    } else {
        titleElement.textContent = 'Pull';
    }

    // Show/hide gender selection
    const genderSelection = document.getElementById('pullGenderSelection');
    const pullGenderFMP = document.getElementById('pullGenderFMP');
    const pullGenderMMP = document.getElementById('pullGenderMMP');
    
    if (alternatePulls) {
        genderSelection.style.display = 'block';
        // Check if this is the first defensive point
        const isFirstDefensivePoint = isFirstDefensivePointForTeam(game);
        if (isFirstDefensivePoint && !expectedPullGender) {
            // First defensive point and we can't determine expected gender: neither selected
            if (pullGenderFMP) pullGenderFMP.checked = false;
            if (pullGenderMMP) pullGenderMMP.checked = false;
            pullSelectedGender = null;
        } else if (expectedPullGender) {
            // Pre-select expected gender (works for both first and subsequent points)
            pullSelectedGender = expectedPullGender;
            if (expectedPullGender === Gender.FMP) {
                if (pullGenderFMP) pullGenderFMP.checked = true;
                if (pullGenderMMP) pullGenderMMP.checked = false;
            } else {
                if (pullGenderFMP) pullGenderFMP.checked = false;
                if (pullGenderMMP) pullGenderMMP.checked = true;
            }
        } else {
            // No expected gender determined: neither selected
            if (pullGenderFMP) pullGenderFMP.checked = false;
            if (pullGenderMMP) pullGenderMMP.checked = false;
            pullSelectedGender = null;
        }
    } else {
        genderSelection.style.display = 'none';
    }

    // Create player buttons
    createPullPlayerButtons(expectedPullGender, alternatePulls);

    // Set up quality button handlers
    setupPullQualityButtons();

    // Reset checkboxes
    document.getElementById('pullFlick').checked = false;
    document.getElementById('pullRoller').checked = false;
    document.getElementById('pullIO').checked = false;
    document.getElementById('pullOI').checked = false;

    // Update dialog state (will disable proceed button since no player selected yet)
    updatePullDialogState();

    // Show dialog
    console.log('Showing pull dialog');
    dialog.style.display = 'block';
    
    // Ensure dialog is visible (in case CSS is hiding it)
    if (dialog.style.display !== 'block') {
        console.warn('Dialog display style not set correctly');
    }
}

function createPullPlayerButtons(expectedGender, alternatePulls) {
    const playerButtonsContainer = document.getElementById('pullPlayerButtons');
    
    // Clear existing buttons
    playerButtonsContainer.innerHTML = '';
    
    // Add Unknown Player button first
    const unknownButton = document.createElement('button');
    unknownButton.textContent = UNKNOWN_PLAYER;
    unknownButton.classList.add('player-button', 'unknown-player');
    unknownButton.addEventListener('click', function() {
        handlePullPlayerSelection(null, this);
    });
    playerButtonsContainer.appendChild(unknownButton);
    
    // Add player buttons for all active players
    if (currentPoint && currentPoint.players) {
        currentPoint.players.forEach(playerName => {
            const player = getPlayerFromName(playerName);
            const playerButton = document.createElement('button');
            playerButton.textContent = playerName;
            playerButton.classList.add('player-button');
            
            // Check if player is eligible based on gender
            if (alternatePulls && expectedGender && player && player.gender !== Gender.UNKNOWN) {
                if (player.gender !== expectedGender) {
                    playerButton.classList.add('ineligible-puller');
                }
            }
            
            playerButton.addEventListener('click', function() {
                handlePullPlayerSelection(player, this);
            });
            playerButtonsContainer.appendChild(playerButton);
        });
    }
}

function setupPullQualityButtons() {
    const qualityButtons = document.querySelectorAll('.pull-quality-btn');
    qualityButtons.forEach(button => {
        // Remove existing listeners by cloning
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);
        
        newButton.addEventListener('click', function() {
            // Get all quality buttons (including the newly cloned ones)
            const allQualityButtons = document.querySelectorAll('.pull-quality-btn');
            
            // Toggle selection
            if (this.classList.contains('selected')) {
                this.classList.remove('selected');
                pullSelectedQuality = null;
            } else {
                // Deselect all others
                allQualityButtons.forEach(btn => btn.classList.remove('selected'));
                this.classList.add('selected');
                pullSelectedQuality = this.dataset.quality;
            }
            updatePullDialogState();
        });
    });
}

function refreshPullPlayerButtonStyles() {
    // Refresh styling for all player buttons based on current gender selection
    const game = currentGame();
    const playerButtons = document.querySelectorAll('#pullPlayerButtons .player-button');
    
    playerButtons.forEach(button => {
        // Skip Unknown Player button
        if (button.classList.contains('unknown-player')) {
            return;
        }
        
        const playerName = button.textContent;
        const player = getPlayerFromName(playerName);
        
        // Remove ineligible class first
        button.classList.remove('ineligible-puller');
        
        // Check if player is eligible based on current gender selection
        if (game && game.alternateGenderPulls && pullSelectedGender && player && player.gender !== Gender.UNKNOWN) {
            if (player.gender !== pullSelectedGender) {
                // Player is ineligible - add ineligible class
                button.classList.add('ineligible-puller');
            }
        }
        
        // If this button is selected, ensure it has the correct styling
        if (button.classList.contains('selected')) {
            // The selected styling will be handled by CSS based on ineligible-puller class
            // No additional action needed here
        }
    });
}

function handlePullPlayerSelection(player, buttonElement) {
    // Update button states - deselect all player buttons
    document.querySelectorAll('#pullPlayerButtons .player-button').forEach(btn => {
        btn.classList.remove('selected');
        btn.classList.remove('inactive');
        // Note: Keep ineligible-puller class for visual indication, but remove selected state
    });
    
    // Select the clicked button
    buttonElement.classList.add('selected');
    pullSelectedPlayer = player; // null for Unknown Player, Player object otherwise
    
    const game = currentGame();
    const playerGender = player ? player.gender : Gender.UNKNOWN;
    
    // If this is the first defensive point and no gender is selected yet,
    // automatically select the gender radio button based on the selected player's gender
    if (game && game.alternateGenderPulls && pullSelectedGender === null && playerGender !== Gender.UNKNOWN) {
        const pullGenderFMP = document.getElementById('pullGenderFMP');
        const pullGenderMMP = document.getElementById('pullGenderMMP');
        
        if (playerGender === Gender.FMP && pullGenderFMP) {
            pullGenderFMP.checked = true;
            pullSelectedGender = Gender.FMP;
        } else if (playerGender === Gender.MMP && pullGenderMMP) {
            pullGenderMMP.checked = true;
            pullSelectedGender = Gender.MMP;
        }
        
        // Refresh button styles now that gender is selected
        refreshPullPlayerButtonStyles();
    }
    
    // Check if player is ineligible - the ineligible-puller class should already be on the button
    // from when it was created, but we ensure it's there if needed
    if (game && game.alternateGenderPulls && pullSelectedGender) {
        if (playerGender !== Gender.UNKNOWN && playerGender !== pullSelectedGender) {
            // Ineligible player selected - ensure class is present
            buttonElement.classList.add('ineligible-puller');
        } else {
            // Eligible player selected - remove ineligible class if present
            buttonElement.classList.remove('ineligible-puller');
        }
    } else {
        // Not checking eligibility - remove ineligible class if present
        buttonElement.classList.remove('ineligible-puller');
    }
    
    updatePullDialogState();
}

function updatePullDialogState() {
    const proceedBtn = document.getElementById('pullProceedBtn');
    const game = currentGame();
    
    if (!proceedBtn) return;
    
    // Check if gender selection is required (only when alternate pulling is enabled)
    let genderRequired = false;
    let genderSelected = true; // Default to true when alternate pulling is not enabled
    if (game && game.alternateGenderPulls) {
        // Only require gender selection if alternate pulling is enabled
        genderRequired = isFirstDefensivePointForTeam(game);
        genderSelected = pullSelectedGender !== null;
    }
    // When alternate pulling is NOT enabled, genderSelected stays true (not required)
    
    // Check if we have required selections
    // Player selection is required (pullSelectedPlayer is set when any button is clicked, including Unknown Player which sets it to null)
    // Note: pullSelectedPlayer will be undefined initially, null when Unknown Player is selected, or a Player object when a player is selected
    const hasPlayer = pullSelectedPlayer !== undefined; // A player button has been clicked (including Unknown Player)
    
    // Quality selection is NOT required - proceed button should enable when any player is selected
    
    // Check if ineligible player is selected (only relevant when alternate pulling is enabled)
    let ineligibleSelected = false;
    if (game && game.alternateGenderPulls && pullSelectedGender && pullSelectedPlayer) {
        const playerGender = pullSelectedPlayer.gender;
        if (playerGender !== Gender.UNKNOWN && playerGender !== pullSelectedGender) {
            ineligibleSelected = true;
        }
    }
    
    // Enable/disable proceed button
    // Quality selection is NOT required - only player selection (and gender if required) is needed
    if (genderRequired && !genderSelected) {
        // Gender selection required but not selected (only when alternate pulling enabled and first defensive point)
        proceedBtn.disabled = true;
        proceedBtn.classList.remove('warning');
    } else if (hasPlayer && genderSelected) {
        // Player selected (and gender if required) - enable proceed button
        proceedBtn.disabled = false;
        if (ineligibleSelected) {
            proceedBtn.classList.add('warning');
        } else {
            proceedBtn.classList.remove('warning');
        }
    } else {
        // Missing required selections (player not selected)
        proceedBtn.disabled = true;
        proceedBtn.classList.remove('warning');
    }
}

function createPullEvent() {
    console.log('createPullEvent() called');
    const game = currentGame();
    if (!game || !currentPoint) {
        console.error('Cannot create pull event: no game or point');
        return;
    }
    
    // Ensure a player has been selected (including Unknown Player)
    if (pullSelectedPlayer === undefined) {
        console.error('Cannot create pull event: no player selected');
        return;
    }

    // Determine puller gender
    let pullerGender = Gender.UNKNOWN;
    if (game.alternateGenderPulls && pullSelectedGender) {
        pullerGender = pullSelectedGender;
    } else if (pullSelectedPlayer && pullSelectedPlayer.gender !== Gender.UNKNOWN) {
        pullerGender = pullSelectedPlayer.gender;
    }

    // Create pull event
    const pullEvent = new Pull({
        puller: pullSelectedPlayer,
        pullerGender: pullerGender,
        quality: pullSelectedQuality,
        flick: document.getElementById('pullFlick').checked,
        roller: document.getElementById('pullRoller').checked,
        io: document.getElementById('pullIO').checked,
        oi: document.getElementById('pullOI').checked
    });

    // Add to first possession (create if needed)
    let firstPossession = currentPoint.possessions.length > 0 
        ? currentPoint.possessions[0] 
        : null;
    
    if (!firstPossession) {
        // Create defensive possession for pull
        firstPossession = new Possession(false);
        currentPoint.addPossession(firstPossession);
    }
    
    // Add pull event at the beginning of the event list
    firstPossession.events.unshift(pullEvent);
    logEvent(pullEvent.summarize());

    // Close dialog and proceed to defense screen
    closePullDialog();

    console.log('Pull event created:', pullEvent.summarize());
}

function closePullDialog() {
    console.log('closePullDialog() called');
    document.getElementById('pullDialog').style.display = 'none';
    
    // Proceed to appropriate screen if we're starting a defense point
    if (currentPoint && currentPoint.startingPosition === 'defense') {
        console.log('Proceeding to defense screen, proceedToDefenseScreen available:', typeof proceedToDefenseScreen);
        // Use the proceedToDefenseScreen function if available, otherwise handle it here
        if (typeof proceedToDefenseScreen === 'function') {
            proceedToDefenseScreen();
        } else {
            // Fallback handling
            if (window.isSimpleMode) {
                showScreen('simpleModeScreen');
                if (currentPoint.startTimestamp === null) {
                    currentPoint.startTimestamp = new Date();
                }
            } else {
                updateDefensivePossessionScreen();
                showScreen('defensePlayByPlayScreen');
                if (currentPoint.possessions.length === 0) {
                    currentPoint.addPossession(new Possession(false));
                }
                if (currentPoint.startTimestamp === null) {
                    currentPoint.startTimestamp = new Date();
                }
            }
        }
    }
}

function isFirstDefensivePointForTeam(game) {
    if (!game || !game.points) return true;
    
    // Count defensive points for this team
    let defensivePointCount = 0;
    for (const point of game.points) {
        if (point.startingPosition === 'defense') {
            defensivePointCount++;
        }
    }
    
    // If current point is defense, we're counting it, so subtract 1
    if (currentPoint && currentPoint.startingPosition === 'defense') {
        defensivePointCount--;
    }
    
    return defensivePointCount === 0;
}

function getExpectedPullGender(game) {
    if (!game || !game.alternateGenderPulls) return null;
    
    // For alternating gender ratio games (4:3 - 3:4 or 3:2 - 2:3)
    // The pull should be done by a player matching the majority gender matching preference
    if (game.alternateGenderRatio === 'Alternating' && game.startingGenderRatio) {
        // Determine the current point index (currentPoint has already been added to game.points)
        const currentPointIndex = game.points.length - 1;
        
        // Get the gender ratio for this point (FMP+ or MMP+)
        const pointGenderRatio = getGenderRatioForPoint(game, currentPointIndex);
        
        if (pointGenderRatio === 'FMP') {
            return Gender.FMP;
        } else if (pointGenderRatio === 'MMP') {
            return Gender.MMP;
        }
        // If we can't determine the ratio, fall through to alternating logic below
    }
    
    // For fixed ratio games (e.g., "4:3", "3:2") with alternating gender pulls enabled,
    // pulls should alternate gender every point
    // Get all defensive points (excluding current point)
    const defensivePoints = [];
    for (const point of game.points) {
        if (point.startingPosition === 'defense' && point !== currentPoint) {
            defensivePoints.push(point);
        }
    }
    
    // Find the last pull event to determine what gender pulled last
    let lastPullGender = null;
    for (let i = defensivePoints.length - 1; i >= 0; i--) {
        const point = defensivePoints[i];
        for (const possession of point.possessions) {
            for (const event of possession.events) {
                if (event.type === 'Pull' && event.pullerGender !== Gender.UNKNOWN) {
                    lastPullGender = event.pullerGender;
                    break;
                }
            }
            if (lastPullGender) break;
        }
        if (lastPullGender) break;
    }
    
    // If no previous pull, return null (user must select)
    if (!lastPullGender) return null;
    
    // Return opposite gender
    return lastPullGender === Gender.FMP ? Gender.MMP : Gender.FMP;
}

