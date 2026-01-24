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
    
    // Build header with refresh and server buttons
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '10px';
    header.style.flexWrap = 'wrap';
    header.style.marginBottom = '10px';
    
    const title = document.createElement('h3');
    title.textContent = 'Teams & Games';
    title.style.margin = '0';
    header.appendChild(title);
    
    const refreshBtn = document.createElement('button');
    refreshBtn.id = 'refreshCloudGamesBtn';
    refreshBtn.className = 'icon-button';
    refreshBtn.innerHTML = '<i class="fas fa-sync" style="color: #333;"></i>';
    refreshBtn.title = 'Refresh';
    refreshBtn.onclick = () => populateCloudTeamsAndGames();
    header.appendChild(refreshBtn);
    
    const setServerBtn = document.createElement('button');
    setServerBtn.id = 'setServerBtn';
    setServerBtn.className = 'icon-button';
    setServerBtn.innerHTML = '<i class="fas fa-server" style="color: #333;"></i>';
    setServerBtn.title = 'Set Server Address';
    setServerBtn.style.width = 'auto';
    setServerBtn.style.padding = '5px 10px';
    setServerBtn.onclick = showSetServerDialog;
    header.appendChild(setServerBtn);
    
    // Server URL display
    const serverUrlDisplay = document.createElement('span');
    serverUrlDisplay.id = 'serverUrlDisplay';
    serverUrlDisplay.style.fontSize = '0.75em';
    serverUrlDisplay.style.color = '#666';
    serverUrlDisplay.style.marginLeft = 'auto';
    serverUrlDisplay.textContent = `Server: ${typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'Not configured'}`;
    header.appendChild(serverUrlDisplay);
    
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
 * Populate the cloud-only teams and games list
 * This is the primary UI for selecting teams and games (Phase 6b)
 */
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
        
        // Also fetch games
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

        const table = document.createElement('table');
        table.classList.add('team-selection-table');

        // Group games by teamId
        const gamesByTeamId = {};
        allGames.forEach(game => {
            const teamId = game.teamId || null;
            if (!gamesByTeamId[teamId]) {
                gamesByTeamId[teamId] = [];
            }
            gamesByTeamId[teamId].push(game);
        });

        userTeams.forEach(({ team, role }) => {
            const teamRow = document.createElement('tr');
            teamRow.classList.add('team-row');
            
            // Team name cell (clickable to go to roster)
            const teamNameCell = document.createElement('td');
            teamNameCell.classList.add('team-name');
            teamNameCell.style.cursor = 'pointer';
            
            // Show team symbol/icon if available
            const teamDisplay = document.createElement('span');
            if (team.teamSymbol) {
                teamDisplay.textContent = `${team.teamSymbol} ${team.name}`;
            } else {
                teamDisplay.textContent = team.name;
            }
            teamNameCell.appendChild(teamDisplay);
            
            // Show role badge
            const roleBadge = document.createElement('span');
            roleBadge.className = 'role-badge';
            roleBadge.textContent = role === 'coach' ? '🏈' : '👁️';
            roleBadge.title = role === 'coach' ? 'Coach' : 'Viewer';
            roleBadge.style.marginLeft = '8px';
            roleBadge.style.fontSize = '0.8em';
            teamNameCell.appendChild(roleBadge);
            
            teamNameCell.onclick = () => selectCloudTeam(team);
            teamRow.appendChild(teamNameCell);

            // Delete team button (coaches only)
            const deleteTeamCell = document.createElement('td');
            deleteTeamCell.style.width = '40px';
            deleteTeamCell.style.textAlign = 'center';
            if (role === 'coach') {
                const deleteTeamBtn = document.createElement('button');
                deleteTeamBtn.innerHTML = '<i class="fas fa-trash" style="color: #dc3545;"></i>';
                deleteTeamBtn.classList.add('icon-button');
                deleteTeamBtn.title = 'Delete Team';
                deleteTeamBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteCloudTeam(team);
                };
                deleteTeamCell.appendChild(deleteTeamBtn);
            }
            teamRow.appendChild(deleteTeamCell);

            // Games cell
            const gamesCell = document.createElement('td');
            const gamesList = document.createElement('ul');
            gamesList.classList.add('games-list');

            const teamGames = gamesByTeamId[team.id] || [];
            
            if (teamGames.length === 0) {
                const noGamesItem = document.createElement('li');
                noGamesItem.style.color = '#888';
                noGamesItem.style.fontStyle = 'italic';
                noGamesItem.textContent = 'No games yet';
                gamesList.appendChild(noGamesItem);
            } else {
                // Sort games by date (newest first)
                teamGames.sort((a, b) => {
                    const dateA = new Date(a.game_start_timestamp || 0);
                    const dateB = new Date(b.game_start_timestamp || 0);
                    return dateB - dateA;
                });
                
                teamGames.forEach(game => {
                    const gameItem = document.createElement('li');
                    gameItem.style.display = 'flex';
                    gameItem.style.justifyContent = 'space-between';
                    gameItem.style.alignItems = 'center';
                    gameItem.style.padding = '5px 0';
                    
                    const dateStr = game.game_start_timestamp 
                        ? new Date(game.game_start_timestamp).toLocaleDateString() 
                        : 'Unknown Date';
                    
                    const gameText = document.createElement('span');
                    const scoreText = `${game.scores?.team || 0}-${game.scores?.opponent || 0}`;
                    gameText.textContent = `${dateStr}: vs ${game.opponent} (${scoreText})`;
                    
                    // Show [In Progress] for games without end timestamp
                    if (!game.game_end_timestamp) {
                        const inProgressBadge = document.createElement('span');
                        inProgressBadge.textContent = ' [In Progress]';
                        inProgressBadge.style.color = '#007bff';
                        inProgressBadge.style.fontWeight = 'bold';
                        gameText.appendChild(inProgressBadge);
                    }
                    
                    gameItem.appendChild(gameText);

                    // Buttons Container
                    const buttonsDiv = document.createElement('div');
                    buttonsDiv.style.display = 'flex';
                    buttonsDiv.style.gap = '5px';

                    // Resume/Open button for in-progress games
                    if (!game.game_end_timestamp && role === 'coach') {
                        const resumeBtn = document.createElement('button');
                        resumeBtn.innerHTML = '↪️ Resume';
                        resumeBtn.classList.add('icon-button');
                        resumeBtn.title = 'Resume Game';
                        resumeBtn.style.width = 'auto';
                        resumeBtn.style.padding = '5px 10px';
                        resumeBtn.onclick = (e) => {
                            e.stopPropagation();
                            resumeCloudGame(team, game.game_id);
                        };
                        buttonsDiv.appendChild(resumeBtn);
                    }

                    // Delete Button (coaches only)
                    if (role === 'coach') {
                        const deleteBtn = document.createElement('button');
                        deleteBtn.innerHTML = '<i class="fas fa-trash" style="color: #dc3545;"></i>';
                        deleteBtn.classList.add('icon-button');
                        deleteBtn.title = 'Delete Game';
                        deleteBtn.onclick = (e) => {
                            e.stopPropagation();
                            deleteCloudGameWithConfirm(game.game_id);
                        };
                        buttonsDiv.appendChild(deleteBtn);
                    }

                    gameItem.appendChild(buttonsDiv);
                    gamesList.appendChild(gameItem);
                });
            }

            gamesCell.appendChild(gamesList);
            teamRow.appendChild(gamesCell);
            table.appendChild(teamRow);
        });

        listElement.innerHTML = '';
        listElement.appendChild(table);
        
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
        : '<span class="synced-badge">✓ Synced</span>';
    
    // Check if user is authenticated
    const isAuthenticated = window.breakside?.auth?.isAuthenticated?.() || false;
    const userEmail = window.breakside?.auth?.getCurrentUser?.()?.email || '';
    const signOutButton = isAuthenticated 
        ? `<button id="signOutBtn" class="sync-btn sign-out-btn" onclick="handleSignOut()" title="${userEmail}">
               <i class="fas fa-sign-out-alt"></i> Sign Out
           </button>`
        : '';
    
    return `
        <div class="sync-status-info">
            <span class="sync-status-icon">${statusIcon}</span>
            <span class="sync-status-text">${statusText}</span>
            ${pendingText}
        </div>
        <div class="sync-status-actions">
            <button id="syncNowBtn" class="sync-btn" ${!isOnline ? 'disabled' : ''} onclick="triggerManualSync()">
                <i class="fas fa-sync"></i> Sync
            </button>
            <button id="pullFromCloudBtn" class="sync-btn" ${!isOnline ? 'disabled' : ''} onclick="pullDataFromCloud()">
                <i class="fas fa-cloud-download-alt"></i> Pull
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
 * Trigger a manual sync of all pending data
 */
async function triggerManualSync() {
    if (typeof processSyncQueue !== 'function') {
        alert('Sync not available');
        return;
    }
    
    const syncBtn = document.getElementById('syncNowBtn');
    if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.innerHTML = '<i class="fas fa-sync fa-spin"></i> Syncing...';
    }
    
    try {
        await processSyncQueue();
        updateSyncStatusDisplay();
        // Refresh the cloud games list
        populateCloudGames();
    } catch (error) {
        console.error('Sync failed:', error);
        alert('Sync failed: ' + error.message);
    } finally {
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.innerHTML = '<i class="fas fa-sync"></i> Sync';
        }
    }
}

/**
 * Pull latest data from the cloud
 */
async function pullDataFromCloud() {
    if (typeof pullFromCloud !== 'function') {
        alert('Cloud sync not available');
        return;
    }
    
    const pullBtn = document.getElementById('pullFromCloudBtn');
    if (pullBtn) {
        pullBtn.disabled = true;
        pullBtn.innerHTML = '<i class="fas fa-cloud-download-alt fa-spin"></i> Pulling...';
    }
    
    try {
        // First sync user's teams (this pulls any teams the user has access to)
        if (typeof syncUserTeams === 'function') {
            const teamResult = await syncUserTeams();
            if (teamResult.synced > 0) {
                console.log(`Synced ${teamResult.synced} teams from server`);
            }
        }
        
        // Then pull other data
        const result = await pullFromCloud();
        if (result.success) {
            console.log('Pulled data from cloud:', result);
            // Refresh displays - reload the whole screen to show new teams
            showSelectTeamScreen();
        } else {
            // Refresh displays even on partial success
            updateSyncStatusDisplay();
            populateCloudGames();
            if (result.error && result.error !== 'Not authenticated') {
                alert('Pull failed: ' + (result.error || 'Unknown error'));
            }
        }
    } catch (error) {
        console.error('Pull failed:', error);
        alert('Pull failed: ' + error.message);
    } finally {
        if (pullBtn) {
            pullBtn.disabled = false;
            pullBtn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Pull';
        }
    }
}

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

// Make handleSignOut available globally for onclick
window.handleSignOut = handleSignOut;

// Update sync status periodically
setInterval(() => {
    if (document.getElementById('syncStatusContainer')) {
        updateSyncStatusDisplay();
    }
}, 5000);
