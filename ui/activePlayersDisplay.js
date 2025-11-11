/*
 * Active Players Display
 * Handles rendering and management of the active players table on the Before Point Screen
 */

let showingTotalStats = false;
let nextLineSelections = null;

/**
 * Update the active players list display
 * This is the main entry point for refreshing the table
 */
function updateActivePlayersList() {
    console.log('Updating active players list...');

    // Clear and recreate the table structure
    createActivePlayersTable();

    // Create player rows and set checkbox states
    setPlayerCheckboxes();

    // Populate player statistics and point data
    populatePlayerStats();

    console.log('Finished updating active players list');
    // After adding all rows to the tableBody, calculate the widths
    makeColumnsSticky();
    
    // Update gender ratio display
    if (typeof updateGenderRatioDisplay === 'function') {
        updateGenderRatioDisplay();
    }
}

/**
 * Create the header structure for the active players table
 * Includes score rows showing running scores for team and opponent
 */
function createActivePlayersTable() {
    const table = document.getElementById('activePlayersTable');
    const tableBody = table.querySelector('tbody');
    const tableHead = table.querySelector('thead');

    // Clear existing rows in the table body and head
    tableBody.innerHTML = '';
    tableHead.innerHTML = '';

    // Create header rows for scores
    const teamScoreRow = document.createElement('tr');
    const opponentScoreRow = document.createElement('tr');

    // Add cells to the score rows
    const addScoreCells = (row, teamName, scores) => {
        const nameCell = document.createElement('th');
        nameCell.textContent = teamName;
        nameCell.setAttribute('colspan', '3');  // merge with time column in header row
        nameCell.setAttribute('text-align', 'center');
        nameCell.classList.add('active-header-teams');
        row.appendChild(nameCell);
        scores.forEach((score, index) => {
            const scoreCell = document.createElement('th');
            scoreCell.textContent = score;
            
            // Color score cells based on gender ratio for alternating games
            const game = currentGame();
            if (game && game.alternateGenderRatio === 'Alternating' && game.startingGenderRatio) {
                    const pointIndex = index; 
                    const genderRatio = getGenderRatioForPoint(game, pointIndex);
                    if (genderRatio === 'FMP') {
                        scoreCell.classList.add('score-cell-fmp');
                    } else if (genderRatio === 'MMP') {
                        scoreCell.classList.add('score-cell-mmp');
                    }
            }
            
            row.appendChild(scoreCell);
        });
    };

    // Calculate and add score cells using utility function
    const runningScores = getRunningScores();

    addScoreCells(teamScoreRow, currentGame().team, runningScores.team);
    addScoreCells(opponentScoreRow, currentGame().opponent, runningScores.opponent);

    // Add score rows to the head
    tableHead.appendChild(teamScoreRow);
    tableHead.appendChild(opponentScoreRow);
}

/**
 * Set up player checkboxes in the table
 */
function setPlayerCheckboxes() {
    // Create player rows with checkboxes
    createPlayerRows();

    // Set checkbox states based on last point players
    setCheckboxStates();
}

/**
 * Create player rows with checkboxes and basic info
 */
function createPlayerRows() {
    // Determine players from the last point using utility function
    const lastPointPlayers = getLastPointPlayers();

    console.log('Last point players: ', lastPointPlayers);

    // Sort roster into 3 alphabetical lists: played the last point, played any points, played no points
    currentTeam.teamRoster.sort((a, b) => {
        const aLastPoint = lastPointPlayers.includes(a.name);
        const bLastPoint = lastPointPlayers.includes(b.name);
        const aPlayedAny = hasPlayedAnyPoints(a.name);
        const bPlayedAny = hasPlayedAnyPoints(b.name);

        if (aLastPoint && !bLastPoint) return -1;
        if (!aLastPoint && bLastPoint) return 1;
        if (aPlayedAny && !bPlayedAny) return -1;
        if (!aPlayedAny && bPlayedAny) return 1;

        return a.name.localeCompare(b.name);
    });

    // Create player rows with checkboxes
    const tableBody = document.getElementById('activePlayersTable').querySelector('tbody');

    currentTeam.teamRoster.forEach(player => {
        const row = document.createElement('tr');

        // Add checkbox column
        const checkboxCell = document.createElement('td');
        checkboxCell.classList.add('active-checkbox-column');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('active-checkbox');
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);

        // Add name column with gender-based styling
        const nameCell = document.createElement('td');
        nameCell.classList.add('active-name-column');
        nameCell.textContent = player.name;
        
        // Add gender-based color coding
        if (player.gender === Gender.FMP) {
            nameCell.classList.add('player-fmp');
        } else if (player.gender === Gender.MMP) {
            nameCell.classList.add('player-mmp');
        }
        
        row.appendChild(nameCell);

        // Add time column using utility function
        const timeCell = document.createElement('td');
        timeCell.classList.add('active-time-column');
        timeCell.textContent = getPlayerDisplayTime(player.name);
        row.appendChild(timeCell);

        // Add placeholder cells for points data (will be populated by populatePlayerStats)
        currentGame().points.forEach(() => {
            const pointCell = document.createElement('td');
            pointCell.classList.add('active-points-columns');
            pointCell.textContent = ''; // Will be populated later
            row.appendChild(pointCell);
        });

        tableBody.appendChild(row);
    });
}

/**
 * Set checkbox states based on which players should be checked
 */
function setCheckboxStates() {
    // Get the players to check based on current strategy
    const playersToCheck = getPlayersToCheck();
    console.log('setCheckboxStates() using players:', playersToCheck);

    // Set checkbox states
    const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
    checkboxes.forEach((checkbox, index) => {
        const player = currentTeam.teamRoster[index];
        if (player && playersToCheck.includes(player.name)) {
            console.log('Checking checkbox for player:', player.name);
            checkbox.checked = true;
        } else {
            checkbox.checked = false;
        }
    });
}

/**
 * Determine which players should be checked
 * Uses stored next line selections if available, otherwise uses last point players
 */
function getPlayersToCheck() {
    // If we have stored next line selections, use those
    if (nextLineSelections !== null) {
        console.log('Using stored next line selections:', nextLineSelections);
        return nextLineSelections;
    }

    // Otherwise, use the last point's players
    const lastPointPlayers = getLastPointPlayers();
    console.log('No stored selections, using last point players:', lastPointPlayers);

    // In the future, this could be extended to support:
    // - Line-based selection
    // - Rotation-based selection
    // - Manual pre-selection
    // - AI-suggested selection
    return lastPointPlayers;
}

/**
 * Populate player statistics in the table cells
 */
function populatePlayerStats() {
    const tableBody = document.getElementById('activePlayersTable').querySelector('tbody');
    const rows = tableBody.querySelectorAll('tr');

    rows.forEach((row, rowIndex) => {
        const player = currentTeam.teamRoster[rowIndex];
        if (!player) return;

        // Points data cells
        // If showing total stats, add points from previous games
        let runningPointTotal = showingTotalStats ? player.pointsPlayedPreviousGames : 0;
        const pointCells = row.querySelectorAll('.active-points-columns');

        pointCells.forEach((pointCell, pointIndex) => {
            const point = currentGame().points[pointIndex];
            if (point && point.players.includes(player.name)) {
                runningPointTotal++;
                pointCell.textContent = `${runningPointTotal}`;
            } else {
                pointCell.textContent = '-';
            }
        });
    });
}

/**
 * Get players from the last point
 */
function getLastPointPlayers() {
    return currentGame().points.length > 0
        ? currentGame().points[currentGame().points.length - 1].players
        : [];
}

/**
 * Check if a player has played any points in the current game
 */
function hasPlayedAnyPoints(playerName) {
    return currentGame().points.some(point => point.players.includes(playerName));
}

/**
 * Calculate running scores for team and opponent
 */
function getRunningScores() {
    const runningScores = { team: [0], opponent: [0] };
    currentGame().points.forEach(point => {
        runningScores.team.push(point.winner === 'team' ? runningScores.team.slice(-1)[0] + 1 : runningScores.team.slice(-1)[0]);
        runningScores.opponent.push(point.winner === 'opponent' ? runningScores.opponent.slice(-1)[0] + 1 : runningScores.opponent.slice(-1)[0]);
    });
    return runningScores;
}

/**
 * Get the gender ratio (FMP or MMP) for a specific point index in an alternating game
 * Returns 'FMP', 'MMP', or null if not applicable. 
 * 
 * The pattern is: ABBAABB... (or {0,1,1,0,0,1,1}...) 
 * which is (i+1) // 2 % 2   [where // is integer division and % is modulo]
 * or ((i+1) >> 1) & 1   using bitwise operations
 * 
 */
function getGenderRatioForPoint(game, pointIndex) {
    if (!game || game.alternateGenderRatio !== 'Alternating' || !game.startingGenderRatio) {
        return null;
    }
    
    const useFirstRatio = (((pointIndex + 1) >> 1) & 1) === 0;
    
    return useFirstRatio ? game.startingGenderRatio : (game.startingGenderRatio === 'FMP' ? 'MMP' : 'FMP');
}

/**
 * Get display time for a player (either game time or total time)
 */
function getPlayerDisplayTime(playerName) {
    if (showingTotalStats) {
        const player = getPlayerFromName(playerName);
        return formatPlayTime(player.totalTimePlayed);
    } else {
        return formatPlayTime(getPlayerGameTime(playerName));
    }
}

/**
 * Capture selected players for next line
 */
function captureNextLineSelections() {
    const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
    const selectedPlayers = [];

    checkboxes.forEach((checkbox, index) => {
        if (checkbox.checked && index < currentTeam.teamRoster.length) {
            selectedPlayers.push(currentTeam.teamRoster[index].name);
        }
    });

    nextLineSelections = selectedPlayers;
    console.log('Captured next line selections:', nextLineSelections);
}

/**
 * Clear stored next line selections
 */
function clearNextLineSelections() {
    if (nextLineSelections !== null) {
        console.log('Clearing next line selections (was:', nextLineSelections, ')');
    }
    nextLineSelections = null;
}

/**
 * Make the first few columns sticky for horizontal scrolling
 */
function makeColumnsSticky() {
    // Below assumes all checkbox & name cells will have the same width
    const checkboxCells = document.querySelectorAll('.active-checkbox-column');
    if (checkboxCells.length === 0) {
        return;
    }
    const checkboxCellWidth = checkboxCells[0].getBoundingClientRect().width + 1;  // 1-pixel border each side

    const nameCells = document.querySelectorAll('.active-name-column');
    const nameCellWidth = nameCells.length > 0 ? nameCells[0].getBoundingClientRect().width + 1 : 0;
    // Update the second sticky column's left offset
    nameCells.forEach(cell => {
        cell.style.position = 'sticky';
        cell.style.left = `${checkboxCellWidth}px`;
        cell.style.zIndex = 1;
    });

    const timeCells = document.querySelectorAll('.active-time-column');
    // Update the third sticky column's left offset
    timeCells.forEach(cell => {
        cell.style.position = 'sticky';
        cell.style.left = `${checkboxCellWidth + nameCellWidth}px`;
        cell.style.zIndex = 1;
    });
    // Set the scroll position to the maximum scroll width
    const tableContainer = document.getElementById('tableContainer');
    if (tableContainer) {
        tableContainer.scrollLeft = tableContainer.scrollWidth;
    }
}

/**
 * Toggle between showing game stats and total stats
 */
function togglePlayerStats() {
    // Store current checkbox states before updating
    const checkboxStates = {};
    document.querySelectorAll('#activePlayersTable input[type="checkbox"]').forEach((checkbox, index) => {
        const playerName = currentTeam.teamRoster[index].name;
        checkboxStates[playerName] = checkbox.checked;
    });

    // Toggle stats display
    showingTotalStats = !showingTotalStats;
    document.getElementById('statsToggle').textContent = showingTotalStats ? '(Total)' : '(Game)';

    // Update the display
    updateActivePlayersList();

    // Restore checkbox states
    document.querySelectorAll('#activePlayersTable input[type="checkbox"]').forEach((checkbox, index) => {
        const playerName = currentTeam.teamRoster[index].name;
        checkbox.checked = checkboxStates[playerName];
    });

    // Make sure the Start Point button state is correct
    if (typeof checkPlayerCount === 'function') {
        checkPlayerCount();
    }
}

