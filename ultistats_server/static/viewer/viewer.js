/**
 * Ultistats Viewer
 * Handles navigation, entity listing, and game detail viewing
 * 
 * Phase 3 update: Added sync status indicator and pending sync badges
 */

// =============================================================================
// API Configuration
// =============================================================================

/**
 * Get the API base URL based on where the viewer is hosted.
 * - If served from api.breakside.pro, use relative URLs (same origin)
 * - If served from www.breakside.pro or other domains, use absolute URL
 */
function getApiBaseUrl() {
    const hostname = window.location.hostname;
    
    // If served from the API server itself, use relative URLs
    if (hostname === 'api.breakside.pro' || hostname === 'api.breakside.us') {
        return '';
    }
    
    // If served from CloudFront/S3 or other hosts, use absolute API URL
    if (hostname === 'www.breakside.pro' || hostname === 'breakside.pro' ||
        hostname === 'www.breakside.us' || hostname === 'breakside.us' ||
        hostname === 'luebke.us' ||
        hostname.endsWith('.breakside.pro') || hostname.endsWith('.breakside.us')) {
        return 'https://api.breakside.pro';
    }
    
    // Local development
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return '';
    }
    
    // Default: assume same origin
    return '';
}

const API_BASE_URL = getApiBaseUrl();
console.log(`📡 Viewer API URL: ${API_BASE_URL || '(same origin)'}`);

const POLL_INTERVAL = 3000; // 3 seconds
const SYNC_STATUS_POLL_INTERVAL = 5000; // 5 seconds
let currentGameId = null;
let lastGameVersion = null;
let isPolling = false;
let pollingInterval = null;
let syncStatusInterval = null;

// Data caches
let gamesCache = [];
let teamsCache = [];
let playersCache = [];

// Player ID to name/nickname lookup (built from rosterSnapshot)
let playerIdToName = {};

// Sync status tracking
let lastSyncStatus = null;

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    // Parse URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const gameId = urlParams.get('game_id');
    const teamId = urlParams.get('team_id');
    const playerId = urlParams.get('player_id');
    
    // Setup navigation tabs
    setupNavigation();
    
    // Setup info toggle for game detail view
    const infoToggle = document.getElementById('info-toggle');
    if (infoToggle) {
        const infoPanel = document.getElementById('game-info-panel');
        infoToggle.addEventListener('click', () => {
            infoPanel.classList.toggle('open');
        });
    }
    
    // Start sync status polling (Phase 3)
    startSyncStatusPolling();
    
    // Route to appropriate view
    if (gameId) {
        showGameDetail(gameId);
    } else if (teamId) {
        showTeamDetail(teamId);
    } else if (playerId) {
        showPlayerDetail(playerId);
    } else {
        showHomeView();
        loadAllData();
    }
});

function setupNavigation() {
    const navTabs = document.querySelectorAll('.nav-tab');
    navTabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            const tabName = tab.getAttribute('data-tab');
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    // Update nav tabs
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.nav-tab[data-tab="${tabName}"]`).classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Update URL hash
    window.location.hash = tabName;
}

// =============================================================================
// View Management
// =============================================================================

function showHomeView() {
    stopPolling();
    document.getElementById('home-view').classList.remove('hidden');
    document.getElementById('game-detail-view').classList.add('hidden');
    document.getElementById('team-detail-view').classList.add('hidden');
    document.getElementById('player-detail-view').classList.add('hidden');
    document.getElementById('main-nav').classList.remove('hidden');
    
    // Update URL
    history.pushState({}, '', '/static/viewer/');
    
    // Refresh current tab data
    const activeTab = document.querySelector('.nav-tab.active');
    if (activeTab) {
        const tabName = activeTab.getAttribute('data-tab');
        if (tabName === 'games') loadGames();
        else if (tabName === 'teams') loadTeams();
        else if (tabName === 'players') loadPlayers();
    }
}

function showGameDetail(gameId) {
    currentGameId = gameId;
    document.getElementById('home-view').classList.add('hidden');
    document.getElementById('game-detail-view').classList.remove('hidden');
    document.getElementById('team-detail-view').classList.add('hidden');
    document.getElementById('player-detail-view').classList.add('hidden');
    document.getElementById('main-nav').classList.add('hidden');
    
    // Update URL
    history.pushState({}, '', `/static/viewer/?game_id=${gameId}`);
    
    // Start loading and polling
    startGamePolling();
}

function showTeamDetail(teamId) {
    stopPolling();
    document.getElementById('home-view').classList.add('hidden');
    document.getElementById('game-detail-view').classList.add('hidden');
    document.getElementById('team-detail-view').classList.remove('hidden');
    document.getElementById('player-detail-view').classList.add('hidden');
    document.getElementById('main-nav').classList.add('hidden');
    
    // Update URL
    history.pushState({}, '', `/static/viewer/?team_id=${teamId}`);
    
    loadTeamDetail(teamId);
}

function showPlayerDetail(playerId) {
    stopPolling();
    document.getElementById('home-view').classList.add('hidden');
    document.getElementById('game-detail-view').classList.add('hidden');
    document.getElementById('team-detail-view').classList.add('hidden');
    document.getElementById('player-detail-view').classList.remove('hidden');
    document.getElementById('main-nav').classList.add('hidden');
    
    // Update URL
    history.pushState({}, '', `/static/viewer/?player_id=${playerId}`);
    
    loadPlayerDetail(playerId);
}

// =============================================================================
// Data Loading
// =============================================================================

async function loadAllData() {
    updateConnectionStatus('connecting');
    try {
        await Promise.all([loadGames(), loadTeams(), loadPlayers()]);
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Failed to load data:', error);
        updateConnectionStatus('disconnected');
    }
}

async function loadGames() {
    const container = document.getElementById('games-list');
    try {
        const response = await fetch(`${API_BASE_URL}/api/games`);
        if (!response.ok) throw new Error(`Failed to fetch games: ${response.statusText}`);
        
        const data = await response.json();
        gamesCache = data.games || [];
        
        renderGamesList(gamesCache, container);
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Failed to load games:', error);
        container.innerHTML = `<div class="error-message">Failed to load games: ${error.message}</div>`;
        updateConnectionStatus('disconnected');
    }
}

async function loadTeams() {
    const container = document.getElementById('teams-list');
    try {
        const response = await fetch(`${API_BASE_URL}/api/teams`);
        if (!response.ok) throw new Error(`Failed to fetch teams: ${response.statusText}`);
        
        const data = await response.json();
        teamsCache = data.teams || [];
        
        renderTeamsList(teamsCache, container);
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Failed to load teams:', error);
        container.innerHTML = `<div class="error-message">Failed to load teams: ${error.message}</div>`;
        updateConnectionStatus('disconnected');
    }
}

async function loadPlayers() {
    const container = document.getElementById('players-list');
    try {
        const response = await fetch(`${API_BASE_URL}/api/players`);
        if (!response.ok) throw new Error(`Failed to fetch players: ${response.statusText}`);
        
        const data = await response.json();
        playersCache = data.players || [];
        
        renderPlayersList(playersCache, container);
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Failed to load players:', error);
        container.innerHTML = `<div class="error-message">Failed to load players: ${error.message}</div>`;
        updateConnectionStatus('disconnected');
    }
}

async function loadTeamDetail(teamId) {
    try {
        const [teamResponse, playersResponse, gamesResponse] = await Promise.all([
            fetch(`${API_BASE_URL}/api/teams/${teamId}`),
            fetch(`${API_BASE_URL}/api/teams/${teamId}/players`),
            fetch(`${API_BASE_URL}/api/teams/${teamId}/games`)
        ]);
        
        if (!teamResponse.ok) throw new Error('Team not found');
        
        const team = await teamResponse.json();
        const playersData = await playersResponse.json();
        const gamesData = await gamesResponse.json();
        
        document.getElementById('team-name').textContent = team.name;
        document.getElementById('team-id-display').textContent = `ID: ${team.id}`;
        document.getElementById('team-player-count').textContent = playersData.players?.length || 0;
        document.getElementById('team-game-count').textContent = gamesData.game_ids?.length || 0;
        
        // Phase 4: Load and compute season stats
        loadTeamSeasonStats(teamId, gamesData.game_ids || []);
        
        // Render players with gender-based color coding
        const playersContainer = document.getElementById('team-players-list');
        if (playersData.players && playersData.players.length > 0) {
            playersContainer.innerHTML = playersData.players.map(p => {
                const genderClass = p.gender === 'FMP' ? 'gender-fmp' : p.gender === 'MMP' ? 'gender-mmp' : '';
                return `
                    <a href="?player_id=${p.id}" class="mini-item ${genderClass}" onclick="event.preventDefault(); showPlayerDetail('${p.id}')">
                        <span class="mini-name">${p.name}</span>
                        <span class="mini-badge">#${p.number || '-'}</span>
                    </a>
                `;
            }).join('');
        } else {
            playersContainer.innerHTML = '<div class="empty-state">No players</div>';
        }
        
        // Render games (need to fetch game details)
        const gamesContainer = document.getElementById('team-games-list');
        if (gamesData.game_ids && gamesData.game_ids.length > 0) {
            gamesContainer.innerHTML = gamesData.game_ids.map(gameId => `
                <a href="?game_id=${gameId}" class="mini-item" onclick="event.preventDefault(); showGameDetail('${gameId}')">
                    <span class="mini-name">${formatGameId(gameId)}</span>
                </a>
            `).join('');
        } else {
            gamesContainer.innerHTML = '<div class="empty-state">No games</div>';
        }
        
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Failed to load team:', error);
        document.getElementById('team-name').textContent = 'Error loading team';
        updateConnectionStatus('disconnected');
    }
}

async function loadPlayerDetail(playerId) {
    try {
        const [playerResponse, gamesResponse, teamsResponse] = await Promise.all([
            fetch(`${API_BASE_URL}/api/players/${playerId}`),
            fetch(`${API_BASE_URL}/api/players/${playerId}/games`),
            fetch(`${API_BASE_URL}/api/players/${playerId}/teams`)
        ]);
        
        if (!playerResponse.ok) throw new Error('Player not found');
        
        const player = await playerResponse.json();
        const gamesData = await gamesResponse.json();
        const teamsData = teamsResponse.ok ? await teamsResponse.json() : { teams: [] };
        
        document.getElementById('player-name').textContent = player.name;
        document.getElementById('player-id-display').textContent = `ID: ${player.id}`;
        document.getElementById('player-number').textContent = player.number || '-';
        
        // Set gender with color styling
        const genderEl = document.getElementById('player-gender');
        genderEl.textContent = player.gender || '-';
        genderEl.classList.remove('gender-fmp', 'gender-mmp');
        if (player.gender === 'FMP') {
            genderEl.classList.add('gender-fmp');
        } else if (player.gender === 'MMP') {
            genderEl.classList.add('gender-mmp');
        }
        
        document.getElementById('player-game-count').textContent = gamesData.game_ids?.length || 0;
        
        // Phase 4: Load and compute career stats
        loadPlayerCareerStats(playerId, gamesData.game_ids || []);
        
        // Render teams
        const teamsContainer = document.getElementById('player-teams-list');
        if (teamsData.teams && teamsData.teams.length > 0) {
            teamsContainer.innerHTML = teamsData.teams.map(team => `
                <a href="?team_id=${team.id}" class="mini-item" onclick="event.preventDefault(); showTeamDetail('${team.id}')">
                    <span class="mini-name">${team.name}</span>
                </a>
            `).join('');
        } else {
            teamsContainer.innerHTML = '<div class="empty-state">Not on any teams</div>';
        }
        
        // Render games
        const gamesContainer = document.getElementById('player-games-list');
        if (gamesData.game_ids && gamesData.game_ids.length > 0) {
            gamesContainer.innerHTML = gamesData.game_ids.map(gameId => `
                <a href="?game_id=${gameId}" class="mini-item" onclick="event.preventDefault(); showGameDetail('${gameId}')">
                    <span class="mini-name">${formatGameId(gameId)}</span>
                </a>
            `).join('');
        } else {
            gamesContainer.innerHTML = '<div class="empty-state">No games</div>';
        }
        
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Failed to load player:', error);
        document.getElementById('player-name').textContent = 'Error loading player';
        updateConnectionStatus('disconnected');
    }
}

// =============================================================================
// List Rendering
// =============================================================================

function renderGamesList(games, container) {
    if (games.length === 0) {
        container.innerHTML = '<div class="empty-state">No games found</div>';
        return;
    }
    
    // Sort by date, newest first
    games.sort((a, b) => {
        const dateA = new Date(a.game_start_timestamp || 0);
        const dateB = new Date(b.game_start_timestamp || 0);
        return dateB - dateA;
    });
    
    container.innerHTML = games.map(game => {
        const date = game.game_start_timestamp ? new Date(game.game_start_timestamp) : null;
        const dateStr = date ? date.toLocaleDateString() : 'Unknown date';
        const scores = game.scores || {};
        const teamScore = scores.team || 0;
        const oppScore = scores.opponent || 0;
        const isInProgress = !game.game_end_timestamp;
        const isPending = game._localOnly || isLocalOnly('game', game.game_id);
        const localOnlyClass = isPending ? 'local-only' : '';
        
        return `
            <a href="?game_id=${game.game_id}" class="entity-card game-card ${localOnlyClass}" onclick="event.preventDefault(); showGameDetail('${game.game_id}')">
                <div class="card-header">
                    <span class="card-title">${game.team} vs ${game.opponent}</span>
                    ${isInProgress ? '<span class="live-badge">LIVE</span>' : ''}
                    ${isPending ? '<span class="pending-sync-badge"><span class="pending-icon">⏳</span>Pending</span>' : ''}
                </div>
                <div class="card-meta">
                    <span class="card-date">${dateStr}</span>
                    <span class="card-score">${teamScore} - ${oppScore}</span>
                    <span class="card-points">${game.points_count || 0} pts</span>
                </div>
            </a>
        `;
    }).join('');
}

function renderTeamsList(teams, container) {
    if (teams.length === 0) {
        container.innerHTML = '<div class="empty-state">No teams found. Create teams in the PWA to see them here.</div>';
        return;
    }
    
    container.innerHTML = teams.map(team => {
        const playerCount = team.playerIds?.length || 0;
        const isPending = team._localOnly || isLocalOnly('team', team.id);
        const localOnlyClass = isPending ? 'local-only' : '';
        
        return `
            <a href="?team_id=${team.id}" class="entity-card team-card ${localOnlyClass}" onclick="event.preventDefault(); showTeamDetail('${team.id}')">
                <div class="card-header">
                    <span class="card-title">${team.name}</span>
                    ${isPending ? '<span class="pending-sync-badge"><span class="pending-icon">⏳</span>Pending</span>' : ''}
                </div>
                <div class="card-meta">
                    <span class="card-id">${team.id}</span>
                    <span class="card-count">${playerCount} players</span>
                </div>
            </a>
        `;
    }).join('');
}

function renderPlayersList(players, container) {
    if (players.length === 0) {
        container.innerHTML = '<div class="empty-state">No players found. Create players in the PWA to see them here.</div>';
        return;
    }
    
    container.innerHTML = players.map(player => {
        const genderClass = player.gender === 'FMP' ? 'gender-fmp' : player.gender === 'MMP' ? 'gender-mmp' : '';
        const isPending = player._localOnly || isLocalOnly('player', player.id);
        const localOnlyClass = isPending ? 'local-only' : '';
        
        return `
            <a href="?player_id=${player.id}" class="entity-card player-card ${genderClass} ${localOnlyClass}" onclick="event.preventDefault(); showPlayerDetail('${player.id}')">
                <div class="card-header">
                    <span class="card-title">${player.name}</span>
                    ${player.number ? `<span class="player-number">#${player.number}</span>` : ''}
                    ${isPending ? '<span class="pending-sync-badge"><span class="pending-icon">⏳</span>Pending</span>' : ''}
                </div>
                <div class="card-meta">
                    <span class="card-id">${player.id}</span>
                    ${player.gender ? `<span class="card-gender">${player.gender}</span>` : ''}
                </div>
            </a>
        `;
    }).join('');
}

// =============================================================================
// Game Detail & Polling
// =============================================================================

function startGamePolling() {
    if (isPolling) return;
    isPolling = true;
    
    updateConnectionStatus('connecting');
    loadGameDetail();
    
    pollingInterval = setInterval(async () => {
        try {
            await loadGameDetail();
            updateConnectionStatus('connected');
        } catch (error) {
            console.error('Poll failed:', error);
            updateConnectionStatus('disconnected');
        }
    }, POLL_INTERVAL);
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
    isPolling = false;
    currentGameId = null;
    lastGameVersion = null;
}

async function loadGameDetail() {
    if (!currentGameId) return;
    
    const response = await fetch(`${API_BASE_URL}/api/games/${currentGameId}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch game: ${response.statusText}`);
    }

    const gameData = await response.json();
    
    // Check if data changed
    const currentDataJson = JSON.stringify(gameData);
    if (lastGameVersion !== currentDataJson) {
        lastGameVersion = currentDataJson;
        renderGame(gameData);
    }
    
    updateConnectionStatus('connected');
}

/**
 * Resolve a player ID to display name (nickname if present, otherwise name)
 * Falls back to the ID itself if not found in rosterSnapshot
 */
function resolvePlayerName(playerId) {
    if (!playerId) return 'Unknown';
    
    // Check if we have a mapping
    if (playerIdToName[playerId]) {
        return playerIdToName[playerId];
    }
    
    // If it doesn't look like an ID (no hyphen with 4-char suffix), it's probably already a name
    if (!playerId.includes('-') || playerId.length < 6) {
        return playerId;
    }
    
    // Extract name portion from ID (everything before the last hyphen)
    const lastHyphen = playerId.lastIndexOf('-');
    if (lastHyphen > 0) {
        return playerId.substring(0, lastHyphen);
    }
    
    return playerId;
}

/**
 * Build player ID to name lookup from rosterSnapshot
 */
function buildPlayerLookup(game) {
    playerIdToName = {};
    
    if (game.rosterSnapshot && game.rosterSnapshot.players) {
        game.rosterSnapshot.players.forEach(player => {
            // Prefer nickname if present, otherwise use name
            const displayName = player.nickname || player.name;
            playerIdToName[player.id] = displayName;
        });
    }
}

function renderGame(game) {
    // Build player lookup for this game
    buildPlayerLookup(game);
    
    // Render Header
    document.getElementById('game-title').textContent = `${game.team} vs ${game.opponent}`;
    document.getElementById('game-id').textContent = `ID: ${currentGameId}`;
    
    const date = new Date(game.gameStartTimestamp);
    document.getElementById('game-date').textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    const scores = game.scores || { team: 0, opponent: 0 };
    const teamScore = scores.team || scores[game.team] || 0;
    const oppScore = scores.opponent || scores[game.opponent] || 0;
    
    document.getElementById('game-score').textContent = `${teamScore} - ${oppScore}`;
    
    // Stats
    document.getElementById('total-points').textContent = (game.points || []).length;
    
    // Duration = wall-clock time from start to end (or now if in progress)
    if (game.gameStartTimestamp) {
        const start = new Date(game.gameStartTimestamp);
        const end = game.gameEndTimestamp ? new Date(game.gameEndTimestamp) : null;
        if (end) {
            const diffSeconds = Math.floor((end - start) / 1000);
            document.getElementById('game-duration').textContent = formatDuration(diffSeconds);
        } else {
            // Game in progress - show "--:--" since wall-clock from weeks ago is meaningless
            document.getElementById('game-duration').textContent = '--:--';
        }
    } else {
        document.getElementById('game-duration').textContent = '--:--';
    }
    
    // Play Time = sum of actual point durations (excludes timeouts, halftime, etc.)
    let totalPlayedMs = 0;
    (game.points || []).forEach(point => {
        if (point.totalPointTime) {
            totalPlayedMs += point.totalPointTime;
        }
    });
    
    const playTimeEl = document.getElementById('game-play-time');
    if (playTimeEl) {
        if (totalPlayedMs > 0) {
            playTimeEl.textContent = formatDuration(Math.floor(totalPlayedMs / 1000));
        } else {
            playTimeEl.textContent = '--:--';
        }
    }
    
    // Show data format indicator (Phase 2)
    const formatIndicator = document.getElementById('data-format-indicator');
    if (formatIndicator) {
        const hasTeamId = !!game.teamId;
        const hasRosterSnapshot = !!game.rosterSnapshot;
        const isNewFormat = hasTeamId || hasRosterSnapshot;
        
        if (isNewFormat) {
            formatIndicator.textContent = 'New Format';
            formatIndicator.className = 'format-badge new-format';
            formatIndicator.title = `teamId: ${game.teamId || 'none'}, rosterSnapshot: ${hasRosterSnapshot ? 'yes' : 'no'}`;
        } else {
            formatIndicator.textContent = 'Legacy';
            formatIndicator.className = 'format-badge legacy-format';
            formatIndicator.title = 'Legacy format (name-based references)';
        }
        formatIndicator.style.display = 'inline-block';
    }

    // Render Points
    const pointsContainer = document.getElementById('points-container');
    
    // Save expanded state
    const expandedPoints = new Set();
    document.querySelectorAll('.point-content.expanded').forEach(el => {
        expandedPoints.add(el.getAttribute('data-point-index'));
    });

    // Check scroll position
    const isNearBottom = (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 100;

    pointsContainer.innerHTML = '';

    const totalPoints = (game.points || []).length;

    (game.points || []).forEach((point, index) => {
        const pointEl = createPointElement(point, index + 1, game.team, game.opponent);
        pointsContainer.appendChild(pointEl);

        const isLast = index === totalPoints - 1;
        const isInProgress = !point.winner;
        
        if (expandedPoints.has(String(index)) || (isLast && (isInProgress || expandedPoints.size === 0))) {
            const content = pointEl.querySelector('.point-content');
            content.classList.add('expanded');
        }
        pointEl.querySelector('.point-content').setAttribute('data-point-index', index);
    });

    if (isNearBottom) {
        window.scrollTo(0, document.body.scrollHeight);
    }
}

function createPointElement(point, pointNumber, teamName, opponentName) {
    const div = document.createElement('div');
    div.className = 'point-card';
    
    let resultClass = '';
    let resultText = 'In Progress';
    
    if (point.winner) {
        if (point.winner === 'team' || point.winner === teamName) {
            resultClass = 'our-score';
            resultText = `${teamName} Score`;
        } else {
            resultClass = 'their-score';
            resultText = `${opponentName} Score`;
        }
    }

    const durationSeconds = point.totalPointTime ? Math.floor(point.totalPointTime / 1000) : 0;
    const summary = `Duration: ${formatDuration(durationSeconds)}`;
    // Resolve player IDs to names
    const rosterList = (point.players || []).map(p => resolvePlayerName(p)).join(', ');

    div.innerHTML = `
        <div class="point-header" onclick="togglePoint(this)">
            <div class="point-title">
                <span>Point ${pointNumber}: ${rosterList}</span>
                <span class="point-score-summary">${summary}</span>
            </div>
            <span class="point-result ${resultClass}">${resultText}</span>
        </div>
        <div class="point-content">
            ${renderPossessions(point.possessions)}
        </div>
    `;
    return div;
}

function renderPossessions(possessions) {
    if (!possessions || possessions.length === 0) return '<div class="possession">No possessions yet</div>';
    
    return possessions.map((pos, index) => `
        <div class="possession">
            <div class="possession-header">
                ${pos.offensive ? 'Offense' : 'Defense'}
            </div>
            <div class="events-list">
                ${(pos.events || []).map(event => renderEvent(event)).join('')}
            </div>
        </div>
    `).join('');
}

function renderEvent(event) {
    let type = event.type;
    let desc = '';
    
    if (type === 'Throw') {
        let verb = event.huck_flag ? 'hucks' : 'throws';
        desc = `${event.thrower || 'Unknown'} ${verb} `;
        let throwType = '';
        if (event.break_flag) throwType += 'break ';
        if (event.hammer_flag) throwType += 'hammer ';
        if (event.dump_flag) throwType += 'dump ';
        if (throwType) desc += `a ${throwType}`;
        if (event.receiver) desc += `to ${event.receiver} `;
        if (event.sky_flag || event.layout_flag) {
            desc += `for a ${event.sky_flag ? "sky ":""}${event.layout_flag ? "layout ":""}catch `;
        }        
        if (event.score_flag) desc += 'for the score!';
        
    } else if (type === 'Turnover') {
        const t = event.thrower || "Unknown";
        const r = event.receiver || "Unknown";
        const hucktxt = event.huck_flag ? 'on a huck' : '';
        const defensetxt = event.defense_flag ? 'due to good defense' : '';
        if (event.throwaway_flag) desc = `${t} throws it away ${hucktxt} ${defensetxt}`;
        else if (event.drop_flag) desc = `${r} misses the catch from ${t} ${hucktxt} ${defensetxt}`;
        else if (event.defense_flag) desc = `Turnover ${defensetxt}`;
        else if (event.stall_flag) desc = `${t} gets stalled ${defensetxt}`;
        else desc = `Turnover by ${t}`;

    } else if (type === 'Defense') {
        let summary = '';
        let defender = event.defender || '';
        if (event.interception_flag) summary += 'Interception ';
        if (event.layout_flag) summary += 'Layout D ';
        if (event.sky_flag) summary += 'Sky D ';
        if (event.Callahan_flag) summary += 'Callahan ';
        if (event.stall_flag) summary += 'Stall ';
        if (event.unforcedError_flag) summary += 'Unforced error ';
        if (defender) {
            summary += (summary ? '' : 'Turnover caused ') + `by ${defender}`;
        } else {
            summary = summary || 'Unforced turnover by opponent';
        }
        desc = summary;

    } else if (type === 'Pull') {
        let pullerName = event.puller || 'Unknown';
        desc = `Pull by ${pullerName}`;
        if (event.quality) desc += ` (${event.quality})`;
        let pullType = [];
        if (event.flick_flag) pullType.push('Flick');
        if (event.roller_flag) pullType.push('Roller');
        if (event.io_flag) pullType.push('IO');
        if (event.oi_flag) pullType.push('OI');
        if (pullType.length > 0) desc += ` - ${pullType.join(', ')}`;

    } else if (type === 'Violation') {
        let summary = 'Violation called: ';
        if (event.ofoul_flag) summary += 'Offensive foul ';
        if (event.strip_flag) summary += 'Strip ';
        if (event.pick_flag) summary += 'Pick ';
        if (event.travel_flag) summary += 'Travel ';
        if (event.contest_flag) summary += 'Contested foul ';
        if (event.dblteam_flag) summary += 'Double team ';
        desc = summary;

    } else if (type === 'Other') {
        let summary = '';
        if (event.timeout_flag) summary += 'Timeout called. ';
        if (event.injury_flag) summary += 'Injury sub called ';
        if (event.timecap_flag) summary += 'Hard cap called; game over ';
        if (event.switchsides_flag) summary += 'O and D switch sides ';
        if (event.halftime_flag) summary += 'Halftime ';
        desc = summary;

    } else {
        desc = type;
    }

    return `
        <div class="event-item">
            <span class="event-type ${type}">${type}</span>
            <span class="event-desc">${desc}</span>
        </div>
    `;
}

// =============================================================================
// Utility Functions
// =============================================================================

function togglePoint(header) {
    const content = header.nextElementSibling;
    content.classList.toggle('expanded');
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatGameId(gameId) {
    // Extract date and teams from game ID
    // Format: YYYY-MM-DD_Team_vs_Opponent_Timestamp
    const parts = gameId.split('_');
    if (parts.length >= 4) {
        const date = parts[0];
        const team = parts[1];
        const opponent = parts[3];
        return `${date}: ${team} vs ${opponent}`;
    }
    return gameId;
}

function updateConnectionStatus(status) {
    const badge = document.getElementById('connection-status');
    badge.className = `status-badge ${status}`;
    
    if (status === 'connected') badge.textContent = 'Connected';
    else if (status === 'connecting') badge.textContent = 'Loading...';
    else if (status === 'disconnected') badge.textContent = 'Disconnected';
}

// Handle browser back button
window.addEventListener('popstate', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const gameId = urlParams.get('game_id');
    const teamId = urlParams.get('team_id');
    const playerId = urlParams.get('player_id');
    
    if (gameId) showGameDetail(gameId);
    else if (teamId) showTeamDetail(teamId);
    else if (playerId) showPlayerDetail(playerId);
    else showHomeView();
});

// =============================================================================
// Sync Status Functions (Phase 3)
// =============================================================================

/**
 * Start polling for sync status from the PWA (via localStorage)
 * This allows the viewer to show sync status even when the PWA is open in another tab
 */
function startSyncStatusPolling() {
    updateSyncStatusDisplay();
    syncStatusInterval = setInterval(updateSyncStatusDisplay, SYNC_STATUS_POLL_INTERVAL);
}

/**
 * Stop sync status polling
 */
function stopSyncStatusPolling() {
    if (syncStatusInterval) {
        clearInterval(syncStatusInterval);
        syncStatusInterval = null;
    }
}

/**
 * Get sync status from localStorage (shared with PWA)
 */
function getSyncStatusFromStorage() {
    try {
        const queueData = localStorage.getItem('ultistats_sync_queue');
        const queue = queueData ? JSON.parse(queueData) : [];
        
        // Count by type
        const counts = { player: 0, team: 0, game: 0 };
        queue.forEach(item => {
            if (counts[item.type] !== undefined) {
                counts[item.type]++;
            }
        });
        
        // Check local-only entities
        const localPlayers = JSON.parse(localStorage.getItem('ultistats_local_players') || '{}');
        const localTeams = JSON.parse(localStorage.getItem('ultistats_local_teams') || '{}');
        const localGames = JSON.parse(localStorage.getItem('ultistats_local_games') || '{}');
        
        return {
            isOnline: navigator.onLine,
            pendingCount: queue.length,
            pendingByType: counts,
            localPlayersCount: Object.keys(localPlayers).filter(k => localPlayers[k]._localOnly).length,
            localTeamsCount: Object.keys(localTeams).filter(k => localTeams[k]._localOnly).length,
            localGamesCount: Object.keys(localGames).filter(k => localGames[k]._localOnly).length
        };
    } catch (e) {
        console.error('Failed to get sync status:', e);
        return null;
    }
}

/**
 * Update the sync status display in the header
 */
function updateSyncStatusDisplay() {
    const status = getSyncStatusFromStorage();
    if (!status) return;
    
    lastSyncStatus = status;
    
    const syncStatusEl = document.getElementById('sync-status');
    const syncQueuePanel = document.getElementById('sync-queue-panel');
    
    if (syncStatusEl) {
        const totalPending = status.pendingCount;
        const hasLocalOnly = status.localPlayersCount + status.localTeamsCount + status.localGamesCount > 0;
        
        if (totalPending > 0 || hasLocalOnly) {
            syncStatusEl.className = 'sync-status has-pending';
            syncStatusEl.innerHTML = `
                <span class="sync-icon">⏳</span>
                <span>${totalPending} pending</span>
            `;
            syncStatusEl.title = `${status.pendingByType.player} players, ${status.pendingByType.team} teams, ${status.pendingByType.game} games pending sync`;
        } else {
            syncStatusEl.className = 'sync-status';
            syncStatusEl.innerHTML = `
                <span class="sync-icon">✓</span>
                <span>Synced</span>
            `;
            syncStatusEl.title = 'All data synced to server';
        }
    }
    
    // Update sync queue panel if visible
    if (syncQueuePanel && syncQueuePanel.classList.contains('visible')) {
        updateSyncQueuePanel(status);
    }
    
    // Update offline banner
    const offlineBanner = document.getElementById('offline-banner');
    if (offlineBanner) {
        if (!status.isOnline) {
            offlineBanner.classList.add('visible');
        } else {
            offlineBanner.classList.remove('visible');
        }
    }
}

/**
 * Update the sync queue panel content
 */
function updateSyncQueuePanel(status) {
    const statsEl = document.getElementById('sync-queue-stats');
    if (!statsEl) return;
    
    statsEl.innerHTML = `
        <div class="sync-queue-stat ${status.pendingByType.player > 0 ? 'pending' : ''}">
            <span class="stat-icon">👤</span>
            <span>${status.pendingByType.player} players</span>
        </div>
        <div class="sync-queue-stat ${status.pendingByType.team > 0 ? 'pending' : ''}">
            <span class="stat-icon">👥</span>
            <span>${status.pendingByType.team} teams</span>
        </div>
        <div class="sync-queue-stat ${status.pendingByType.game > 0 ? 'pending' : ''}">
            <span class="stat-icon">🎮</span>
            <span>${status.pendingByType.game} games</span>
        </div>
    `;
    
    // Update sync button state
    const syncBtn = document.getElementById('sync-now-btn');
    if (syncBtn) {
        syncBtn.disabled = !status.isOnline || status.pendingCount === 0;
        syncBtn.textContent = status.isOnline ? 'Sync Now' : 'Offline';
    }
}

/**
 * Toggle sync queue panel visibility
 */
function toggleSyncQueuePanel() {
    const panel = document.getElementById('sync-queue-panel');
    if (panel) {
        panel.classList.toggle('visible');
        if (panel.classList.contains('visible')) {
            updateSyncQueuePanel(lastSyncStatus || getSyncStatusFromStorage());
        }
    }
}

/**
 * Trigger sync (calls PWA's sync function if available)
 */
async function triggerSync() {
    const syncBtn = document.getElementById('sync-now-btn');
    if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing...';
    }
    
    try {
        // Try to call the PWA's sync function if available (same tab)
        if (typeof window.processSyncQueue === 'function') {
            await window.processSyncQueue();
        } else {
            // Otherwise, just refresh data from server
            await loadAllData();
        }
        
        // Update sync status
        updateSyncStatusDisplay();
        
    } catch (error) {
        console.error('Sync failed:', error);
    } finally {
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.textContent = 'Sync Now';
        }
    }
}

/**
 * Refresh data from server
 */
async function refreshFromServer() {
    updateConnectionStatus('connecting');
    try {
        await loadAllData();
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Refresh failed:', error);
        updateConnectionStatus('disconnected');
    }
}

/**
 * Check if an entity is local-only (pending sync)
 */
function isLocalOnly(type, id) {
    try {
        let storageKey;
        switch (type) {
            case 'player': storageKey = 'ultistats_local_players'; break;
            case 'team': storageKey = 'ultistats_local_teams'; break;
            case 'game': storageKey = 'ultistats_local_games'; break;
            default: return false;
        }
        
        const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
        return data[id] && data[id]._localOnly;
    } catch (e) {
        return false;
    }
}

// =============================================================================
// Career Stats Functions (Phase 4)
// =============================================================================

/**
 * Load and compute career stats for a player
 * @param {string} playerId - Player ID
 * @param {Array} gameIds - List of game IDs the player participated in
 */
async function loadPlayerCareerStats(playerId, gameIds) {
    // Initialize with placeholder values
    const statElements = {
        games: document.getElementById('career-games'),
        points: document.getElementById('career-points'),
        goals: document.getElementById('career-goals'),
        assists: document.getElementById('career-assists'),
        ds: document.getElementById('career-ds'),
        turnovers: document.getElementById('career-turnovers'),
        plusminus: document.getElementById('career-plusminus'),
        compPct: document.getElementById('career-comp-pct')
    };
    
    // Set loading state
    Object.values(statElements).forEach(el => {
        if (el) el.textContent = '...';
    });
    
    if (!gameIds || gameIds.length === 0) {
        Object.values(statElements).forEach(el => {
            if (el) el.textContent = '0';
        });
        if (statElements.compPct) statElements.compPct.textContent = '-';
        return;
    }
    
    try {
        // Fetch all games and compute stats
        const stats = {
            games: gameIds.length,
            points: 0,
            goals: 0,
            assists: 0,
            ds: 0,
            turnovers: 0,
            pointsWon: 0,
            pointsLost: 0,
            completions: 0,
            totalThrows: 0
        };
        
        // Fetch games in batches to avoid overwhelming the server
        const batchSize = 5;
        for (let i = 0; i < gameIds.length; i += batchSize) {
            const batch = gameIds.slice(i, i + batchSize);
            const gamePromises = batch.map(gameId => 
                fetch(`${API_BASE_URL}/api/games/${gameId}`).then(r => r.ok ? r.json() : null)
            );
            
            const games = await Promise.all(gamePromises);
            
            games.forEach(game => {
                if (!game) return;
                
                const playerStats = computePlayerStatsFromGame(game, playerId);
                stats.points += playerStats.points;
                stats.goals += playerStats.goals;
                stats.assists += playerStats.assists;
                stats.ds += playerStats.ds;
                stats.turnovers += playerStats.turnovers;
                stats.pointsWon += playerStats.pointsWon;
                stats.pointsLost += playerStats.pointsLost;
                stats.completions += playerStats.completions;
                stats.totalThrows += playerStats.totalThrows;
            });
        }
        
        // Update display
        if (statElements.games) statElements.games.textContent = stats.games;
        if (statElements.points) statElements.points.textContent = stats.points;
        if (statElements.goals) statElements.goals.textContent = stats.goals;
        if (statElements.assists) statElements.assists.textContent = stats.assists;
        if (statElements.ds) statElements.ds.textContent = stats.ds;
        if (statElements.turnovers) statElements.turnovers.textContent = stats.turnovers;
        
        const plusMinus = stats.pointsWon - stats.pointsLost;
        if (statElements.plusminus) {
            statElements.plusminus.textContent = plusMinus > 0 ? `+${plusMinus}` : plusMinus;
            statElements.plusminus.className = 'stat-value ' + (plusMinus > 0 ? 'positive' : plusMinus < 0 ? 'negative' : '');
        }
        
        if (statElements.compPct) {
            if (stats.totalThrows > 0) {
                const pct = Math.round((stats.completions / stats.totalThrows) * 100);
                statElements.compPct.textContent = `${pct}%`;
            } else {
                statElements.compPct.textContent = '-';
            }
        }
        
    } catch (error) {
        console.error('Failed to load career stats:', error);
        Object.values(statElements).forEach(el => {
            if (el) el.textContent = '-';
        });
    }
}

/**
 * Compute player stats from a single game
 * @param {Object} game - Game data
 * @param {string} playerId - Player ID to compute stats for
 * @returns {Object} Stats object
 */
function computePlayerStatsFromGame(game, playerId) {
    const stats = {
        points: 0,
        goals: 0,
        assists: 0,
        ds: 0,
        turnovers: 0,
        pointsWon: 0,
        pointsLost: 0,
        completions: 0,
        totalThrows: 0
    };
    
    if (!game.points) return stats;
    
    // Find player name(s) - check roster snapshot and legacy name matching
    const playerNames = new Set();
    playerNames.add(playerId);
    
    if (game.rosterSnapshot && game.rosterSnapshot.players) {
        const snapshotPlayer = game.rosterSnapshot.players.find(p => p.id === playerId);
        if (snapshotPlayer) {
            playerNames.add(snapshotPlayer.name);
        }
    }
    
    // Also try to extract name from ID (format: Name-hash)
    const lastHyphen = playerId.lastIndexOf('-');
    if (lastHyphen > 0) {
        playerNames.add(playerId.substring(0, lastHyphen));
    }
    
    game.points.forEach(point => {
        // Check if player was in this point
        const wasInPoint = point.players && point.players.some(p => playerNames.has(p));
        
        if (wasInPoint) {
            stats.points++;
            
            if (point.winner === 'team') {
                stats.pointsWon++;
            } else if (point.winner === 'opponent') {
                stats.pointsLost++;
            }
        }
        
        // Scan events for this player's actions
        if (point.possessions) {
            point.possessions.forEach(possession => {
                if (!possession.events) return;
                
                possession.events.forEach(event => {
                    const thrower = event.thrower || event.throwerId;
                    const receiver = event.receiver || event.receiverId;
                    const defender = event.defender || event.defenderId;
                    
                    if (event.type === 'Throw') {
                        if (thrower && playerNames.has(thrower)) {
                            stats.totalThrows++;
                            stats.completions++;
                            if (event.score_flag && receiver && playerNames.has(receiver)) {
                                stats.goals++;
                            } else if (event.score_flag) {
                                stats.assists++;
                            }
                        } else if (receiver && playerNames.has(receiver)) {
                            if (event.score_flag) {
                                stats.goals++;
                            }
                        }
                    } else if (event.type === 'Turnover') {
                        if (thrower && playerNames.has(thrower)) {
                            stats.totalThrows++;
                            stats.turnovers++;
                        }
                    } else if (event.type === 'Defense') {
                        if (defender && playerNames.has(defender)) {
                            stats.ds++;
                            if (event.Callahan_flag) {
                                stats.goals++;
                            }
                        }
                    }
                });
            });
        }
    });
    
    return stats;
}

/**
 * Load and compute season stats for a team
 * @param {string} teamId - Team ID
 * @param {Array} gameIds - List of game IDs
 */
async function loadTeamSeasonStats(teamId, gameIds) {
    const statElements = {
        games: document.getElementById('season-games'),
        wins: document.getElementById('season-wins'),
        losses: document.getElementById('season-losses'),
        pointsFor: document.getElementById('season-points-for'),
        pointsAgainst: document.getElementById('season-points-against'),
        pointDiff: document.getElementById('season-point-diff')
    };
    
    // Set loading state
    Object.values(statElements).forEach(el => {
        if (el) el.textContent = '...';
    });
    
    if (!gameIds || gameIds.length === 0) {
        Object.values(statElements).forEach(el => {
            if (el) el.textContent = '0';
        });
        return;
    }
    
    try {
        // Use the games cache if available, otherwise fetch
        let games = [];
        
        for (const gameId of gameIds) {
            const cached = gamesCache.find(g => g.game_id === gameId);
            if (cached) {
                games.push(cached);
            } else {
                try {
                    const response = await fetch(`${API_BASE_URL}/api/games/${gameId}`);
                    if (response.ok) {
                        const game = await response.json();
                        games.push({
                            game_id: gameId,
                            scores: game.scores
                        });
                    }
                } catch (e) {
                    // Skip this game
                }
            }
        }
        
        const stats = {
            games: games.length,
            wins: 0,
            losses: 0,
            pointsFor: 0,
            pointsAgainst: 0
        };
        
        games.forEach(game => {
            const scores = game.scores || {};
            const teamScore = scores.team || 0;
            const oppScore = scores.opponent || 0;
            
            stats.pointsFor += teamScore;
            stats.pointsAgainst += oppScore;
            
            if (teamScore > oppScore) {
                stats.wins++;
            } else if (teamScore < oppScore) {
                stats.losses++;
            }
        });
        
        // Update display
        if (statElements.games) statElements.games.textContent = stats.games;
        if (statElements.wins) statElements.wins.textContent = stats.wins;
        if (statElements.losses) statElements.losses.textContent = stats.losses;
        if (statElements.pointsFor) statElements.pointsFor.textContent = stats.pointsFor;
        if (statElements.pointsAgainst) statElements.pointsAgainst.textContent = stats.pointsAgainst;
        
        const pointDiff = stats.pointsFor - stats.pointsAgainst;
        if (statElements.pointDiff) {
            statElements.pointDiff.textContent = pointDiff > 0 ? `+${pointDiff}` : pointDiff;
            statElements.pointDiff.className = 'stat-value ' + (pointDiff > 0 ? 'positive' : pointDiff < 0 ? 'negative' : '');
        }
        
    } catch (error) {
        console.error('Failed to load season stats:', error);
        Object.values(statElements).forEach(el => {
            if (el) el.textContent = '-';
        });
    }
}
