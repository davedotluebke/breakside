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
 */
// A list of all our main screens
const screens = [
    document.getElementById('selectTeamScreen'), 
    document.getElementById('teamRosterScreen'),
    document.getElementById('beforePointScreen'),
    document.getElementById('offensePlayByPlayScreen'),
    document.getElementById('defensePlayByPlayScreen'),
    document.getElementById('gameSummaryScreen')
];

// Function to handle screen transitions
function showScreen(screenId) {
    // Hide all screens first
    screens.forEach(screen => screen.style.display = 'none');

    // Display the desired screen
    const targetScreen = document.getElementById(screenId);
    targetScreen.style.display = 'block';
}

/*
 * Data structures for game tracking
 */
const Role = {
    TEAM: "team",
    OPPONENT: "opponent",
};

// Player data structure
function Player(name, nickname = "") {
    this.name = name;
    this.nickname = nickname;
    this.totalPointsPlayed = 0;
    this.consecutivePointsPlayed = 0;
    this.totalTimePlayed = 0;  // in milliseconds
    this.completedPasses = 0;
    this.turnovers = 0;
    this.goals = 0;
    this.assists = 0;
    this.pointsWon = 0;
    this.pointsLost = 0;
}

// Game data structure; includes a list of 'points'
function Game(teamName, opponentName, startOn) {
    this.team = teamName;
    this.opponent = opponentName;
    this.startingPosition = startOn;
    this.scores = {
        [Role.TEAM]: 0,
        [Role.OPPONENT]: 0,
    };
    this.points = [];  // An array of Point objects
    this.gameStartTimestamp = new Date();
    this.gameEndTimestamp = null;
    this.pointsData = [];  // New property: Array of objects. Each object will have player names as keys and true/false as values.
}

// Team data structure
function Team(name = "My Team", initialRoster = []) {
    this.name = name;
    this.games = [];  // array of Games played by this team
    this.teamRoster = []; // array of Players on the team
    initialRoster.forEach(name => {
        let newPlayer = new Player(name);
        this.teamRoster.push(newPlayer);
    });
}

class Event {
    constructor(type) {
        this.type = type;
    }

    // Default summarize method for generic events
    summarize() {
        return `Event of type: ${this.type}`;
    }
}

class Throw extends Event {
    constructor({thrower = "voidthrower", receiver = "voidreceiver", huck = false, breakmark = false, dump = false, hammer = false, sky = false, layout = false, score = false}) {
        super('Throw');
        this.thrower = thrower;
        this.receiver = receiver;
        this.huck_flag = huck;
        this.breakmark_flag = breakmark;
        this.dump_flag = dump;
        this.hammer_flag = hammer;
        this.sky_flag = sky;
        this.layout_flag = layout;
        this.score_flag = score;
    }

    // Override summarize for Throw events
    summarize() {
        let verb = `${this.huck_flag ? 'hucks' : 'throws'}`;
        let summary = `${this.thrower.name} ${verb} `;
        let throwType = '';
        let receiver = this.receiver ? this.receiver.name : '';
        if (this.breakmark_flag)    { throwType += 'breakmark '; }
        if (this.hammer_flag)       { throwType += 'hammer '; }
        if (this.dump_flag)         { throwType += 'dump '; }
        if (throwType)              { summary += `a ${throwType} `; }
        if (receiver)               { summary += `to ${this.receiver.name} `; }
        if (this.sky_flag || this.layout_flag) {
            summary += `for a ${this.sky_flag ? "sky":""} {this.layout_flag ? "layout":""} catch`;
        }        
        if (this.score_flag) summary += ' for the score!';

        return summary;
    }
}

class Turnover extends Event {
    constructor({thrower = null, receiver = null, throwaway = false, huck = false, receiverError = false, goodDefense = false, stall = false}) {
        super('Turnover');
        this.thrower = thrower;
        this.receiver = receiver;
        this.throwaway_flag = throwaway;
        this.huck_flag = huck;
        this.receiverError_flag = receiverError;
        this.goodDefense_flag = goodDefense;
        this.stall_flag = stall;
    }
    // Override summarize for Turnover events
    summarize() {
        const t = this.thrower ? this.thrower.name : "voidthrower"
        const r = this.receiver ? this.receiver.name : "voidreceiver"
        const hucktxt = this.huck_flag ? 'on a huck' : '';
        const defensetxt = this.goodDefense_flag ? 'due to good defense' : '';
        if (this.throwaway_flag)    { return `${t} throws it away ${hucktxt} ${defensetxt}`; }
        if (this.receiverError_flag){ return `${r} misses the catch from ${t} ${hucktxt} ${defensetxt}`; }
        if (this.goodDefense_flag)  { return `Turnover ${defensetxt}`; }
        if (this.stall_flag)        { return `${t} gets stalled ${defensetxt}`; }
    }
}

class FoulViolation extends Event {
    constructor({offensive = false, strip = false, pick = false, travel = false, contested = false, doubleTeam = false}) {
        super('Foul/Violation');
        this.offensive_flag = offensive;
        this.strip_flag = strip;
        this.pick_flag = pick;
        this.travel_flag = travel;
        this.contested_flag = contested;
        this.doubleTeam_flag = doubleTeam;
    }

    summarize() {
        let summary = 'Foul/Violation called: ';
        if (this.offensive_flag)        { summary += 'Offensive foul '; }
        if (this.strip_flag)            { summary += 'Strip '; }
        if (this.pick_flag)             { summary += 'Pick '; }
        if (this.travel_flag)           { summary += 'Travel '; }
        if (this.contested_flag)        { summary += 'Contested foul '; }
        if (this.doubleTeam_flag)       { summary += 'Double team '; }
        return summary;
    }
}

class Defense extends Event {
    constructor({defender = null, interception = false, layout = false, sky = false, Callahan = false, turnover = true}) {
        super('Defense');
        this.defender = defender;
        this.interception_flag = interception;
        this.layout_flag = layout;
        this.sky_flag = sky;
        this.Callahan_flag = Callahan;
        this.turnover_flag = turnover;
    }

    summarize() {
        let summary = '';
        let defender = this.defender ? this.defender.name : '';
        if (this.interception_flag)     { summary += 'Interception '; }
        if (this.layout_flag)           { summary += 'Layout D '; }
        if (this.sky_flag)              { summary += 'Sky D '; }
        if (this.Callahan_flag)         { summary += 'Callahan'; }
        if (summary && defender)        { summary += `by ${defender}`; }
        if (this.turnover_flag)         { summary += `Turnover ${defender ? "caused by " + defender : ""}`; }
        return summary;
    }
}

class Other extends Event {
    constructor(type) {
        super('Other');
        this.subtype = type; // Time-out, Injury sub, time cap
    }
}

class Possession {
    constructor(offensive) {
        this.offensive = offensive; // true for offensive, false for defensive
        this.events = [];
    }

    addEvent(event) {
        this.events.push(event);
    }
}

class Point {
    constructor(playingPlayers, startOn) {
        this.possessions = [];
        this.players = playingPlayers;  // An array of player names who played the point
        this.startingPosition = startOn;  // Either 'offense' or 'defense'
        this.winner = "";  // Either 'team' or 'opponent'     
        this.startTimestamp = null;
        this.endTimestamp = null;
    }

    addPossession(possession) {
        this.possessions.push(possession);
    }
}

// Given a player name, return the corresponding Player object from the team roster
function getPlayerFromName(playerName) {
    return currentTeam.teamRoster.find(player => player.name === playerName);
}

/*
 * Saving and loading team data
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

function serializeTeam(team) {
    // Simplify the team and game objects into serializable objects
    const simplifiedGames = team.games.map(game => ({
        ...game,
        gameStartTimestamp: game.gameStartTimestamp.toISOString(),
        gameEndTimestamp: game.gameEndTimestamp ? game.gameEndTimestamp.toISOString() : null,
        points: game.points.map(point => ({
            ...point,
            startTimestamp: point.startTimestamp ? point.startTimestamp.toISOString() : null,
            endTimestamp: point.endTimestamp ? point.endTimestamp.toISOString() : null,
            possessions: point.possessions.map(possession => ({
                ...possession,
                events: possession.events.map(serializeEvent)
            }))
        }))
    }));

    return JSON.stringify({
        ...team,
        games: simplifiedGames
    }, null, 4);
}

function logTeamData(team) {
    console.log("Team data: ");
    console.log(team);
    console.log("Serialized team data: ");
    console.log(serializeTeam(team));
}

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
        case 'Foul/Violation': event = new FoulViolation({ /* default parameters */ }); break;
        case 'Defense': event = new Defense({ /* default parameters */ }); break;
        case 'Other': event = new Other(eventData.subtype); break;
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

function deserializeTeams(serializedTeamsData) {
    const teamsData = JSON.parse(serializedTeamsData);
    return teamsData.map(deserializeSingleTeam); // Each item is an object, not a string
}

function deserializeSingleTeam(data) {
    // Create a new Team instance
    const team = new Team(data.name);
    currentTeam = team;

    // Reconstruct Player instances
    data.teamRoster.forEach(playerData => {
        const player = new Player(playerData.name);
        // Reassign other properties
        for (const key in playerData) {
            if (playerData.hasOwnProperty(key) && key !== 'name') {
                player[key] = playerData[key];
            }
        }
        team.teamRoster.push(player);
    });

    // Reconstruct Game instances and other nested structures
    data.games.forEach(gameData => {
        const game = new Game(gameData.team, gameData.opponent, gameData.startingPosition);
        // Reassign other properties

        gameData.points.forEach(pointData => {
            const point = new Point(pointData.players, pointData.startingPosition);

            pointData.possessions.forEach(possessionData => {
                const possession = new Possession(possessionData.offensive);

                possessionData.events.forEach(eventData => {
                    const event = deserializeEvent(eventData);
                    possession.addEvent(event);
                });

                point.addPossession(possession);
            });

            game.points.push(point);
        });

        team.games.push(game);
    });

    return team;
}

function initializeTeams() {
    // load teams from local storage or create a sample team
    loadTeams({ silent: true })
    if (teams.length === 0) {
        const sampleNames = ["Cyrus L","Leif","Cesc","Cyrus J","Abby","Avery","James","Simeon","Soren","Walden"];
        sampleTeam = new Team("Sample Team", sampleNames);  // A sample team with 10 players
        teams.push(sampleTeam);         // Add the sample team to the teams array
    }
    currentTeam = teams[0];         // there will be at least one team in the array
}
/*
 * Globals
 */
let teams = [];                 // An array of teams
let currentTeam = null;         // The current team being tracked
let sampleTeam = null;          // A sample team with 10 players, used if no teams are found
initializeTeams();              // Load teams from local storage or create a sample team

let currentPoint = null;        // This will hold the current point being played
let currentEvent = null;        // ...the current event taking place in the current possession
let currentPlayer = null;       // ...the current player with the disc


/* 
 * Utility functions
 */
// Get the current game
function currentGame() {
    if (currentTeam.games.length === 0) {
        throw new Error("No current game");
    }
    return currentTeam.games[currentTeam.games.length - 1];
}

// Get the current possession (the last one in the current point); error if none
function getActivePossession(activePoint) {
    if (! activePoint) {
        throw new Error("No active point");
    }
    if (activePoint.possessions.length === 0) {
        throw new Error("No possessions in active point");
    }
    return activePoint.possessions[activePoint.possessions.length - 1];
}

// print playing time in mm:ss format
function formatPlayTime(totalTimePlayed) {
    const timeDifferenceInMilliseconds = totalTimePlayed;
    const timeDifferenceInSeconds = Math.floor(timeDifferenceInMilliseconds / 1000);
    const minutes = Math.floor(timeDifferenceInSeconds / 60);
    const seconds = timeDifferenceInSeconds % 60;
    // Function to format a number as two digits with leading zeros
    const formatTwoDigits = (num) => (num < 10 ? `0${num}` : num);
    return `${formatTwoDigits(minutes)}:${formatTwoDigits(seconds)}`;
}

/************************************************************************ 
 *
 *   BEFORE POINT SCREEN
 *   TEAM ROSTER TABLE 
 * 
 ************************************************************************/
// Open up with the "Select Your Team" screen
showSelectTeamScreen(true);

function showSelectTeamScreen(firsttime = false) {
    const teamListElement = document.getElementById('teamList');
    const teamListWarning = document.getElementById('teamListWarning');
    teamListElement.innerHTML = ''; // Clear current list

    // assume teams global already populated
    if (teams.length === 0 || teams.length === 1 && teams[0].name === "Sample Team") {
        teamListWarning.style.display = 'block'; // Show warning if no teams are found
    } else {
        teamListWarning.style.display = 'none'; // Hide warning otherwise
    }

    teams.forEach((team, index) => {
        let teamItem = document.createElement('li');
        teamItem.textContent = team.name;
        teamItem.onclick = () => selectTeam(index);
        teamListElement.appendChild(teamItem);
    });

    showScreen('selectTeamScreen');
}

// Handle team selection
function selectTeam(index) {
    currentTeam = teams[index]; // assumes teams global already populated
    updateTeamRosterDisplay(); // Update the roster display
    showScreen('teamRosterScreen'); // Go back to the roster screen
}

// Event listeners for relevant  buttons
document.getElementById('switchTeamsBtn').addEventListener('click', showSelectTeamScreen);
document.getElementById('createNewTeamBtn').addEventListener('click', () => {
    currentTeam = new Team(); // Create a new empty team
    teams.push(currentTeam); // Add it to the teams array
    updateTeamRosterDisplay(); // Update the display
    showScreen('teamRosterScreen'); // Return to the roster screen
});
document.getElementById('backToRosterScreenBtn').addEventListener('click', () => {
    showScreen('teamRosterScreen'); // Return to the roster screen
});

/************************************************************************ 
 *
 *   BEFORE GAME SCREEN
 *   TEAM ROSTER TABLE 
 * 
 ************************************************************************/

// Updates the displayed roster on the "Team Roster Screen"
function updateTeamRosterDisplay() {
    const rosterElement = document.getElementById('rosterList');
    rosterElement.innerHTML = '';  // Clear existing rows

    currentTeam.teamRoster.forEach(player => {
        let playerRow = document.createElement('tr');

        // Player name column
        let nameCell = document.createElement('td');
        nameCell.classList.add('roster-name-column');
        nameCell.textContent = player.name;

        // Total points played column
        let totalPointsCell = document.createElement('td');
        totalPointsCell.classList.add('roster-points-column');
        totalPointsCell.textContent = player.totalPointsPlayed;

        let totalTimeCell = document.createElement('td');
        totalTimeCell.classList.add('roster-time-column');
        totalTimeCell.textContent = formatPlayTime(player.totalTimePlayed);

        // Append cells to the row
        playerRow.appendChild(nameCell);
        playerRow.appendChild(totalPointsCell);
        playerRow.appendChild(totalTimeCell);

        // Append row to the table body
        rosterElement.appendChild(playerRow);
    });
}
updateTeamRosterDisplay();

// Handling player addition to teamRoster
document.getElementById('addPlayerBtn').addEventListener('click', function() {
    const playerNameInput = document.getElementById('newPlayerInput');
    const playerName = playerNameInput.value.trim();

    if (playerName && !currentTeam.teamRoster.some(player => player.name === playerName)) {
        let newPlayer = new Player(playerName);
        currentTeam.teamRoster.push(newPlayer);
        updateTeamRosterDisplay();
    }
    playerNameInput.value = '';
});
// Also accept an Enter keypress to add a player
const playerNameInput = document.getElementById('newPlayerInput');
playerNameInput.addEventListener('keydown', function(event) {
    if (event.key === "Enter") {
        document.getElementById('addPlayerBtn').click();
    }
});

// Restoring team data from local storage
document.getElementById('restoreGamesBtn').addEventListener('click', function() {
    loadTeams();
    if (teams.length > 0) {
        currentTeam = teams[0];
        updateTeamRosterDisplay();
        showSelectTeamScreen();
    }
    logTeamData(currentTeam);
});

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
// Clearing games from local storage
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


/************************************************************************ 
 *
 *   BEFORE POINT SCREEN
 *   ACTIVE PLAYERS TABLE 
 * 
 ************************************************************************/

// Updates the displayed roster on the "Before Point Screen"
function updateActivePlayersList() {
    let table = document.getElementById('activePlayersTable');
    let tableBody = table.querySelector('tbody');
    let tableHead = table.querySelector('thead');

    // Clear existing rows in the table body and head
    tableBody.innerHTML = '';
    tableHead.innerHTML = '';

    // Create header rows for scores
    let teamScoreRow = document.createElement('tr');
    let opponentScoreRow = document.createElement('tr');

    // Function to add cells to the score rows
    const addScoreCells = (row, teamName, scores) => {
        let nameCell = document.createElement('th');
        nameCell.textContent = teamName;
        nameCell.setAttribute('colspan', '3');  // merge with time column in header row
        nameCell.setAttribute('text-align', 'center');
        nameCell.classList.add('active-header-teams');
        row.appendChild(nameCell);
        scores.forEach(score => {
            let scoreCell = document.createElement('th');
            scoreCell.textContent = score;
            row.appendChild(scoreCell);
        });
    };

    // Calculate and add score cells
    let runningScores = { team: [0], opponent: [0] };
        currentGame().points.forEach(point => {
        runningScores.team.push(point.winner === 'team' ? runningScores.team.slice(-1)[0] + 1 : runningScores.team.slice(-1)[0]);
        runningScores.opponent.push(point.winner === 'opponent' ? runningScores.opponent.slice(-1)[0] + 1 : runningScores.opponent.slice(-1)[0]);
    });

    addScoreCells(teamScoreRow, currentGame().team, runningScores.team);
    addScoreCells(opponentScoreRow, currentGame().opponent, runningScores.opponent);

    // Add score rows to the head
    tableHead.appendChild(teamScoreRow);
    tableHead.appendChild(opponentScoreRow);

    // Determine players from the last point
    const lastPointPlayers = currentGame().points.length > 0
        ? currentGame().points[currentGame().points.length - 1].players
        : [];

    // Check if a player has played any points
    function hasPlayedAnyPoints(playerName) {
        return currentGame().points.some(point => point.players.includes(playerName));
    }

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

    // Add player rows
    currentTeam.teamRoster.forEach(player => {
        const row = document.createElement('tr');

        // Checkbox cell
        let checkboxCell = document.createElement('td');
        checkboxCell.classList.add('active-checkbox-column');
        let checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        if (lastPointPlayers.includes(player.name)) {
            checkbox.checked = true;
        }
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);

        // Player name cell
        let nameCell = document.createElement('td');
        nameCell.classList.add('active-name-column');
        nameCell.textContent = player.name;
        row.appendChild(nameCell);

        // Player time cell
        let timeCell = document.createElement('td');
        timeCell.classList.add('active-time-column');
        timeCell.textContent = formatPlayTime(player.totalTimePlayed);
        row.appendChild(timeCell);

        // Points data cells
        let runningPointTotal = 0;
        currentGame().points.forEach(point => {
            let pointCell = document.createElement('td');
            pointCell.classList.add('active-points-columns');

            if (point.players.includes(player.name)) {
                runningPointTotal++;
                pointCell.textContent = runningPointTotal.toString();
            } else {
                pointCell.textContent = '-';
            }

            row.appendChild(pointCell);
        });

        tableBody.appendChild(row);
    });
    // After adding all rows to the tableBody, calculate the widths
    makeColumnsSticky();
}
/*
 * Make left 3 columns "sticky", calculating widths to set left offsets, 
 * and scroll table all the way right so the latest points are visible.
 */
function makeColumnsSticky() {
    // Below assumes all checkbox & name cells will have the same width
    const checkboxCells = document.querySelectorAll('.active-checkbox-column');
    let checkboxCellWidth = checkboxCells[0].getBoundingClientRect().width + 1;  // 1-pixel border each side
    
    const nameCells = document.querySelectorAll('.active-name-column');
    let nameCellWidth = nameCells[0].getBoundingClientRect().width + 1;  // 1-pixel border each side
    // Update the second sticky colun's left offset
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
    let tableContainer = document.getElementById('tableContainer');
    tableContainer.scrollLeft = tableContainer.scrollWidth;
}


// Show start-next-point button with warning style if wrong # of players selected
function checkPlayerCount() {
    const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
    const selectedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput').value, 10);

    const startPointBtn = document.getElementById('startPointBtn');
    if (selectedCount !== expectedCount) {
        startPointBtn.classList.add('warning');
    } else {
        startPointBtn.classList.remove('warning');
    }
}

// Starting a new game, on O or D
function startNewGame(startingPosition) {
    const opponentNameInput = document.getElementById('opponentNameInput');
    const opponentName = opponentNameInput.value.trim() || "them";

    let newGame = new Game(currentTeam.name, opponentName, startingPosition);
    currentTeam.games.push(newGame);
    logEvent(`Starting new game vs ${opponentName} on ${startingPosition}:`);
    moveToNextPoint();
}
document.getElementById('startGameOnOBtn').addEventListener('click', function() {
    startNewGame('offense');
});

document.getElementById('startGameOnDBtn').addEventListener('click', function() {
    startNewGame('defense');
});

// Transition from Play-by-Play to Before Point when either team scores
function moveToNextPoint() {
    updateActivePlayersList();
    showScreen('beforePointScreen');
    // once the table is rendered, make the left columns sticky
    makeColumnsSticky();
    // (could call window.requestAnimationFrame(makeColumnsSticky) to force a render, shouldn't be needed)
}

// Transition from Before Point to Play-by-Play
function startNextPoint() {
    // Get the checkboxes and player names
    let checkboxes = [...document.querySelectorAll('#activePlayersTable input[type="checkbox"]')];

    let activePlayersForThisPoint = [];
    checkboxes.forEach((checkbox, index) => {
        if (checkbox.checked) {
            //  this code works because we re-sort the actual team roster after 
            //  each point in updateActivePlayersList():
            let player = currentTeam.teamRoster[index];  
            activePlayersForThisPoint.push(player.name);
        }
    });
    logEvent("Active players for this point: " + activePlayersForThisPoint);

    // Create a new Point with the active players 
    // Don't set the winning team yet
    // Don't set startTimeStamp yet, wait till first player touches the disc
    let startPointOn = "";
    if (currentGame().points.length === 0) {
        startPointOn = currentGame().startingPosition;
    } else {
        startPointOn = currentGame().points[currentGame().points.length - 1].winner === Role.TEAM ? 'defense' : 'offense';
    } 
    currentPoint = new Point(activePlayersForThisPoint, startPointOn);
    currentGame().points.push(currentPoint);
    if (startPointOn === 'offense') {
        updateOffensivePossessionScreen();
        showScreen('offensePlayByPlayScreen');
    } else {
        updateOffensivePossessionScreen();
        showScreen('defensePlayByPlayScreen');
        // For now start timing point on defense when the point starts
        if (currentPoint.startTimestamp === null) {
            currentPoint.startTimestamp = new Date();
        }
    }
}
document.getElementById('startPointBtn').addEventListener('click', startNextPoint);

// Handling scores and game end
function updateScore(winner) {
    if (winner !== Role.TEAM && winner !== Role.OPPONENT) {
        throw new Error("Invalid role");
    }

    if (currentPoint) {
        currentPoint.endTimestamp = new Date();
        currentPoint.winner = winner; // Setting the winning team for the current point
        currentGame().scores[winner]++;

        // Update player stats for those who played this point
        currentTeam.teamRoster.forEach(p => {
            if (currentPoint.players.includes(p.name)) { // the player played this point
                p.totalPointsPlayed++;
                p.consecutivePointsPlayed++;
                p.totalTimePlayed += currentPoint.endTimestamp - currentPoint.startTimestamp;
                if (winner === Role.TEAM) {
                    p.pointsWon++;
                } else {
                    p.pointsLost++;
                }
            } else {                                    // the player did not play this point
                p.consecutivePointsPlayed = 0;
            }
        });

        currentPoint = null;  // Reset the temporary point object
        currentEvent = null;  // Reset the temporary event object
        currentPlayer = null; // Reset the temporary player object
    } else {
        throw new Error("No current point");
    }

    updateActivePlayersList();  // Update the table with the new point data
}

/******************************************************************************/
/**************************** Offense play-by-play ****************************/
/******************************************************************************/
function logEvent(description) {
    const eventLog = document.getElementById('eventLog');
    eventLog.value += description + '\n'; // Append the description to the log
    eventLog.scrollTop = eventLog.scrollHeight; // Auto-scroll to the bottom
}

// remove and return the last line from the log
function popLogEvent() {  
    const eventLog = document.getElementById('eventLog');
    const logLines = eventLog.value.split('\n');
    lastLine = logLines.pop();  // need to pop twice...last line is always blank
    lastLine = logLines.pop();  
    eventLog.value = logLines.join('\n') + '\n';  // re-add the final newline
    return lastLine;
}
/*
function setLastLogEvent(description) { 
    const eventLog = document.getElementById('eventLog');
    const logLines = eventLog.value.split('\n');
    logLines[logLines.length - 2] = description;
    eventLog.value = logLines.join('\n');
}
*/
function updateOffensivePossessionScreen() {
    displayOPlayerButtons();
    displayOActionButtons();
}

function displayOPlayerButtons() {
    // throw an error if there is no current point
    if (!currentPoint) {
        throw new Error("No current point");
    }
    let activePlayers = currentPoint.players; // Holds the names of active players

    let playerButtonsContainer = document.getElementById('offensivePlayerButtons');
    playerButtonsContainer.innerHTML = ''; // Clear existing buttons

    activePlayers.forEach(playerName => {
        let playerButton = document.createElement('button');
        playerButton.textContent = playerName;
        playerButton.classList.add('player-button'); // Add a class for styling
        playerButton.addEventListener('click', function() {
            handleOPlayerButton(playerName);
        });
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
        logEvent(playerName + " starts a new possession");
    }
    // if most recent event is a throw, mark this player as the receiver
    // (thrower will already be set)
    if (currentEvent && currentEvent instanceof Throw) {
        currentEvent.receiver = getPlayerFromName(playerName);
        logEvent(currentEvent.summarize());
    }
    // set currentPlayer to this player
    currentPlayer = getPlayerFromName(playerName);
}

function displayOActionButtons() {
    let actionButtonsContainer = document.getElementById('offensiveActionButtons');
    actionButtonsContainer.innerHTML = ''; // Clear existing buttons

    // Create and add action buttons
    let throwButton = document.createElement('button');
    throwButton.textContent = 'Throws to...';
    let huckButton = document.createElement('button');
    huckButton.textContent = 'Hucks to...';
    let throwawayButton = document.createElement('button');
    throwawayButton.textContent = 'Throws it away';
    let scoreButton = document.createElement('button');
    scoreButton.textContent = '..for the score!';
    let dropButton = document.createElement('button');
    dropButton.textContent = '..who drops it';
    // Add event listeners to these buttons
    throwButton.addEventListener('click', function() {
        currentEvent = new Throw({thrower: currentPlayer, receiver: null, huck: false, strike: false, dump: false, hammer: false, sky: false, layout: false, score: false});
        logEvent(currentEvent.summarize());
        showActionFlags('throw');
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPlayer.completedPasses++;
    });
    huckButton.addEventListener('click', function() {
        currentEvent = new Throw({thrower: currentPlayer, receiver: null, huck: true, strike: false, dump: false, hammer: false, sky: false, layout: false, score: false});
        logEvent(currentEvent.summarize());
        showActionFlags('huck');
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPlayer.completedPasses++;
    });
    throwawayButton.addEventListener('click', function() {
        // Create a new Turnover event and add it to the current possession
        currentEvent = new Turnover({thrower: currentPlayer, throwaway: true, receiverError: false, goodDefense: false, stall: false});
        logEvent(currentEvent.summarize());
        showActionFlags('throwaway');
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPossession = new Possession(false);
        currentPoint.addPossession(currentPossession);
        showScreen('defensePlayByPlayScreen');
    });
    scoreButton.addEventListener('click', function() {
        // Current event should be a throw; tag as score & update player stats
        showActionFlags('score'); // none currently
        if (currentEvent && currentEvent instanceof Throw) {
            currentEvent.score = true;
            currentEvent.receiver.goals++;
            currentEvent.thrower.assists++;
        } else {
            console.log("Warning: No current event or event is not a throw");
        }
        logEvent(currentEvent.summarize());
        updateScore(Role.TEAM);
        moveToNextPoint();
    });

    actionButtonsContainer.appendChild(throwButton);
    actionButtonsContainer.appendChild(huckButton);
    actionButtonsContainer.appendChild(throwawayButton);
    actionButtonsContainer.appendChild(scoreButton);
    // Append other action buttons similarly
}

// Action Flags are checkboxes that dynamically appear when an action is selected
function showActionFlags(actionType) {
    const actionFlagsContainer = document.getElementById('actionFlagsContainer');
    actionFlagsContainer.innerHTML = ''; // Clear current flags

    // Assuming getFlagsForAction returns an object with flag names and their current values
    const flags = getFlagsForAction();

    Object.keys(flags).forEach(flag => {
        const checkboxLabel = document.createElement('label');
        checkboxLabel.textContent = flag;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = flag;
        checkbox.checked = flags[flag]; // Set the checkbox state based on the currentEvent

        // Event listener to update the currentEvent when the checkbox is changed
        checkbox.addEventListener('change', (e) => {
            currentEvent[flag] = e.target.checked; // Set the event flag based on the checkbox state
        });

        checkboxLabel.appendChild(checkbox);
        actionFlagsContainer.appendChild(checkboxLabel);
    });
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

/******************************************************************************/
/**************************** Defense play-by-play ****************************/
/******************************************************************************/

// Defense play-by-play buttons
document.getElementById('theyScoreBtn').addEventListener('click', function() {
    updateScore(Role.OPPONENT);
    moveToNextPoint();
});

document.getElementById('theyTurnoverBtn').addEventListener('click', function() {
    let currentPossession = new Possession(true);
    currentPoint.addPossession(currentPossession);
    showScreen('offensePlayByPlayScreen');
});

document.getElementById('endGameBtn').addEventListener('click', function() {
    if (confirm('Are you sure you want to end the game?')) {
        currentGame().endTimestamp = new Date(); // Set end timestamp

        // Populate the gameSummaryScreen with statistics, then show it
        document.getElementById('teamName').textContent = currentGame().team;
        document.getElementById('teamFinalScore').textContent = currentGame().scores[Role.TEAM];
        document.getElementById('opponentName').textContent = currentGame().opponent;
        document.getElementById('opponentFinalScore').textContent = currentGame().scores[Role.OPPONENT];
        showScreen('gameSummaryScreen');
        saveAllTeamsData();
    }
});

// Start a new game from the Game Summary screen
document.getElementById('anotherGameBtn').addEventListener('click', function() {
    // Reset game data if needed here
    updateTeamRosterDisplay();
    showScreen('teamRosterScreen');
});

// After DOM objects sufficiently loaded, bind checkPlayerCount to run
// whenever a player's checkbox is clicked
document.getElementById('activePlayersTable').addEventListener('change', checkPlayerCount);
document.getElementById('playersOnFieldInput').addEventListener('input', checkPlayerCount);
