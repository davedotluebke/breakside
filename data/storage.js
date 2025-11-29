/*
 * Data Storage and Serialization
 * Handles all data persistence operations
 */

// Note: This module depends on data/models.js for data structures
// It also depends on getPlayerFromName which will be defined in utils/helpers.js
// For now, we'll reference it as a global function that will be available

/**
 * Serialize an event to JSON
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
    if (event.puller) serializedEvent.puller = event.puller.name;
    if (event.defender) serializedEvent.defender = event.defender.name;

    return serializedEvent;
}

/**
 * Simplify the team & game objects into serializable objects and output JSON
 */
function serializeTeam(team) {
    const serializedTeam = {
        name: team.name,
        teamRoster: team.teamRoster.map(player => ({
            name: player.name,
            nickname: player.nickname,
            gender: player.gender,
            number: player.number,
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
            alternateGenderRatio: game.alternateGenderRatio,
            alternateGenderPulls: game.alternateGenderPulls,
            startingGenderRatio: game.startingGenderRatio,
            lastLineUsed: game.lastLineUsed,
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

/**
 * Log team data to the console
 */
function logTeamData(team) {
    console.log("Team data: ");
    console.log(team);
    console.log("Serialized team data: ");
    console.log(serializeTeam(team));
}

/**
 * Save all teams' data to local storage
 */
function saveAllTeamsData() {
    // Serialize each team in the global teams array
    const serializedTeams = teams.map(team => JSON.parse(serializeTeam(team)));

    // Save the serialized array to local storage
    localStorage.setItem('teamsData', JSON.stringify(serializedTeams));

    // Log each team's data
    teams.forEach(team => logTeamData(team));

    // SYNC: Attempt to sync current game to cloud if available
    if (typeof syncGameToCloud === 'function' && typeof currentGame === 'function') {
        try {
            const game = currentGame();
            if (game) {
                syncGameToCloud(game);
            }
        } catch (e) {
            // Ignore errors if no current game (e.g. during initialization)
            console.log("Skipping cloud sync: " + e.message);
        }
    }
}

/** 
 * Given eventData created when deserializing an Event from JSON, create an
 * Event object of the proper subclass and convert any player name strings into
 * references to Player instances.
 * 
 * Note: This function uses getPlayerFromName which is defined in main.js
 * In the future, this should be moved to utils/helpers.js
 */
function deserializeEvent(eventData) {
    let event;

    switch (eventData.type) {
        case 'Throw': event = new Throw({ /* default parameters */ }); break;
        case 'Turnover': event = new Turnover({ /* default parameters */ }); break;
        case 'Violation': event = new Violation({ /* default parameters */ }); break;
        case 'Defense': event = new Defense({ /* default parameters */ }); break;
        case 'Pull': event = new Pull({ /* default parameters */ }); break;
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
        case 'Defense':
            if (eventData.defender) {
                event.defender = getPlayerFromName(eventData.defender);
            }
            break;
        case 'Pull':
            if (eventData.puller) {
                event.puller = getPlayerFromName(eventData.puller);
            }
            break;
        // Add other event types here, if they refer to players
    }
    return event;
}

/**
 * Convert serialized team data back into team objects
 */
function deserializeTeams(serializedData) {
    const parsedData = JSON.parse(serializedData);
    return parsedData.map(teamData => {
        const team = new Team(teamData.name);
        currentTeam = team; // Set current team before deserializing events
        
        // First deserialize the roster
        team.teamRoster = teamData.teamRoster.map(playerData => {
            const player = new Player(playerData.name, playerData.nickname || "", playerData.gender || Gender.UNKNOWN, playerData.number || null);
            Object.assign(player, playerData);
            // Ensure gender is set (for backward compatibility with old saves)
            if (!player.gender) {
                player.gender = Gender.UNKNOWN;
            }
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
            // Handle backward compatibility: convert boolean to string format
            if (gameData.alternateGenderRatio === true) {
                game.alternateGenderRatio = 'Alternating';
            } else if (gameData.alternateGenderRatio === false || !gameData.alternateGenderRatio) {
                game.alternateGenderRatio = 'No';
            } else {
                game.alternateGenderRatio = gameData.alternateGenderRatio;
            }
            game.alternateGenderPulls = gameData.alternateGenderPulls || false;
            game.startingGenderRatio = gameData.startingGenderRatio || null;
            game.lastLineUsed = gameData.lastLineUsed || null;
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

/**
 * Given a player name, return the corresponding Player object from the team roster
 * This is a helper function used by deserializeEvent
 * TODO: Move this to utils/helpers.js
 */
function getPlayerFromName(playerName) {
    if (playerName === UNKNOWN_PLAYER) {
        return UNKNOWN_PLAYER_OBJ;  // Return the singleton instance
    }
    return currentTeam ? currentTeam.teamRoster.find(player => player.name === playerName) : null;
}

/**
 * Load team data from local storage
 */
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

/**
 * Initialize teams from local storage or create a sample team
 */
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
 * Global variables - initialized by this module
 * These globals are shared across the application
 * Using var to ensure they are in global scope
 */
var teams = [];                 // An array of teams
var currentTeam = null;         // The current team being tracked
var sampleTeam = null;          // A sample team with 10 players, used if no teams are found

/*
 * Global initialization
 * Note: Player class must be defined before creating UNKNOWN_PLAYER_OBJ
 */
var UNKNOWN_PLAYER_OBJ = new Player(UNKNOWN_PLAYER);

// Initialize teams on module load
initializeTeams();

/**
 * Create a sample team with predefined players
 * Used for initial setup when no teams exist
 */
function createSampleTeam() {
    const sampleNames = ["Cyrus L","Leif","Cesc","Cyrus J","Abby","Avery","James","Simeon","Soren","Walden"];
    return new Team("Sample Team", sampleNames);
}

