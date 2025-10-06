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
 */
// A list of all our main screens
const screens = [
    document.getElementById('selectTeamScreen'), 
    document.getElementById('teamRosterScreen'),
    document.getElementById('beforePointScreen'),
    document.getElementById('offensePlayByPlayScreen'),
    document.getElementById('defensePlayByPlayScreen'),
    document.getElementById('simpleModeScreen'),  // Add Simple Mode screen
    document.getElementById('gameSummaryScreen')
];

// Play-by-play screens where simple mode toggle changes are relevant
const playByPlayScreenIds = [
    'offensePlayByPlayScreen',
    'defensePlayByPlayScreen',
    'simpleModeScreen'
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
        // Match button widths when footer is shown
        matchButtonWidths();
        setTimeout(matchButtonWidths, 100);
    } else {
        document.getElementById('bottomPanel').style.display = 'none';
    }

    // Update header layout based on the current screen
    const headerElement = document.querySelector('header');
    const simpleModeToggle = document.querySelector('.simple-mode-toggle');
    
    // Hide simple mode toggle on team select and roster screens
    if (screenId === 'selectTeamScreen' || screenId === 'teamRosterScreen') {
        headerElement.classList.remove('header-compact');
        headerElement.classList.add('header-full');
        simpleModeToggle.classList.add('hidden');
    } else {
        // Show compact header for gameplay screens
        headerElement.classList.remove('header-full');
        headerElement.classList.add('header-compact');
        simpleModeToggle.classList.remove('hidden');
    }

    // Update the simple mode toggle to match current screen
    if (screenId === 'simpleModeScreen') {
        document.getElementById('simpleModeToggle').checked = true;
    } else if (playByPlayScreenIds.includes(screenId) && screenId !== 'simpleModeScreen') {
        document.getElementById('simpleModeToggle').checked = false;
    }

    // Update specific UI elements for the new screen
    if (screenId === 'beforePointScreen') {
        shouldClearSelectionsInLineDialog = true;  // Reset checkbox state when entering Before Point screen
        updateActivePlayersList();
        checkPlayerCount();
    }
}

/*
 * Data structures for game tracking
 */
const Role = {
    TEAM: "team",
    OPPONENT: "opponent",
};

const UNKNOWN_PLAYER = "Unknown Player";
const UNKNOWN_PLAYER_OBJ = new Player(UNKNOWN_PLAYER);  // Single reusable instance

// Player data structure
function Player(name, nickname = "") {
    this.name = name;
    this.nickname = nickname;
    this.totalPointsPlayed = 0;
    this.consecutivePointsPlayed = 0;
    this.pointsPlayedPreviousGames = 0;
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
    this.lastLineUsed = null; // Track the last line used in this game
}

// Team data structure
function Team(name = "My Team", initialRoster = []) {
    this.name = name;
    this.games = [];  // array of Games played by this team
    this.teamRoster = []; // array of Players on the team
    this.lines = []; // array of pre-defined player lines
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
        // Fallback for unspecified turnovers
        return `Turnover by ${t}`;
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
    constructor({defender = null, interception = false, layout = false, sky = false, Callahan = false}) {
        super('Defense');
        this.defender = defender;       // null indicates an unforced turnover by opponent
        this.interception_flag = interception;
        this.layout_flag = layout;
        this.sky_flag = sky;
        this.Callahan_flag = Callahan;
    }
    // Override summarize for Defense events
    summarize() {
        let summary = '';
        let defender = this.defender ? this.defender.name : '';
        if (this.interception_flag)     { summary += 'Interception '; }
        if (this.layout_flag)           { summary += 'Layout D '; }
        if (this.sky_flag)              { summary += 'Sky D '; }
        if (this.Callahan_flag)         { summary += 'Callahan '; }
        if (this.defender) {
            summary += (summary ? summary : 'Turnover causeed ') + `by ${defender}`;
        } else {
            summary = (summary ? summary : 'Unforced turnover by opponent');
        }
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
        this.totalPointTime = 0;  // New field to track accumulated time
        this.lastPauseTime = null;  // New field to track when point was paused
    }

    addPossession(possession) {
        this.possessions.push(possession);
    }
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

/* UI Globals */
let showingTotalStats = false;  // true if showing total stats, false if showing game stats
let countdownInterval = null;
let countdownSeconds = 90;      // Default 90 seconds
let isCountdownRunning = false;
let nextLineSelections = null;  // Store user's selections made in next line mode
let shouldClearSelectionsInLineDialog = true;  // true when first entering Before Point screen, false after first line selection

/* 
 * Utility functions
 */

// Given a player name, return the corresponding Player object from the team roster
function getPlayerFromName(playerName) {
    if (playerName === UNKNOWN_PLAYER) {
        return UNKNOWN_PLAYER_OBJ;  // Return the singleton instance
    }
    return currentTeam.teamRoster.find(player => player.name === playerName);
}

// Get the current game
function currentGame() {
    if (currentTeam.games.length === 0) {
        console.log("Warning: No current game");
        return null;
    }
    return currentTeam.games[currentTeam.games.length - 1];
}

// Return the most recent point, or null if no points yet
function getLatestPoint() {
    if (!currentGame() || currentGame().points.length === 0) { return null; }
    return currentGame().points[currentGame().points.length - 1];
}

// Get the most recent possession (in most recent point); null if none
function getLatestPossession() {
    const latestPoint = getLatestPoint();
    if (!latestPoint) { return null; }
    if (latestPoint.possessions.length === 0) { return null; }
    return latestPoint.possessions[latestPoint.possessions.length - 1];
}

// Get the most recent event (in most recent possession with any events); null if no possessions this point
function getLatestEvent() {
    const latestPossession = getLatestPossession();
    if (!latestPossession) { return null; }
    if (latestPossession.events.length > 0) {
        return latestPossession.events[latestPossession.events.length - 1];
    }
    // no events in the current possession; return the last event of the previous possession
    latestPoint = getLatestPoint();
    if (!latestPoint) { return null; }
    if (latestPoint.possessions.length < 2) { 
        // no previous possession; return null
        return null; 
    }
    const prevPossession = latestPoint.possessions[latestPoint.possessions.length - 2];
    return prevPossession.events[prevPossession.events.length - 1];        
}

// Return true if a point is currently in progress
// (i.e., the latest point has at least one possession and does not 
// have a winner yet)
function isPointInProgress() {
    const latestPoint = getLatestPoint();
    if (!latestPoint) { return false; }
    if (latestPoint.possessions.length === 0) { return false; }
    return latestPoint.winner === "";
}

// Get the current possession (the last one in the current point); null if none
function getActivePossession(activePoint) {
    if (! activePoint) {
        console.log("getActivePossession() called, but no active point");
        return null;
    }
    if (activePoint.possessions.length === 0) {
        console.log("getActivePossession() called, but no possessions in active point");
        return null
    }
    return activePoint.possessions[activePoint.possessions.length - 1];
}

// Helper function to calculate player's time in current game
function getPlayerGameTime(playerName) {
    let totalTime = 0;
    if (currentGame()) {
        currentGame().points.forEach(point => {
            if (point.players.includes(playerName)) {
                if (point.endTimestamp) {
                    // For completed points, just use the totalPointTime
                    totalTime += point.totalPointTime;
                } else if (point === currentPoint) {
                    // For the current point, handle paused state
                    if (isPaused) {
                        // If paused, just use the accumulated time
                        totalTime += point.totalPointTime;
                    } else if (point.startTimestamp) {
                        // If running, calculate current running time and update totalPointTime
                        const currentRunningTime = new Date() - point.startTimestamp;
                        point.totalPointTime += currentRunningTime;
                        point.startTimestamp = new Date(); // Reset start time to now
                        totalTime += point.totalPointTime;
                    } else {
                        // If no start time, just use accumulated time
                        totalTime += point.totalPointTime;
                    }
                } else {
                    // For other incomplete points (shouldn't happen), use accumulated time
                    totalTime += point.totalPointTime;
                }
            }
        });
    }
    return totalTime;
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

    if (teams.length === 0 || teams.length === 1 && teams[0].name === "Sample Team") {
        teamListWarning.style.display = 'block';
    } else {
        teamListWarning.style.display = 'none';
    }

    // Create a table instead of a simple list
    const table = document.createElement('table');
    table.classList.add('team-selection-table');

    teams.forEach((team, teamIndex) => {
        // Create team row
        const teamRow = document.createElement('tr');
        teamRow.classList.add('team-row');
        
        // Team name cell
        const teamNameCell = document.createElement('td');
        teamNameCell.textContent = team.name;
        teamNameCell.classList.add('team-name');
        teamNameCell.onclick = () => selectTeam(teamIndex);
        teamRow.appendChild(teamNameCell);

        // Games list cell
        const gamesCell = document.createElement('td');
        const gamesList = document.createElement('ul');
        gamesList.classList.add('games-list');

        team.games.forEach((game, gameIndex) => {
            const gameItem = document.createElement('li');
            
            // Game description
            const gameText = document.createElement('span');
            gameText.textContent = `vs ${game.opponent} (${game.scores[Role.TEAM]}-${game.scores[Role.OPPONENT]})`;
            if (!game.gameEndTimestamp) {
                gameText.textContent += ' [In Progress]';
            }
            gameItem.appendChild(gameText);

            // Resume game button
            if (!game.gameEndTimestamp) {
                const resumeBtn = document.createElement('button');
                resumeBtn.textContent = '↪️';
                resumeBtn.classList.add('icon-button');
                resumeBtn.title = 'Resume Game';
                resumeBtn.onclick = (e) => {
                    e.stopPropagation(); // Prevent triggering team selection
                    if (confirm('Resume this game?')) {
                        currentTeam = team;
                        // Resume game logic - determine which screen to show
                        if (isPointInProgress()) {
                            const latestPossession = getLatestPossession();
                            if (latestPossession.offensive) {
                                updateOffensivePossessionScreen();
                                showScreen('offensePlayByPlayScreen');
                            } else {
                                updateDefensivePossessionScreen();
                                showScreen('defensePlayByPlayScreen');
                            }
                        } else {
                            updateActivePlayersList();
                            showScreen('beforePointScreen');
                        }
                    }
                };
                gameItem.appendChild(resumeBtn);
            }

            // Delete game button
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = '🗑️';
            deleteBtn.classList.add('icon-button');
            deleteBtn.title = 'Delete Game';
            deleteBtn.onclick = (e) => {
                e.stopPropagation(); // Prevent triggering team selection
                if (confirm('Delete this game? This cannot be undone.')) {
                    // Remove player stats from this game
                    removeGameStatsFromRoster(team, game);
                    // Remove the game
                    team.games.splice(gameIndex, 1);
                    showSelectTeamScreen(); // Refresh the screen
                    saveAllTeamsData(); // Save the updated data
                }
            };
            gameItem.appendChild(deleteBtn);

            gamesList.appendChild(gameItem);
        });

        gamesCell.appendChild(gamesList);
        teamRow.appendChild(gamesCell);
        table.appendChild(teamRow);
    });

    teamListElement.appendChild(table);
    showScreen('selectTeamScreen');
}

function removeGameStatsFromRoster(team, game) {
    // Get all points from the game
    const points = game.points || [];
    
    // For each point
    points.forEach(point => {
        // Get the duration of the point using totalPointTime
        const pointDuration = point.totalPointTime;
        
        // Subtract time and point from each player who was on the field
        point.players.forEach(playerName => {
            const player = getPlayerFromName(playerName);
            if (player) {
                // Decrement total points played
                player.totalPointsPlayed = Math.max(0, (player.totalPointsPlayed || 0) - 1);
                
                // Subtract time played
                player.totalTimePlayed = Math.max(0, (player.totalTimePlayed || 0) - pointDuration);
                
                // If this was their most recent game, reset consecutive points
                if (game === team.games[team.games.length - 1]) {
                    player.consecutivePointsPlayed = 0;
                }
            }
        });
    });
}

// Load team data from a file
document.getElementById('loadTeamBtn').onclick = () => {
    document.getElementById('fileInput').click();
};
document.getElementById('fileInput').addEventListener('change', function(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const jsonData = JSON.parse(e.target.result);
            // deserialize the JSON data and append to the current team data
            const newTeams = deserializeTeams(JSON.stringify([jsonData]));
            teams.push(newTeams[0]);
            currentTeam = newTeams[0];
            updateTeamRosterDisplay();
            showSelectTeamScreen();
        } catch (error) {
            console.error("Error parsing JSON:", error);
        }
    };
    reader.readAsText(file);
});
// Handle team selection
function selectTeam(index) {
    currentTeam = teams[index]; // assumes teams global already populated
    updateTeamRosterDisplay(); // Update the roster display
    showScreen('teamRosterScreen'); // Go back to the roster screen
}

// Event listeners for relevant  buttons
document.getElementById('switchTeamsBtn').addEventListener('click', showSelectTeamScreen);
// Show the modal when the "Create New Team" button is clicked
document.getElementById('createNewTeamBtn').addEventListener('click', () => {
    document.getElementById('createTeamModal').style.display = 'block';
});

// Close the modal when the close button is clicked
document.querySelector('.close').addEventListener('click', () => {
    document.getElementById('createTeamModal').style.display = 'none';
});

// Save the new team when the "Save" button is clicked
document.getElementById('saveNewTeamBtn').addEventListener('click', () => {
    const newTeamName = document.getElementById('newTeamNameInput').value.trim();
    if (newTeamName) {
        const newTeam = new Team(newTeamName);
        teams.push(newTeam);
        currentTeam = newTeam;
        updateTeamRosterDisplay();
        showScreen('teamRosterScreen');
        document.getElementById('createTeamModal').style.display = 'none';
    } else {
        alert('Please enter a team name.');
    }
});

// Close the modal if the user clicks outside of it
window.addEventListener('click', (event) => {
    const modal = document.getElementById('createTeamModal');
    if (event.target === modal) {
        modal.style.display = 'none';
    }
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
    const teamRosterHeader = document.getElementById('teamRosterHeader');
    if (currentTeam && currentTeam.name) {
        teamRosterHeader.textContent = `Roster: ${currentTeam.name}`;
    } else {
        teamRosterHeader.textContent = 'Team Roster';
    }
    const rosterElement = document.getElementById('rosterList');
    rosterElement.innerHTML = '';  // Clear existing rows

    // Add header row
    let headerRow = document.createElement('tr');
    ['', 'Name', 'Pts', 'Time', 'Goals', 'Assists', '+/-', '..per pt'].forEach(headerText => {
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
document.querySelector('.delete-line-button').addEventListener('click', showDeleteLineDialog);

/************************************************************************ 
 *
 *   BEFORE POINT SCREEN
 *   SELECT PLAYERS TABLE 
 * 
 ************************************************************************/

// Toggle between showing total stats and game stats on the "Select Active Players" table
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
    checkPlayerCount();
}
document.getElementById('statsToggle').addEventListener('click', togglePlayerStats);

// Adjust Roster button returns to the "Team Roster Screen" and enables "Continue Game" button
document.getElementById('adjustRosterBtn').addEventListener('click', function() {
    showScreen('teamRosterScreen');
    document.getElementById('continueGameBtn').classList.remove('inactive');
});

// Updates the displayed roster on the "Before Point Screen"
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
}

/**
 * Creates the HTML table structure with headers and score rows
 */
function createActivePlayersTable() {
    let table = document.getElementById('activePlayersTable');
    let tableBody = table.querySelector('tbody');
    let tableHead = table.querySelector('thead');

    // Clear existing rows in the table body and head
    tableBody.innerHTML = '';
    tableHead.innerHTML = '';

    // Create header rows for scores
    let teamScoreRow = document.createElement('tr');
    let opponentScoreRow = document.createElement('tr');

    // Add cells to the score rows
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

    // Calculate and add score cells using utility function
    let runningScores = getRunningScores();

    addScoreCells(teamScoreRow, currentGame().team, runningScores.team);
    addScoreCells(opponentScoreRow, currentGame().opponent, runningScores.opponent);

    // Add score rows to the head
    tableHead.appendChild(teamScoreRow);
    tableHead.appendChild(opponentScoreRow);
}

/**
 * Sets checkbox states based on who played the last point
 */
function setPlayerCheckboxes() {
    // Create player rows with checkboxes
    createPlayerRows();
    
    // Set checkbox states based on last point players
    setCheckboxStates();
}

/**
 * Creates player rows with checkboxes, sorting players by priority
 */
function createPlayerRows() {
    // Determine players from the last point using utility function
    const lastPointPlayers = getLastPointPlayers();
    
    console.log('Last point players:', lastPointPlayers);

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
    let tableBody = document.getElementById('activePlayersTable').querySelector('tbody');
    
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

        // Add name column
        const nameCell = document.createElement('td');
        nameCell.classList.add('active-name-column');
        nameCell.textContent = player.name;
        row.appendChild(nameCell);

        // Add time column using utility function
        const timeCell = document.createElement('td');
        timeCell.classList.add('active-time-column');
        timeCell.textContent = getPlayerDisplayTime(player.name);
        row.appendChild(timeCell);

        // Add placeholder cells for points data (will be populated by populatePlayerStats)
        currentGame().points.forEach(() => {
            let pointCell = document.createElement('td');
            pointCell.classList.add('active-points-columns');
            pointCell.textContent = ''; // Will be populated later
            row.appendChild(pointCell);
        });

        tableBody.appendChild(row);
    });
}

/**
 * Sets checkbox states based on player selection strategy
 * Currently uses last point players, but can be extended for other strategies
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
 * Determines which players should be checked based on current selection strategy
 * Currently returns last point players, but can be extended for other strategies
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
 * Populates the table with player statistics and point data
 */
function populatePlayerStats() {
    let tableBody = document.getElementById('activePlayersTable').querySelector('tbody');
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
 * Utility function to get the last point's players
 */
function getLastPointPlayers() {
    return currentGame().points.length > 0
        ? currentGame().points[currentGame().points.length - 1].players
        : [];
}

/**
 * Utility function to check if a player has played any points in the current game
 */
function hasPlayedAnyPoints(playerName) {
    return currentGame().points.some(point => point.players.includes(playerName));
}

/**
 * Utility function to get running scores for both teams
 */
function getRunningScores() {
    let runningScores = { team: [0], opponent: [0] };
    currentGame().points.forEach(point => {
        runningScores.team.push(point.winner === 'team' ? runningScores.team.slice(-1)[0] + 1 : runningScores.team.slice(-1)[0]);
        runningScores.opponent.push(point.winner === 'opponent' ? runningScores.opponent.slice(-1)[0] + 1 : runningScores.opponent.slice(-1)[0]);
    });
    return runningScores;
}

/**
 * Utility function to get player display time (game vs total stats)
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
 * Captures the current checkbox selections and stores them for next line mode
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
 * Clears the stored next line selections
 */
function clearNextLineSelections() {
    if (nextLineSelections !== null) {
        console.log('Clearing next line selections (was:', nextLineSelections, ')');
    }
    nextLineSelections = null;
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

// return the starting position for the next point, based on points played so far
function determineStartingPosition() {
    if (! currentGame()) { console.log("Warning: No current game"); return 'offense'; }
    let startPointOn = currentGame().startingPosition;
    currentGame().points.forEach(point => {
        let switchsides = false; // flag to indicate if O and D switch sides after this point
        point.possessions.forEach(possession => {
            possession.events.forEach(event => {
                if (event.type === 'Other' && event.switchsides_flag) {
                    switchsides = !switchsides;
                }
            });
        });
        if (point.winner == 'team') {
            // if the team won the last point, they will start on defense unless switchsides is true
            startPointOn = switchsides ? 'offense' : 'defense';
        } else {
            //  the opponent won the last point, our team will start on offense unless switchsides is true
            startPointOn = switchsides ? 'defense' : 'offense';
        }
    });
    return startPointOn;
}

// Show start/continue-point button with warning style if wrong # of players selected
function checkPlayerCount() {
    const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
    const selectedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput').value, 10);
    
    // Determine which button to update based on mode
    const inNextLineMode = document.body.classList.contains('next-line-mode');
    const startPointBtn = document.getElementById('startPointBtn');
    const selectNextLineBtn = document.getElementById('selectNextLineBtn');
    const activeBtn = inNextLineMode ? selectNextLineBtn : startPointBtn;
    
    // Remove warning and inactive classes
    activeBtn.classList.remove('warning');
    activeBtn.classList.remove('inactive');
    
    // Apply appropriate classes based on player count
    if (selectedCount === 0) {
        activeBtn.classList.add('inactive');
    } else if (selectedCount !== expectedCount) {
        activeBtn.classList.add('warning');
    }
    
    // Update button text (only for startPointBtn when not in next line mode)
    if (!inNextLineMode) {
        // If a point is in progress, the button should say "Continue Point"
        if (isPointInProgress()) {
            startPointBtn.textContent = "Continue Point";
        } else {
            startPointBtn.textContent = "Start Point";
        }
        
        // Append "(Offense)" or "(Defense)" based on the next point 
        let startPointOn = determineStartingPosition();
        startPointBtn.textContent += ` (${capitalize(startPointOn)})`;
    } else {
        // In next line mode, always show "Select Next Line"
        selectNextLineBtn.textContent = "Select Next Line";
    }
}

// Starting a new game, on O or D
function startNewGame(startingPosition, seconds) {
    const opponentNameInput = document.getElementById('opponentNameInput');
    const opponentName = opponentNameInput.value.trim() || "Bad Guys";

    // Store current totalPointsPlayed into pointsPlayedPreviousGames for each player
    currentTeam.teamRoster.forEach(player => {
        player.pointsPlayedPreviousGames = player.totalPointsPlayed;
    });
    let newGame = new Game(currentTeam.name, opponentName, startingPosition);
    currentTeam.games.push(newGame);
    logEvent(`New game started against ${opponentName}`);

    // Set countdown seconds before moving to next point
    countdownSeconds = seconds;
    
    moveToNextPoint();
}


document.getElementById('startGameOnOBtn').addEventListener('click', function() {
    const timerInput = document.getElementById('pointTimerInput');
    const seconds = parseInt(timerInput.value) || 90;
    startNewGame('offense', seconds);
});

document.getElementById('startGameOnDBtn').addEventListener('click', function() {
    const timerInput = document.getElementById('pointTimerInput');
    const seconds = parseInt(timerInput.value) || 90;
    startNewGame('defense', seconds);
});

// Transition from Play-by-Play to Before Point when either team scores
function moveToNextPoint() {
    console.log('moveToNextPoint() called, current nextLineSelections:', nextLineSelections);
    
    // If we're in next line selection mode, exit it
    if (document.body.classList.contains('next-line-mode')) {
        console.log('Exiting next line mode from moveToNextPoint');
        exitNextLineSelectionMode();
    }
    
    // Don't clear next line selections here - we want them to persist to the next point's Before Point screen
    // They will be cleared when the point actually starts in startNextPoint()
    
    updateActivePlayersList();
    logEvent("New point started");
    // make contiueGameBtn active to enable changing roster between points
    document.getElementById('continueGameBtn').classList.remove('inactive');
    showScreen('beforePointScreen');
    checkPlayerCount();  // to update the "Start Point" button style
    makeColumnsSticky(); // once the table is rendered, make the left columns sticky

    // Start the countdown timer
    startCountdown();
}

// Transition from Before Point to Play-by-Play
function startNextPoint() {
    // Stop the countdown when point starts
    stopCountdown();
    
    // Get the checkboxes and player names
    let checkboxes = [...document.querySelectorAll('#activePlayersTable input[type="checkbox"]')];

    let activePlayersForThisPoint = [];
    checkboxes.forEach((checkbox, index) => {
        if (checkbox.checked) {
            let player = currentTeam.teamRoster[index];  
            activePlayersForThisPoint.push(player.name);
        }
    });

    // Clear the stored next line selections since we're now using them
    console.log('About to clear next line selections in startNextPoint after using them');
    clearNextLineSelections();

    // determine starting position: check point winners and switchside events 
    let startPointOn = determineStartingPosition();

    // Create a new Point with the active players and starting position
    currentPoint = new Point(activePlayersForThisPoint, startPointOn);
    currentGame().points.push(currentPoint);
    
    // Update the simple mode toggle to match isSimpleMode before showing the screen
    document.getElementById('simpleModeToggle').checked = isSimpleMode;
    
    if (isSimpleMode) {
        showScreen('simpleModeScreen');
        // Start timing immediately in simple mode
        if (currentPoint.startTimestamp !== null) {
            console.warn("Warning: startTimestamp was already set when starting point in simple mode");
        }
        currentPoint.startTimestamp = new Date();
    } else {
        if (startPointOn === 'offense') {
            updateOffensivePossessionScreen();
            showScreen('offensePlayByPlayScreen');
        } else {
            updateDefensivePossessionScreen();
            showScreen('defensePlayByPlayScreen');
            // For now start possession and timing when D points start
            currentPoint.addPossession(new Possession(false));
            if (currentPoint.startTimestamp !== null) {
                console.warn("Warning: startTimestamp was already set when starting defensive point");
            }
            currentPoint.startTimestamp = new Date();
        }
    }
}
document.getElementById('startPointBtn').addEventListener('click', startNextPoint);

// Handling scores and game end
function updateScore(winner) {
    if (winner !== Role.TEAM && winner !== Role.OPPONENT) {
        throw new Error("inactive role");
    }

    if (currentPoint) {
        if (currentPoint.startTimestamp === null) {
            console.warn("Warning: currentPoint.startTimestamp is null; setting to now");
            currentPoint.startTimestamp = new Date();
        }
        // Add any remaining time to totalPointTime before ending
        currentPoint.totalPointTime += (new Date() - currentPoint.startTimestamp);
        currentPoint.endTimestamp = new Date();
        currentPoint.winner = winner; // Setting the winning team for the current point
        currentGame().scores[winner]++;

        // Update event log
        logEvent(`${currentPoint.winner} scores!`);

        // Update player stats for those who played this point
        currentTeam.teamRoster.forEach(p => {
            if (currentPoint.players.includes(p.name)) { // the player played this point
                p.totalPointsPlayed++;
                p.consecutivePointsPlayed++;
                p.totalTimePlayed += currentPoint.totalPointTime;
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
        
        // Check if we're in next line selection mode and exit if we are
        if (document.body.classList.contains('next-line-mode')) {
            exitNextLineSelectionMode();
        }
        
        // Un-select all player buttons so O action buttons will be inactive next point
        document.querySelectorAll('.player-button').forEach(button => {
            button.classList.remove('selected');
        });
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

document.getElementById('toggleEventLogBtn').addEventListener('click', function() {
    var eventLog = document.getElementById('eventLog');
    var toggleBtn = document.getElementById('toggleEventLogBtn');

    // Check if the event log is currently visible
    if (eventLog.style.display != 'block') {
        eventLog.style.display = 'block'; // Show the event log
        toggleBtn.classList.add('selected');
    } else {
        eventLog.style.display = 'none'; // Hide the event log
        toggleBtn.classList.remove('selected');
    }
});


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
document.getElementById('endGameBtn').addEventListener('click', function() {
    if (confirm('Are you sure you want to end the game?')) {
        stopCountdown();
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
        // if the latest event is a switch sides event, just remove it
        let latestEvent = getLatestEvent();
        if (latestEvent && latestEvent.type === 'Other' && latestEvent.switchsides_flag) {
            let currentPossession = getActivePossession(currentPoint);
            currentPossession.events.pop();
            logEvent("Removed most recent switch sides event");
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

// Event listener for adjust roster buttons
document.getElementById('oSubPlayersBtn').addEventListener('click', function() {
    updateActivePlayersList();
    showScreen('beforePointScreen');
    // enable the "continue game" button
    document.getElementById('continueGameBtn').classList.remove('inactive');
});
document.getElementById('dSubPlayersBtn').addEventListener('click', function() {
    updateActivePlayersList();
    showScreen('beforePointScreen');
    // enable the "continue game" button
    document.getElementById('continueGameBtn').classList.remove('inactive');
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

// Also capture next line selections when checkboxes change in next line mode
document.getElementById('activePlayersTable').addEventListener('change', function(event) {
    if (event.target.type === 'checkbox' && document.body.classList.contains('next-line-mode')) {
        captureNextLineSelections();
    }
});

// Initialize header state on page load
document.addEventListener('DOMContentLoaded', function() {
    // Set initial header state based on starting screen
    const headerElement = document.querySelector('header');
    const simpleModeToggle = document.querySelector('.simple-mode-toggle');
    
    // Start with full header and hidden toggle since we start on team select
    headerElement.classList.add('header-full');
    headerElement.classList.remove('header-compact');
    simpleModeToggle.classList.add('hidden');
    
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

function showLineSelectionDialog() {
    if (!currentTeam || !currentTeam.lines || currentTeam.lines.length === 0) {
        alert('No lines have been created yet. Please create lines in the roster management screen.');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'select-line-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'select-line-dialog';

    const heading = document.createElement('h3');
    heading.textContent = 'Select Line';
    dialog.appendChild(heading);

    // Add checkbox for clearing existing selections
    const checkboxContainer = document.createElement('div');
    checkboxContainer.className = 'clear-selections-checkbox-container';
    
    const clearCheckbox = document.createElement('input');
    clearCheckbox.type = 'checkbox';
    clearCheckbox.id = 'clearSelectionsCheckbox';
    clearCheckbox.checked = shouldClearSelectionsInLineDialog;
    
    const clearLabel = document.createElement('label');
    clearLabel.htmlFor = 'clearSelectionsCheckbox';
    clearLabel.textContent = 'Clear existing selections';
    
    checkboxContainer.appendChild(clearCheckbox);
    checkboxContainer.appendChild(clearLabel);
    dialog.appendChild(checkboxContainer);

    const radioContainer = document.createElement('div');
    radioContainer.className = 'select-line-radio-container';

    let selectedLine = null;

    currentTeam.lines.forEach((line, index) => {
        const option = document.createElement('div');
        option.className = 'select-line-radio-option';
        if (currentGame && currentGame.lastLineUsed === line.name) {
            option.classList.add('last-used');
        }

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'lineSelection';
        radio.id = `line-${index}`;
        radio.value = line.name;

        const label = document.createElement('label');
        label.htmlFor = `line-${index}`;
        
        const lineName = document.createElement('span');
        lineName.className = 'line-name';
        lineName.textContent = line.name;
        
        const players = document.createElement('span');
        players.className = 'line-players';
        players.textContent = line.players.join(', ');
        
        label.appendChild(lineName);
        label.appendChild(players);

        radio.addEventListener('change', () => {
            selectedLine = line;
            selectButton.disabled = false;
        });

        option.appendChild(radio);
        option.appendChild(label);
        radioContainer.appendChild(option);
    });

    dialog.appendChild(radioContainer);

    const buttons = document.createElement('div');
    buttons.className = 'select-line-buttons';

    const selectButton = document.createElement('button');
    selectButton.className = 'select-line-button select';
    selectButton.textContent = 'Select';
    selectButton.disabled = true;
    selectButton.addEventListener('click', () => {
        if (selectedLine) {
            // Only uncheck all checkboxes if the checkbox is checked
            if (clearCheckbox.checked) {
                document.querySelectorAll('#activePlayersTable input[type="checkbox"]').forEach(checkbox => {
                    checkbox.checked = false;
                });
            }

            // Check boxes for players in the selected line
            const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
            currentTeam.teamRoster.forEach((player, index) => {
                if (selectedLine.players.includes(player.name)) {
                    checkboxes[index].checked = true;
                }
            });

            // Clear any stored next line selections since we just made a new line selection
            clearNextLineSelections();

            // Update the last used line and save
            currentGame().lastLineUsed = selectedLine.name;
            saveAllTeamsData();
            
            // Update the Start Point button state
            checkPlayerCount();
            
            // Uncheck the checkbox for next time (unless we're still in the same point)
            shouldClearSelectionsInLineDialog = false;
            
            // Close the dialog
            overlay.remove();
        }
    });

    const cancelButton = document.createElement('button');
    cancelButton.className = 'select-line-button cancel';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => {
        overlay.remove();
    });

    buttons.appendChild(selectButton);
    buttons.appendChild(cancelButton);
    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// Add event listener for the Lines button
document.getElementById('selectLineBtn').addEventListener('click', showLineSelectionDialog);

function updateActivePlayersDisplay() {
    const table = document.getElementById('activePlayersTable');
    if (!table) return;

    // Clear existing rows except header
    while (table.rows.length > 1) {
        table.deleteRow(1);
    }

    // Add rows for each active player
    currentGame.activePlayers.forEach(playerName => {
        const row = table.insertRow();
        
        // Add checkbox cell
        const checkboxCell = row.insertCell();
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'active-checkbox';
        checkbox.checked = true; // Active players are checked by default
        checkboxCell.appendChild(checkbox);
        
        // Add player name cell
        const nameCell = row.insertCell();
        nameCell.textContent = playerName;
        
        // Add time played cell
        const timeCell = row.insertCell();
        timeCell.textContent = formatPlayTime(getPlayerGameTime(playerName));
        
        // Add cells for each point
        const latestPoint = getLatestPoint();
        if (latestPoint) {
            const pointsPlayed = latestPoint.playingPlayers.includes(playerName) ? '✓' : '';
            const pointCell = row.insertCell();
            pointCell.textContent = pointsPlayed;
        }
    });
}

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
        return;
    }
    
    // Update selection
    if (isThrower) {
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
    
    // If both players are selected, create the event and move to next point
    if (selectedThrower && selectedReceiver) {
        const scoreEvent = new Throw({
            thrower: selectedThrower,
            receiver: selectedReceiver,
            score: true
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
    const callahanEvent = new Defense({
        Callahan: true
    });
    currentPoint.addPossession(new Possession(false));
    getActivePossession(currentPoint).addEvent(callahanEvent);
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
        }
        // TODO: Add defense logic later
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
    if (throwEvent.score) {
        keyPlaySelectedReceiver.goals++;
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
let isSimpleMode = false;

document.getElementById('simpleModeToggle').addEventListener('change', function() {
    isSimpleMode = this.checked;
    
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
        if (isSimpleMode) {
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

// Add this near the top with other DOM element references
const pauseResumeBtn = document.getElementById('pauseResumeBtn');
const pauseResumeText = pauseResumeBtn.querySelector('.pause-resume-text');
const pauseResumeIcon = pauseResumeBtn.querySelector('i');
let isPaused = false;

// Add this near other event listeners
pauseResumeBtn.addEventListener('click', () => {
    if (!currentPoint) {
        console.warn("Warning: pause/resume button clicked, but currentPoint is null");
        return;
    }
    
    isPaused = !isPaused;
    if (isPaused) {
        // Pause logic
        currentPoint.lastPauseTime = new Date();
        if (currentPoint.startTimestamp) {
            currentPoint.totalPointTime += (currentPoint.lastPauseTime - currentPoint.startTimestamp);
            currentPoint.startTimestamp = null;
        }
        pauseResumeIcon.className = 'fas fa-play';
        pauseResumeText.textContent = 'Resume';
    } else {
        // Resume logic
        currentPoint.startTimestamp = new Date();
        currentPoint.lastPauseTime = null;
        pauseResumeIcon.className = 'fas fa-pause';
        pauseResumeText.textContent = 'Pause';
    }
});

// New function to update the timer display
function updatePointTimer() {
    if (!currentPoint) return;
    
    let elapsedTime = currentPoint.totalPointTime;
    if (currentPoint.startTimestamp && !isPaused) {
        elapsedTime += (new Date() - currentPoint.startTimestamp);
    }
    
    const minutes = Math.floor(elapsedTime / 60000);
    const seconds = Math.floor((elapsedTime % 60000) / 1000);
    const formattedTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    // Update both the main and mini timers
    document.getElementById('pointTimer').textContent = formattedTime;
    
    // Also update mini timer if in next line selection mode
    if (document.body.classList.contains('next-line-mode')) {
        document.getElementById('pointTimerMini').textContent = formattedTime;
        
        // In next line selection mode, also update the time displays for active players
        if (currentPoint && currentPoint.players) {
            const timeCells = document.querySelectorAll('.active-time-column');
            
            currentTeam.teamRoster.forEach((player, idx) => {
                if (idx < timeCells.length) {
                    // Only update time for players currently in the game
                    if (currentPoint.players.includes(player.name)) {
                        let totalTime = getPlayerGameTime(player.name);
                        timeCells[idx].textContent = formatPlayTime(totalTime);
                    }
                }
            });
        }
    }
}

// Remove the previous modification that wrapped the original updatePointTimer
// Since we're replacing it completely
// Delete these lines:
// const originalUpdatePointTimer = updatePointTimer;
// updatePointTimer = function() {
//     originalUpdatePointTimer();
//     if (document.body.classList.contains('next-line-mode')) {
//         syncPointTimers();
//     }
// };

// Update function to enter next line selection mode
function enterNextLineSelectionMode() {
    // First, update the active players list
    updateActivePlayersList();
    
    // Show the next line header
    document.getElementById('nextLineHeader').style.display = 'block';
    
    // Add class to body to trigger the CSS changes
    document.body.classList.add('next-line-mode');
    
    // Update the pause/resume button icon
    updatePauseResumeIconsForNextLineMode();
    
    // Make table columns sticky after rendering
    setTimeout(makeColumnsSticky, 100);
    
    // Set up the touch events for swiping
    setupSwipeEvents();
    
    // Start a timer to update player times in this view
    startNextLinePlayerTimeUpdates();
    
    // Update the player count check for the selectNextLineBtn
    checkPlayerCount();
}

// Function to periodically update player times in next line mode
function startNextLinePlayerTimeUpdates() {
    // Make sure we don't have duplicate intervals
    if (window.nextLineTimeUpdateInterval) {
        clearInterval(window.nextLineTimeUpdateInterval);
    }
    
    // Update times immediately
    updatePlayerTimesInNextLineMode();
    
    // Set interval to update times every second
    window.nextLineTimeUpdateInterval = setInterval(function() {
        if (document.body.classList.contains('next-line-mode')) {
            updatePlayerTimesInNextLineMode();
        } else {
            // Clean up interval if we're not in next line mode
            clearInterval(window.nextLineTimeUpdateInterval);
            window.nextLineTimeUpdateInterval = null;
        }
    }, 1000);
}

// Function to update player times in next line mode
function updatePlayerTimesInNextLineMode() {
    if (!currentPoint || !currentPoint.players) return;
    
    const timeCells = document.querySelectorAll('.active-time-column');
    currentTeam.teamRoster.forEach((player, idx) => {
        if (idx < timeCells.length) {
            // Highlight and update time for players currently in the game
            if (currentPoint.players.includes(player.name)) {
                timeCells[idx].textContent = formatPlayTime(getPlayerGameTime(player.name));
                timeCells[idx].classList.add('active-player-time');
            } else {
                timeCells[idx].classList.remove('active-player-time');
            }
        }
    });
}

// Function to exit the next line selection mode
function exitNextLineSelectionMode() {
    // Capture the current selections before exiting
    console.log('exitNextLineSelectionMode() capturing selections');
    captureNextLineSelections();
    
    // Hide the next line header
    document.getElementById('nextLineHeader').style.display = 'none';
    
    // Remove class from body
    document.body.classList.remove('next-line-mode');
    
    // Restore the Start Point button text
    let startPointOn = determineStartingPosition();
    document.getElementById('startPointBtn').textContent = `Start Point (${capitalize(startPointOn)})`;
    
    // Clean up any swipe event listeners
    cleanupSwipeEvents();
    
    // Clean up time update interval
    if (window.nextLineTimeUpdateInterval) {
        clearInterval(window.nextLineTimeUpdateInterval);
        window.nextLineTimeUpdateInterval = null;
    }
    
    // Update the player count check for the startPointBtn
    checkPlayerCount();
}

// Function to match button widths
function matchButtonWidths() {
    const gameLogBtn = document.getElementById('toggleEventLogBtn');
    const undoBtn = document.getElementById('undoBtn');
    
    if (gameLogBtn && undoBtn) {
        // Use getComputedStyle for accurate width and height
        const gameLogStyle = window.getComputedStyle(gameLogBtn);
        undoBtn.style.width = gameLogStyle.width;
        undoBtn.style.height = gameLogStyle.height;
        undoBtn.style.lineHeight = gameLogStyle.lineHeight;
        undoBtn.style.fontSize = gameLogStyle.fontSize;
        undoBtn.style.borderRadius = gameLogStyle.borderRadius;
        undoBtn.style.padding = gameLogStyle.padding;
    }
}

// Call the function when the page loads
document.addEventListener('DOMContentLoaded', function() {
    // Initial call
    matchButtonWidths();
    
    // Also call after a short delay to ensure all styles are applied
    setTimeout(matchButtonWidths, 100);
});

// Next Line Selection Mode functions
document.getElementById('chooseNextLineBtn').addEventListener('click', function() {
    enterNextLineSelectionMode();
});

// Mini versions of score and pause buttons in the header
document.getElementById('weScoreBtnMini').addEventListener('click', function() {
    // Delegate the click to the main We Score button
    document.getElementById('weScoreBtn').click();
});

document.getElementById('theyScoreBtnMini').addEventListener('click', function() {
    // Delegate the click to the main They Score button
    document.getElementById('theyScoreBtn').click();
});

document.getElementById('pauseResumeBtnMini').addEventListener('click', function() {
    // Delegate the click to the main pause/resume button
    document.getElementById('pauseResumeBtn').click();
    // Update the mini button's icon based on pause state
    updatePauseResumeIconsForNextLineMode();
});

// Swipe down to return to simple mode
document.querySelector('.swipe-indicator').addEventListener('click', function() {
    exitNextLineSelectionMode();
});

// Function to sync the point timer between the main display and mini display
function syncPointTimers() {
    const mainTimer = document.getElementById('pointTimer');
    const miniTimer = document.getElementById('pointTimerMini');
    miniTimer.textContent = mainTimer.textContent;
}

// Update both main and mini pause/resume button icons
function updatePauseResumeIconsForNextLineMode() {
    const iconClass = isPaused ? 'fa-play' : 'fa-pause';
    const mainIcon = document.querySelector('#pauseResumeBtn i');
    const miniIcon = document.querySelector('#pauseResumeBtnMini i');
    
    if (mainIcon) mainIcon.className = `fas ${iconClass}`;
    if (miniIcon) miniIcon.className = `fas ${iconClass}`;
    
    const pauseResumeText = document.querySelector('.pause-resume-text');
    if (pauseResumeText) {
        pauseResumeText.textContent = isPaused ? 'Resume' : 'Pause';
    }
}

// Track touch events for swipe gesture
let touchStartY = 0;
let touchSwipeListenerActive = false;

function setupSwipeEvents() {
    if (touchSwipeListenerActive) return;
    
    const nextLineHeader = document.getElementById('nextLineHeader');
    
    nextLineHeader.addEventListener('touchstart', handleTouchStart, { passive: true });
    nextLineHeader.addEventListener('touchmove', handleTouchMove, { passive: true });
    nextLineHeader.addEventListener('touchend', handleTouchEnd, { passive: true });
    
    touchSwipeListenerActive = true;
}

function cleanupSwipeEvents() {
    if (!touchSwipeListenerActive) return;
    
    const nextLineHeader = document.getElementById('nextLineHeader');
    
    nextLineHeader.removeEventListener('touchstart', handleTouchStart);
    nextLineHeader.removeEventListener('touchmove', handleTouchMove);
    nextLineHeader.removeEventListener('touchend', handleTouchEnd);
    
    touchSwipeListenerActive = false;
}

function handleTouchStart(event) {
    touchStartY = event.touches[0].clientY;
}

function handleTouchMove(event) {
    if (!touchStartY) return;
    
    const touchY = event.touches[0].clientY;
    const diff = touchY - touchStartY;
    
    // If user has swiped down at least 50px, exit the next line mode
    if (diff > 50) {
        exitNextLineSelectionMode();
        touchStartY = 0; // Reset
    }
}

function handleTouchEnd() {
    touchStartY = 0; // Reset
}

// Helper function to capitalize the first letter of a string
function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

// Add timer update to existing interval
setInterval(updatePointTimer, 1000);

// Add event listener for the new Select Next Line button
document.getElementById('selectNextLineBtn').addEventListener('click', function() {
    exitNextLineSelectionMode();
});

