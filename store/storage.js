/*
 * Data Storage and Serialization
 * Handles all data persistence operations
 * 
 * Phase 2 update: Support for ID-based player references alongside name-based (legacy)
 */

// Note: This module depends on store/models.js for data structures
// It also depends on getPlayerFromName which will be defined in utils/helpers.js
// For now, we'll reference it as a global function that will be available

/**
 * Serialize an event to JSON
 * Supports both legacy (name-based) and new (ID-based) player references
 * @param {Event} event - The event object to serialize
 * @param {boolean} useIds - If true, include player IDs (new format). Default: true for new games
 */
function serializeEvent(event, useIds = true) {
    const serializedEvent = { type: event.type };
    // Create a new instance of the event with default values
    const defaultEvent = new event.constructor({});

    // Player reference ID fields are handled separately in the player reference section below
    // We must exclude them here to avoid duplicating IDs when player lookup fails during deserialization
    const playerIdFields = ['throwerId', 'receiverId', 'pullerId', 'defenderId'];

    // Serialize only the properties that are different from the default instance
    for (const prop in event) {
        if (event.hasOwnProperty(prop) && event[prop] !== defaultEvent[prop]) {
            // Skip player ID fields - they're handled in the player reference section
            if (playerIdFields.includes(prop)) {
                continue;
            }
            serializedEvent[prop] = event[prop];
        }
    }

    // Serialize player references
    // Legacy format: store player name (for backward compatibility)
    // New format: also store player ID for direct lookup
    if (event.thrower) {
        serializedEvent.thrower = event.thrower.name;
        if (useIds && event.thrower.id) {
            serializedEvent.throwerId = event.thrower.id;
        }
    }
    if (event.receiver) {
        serializedEvent.receiver = event.receiver.name;
        if (useIds && event.receiver.id) {
            serializedEvent.receiverId = event.receiver.id;
        }
    }
    if (event.puller) {
        serializedEvent.puller = event.puller.name;
        if (useIds && event.puller.id) {
            serializedEvent.pullerId = event.puller.id;
        }
    }
    if (event.defender) {
        serializedEvent.defender = event.defender.name;
        if (useIds && event.defender.id) {
            serializedEvent.defenderId = event.defender.id;
        }
    }

    return serializedEvent;
}

/**
 * Serialize a single player to a plain object
 */
function serializePlayer(player) {
    return {
        id: player.id,
        name: player.name,
        nickname: player.nickname,
        gender: player.gender,
        number: player.number,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
        // Legacy stats (kept for backward compatibility)
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
    };
}

/**
 * Serialize a single game to a plain object
 * Phase 6b update: includes gameDurationMinutes, roundEndTime
 */
function serializeGame(game) {
    return {
        id: game.id,
        teamId: game.teamId,  // New: reference to team by ID
        team: game.team,       // Legacy: team name string
        opponent: game.opponent,
        startingPosition: game.startingPosition,
        scores: game.scores,
        gameStartTimestamp: game.gameStartTimestamp.toISOString(),
        gameEndTimestamp: game.gameEndTimestamp ? game.gameEndTimestamp.toISOString() : null,
        alternateGenderRatio: game.alternateGenderRatio,
        alternateGenderPulls: game.alternateGenderPulls,
        startingGenderRatio: game.startingGenderRatio,
        lastLineUsed: game.lastLineUsed,
        rosterSnapshot: game.rosterSnapshot,  // New: snapshot of player data at game time
        // Phase 6b: Timer/cap settings
        gameDurationMinutes: game.gameDurationMinutes ?? 50,
        roundEndTime: game.roundEndTime || null,
        // Phase 6b: Pending next line selections for multi-device sync
        pendingNextLine: game.pendingNextLine ? {
            oLine: game.pendingNextLine.oLine || [],
            dLine: game.pendingNextLine.dLine || [],
            odLine: game.pendingNextLine.odLine || [],
            oLineModifiedAt: game.pendingNextLine.oLineModifiedAt || null,
            dLineModifiedAt: game.pendingNextLine.dLineModifiedAt || null,
            odLineModifiedAt: game.pendingNextLine.odLineModifiedAt || null,
            activeType: game.pendingNextLine.activeType || 'od'
        } : null,
        points: game.points.map(point => ({
            players: point.players,
            startingPosition: point.startingPosition,
            winner: point.winner,
            startTimestamp: point.startTimestamp ? point.startTimestamp.toISOString() : null,
            endTimestamp: point.endTimestamp ? point.endTimestamp.toISOString() : null,
            totalPointTime: point.totalPointTime,
            lastPauseTime: point.lastPauseTime ? (typeof point.lastPauseTime === 'string' ? point.lastPauseTime : point.lastPauseTime.toISOString()) : null,
            possessions: point.possessions.map(possession => ({
                offensive: possession.offensive,
                events: possession.events.map(event => serializeEvent(event))
            }))
        }))
    };
}

/**
 * Simplify the team & game objects into serializable objects and output JSON
 * Phase 2 update: includes id, playerIds, createdAt, updatedAt
 * Phase 6b update: includes teamSymbol, iconUrl
 */
function serializeTeam(team) {
    const serializedTeam = {
        // New fields
        id: team.id,
        createdAt: team.createdAt,
        updatedAt: team.updatedAt,
        playerIds: team.playerIds || [],
        
        // Phase 6b: Team identity for header display
        teamSymbol: team.teamSymbol || null,
        iconUrl: team.iconUrl || null,
        
        // Existing fields
        name: team.name,
        
        // Legacy: embedded roster (kept for backward compatibility)
        teamRoster: team.teamRoster.map(player => serializePlayer(player)),
        
        // Legacy: embedded games (kept for backward compatibility during migration)
        games: team.games.map(game => serializeGame(game)),
        
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

    // Note: Team data logging disabled to reduce console noise
    // Uncomment for debugging: teams.forEach(team => logTeamData(team));

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
 * Event object of the proper subclass and convert any player references into
 * Player instances.
 * 
 * Phase 2 update: Supports both ID-based (new) and name-based (legacy) lookups
 * - If throwerId/receiverId/etc exists, use ID lookup
 * - Otherwise fall back to name lookup (legacy)
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
    
    // Now replace player references with Player instances
    // Try ID-based lookup first (new format), fall back to name lookup (legacy)
    switch (eventData.type) {
        case 'Throw':
            event.thrower = resolvePlayerReference(eventData.throwerId, eventData.thrower);
            event.receiver = resolvePlayerReference(eventData.receiverId, eventData.receiver);
            break;
        case 'Turnover':
            if (eventData.thrower || eventData.throwerId) {
                event.thrower = resolvePlayerReference(eventData.throwerId, eventData.thrower);
            }
            if (eventData.receiver || eventData.receiverId) {
                event.receiver = resolvePlayerReference(eventData.receiverId, eventData.receiver);
            }
            break;
        case 'Defense':
            if (eventData.defender || eventData.defenderId) {
                event.defender = resolvePlayerReference(eventData.defenderId, eventData.defender);
            }
            break;
        case 'Pull':
            if (eventData.puller || eventData.pullerId) {
                event.puller = resolvePlayerReference(eventData.pullerId, eventData.puller);
            }
            break;
        // Add other event types here, if they refer to players
    }
    return event;
}

/**
 * Resolve a player reference - try ID first, then name
 * @param {string|null} playerId - Player ID (new format)
 * @param {string|null} playerName - Player name (legacy format)
 * @returns {Player|Object|null} The resolved Player object, a minimal object with name/id, or null
 */
function resolvePlayerReference(playerId, playerName) {
    // Try ID lookup first (new format)
    if (playerId) {
        const player = getPlayerById(playerId);
        if (player) return player;
    }
    // Fall back to name lookup (legacy format)
    if (playerName) {
        const player = getPlayerFromName(playerName);
        if (player) return player;
    }
    
    // If we have a name and/or ID but couldn't find the player,
    // create a minimal object to preserve the data for serialization
    // This prevents data loss when currentTeam isn't set during deserialization
    if (playerName || playerId) {
        return {
            name: playerName || UNKNOWN_PLAYER,
            id: playerId || null,
            gender: Gender.UNKNOWN
        };
    }
    
    return null;
}

/**
 * Get a player by their unique ID
 * Searches the current team's roster for a player with matching ID
 * @param {string} playerId - The player's unique ID
 * @returns {Player|null} The Player object or null if not found
 */
function getPlayerById(playerId) {
    if (!playerId) return null;
    if (!currentTeam || !currentTeam.teamRoster) return null;
    return currentTeam.teamRoster.find(player => player.id === playerId) || null;
}

/**
 * Deserialize a single player from data
 * Handles both legacy (no id) and new (with id) formats
 */
function deserializePlayer(playerData) {
    // Create player with id if available, otherwise it will be generated
    const player = new Player(
        playerData.name, 
        playerData.nickname || "", 
        playerData.gender || Gender.UNKNOWN, 
        playerData.number || null,
        playerData.id || null  // Pass existing id if available
    );
    
    // Copy over all properties (handles legacy stats)
    Object.assign(player, playerData);
    
    // Ensure required fields are set
    if (!player.gender) {
        player.gender = Gender.UNKNOWN;
    }
    if (!player.createdAt) {
        player.createdAt = new Date().toISOString();
    }
    if (!player.updatedAt) {
        player.updatedAt = player.createdAt;
    }
    
    return player;
}

/**
 * Deserialize a single game from data
 * Handles both legacy and new formats
 */
function deserializeGame(gameData) {
    const game = new Game(
        gameData.team,
        gameData.opponent,
        gameData.startingPosition,
        gameData.teamId || null  // New: team ID reference
    );
    
    game.id = gameData.id;
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
    game.rosterSnapshot = gameData.rosterSnapshot || null;  // New: roster snapshot
    
    // Phase 6b: Timer/cap settings
    game.gameDurationMinutes = gameData.gameDurationMinutes ?? 50;
    game.roundEndTime = gameData.roundEndTime || null;
    
    // Phase 6b: Pending next line selections (migrate from existing games)
    if (gameData.pendingNextLine) {
        game.pendingNextLine = {
            oLine: gameData.pendingNextLine.oLine || [],
            dLine: gameData.pendingNextLine.dLine || [],
            odLine: gameData.pendingNextLine.odLine || [],
            oLineModifiedAt: gameData.pendingNextLine.oLineModifiedAt || null,
            dLineModifiedAt: gameData.pendingNextLine.dLineModifiedAt || null,
            odLineModifiedAt: gameData.pendingNextLine.odLineModifiedAt || null,
            activeType: gameData.pendingNextLine.activeType || 'od'
        };
    }
    // If no pendingNextLine, the default from Game constructor is used
    
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
}

/**
 * Convert serialized team data back into team objects
 * Phase 2 update: handles id, playerIds, createdAt, updatedAt fields
 */
function deserializeTeams(serializedData) {
    const parsedData = JSON.parse(serializedData);
    return parsedData.map(teamData => {
        // Create team with id if available
        const team = new Team(teamData.name, [], teamData.id || null);
        currentTeam = team; // Set current team before deserializing events
        
        // Restore metadata
        team.createdAt = teamData.createdAt || new Date().toISOString();
        team.updatedAt = teamData.updatedAt || team.createdAt;
        
        // Phase 6b: Restore team identity fields
        team.teamSymbol = teamData.teamSymbol || null;
        team.iconUrl = teamData.iconUrl || null;
        
        // Deserialize the roster
        team.teamRoster = teamData.teamRoster.map(playerData => deserializePlayer(playerData));
        
        // Build playerIds from roster (ensures consistency)
        // If playerIds exists in data, use it; otherwise build from roster
        if (teamData.playerIds && teamData.playerIds.length > 0) {
            team.playerIds = teamData.playerIds;
        } else {
            team.playerIds = team.teamRoster.map(p => p.id);
        }
        
        // Deserialize games
        team.games = teamData.games.map(gameData => deserializeGame(gameData));
        
        // Set the lines data
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
 * Clear all teams data from memory.
 * Called on sign out to prevent data leaking between accounts.
 */
function clearAllTeamsData() {
    console.log('Clearing in-memory teams data...');
    teams = [];
    currentTeam = null;
    sampleTeam = null;
}

// Expose clearAllTeamsData globally for auth module
window.clearAllTeamsData = clearAllTeamsData;

/**
 * Create a sample team with predefined players
 * Used for initial setup when no teams exist
 */
function createSampleTeam() {
    const sampleNames = ["Cyrus L","Leif","Cesc","Cyrus J","Abby","Avery","James","Simeon","Soren","Walden"];
    return new Team("Sample Team", sampleNames);
}

