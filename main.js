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

    // In-game screens display a bottom panel with play-by-play textarea
    if (targetScreen.classList && targetScreen.classList.contains('in-game-content')) {
        document.getElementById('bottomPanel').style.display = 'flex';
    } else {
        document.getElementById('bottomPanel').style.display = 'none';
    }
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
    this.pointsData = [];  // Array of objects, each object will have player names as keys and true/false as values.
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
        this.break_flag = breakmark;
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
        if (this.break_flag)        { throwType += 'break '; }
        if (this.hammer_flag)       { throwType += 'hammer '; }
        if (this.dump_flag)         { throwType += 'dump '; }
        if (throwType)              { summary += `a ${throwType}`; }
        if (receiver)               { summary += `to ${this.receiver.name} `; }
        if (this.sky_flag || this.layout_flag) {
            summary += `for a ${this.sky_flag ? "sky ":""}${this.layout_flag ? "layout ":""}catch `;
        }        
        if (this.score_flag) summary += 'for the score!';

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
        this.drop_flag = receiverError;
        this.defense_flag = goodDefense;
        this.stall_flag = stall;
    }
    // Override summarize for Turnover events
    summarize() {
        const t = this.thrower ? this.thrower.name : "voidthrower"
        const r = this.receiver ? this.receiver.name : "voidreceiver"
        const hucktxt = this.huck_flag ? 'on a huck' : '';
        const defensetxt = this.defense_flag ? 'due to good defense' : '';
        if (this.throwaway_flag)    { return `${t} throws it away ${hucktxt} ${defensetxt}`; }
        if (this.drop_flag){ return `${r} misses the catch from ${t} ${hucktxt} ${defensetxt}`; }
        if (this.defense_flag)  { return `Turnover ${defensetxt}`; }
        if (this.stall_flag)        { return `${t} gets stalled ${defensetxt}`; }
    }
}

class Violation extends Event {
    constructor({offensive = false, strip = false, pick = false, travel = false, contested = false, doubleTeam = false}) {
        super('Violation');
        this.ofoul_flag = offensive;
        this.strip_flag = strip;
        this.pick_flag = pick;
        this.travel_flag = travel;
        this.contest_flag = contested;
        this.dblteam_flag = doubleTeam;
    }
    // Override summarize for Violation events  
    summarize() {
        let summary = 'Violation called: ';
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
    // Override summarize for Defense events
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
    constructor({timeout = null, injury = null, timecap = null, switchsides = null, halftime = null}) {
        super('Other');
        this.timeout_flag = timeout;
        this.injury_flag = injury;
        this.timecap_flag = timecap;
        this.switchsides_flag = switchsides;
        this.halftime_flag = halftime;
    }
    // Override summarize for Other events
    summarize() {
        let summary = '';
        if (this.timeout_flag)      { summary += 'Timeout called. '; }
        if (this.injury_flag)       { summary += 'Injury sub called '; }
        if (this.timecap_flag)      { summary += 'Hard cap called; game over '; }
        if (this.switchsides_flag)  { summary += 'O and D switch sides '; }
        if (this.halftime_flag)     { summary += 'Halftime '; }
        return summary;
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
 *   TEAM SELECTION SCREEN
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
 *   SELECT PLAYERS TABLE 
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
    const opponentName = opponentNameInput.value.trim() || "Bad Guys";

    let newGame = new Game(currentTeam.name, opponentName, startingPosition);
    currentTeam.games.push(newGame);
    logEvent(`New game started against ${opponentName}`);
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
    logEvent("New point started");
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

    // Create a new Point with the active players and starting position
    // Don't set the winning team yet
    // Don't set startTimeStamp yet, wait till first player touches the disc
    let startPointOn = "";
    if (currentGame().points.length === 0) {
        // First point of the game
        startPointOn = currentGame().startingPosition;
    } else {
        // Start on D if won last point, otherwise start on O
        const lastPoint = currentGame().points[currentGame().points.length - 1];
        startPointOn = lastPoint.winner === Role.TEAM ? 'defense' : 'offense';
        // if last poessession includes switchsides event, switch the starting position
        const lastPossession = lastPoint.possessions[lastPoint.possessions.length - 1];
        if (lastPossession.events.some(event => event.type === 'Other' && event.switchsides_flag)) {
            startPointOn = startPointOn === 'offense' ? 'defense' : 'offense';
        }
    } 
    currentPoint = new Point(activePlayersForThisPoint, startPointOn);
    currentGame().points.push(currentPoint);
    if (startPointOn === 'offense') {
        updateOffensivePossessionScreen();
        showScreen('offensePlayByPlayScreen');
    } else {
        updateDefensivePossessionScreen();
        showScreen('defensePlayByPlayScreen');
        // For now start possession and timing when D points start
        currentPoint.addPossession(new Possession(false));
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
    summarizeGame();
    updateActivePlayersList();  // Update the table with the new point data
}

/******************************************************************************/
/************************ Event logging & game summary ************************/
/******************************************************************************/

function summarizeGame() {
    summary = `Game Summary: ${currentGame().team} vs. ${currentGame().opponent}.\n`;
    summary += `${currentGame().team} roster:`;
    currentTeam.teamRoster.forEach(player => summary += ` ${player.name}`);
    numPoints = 0;
    runningScoreUs = 0;
    runningScoreThem = 0;
    currentGame().points.forEach(point => {
        let switchsides = false;
        numPoints += 1;
        summary += `\nPoint ${numPoints} roster:`;
        point.players.forEach(player => summary += ` ${player}`);
        // indicate which team pulls and which receives (thus starting on offense)
        if (point.startingPosition === 'offense') {
            summary += `\n${currentGame().opponent} pulls to ${currentGame().team}.`;
        } else {
            summary += `\n${currentGame().team} pulls to ${currentGame().opponent}.`;
        }
        point.possessions.forEach(possession => {
            possession.events.forEach(event => {
                summary += `\n${event.summarize()}`;
                if (event.type === 'Other' && event.switchsides_flag) {
                    switchsides = true;
                }
            })
        });
        // if most recent event is a score, indicate which team scored
        if (point.winner === 'team') {
            summary += `\n${currentGame().team} scores! `
            runningScoreUs++;
        } 
        if (point.winner === 'opponent') {
            summary += `\n${currentGame().opponent} scores! `
            runningScoreThem++;
        }
        if (point.winner) {
            summary += `\nCurrent score: ${currentGame().team} ${runningScoreUs}, ${currentGame().opponent} ${runningScoreThem}`; 
        }
        if (switchsides) {
            summary += `\nO and D switching sides for next point. `;
            if (point.winner === 'team') {
                summary += `\n${currentGame().team} will receive pull and play O. `;
            } else {
                summary += `\n${currentGame().team} will pull to ${currentGame().opponent} and play D. `;
            }
        }
    });
    console.log(summary); 
    return summary;
}

function logEvent(description) {
    console.log("Event: " + description);
    /* update the running event log on the screen */    
    const eventLog = document.getElementById('eventLog');
    eventLog.value = summarizeGame();           // Replace log with the new game summary
    eventLog.scrollTop = eventLog.scrollHeight; // Auto-scroll to the bottom
}

document.getElementById('toggleEventLogSpan').addEventListener('click', function() {
    var eventLog = document.getElementById('eventLog');
    var toggleIcon = document.getElementById('toggleEventLogIcon');

    // Check if the event log is currently visible
    if (eventLog.style.display === 'none') {
        eventLog.style.display = 'block'; // Show the event log
        toggleIcon.textContent = '[-]'; // Set the icon to 'collapse' indicator
    } else {
        eventLog.style.display = 'none'; // Hide the event log
        toggleIcon.textContent = '[+]'; // Set the icon to 'expand' indicator
    }
});


/******************************************************************************/
/**************************** Offense play-by-play ****************************/
/******************************************************************************/

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
    }
    // if most recent event is a throw: 
    if (currentEvent && currentEvent instanceof Throw) {
        // mark this player as the receiver (thrower will already be set)
        currentEvent.receiver = getPlayerFromName(playerName);
        if (! currentEvent.receiver) {
            console.log(`Warning: could not find player for receiver ${playerName}`);
        }
        logEvent(currentEvent.summarize()); 
        // close the Throw panel (maybe just clear sub-btn "selected" status instead?)
        showActionPanel('none');
        // Additional logic to handle scores (XXX add Callahan handling under Defense)
        if (currentEvent.score_flag) {
            currentEvent.receiver.goals++;
            currentEvent.thrower.assists++;
            updateScore(Role.TEAM);
            moveToNextPoint(); 
        }
    }
    // set currentPlayer to this player
    currentPlayer = getPlayerFromName(playerName);
}

function displayOActionButtons() {
    let actionButtonsContainer = document.getElementById('offensiveActionButtons');
    actionButtonsContainer.innerHTML = ''; // Clear existing buttons

    // Main action buttons
    const throwButton = document.createElement('button');
    throwButton.textContent = 'Throw';
    throwButton.classList.add('main-action-btn');
    throwButton.dataset.action = 'Throw'; // This will be used to identify which panel to toggle

    const turnoverButton = document.createElement('button');
    turnoverButton.textContent = 'Turnover';
    turnoverButton.classList.add('main-action-btn');
    turnoverButton.dataset.action = 'Turnover';

    const violationButton = document.createElement('button');
    violationButton.textContent = 'Violation';
    violationButton.classList.add('main-action-btn');
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

    // Add event listeners to these buttons
    throwButton.addEventListener('click', function() {
        currentEvent = new Throw({thrower: currentPlayer, receiver: null, huck: false, strike: false, dump: false, hammer: false, sky: false, layout: false, score: false});
        showActionPanel('throw');
        generateSubButtons('throw');
        logEvent(currentEvent.summarize());
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPlayer.completedPasses++;
    });
    turnoverButton.addEventListener('click', function() {
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
                updateOffensivePossessionScreen();
                showScreen('offensePlayByPlayScreen');
            } else {
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
}

function displayDPlayerButtons() {
    // throw an error if there is no current point
    if (!currentPoint) {
        throw new Error("No current point");
    }
    let activePlayers = currentPoint.players; // Holds the names of active players

    let playerButtonsContainer = document.getElementById('defensivePlayerButtons');
    playerButtonsContainer.innerHTML = ''; // Clear existing buttons

    activePlayers.forEach(playerName => {
        let playerButton = document.createElement('button');
        playerButton.textContent = playerName;
        playerButton.classList.add('player-button'); // Add a class for styling
        playerButton.classList.add('invalid'); // Player names can't be clicked at first
        playerButton.addEventListener('click', function() {
            handleDPlayerButton(playerName);
        });
        playerButtonsContainer.appendChild(playerButton);
    });
}

function handleDPlayerButton(playerName) {
     // Logic to handle click on a defensive player button 
        // XXX if button is marked invalid, ignore and return 
     // if most recent event is a defensive turnover:
     if (currentEvent && currentEvent instanceof Defense) {
        // mark this player as the defender
        currentEvent.defender = getPlayerFromName(playerName);
        if (! currentEvent.defender) {
            console.log(`Warning: could not find player for defender ${playerName}`);
        }
        logEvent(currentEvent.summarize());
        // XXX get player button, mark as 'selected' and unselect other players
     }
}

// XXX add function to mark all buttons as 'invalid' (unclickable)
// (to be made valid again when a defensive Turnover action is selected)

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

    // Add event listeners to these buttons
    dTurnoverButton.addEventListener('click', function() {
        // Create a new Defense event and add it to the current possession
        currentEvent = new Defense({defender: null, interception: false, layout: false, sky: false, Callahan: false, turnover: true});
        logEvent(currentEvent.summarize());
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);        
        showActionPanel('theyturnover');
        generateSubButtons('theyturnover');
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
                    currentGame.scores[currentPoint.winner]--;
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
/********************************** Game Events *******************************/
/******************************************************************************/
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

document.getElementById('switchSidesBtn').addEventListener('click', function() {
    // if no points exist yet, just change the Game.startingPosition flag
    if (currentGame().points.length === 0) {
        currentGame().startingPosition = currentGame().startingPosition === 'offense' ? 'defense' : 'offense';
        logEvent(`Switching starting position to ${currentGame().startingPosition}`);
    } else {
        // add Other event with switchsides flag set to current point
        currentEvent = new Other({switchsides: true});
        // find the most recent point and add the event to its final possession
        try {
            const lastPoint = currentGame().points[currentGame().points.length - 1];
            const lastPossession = lastPoint.possessions[lastPoint.possessions.length - 1];
            lastPossession.addEvent(currentEvent);
            logEvent(currentEvent.summarize());
        } catch (e) {
            logEvent("Error: could not find most recent point or possession to add switchsides event");
        }
    }
});

document.getElementById('timeOutBtn').addEventListener('click', function() {
    // create Other event with timeout flag set; append to most recent point
    currentEvent = new Other({timeout: true});
    let currentPossession = getActivePossession(currentPoint);
    currentPossession.addEvent(currentEvent);
    logEvent(currentEvent.summarize());
});

document.getElementById('halftimeBtn').addEventListener('click', function() {
    // create Other event with halftime flag set; append to most recent point
    currentEvent = new Other({halftime: true});
    let currentPossession = getActivePossession(currentPoint);
    currentPossession.addEvent(currentEvent);
    logEvent(currentEvent.summarize());
});


/******************************************************************************/
/**************************** Game summary & stats ****************************/
/******************************************************************************/

// Download a text file with the game data in JSON format
document.getElementById('downloadGameBtn').addEventListener('click', function() {
    const teamData = serializeTeam(currentTeam); // Assuming serializeTeam returns a JSON string
    downloadJSON(teamData, 'teamData.json');
});

function downloadJSON(jsonData, filename) {
    // Create a Blob with the JSON data
    const blob = new Blob([jsonData], {type: 'application/json'});
    // Create a URL for the blob
    const url = URL.createObjectURL(blob);
    // Create a temporary anchor element and set its href to the blob URL
    const a = document.createElement('a');
    a.href = url;
    // Set the download attribute to suggest a filename for the download based on current teams and date
    a.download = filename || `${currentGame().team}_${currentGame().opponent}_${new Date().toISOString()}.json`;
    // Append the anchor to the body, click it, and then remove it
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke the blob URL to free up resources
    URL.revokeObjectURL(url);
}

// Save game summary text to the clipboard
document.getElementById('copySummaryBtn').addEventListener('click', function() {
    const summary = summarizeGame();
    navigator.clipboard.writeText(summary).then(() => {
        alert('Game summary copied to clipboard');
    });
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
