/*
 * Roster management helpers
 * Handles roster displays and roster-related UI interactions
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

    const rosterElement = document.getElementById('rosterList');
    if (!rosterElement) {
        console.warn('Roster list element not found.');
        return;
    }
    rosterElement.innerHTML = '';

    const eventStats = currentGame() ? calculatePlayerStatsFromEvents(currentGame()) : {};

    const headerRow = document.createElement('tr');
    ['', 'Name', 'Pts', 'Time', 'Goals', 'Assists', 'Comp%', 'Ds', 'TOs', '+/-', '..per pt'].forEach(headerText => {
        const headerCell = document.createElement('th');
        headerCell.textContent = headerText;
        headerCell.classList.add('roster-header');
        headerRow.appendChild(headerCell);
    });
    rosterElement.appendChild(headerRow);

    currentTeam.teamRoster.forEach(player => {
        const playerRow = document.createElement('tr');

        const checkboxCell = document.createElement('td');
        checkboxCell.classList.add('active-checkbox-column');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('active-checkbox');
        checkboxCell.appendChild(checkbox);
        playerRow.appendChild(checkboxCell);

        const nameCell = document.createElement('td');
        nameCell.classList.add('roster-name-column');
        nameCell.textContent = player.name;
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

    const appendTeamCell = (value, className) => {
        const cell = document.createElement('td');
        cell.classList.add(className, 'team-total-cell');
        cell.textContent = value;
        teamRow.appendChild(cell);
    };

    appendTeamCell('Team', 'roster-name-column');
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
}

function updateGameSummaryRosterDisplay() {
    const rosterElement = document.getElementById('gameSummaryRosterList');
    if (!rosterElement) {
        console.warn('Game summary roster list not found.');
        return;
    }
    rosterElement.innerHTML = '';

    const eventStats = currentGame() ? calculatePlayerStatsFromEvents(currentGame()) : {};

    const headerRow = document.createElement('tr');
    ['Name', 'Pts', 'Time', 'Goals', 'Assists', 'Comp%', 'Huck%', 'Ds', 'TOs', '+/-', '..per pt'].forEach(headerText => {
        const headerCell = document.createElement('th');
        headerCell.textContent = headerText;
        headerCell.classList.add('roster-header');
        headerRow.appendChild(headerCell);
    });
    rosterElement.appendChild(headerRow);

    currentTeam.teamRoster.forEach(player => {
        const playerRow = document.createElement('tr');

        const nameCell = document.createElement('td');
        nameCell.classList.add('roster-name-column');
        nameCell.textContent = player.name;
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

(function setupRosterUI() {
    const playerNameInput = document.getElementById('newPlayerInput');
    const addPlayerBtn = document.getElementById('addPlayerBtn');
    if (addPlayerBtn) {
        addPlayerBtn.addEventListener('click', () => {
            const playerName = playerNameInput ? playerNameInput.value.trim() : '';

            if (playerName && !currentTeam.teamRoster.some(player => player.name === playerName)) {
                const newPlayer = new Player(playerName);
                currentTeam.teamRoster.push(newPlayer);
                updateTeamRosterDisplay();
            }
            if (playerNameInput) {
                playerNameInput.value = '';
            }
        });
    }

    if (playerNameInput) {
        playerNameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && addPlayerBtn) {
                addPlayerBtn.click();
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
})();

