/*
 * Key Play Dialog
 * Handles the key play dialog for logging throws, turnovers, and defense events
 */

// Track Key Play dialog state
let keyPlaySelectedSubButtons = [];
let keyPlaySelectedThrower = null;
let keyPlaySelectedReceiver = null;
let keyPlayCurrentRole = 'thrower'; // 'thrower' or 'receiver'

/**
 * Initialize key play dialog event handlers
 * Should be called after DOM is ready
 */
function initializeKeyPlayDialog() {
    const keyPlayBtn = document.getElementById('keyPlayBtn');
    const keyPlayDialogClose = document.querySelector('#keyPlayDialog .close');

    if (keyPlayBtn) {
        keyPlayBtn.addEventListener('click', function() {
            showKeyPlayDialog();
        });
    }

    // Close Key Play dialog when clicking the X
    if (keyPlayDialogClose) {
        keyPlayDialogClose.addEventListener('click', function() {
            document.getElementById('keyPlayDialog').style.display = 'none';
        });
    }

    // Close Key Play dialog when clicking outside
    window.addEventListener('click', function(event) {
        const dialog = document.getElementById('keyPlayDialog');
        if (event.target === dialog) {
            dialog.style.display = 'none';
        }
    });
}

function showKeyPlayDialog() {
    const dialog = document.getElementById('keyPlayDialog');
    
    // Reset dialog state
    keyPlaySelectedSubButtons = [];
    keyPlaySelectedThrower = null;
    keyPlaySelectedReceiver = null;
    keyPlayCurrentRole = 'thrower';
    
    createKeyPlayPanels();
    createKeyPlayPlayerButtons();
    
    // Show dialog
    dialog.style.display = 'block';
}

function createKeyPlayPanels() {
    const panelsContainer = document.getElementById('keyPlayPanels');
    
    // Clear existing content
    panelsContainer.innerHTML = '';
    
    // Create Throw Panel
    const throwPanel = createKeyPlayPanel('Throws', [
        { text: 'huck', fullWidth: false },
        { text: 'break', fullWidth: false },
        { text: 'hammer', fullWidth: false },
        { text: 'dump', fullWidth: false },
        { text: 'layout', fullWidth: false },
        { text: 'sky', fullWidth: false },
        { text: 'score', fullWidth: true }
    ], 'throw');
    
    // Create Turnover Panel
    const turnoverPanel = createKeyPlayPanel('Turnover', [
        { text: 'throwaway', fullWidth: true },
        { text: 'huck', fullWidth: false },
        { text: 'drop', fullWidth: false },
        { text: 'good D', fullWidth: false },
        { text: 'stall', fullWidth: false }
    ], 'turnover');
    
    // Create Defense Panel
    const defensePanel = createKeyPlayPanel('Defense', [
        { text: 'block', fullWidth: false },
        { text: 'stall', fullWidth: false },
        { text: 'interception', fullWidth: true },
        { text: 'layout', fullWidth: false },
        { text: 'sky', fullWidth: false },
        { text: 'unforced error', fullWidth: true },
        { text: 'Callahan', fullWidth: true }
    ], 'defense');
    
    // Append panels
    panelsContainer.appendChild(throwPanel);
    panelsContainer.appendChild(turnoverPanel);
    panelsContainer.appendChild(defensePanel);
}

function createKeyPlayPanel(panelTitle, subButtons, panelType) {
    const panel = document.createElement('div');
    panel.classList.add('key-play-panel');
    panel.dataset.panelType = panelType;
    
    // Create panel header (clickable)
    const panelHeader = document.createElement('div');
    panelHeader.classList.add('key-play-panel-header');
    panelHeader.textContent = panelTitle;
    panelHeader.style.cursor = 'pointer';
    panelHeader.addEventListener('click', function() {
        handleKeyPlayPanelToggle(panelType, this);
    });
    panel.appendChild(panelHeader);
    
    // Create sub-buttons container (initially hidden)
    const subButtonsContainer = document.createElement('div');
    subButtonsContainer.classList.add('key-play-sub-buttons');
    subButtonsContainer.style.height = '0'; // Start furled
    subButtonsContainer.style.opacity = '0'; // Start transparent
    
    // Create sub-buttons
    subButtons.forEach(buttonConfig => {
        const subButton = document.createElement('button');
        subButton.textContent = buttonConfig.text;
        subButton.classList.add('key-play-sub-btn');
        if (buttonConfig.fullWidth) {
            subButton.classList.add('full-width');
        }
        subButton.dataset.flag = buttonConfig.text;
        subButton.dataset.panel = panelType;
        subButton.dataset.subButtonType = `${panelType}-${buttonConfig.text}`;
        
        subButton.addEventListener('click', function() {
            handleKeyPlaySubButton(buttonConfig.text, panelType, this);
        });
        
        subButtonsContainer.appendChild(subButton);
    });
    
    panel.appendChild(subButtonsContainer);
    return panel;
}

function createKeyPlayPlayerButtons() {
    const playerButtonsContainer = document.getElementById('keyPlayPlayerButtons');
    
    // Clear existing buttons
    playerButtonsContainer.innerHTML = '';
    
    // Add Unknown Player button first
    const unknownButton = document.createElement('button');
    unknownButton.textContent = UNKNOWN_PLAYER;
    unknownButton.classList.add('player-button', 'unknown-player', 'inactive');
    unknownButton.addEventListener('click', function() {
        handleKeyPlayPlayerSelection(UNKNOWN_PLAYER, this);
    });
    playerButtonsContainer.appendChild(unknownButton);
    
    // Add player buttons for all active players
    if (currentPoint && currentPoint.players) {
        currentPoint.players.forEach(playerName => {
            const playerButton = document.createElement('button');
            playerButton.textContent = playerName;
            playerButton.classList.add('player-button', 'inactive');
            playerButton.addEventListener('click', function() {
                handleKeyPlayPlayerSelection(playerName, this);
            });
            playerButtonsContainer.appendChild(playerButton);
        });
    }
    
    // Add click handler to player header for toggling (only if not already added)
    const playerHeader = document.getElementById('keyPlayPlayerHeader');
    if (playerHeader && !playerHeader.hasAttribute('data-toggle-listener-added')) {
        playerHeader.addEventListener('click', function() {
            handleKeyPlayHeaderToggle();
        });
        playerHeader.setAttribute('data-toggle-listener-added', 'true');
    }
}

function handleKeyPlayPanelToggle(panelType, headerElement) {
    // Get the sub-buttons container for this panel
    const subButtonsContainer = headerElement.parentElement.querySelector('.key-play-sub-buttons');
    
    // Check if this panel is currently unfurled
    const isCurrentlyUnfurled = subButtonsContainer.style.height !== '0px';
    
    if (isCurrentlyUnfurled) {
        // Furl this panel
        furlPanel(subButtonsContainer);
    } else {
        // Furl all other panels first
        document.querySelectorAll('#keyPlayPanels .key-play-sub-buttons').forEach(container => {
            if (container !== subButtonsContainer) {
                furlPanel(container);
            }
        });
        
        // Unfurl this panel
        unfurlPanel(subButtonsContainer);
        
        // Update player column header and enable player buttons for this panel type
        updateKeyPlayPlayerHeader('', panelType);
        document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
            btn.classList.remove('inactive');
        });
    }
}

function furlPanel(container) {
    // Set height to 0 and opacity to 0 for smooth transition
    container.style.height = '0';
    container.style.opacity = '0';
}

function unfurlPanel(container) {
    // Temporarily set height to auto to measure content
    container.style.height = 'auto';
    const fullHeight = container.scrollHeight;
    
    // Set height to 0 first, then animate to full height
    container.style.height = '0';
    container.style.opacity = '0';
    
    // Use requestAnimationFrame to ensure the height: 0 is applied
    requestAnimationFrame(() => {
        container.style.height = fullHeight + 'px';
        container.style.opacity = '1';
    });
}

function handleKeyPlaySubButton(subButtonType, panelType, buttonElement) {
    // Special handling for turnover events
    if (panelType === 'turnover') {
        handleTurnoverSubButton(subButtonType, buttonElement);
        return;
    }
    
    // Special handling for defense events
    if (panelType === 'defense') {
        handleDefenseSubButton(subButtonType, buttonElement);
        return;
    }
    
    // Toggle selected state of the clicked button
    buttonElement.classList.toggle('selected');
    
    // Update selected sub-buttons array
    const buttonId = `${panelType}-${subButtonType}`;
    if (buttonElement.classList.contains('selected')) {
        if (!keyPlaySelectedSubButtons.includes(buttonId)) {
            keyPlaySelectedSubButtons.push(buttonId);
        }
    } else {
        keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== buttonId);
    }
    
    // Update player column header based on selected sub-button
    updateKeyPlayPlayerHeader(subButtonType, panelType);
    
    // Enable player buttons if any sub-button is selected
    const hasSelectedSubButton = keyPlaySelectedSubButtons.length > 0;
    document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
        if (hasSelectedSubButton) {
            btn.classList.remove('inactive');
        } else {
            btn.classList.add('inactive');
        }
    });
}

function handleTurnoverSubButton(subButtonType, buttonElement) {
    const buttonId = `turnover-${subButtonType}`;
    
    // Special case: "Good D" creates event immediately
    if (subButtonType === 'good D') {
        buttonElement.classList.toggle('selected');
        if (buttonElement.classList.contains('selected')) {
            keyPlaySelectedSubButtons.push(buttonId);
            createKeyPlayTurnoverEvent(getPlayerFromName("Unknown Player"));
        } else {
            keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== buttonId);
        }
        return;
    }
    
    // Toggle the clicked button
    buttonElement.classList.toggle('selected');
    const isNowSelected = buttonElement.classList.contains('selected');
    
    // Update the selected buttons array
    if (isNowSelected) {
        keyPlaySelectedSubButtons.push(buttonId);
    } else {
        keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== buttonId);
    }
    
    // Handle mutual exclusivity rules
    if (isNowSelected) {
        // Primary types are mutually exclusive
        const PrimaryTypes = ['throwaway', 'drop', 'stall'];
        if (PrimaryTypes.includes(subButtonType)) {
            const otherPrimaryTypes = PrimaryTypes.filter(type => type !== subButtonType);
            otherPrimaryTypes.forEach(type => {
                const otherButton = document.querySelector(`[data-sub-button-type="turnover-${type}"]`);
                if (otherButton && otherButton.classList.contains('selected')) {
                    otherButton.classList.remove('selected');
                    keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== `turnover-${type}`);
                }
            });
        }
        
        // Huck and Stall are mutually exclusive
        if (subButtonType === 'huck') {
            const stallButton = document.querySelector(`[data-sub-button-type="turnover-stall"]`);
            if (stallButton && stallButton.classList.contains('selected')) {
                stallButton.classList.remove('selected');
                keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== 'turnover-stall');
            }
        }
        
        if (subButtonType === 'stall') {
            const huckButton = document.querySelector(`[data-sub-button-type="turnover-huck"]`);
            if (huckButton && huckButton.classList.contains('selected')) {
                huckButton.classList.remove('selected');
                keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== 'turnover-huck');
            }
        }
    }
    
    // Update UI
    updateKeyPlayPlayerHeader(subButtonType, 'turnover');
    
    const hasSelectedSubButton = keyPlaySelectedSubButtons.length > 0;
    document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
        if (hasSelectedSubButton) {
            btn.classList.remove('inactive');
        } else {
            btn.classList.add('inactive');
        }
    });
}

function handleDefenseSubButton(subButtonType, buttonElement) {
    const buttonId = `defense-${subButtonType}`;
    
    // Special case: "Unforced error" creates event immediately
    if (subButtonType === 'unforced error') {
        buttonElement.classList.toggle('selected');
        if (buttonElement.classList.contains('selected')) {
            // Deselect "Stall" if it's selected (mutually exclusive)
            const stallButton = document.querySelector(`[data-sub-button-type="defense-stall"]`);
            if (stallButton && stallButton.classList.contains('selected')) {
                stallButton.classList.remove('selected');
                keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== 'defense-stall');
            }
            
            keyPlaySelectedSubButtons.push(buttonId);
            createKeyPlayDefenseEvent(null); // null defender for unforced error
        } else {
            keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== buttonId);
        }
        return;
    }
    
    // Toggle the clicked button
    buttonElement.classList.toggle('selected');
    const isNowSelected = buttonElement.classList.contains('selected');
    
    // Update the selected buttons array
    if (isNowSelected) {
        keyPlaySelectedSubButtons.push(buttonId);
    } else {
        keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== buttonId);
    }
    
    // Handle mutual exclusivity rules
    if (isNowSelected) {
        // "Stall" and "Unforced Error" are exclusive with everything
        if (subButtonType === 'stall' || subButtonType === 'unforced error') {
            const allOtherTypes = ['block', 'interception', 'Callahan', 'layout', 'sky'];
            if (subButtonType === 'stall') {
                allOtherTypes.push('unforced error');
            } else {
                allOtherTypes.push('stall');
            }
            
            allOtherTypes.forEach(type => {
                const otherButton = document.querySelector(`[data-sub-button-type="defense-${type}"]`);
                if (otherButton && otherButton.classList.contains('selected')) {
                    otherButton.classList.remove('selected');
                    keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== `defense-${type}`);
                }
            });
        }
        
        // "Block", "Interception", and "Callahan" are mutually exclusive
        if (subButtonType === 'block' || subButtonType === 'interception' || subButtonType === 'Callahan') {
            const otherActionTypes = ['block', 'interception', 'Callahan'].filter(type => type !== subButtonType);
            otherActionTypes.forEach(type => {
                const otherButton = document.querySelector(`[data-sub-button-type="defense-${type}"]`);
                if (otherButton && otherButton.classList.contains('selected')) {
                    otherButton.classList.remove('selected');
                    keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== `defense-${type}`);
                }
            });
            
            // Also deselect "Stall" and "Unforced Error" when selecting action types
            const incompatibleTypes = ['stall', 'unforced error'];
            incompatibleTypes.forEach(type => {
                const otherButton = document.querySelector(`[data-sub-button-type="defense-${type}"]`);
                if (otherButton && otherButton.classList.contains('selected')) {
                    otherButton.classList.remove('selected');
                    keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== `defense-${type}`);
                }
            });
        }
        
        // "Layout" and "Sky" are only compatible with "Block", "Interception", and "Callahan"
        if (subButtonType === 'layout' || subButtonType === 'sky') {
            const incompatibleTypes = ['stall', 'unforced error'];
            incompatibleTypes.forEach(type => {
                const otherButton = document.querySelector(`[data-sub-button-type="defense-${type}"]`);
                if (otherButton && otherButton.classList.contains('selected')) {
                    otherButton.classList.remove('selected');
                    keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== `defense-${type}`);
                }
            });
        }
        
        // If selecting "Stall" or "Unforced Error", deselect "Layout" and "Sky"
        if (subButtonType === 'stall' || subButtonType === 'unforced error') {
            const modifierTypes = ['layout', 'sky'];
            modifierTypes.forEach(type => {
                const otherButton = document.querySelector(`[data-sub-button-type="defense-${type}"]`);
                if (otherButton && otherButton.classList.contains('selected')) {
                    otherButton.classList.remove('selected');
                    keyPlaySelectedSubButtons = keyPlaySelectedSubButtons.filter(id => id !== `defense-${type}`);
                }
            });
        }
    }
    
    // Update UI
    updateKeyPlayPlayerHeader(subButtonType, 'defense');
    
    const hasSelectedSubButton = keyPlaySelectedSubButtons.length > 0;
    document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
        if (hasSelectedSubButton) {
            btn.classList.remove('inactive');
        } else {
            btn.classList.add('inactive');
        }
    });
}

function handleDefensePlayerSelection(playerName, buttonElement) {
    const player = getPlayerFromName(playerName);
    
    // Update button states
    document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
        btn.classList.remove('selected');
    });
    buttonElement.classList.add('selected');
    
    // Create the defense event
    createKeyPlayDefenseEvent(player);
}

function createKeyPlayDefenseEvent(player) {
    // Get selected defense sub-buttons to determine flags
    const defenseSubButtons = keyPlaySelectedSubButtons.filter(id => id.startsWith('defense-'));
    
    // Create defense event with appropriate flags
    const defenseEvent = new Defense({
        defender: player,
        interception: defenseSubButtons.includes('defense-interception'),
        layout: defenseSubButtons.includes('defense-layout'),
        sky: defenseSubButtons.includes('defense-sky'),
        Callahan: defenseSubButtons.includes('defense-Callahan'),
        stall: defenseSubButtons.includes('defense-stall'),
        unforcedError: defenseSubButtons.includes('defense-unforced error')
    });
    
    // Ensure we have a defensive possession to add the event to
    const currentPossession = ensurePossessionExists(false);
    
    // Add event to possession
    currentPossession.addEvent(defenseEvent);
    logEvent(defenseEvent.summarize());
    
    // Handle Callahan special case
    if (defenseSubButtons.includes('defense-Callahan')) {
        // Callahan scores a point and ends the current point
        // Award goal to the defender who caught the Callahan
        if (player) {
            player.goals++;
        } else {
            console.log("Warning: no defender selected for Callahan");
        }
        updateScore(Role.TEAM);
        moveToNextPoint();
    }
    
    // Close dialog
    document.getElementById('keyPlayDialog').style.display = 'none';
    
    console.log('Defense event created:', defenseEvent.summarize());
}

function handleKeyPlayPlayerSelection(playerName, buttonElement) {
    // Check which panel is currently unfurled (height > 0)
    const panels = document.querySelectorAll('#keyPlayPanels .key-play-sub-buttons');
    let unfurledPanel = null;
    let panelType = null;
    
    panels.forEach(panel => {
        if (panel.style.height && panel.style.height !== '0px' && panel.style.height !== '0') {
            unfurledPanel = panel;
            // Get panel type from the parent panel's data attribute
            const parentPanel = panel.closest('.key-play-panel');
            panelType = parentPanel ? parentPanel.dataset.panelType : null;
        }
    });
    
    if (unfurledPanel && panelType) {
        if (panelType === 'throw') {
            handleThrowPlayerSelection(playerName, buttonElement);
        } else if (panelType === 'turnover') {
            handleTurnoverPlayerSelection(playerName, buttonElement);
        } else if (panelType === 'defense') {
            handleDefensePlayerSelection(playerName, buttonElement);
        }
    }
}

function handleThrowPlayerSelection(playerName, buttonElement) {
    const player = getPlayerFromName(playerName);
    
    if (keyPlayCurrentRole === 'thrower') {
        // Selecting thrower
        if (keyPlaySelectedThrower && keyPlaySelectedThrower.name === playerName) {
            // Deselecting current thrower
            keyPlaySelectedThrower = null;
            buttonElement.classList.remove('selected');
            // Re-enable this player's button in receiver column
            document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
                    btn.disabled = false;
                    btn.classList.remove('inactive');
                }
            });
        } else {
            // Selecting new thrower
            keyPlaySelectedThrower = player;
            
            // Update button states
            document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
                btn.classList.remove('selected');
            });
            buttonElement.classList.add('selected');
            
            // Disable this player's button for receiver selection
            document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
                if (btn.textContent === playerName) {
                    btn.disabled = true;
                    btn.classList.add('inactive');
                }
            });
            
            // Switch to receiver selection
            keyPlayCurrentRole = 'receiver';
            updateKeyPlayPlayerHeader('', 'throw');
        }
    } else if (keyPlayCurrentRole === 'receiver') {
        // Selecting receiver
        if (keyPlaySelectedReceiver && keyPlaySelectedReceiver.name === playerName) {
            // Deselecting current receiver
            keyPlaySelectedReceiver = null;
            buttonElement.classList.remove('selected');
        } else {
            // Selecting new receiver
            keyPlaySelectedReceiver = player;
            
            // Update button states
            document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
                btn.classList.remove('selected');
            });
            buttonElement.classList.add('selected');
        }
    }
    
    // Check if both thrower and receiver are selected, then create the event
    if (keyPlaySelectedThrower && keyPlaySelectedReceiver) {
        createKeyPlayThrowEvent();
    }
}

function ensurePossessionExists(isOffensive) {
    let currentPossession = getActivePossession(currentPoint);
    
    if (!currentPossession) {
        // No possession exists, create a new one
        currentPossession = new Possession(isOffensive);
        currentPoint.addPossession(currentPossession);
        console.log(`Created new ${isOffensive ? 'offensive' : 'defensive'} possession for Key Play event`);
    } else if (currentPossession.offensive !== isOffensive) {
        // Current possession doesn't match the required type, create a new one
        const previousType = currentPossession.offensive ? 'offensive' : 'defensive';
        currentPossession = new Possession(isOffensive);
        currentPoint.addPossession(currentPossession);
        console.log(`Created new ${isOffensive ? 'offensive' : 'defensive'} possession (switched from ${previousType}) for Key Play event`);
    }
    
    return currentPossession;
}

function createKeyPlayThrowEvent() {
    // Validate that we have both thrower and receiver
    if (!keyPlaySelectedThrower || !keyPlaySelectedReceiver) {
        console.error('Cannot create throw event: missing thrower or receiver');
        return;
    }
    
    // Get selected throw sub-buttons to determine flags
    const throwSubButtons = keyPlaySelectedSubButtons.filter(id => id.startsWith('throw-'));
    
    // Create throw event with appropriate flags (basic throw if no sub-buttons selected)
    const throwEvent = new Throw({
        thrower: keyPlaySelectedThrower,
        receiver: keyPlaySelectedReceiver,
        huck: throwSubButtons.includes('throw-huck'),
        breakmark: throwSubButtons.includes('throw-break'),
        dump: throwSubButtons.includes('throw-dump'),
        hammer: throwSubButtons.includes('throw-hammer'),
        sky: throwSubButtons.includes('throw-sky'),
        layout: throwSubButtons.includes('throw-layout'),
        score: throwSubButtons.includes('throw-score')
    });
    
    // Ensure we have an offensive possession to add the event to
    const currentPossession = ensurePossessionExists(true);
    
    // Add event to possession
    currentPossession.addEvent(throwEvent);
    logEvent(throwEvent.summarize());
    
    // Update player stats
    keyPlaySelectedThrower.assists++;
    if (throwEvent.score_flag) {
        keyPlaySelectedReceiver.goals++;
        // Update score and move to next point for score events
        updateScore(Role.TEAM);
        moveToNextPoint();
    }
    
    // Close dialog
    document.getElementById('keyPlayDialog').style.display = 'none';
    
    console.log('Throw event created:', throwEvent.summarize());
}

function handleKeyPlayHeaderToggle() {
    // Check which panel is currently unfurled
    const panels = document.querySelectorAll('#keyPlayPanels .key-play-sub-buttons');
    let unfurledPanel = null;
    let panelType = null;
    
    panels.forEach(panel => {
        if (panel.style.height && panel.style.height !== '0px' && panel.style.height !== '0') {
            unfurledPanel = panel;
            const parentPanel = panel.closest('.key-play-panel');
            panelType = parentPanel ? parentPanel.dataset.panelType : null;
        }
    });
    
    // Only allow header toggling for throw events (multi-player selection)
    if (unfurledPanel && panelType === 'throw') {
        // Toggle between thrower and receiver selection
        if (keyPlayCurrentRole === 'thrower') {
            keyPlayCurrentRole = 'receiver';
        } else {
            keyPlayCurrentRole = 'thrower';
        }
        
        // Update header and button states
        updateKeyPlayPlayerHeader('', 'throw');
        updateKeyPlayPlayerButtonStates();
    }
}

function updateKeyPlayPlayerButtonStates() {
    // Clear all selections
    document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
        btn.classList.remove('selected');
        btn.disabled = false;
        btn.classList.remove('inactive');
    });
    
    // Re-apply current selections based on role
    if (keyPlayCurrentRole === 'thrower' && keyPlaySelectedThrower) {
        document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
            if (btn.textContent === keyPlaySelectedThrower.name) {
                btn.classList.add('selected');
            }
        });
    } else if (keyPlayCurrentRole === 'receiver' && keyPlaySelectedReceiver) {
        document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
            if (btn.textContent === keyPlaySelectedReceiver.name) {
                btn.classList.add('selected');
            }
        });
    }
    
    // Disable thrower's button when selecting receiver
    if (keyPlayCurrentRole === 'receiver' && keyPlaySelectedThrower) {
        document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
            if (btn.textContent === keyPlaySelectedThrower.name) {
                btn.disabled = true;
                btn.classList.add('inactive');
            }
        });
    }
}

function handleTurnoverPlayerSelection(playerName, buttonElement) {
    const player = getPlayerFromName(playerName);
    
    // For turnover events, just select the player and create the event immediately
    // Update button states
    document.querySelectorAll('#keyPlayPlayerButtons .player-button').forEach(btn => {
        btn.classList.remove('selected');
    });
    buttonElement.classList.add('selected');
    
    // Create the turnover event
    createKeyPlayTurnoverEvent(player);
}

function createKeyPlayTurnoverEvent(player) {
    // Get selected turnover sub-buttons to determine flags
    const turnoverSubButtons = keyPlaySelectedSubButtons.filter(id => id.startsWith('turnover-'));
    
    // Determine thrower and receiver based on turnover type
    let thrower, receiver;
    if (turnoverSubButtons.includes('turnover-drop')) {
        // For drops: selected player is the receiver who dropped it, thrower is unknown
        thrower = getPlayerFromName("Unknown Player");
        receiver = player;
    } else {
        // For other turnovers: selected player is the thrower, receiver is unknown
        thrower = player;
        receiver = getPlayerFromName("Unknown Player");
    }
    
    // Create turnover event with appropriate flags
    const turnoverEvent = new Turnover({
        thrower: thrower,
        receiver: receiver,
        throwaway: turnoverSubButtons.includes('turnover-throwaway'),
        huck: turnoverSubButtons.includes('turnover-huck'),
        receiverError: turnoverSubButtons.includes('turnover-drop'),
        goodDefense: turnoverSubButtons.includes('turnover-good D'),
        stall: turnoverSubButtons.includes('turnover-stall')
    });
    
    // Ensure we have an offensive possession to add the event to
    const currentPossession = ensurePossessionExists(true);
    
    // Add event to possession
    currentPossession.addEvent(turnoverEvent);
    logEvent(turnoverEvent.summarize());
    
    // Close dialog
    document.getElementById('keyPlayDialog').style.display = 'none';
    
    console.log('Turnover event created:', turnoverEvent.summarize());
    if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
}

function updateKeyPlayPlayerHeader(subButtonType, panelType) {
    const header = document.getElementById('keyPlayPlayerHeader');
    if (!header) return;
    
    if (panelType === 'throw') {
        if (keyPlayCurrentRole === 'thrower') {
            header.textContent = 'Thrower';
        } else {
            header.textContent = 'Receiver';
        }
    } else if (panelType === 'turnover') {
        header.textContent = 'Players';
    } else if (panelType === 'defense') {
        header.textContent = 'Defender';
    } else {
        header.textContent = 'Players';
    }
}

