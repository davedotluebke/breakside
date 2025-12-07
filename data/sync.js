/*
 * Client-Side Synchronization Module
 * Handles syncing Players, Teams, and Games to the JSON backend server
 * 
 * Phase 3 update: Full offline support with entity-typed sync queue
 * - Players, Teams, and Games are all synced as separate entities
 * - Sync queue processes in dependency order: players → teams → games
 * - Entities created offline are marked with _localOnly: true
 */

// =============================================================================
// Configuration
// =============================================================================

// API_BASE_URL can be set via localStorage for multi-device testing
// e.g., localStorage.setItem('ultistats_api_url', 'http://192.168.1.100:8000')
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

// Storage keys
const SYNC_QUEUE_KEY = 'ultistats_sync_queue';
const LOCAL_PLAYERS_KEY = 'ultistats_local_players';
const LOCAL_TEAMS_KEY = 'ultistats_local_teams';
const LOCAL_GAMES_KEY = 'ultistats_local_games';

// =============================================================================
// State
// =============================================================================

let isOnline = navigator.onLine;
let isSyncing = false;
let syncQueue = loadSyncQueue();

// Local entity caches (for offline-created entities)
let localPlayers = loadLocalPlayers();
let localTeams = loadLocalTeams();
let localGames = loadLocalGames();

// =============================================================================
// Connectivity Listeners
// =============================================================================

window.addEventListener('online', () => {
    isOnline = true;
    console.log('🌐 App is online, processing sync queue...');
    processSyncQueue();
});

window.addEventListener('offline', () => {
    isOnline = false;
    console.log('📴 App is offline, queuing changes...');
});

// =============================================================================
// Sync Queue Management
// =============================================================================

/**
 * Load sync queue from local storage
 * Queue items have structure: { type, action, id, data, timestamp, retryCount }
 */
function loadSyncQueue() {
    try {
        const stored = localStorage.getItem(SYNC_QUEUE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error('Failed to load sync queue:', e);
        return [];
    }
}

/**
 * Save sync queue to local storage
 */
function saveSyncQueue() {
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(syncQueue));
}

/**
 * Add an item to the sync queue
 * @param {string} type - Entity type: 'player', 'team', or 'game'
 * @param {string} action - Action: 'create', 'update', or 'delete'
 * @param {string} id - Entity ID
 * @param {object} data - Entity data
 */
function addToSyncQueue(type, action, id, data) {
    // Remove any existing pending sync for this entity
    syncQueue = syncQueue.filter(item => !(item.type === type && item.id === id));
    
    // Add new item
    syncQueue.push({
        type: type,
        action: action,
        id: id,
        data: data,
        timestamp: Date.now(),
        retryCount: 0
    });
    
    saveSyncQueue();
    console.log(`📝 Queued ${action} for ${type} ${id}`);
}

/**
 * Get pending sync count by type
 */
function getPendingSyncCount() {
    const counts = { player: 0, team: 0, game: 0 };
    syncQueue.forEach(item => {
        if (counts[item.type] !== undefined) {
            counts[item.type]++;
        }
    });
    return counts;
}

/**
 * Check if an entity has pending sync
 */
function hasPendingSync(type, id) {
    return syncQueue.some(item => item.type === type && item.id === id);
}

/**
 * Process the sync queue in dependency order: players → teams → games
 */
async function processSyncQueue() {
    if (isSyncing || syncQueue.length === 0 || !isOnline) return;
    
    isSyncing = true;
    console.log(`🔄 Processing ${syncQueue.length} items in sync queue...`);
    
    // Sort queue by type (players first, then teams, then games)
    const typeOrder = { player: 0, team: 1, game: 2 };
    const sortedQueue = [...syncQueue].sort((a, b) => {
        return (typeOrder[a.type] || 3) - (typeOrder[b.type] || 3);
    });
    
    for (const item of sortedQueue) {
        try {
            await syncQueueItem(item);
            
            // Remove from queue on success
            syncQueue = syncQueue.filter(qItem => 
                !(qItem.type === item.type && qItem.id === item.id)
            );
            saveSyncQueue();
            
            // Clear _localOnly flag from local storage
            clearLocalOnlyFlag(item.type, item.id);
            
        } catch (error) {
            console.error(`❌ Failed to sync ${item.type} ${item.id}:`, error);
            
            // Increment retry count
            const queueItem = syncQueue.find(q => q.type === item.type && q.id === item.id);
            if (queueItem) {
                queueItem.retryCount = (queueItem.retryCount || 0) + 1;
                queueItem.lastError = error.message;
                saveSyncQueue();
            }
            
            // If it's a network error, stop processing
            if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
                isOnline = false;
                break;
            }
        }
    }
    
    isSyncing = false;
    
    // Retry remaining items after delay if still online
    if (syncQueue.length > 0 && isOnline) {
        setTimeout(processSyncQueue, 5000);
    }
}

/**
 * Sync a single queue item to the server
 */
async function syncQueueItem(item) {
    const { type, action, id, data } = item;
    
    // Strip _localOnly flag before sending to server (it's client-side only)
    let cleanData = data;
    if (data && typeof data === 'object') {
        cleanData = { ...data };
        delete cleanData._localOnly;
    }
    
    let url, method, body;
    
    switch (type) {
        case 'player':
            if (action === 'create' || action === 'update') {
                url = `${API_BASE_URL}/players`;
                method = 'POST';  // POST handles both create and update via ID
                body = JSON.stringify(cleanData);
            } else if (action === 'delete') {
                url = `${API_BASE_URL}/players/${id}`;
                method = 'DELETE';
            }
            break;
            
        case 'team':
            if (action === 'create' || action === 'update') {
                url = `${API_BASE_URL}/teams`;
                method = 'POST';  // POST handles both create and update via ID
                body = JSON.stringify(cleanData);
            } else if (action === 'delete') {
                url = `${API_BASE_URL}/teams/${id}`;
                method = 'DELETE';
            }
            break;
            
        case 'game':
            if (action === 'create' || action === 'update' || action === 'sync') {
                url = `${API_BASE_URL}/games/${id}/sync`;
                method = 'POST';
                body = JSON.stringify(cleanData);
            } else if (action === 'delete') {
                url = `${API_BASE_URL}/games/${id}`;
                method = 'DELETE';
            }
            break;
            
        default:
            throw new Error(`Unknown entity type: ${type}`);
    }
    
    console.log(`📤 Syncing ${type} ${id} (${action})...`);
    
    const response = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server returned ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    console.log(`✅ Synced ${type} ${id}:`, result);
    
    return result;
}

/**
 * Clear the _localOnly flag for an entity
 */
function clearLocalOnlyFlag(type, id) {
    switch (type) {
        case 'player':
            delete localPlayers[id];
            saveLocalPlayers();
            break;
        case 'team':
            delete localTeams[id];
            saveLocalTeams();
            break;
        case 'game':
            delete localGames[id];
            saveLocalGames();
            break;
    }
}

// =============================================================================
// Local Storage for Offline Entities
// =============================================================================

function loadLocalPlayers() {
    try {
        const stored = localStorage.getItem(LOCAL_PLAYERS_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        return {};
    }
}

function saveLocalPlayers() {
    localStorage.setItem(LOCAL_PLAYERS_KEY, JSON.stringify(localPlayers));
}

function loadLocalTeams() {
    try {
        const stored = localStorage.getItem(LOCAL_TEAMS_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        return {};
    }
}

function saveLocalTeams() {
    localStorage.setItem(LOCAL_TEAMS_KEY, JSON.stringify(localTeams));
}

function loadLocalGames() {
    try {
        const stored = localStorage.getItem(LOCAL_GAMES_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        return {};
    }
}

function saveLocalGames() {
    localStorage.setItem(LOCAL_GAMES_KEY, JSON.stringify(localGames));
}

// =============================================================================
// Player Sync Functions
// =============================================================================

/**
 * Create a player offline (works without server connection)
 * @param {object} playerData - Player data (name required, id optional)
 * @returns {object} The created player with ID
 */
function createPlayerOffline(playerData) {
    // Generate ID if not provided
    const id = playerData.id || generatePlayerId(playerData.name);
    
    const now = new Date().toISOString();
    const player = {
        id: id,
        name: playerData.name,
        nickname: playerData.nickname || '',
        gender: playerData.gender || Gender.UNKNOWN,
        number: playerData.number || null,
        createdAt: playerData.createdAt || now,
        updatedAt: now,
        _localOnly: true  // Mark as offline-created
    };
    
    // Save to local cache
    localPlayers[id] = player;
    saveLocalPlayers();
    
    // Queue for sync
    addToSyncQueue('player', 'create', id, player);
    
    // Try to sync immediately if online
    if (isOnline) {
        processSyncQueue();
    }
    
    console.log(`👤 Created player offline: ${player.name} (${id})`);
    return player;
}

/**
 * Sync a player to the cloud (create or update)
 * @param {object} player - Player object
 */
async function syncPlayerToCloud(player) {
    if (!player || !player.id) {
        throw new Error('Player must have an ID');
    }
    
    // Update timestamp
    player.updatedAt = new Date().toISOString();
    
    // Prepare data for sync
    const playerData = {
        id: player.id,
        name: player.name,
        nickname: player.nickname || '',
        gender: player.gender || Gender.UNKNOWN,
        number: player.number || null,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt
    };
    
    // Queue for sync
    addToSyncQueue('player', 'update', player.id, playerData);
    
    // Try to process immediately if online
    if (isOnline) {
        processSyncQueue();
    }
}

/**
 * Load a player from the cloud
 * @param {string} playerId - Player ID
 * @returns {Promise<object>} Player data
 */
async function loadPlayerFromCloud(playerId) {
    if (!isOnline) {
        // Check local cache
        if (localPlayers[playerId]) {
            return localPlayers[playerId];
        }
        throw new Error('Cannot load player: Offline');
    }
    
    const response = await fetch(`${API_BASE_URL}/players/${playerId}`);
    if (!response.ok) {
        throw new Error(`Failed to load player: ${response.statusText}`);
    }
    
    return await response.json();
}

/**
 * List all players from the cloud
 * @returns {Promise<Array>} List of players
 */
async function listCloudPlayers() {
    if (!isOnline) {
        // Return local players only
        return Object.values(localPlayers);
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/players`);
        if (!response.ok) {
            throw new Error(`Failed to list players: ${response.statusText}`);
        }
        
        const data = await response.json();
        const cloudPlayers = data.players || [];
        
        // Merge with local-only players
        const localOnlyPlayers = Object.values(localPlayers).filter(p => p._localOnly);
        
        return [...cloudPlayers, ...localOnlyPlayers];
    } catch (error) {
        console.error('Error listing players:', error);
        // Return local players on error
        return Object.values(localPlayers);
    }
}

/**
 * Delete a player
 * @param {string} playerId - Player ID
 */
async function deletePlayerFromCloud(playerId) {
    addToSyncQueue('player', 'delete', playerId, null);
    
    // Remove from local cache
    delete localPlayers[playerId];
    saveLocalPlayers();
    
    if (isOnline) {
        processSyncQueue();
    }
}

// =============================================================================
// Team Sync Functions
// =============================================================================

/**
 * Create a team offline (works without server connection)
 * @param {object} teamData - Team data (name required, id optional)
 * @returns {object} The created team with ID
 */
function createTeamOffline(teamData) {
    // Generate ID if not provided
    const id = teamData.id || generateTeamId(teamData.name);
    
    const now = new Date().toISOString();
    const team = {
        id: id,
        name: teamData.name,
        playerIds: teamData.playerIds || [],
        lines: teamData.lines || [],
        createdAt: teamData.createdAt || now,
        updatedAt: now,
        _localOnly: true  // Mark as offline-created
    };
    
    // Save to local cache
    localTeams[id] = team;
    saveLocalTeams();
    
    // Queue for sync
    addToSyncQueue('team', 'create', id, team);
    
    // Try to sync immediately if online
    if (isOnline) {
        processSyncQueue();
    }
    
    console.log(`👥 Created team offline: ${team.name} (${id})`);
    return team;
}

/**
 * Sync a team to the cloud (create or update)
 * @param {object} team - Team object
 */
async function syncTeamToCloud(team) {
    if (!team || !team.id) {
        throw new Error('Team must have an ID');
    }
    
    // Update timestamp
    team.updatedAt = new Date().toISOString();
    
    // Prepare data for sync (exclude legacy embedded data)
    const teamData = {
        id: team.id,
        name: team.name,
        playerIds: team.playerIds || [],
        lines: team.lines || [],
        createdAt: team.createdAt,
        updatedAt: team.updatedAt
    };
    
    // Queue for sync
    addToSyncQueue('team', 'update', team.id, teamData);
    
    // Try to process immediately if online
    if (isOnline) {
        processSyncQueue();
    }
}

/**
 * Load a team from the cloud
 * @param {string} teamId - Team ID
 * @returns {Promise<object>} Team data
 */
async function loadTeamFromCloud(teamId) {
    if (!isOnline) {
        // Check local cache
        if (localTeams[teamId]) {
            return localTeams[teamId];
        }
        throw new Error('Cannot load team: Offline');
    }
    
    const response = await fetch(`${API_BASE_URL}/teams/${teamId}`);
    if (!response.ok) {
        throw new Error(`Failed to load team: ${response.statusText}`);
    }
    
    return await response.json();
}

/**
 * List all teams from the cloud
 * @returns {Promise<Array>} List of teams
 */
async function listCloudTeams() {
    if (!isOnline) {
        // Return local teams only
        return Object.values(localTeams);
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/teams`);
        if (!response.ok) {
            throw new Error(`Failed to list teams: ${response.statusText}`);
        }
        
        const data = await response.json();
        const cloudTeams = data.teams || [];
        
        // Merge with local-only teams
        const localOnlyTeams = Object.values(localTeams).filter(t => t._localOnly);
        
        return [...cloudTeams, ...localOnlyTeams];
    } catch (error) {
        console.error('Error listing teams:', error);
        // Return local teams on error
        return Object.values(localTeams);
    }
}

/**
 * Delete a team
 * @param {string} teamId - Team ID
 */
async function deleteTeamFromCloud(teamId) {
    addToSyncQueue('team', 'delete', teamId, null);
    
    // Remove from local cache
    delete localTeams[teamId];
    saveLocalTeams();
    
    if (isOnline) {
        processSyncQueue();
    }
}

// =============================================================================
// Game Sync Functions
// =============================================================================

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
 * Create a game offline (works without server connection)
 * @param {object} gameData - Game data
 * @returns {object} The created game with ID
 */
function createGameOffline(gameData) {
    // Ensure game has an ID
    const id = gameData.id || generateGameId(gameData);
    gameData.id = id;
    
    // Mark as offline-created
    gameData._localOnly = true;
    
    // Save to local cache
    localGames[id] = gameData;
    saveLocalGames();
    
    console.log(`🎮 Created game offline: ${id}`);
    return gameData;
}

/**
 * Serialize game for API
 * Returns a plain object, not a JSON string
 */
function prepareGameForSync(game) {
    // Use the serializeGame function from storage.js if available
    if (typeof serializeGame === 'function') {
        const serialized = serializeGame(game);
        serialized.id = serialized.id || generateGameId(game);
        return serialized;
    }
    
    // Fallback: manual serialization
    return {
        id: game.id || generateGameId(game),
        teamId: game.teamId || null,
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
        rosterSnapshot: game.rosterSnapshot || null,
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
    
    // Queue for sync
    addToSyncQueue('game', 'sync', game.id, gameData);
    
    // Update local cache
    localGames[game.id] = gameData;
    saveLocalGames();
    
    // Try to process queue immediately if online
    if (isOnline) {
        processSyncQueue();
    }
}

/**
 * List all games from the server
 * @returns {Promise<Array>} List of games metadata
 */
async function listServerGames() {
    if (!isOnline) {
        // Return local games only
        return Object.values(localGames).map(g => ({
            game_id: g.id,
            team: g.team,
            opponent: g.opponent,
            scores: g.scores,
            game_start_timestamp: g.gameStartTimestamp,
            game_end_timestamp: g.gameEndTimestamp,
            points_count: g.points ? g.points.length : 0,
            _localOnly: g._localOnly
        }));
    }

    try {
        const response = await fetch(`${API_BASE_URL}/games`);
        if (!response.ok) {
            throw new Error(`Failed to list games: ${response.statusText}`);
        }
        const data = await response.json();
        const cloudGames = data.games || [];
        
        // Merge with local-only games
        const localOnlyGames = Object.values(localGames)
            .filter(g => g._localOnly)
            .map(g => ({
                game_id: g.id,
                team: g.team,
                opponent: g.opponent,
                scores: g.scores,
                game_start_timestamp: g.gameStartTimestamp,
                game_end_timestamp: g.gameEndTimestamp,
                points_count: g.points ? g.points.length : 0,
                _localOnly: true
            }));
        
        return [...cloudGames, ...localOnlyGames];
    } catch (error) {
        console.error('Error listing server games:', error);
        return Object.values(localGames).map(g => ({
            game_id: g.id,
            team: g.team,
            opponent: g.opponent,
            scores: g.scores,
            game_start_timestamp: g.gameStartTimestamp,
            game_end_timestamp: g.gameEndTimestamp,
            points_count: g.points ? g.points.length : 0,
            _localOnly: g._localOnly
        }));
    }
}

/**
 * Load a game from the server and deserialize it
 * @param {string} gameId 
 * @returns {Promise<Object>} The deserialized Game object
 */
async function loadGameFromCloud(gameId) {
    // Check local cache first
    if (localGames[gameId]) {
        const cachedGame = localGames[gameId];
        if (typeof deserializeGame === 'function') {
            return deserializeGame(cachedGame);
        }
        return cachedGame;
    }
    
    if (!isOnline) {
        throw new Error('Cannot load game: Offline');
    }

    try {
        const response = await fetch(`${API_BASE_URL}/games/${gameId}`);
        if (!response.ok) {
            throw new Error(`Failed to load game: ${response.statusText}`);
        }
        
        const gameData = await response.json();
        
        // Use deserializeGame from storage.js if available
        if (typeof deserializeGame === 'function') {
            const game = deserializeGame(gameData);
            game.id = gameId;
            return game;
        }
        
        // Fallback: manual deserialization
        const game = new Game(
            gameData.team,
            gameData.opponent,
            gameData.startingPosition,
            gameData.teamId || null
        );
        game.id = gameId;
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
        game.rosterSnapshot = gameData.rosterSnapshot || null;
        game.scores = gameData.scores || { [Role.TEAM]: 0, [Role.OPPONENT]: 0 };

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

/**
 * Delete a game from the cloud
 * @param {string} gameId - Game ID
 */
async function deleteGameFromCloud(gameId) {
    addToSyncQueue('game', 'delete', gameId, null);
    
    // Remove from local cache
    delete localGames[gameId];
    saveLocalGames();
    
    if (isOnline) {
        processSyncQueue();
    }
}

// =============================================================================
// Full Sync Functions
// =============================================================================

/**
 * Sync all local data to the cloud
 * Processes in dependency order: players → teams → games
 */
async function syncAllData() {
    if (!isOnline) {
        console.log('📴 Cannot sync: Offline');
        return { success: false, error: 'Offline' };
    }
    
    console.log('🔄 Starting full sync...');
    
    try {
        // Process sync queue (already ordered by type)
        await processSyncQueue();
        
        const pendingCounts = getPendingSyncCount();
        const totalPending = pendingCounts.player + pendingCounts.team + pendingCounts.game;
        
        if (totalPending === 0) {
            console.log('✅ Full sync complete');
            return { success: true, synced: syncQueue.length };
        } else {
            console.log(`⚠️ Sync incomplete: ${totalPending} items pending`);
            return { success: false, pending: pendingCounts };
        }
    } catch (error) {
        console.error('❌ Sync failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Pull latest data from cloud and merge with local
 * @returns {Promise<object>} Pull result with counts
 */
async function pullFromCloud() {
    if (!isOnline) {
        console.log('📴 Cannot pull: Offline');
        return { success: false, error: 'Offline' };
    }
    
    console.log('📥 Pulling from cloud...');
    
    try {
        const [players, teams, games] = await Promise.all([
            listCloudPlayers(),
            listCloudTeams(),
            listServerGames()
        ]);
        
        console.log(`📥 Pulled ${players.length} players, ${teams.length} teams, ${games.length} games`);
        
        return {
            success: true,
            players: players,
            teams: teams,
            games: games
        };
    } catch (error) {
        console.error('❌ Pull failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get sync status information
 * @returns {object} Sync status
 */
function getSyncStatus() {
    const pendingCounts = getPendingSyncCount();
    return {
        isOnline: isOnline,
        isSyncing: isSyncing,
        pendingCount: syncQueue.length,
        pendingByType: pendingCounts,
        localPlayersCount: Object.keys(localPlayers).length,
        localTeamsCount: Object.keys(localTeams).length,
        localGamesCount: Object.keys(localGames).length
    };
}

/**
 * Check if we're currently online
 * @returns {boolean}
 */
function checkIsOnline() {
    return isOnline;
}

// =============================================================================
// Exports
// =============================================================================

// Game sync (existing)
window.syncGameToCloud = syncGameToCloud;
window.generateGameId = generateGameId;
window.listServerGames = listServerGames;
window.loadGameFromCloud = loadGameFromCloud;
window.deleteGameFromCloud = deleteGameFromCloud;
window.createGameOffline = createGameOffline;

// Player sync (new)
window.createPlayerOffline = createPlayerOffline;
window.syncPlayerToCloud = syncPlayerToCloud;
window.loadPlayerFromCloud = loadPlayerFromCloud;
window.listCloudPlayers = listCloudPlayers;
window.deletePlayerFromCloud = deletePlayerFromCloud;

// Team sync (new)
window.createTeamOffline = createTeamOffline;
window.syncTeamToCloud = syncTeamToCloud;
window.loadTeamFromCloud = loadTeamFromCloud;
window.listCloudTeams = listCloudTeams;
window.deleteTeamFromCloud = deleteTeamFromCloud;

// Full sync (new)
window.syncAllData = syncAllData;
window.pullFromCloud = pullFromCloud;
window.getSyncStatus = getSyncStatus;
window.checkIsOnline = checkIsOnline;
window.getPendingSyncCount = getPendingSyncCount;
window.hasPendingSync = hasPendingSync;
window.processSyncQueue = processSyncQueue;
