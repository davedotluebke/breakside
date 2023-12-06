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
        // Initialize other properties based on type
    }
}

class Throw extends Event {
    constructor({thrower = "voidthrower", receiver = "voidreceiver", huck = false, strike = false, dump = false, hammer = false, sky = false, layout = false, score = false}) {
        super('Throw');
        this.thrower = thrower;
        this.receiver = receiver;
        this.huck = huck;
        this.strike = strike;
        this.dump = dump;
        this.hammer = hammer;
        this.sky = sky;
        this.layout = layout;
        this.score = score;
    }
}

class Turnover extends Event {
    constructor({receiver = "voidreceiver", throwaway = false, receiverError = false, goodDefense = false, stall = false}) {
        super('Turnover');
        this.receiver = receiver;
        this.throwaway = throwaway;
        this.receiverError = receiverError;
        this.goodDefense = goodDefense;
        this.stall = stall;
    }
}

class FoulViolation extends Event {
    constructor({offensive = false, strip = false, pick = false, travel = false, contested = false, doubleTeam = false}) {
        super('Foul/Violation');
        this.offensive = offensive;
        this.strip = strip;
        this.pick = pick;
        this.travel = travel;
        this.contested = contested;
        this.doubleTeam = doubleTeam;
    }
}

class Defense extends Event {
    constructor({interception = false, layout = false, sky = false, Callahan = false, turnover = true}) {
        super('Defense');
        this.interception = interception;
        this.layout = layout;
        this.sky = sky;
        this.Callahan = Callahan;
        this.turnover = turnover;
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

function saveTeamData(team) {
    const serializedData = serializeTeam(team);
    localStorage.setItem('teamData', serializedData);
    logTeamData(team);
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

function deserializeTeam(serializedData) {
    const data = JSON.parse(serializedData);

    // Create a new Team instance
    const team = new Team(data.name);
    currentTeam = team;

    // Reconstruct Player instances
    data.teamRoster.forEach(playerData => {
        const player = new Player(playerData.name);
        // Reassign other properties if needed
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
        // Reassign other properties if needed

        gameData.points.forEach(pointData => {
            const point = new Point(pointData.players, pointData.startingPosition);
            // Reassign other properties if needed

            pointData.possessions.forEach(possessionData => {
                const possession = new Possession(possessionData.offensive);

                possessionData.events.forEach(eventData => {
                    // Deserialize the event using the deserialization function
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

/*
 * Globals
 */
const sampleNames = ["Cyrus L","Leif","Cesc","Cyrus J","Abby","Avery","James","Simeon","Soren","Walden"];
let currentTeam = new Team("My Team", sampleNames);  // Later, support loading teams from storage/cloud
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
showScreen('teamRosterScreen');

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
    const serializedTeam = localStorage.getItem('teamData');
    if (serializedTeam) {
        currentTeam = deserializeTeam(serializedTeam);
        updateTeamRosterDisplay();
    } else {
        console.log("No saved team data found.");
        alert('No saved team data found.');
    }
    logTeamData(currentTeam);
});

// Clearing games from local storage
document.getElementById('clearGamesBtn').addEventListener('click', function() {
    if (confirm('Are you sure you want to clear all saved game data?')) {
        localStorage.removeItem('teamData');
        alert('Saved games have been cleared.');
        // Optionally reset the current team data or refresh the page
        // currentTeam = new Team(); // Reset the team data
        // updateTeamRosterDisplay(); // Update the display
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
    console.log("Starting new game on " + startingPosition + ": ");
    console.log(newGame);
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
    console.log("Active players for this point: " + activePlayersForThisPoint);

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
        console.log(playerName + " starts a new possession");
    }
    // if most recent event is a throw, mark this player as the receiver
    // (thrower will already be set)
    if (currentEvent && currentEvent instanceof Throw) {
        currentEvent.receiver = getPlayerFromName(playerName);
        console.log(playerName + " catches the disc from " + currentEvent.thrower.name);
    } else {
        console.log(playerName + " has the disc");
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
        console.log('Throw initiated');
        currentEvent = new Throw({thrower: currentPlayer, receiver: null, huck: false, strike: false, dump: false, hammer: false, sky: false, layout: false, score: false});
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPlayer.completedPasses++;
    });
    huckButton.addEventListener('click', function() {
        console.log('Huck initiated');
        currentEvent = new Throw({thrower: currentPlayer, receiver: null, huck: true, strike: false, dump: false, hammer: false, sky: false, layout: false, score: false});
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPlayer.completedPasses++;
    });
    throwawayButton.addEventListener('click', function() {
        // Create a new Turnover event and add it to the current possession
        console.log('Throwaway');
        currentEvent = new Turnover({throwaway: true, receiverError: false, goodDefense: false, stall: false});
        let currentPossession = getActivePossession(currentPoint);
        currentPossession.addEvent(currentEvent);
        currentPossession = new Possession(false);
        currentPoint.addPossession(currentPossession);
        showScreen('defensePlayByPlayScreen');
    });
    scoreButton.addEventListener('click', function() {
        // Current event should be a throw; tag as score & update player stats
        console.log('Score!');
        let currentPossession = getActivePossession(currentPoint);
        if (currentEvent && currentEvent instanceof Throw) {
            currentEvent.score = true;
            currentEvent.receiver.goals++;
            currentEvent.thrower.assists++;
        } else {
            console.log("Warning: No current event or event is not a throw");
        }
        updateScore(Role.TEAM);
        moveToNextPoint();
    });

    actionButtonsContainer.appendChild(throwButton);
    actionButtonsContainer.appendChild(huckButton);
    actionButtonsContainer.appendChild(throwawayButton);
    actionButtonsContainer.appendChild(scoreButton);
    // Append other action buttons similarly
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
    currentGame().endTimestamp = new Date(); // Set end timestamp

    // Populate the gameSummaryScreen with statistics, then show it
    document.getElementById('teamName').textContent = currentGame().team;
    document.getElementById('teamFinalScore').textContent = currentGame().scores[Role.TEAM];
    document.getElementById('opponentName').textContent = currentGame().opponent;
    document.getElementById('opponentFinalScore').textContent = currentGame().scores[Role.OPPONENT];
    showScreen('gameSummaryScreen');
    saveTeamData(currentTeam);
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
