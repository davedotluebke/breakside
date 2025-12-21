/*
 * Roster management helpers
 * Handles roster displays and roster-related UI interactions
 * 
 * Phase 4 update: Player IDs, cloud sync for player creation/updates
 */

function updateTeamRosterDisplay() {
    const teamRosterHeader = document.getElementById('teamRosterHeader');
    if (teamRosterHeader) {
        if (currentTeam && currentTeam.name) {
            teamRosterHeader.textContent = `Roster: ${currentTeam.name}`;
        } else {
            teamRosterHeader.textContent = 'Team Roster';
        }
    }
    
    // Initialize gender ratio dropdown when roster screen is displayed
    if (typeof initializeGenderRatioDropdown === 'function') {
        initializeGenderRatioDropdown();
    }

    const rosterElement = document.getElementById('rosterList');
    if (!rosterElement) {
        console.warn('Roster list element not found.');
        return;
    }
    rosterElement.innerHTML = '';

    const eventStats = currentGame() ? calculatePlayerStatsFromEvents(currentGame()) : {};

    const headerRow = document.createElement('tr');
    const headerClasses = ['roster-checkbox-header', 'roster-name-header', 'roster-points-header', 'roster-time-header', 'roster-goals-header', 'roster-assists-header', 'roster-comppct-header', 'roster-dplays-header', 'roster-turnovers-header', 'roster-plusminus-header', 'roster-plusminus-per-point-header'];
    ['', 'Name', 'Pts', 'Time', 'Goals', 'Assists', 'Comp%', 'Ds', 'TOs', '+/-', '..per pt'].forEach((headerText, index) => {
        const headerCell = document.createElement('th');
        headerCell.textContent = headerText;
        headerCell.classList.add('roster-header');
        if (headerClasses[index]) {
            headerCell.classList.add(headerClasses[index]);
        }
        headerRow.appendChild(headerCell);
    });
    rosterElement.appendChild(headerRow);

    currentTeam.teamRoster.forEach(player => {
        const playerRow = document.createElement('tr');

        const checkboxCell = document.createElement('td');
        checkboxCell.classList.add('active-checkbox-column', 'roster-sticky-checkbox');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('active-checkbox');
        checkboxCell.appendChild(checkbox);
        playerRow.appendChild(checkboxCell);

        const nameCell = document.createElement('td');
        nameCell.classList.add('roster-name-column', 'roster-sticky-name');
        nameCell.textContent = formatPlayerName(player);
        
        // Add gender-based color coding
        if (player.gender === Gender.FMP) {
            nameCell.classList.add('player-fmp');
        } else if (player.gender === Gender.MMP) {
            nameCell.classList.add('player-mmp');
        }
        
        // Make name cell clickable to edit player
        nameCell.addEventListener('click', () => {
            showEditPlayerDialog(player);
        });
        
        playerRow.appendChild(nameCell);

        const totalPointsCell = document.createElement('td');
        totalPointsCell.classList.add('roster-points-column');
        totalPointsCell.textContent = player.totalPointsPlayed;
        playerRow.appendChild(totalPointsCell);

        const totalTimeCell = document.createElement('td');
        totalTimeCell.classList.add('roster-time-column');
        totalTimeCell.textContent = formatPlayTime(player.totalTimePlayed);
        playerRow.appendChild(totalTimeCell);

        const goalsCell = document.createElement('td');
        goalsCell.classList.add('roster-goals-column');
        goalsCell.textContent = player.goals || 0;
        playerRow.appendChild(goalsCell);

        const assistsCell = document.createElement('td');
        assistsCell.classList.add('roster-assists-column');
        assistsCell.textContent = player.assists || 0;
        playerRow.appendChild(assistsCell);

        const playerStats = eventStats[player.name] || {};

        const compPctCell = document.createElement('td');
        compPctCell.classList.add('roster-comppct-column');
        const compPct = playerStats.totalThrows > 0
            ? ((playerStats.completions / playerStats.totalThrows) * 100).toFixed(0)
            : '-';
        compPctCell.textContent = compPct !== '-' ? `${compPct}%` : compPct;
        playerRow.appendChild(compPctCell);

        const dPlaysCell = document.createElement('td');
        dPlaysCell.classList.add('roster-dplays-column');
        dPlaysCell.textContent = playerStats.dPlays || 0;
        playerRow.appendChild(dPlaysCell);

        const turnoversCell = document.createElement('td');
        turnoversCell.classList.add('roster-turnovers-column');
        turnoversCell.textContent = playerStats.turnovers || 0;
        playerRow.appendChild(turnoversCell);

        const plusMinusCell = document.createElement('td');
        plusMinusCell.classList.add('roster-plusminus-column');
        const plusMinus = (player.pointsWon || 0) - (player.pointsLost || 0);
        plusMinusCell.textContent = plusMinus > 0 ? `+${plusMinus}` : plusMinus;
        playerRow.appendChild(plusMinusCell);

        const plusMinusPerPointCell = document.createElement('td');
        plusMinusPerPointCell.classList.add('roster-plusminus-per-point-column');
        const plusMinusPerPoint = player.totalPointsPlayed > 0
            ? (plusMinus / player.totalPointsPlayed).toFixed(2)
            : '0.0';
        plusMinusPerPointCell.textContent = plusMinusPerPoint > 0 ? `+${plusMinusPerPoint}` : plusMinusPerPoint;
        playerRow.appendChild(plusMinusPerPointCell);

        rosterElement.appendChild(playerRow);
    });

    // Make sticky columns work after all rows are added
    // Use requestAnimationFrame to ensure DOM is fully rendered before calculating widths
    requestAnimationFrame(() => {
        makeRosterColumnsSticky();
    });

    const teamRow = document.createElement('tr');
    teamRow.classList.add('team-aggregate-row');

    let totalGoals = 0;
    let totalAssists = 0;
    let totalCompletions = 0;
    let totalThrows = 0;
    let totalHuckCompletions = 0;
    let totalHucks = 0;
    let totalDPlays = 0;
    let totalTurnovers = 0;
    let totalTimePlayed = 0;

    currentTeam.teamRoster.forEach(player => {
        totalGoals += player.goals || 0;
        totalAssists += player.assists || 0;
        totalTimePlayed += player.totalTimePlayed || 0;

        const playerStats = eventStats[player.name] || {};
        totalCompletions += playerStats.completions || 0;
        totalThrows += playerStats.totalThrows || 0;
        totalHuckCompletions += playerStats.huckCompletions || 0;
        totalHucks += playerStats.totalHucks || 0;
        totalDPlays += playerStats.dPlays || 0;
        totalTurnovers += playerStats.turnovers || 0;
    });

    const appendTeamCell = (value, className, isSticky = false) => {
        const cell = document.createElement('td');
        cell.classList.add(className, 'team-total-cell');
        if (isSticky) {
            if (className === 'active-checkbox-column') {
                cell.classList.add('roster-sticky-checkbox');
            } else if (className === 'roster-name-column') {
                cell.classList.add('roster-sticky-name');
            }
        }
        cell.textContent = value;
        teamRow.appendChild(cell);
    };

    // First cell is empty (checkbox column) - make it sticky
    appendTeamCell('', 'active-checkbox-column', true);
    // Second cell is "Team" (name column) - make it sticky
    appendTeamCell('Team', 'roster-name-column', true);
    appendTeamCell(currentGame() ? currentGame().points.length : 0, 'roster-points-column');
    appendTeamCell(formatPlayTime(totalTimePlayed), 'roster-time-column');
    appendTeamCell(totalGoals, 'roster-goals-column');
    appendTeamCell(totalAssists, 'roster-assists-column');

    const teamCompPct = totalThrows > 0 ? ((totalCompletions / totalThrows) * 100).toFixed(0) : '-';
    appendTeamCell(teamCompPct !== '-' ? `${teamCompPct}%` : teamCompPct, 'roster-comppct-column');

    const teamHuckPct = totalHucks > 0 ? ((totalHuckCompletions / totalHucks) * 100).toFixed(0) : '-';
    appendTeamCell(teamHuckPct !== '-' ? `${teamHuckPct}%` : teamHuckPct, 'roster-huckpct-column');

    appendTeamCell(totalDPlays, 'roster-dplays-column');
    appendTeamCell(totalTurnovers, 'roster-turnovers-column');

    const teamScore = currentGame() ? currentGame().scores[Role.TEAM] : 0;
    const opponentScore = currentGame() ? currentGame().scores[Role.OPPONENT] : 0;
    const teamPlusMinus = teamScore - opponentScore;
    appendTeamCell(teamPlusMinus > 0 ? `+${teamPlusMinus}` : teamPlusMinus, 'roster-plusminus-column');

    const totalPoints = currentGame() ? currentGame().points.length : 0;
    const teamPlusMinusPerPoint = totalPoints > 0 ? (teamPlusMinus / totalPoints).toFixed(2) : '0.0';
    appendTeamCell(teamPlusMinusPerPoint > 0 ? `+${teamPlusMinusPerPoint}` : teamPlusMinusPerPoint, 'roster-plusminus-per-point-column');

    rosterElement.appendChild(teamRow);
    
    // Re-run sticky columns function to include team row
    requestAnimationFrame(() => {
        makeRosterColumnsSticky();
    });
}

function updateGameSummaryRosterDisplay() {
    const rosterElement = document.getElementById('gameSummaryRosterList');
    if (!rosterElement) {
        console.warn('Game summary roster list not found.');
        return;
    }
    rosterElement.innerHTML = '';

    const eventStats = currentGame() ? calculatePlayerStatsFromEvents(currentGame()) : {};
    
    // Phase 4: Use rosterSnapshot if available for historical accuracy
    const game = currentGame();
    let playersToDisplay = currentTeam.teamRoster;
    
    if (game && game.rosterSnapshot && game.rosterSnapshot.players) {
        // Use snapshot players but merge with current roster for full Player objects
        // This preserves historical data (names/numbers at game time)
        playersToDisplay = game.rosterSnapshot.players.map(snapshotPlayer => {
            // Find the current player by ID to get accumulated stats
            const currentPlayer = currentTeam.teamRoster.find(p => p.id === snapshotPlayer.id);
            return currentPlayer || snapshotPlayer;
        });
        console.log('📸 Using roster snapshot for game summary display');
    }

    const headerRow = document.createElement('tr');
    ['Name', 'Pts', 'Time', 'Goals', 'Assists', 'Comp%', 'Huck%', 'Ds', 'TOs', '+/-', '..per pt'].forEach(headerText => {
        const headerCell = document.createElement('th');
        headerCell.textContent = headerText;
        headerCell.classList.add('roster-header');
        headerRow.appendChild(headerCell);
    });
    rosterElement.appendChild(headerRow);

    playersToDisplay.forEach(player => {
        const playerRow = document.createElement('tr');

        const nameCell = document.createElement('td');
        nameCell.classList.add('roster-name-column');
        nameCell.textContent = formatPlayerName(player);
        
        // Add gender-based color coding
        if (player.gender === Gender.FMP) {
            nameCell.classList.add('player-fmp');
        } else if (player.gender === Gender.MMP) {
            nameCell.classList.add('player-mmp');
        }
        
        playerRow.appendChild(nameCell);

        const totalPointsCell = document.createElement('td');
        totalPointsCell.classList.add('roster-points-column');
        totalPointsCell.textContent = player.totalPointsPlayed;
        playerRow.appendChild(totalPointsCell);

        const totalTimeCell = document.createElement('td');
        totalTimeCell.classList.add('roster-time-column');
        totalTimeCell.textContent = formatPlayTime(player.totalTimePlayed);
        playerRow.appendChild(totalTimeCell);

        const goalsCell = document.createElement('td');
        goalsCell.classList.add('roster-goals-column');
        goalsCell.textContent = player.goals || 0;
        playerRow.appendChild(goalsCell);

        const assistsCell = document.createElement('td');
        assistsCell.classList.add('roster-assists-column');
        assistsCell.textContent = player.assists || 0;
        playerRow.appendChild(assistsCell);

        const playerStats = eventStats[player.name] || {};

        const compPctCell = document.createElement('td');
        compPctCell.classList.add('roster-comppct-column');
        const compPct = playerStats.totalThrows > 0
            ? ((playerStats.completions / playerStats.totalThrows) * 100).toFixed(0)
            : '-';
        compPctCell.textContent = compPct !== '-' ? `${compPct}%` : compPct;
        playerRow.appendChild(compPctCell);

        const huckPctCell = document.createElement('td');
        huckPctCell.classList.add('roster-huckpct-column');
        const huckPct = playerStats.totalHucks > 0
            ? ((playerStats.huckCompletions / playerStats.totalHucks) * 100).toFixed(0)
            : '-';
        huckPctCell.textContent = huckPct !== '-' ? `${huckPct}%` : huckPct;
        playerRow.appendChild(huckPctCell);

        const dPlaysCell = document.createElement('td');
        dPlaysCell.classList.add('roster-dplays-column');
        dPlaysCell.textContent = playerStats.dPlays || 0;
        playerRow.appendChild(dPlaysCell);

        const turnoversCell = document.createElement('td');
        turnoversCell.classList.add('roster-turnovers-column');
        turnoversCell.textContent = playerStats.turnovers || 0;
        playerRow.appendChild(turnoversCell);

        const plusMinusCell = document.createElement('td');
        plusMinusCell.classList.add('roster-plusminus-column');
        const plusMinus = (player.pointsWon || 0) - (player.pointsLost || 0);
        plusMinusCell.textContent = plusMinus > 0 ? `+${plusMinus}` : plusMinus;
        playerRow.appendChild(plusMinusCell);

        const plusMinusPerPointCell = document.createElement('td');
        plusMinusPerPointCell.classList.add('roster-plusminus-per-point-column');
        const plusMinusPerPoint = player.totalPointsPlayed > 0
            ? (plusMinus / player.totalPointsPlayed).toFixed(2)
            : '0.0';
        plusMinusPerPointCell.textContent = plusMinusPerPoint > 0 ? `+${plusMinusPerPoint}` : plusMinusPerPoint;
        playerRow.appendChild(plusMinusPerPointCell);

        rosterElement.appendChild(playerRow);
    });
}

/**
 * Validate jersey number input
 * Returns the validated value (string or null), or null if user cancels invalid input
 * Accepts: null/empty, "00", or integers 0-99
 * Shows confirmation alert for invalid values like "pi", "ASDF", "1e23"
 */
function validateJerseyNumber(input) {
    const trimmed = input ? input.trim() : '';
    
    // Empty is valid (no jersey number)
    if (!trimmed) {
        return null;
    }
    
    // Special case: "00" is valid
    if (trimmed === '00') {
        return '00';
    }
    
    // Try to parse as integer
    const parsed = parseInt(trimmed, 10);
    
    // Check if it's a valid integer between 0 and 99
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 99 && parsed.toString() === trimmed) {
        return trimmed;
    }
    
    // Invalid value - ask for confirmation
    const confirmed = confirm(
        `"${trimmed}" is not a valid jersey number (must be 0-99 or 00).\n\n` +
        `Do you want to use "${trimmed}" anyway?`
    );
    
    return confirmed ? trimmed : null;
}

(function setupRosterUI() {
    function addPlayerWithGender(gender) {
        const playerNameInput = document.getElementById('newPlayerInput');
        const playerNumberInput = document.getElementById('newPlayerNumberInput');
        const playerName = playerNameInput ? playerNameInput.value.trim() : '';
        const playerNumber = playerNumberInput ? (playerNumberInput.value.trim() || null) : null;
        
        if (playerName && !currentTeam.teamRoster.some(player => player.name === playerName)) {
            const numberValue = validateJerseyNumber(playerNumber);
            // If validation was cancelled (returned null when input was provided), don't add player
            if (playerNumber && numberValue === null) {
                return;
            }
            
            // Phase 4: Create player with ID and queue for cloud sync
            const newPlayer = new Player(playerName, "", gender, numberValue);
            currentTeam.teamRoster.push(newPlayer);
            
            // Add player ID to team's playerIds array
            if (!currentTeam.playerIds) {
                currentTeam.playerIds = [];
            }
            if (!currentTeam.playerIds.includes(newPlayer.id)) {
                currentTeam.playerIds.push(newPlayer.id);
            }
            
            // Queue player for cloud sync
            if (typeof createPlayerOffline === 'function') {
                createPlayerOffline({
                    id: newPlayer.id,
                    name: newPlayer.name,
                    nickname: newPlayer.nickname,
                    gender: newPlayer.gender,
                    number: newPlayer.number,
                    createdAt: newPlayer.createdAt,
                    updatedAt: newPlayer.updatedAt
                });
            }
            
            // Update team on cloud
            if (typeof syncTeamToCloud === 'function' && currentTeam.id) {
                syncTeamToCloud(currentTeam);
            }
            
            updateTeamRosterDisplay();
            
            // Save locally
            if (typeof saveAllTeamsData === 'function') {
                saveAllTeamsData();
            }
        }
        if (playerNameInput) {
            playerNameInput.value = '';
        }
        if (playerNumberInput) {
            playerNumberInput.value = '';
        }
    }
    
    const addFMPPlayerBtn = document.getElementById('addFMPPlayerBtn');
    if (addFMPPlayerBtn) {
        addFMPPlayerBtn.addEventListener('click', () => {
            addPlayerWithGender(Gender.FMP);
        });
    }

    const addMMPPlayerBtn = document.getElementById('addMMPPlayerBtn');
    if (addMMPPlayerBtn) {
        addMMPPlayerBtn.addEventListener('click', () => {
            addPlayerWithGender(Gender.MMP);
        });
    }

    const playerNameInput = document.getElementById('newPlayerInput');
    if (playerNameInput) {
        playerNameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                // Default to FMP if Enter is pressed (user can change later if needed)
                const addFMPPlayerBtn = document.getElementById('addFMPPlayerBtn');
                if (addFMPPlayerBtn) {
                    addFMPPlayerBtn.click();
                }
            }
        });
    }

    const adjustRosterBtn = document.getElementById('adjustRosterBtn');
    if (adjustRosterBtn) {
        adjustRosterBtn.addEventListener('click', () => {
            updateTeamRosterDisplay();
            showScreen('teamRosterScreen');
            const continueGameBtn = document.getElementById('continueGameBtn');
            if (continueGameBtn) {
                continueGameBtn.classList.remove('inactive');
            }
        });
    }

    const continueGameBtn = document.getElementById('continueGameBtn');
    if (continueGameBtn) {
        continueGameBtn.addEventListener('click', () => {
            if (currentTeam.games.length > 0) {
                if (isPointInProgress() === false) {
                    if (typeof updateActivePlayersList === 'function') {
                        updateActivePlayersList();
                    }
                    showScreen('beforePointScreen');
                } else {
                    const latestPossession = getLatestPossession();
                    if (latestPossession && latestPossession.offensive) {
                        updateOffensivePossessionScreen();
                        showScreen('offensePlayByPlayScreen');
                    } else {
                        updateDefensivePossessionScreen();
                        showScreen('defensePlayByPlayScreen');
                    }
                    continueGameBtn.classList.add('inactive');
                }
            }
        });
    }

    // Line management functions
    const addLineButton = document.querySelector('.add-line-button');
    if (addLineButton) {
        addLineButton.addEventListener('click', addNewLine);
    }

    const deleteLineButton = document.querySelector('.delete-line-button');
    if (deleteLineButton && !deleteLineButton.classList.contains('delete')) {
        deleteLineButton.addEventListener('click', showDeleteLineDialog);
    }
})();

/**
 * Function to add a new line
 */
function addNewLine() {
    const lineNameInput = document.querySelector('.line-name-input');
    const lineName = lineNameInput ? lineNameInput.value.trim() : '';
    
    if (!lineName) {
        alert('Please enter a line name');
        return;
    }
    
    // Get selected players
    const selectedPlayers = Array.from(document.querySelectorAll('.active-checkbox:checked'))
        .map(checkbox => {
            const row = checkbox.closest('tr');
            const displayText = row ? row.querySelector('.roster-name-column').textContent : null;
            return displayText ? extractPlayerName(displayText) : null;
        })
        .filter(name => name !== null);
    
    if (selectedPlayers.length === 0) {
        alert('Please select at least one player for the line');
        return;
    }
    
    // Add the new line
    currentTeam.lines.push({
        name: lineName,
        players: selectedPlayers,
        lastUsed: null
    });
    
    // Clear input and save changes
    if (lineNameInput) {
        lineNameInput.value = '';
    }
    saveAllTeamsData();
    updateTeamRosterDisplay();
}

/**
 * Function to show delete line dialog
 */
function showDeleteLineDialog() {
    if (!currentTeam.lines || currentTeam.lines.length === 0) {
        alert('No lines to delete');
        return;
    }
    
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.classList.add('delete-line-overlay');
    
    // Create dialog container
    const dialog = document.createElement('div');
    dialog.classList.add('delete-line-dialog');
    
    const title = document.createElement('h3');
    title.textContent = 'Select Line to Delete';
    dialog.appendChild(title);
    
    // Create container for radio buttons
    const radioContainer = document.createElement('div');
    radioContainer.classList.add('delete-line-radio-container');
    
    currentTeam.lines.forEach((line, index) => {
        const radioDiv = document.createElement('div');
        radioDiv.classList.add('delete-line-radio-option');
        
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'lineToDelete';
        radio.value = index;
        radio.id = `line-${index}`;
        
        const label = document.createElement('label');
        label.htmlFor = `line-${index}`;
        
        const lineName = document.createElement('span');
        lineName.classList.add('line-name');
        lineName.textContent = line.name;
        
        const linePlayers = document.createElement('span');
        linePlayers.classList.add('line-players');
        linePlayers.textContent = line.players.join(', ');
        
        label.appendChild(lineName);
        label.appendChild(linePlayers);
        
        radioDiv.appendChild(radio);
        radioDiv.appendChild(label);
        radioContainer.appendChild(radioDiv);
    });
    
    dialog.appendChild(radioContainer);
    
    const buttonDiv = document.createElement('div');
    buttonDiv.classList.add('delete-line-buttons');
    
    const confirmButton = document.createElement('button');
    confirmButton.textContent = 'Delete';
    confirmButton.classList.add('delete-line-button', 'delete');
    confirmButton.disabled = true; // Initially disabled
    
    // Add event listener to radio buttons to enable/disable delete button
    const radioButtons = dialog.querySelectorAll('input[type="radio"]');
    radioButtons.forEach(radio => {
        radio.addEventListener('change', () => {
            confirmButton.disabled = false;
        });
    });
    
    confirmButton.addEventListener('click', () => {
        const selectedRadio = dialog.querySelector('input[name="lineToDelete"]:checked');
        if (selectedRadio) {
            const index = parseInt(selectedRadio.value);
            currentTeam.lines.splice(index, 1);
            saveAllTeamsData();
            updateTeamRosterDisplay();
        }
        document.body.removeChild(overlay);
    });
    
    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    cancelButton.classList.add('delete-line-button', 'cancel');
    cancelButton.addEventListener('click', () => {
        document.body.removeChild(overlay);
    });
    
    buttonDiv.appendChild(cancelButton);
    buttonDiv.appendChild(confirmButton);
    dialog.appendChild(buttonDiv);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// Edit Player Dialog state
let editPlayerDialogPlayer = null;
let editPlayerDialogOriginalData = null;

/**
 * Show the edit player dialog for a given player
 */
function showEditPlayerDialog(player) {
    if (!player) {
        console.error('Cannot show edit player dialog: no player provided');
        return;
    }

    editPlayerDialogPlayer = player;
    // Store original values to detect changes
    editPlayerDialogOriginalData = {
        name: player.name,
        number: player.number,
        gender: player.gender
    };

    const dialog = document.getElementById('editPlayerDialog');
    if (!dialog) {
        console.error('Edit player dialog element not found');
        return;
    }

    // Populate form fields with current player data
    const nameInput = document.getElementById('editPlayerName');
    const numberInput = document.getElementById('editPlayerNumber');
    const fmpBtn = document.getElementById('editPlayerFMPBtn');
    const mmpBtn = document.getElementById('editPlayerMMPBtn');
    const confirmBtn = document.getElementById('editPlayerConfirmBtn');

    if (nameInput) nameInput.value = player.name;
    if (numberInput) numberInput.value = player.number || '';
    
    // Phase 4: Show player ID for debugging
    let playerIdDisplay = document.getElementById('editPlayerIdDisplay');
    if (!playerIdDisplay) {
        // Create the ID display element if it doesn't exist
        const container = dialog.querySelector('.edit-player-container');
        if (container) {
            const idField = document.createElement('div');
            idField.className = 'edit-player-field edit-player-id-field';
            idField.innerHTML = `
                <label>Player ID:</label>
                <code id="editPlayerIdDisplay" class="player-id-code">${player.id || 'No ID'}</code>
            `;
            container.insertBefore(idField, container.firstChild);
            playerIdDisplay = document.getElementById('editPlayerIdDisplay');
        }
    } else {
        playerIdDisplay.textContent = player.id || 'No ID';
    }
    
    // Set gender button states
    if (fmpBtn && mmpBtn) {
        fmpBtn.classList.remove('selected');
        mmpBtn.classList.remove('selected');
        if (player.gender === Gender.FMP) {
            fmpBtn.classList.add('selected');
        } else if (player.gender === Gender.MMP) {
            mmpBtn.classList.add('selected');
        }
    }

    // Reset confirm button state
    if (confirmBtn) {
        confirmBtn.disabled = true;
    }

    // Show dialog
    dialog.style.display = 'block';
}

/**
 * Close the edit player dialog
 */
function closeEditPlayerDialog() {
    const dialog = document.getElementById('editPlayerDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
    editPlayerDialogPlayer = null;
    editPlayerDialogOriginalData = null;
}

/**
 * Check if any changes have been made and update confirm button state
 */
function updateEditPlayerDialogState() {
    if (!editPlayerDialogPlayer || !editPlayerDialogOriginalData) {
        return;
    }

    const nameInput = document.getElementById('editPlayerName');
    const numberInput = document.getElementById('editPlayerNumber');
    const fmpBtn = document.getElementById('editPlayerFMPBtn');
    const mmpBtn = document.getElementById('editPlayerMMPBtn');
    const confirmBtn = document.getElementById('editPlayerConfirmBtn');

    if (!nameInput || !confirmBtn) {
        return;
    }

    // Get current form values
    const currentName = nameInput.value.trim();
    const currentNumber = numberInput.value.trim();
    const currentNumberValue = currentNumber || null;
    
    // Determine current gender selection
    let currentGender = Gender.UNKNOWN;
    if (fmpBtn && fmpBtn.classList.contains('selected')) {
        currentGender = Gender.FMP;
    } else if (mmpBtn && mmpBtn.classList.contains('selected')) {
        currentGender = Gender.MMP;
    }

    // Check if any changes were made
    const nameChanged = currentName !== editPlayerDialogOriginalData.name;
    const numberChanged = currentNumberValue !== editPlayerDialogOriginalData.number;
    const genderChanged = currentGender !== editPlayerDialogOriginalData.gender;

    // Enable confirm button if changes were made and name is not empty
    confirmBtn.disabled = !(nameChanged || numberChanged || genderChanged) || currentName === '';
}

/**
 * Delete the current player with confirmation
 */
function deletePlayer() {
    if (!editPlayerDialogPlayer) {
        console.error('Cannot delete player: no player selected');
        return;
    }

    const playerName = editPlayerDialogPlayer.name;
    
    // Show confirmation alert
    if (!confirm(`Are you sure you want to delete ${playerName}?`)) {
        return; // User cancelled
    }

    // Get player ID before removing
    const playerId = editPlayerDialogPlayer.id;
    
    // Remove player from roster
    const index = currentTeam.teamRoster.indexOf(editPlayerDialogPlayer);
    if (index > -1) {
        currentTeam.teamRoster.splice(index, 1);
    }
    
    // Remove player ID from team's playerIds array
    if (currentTeam.playerIds && playerId) {
        const idIndex = currentTeam.playerIds.indexOf(playerId);
        if (idIndex > -1) {
            currentTeam.playerIds.splice(idIndex, 1);
        }
    }
    
    // Phase 4: Sync team update to cloud (player removed from team)
    // Note: We don't delete the player entity itself - they may be on other teams
    if (typeof syncTeamToCloud === 'function' && currentTeam.id) {
        syncTeamToCloud(currentTeam);
    }

    // Save changes
    saveAllTeamsData();
    
    // Refresh roster display
    updateTeamRosterDisplay();

    // Close dialog
    closeEditPlayerDialog();
}

/**
 * Save the edited player data
 */
function saveEditedPlayer() {
    if (!editPlayerDialogPlayer || !editPlayerDialogOriginalData) {
        console.error('Cannot save edited player: no player or original data');
        return;
    }

    const nameInput = document.getElementById('editPlayerName');
    const numberInput = document.getElementById('editPlayerNumber');
    const fmpBtn = document.getElementById('editPlayerFMPBtn');
    const mmpBtn = document.getElementById('editPlayerMMPBtn');

    if (!nameInput) {
        console.error('Cannot save edited player: name input not found');
        return;
    }

    const newName = nameInput.value.trim();
    if (!newName) {
        alert('Player name cannot be empty');
        return;
    }

    // Check if name already exists (excluding current player)
    const nameExists = currentTeam.teamRoster.some(p => 
        p !== editPlayerDialogPlayer && p.name === newName
    );
    if (nameExists) {
        alert('A player with this name already exists');
        return;
    }

    // Get new values
    const newNumber = numberInput.value.trim();
    const newNumberValue = validateJerseyNumber(newNumber);
    
    // If validation was cancelled (returned null when input was provided), don't save
    if (newNumber && newNumberValue === null) {
        return;
    }
    
    // Determine new gender
    let newGender = Gender.UNKNOWN;
    if (fmpBtn && fmpBtn.classList.contains('selected')) {
        newGender = Gender.FMP;
    } else if (mmpBtn && mmpBtn.classList.contains('selected')) {
        newGender = Gender.MMP;
    }

    // Update player object
    editPlayerDialogPlayer.name = newName;
    editPlayerDialogPlayer.number = newNumberValue;
    editPlayerDialogPlayer.gender = newGender;
    editPlayerDialogPlayer.updatedAt = new Date().toISOString();

    // Phase 4: Sync player update to cloud
    if (typeof syncPlayerToCloud === 'function') {
        syncPlayerToCloud(editPlayerDialogPlayer);
    }

    // Save changes
    saveAllTeamsData();
    
    // Refresh roster display
    updateTeamRosterDisplay();

    // Close dialog
    closeEditPlayerDialog();
}

// Initialize edit player dialog event handlers
(function initializeEditPlayerDialog() {
    const dialog = document.getElementById('editPlayerDialog');
    if (!dialog) {
        console.warn('Edit player dialog not found, skipping initialization');
        return;
    }

    // Close button
    const closeBtn = dialog.querySelector('.close');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeEditPlayerDialog);
    }

    // Close when clicking outside dialog
    window.addEventListener('click', function(event) {
        if (event.target === dialog) {
            closeEditPlayerDialog();
        }
    });

    // Cancel button
    const cancelBtn = document.getElementById('editPlayerCancelBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeEditPlayerDialog);
    }

    // Confirm button
    const confirmBtn = document.getElementById('editPlayerConfirmBtn');
    if (confirmBtn) {
        confirmBtn.addEventListener('click', saveEditedPlayer);
    }

    // Delete button
    const deleteBtn = document.getElementById('editPlayerDeleteBtn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', deletePlayer);
    }

    // Gender buttons
    const fmpBtn = document.getElementById('editPlayerFMPBtn');
    const mmpBtn = document.getElementById('editPlayerMMPBtn');
    
    if (fmpBtn) {
        fmpBtn.addEventListener('click', function() {
            // Toggle selection
            if (this.classList.contains('selected')) {
                this.classList.remove('selected');
            } else {
                this.classList.add('selected');
                if (mmpBtn) mmpBtn.classList.remove('selected');
            }
            updateEditPlayerDialogState();
        });
    }

    if (mmpBtn) {
        mmpBtn.addEventListener('click', function() {
            // Toggle selection
            if (this.classList.contains('selected')) {
                this.classList.remove('selected');
            } else {
                this.classList.add('selected');
                if (fmpBtn) fmpBtn.classList.remove('selected');
            }
            updateEditPlayerDialogState();
        });
    }

    // Input fields - track changes
    const nameInput = document.getElementById('editPlayerName');
    const numberInput = document.getElementById('editPlayerNumber');
    
    if (nameInput) {
        nameInput.addEventListener('input', updateEditPlayerDialogState);
        nameInput.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !confirmBtn.disabled) {
                saveEditedPlayer();
            }
        });
    }
    
    if (numberInput) {
        numberInput.addEventListener('input', updateEditPlayerDialogState);
    }
})();

/**
 * Make the first two columns (checkbox, name) sticky for horizontal scrolling
 */
function makeRosterColumnsSticky() {
    const checkboxCells = document.querySelectorAll('.roster-sticky-checkbox');
    if (checkboxCells.length === 0) {
        return;
    }
    
    // Get checkbox column width - use getBoundingClientRect which includes padding and border
    // Use the first data cell (not header) for accurate measurement
    const firstCheckboxCell = checkboxCells[0];
    const checkboxRect = firstCheckboxCell.getBoundingClientRect();
    let checkboxCellWidth = checkboxRect.width;
    
    // If width is 0 or invalid, try to get computed style width
    if (checkboxCellWidth <= 0) {
        const computedStyle = window.getComputedStyle(firstCheckboxCell);
        checkboxCellWidth = parseFloat(computedStyle.width) || 30; // fallback to 30px
    }
    
    // Ensure checkbox column has consistent width and positioning
    checkboxCells.forEach(cell => {
        cell.style.position = 'sticky';
        cell.style.left = '0';
        cell.style.zIndex = '4';
        cell.style.backgroundColor = '#fafafa';
        // Force consistent width
        cell.style.width = `${checkboxCellWidth}px`;
        cell.style.minWidth = `${checkboxCellWidth}px`;
        cell.style.maxWidth = `${checkboxCellWidth}px`;
        cell.style.boxSizing = 'border-box';
        // Use box-shadow to create borders that stay with sticky column
        // Format: x-offset y-offset blur spread color
        // Right border (2px), left border (1px), bottom border (1px)
        cell.style.boxShadow = 'inset -2px 0 0 0 #888, inset 1px 0 0 0 grey, inset 0 -1px 0 0 grey';
        // Remove all CSS borders that would scroll
        cell.style.borderLeft = 'none';
        cell.style.borderRight = 'none';
        cell.style.borderTop = 'none';
        cell.style.borderBottom = 'none';
    });
    
    // Get name column cells
    const nameCells = document.querySelectorAll('.roster-sticky-name');
    
    // Apply sticky positioning to name column (positioned right after checkbox)
    // Use the exact checkbox width to prevent overlap
    nameCells.forEach(cell => {
        cell.style.position = 'sticky';
        cell.style.left = `${checkboxCellWidth}px`;
        cell.style.zIndex = '3';
        cell.style.backgroundColor = '#fafafa';
        // Use box-shadow to create borders that stay with sticky column
        cell.style.boxShadow = 'inset -2px 0 0 0 #888, inset 0 -1px 0 0 grey';
        // Remove all borders that would scroll
        cell.style.borderLeft = 'none';
        cell.style.borderRight = 'none';
        cell.style.borderTop = 'none';
        cell.style.borderBottom = 'none';
    });
    
    // Also make header cells sticky
    const headerCheckbox = document.querySelector('.roster-checkbox-header');
    if (headerCheckbox) {
        headerCheckbox.style.position = 'sticky';
        headerCheckbox.style.left = '0';
        headerCheckbox.style.zIndex = '5';
        headerCheckbox.style.backgroundColor = '#fafafa';
        // Ensure header checkbox has same width as data cells
        headerCheckbox.style.width = `${checkboxCellWidth}px`;
        headerCheckbox.style.minWidth = `${checkboxCellWidth}px`;
        headerCheckbox.style.maxWidth = `${checkboxCellWidth}px`;
        headerCheckbox.style.boxSizing = 'border-box';
        // Use box-shadow to create borders that stay with sticky column
        // Right border (2px), left border (1px), bottom border (1px)
        headerCheckbox.style.boxShadow = 'inset -2px 0 0 0 #888, inset 1px 0 0 0 grey, inset 0 -1px 0 0 grey';
        // Remove all CSS borders that would scroll
        headerCheckbox.style.borderLeft = 'none';
        headerCheckbox.style.borderRight = 'none';
        headerCheckbox.style.borderTop = 'none';
        headerCheckbox.style.borderBottom = 'none';
    }
    
    const headerName = document.querySelector('.roster-name-header');
    if (headerName) {
        headerName.style.position = 'sticky';
        headerName.style.left = `${checkboxCellWidth}px`;
        headerName.style.zIndex = '4';
        headerName.style.backgroundColor = '#fafafa';
        // Use box-shadow to create borders that stay with sticky column
        headerName.style.boxShadow = 'inset -2px 0 0 0 #888, inset 0 -1px 0 0 grey';
        headerName.style.borderLeft = 'none';
        headerName.style.borderRight = 'none';
        headerName.style.borderTop = 'none';
        headerName.style.borderBottom = 'none';
    }
}

// =============================================================================
// Roster Screen Polling (for cross-device sync)
// =============================================================================

let rosterPollIntervalId = null;
const ROSTER_POLL_INTERVAL = 10000;  // 10 seconds

/**
 * Start polling for roster updates while on the roster screen
 */
function startRosterPolling() {
    if (rosterPollIntervalId) {
        return; // Already running
    }
    
    rosterPollIntervalId = setInterval(async () => {
        // Only poll if we're on the roster screen
        const rosterScreen = document.getElementById('teamRosterScreen');
        if (!rosterScreen || rosterScreen.style.display === 'none') {
            stopRosterPolling();
            return;
        }
        
        // Check if we're authenticated and online
        if (!window.breakside?.auth?.isAuthenticated?.() || !navigator.onLine) {
            return;
        }
        
        // Don't poll during active game
        if (typeof currentGame === 'function') {
            try {
                const game = currentGame();
                if (game && !game.gameEndTimestamp) {
                    return;
                }
            } catch (e) {
                // No current game
            }
        }
        
        try {
            // Check for updates
            if (typeof checkForUpdates === 'function') {
                const hasUpdates = await checkForUpdates();
                
                if (hasUpdates && typeof syncUserTeams === 'function') {
                    console.log('📥 Roster: Updates detected, syncing...');
                    const result = await syncUserTeams();
                    
                    if (result.success && (result.synced > 0 || result.updated > 0 || result.players > 0)) {
                        // Refresh roster display
                        if (typeof updateTeamRosterDisplay === 'function') {
                            updateTeamRosterDisplay();
                        }
                        console.log('✅ Roster: Updated display with new data');
                    }
                }
            }
        } catch (error) {
            console.warn('Roster poll failed:', error);
        }
    }, ROSTER_POLL_INTERVAL);
    
    console.log('🔄 Started roster polling');
}

/**
 * Stop roster polling
 */
function stopRosterPolling() {
    if (rosterPollIntervalId) {
        clearInterval(rosterPollIntervalId);
        rosterPollIntervalId = null;
        console.log('⏹️ Stopped roster polling');
    }
}

// Start polling when roster screen becomes visible
// Hook into showScreen if available
const originalShowScreen = window.showScreen;
if (typeof originalShowScreen === 'function') {
    window.showScreen = function(screenId) {
        originalShowScreen(screenId);
        
        if (screenId === 'teamRosterScreen') {
            startRosterPolling();
        } else {
            stopRosterPolling();
        }
    };
}

