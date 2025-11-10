// Breakside PWA - Main Application Entry Point
// Data layer is now in data/models.js and data/storage.js

// import AudioNarrationService from './audioNarration.js';

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('./service-worker.js')
            .then(reg => console.log('Service Worker: Registered'))
            .catch(err => console.log(`Service Worker Error: ${err}`));
    });
}

/*
 * Screens & other app-wide HTML elements
 * (see screens/navigation.js for screen management helpers)
 */

/*
 * Global variables
 * These are now initialized from data modules loaded before this file
 */
// Globals are now defined before this point by data/storage.js

/*
 * Saving and loading team data
 * NOTE: Serialization functions have been moved to data/storage.js
 * These are kept here temporarily for backward compatibility during refactoring
 */
function serializeEvent(event) {
    const serializedEvent = { type: event.type };
    // Create a new instance of the event with default values
    const defaultEvent = new event.constructor({});

    // Serialize only the properties that are different from the default instance
    for (const prop in event) {
        if (event.hasOwnProperty(prop) && event[prop] !== defaultEvent[prop]) {
            serializedEvent[prop] = event[prop];
        }
    }

    // Serialize player names if available
    if (event.thrower) serializedEvent.thrower = event.thrower.name;
    if (event.receiver) serializedEvent.receiver = event.receiver.name;

    return serializedEvent;
}

// Simplify the team & game objects into serializable objects and output JSON
function serializeTeam(team) {
    const serializedTeam = {
        name: team.name,
        teamRoster: team.teamRoster.map(player => ({
            name: player.name,
            nickname: player.nickname,
            totalPointsPlayed: player.totalPointsPlayed,
            consecutivePointsPlayed: player.consecutivePointsPlayed,
            pointsPlayedPreviousGames: player.pointsPlayedPreviousGames,
            totalTimePlayed: player.totalTimePlayed,
            completedPasses: player.completedPasses,
            turnovers: player.turnovers,
            goals: player.goals,
            assists: player.assists,
            pointsWon: player.pointsWon,
            pointsLost: player.pointsLost
        })),
        games: team.games.map(game => ({
            team: game.team,
            opponent: game.opponent,
            startingPosition: game.startingPosition,
            scores: game.scores,
            gameStartTimestamp: game.gameStartTimestamp.toISOString(),
            gameEndTimestamp: game.gameEndTimestamp ? game.gameEndTimestamp.toISOString() : null,
            points: game.points.map(point => ({
                players: point.players,
                startingPosition: point.startingPosition,
                winner: point.winner,
                startTimestamp: point.startTimestamp ? point.startTimestamp.toISOString() : null,
                endTimestamp: point.endTimestamp ? point.endTimestamp.toISOString() : null,
                totalPointTime: point.totalPointTime,
                lastPauseTime: point.lastPauseTime ? point.lastPauseTime.toISOString() : null,
                possessions: point.possessions.map(possession => ({
                    offensive: possession.offensive,
                    events: possession.events.map(event => serializeEvent(event))
                }))
            }))
        })),
        lines: team.lines
    };
    return JSON.stringify(serializedTeam, null, 4);
}

// Log team data to the console
function logTeamData(team) {
    console.log("Team data: ");
    console.log(team);
    console.log("Serialized team data: ");
    console.log(serializeTeam(team));
}

// Save all teams' data to local storage
function saveAllTeamsData() {
    // Serialize each team in the global teams array
    const serializedTeams = teams.map(team => JSON.parse(serializeTeam(team)));

    // Save the serialized array to local storage
    localStorage.setItem('teamsData', JSON.stringify(serializedTeams));

    // Log each team's data
    teams.forEach(team => logTeamData(team));
}

/* 
 * Given eventData created when deserializing an Event from JSON, create an
 * Event object of the proper subclass and convert any player name strings into
 * references to Player instances.
 */
function deserializeEvent(eventData, playerLookup) {
    let event;

    switch (eventData.type) {
        case 'Throw': event = new Throw({ /* default parameters */ }); break;
        case 'Turnover': event = new Turnover({ /* default parameters */ }); break;
        case 'Violation': event = new Violation({ /* default parameters */ }); break;
        case 'Defense': event = new Defense({ /* default parameters */ }); break;
        case 'Other': event = new Other({ /* default parameters */ }); break;
        default:
            throw new Error(`Unknown event type: ${eventData.type}`);
    }
    // Now set any properties that were serialized (because they differed from the default instance)
    for (const key in eventData) {
        if (eventData.hasOwnProperty(key) && key !== 'type') {
            event[key] = eventData[key];
        }
    }
    // Now replace player names with Player instances
    switch (eventData.type) {
        case 'Throw':
            event.thrower = getPlayerFromName(eventData.thrower);
            event.receiver = getPlayerFromName(eventData.receiver);
            break;
        case 'Turnover':
            if (event.receiverError) {
                event.receiver = getPlayerFromName(eventData.receiver);
            }
            break;
        // Add other event types here, if they refer to players
    }
    return event;
}

// Convert serialized team data back into team objects
function deserializeTeams(serializedData) {
    const parsedData = JSON.parse(serializedData);
    return parsedData.map(teamData => {
        const team = new Team(teamData.name);
        currentTeam = team; // Set current team before deserializing events
        
        // First deserialize the roster
        team.teamRoster = teamData.teamRoster.map(playerData => {
            const player = new Player(playerData.name);
            Object.assign(player, playerData);
            return player;
        });
        
        // Then deserialize games and their nested structures
        team.games = teamData.games.map(gameData => {
            const game = new Game(
                gameData.team,
                gameData.opponent,
                gameData.startingPosition
            );
            game.gameStartTimestamp = new Date(gameData.gameStartTimestamp);
            game.gameEndTimestamp = gameData.gameEndTimestamp ? new Date(gameData.gameEndTimestamp) : null;
            game.points = gameData.points.map(pointData => {
                const point = new Point(pointData.players, pointData.startingPosition);
                point.startTimestamp = pointData.startTimestamp ? new Date(pointData.startTimestamp) : null;
                point.endTimestamp = pointData.endTimestamp ? new Date(pointData.endTimestamp) : null;
                point.winner = pointData.winner;
                point.totalPointTime = pointData.totalPointTime || 0;
                point.lastPauseTime = pointData.lastPauseTime ? new Date(pointData.lastPauseTime) : null;
                point.possessions = pointData.possessions.map(possessionData => {
                    const possession = new Possession(possessionData.offensive);
                    possession.events = possessionData.events.map(eventData => deserializeEvent(eventData));
                    return possession;
                });
                return point;
            });
            return game;
        });
        
        // Finally set the lines data
        team.lines = teamData.lines || [];
        return team;
    });
}

// load teams from local storage or create a sample team
function initializeTeams() {
    loadTeams({ silent: true })
    if (teams.length === 0) {
        const sampleNames = ["Cyrus L","Leif","Cesc","Cyrus J","Abby","Avery","James","Simeon","Soren","Walden"];
        sampleTeam = new Team("Sample Team", sampleNames);  // A sample team with 10 players
        teams.push(sampleTeam);         // Add the sample team to the teams array
    }
    currentTeam = teams[0];         // there will be at least one team in the array
}

// (i.e., the latest point has at least one possession and does not 
// have a winner yet)

/************************************************************************ 
 *
 *   TEAM SELECTION SCREEN
 * 
 ************************************************************************/
// Open up with the "Select Your Team" screen
showSelectTeamScreen(true);

// Feedback link handler - opens GitHub issues page
const feedbackLink = document.getElementById('feedbackLink');
if (feedbackLink) {
    feedbackLink.addEventListener('click', function(e) {
        e.preventDefault();

        const versionInfo = appVersion ? `${appVersion.version} (Build ${appVersion.build})` : 'Unknown';
        const userAgent = navigator.userAgent;

        const body = `Please describe your experience or issue below:

---

**Device/Browser:** ${userAgent}
**App Version:** ${versionInfo}
**Steps to reproduce:**`;

        const encodedBody = encodeURIComponent(body);
        const feedbackUrl = `https://github.com/davedotluebke/ultistats/issues/new?labels=beta_feedback&title=${encodeURIComponent('Beta Feedback:')}&body=${encodedBody}`;

        window.open(feedbackUrl, '_blank');
    });
}

/************************************************************************ 
 *
 *   BEFORE GAME SCREEN
 *   TEAM ROSTER TABLE 
 * 
 ************************************************************************/

// Updates the displayed roster on the "Team Roster Screen"
function updateTeamRosterDisplay() {
    const teamRosterHeader = document.getElementById('teamRosterHeader');
    if (currentTeam && currentTeam.name) {
        teamRosterHeader.textContent = `Roster: ${currentTeam.name}`;
    } else {
        teamRosterHeader.textContent = 'Team Roster';
    }
    const rosterElement = document.getElementById('rosterList');
    rosterElement.innerHTML = '';  // Clear existing rows

    // Calculate stats from current game events (if a game is in progress)
    const eventStats = currentGame() ? calculatePlayerStatsFromEvents(currentGame()) : {};

    // Add header row
    let headerRow = document.createElement('tr');
    ['', 'Name', 'Pts', 'Time', 'Goals', 'Assists', 'Comp%', 'Ds', 'TOs', '+/-', '..per pt'].forEach(headerText => {
        let headerCell = document.createElement('th');
        headerCell.textContent = headerText;
        headerCell.classList.add('roster-header');
        headerRow.appendChild(headerCell);
    });
    rosterElement.appendChild(headerRow);

    currentTeam.teamRoster.forEach(player => {
        let playerRow = document.createElement('tr');

        // Add checkbox column
        let checkboxCell = document.createElement('td');
        checkboxCell.classList.add('active-checkbox-column');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('active-checkbox');
        checkboxCell.appendChild(checkbox);
        playerRow.appendChild(checkboxCell);

        // Player name column
        let nameCell = document.createElement('td');
        nameCell.classList.add('roster-name-column');
        nameCell.textContent = player.name;
        playerRow.appendChild(nameCell);

        // Total points played column
        let totalPointsCell = document.createElement('td');
        totalPointsCell.classList.add('roster-points-column');
        totalPointsCell.textContent = player.totalPointsPlayed;
        playerRow.appendChild(totalPointsCell);

        // Total time played column
        let totalTimeCell = document.createElement('td');
        totalTimeCell.classList.add('roster-time-column');
        totalTimeCell.textContent = formatPlayTime(player.totalTimePlayed);
        playerRow.appendChild(totalTimeCell);

        // Goals column
        let goalsCell = document.createElement('td');
        goalsCell.classList.add('roster-goals-column');
        goalsCell.textContent = player.goals || 0;
        playerRow.appendChild(goalsCell);

        // Assists column
        let assistsCell = document.createElement('td');
        assistsCell.classList.add('roster-assists-column');
        assistsCell.textContent = player.assists || 0;
        playerRow.appendChild(assistsCell);

        // Completion percentage column
        let compPctCell = document.createElement('td');
        compPctCell.classList.add('roster-comppct-column');
        const playerStats = eventStats[player.name] || {};
        const compPct = playerStats.totalThrows > 0
            ? ((playerStats.completions / playerStats.totalThrows) * 100).toFixed(0)
            : '-';
        compPctCell.textContent = compPct !== '-' ? `${compPct}%` : compPct;
        playerRow.appendChild(compPctCell);

        // Ds column
        let dPlaysCell = document.createElement('td');
        dPlaysCell.classList.add('roster-dplays-column');
        dPlaysCell.textContent = playerStats.dPlays || 0;
        playerRow.appendChild(dPlaysCell);

        // Turnovers column
        let turnoversCell = document.createElement('td');
        turnoversCell.classList.add('roster-turnovers-column');
        turnoversCell.textContent = playerStats.turnovers || 0;
        playerRow.appendChild(turnoversCell);

        // Plus/Minus column
        let plusMinusCell = document.createElement('td');
        plusMinusCell.classList.add('roster-plusminus-column');
        const plusMinus = (player.pointsWon || 0) - (player.pointsLost || 0);
        plusMinusCell.textContent = plusMinus > 0 ? `+${plusMinus}` : plusMinus;
        playerRow.appendChild(plusMinusCell);

        // Plus/Minus per point column
        let plusMinusPerPointCell = document.createElement('td');
        plusMinusPerPointCell.classList.add('roster-plusminus-per-point-column');
        const plusMinusPerPoint = player.totalPointsPlayed > 0 
            ? (plusMinus / player.totalPointsPlayed).toFixed(2)
            : '0.0';
        plusMinusPerPointCell.textContent = plusMinusPerPoint > 0 ? `+${plusMinusPerPoint}` : plusMinusPerPoint;
        playerRow.appendChild(plusMinusPerPointCell);

        // Append row to the table body
        rosterElement.appendChild(playerRow);
    });

    // Add aggregate "Team" row
    let teamRow = document.createElement('tr');
    teamRow.classList.add('team-aggregate-row');

    // Calculate team totals
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

    // Team name cell
    let teamNameCell = document.createElement('td');
    teamNameCell.classList.add('roster-name-column', 'team-total-cell');
    teamNameCell.textContent = 'Team';
    teamRow.appendChild(teamNameCell);

    // Total points in game
    let teamPointsCell = document.createElement('td');
    teamPointsCell.classList.add('roster-points-column', 'team-total-cell');
    teamPointsCell.textContent = currentGame() ? currentGame().points.length : 0;
    teamRow.appendChild(teamPointsCell);

    // Total time
    let teamTimeCell = document.createElement('td');
    teamTimeCell.classList.add('roster-time-column', 'team-total-cell');
    teamTimeCell.textContent = formatPlayTime(totalTimePlayed);
    teamRow.appendChild(teamTimeCell);

    // Total goals
    let teamGoalsCell = document.createElement('td');
    teamGoalsCell.classList.add('roster-goals-column', 'team-total-cell');
    teamGoalsCell.textContent = totalGoals;
    teamRow.appendChild(teamGoalsCell);

    // Total assists
    let teamAssistsCell = document.createElement('td');
    teamAssistsCell.classList.add('roster-assists-column', 'team-total-cell');
    teamAssistsCell.textContent = totalAssists;
    teamRow.appendChild(teamAssistsCell);

    // Team completion percentage
    let teamCompPctCell = document.createElement('td');
    teamCompPctCell.classList.add('roster-comppct-column', 'team-total-cell');
    const teamCompPct = totalThrows > 0
        ? ((totalCompletions / totalThrows) * 100).toFixed(0)
        : '-';
    teamCompPctCell.textContent = teamCompPct !== '-' ? `${teamCompPct}%` : teamCompPct;
    teamRow.appendChild(teamCompPctCell);

    // Team huck percentage
    let teamHuckPctCell = document.createElement('td');
    teamHuckPctCell.classList.add('roster-huckpct-column', 'team-total-cell');
    const teamHuckPct = totalHucks > 0
        ? ((totalHuckCompletions / totalHucks) * 100).toFixed(0)
        : '-';
    teamHuckPctCell.textContent = teamHuckPct !== '-' ? `${teamHuckPct}%` : teamHuckPct;
    teamRow.appendChild(teamHuckPctCell);

    // Total Ds
    let teamDPlaysCell = document.createElement('td');
    teamDPlaysCell.classList.add('roster-dplays-column', 'team-total-cell');
    teamDPlaysCell.textContent = totalDPlays;
    teamRow.appendChild(teamDPlaysCell);

    // Total turnovers
    let teamTurnoversCell = document.createElement('td');
    teamTurnoversCell.classList.add('roster-turnovers-column', 'team-total-cell');
    teamTurnoversCell.textContent = totalTurnovers;
    teamRow.appendChild(teamTurnoversCell);

    // Team plus/minus (score differential)
    let teamPlusMinusCell = document.createElement('td');
    teamPlusMinusCell.classList.add('roster-plusminus-column', 'team-total-cell');
    const teamScore = currentGame() ? currentGame().scores[Role.TEAM] : 0;
    const opponentScore = currentGame() ? currentGame().scores[Role.OPPONENT] : 0;
    const teamPlusMinus = teamScore - opponentScore;
    teamPlusMinusCell.textContent = teamPlusMinus > 0 ? `+${teamPlusMinus}` : teamPlusMinus;
    teamRow.appendChild(teamPlusMinusCell);

    // Team plus/minus per point
    let teamPlusMinusPerPointCell = document.createElement('td');
    teamPlusMinusPerPointCell.classList.add('roster-plusminus-per-point-column', 'team-total-cell');
    const totalPoints = currentGame() ? currentGame().points.length : 0;
    const teamPlusMinusPerPoint = totalPoints > 0 
        ? (teamPlusMinus / totalPoints).toFixed(2)
        : '0.0';
    teamPlusMinusPerPointCell.textContent = teamPlusMinusPerPoint > 0 ? `+${teamPlusMinusPerPoint}` : teamPlusMinusPerPoint;
    teamRow.appendChild(teamPlusMinusPerPointCell);

    // Append team row to the table
    rosterElement.appendChild(teamRow);
}

// UI: Handle player addition to teamRoster
const playerNameInput = document.getElementById('newPlayerInput');
document.getElementById('addPlayerBtn').addEventListener('click', function() {
    const playerName = playerNameInput.value.trim();

    if (playerName && !currentTeam.teamRoster.some(player => player.name === playerName)) {
        let newPlayer = new Player(playerName);
        currentTeam.teamRoster.push(newPlayer);
        updateTeamRosterDisplay();
    }
    playerNameInput.value = '';
});
// Also accept an Enter keypress to add a player
playerNameInput.addEventListener('keydown', function(event) {
    if (event.key === "Enter") {
        document.getElementById('addPlayerBtn').click();
    }
});

// UI: Continue an in-progress game (inactive by default)
//     Used to add players to the roster or change players during an injury sub)
document.getElementById('continueGameBtn').addEventListener('click', function() {
    if (currentTeam.games.length > 0) {
        // if adding new player to roster between points, return to choose players screen
        if (isPointInProgress() === false) {
            updateActivePlayersList();
            showScreen('beforePointScreen');
        } else {
            // if the game is in progress, and the last event is not a score, return to the O or D possession screen
            if (getLatestPossession().offensive) {
                updateOffensivePossessionScreen();
                showScreen('offensePlayByPlayScreen');
            } else {
                updateDefensivePossessionScreen();
                showScreen('defensePlayByPlayScreen');
            }
            // make contiueGameBtn inactive now that we've handled it
            document.getElementById('continueGameBtn').classList.add('inactive');
        }
    }
});

// UI: Add a download button to save team data from the roster screen
document.getElementById('downloadTeamBtn').addEventListener('click', function() {
    const teamData = serializeTeam(currentTeam);
    downloadJSON(teamData, `${currentTeam.name}_roster.json`);
});

// UI: Restore team data from local storage
document.getElementById('restoreGamesBtn').addEventListener('click', function() {
    loadTeams();
    if (teams.length > 0) {
        currentTeam = teams[0];
        updateTeamRosterDisplay();
        showSelectTeamScreen();
    }
    logTeamData(currentTeam);
});

// Load team data from local storage
function loadTeams(silent = false) {
    const serializedTeams = localStorage.getItem('teamsData');
    if (serializedTeams) {
        teams = deserializeTeams(serializedTeams);
    } else {
        console.log("No saved team data found.");
        if (!silent) {
            alert('No saved team data found.');
        }
    }
}

// UI: Clear games from local storage
document.getElementById('clearGamesBtn').addEventListener('click', function() {
    if (confirm('Are you sure you want to clear all saved game data?')) {
        localStorage.removeItem('teamsData');
        // Reset the current team data and refresh, so UI doesn't reflect cleared data
        teams = [];
        initializeTeams();
        updateTeamRosterDisplay(); // Update the display
        showSelectTeamScreen();
    }
});

// Function to add a new line
function addNewLine() {
    const lineNameInput = document.querySelector('.line-name-input');
    const lineName = lineNameInput.value.trim();
    
    if (!lineName) {
        alert('Please enter a line name');
        return;
    }
    
    // Get selected players
    const selectedPlayers = Array.from(document.querySelectorAll('.active-checkbox:checked'))
        .map(checkbox => {
            const row = checkbox.closest('tr');
            return row.querySelector('.roster-name-column').textContent;
        });
    
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
    lineNameInput.value = '';
    saveAllTeamsData();
    updateTeamRosterDisplay();
}

// Add event listener for the add line button
document.querySelector('.add-line-button').addEventListener('click', addNewLine);

// Function to show delete line dialog
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

// Add event listener for the delete line button
const deleteLineButton = document.querySelector('.delete-line-button');
if (deleteLineButton) {
    deleteLineButton.addEventListener('click', showDeleteLineDialog);
}

/************************************************************************ 
 *
 *   BEFORE POINT SCREEN
 *   SELECT PLAYERS TABLE 
 * 
 ************************************************************************/

const toggleEventLogBtn = document.getElementById('toggleEventLogBtn');
if (toggleEventLogBtn) {
    toggleEventLogBtn.addEventListener('click', function() {
        const eventLog = document.getElementById('eventLog');
        if (!eventLog) {
            console.warn('Event log element not found.');
            return;
        }

        if (eventLog.style.display !== 'block') {
            eventLog.style.display = 'block';
            toggleEventLogBtn.classList.add('selected');
        } else {
            eventLog.style.display = 'none';
            toggleEventLogBtn.classList.remove('selected');
        }
    });
}


/******************************************************************************/
/**************************** Offense play-by-play ****************************/
/******************************************************************************/

function updateOffensivePossessionScreen() {
    displayOPlayerButtons();
    displayOActionButtons();
    logEvent('Refresh event log');
}

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

// Function to show action panels - call with 'none' to close all panels
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

// Function to generate sub-buttons
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

// Function to handle sub action button clicks
// (CSS for the 'selected' class visually indicates a button is selected)
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

// Assuming 'currentEvent' global is an instance of one of the Event subclasses
// and has properties like 'huck_flag', 'dump_flag', etc.
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
document.querySelectorAll('.main-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        showActionPanel(action);
        generateSubButtons(action);
    });
});


/******************************************************************************/
/**************************** Defense play-by-play ****************************/
/******************************************************************************/

function updateDefensivePossessionScreen() {
    displayDPlayerButtons();
    displayDActionButtons();
    logEvent('Refresh event log');
}

/* 
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

// Logic to handle click on a defensive player button 
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
    }
}

// function to mark all buttons as 'inactive' (unclickable)
// (to be made valid again when a defensive Turnover action is selected)
function markAllDPlayerButtonsInvalid() {
    document.querySelectorAll('.player-button').forEach(button => {
        button.classList.add('inactive');
    });
}

// function to mark all buttons as 'valid' (clickable)
function markAllDPlayerButtonsValid() {
    document.querySelectorAll('.player-button').forEach(button => {
        button.classList.remove('inactive');
    });
}

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
    });

    dScoreButton.addEventListener('click', function() {
        updateScore(Role.OPPONENT);
        moveToNextPoint();
    });
}


/******************************************************************************/
/**************************** Undo Event Button *******************************/
/******************************************************************************/
function undoEvent() {
    // XXX add logic to remove the most recent event from the current possession
    if (currentGame().points.length > 0) {
        // currentPoint is a global, reset it
        currentPoint = currentGame().points[currentGame().points.length - 1];
        if (currentPoint.possessions.length > 0) {
            let currentPossession = getActivePossession(currentPoint);
            if (currentPossession.events.length > 0) {
                let undoneEvent = currentPossession.events.pop();
                logEvent(`Undid event: ${undoneEvent.summarize()}`);
                if (undoneEvent instanceof Throw) {
                    // update player stats for the thrower and receiver
                    undoneEvent.thrower.completedPasses--;
                    if (undoneEvent.score_flag) {
                        undoneEvent.receiver.goals--;
                        undoneEvent.thrower.assists--;
                    }
                }
                if (currentPossession.offensive) {
                    updateOffensivePossessionScreen();
                } else {
                    updateDefensivePossessionScreen();
                }

                // XXX we allocate but don't currently maintain turnover stats for players 
                // XXX when we handle Callahans, we will need to decrement player goals
            } else {
                // no events in this possession, remove the possession
                currentPoint.possessions.pop();
                if (currentPoint.possessions.length === 0) {
                    // no possessions left in this point, update player stats then remove the point 
                    currentPoint.players.forEach(playerName => {
                        let player = getPlayerFromName(playerName);
                        player.totalPointsPlayed--;
                        player.consecutivePointsPlayed--;
                    });
                    currentGame().scores[currentPoint.winner]--;
                    currentGame().points.pop();
                    currentPoint = null;
                    // display the "before point screen" 
                    moveToNextPoint();
                } else {
                    // update and display screen for the previous possession
                    currentPossession = getActivePossession(currentPoint);
                    currentPossession.endTimestamp = null;
                    currentEvent = currentPossession.events[currentPossession.events.length - 1];
                    if (currentPossession.offensive) {
                        updateOffensivePossessionScreen();
                        showScreen('offensePlayByPlayScreen');
                    } else {
                        updateDefensivePossessionScreen();
                        showScreen('defensePlayByPlayScreen');
                    }
                }
            }
        }
    } 
    // XXX update the event log
    logEvent("Undo button pressed!");  
}   

document.getElementById('undoBtn').addEventListener('click', undoEvent);

/******************************************************************************/
/********************************** Send Audio  *******************************/
/******************************************************************************/
const OPENAI_API_KEY = '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'; // XXX move this out of client code later for security



/* 
const ws = new WebSocket('ws://3.212.138.180:7538/audio_stream');

ws.onopen = () => {
    console.log('WebSocket connection established');
};

ws.onclose = () => {
    console.log('WebSocket closed');
};

ws.onerror = error => {
    console.error('WebSocket error:', error);
};

ws.onmessage = event => {
    console.log('Message from server:', event.data);
};
 */
/******************************************************************************/
/********************************** Game Events *******************************/
/******************************************************************************/
// After DOM objects sufficiently loaded, bind checkPlayerCount to run
// whenever a player's checkbox is clicked
const activePlayersTableMain = document.getElementById('activePlayersTable');
if (activePlayersTableMain) {
    activePlayersTableMain.addEventListener('change', checkPlayerCount);
    activePlayersTableMain.addEventListener('change', function(event) {
    if (event.target.type === 'checkbox' && document.body.classList.contains('next-line-mode')) {
        captureNextLineSelections();
    }
});
}
const playersOnFieldInputMain = document.getElementById('playersOnFieldInput');
if (playersOnFieldInputMain) {
    playersOnFieldInputMain.addEventListener('input', checkPlayerCount);
}

// Initialize header state on page load
document.addEventListener('DOMContentLoaded', function() {
    // Set initial header state based on starting screen
    const headerElement = document.querySelector('header');
    const simpleModeToggle = document.querySelector('.simple-mode-toggle');
    
    // Start with full header and hidden toggle since we start on team select
    headerElement.classList.add('header-full');
    headerElement.classList.remove('header-compact');
    simpleModeToggle.classList.add('hidden');
    
    // Initialize Simple Mode toggle to checked state (since it's now the default)
    document.getElementById('simpleModeToggle').checked = window.isSimpleMode;
    
    // Initial display of countdown timer
    document.getElementById('countdownTimer').style.display = 'none';
    
    // Match button widths
    matchButtonWidths();
    setTimeout(matchButtonWidths, 100);
});

// Commenting out audio narration code for now
// import AudioNarrationService from './audioNarration.js';
// let audioNarration = null;
// function initializeAudioNarration() {
//     audioNarration = new AudioNarrationService(
//         gameState,
//         eventLog
//     );
// }

/******************************************************************************/
/**************************** Countdown Timer *********************************/
/******************************************************************************/
function updateTimerDisplay(seconds) {
    const display = document.getElementById('timerDisplay');
    const minutes = Math.floor(Math.abs(seconds) / 60);
    const remainingSeconds = Math.abs(seconds) % 60;
    const sign = seconds < 0 ? '-' : '';
    display.textContent = `${sign}${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
    
    // Update color based on remaining time
    display.className = '';
    if (seconds < 0) {
        display.classList.add('timer-danger');
    } else if (seconds <= 30) {
        display.classList.add('timer-warning');
    } else {
        display.classList.add('timer-normal');
    }
}

function startCountdown() {
    // Show the timer when starting countdown
    document.getElementById('countdownTimer').style.display = 'flex';

    // Clear any existing interval
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
    
    let timeRemaining = countdownSeconds;
    isCountdownRunning = true;
    
    updateTimerDisplay(timeRemaining);
    
    countdownInterval = setInterval(() => {
        timeRemaining--;
        updateTimerDisplay(timeRemaining);
    }, 1000);
}

function stopCountdown() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    isCountdownRunning = false;
    // Hide the timer when stopping countdown
    document.getElementById('countdownTimer').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
    // Hide countdown timer initially
    document.getElementById('countdownTimer').style.display = 'none';
    
    // Match button widths
    matchButtonWidths();
    setTimeout(matchButtonWidths, 100);
});

 

// Simple Mode Event Handlers
document.getElementById('weScoreBtn').addEventListener('click', function() {
    // Immediately stop the timer when "We Score" is pressed
    if (currentPoint && currentPoint.startTimestamp) {
        currentPoint.totalPointTime += (new Date() - currentPoint.startTimestamp);
        currentPoint.startTimestamp = null;
    }
    showScoreAttributionDialog();
});

document.getElementById('theyScoreBtn').addEventListener('click', function() {
    // Immediately stop the timer when "They Score" is pressed
    if (currentPoint && currentPoint.startTimestamp) {
        currentPoint.totalPointTime += (new Date() - currentPoint.startTimestamp);
        currentPoint.startTimestamp = null;
    }
    updateScore(Role.OPPONENT);
    moveToNextPoint();
});

// Track selected players for score attribution
let selectedThrower = null;
let selectedReceiver = null;

// Track Key Play dialog state
let keyPlaySelectedSubButtons = [];
let keyPlaySelectedThrower = null;
let keyPlaySelectedReceiver = null;
let keyPlayCurrentRole = 'thrower'; // 'thrower' or 'receiver'

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

// Callahan button handler
document.getElementById('callahanBtn').addEventListener('click', function() {
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

// Skip button handler
document.getElementById('skipAttributionBtn').addEventListener('click', function() {
    const dialog = document.getElementById('scoreAttributionDialog');
    updateScore(Role.TEAM);
    dialog.style.display = 'none';
    moveToNextPoint();
});

// Close dialog when clicking the X
document.querySelector('#scoreAttributionDialog .close').addEventListener('click', function() {
    document.getElementById('scoreAttributionDialog').style.display = 'none';
});

// Close dialog when clicking outside
window.addEventListener('click', function(event) {
    const dialog = document.getElementById('scoreAttributionDialog');
    if (event.target === dialog) {
        dialog.style.display = 'none';
    }
});

// Key Play Dialog Event Handlers
document.getElementById('keyPlayBtn').addEventListener('click', function() {
    showKeyPlayDialog();
});

// Close Key Play dialog when clicking the X
document.querySelector('#keyPlayDialog .close').addEventListener('click', function() {
    document.getElementById('keyPlayDialog').style.display = 'none';
});

// Close Key Play dialog when clicking outside
window.addEventListener('click', function(event) {
    const dialog = document.getElementById('keyPlayDialog');
    if (event.target === dialog) {
        dialog.style.display = 'none';
    }
});

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
    if (!playerHeader.hasAttribute('data-toggle-listener-added')) {
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
}

function updateKeyPlayPlayerHeader(subButtonType, panelType) {
    const header = document.getElementById('keyPlayPlayerHeader');
    
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

// Simple Mode Toggle
window.isSimpleMode = window.isSimpleMode ?? true;

document.getElementById('simpleModeToggle').addEventListener('change', function() {
    window.isSimpleMode = this.checked;
    
    // If we're in next line selection mode, exit it first
    if (document.body.classList.contains('next-line-mode')) {
        exitNextLineSelectionMode();
    }
    
    // Find which screen is currently visible
    let currentScreenId = null;
    for (const screen of screens) {
        if (screen && screen.style.display !== 'none') {
            currentScreenId = screen.id;
            break;
        }
    }
    
    // Only process screen transitions if we're on a play-by-play screen
    if (playByPlayScreenIds.includes(currentScreenId)) {
        if (window.isSimpleMode) {
            // When switching to simple mode, keep existing possession data
            showScreen('simpleModeScreen');
            
            // Make sure point timer is running
            if (currentPoint && !currentPoint.startTimestamp) {
                currentPoint.startTimestamp = new Date();
            }
        } else {
            // When switching back to detailed mode, determine which screen to show
            if (!currentPoint) {
                console.warn("No current point when toggling from simple mode");
                return;
            }
            
            // Check if we have any possessions in this point
            if (currentPoint.possessions.length > 0) {
                // Check if the latest possession is offensive or defensive
                const latestPossession = currentPoint.possessions[currentPoint.possessions.length - 1];
                if (latestPossession.offensive) {
                    updateOffensivePossessionScreen();
                    showScreen('offensePlayByPlayScreen');
                } else {
                    updateDefensivePossessionScreen();
                    showScreen('defensePlayByPlayScreen');
                }
            } else {
                // No possessions yet, use the starting position of the point
                if (currentPoint.startingPosition === 'offense') {
                    // Create the first possession as offensive
                    currentPoint.addPossession(new Possession(true));
                    updateOffensivePossessionScreen();
                    showScreen('offensePlayByPlayScreen');
                } else {
                    // Create the first possession as defensive
                    currentPoint.addPossession(new Possession(false));
                    updateDefensivePossessionScreen();
                    showScreen('defensePlayByPlayScreen');
                }
            }
        }
    }
});

function updateGameSummaryRosterDisplay() {
    const rosterElement = document.getElementById('gameSummaryRosterList');
    rosterElement.innerHTML = '';  // Clear existing rows

    // Calculate stats from current game events
    const eventStats = currentGame() ? calculatePlayerStatsFromEvents(currentGame()) : {};

    // Add header row
    let headerRow = document.createElement('tr');
    ['Name', 'Pts', 'Time', 'Goals', 'Assists', 'Comp%', 'Huck%', 'Ds', 'TOs', '+/-', '..per pt'].forEach(headerText => {
        let headerCell = document.createElement('th');
        headerCell.textContent = headerText;
        headerCell.classList.add('roster-header');
        headerRow.appendChild(headerCell);
    });
    rosterElement.appendChild(headerRow);

    currentTeam.teamRoster.forEach(player => {
        let playerRow = document.createElement('tr');

        // Player name column
        let nameCell = document.createElement('td');
        nameCell.classList.add('roster-name-column');
        nameCell.textContent = player.name;
        playerRow.appendChild(nameCell);

        // Total points played column
        let totalPointsCell = document.createElement('td');
        totalPointsCell.classList.add('roster-points-column');
        totalPointsCell.textContent = player.totalPointsPlayed;
        playerRow.appendChild(totalPointsCell);

        // Total time played column
        let totalTimeCell = document.createElement('td');
        totalTimeCell.classList.add('roster-time-column');
        totalTimeCell.textContent = formatPlayTime(player.totalTimePlayed);
        playerRow.appendChild(totalTimeCell);

        // Goals column
        let goalsCell = document.createElement('td');
        goalsCell.classList.add('roster-goals-column');
        goalsCell.textContent = player.goals || 0;
        playerRow.appendChild(goalsCell);

        // Assists column
        let assistsCell = document.createElement('td');
        assistsCell.classList.add('roster-assists-column');
        assistsCell.textContent = player.assists || 0;
        playerRow.appendChild(assistsCell);

        // Get calculated stats for this player
        const playerStats = eventStats[player.name] || {};

        // Completion percentage column
        let compPctCell = document.createElement('td');
        compPctCell.classList.add('roster-comppct-column');
        const compPct = playerStats.totalThrows > 0
            ? ((playerStats.completions / playerStats.totalThrows) * 100).toFixed(0)
            : '-';
        compPctCell.textContent = compPct !== '-' ? `${compPct}%` : compPct;
        playerRow.appendChild(compPctCell);

        // Huck completion percentage column
        let huckPctCell = document.createElement('td');
        huckPctCell.classList.add('roster-huckpct-column');
        const huckPct = playerStats.totalHucks > 0
            ? ((playerStats.huckCompletions / playerStats.totalHucks) * 100).toFixed(0)
            : '-';
        huckPctCell.textContent = huckPct !== '-' ? `${huckPct}%` : huckPct;
        playerRow.appendChild(huckPctCell);

        // Ds column
        let dPlaysCell = document.createElement('td');
        dPlaysCell.classList.add('roster-dplays-column');
        dPlaysCell.textContent = playerStats.dPlays || 0;
        playerRow.appendChild(dPlaysCell);

        // Turnovers column
        let turnoversCell = document.createElement('td');
        turnoversCell.classList.add('roster-turnovers-column');
        turnoversCell.textContent = playerStats.turnovers || 0;
        playerRow.appendChild(turnoversCell);

        // Plus/Minus column
        let plusMinusCell = document.createElement('td');
        plusMinusCell.classList.add('roster-plusminus-column');
        const plusMinus = (player.pointsWon || 0) - (player.pointsLost || 0);
        plusMinusCell.textContent = plusMinus > 0 ? `+${plusMinus}` : plusMinus;
        playerRow.appendChild(plusMinusCell);

        // Plus/Minus per point column
        let plusMinusPerPointCell = document.createElement('td');
        plusMinusPerPointCell.classList.add('roster-plusminus-per-point-column');
        const plusMinusPerPoint = player.totalPointsPlayed > 0
            ? (plusMinus / player.totalPointsPlayed).toFixed(2)
            : '0.0';
        plusMinusPerPointCell.textContent = plusMinusPerPoint > 0 ? `+${plusMinusPerPoint}` : plusMinusPerPoint;
        playerRow.appendChild(plusMinusPerPointCell);

        // Append row to the table
        rosterElement.appendChild(playerRow);
    });
}

