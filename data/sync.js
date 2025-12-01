/*
 * Client-Side Synchronization Module
 * Handles syncing game data to the JSON backend server
 */

// Configuration
// API_BASE_URL can be set via localStorage for multi-device testing
// e.g., localStorage.setItem('ultistats_api_url', 'http://192.168.1.100:8000')
// Default: same host as PWA on port 8000, or localhost:8000 if running from file://
function getApiBaseUrl() {
    const storedUrl = localStorage.getItem('ultistats_api_url');
    if (storedUrl) return storedUrl;
    
    // If PWA is served from a real host (not file://), use same host with port 8000
    if (window.location.protocol !== 'file:' && window.location.hostname !== 'localhost') {
        return `${window.location.protocol}//${window.location.hostname}:8000`;
    }
    
    // Default for local development
    return 'http://localhost:8000';
}

const API_BASE_URL = getApiBaseUrl();
console.log(`📡 Sync API URL: ${API_BASE_URL}`);

const SYNC_QUEUE_KEY = 'ultistats_sync_queue';

// State
let isOnline = navigator.onLine;
let isSyncing = false;
let syncQueue = loadSyncQueue();

// Initialize connectivity listeners
window.addEventListener('online', () => {
    isOnline = true;
    console.log('App is online, processing sync queue...');
    processSyncQueue();
});

window.addEventListener('offline', () => {
    isOnline = false;
    console.log('App is offline, queuing changes...');
});

/**
 * Generate a unique ID for a game if it doesn't have one
 * Format: YYYY-MM-DD_Team_vs_Opponent_Timestamp
 */
function generateGameId(game) {
    if (game.id) return game.id;
    
    const dateStr = game.gameStartTimestamp.toISOString().split('T')[0];
    const safeTeam = (game.team || 'Team').replace(/[^a-zA-Z0-9]/g, '-');
    const safeOpponent = (game.opponent || 'Opponent').replace(/[^a-zA-Z0-9]/g, '-');
    const timestamp = Date.now();
    
    return `${dateStr}_${safeTeam}_vs_${safeOpponent}_${timestamp}`;
}

/**
 * Serialize game for API (wrapper around storage.js serialize functions)
 * Returns a plain object, not a JSON string
 */
function prepareGameForSync(game) {
    // Create a dummy team object to reuse the serialization logic in storage.js
    // This is a bit of a hack but avoids duplicating serialization logic
    // We need to extract the single game serialization logic
    
    // Manually serialize the game based on storage.js logic
    return {
        id: game.id || generateGameId(game),
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
    };
}

/**
 * Sync a game to the server
 * @param {Object} game - The Game object to sync
 */
async function syncGameToCloud(game) {
    if (!game) return;
    
    // Ensure game has an ID
    if (!game.id) {
        game.id = generateGameId(game);
    }
    
    const gameData = prepareGameForSync(game);
    
    // Add to queue (or update existing entry)
    addToSyncQueue(game.id, gameData);
    
    // Try to process queue immediately if online
    if (isOnline) {
        processSyncQueue();
    }
}

/**
 * Add an item to the sync queue
 */
function addToSyncQueue(gameId, gameData) {
    // Remove any existing pending sync for this game (we only need the latest state)
    syncQueue = syncQueue.filter(item => item.gameId !== gameId);
    
    // Add new item
    syncQueue.push({
        gameId: gameId,
        data: gameData,
        timestamp: Date.now(),
        retryCount: 0
    });
    
    saveSyncQueue();
    console.log(`Queued sync for game ${gameId}`);
}

/**
 * Load sync queue from local storage
 */
function loadSyncQueue() {
    const stored = localStorage.getItem(SYNC_QUEUE_KEY);
    return stored ? JSON.parse(stored) : [];
}

/**
 * Save sync queue to local storage
 */
function saveSyncQueue() {
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(syncQueue));
}

/**
 * Process the sync queue
 */
async function processSyncQueue() {
    if (isSyncing || syncQueue.length === 0 || !isOnline) return;
    
    isSyncing = true;
    const queueCopy = [...syncQueue]; // Work on a copy
    
    console.log(`Processing ${queueCopy.length} items in sync queue...`);
    
    for (const item of queueCopy) {
        try {
            console.log(`Syncing game ${item.gameId}...`);
            const response = await fetch(`${API_BASE_URL}/games/${item.gameId}/sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(item.data)
            });
            
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }
            
            const result = await response.json();
            console.log(`✅ Synced game ${item.gameId} (Version: ${result.version})`);
            
            // Remove from queue on success
            syncQueue = syncQueue.filter(qItem => qItem.gameId !== item.gameId);
            saveSyncQueue();
            
        } catch (error) {
            console.error(`❌ Failed to sync game ${item.gameId}:`, error);
            
            // Increment retry count or handle backoff if needed
            // For now, we just leave it in the queue to try again later
            
            // If it's a network error, stop processing the rest of the queue
            if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
                isOnline = false;
                break;
            }
        }
    }
    
    isSyncing = false;
    
    // If there are still items and we're still online, try again in a bit (optional)
    if (syncQueue.length > 0 && isOnline) {
        setTimeout(processSyncQueue, 5000);
    }
}

/**
 * List all games from the server
 * @returns {Promise<Array>} List of games metadata
 */
async function listServerGames() {
    if (!isOnline) {
        console.warn('Cannot list server games: Offline');
        return [];
    }

    try {
        const response = await fetch(`${API_BASE_URL}/games`);
        if (!response.ok) {
            throw new Error(`Failed to list games: ${response.statusText}`);
        }
        const data = await response.json();
        return data.games || [];
    } catch (error) {
        console.error('Error listing server games:', error);
        return [];
    }
}

/**
 * Load a game from the server and deserialize it
 * @param {string} gameId 
 * @returns {Promise<Object>} The deserialized Game object
 */
async function loadGameFromCloud(gameId) {
    if (!isOnline) {
        throw new Error('Cannot load game: Offline');
    }

    try {
        const response = await fetch(`${API_BASE_URL}/games/${gameId}`);
        if (!response.ok) {
            throw new Error(`Failed to load game: ${response.statusText}`);
        }
        
        const gameData = await response.json();
        
        // Use deserializeTeams logic to deserialize a single game
        // We wrap it in a dummy structure to reuse existing deserialization logic
        // or we can manually deserialize it similar to deserializeTeams
        
        // Manual deserialization following storage.js logic:
        const game = new Game(
            gameData.team,
            gameData.opponent,
            gameData.startingPosition
        );
        game.id = gameId; // Important: Set the ID!
        game.gameStartTimestamp = new Date(gameData.gameStartTimestamp);
        game.gameEndTimestamp = gameData.gameEndTimestamp ? new Date(gameData.gameEndTimestamp) : null;
        
        if (gameData.alternateGenderRatio === 'Alternating' || gameData.alternateGenderRatio === true) {
            game.alternateGenderRatio = 'Alternating';
        } else if (gameData.alternateGenderRatio === 'No' || gameData.alternateGenderRatio === false || !gameData.alternateGenderRatio) {
            game.alternateGenderRatio = 'No';
        } else {
            game.alternateGenderRatio = gameData.alternateGenderRatio;
        }
        
        game.alternateGenderPulls = gameData.alternateGenderPulls || false;
        game.startingGenderRatio = gameData.startingGenderRatio || null;
        game.lastLineUsed = gameData.lastLineUsed || null;
        game.scores = gameData.scores || { [Role.TEAM]: 0, [Role.OPPONENT]: 0 }; // Ensure scores are set

        if (gameData.points) {
            game.points = gameData.points.map(pointData => {
                const point = new Point(pointData.players, pointData.startingPosition);
                point.startTimestamp = pointData.startTimestamp ? new Date(pointData.startTimestamp) : null;
                point.endTimestamp = pointData.endTimestamp ? new Date(pointData.endTimestamp) : null;
                point.winner = pointData.winner;
                point.totalPointTime = pointData.totalPointTime || 0;
                point.lastPauseTime = pointData.lastPauseTime ? new Date(pointData.lastPauseTime) : null;
                
                if (pointData.possessions) {
                    point.possessions = pointData.possessions.map(possessionData => {
                        const possession = new Possession(possessionData.offensive);
                        if (possessionData.events) {
                            possession.events = possessionData.events.map(eventData => deserializeEvent(eventData));
                        }
                        return possession;
                    });
                }
                return point;
            });
        }
        
        return game;

    } catch (error) {
        console.error(`Error loading game ${gameId}:`, error);
        throw error;
    }
}


async function deleteGameFromCloud(gameId) {
    if (!isOnline) {
        throw new Error('Cannot delete game: Offline');
    }

    try {
        const response = await fetch(`${API_BASE_URL}/games/${gameId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            throw new Error(`Failed to delete game: ${response.statusText}`);
        }
        
        console.log(`✅ Deleted game ${gameId}`);
        return true;
    } catch (error) {
        console.error(`Error deleting game ${gameId}:`, error);
        throw error;
    }
}

// Export functions
window.syncGameToCloud = syncGameToCloud;
window.generateGameId = generateGameId;
window.listServerGames = listServerGames;
window.loadGameFromCloud = loadGameFromCloud;
window.deleteGameFromCloud = deleteGameFromCloud;
