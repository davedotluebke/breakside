/*
 * Team selection screen logic
 * Handles team switching, loading, and creation
 * 
 * Phase 4 update: Cloud team fetching, sync status indicator
 * Phase 6b update: Cloud-only UI - all teams and games are stored in the cloud
 */

function showSelectTeamScreen(firsttime = false) {
    console.log('showSelectTeamScreen called (cloud-only mode)');
    const teamListElement = document.getElementById('teamList');
    const teamListWarning = document.getElementById('teamListWarning');
    if (!teamListElement || !teamListWarning) {
        console.warn('Team selection elements not found in DOM.');
        return;
    }

    teamListElement.innerHTML = '';
    
    // Check if user is authenticated
    const isAuthenticated = window.breakside?.auth?.isAuthenticated?.() || false;
    
    if (!isAuthenticated) {
        // Show login prompt instead of team list
        teamListWarning.style.display = 'block';
        teamListWarning.innerHTML = '<p>Please sign in to access your teams and games.</p>';
        showScreen('selectTeamScreen');
        return;
    }
    
    teamListWarning.style.display = 'none';

    // Add sync status indicator at the top
    const syncStatusContainer = document.createElement('div');
    syncStatusContainer.id = 'syncStatusContainer';
    syncStatusContainer.className = 'sync-status-bar';
    syncStatusContainer.innerHTML = buildSyncStatusHTML();
    teamListElement.appendChild(syncStatusContainer);

    // Teams & Games Section (cloud-only)
    const teamsContainer = document.createElement('div');
    teamsContainer.id = 'cloudTeamsContainer';
    
    // Build header
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '10px';
    header.style.marginBottom = '10px';
    
    const title = document.createElement('h3');
    title.textContent = 'Teams & Games';
    title.style.margin = '0';
    header.appendChild(title);
    
    teamsContainer.appendChild(header);
    
    const teamsList = document.createElement('div');
    teamsList.id = 'cloudTeamsList';
    teamsList.textContent = 'Loading...';
    teamsContainer.appendChild(teamsList);
    
    teamListElement.appendChild(teamsContainer);

    // Populate teams and games asynchronously
    populateCloudTeamsAndGames();

    showScreen('selectTeamScreen');
}

function showSetServerDialog() {
    const currentUrl = localStorage.getItem('ultistats_api_url') || 
        (typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://localhost:8000');
    
    const newUrl = prompt(
        'Enter the server address:\n\n' +
        'Examples:\n' +
        '• https://api.breakside.pro (production)\n' +
        '• http://192.168.1.100:8000 (local network)\n' +
        '• http://localhost:8000 (same device)\n\n' +
        'Leave empty to use auto-detection.',
        currentUrl
    );
    
    if (newUrl === null) {
        // User cancelled
        return;
    }
    
    if (newUrl.trim() === '') {
        // Clear stored URL - will use auto-detection
        localStorage.removeItem('ultistats_api_url');
        alert('Server URL cleared. The app will auto-detect the server on next reload.');
    } else {
        // Validate URL format
        try {
            new URL(newUrl.trim());
            localStorage.setItem('ultistats_api_url', newUrl.trim());
            alert('Server URL updated. Reload the app to apply changes.');
        } catch (e) {
            alert('Invalid URL format. Please enter a valid URL (e.g., http://192.168.1.100:8000)');
            return;
        }
    }
    
    // Offer to reload
    if (confirm('Reload the app now to apply changes?')) {
        window.location.reload();
    }
}

/**
 * Check if a game has active coaches (activity within last 5 minutes)
 * @param {Object} game - Game object with activeCoaches array
 * @returns {boolean}
 */
function isGameActive(game) {
    return game.activeCoaches && game.activeCoaches.length > 0;
}

/**
 * Get the most recent game timestamp for a team
 * @param {Array} games - Array of games
 * @returns {number} - Timestamp in ms (0 if no games)
 */
function getMostRecentGameTimestamp(games) {
    if (!games || games.length === 0) return 0;
    return Math.max(...games.map(g => new Date(g.game_start_timestamp || 0).getTime()));
}

/**
 * Check if a team has any active games
 * @param {Array} games - Array of games for the team
 * @returns {boolean}
 */
function teamHasActiveGames(games) {
    if (!games || games.length === 0) return false;
    return games.some(g => isGameActive(g));
}

/**
 * Populate the cloud-only teams and games list
 * This is the primary UI for selecting teams and games (Phase 6b)
 * 
 * Features:
 * - Collapsible team sections (click to expand/collapse)
 * - Teams sorted by most recent game
 * - Games sorted by most recent within each team
 * - Active game indicator showing coaching names
 * - Teams with active games are auto-expanded
 */
// Track which teams the user has manually expanded/collapsed (survives re-renders)
const _expandedTeams = new Set();
let _expandStateInitialized = false;

async function populateCloudTeamsAndGames() {
    const listElement = document.getElementById('cloudTeamsList');
    if (!listElement) return;

    // Check if user is authenticated
    if (!window.breakside?.auth?.isAuthenticated?.()) {
        listElement.innerHTML = '<p>Please sign in to view your teams.</p>';
        return;
    }

    try {
        // Fetch teams the user has access to
        const response = await authFetch(`${API_BASE_URL}/api/auth/teams`);
        if (!response.ok) {
            if (response.status === 401) {
                listElement.innerHTML = '<p>Session expired. Please sign in again.</p>';
                return;
            }
            throw new Error(`Failed to fetch teams: ${response.statusText}`);
        }
        
        const data = await response.json();
        const userTeams = data.teams || [];
        
        // Also fetch games (includes activeCoaches from server)
        let allGames = [];
        if (typeof listServerGames === 'function') {
            allGames = await listServerGames();
        }
        
        if (userTeams.length === 0) {
            listElement.innerHTML = `
                <p>No teams yet. Create your first team to get started!</p>
                <p style="font-size: 0.9em; color: #666;">
                    Teams and games are stored in the cloud for multi-device access and coach collaboration.
                </p>
            `;
            return;
        }

        // Group games by teamId
        const gamesByTeamId = {};
        allGames.forEach(game => {
            const teamId = game.teamId || null;
            if (!gamesByTeamId[teamId]) {
                gamesByTeamId[teamId] = [];
            }
            gamesByTeamId[teamId].push(game);
        });

        // Sort games within each team by date (newest first)
        for (const teamId in gamesByTeamId) {
            gamesByTeamId[teamId].sort((a, b) => {
                const dateA = new Date(a.game_start_timestamp || 0);
                const dateB = new Date(b.game_start_timestamp || 0);
                return dateB - dateA;
            });
        }

        // Sort teams by most recent game (newest first)
        const sortedTeams = [...userTeams].sort((a, b) => {
            const aGames = gamesByTeamId[a.team.id] || [];
            const bGames = gamesByTeamId[b.team.id] || [];
            const aRecent = getMostRecentGameTimestamp(aGames);
            const bRecent = getMostRecentGameTimestamp(bGames);
            return bRecent - aRecent;
        });

        // Build the collapsible team list
        const container = document.createElement('div');
        container.className = 'teams-list-container';

        sortedTeams.forEach(({ team, role }) => {
            const teamGames = gamesByTeamId[team.id] || [];
            const hasActiveGames = teamHasActiveGames(teamGames);
            
            // Team section container
            const teamSection = document.createElement('div');
            teamSection.className = 'team-section';
            if (hasActiveGames) {
                teamSection.classList.add('has-active-games');
            }

            // Team header (collapsible, two-line layout)
            const teamHeader = document.createElement('div');
            teamHeader.className = 'team-header';
            
            // --- Top row ---
            const topRow = document.createElement('div');
            topRow.className = 'team-header-top';
            
            // Left side of top row
            const topLeft = document.createElement('div');
            topLeft.className = 'team-header-top-left';
            
            if (hasActiveGames) {
                const activeIndicator = document.createElement('span');
                activeIndicator.className = 'team-active-indicator';
                activeIndicator.textContent = '🟢';
                activeIndicator.title = 'Has active games';
                topLeft.appendChild(activeIndicator);
            }
            
            if (team.iconUrl) {
                const teamIcon = document.createElement('img');
                teamIcon.src = team.iconUrl;
                teamIcon.className = 'team-header-icon';
                teamIcon.alt = team.name;
                topLeft.appendChild(teamIcon);
            }
            
            const teamNameSpan = document.createElement('span');
            teamNameSpan.className = 'team-header-name';
            teamNameSpan.textContent = team.name;
            topLeft.appendChild(teamNameSpan);
            
            topRow.appendChild(topLeft);
            
            // Delete button (right side of top row, coaches only)
            if (role === 'coach') {
                const deleteTeamBtn = document.createElement('button');
                deleteTeamBtn.innerHTML = '<i class="fas fa-trash" style="color: #dc3545;"></i>';
                deleteTeamBtn.classList.add('icon-button');
                deleteTeamBtn.title = 'Delete Team';
                deleteTeamBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteCloudTeam(team);
                };
                topRow.appendChild(deleteTeamBtn);
            }
            
            teamHeader.appendChild(topRow);
            
            // --- Bottom row ---
            const bottomRow = document.createElement('div');
            bottomRow.className = 'team-header-bottom';
            
            if (role === 'coach') {
                const roleBadge = document.createElement('span');
                roleBadge.className = 'role-badge coach-badge';
                roleBadge.innerHTML = '<i class="fas fa-clipboard"></i> <span class="role-badge-text">Coach</span>';
                roleBadge.title = 'Coach';
                bottomRow.appendChild(roleBadge);
            }
            
            const gameCount = document.createElement('span');
            gameCount.className = 'game-count';
            gameCount.textContent = `${teamGames.length} game${teamGames.length !== 1 ? 's' : ''}`;
            bottomRow.appendChild(gameCount);
            
            const rosterBtn = document.createElement('button');
            rosterBtn.innerHTML = '<i class="fas fa-users"></i> Roster';
            rosterBtn.classList.add('icon-button', 'text-icon-button');
            rosterBtn.title = 'View Roster';
            rosterBtn.onclick = (e) => {
                e.stopPropagation();
                selectCloudTeam(team);
            };
            bottomRow.appendChild(rosterBtn);
            
            teamHeader.appendChild(bottomRow);
            teamSection.appendChild(teamHeader);

            // Games list (collapsible content)
            const gamesContainer = document.createElement('div');
            gamesContainer.className = 'team-games-container';
            
            // On first render, expand teams with active games; after that, preserve user's choice
            if (!_expandStateInitialized) {
                if (hasActiveGames) _expandedTeams.add(team.id);
            }
            gamesContainer.style.display = _expandedTeams.has(team.id) ? 'block' : 'none';
            
            if (teamGames.length === 0) {
                const noGamesMsg = document.createElement('div');
                noGamesMsg.className = 'no-games-message';
                noGamesMsg.textContent = 'No games yet';
                gamesContainer.appendChild(noGamesMsg);
            } else {
                const gamesList = document.createElement('ul');
                gamesList.className = 'games-list';
                
                teamGames.forEach(game => {
                    const gameItem = document.createElement('li');
                    gameItem.className = 'game-item';
                    if (isGameActive(game)) {
                        gameItem.classList.add('game-active');
                    }
                    
                    // --- Line 1: date vs opponent score ---
                    const line1 = document.createElement('div');
                    line1.className = 'game-line1';
                    
                    const d = game.game_start_timestamp ? new Date(game.game_start_timestamp) : null;
                    const dateStr = d
                        ? `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${String(d.getFullYear()).slice(-2)}`
                        : '??/??/??';
                    const scoreText = `${game.scores?.team || 0}-${game.scores?.opponent || 0}`;
                    line1.textContent = `${dateStr}  vs ${game.opponent || '???'}  ${scoreText}`;
                    gameItem.appendChild(line1);
                    
                    // --- Line 2: Join button + delete ---
                    const line2 = document.createElement('div');
                    line2.className = 'game-line2';
                    
                    if (!game.game_end_timestamp && role === 'coach') {
                        const joinBtn = document.createElement('button');
                        joinBtn.textContent = 'Join';
                        joinBtn.className = 'game-join-btn';
                        joinBtn.title = 'Join Game';
                        joinBtn.onclick = (e) => {
                            e.stopPropagation();
                            resumeCloudGame(team, game.game_id);
                        };
                        line2.appendChild(joinBtn);
                    }
                    
                    // Spacer pushes delete to the right
                    const spacer = document.createElement('span');
                    spacer.style.flex = '1';
                    line2.appendChild(spacer);
                    
                    if (role === 'coach') {
                        const deleteBtn = document.createElement('button');
                        deleteBtn.innerHTML = '<i class="fas fa-trash" style="color: #dc3545;"></i>';
                        deleteBtn.classList.add('icon-button');
                        deleteBtn.title = 'Delete Game';
                        deleteBtn.onclick = (e) => {
                            e.stopPropagation();
                            deleteCloudGameWithConfirm(game.game_id);
                        };
                        line2.appendChild(deleteBtn);
                    }
                    gameItem.appendChild(line2);
                    
                    // --- Line 3 (if active): coaches badge ---
                    if (isGameActive(game)) {
                        const line3 = document.createElement('div');
                        line3.className = 'game-line3';
                        const activeBadge = document.createElement('span');
                        activeBadge.className = 'game-active-badge';
                        const coachNames = game.activeCoaches.join(', ');
                        activeBadge.textContent = `🟢 ${coachNames} coaching`;
                        activeBadge.title = 'Active coaches in this game';
                        line3.appendChild(activeBadge);
                        gameItem.appendChild(line3);
                    }
                    
                    gamesList.appendChild(gameItem);
                });
                
                gamesContainer.appendChild(gamesList);
            }
            
            // "New Game" button for coaches
            if (role === 'coach') {
                const newGameBtn = document.createElement('button');
                newGameBtn.className = 'new-game-btn';
                newGameBtn.innerHTML = '<i class="fas fa-plus"></i> New Game';
                newGameBtn.onclick = (e) => {
                    e.stopPropagation();
                    selectCloudTeam(team);
                };
                gamesContainer.appendChild(newGameBtn);
            }
            
            teamSection.appendChild(gamesContainer);
            
            // Toggle expand/collapse on header click
            teamHeader.onclick = () => {
                const isExpanded = gamesContainer.style.display !== 'none';
                gamesContainer.style.display = isExpanded ? 'none' : 'block';
                if (isExpanded) {
                    _expandedTeams.delete(team.id);
                } else {
                    _expandedTeams.add(team.id);
                }
            };
            
            container.appendChild(teamSection);
        });

        listElement.innerHTML = '';
        listElement.appendChild(container);
        _expandStateInitialized = true;
        
    } catch (error) {
        console.error('Error populating cloud teams:', error);
        listElement.innerHTML = '<p>Error loading teams. Check connection and try again.</p>';
    }
}

// Keep old function name for backwards compatibility
async function populateCloudGames() {
    return populateCloudTeamsAndGames();
}

async function deleteCloudGame(gameId) {
    if (!confirm('Are you sure you want to delete this game from the cloud? This cannot be undone.')) return;
    
    try {
        await deleteGameFromCloud(gameId);
        populateCloudTeamsAndGames(); // Refresh list
    } catch (error) {
        alert('Failed to delete game: ' + error.message);
    }
}

/**
 * Delete a cloud game with confirmation (used by new UI)
 */
async function deleteCloudGameWithConfirm(gameId) {
    if (!confirm('Are you sure you want to delete this game? This cannot be undone.')) return;
    
    try {
        await deleteGameFromCloud(gameId);
        populateCloudTeamsAndGames(); // Refresh list
    } catch (error) {
        alert('Failed to delete game: ' + error.message);
    }
}

/**
 * Select a cloud team and navigate to roster screen
 * Ensures the team is loaded into local state for the app to work with
 */
async function selectCloudTeam(cloudTeam) {
    console.log('📥 Selecting cloud team:', cloudTeam.name);
    
    try {
        // Check if we already have this team in local state
        let localTeam = teams.find(t => t.id === cloudTeam.id);
        
        if (!localTeam) {
            // Team not in local state - sync it
            console.log('📥 Team not in local state, syncing...');
            if (typeof syncUserTeams === 'function') {
                await syncUserTeams();
                localTeam = teams.find(t => t.id === cloudTeam.id);
            }
        }
        
        if (!localTeam) {
            // Still not found - create it from cloud data
            console.log('📥 Creating local team from cloud data...');
            localTeam = new Team(cloudTeam.name, [], cloudTeam.id);
            localTeam.createdAt = cloudTeam.createdAt || new Date().toISOString();
            localTeam.updatedAt = cloudTeam.updatedAt || localTeam.createdAt;
            localTeam.playerIds = cloudTeam.playerIds || [];
            localTeam.lines = cloudTeam.lines || [];
            localTeam.teamSymbol = cloudTeam.teamSymbol || null;
            localTeam.iconUrl = cloudTeam.iconUrl || null;
            
            // Fetch players for the team
            try {
                const playersResponse = await authFetch(`${API_BASE_URL}/api/teams/${cloudTeam.id}/players`);
                if (playersResponse.ok) {
                    const playersData = await playersResponse.json();
                    localTeam.teamRoster = (playersData.players || []).map(p => {
                        if (typeof deserializePlayer === 'function') {
                            return deserializePlayer(p);
                        }
                        return p;
                    });
                }
            } catch (e) {
                console.warn('Failed to fetch team players:', e);
            }
            
            teams.push(localTeam);
            if (typeof saveAllTeamsData === 'function') {
                saveAllTeamsData();
            }
        }
        
        currentTeam = localTeam;
        
        if (typeof updateTeamRosterDisplay === 'function') {
            updateTeamRosterDisplay();
        }
        showScreen('teamRosterScreen');
        
    } catch (error) {
        console.error('Error selecting cloud team:', error);
        alert('Failed to load team: ' + error.message);
    }
}

/**
 * Delete a team from the cloud
 */
async function deleteCloudTeam(team) {
    if (!confirm(`Are you sure you want to delete "${team.name}"?\n\nThis will permanently delete the team and all its games. This cannot be undone.`)) {
        return;
    }
    
    try {
        // Delete from cloud
        if (typeof deleteTeamFromCloud === 'function') {
            await deleteTeamFromCloud(team.id);
        } else {
            // Direct API call if sync function not available
            const response = await authFetch(`${API_BASE_URL}/api/teams/${team.id}`, {
                method: 'DELETE'
            });
            if (!response.ok) {
                throw new Error(`Failed to delete team: ${response.statusText}`);
            }
        }
        
        // Remove from local state
        const localIndex = teams.findIndex(t => t.id === team.id);
        if (localIndex !== -1) {
            teams.splice(localIndex, 1);
            
            // If we deleted the current team, switch to another
            if (currentTeam && currentTeam.id === team.id) {
                currentTeam = teams.length > 0 ? teams[0] : null;
            }
            
            if (typeof saveAllTeamsData === 'function') {
                saveAllTeamsData();
            }
        }
        
        // Refresh the display
        populateCloudTeamsAndGames();
        
    } catch (error) {
        console.error('Error deleting team:', error);
        alert('Failed to delete team: ' + error.message);
    }
}

/**
 * Resume a game from the cloud
 * Loads the game data and enters the appropriate screen
 */
async function resumeCloudGame(cloudTeam, gameId) {
    console.log('📥 Resuming cloud game:', gameId);
    
    try {
        // First ensure the team is loaded
        await selectCloudTeam(cloudTeam);
        
        // Load the game from cloud
        if (typeof loadGameFromCloud !== 'function') {
            throw new Error('Game loading not available');
        }
        
        const game = await loadGameFromCloud(gameId);
        if (!game) {
            throw new Error('Failed to load game data');
        }
        
        // Check if this game already exists in the local team
        const existingIndex = currentTeam.games.findIndex(g => g.id === gameId);
        if (existingIndex !== -1) {
            // Remove existing game from its current position
            currentTeam.games.splice(existingIndex, 1);
        }
        // Add game to end of array so currentGame() returns it
        currentTeam.games.push(game);
        
        // Save local state
        if (typeof saveAllTeamsData === 'function') {
            saveAllTeamsData();
        }
        
        // Navigate to appropriate screen based on game state
        if (typeof isPointInProgress === 'function' && isPointInProgress()) {
            const latestPossession = typeof getLatestPossession === 'function' ? getLatestPossession() : null;
            if (latestPossession && latestPossession.offensive) {
                if (typeof updateOffensivePossessionScreen === 'function') {
                    updateOffensivePossessionScreen();
                }
                showScreen('offensePlayByPlayScreen');
            } else {
                if (typeof updateDefensivePossessionScreen === 'function') {
                    updateDefensivePossessionScreen();
                }
                showScreen('defensePlayByPlayScreen');
            }
        } else {
            // Phase 6b: Use panel-based game screen if enabled
            if (window.useNewGameScreen && typeof enterGameScreen === 'function') {
                enterGameScreen();
                if (typeof transitionToBetweenPoints === 'function') {
                    transitionToBetweenPoints();
                }
            } else {
                if (typeof updateActivePlayersList === 'function') {
                    updateActivePlayersList();
                }
                showScreen('beforePointScreen');
            }
        }
        
    } catch (error) {
        console.error('Error resuming cloud game:', error);
        alert('Failed to resume game: ' + error.message);
    }
}

// importCloudGame is no longer needed - games are accessed directly from the cloud
// Keeping a stub for backwards compatibility
async function importCloudGame(gameId) {
    console.warn('importCloudGame is deprecated - use resumeCloudGame instead');
    // Find the team for this game and resume it
    try {
        const games = await listServerGames();
        const game = games.find(g => g.game_id === gameId);
        if (game && game.teamId) {
            const response = await authFetch(`${API_BASE_URL}/api/teams/${game.teamId}`);
            if (response.ok) {
                const team = await response.json();
                await resumeCloudGame(team, gameId);
                return;
            }
        }
        alert('Could not find team for this game');
    } catch (error) {
        console.error('Import failed:', error);
        alert('Failed to load game: ' + error.message);
    }
}

function removeGameStatsFromRoster(team, game) {
    const points = game.points || [];

    points.forEach(point => {
        const pointDuration = point.totalPointTime;
        point.players.forEach(playerName => {
            const player = getPlayerFromName(playerName);
            if (player) {
                player.totalPointsPlayed = Math.max(0, (player.totalPointsPlayed || 0) - 1);
                player.totalTimePlayed = Math.max(0, (player.totalTimePlayed || 0) - pointDuration);
                if (game === team.games[team.games.length - 1]) {
                    player.consecutivePointsPlayed = 0;
                }
            }
        });
    });
}

/**
 * Select a team by index (legacy function - kept for backwards compatibility)
 * Use selectCloudTeam() for cloud-first workflow
 */
function selectTeam(index) {
    if (index >= 0 && index < teams.length) {
        currentTeam = teams[index];
        if (typeof updateTeamRosterDisplay === 'function') {
            updateTeamRosterDisplay();
        }
        showScreen('teamRosterScreen');
    }
}

function initializeTeamSelection() {
    const loadTeamBtn = document.getElementById('loadTeamBtn');
    const fileInput = document.getElementById('fileInput');
    if (loadTeamBtn && fileInput) {
        loadTeamBtn.onclick = () => fileInput.click();
        fileInput.addEventListener('change', (event) => {
            const file = event.target.files ? event.target.files[0] : null;
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const jsonData = JSON.parse(e.target.result);
                    const newTeams = deserializeTeams(JSON.stringify([jsonData]));
                    if (newTeams && newTeams[0]) {
                        teams.push(newTeams[0]);
                        currentTeam = newTeams[0];
                        if (typeof updateTeamRosterDisplay === 'function') {
                            updateTeamRosterDisplay();
                        }
                        showSelectTeamScreen();
                    }
                } catch (error) {
                    console.error('Error parsing JSON:', error);
                }
            };
            reader.readAsText(file);
        });
    }

    const switchTeamsBtn = document.getElementById('switchTeamsBtn');
    if (switchTeamsBtn) {
        switchTeamsBtn.addEventListener('click', () => {
            // Save current team data before switching
            if (typeof saveAllTeamsData === 'function') {
                saveAllTeamsData();
            }
            showSelectTeamScreen();
        });
    }

    const downloadTeamBtn = document.getElementById('downloadTeamBtn');
    if (downloadTeamBtn) {
        downloadTeamBtn.addEventListener('click', () => {
            if (currentTeam) {
                const teamData = serializeTeam(currentTeam);
                const filename = `${currentTeam.name}_${new Date().toISOString().split('T')[0]}.json`;
                downloadJSON(teamData, filename);
            } else {
                alert('No team selected.');
            }
        });
    }

    const createNewTeamBtn = document.getElementById('createNewTeamBtn');
    if (createNewTeamBtn) {
        createNewTeamBtn.addEventListener('click', () => {
            const modal = document.getElementById('createTeamModal');
            if (modal) {
                modal.style.display = 'block';
            }
        });
    }

    const closeButton = document.querySelector('.close');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            const modal = document.getElementById('createTeamModal');
            if (modal) {
                modal.style.display = 'none';
            }
        });
    }

    const saveNewTeamBtn = document.getElementById('saveNewTeamBtn');
    if (saveNewTeamBtn) {
        saveNewTeamBtn.addEventListener('click', async () => {
            const input = document.getElementById('newTeamNameInput');
            const newTeamName = input ? input.value.trim() : '';
            
            if (!newTeamName) {
                alert('Please enter a team name.');
                return;
            }
            
            // Check if user is authenticated
            if (!window.breakside?.auth?.isAuthenticated?.()) {
                alert('Please sign in to create a team.');
                return;
            }
            
            // Disable button while creating
            saveNewTeamBtn.disabled = true;
            saveNewTeamBtn.textContent = 'Creating...';
            
            try {
                // Phase 6b: Create team on cloud first
                const newTeam = new Team(newTeamName);
                
                // Create on server
                const response = await authFetch(`${API_BASE_URL}/api/teams`, {
                    method: 'POST',
                    body: JSON.stringify({
                        id: newTeam.id,
                        name: newTeam.name,
                        playerIds: newTeam.playerIds || [],
                        lines: newTeam.lines || []
                    })
                });
                
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.detail || `Server error: ${response.status}`);
                }
                
                const result = await response.json();
                console.log('✅ Team created on server:', result);
                
                // Add to local state
                teams.push(newTeam);
                currentTeam = newTeam;
                
                if (typeof saveAllTeamsData === 'function') {
                    saveAllTeamsData();
                }
                
                if (typeof updateTeamRosterDisplay === 'function') {
                    updateTeamRosterDisplay();
                }
                
                // Close modal and navigate
                const modal = document.getElementById('createTeamModal');
                if (modal) {
                    modal.style.display = 'none';
                }
                if (input) {
                    input.value = '';
                }
                
                showScreen('teamRosterScreen');
                
            } catch (error) {
                console.error('Failed to create team:', error);
                
                // If offline or network error, queue for later sync
                if (!navigator.onLine || error.message.includes('Failed to fetch')) {
                    console.log('📴 Offline - creating team locally and queueing for sync');
                    const newTeam = new Team(newTeamName);
                    teams.push(newTeam);
                    currentTeam = newTeam;
                    
                    if (typeof createTeamOffline === 'function') {
                        createTeamOffline({
                            id: newTeam.id,
                            name: newTeam.name,
                            playerIds: newTeam.playerIds || [],
                            lines: newTeam.lines || []
                        });
                    }
                    
                    if (typeof saveAllTeamsData === 'function') {
                        saveAllTeamsData();
                    }
                    if (typeof updateTeamRosterDisplay === 'function') {
                        updateTeamRosterDisplay();
                    }
                    
                    const modal = document.getElementById('createTeamModal');
                    if (modal) {
                        modal.style.display = 'none';
                    }
                    if (input) {
                        input.value = '';
                    }
                    
                    showScreen('teamRosterScreen');
                    alert('Team created locally. It will sync to the cloud when you\'re back online.');
                } else {
                    alert('Failed to create team: ' + error.message);
                }
            } finally {
                saveNewTeamBtn.disabled = false;
                saveNewTeamBtn.textContent = 'Create Team';
            }
        });
    }

    window.addEventListener('click', (event) => {
        const modal = document.getElementById('createTeamModal');
        if (modal && event.target === modal) {
            modal.style.display = 'none';
        }
    });

    const backToRosterBtn = document.getElementById('backToRosterScreenBtn');
    if (backToRosterBtn) {
        backToRosterBtn.addEventListener('click', () => {
            if (typeof updateTeamRosterDisplay === 'function') {
                updateTeamRosterDisplay();
            }
            showScreen('teamRosterScreen');
        });
    }

    const restoreGamesBtn = document.getElementById('restoreGamesBtn');
    if (restoreGamesBtn) {
        restoreGamesBtn.addEventListener('click', async () => {
            // In cloud-only mode, "restore" means re-sync from cloud
            if (!confirm('Re-sync all data from the cloud? This will refresh your local cache with the latest cloud data.')) {
                return;
            }
            
            restoreGamesBtn.disabled = true;
            restoreGamesBtn.innerHTML = '<i class="fas fa-sync fa-spin"></i> Syncing...';
            
            try {
                if (typeof syncUserTeams === 'function') {
                    await syncUserTeams();
                }
                
                // Set currentTeam to the first team if teams were loaded
                if (teams.length > 0) {
                    currentTeam = teams[0];
                }
                if (currentTeam && typeof updateTeamRosterDisplay === 'function') {
                    updateTeamRosterDisplay();
                }
                showSelectTeamScreen();
                
            } catch (error) {
                console.error('Sync failed:', error);
                alert('Failed to sync from cloud: ' + error.message);
            } finally {
                restoreGamesBtn.disabled = false;
                restoreGamesBtn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Re-sync from Cloud';
            }
        });
        
        // Update button text to reflect cloud-only model
        restoreGamesBtn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Re-sync';
        restoreGamesBtn.title = 'Re-sync all data from the cloud';
    }

    const clearGamesBtn = document.getElementById('clearGamesBtn');
    if (clearGamesBtn) {
        clearGamesBtn.addEventListener('click', () => {
            if (confirm('Clear local cache? This will remove all locally cached data. Your data on the cloud will NOT be affected.\n\nYou will need to re-sync from the cloud after clearing.')) {
                // Clear local teams array
                teams.length = 0;
                currentTeam = null;
                
                // Clear local storage caches
                if (typeof clearSyncData === 'function') {
                    clearSyncData();
                }
                
                // Clear teams from localStorage
                localStorage.removeItem('ultistats_teams');
                
                // Refresh the display
                showSelectTeamScreen();
                
                alert('Local cache cleared. Use "Re-sync" or refresh the page to reload data from the cloud.');
            }
        });
        
        // Update button text to reflect cloud-only model
        clearGamesBtn.innerHTML = '<i class="fas fa-eraser"></i> Clear Cache';
        clearGamesBtn.title = 'Clear local cache (cloud data is not affected)';
    }
}

initializeTeamSelection();

// =============================================================================
// Sync Status Functions (Phase 4)
// =============================================================================

/**
 * Build the HTML for the sync status indicator
 */
function buildSyncStatusHTML() {
    let status = { pendingCount: 0, pendingByType: { player: 0, team: 0, game: 0 }, isOnline: navigator.onLine };
    
    if (typeof getSyncStatus === 'function') {
        status = getSyncStatus();
    }
    
    const isOnline = status.isOnline;
    const totalPending = status.pendingCount || 0;
    const statusIcon = isOnline ? '🌐' : '📴';
    const statusText = isOnline ? 'Online' : 'Offline';
    const pendingText = totalPending > 0 
        ? `<span class="pending-badge">${totalPending} pending</span>` 
        : '';
    
    // Check if user is authenticated
    const isAuthenticated = window.breakside?.auth?.isAuthenticated?.() || false;
    const userEmail = window.breakside?.auth?.getCurrentUser?.()?.email || '';
    const signOutButton = isAuthenticated 
        ? `<button id="signOutBtn" class="sync-btn sign-out-btn" onclick="handleSignOut()" title="${userEmail}">
               <i class="fas fa-sign-out-alt"></i> Sign Out
           </button>`
        : '';
    
    return `
        <div class="sync-status-info" onclick="showConnectionInfo()" style="cursor: pointer;">
            <span class="sync-status-icon">${statusIcon}</span>
            <span class="sync-status-text">${statusText}</span>
            ${pendingText}
        </div>
        <div class="sync-status-actions">
            <button id="refreshAllBtn" class="sync-btn" ${!isOnline ? 'disabled' : ''} onclick="doFullRefresh()">
                <i id="refreshIcon" class="fas fa-sync"></i> Refresh
            </button>
            ${signOutButton}
        </div>
    `;
}

/**
 * Update the sync status display
 */
function updateSyncStatusDisplay() {
    const container = document.getElementById('syncStatusContainer');
    if (container) {
        container.innerHTML = buildSyncStatusHTML();
    }
}

/**
 * Unified refresh: push pending local changes, pull latest from cloud, re-render.
 * @param {boolean} silent - If true, don't show alerts on failure (used for auto-refresh)
 */
let _refreshInProgress = false;
async function doFullRefresh(silent = false) {
    if (_refreshInProgress) return;
    _refreshInProgress = true;
    
    // Subtle feedback: spin the refresh icon once (no text change, no reflow)
    const refreshIcon = document.getElementById('refreshIcon');
    if (refreshIcon) {
        refreshIcon.classList.add('refresh-spin');
    }
    
    try {
        // Step 1: Push any pending local changes
        if (typeof processSyncQueue === 'function') {
            try {
                await processSyncQueue();
            } catch (e) {
                console.warn('Sync queue processing failed:', e);
            }
        }
        
        // Step 2: Pull latest data from cloud
        if (typeof syncUserTeams === 'function') {
            try {
                await syncUserTeams();
            } catch (e) {
                console.warn('Team sync failed:', e);
            }
        }
        
        if (typeof pullFromCloud === 'function') {
            try {
                await pullFromCloud();
            } catch (e) {
                console.warn('Pull from cloud failed:', e);
            }
        }
        
        // Step 3: Re-render the team/game list
        updateSyncStatusDisplay();
        await populateCloudTeamsAndGames();
        
    } catch (error) {
        console.error('Refresh failed:', error);
        if (!silent) {
            alert('Refresh failed: ' + error.message);
        }
    } finally {
        _refreshInProgress = false;
        // Remove spin class (re-query since innerHTML may have been rebuilt)
        const icon = document.getElementById('refreshIcon');
        if (icon) {
            icon.classList.remove('refresh-spin');
        }
    }
}

// Keep old function names for backwards compatibility
async function triggerManualSync() { return doFullRefresh(); }
async function pullDataFromCloud() { return doFullRefresh(); }

/**
 * Handle sign out - clears auth state and shows login screen
 */
async function handleSignOut() {
    if (!window.breakside?.auth?.signOut) {
        alert('Sign out not available');
        return;
    }
    
    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
        signOutBtn.disabled = true;
        signOutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing out...';
    }
    
    try {
        await window.breakside.auth.signOut();
        console.log('Signed out successfully');
        
        // Show the login screen
        if (window.breakside?.loginScreen?.showAuthScreen) {
            window.breakside.loginScreen.showAuthScreen();
        } else {
            // Fallback: reload the page
            window.location.reload();
        }
    } catch (error) {
        console.error('Sign out failed:', error);
        alert('Sign out failed: ' + error.message);
        
        if (signOutBtn) {
            signOutBtn.disabled = false;
            signOutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i> Sign Out';
        }
    }
}

/**
 * Show connection info toast when tapping the Online/Offline status.
 * Uses the existing toast system (showControllerToast) for consistent styling.
 * Includes version info and update check.
 */
async function showConnectionInfo() {
    const userEmail = window.breakside?.auth?.getCurrentUser?.()?.email || 'Not signed in';
    const serverUrl = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'Not configured';
    const isOnline = navigator.onLine;
    
    // Get current version
    const version = window.APP_VERSION || '?';
    const build = window.APP_BUILD || '?';
    
    // Start with basic info, update later if we find an update available
    let versionLine = `Version: ${version} (Build ${build})`;
    let updateButton = '';
    
    // Check for updates if online
    if (isOnline && typeof checkForAppUpdate === 'function') {
        try {
            const updateInfo = await checkForAppUpdate();
            if (updateInfo.hasUpdate) {
                versionLine = `Version: ${version} (Build ${build}) → <b>${updateInfo.latestBuild} available</b>`;
                updateButton = `<br><button onclick="confirmAppUpdate()" style="margin-top:6px;padding:4px 12px;background:#28a745;color:white;border:none;border-radius:4px;cursor:pointer;">Update Now</button>`;
            }
        } catch (e) {
            console.log('Update check failed:', e);
        }
    }
    
    const message = `${isOnline ? 'Online' : 'Offline'}<br>` +
        `<span style="font-size:0.9em;">${versionLine}<br>User: ${userEmail}<br>Server: ${serverUrl}${updateButton}</span>`;
    
    if (typeof showControllerToast === 'function') {
        // Longer duration if update is available
        showControllerToast(message, 'info', updateButton ? 8000 : 4000);
    }
}

/**
 * Show confirmation dialog and force app update
 */
function confirmAppUpdate() {
    if (confirm('Update the app now? The page will reload.')) {
        if (typeof forceAppUpdate === 'function') {
            forceAppUpdate();
        } else {
            // Fallback: just reload with cache clear
            window.location.reload(true);
        }
    }
}

// Make functions available globally for onclick handlers
window.handleSignOut = handleSignOut;
window.doFullRefresh = doFullRefresh;
window.showConnectionInfo = showConnectionInfo;
window.confirmAppUpdate = confirmAppUpdate;

// Auto-refresh every 10 seconds when on the team selection screen
let _autoRefreshInterval = null;

function startAutoRefresh() {
    stopAutoRefresh();
    _autoRefreshInterval = setInterval(() => {
        // Only auto-refresh when the select team screen is visible
        const syncContainer = document.getElementById('syncStatusContainer');
        const selectScreen = document.getElementById('selectTeamScreen');
        if (syncContainer && selectScreen && selectScreen.style.display !== 'none') {
            doFullRefresh(true); // silent refresh
        }
    }, 10000);
}

function stopAutoRefresh() {
    if (_autoRefreshInterval) {
        clearInterval(_autoRefreshInterval);
        _autoRefreshInterval = null;
    }
}

// Start auto-refresh on load
startAutoRefresh();
