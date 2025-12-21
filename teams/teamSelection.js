/*
 * Team selection screen logic
 * Handles team switching, loading, and creation
 * 
 * Phase 4 update: Cloud team fetching, sync status indicator
 */

function showSelectTeamScreen(firsttime = false) {
    console.trace('showSelectTeamScreen called');
    const teamListElement = document.getElementById('teamList');
    const teamListWarning = document.getElementById('teamListWarning');
    if (!teamListElement || !teamListWarning) {
        console.warn('Team selection elements not found in DOM.');
        return;
    }

    teamListElement.innerHTML = '';

    if (teams.length === 0 || (teams.length === 1 && teams[0].name === 'Sample Team')) {
        teamListWarning.style.display = 'block';
    } else {
        teamListWarning.style.display = 'none';
    }

    // Add sync status indicator at the top
    const syncStatusContainer = document.createElement('div');
    syncStatusContainer.id = 'syncStatusContainer';
    syncStatusContainer.className = 'sync-status-bar';
    syncStatusContainer.innerHTML = buildSyncStatusHTML();
    teamListElement.appendChild(syncStatusContainer);

    const table = document.createElement('table');
    table.classList.add('team-selection-table');

    teams.forEach((team, teamIndex) => {
        const teamRow = document.createElement('tr');
        teamRow.classList.add('team-row');

        const teamNameCell = document.createElement('td');
        teamNameCell.textContent = team.name;
        teamNameCell.classList.add('team-name');
        teamNameCell.onclick = () => selectTeam(teamIndex);
        teamRow.appendChild(teamNameCell);

        const deleteTeamCell = document.createElement('td');
        deleteTeamCell.style.width = '40px';
        deleteTeamCell.style.textAlign = 'center';
        const deleteTeamBtn = document.createElement('button');
        deleteTeamBtn.innerHTML = '<i class="fas fa-trash" style="color: #dc3545;"></i>';
        deleteTeamBtn.classList.add('icon-button');
        deleteTeamBtn.title = 'Delete Team';
        deleteTeamBtn.onclick = (e) => {
            e.stopPropagation();
            // Prevent deletion if it's the last team
            if (teams.length === 1) {
                alert('Cannot delete the last team. Please create another team first.');
                return;
            }
            if (confirm(`Are you sure you want to delete "${team.name}"? This will permanently delete the team and all its game data. This cannot be undone.`)) {
                // If deleting the current team, switch to another team
                if (currentTeam === team) {
                    // Switch to the first team if deleting index 0, otherwise switch to index 0
                    // (We know teams.length > 1 because of the check above)
                    const newTeamIndex = teamIndex === 0 ? 1 : 0;
                    currentTeam = teams[newTeamIndex];
                }
                // Remove the team from the array
                teams.splice(teamIndex, 1);
                // Save the updated data
                if (typeof saveAllTeamsData === 'function') {
                    saveAllTeamsData();
                }
                // Refresh the display
                showSelectTeamScreen();
            }
        };
        deleteTeamCell.appendChild(deleteTeamBtn);
        teamRow.appendChild(deleteTeamCell);

        const gamesCell = document.createElement('td');
        const gamesList = document.createElement('ul');
        gamesList.classList.add('games-list');

        team.games.forEach((game, gameIndex) => {
            const gameItem = document.createElement('li');
            const gameText = document.createElement('span');
            gameText.textContent = `vs ${game.opponent} (${game.scores[Role.TEAM]}-${game.scores[Role.OPPONENT]})`;
            if (!game.gameEndTimestamp) {
                gameText.textContent += ' [In Progress]';
            }
            gameItem.appendChild(gameText);

            if (!game.gameEndTimestamp) {
                const resumeBtn = document.createElement('button');
                resumeBtn.textContent = '↪️';
                resumeBtn.classList.add('icon-button');
                resumeBtn.title = 'Resume Game';
                resumeBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm('Resume this game?')) {
                        currentTeam = team;
                        if (isPointInProgress()) {
                            const latestPossession = getLatestPossession();
                            if (latestPossession && latestPossession.offensive) {
                                updateOffensivePossessionScreen();
                                showScreen('offensePlayByPlayScreen');
                            } else {
                                updateDefensivePossessionScreen();
                                showScreen('defensePlayByPlayScreen');
                            }
                        } else {
                            if (typeof updateActivePlayersList === 'function') {
                                updateActivePlayersList();
                            }
                            showScreen('beforePointScreen');
                        }
                    }
                };
                gameItem.appendChild(resumeBtn);
            }

            const deleteBtn = document.createElement('button');
            deleteBtn.innerHTML = '<i class="fas fa-trash" style="color: #dc3545;"></i>';
            deleteBtn.classList.add('icon-button');
            deleteBtn.title = 'Delete Game';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm('Delete this game? This cannot be undone.')) {
                    removeGameStatsFromRoster(team, game);
                    team.games.splice(gameIndex, 1);
                    showSelectTeamScreen();
                    if (typeof saveAllTeamsData === 'function') {
                        saveAllTeamsData();
                    }
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

    // Cloud Games Section
    const cloudGamesContainer = document.createElement('div');
    cloudGamesContainer.id = 'cloudGamesContainer';
    
    // Build Cloud Games header with buttons
    const cloudHeader = document.createElement('h3');
    cloudHeader.style.display = 'flex';
    cloudHeader.style.alignItems = 'center';
    cloudHeader.style.gap = '10px';
    cloudHeader.style.flexWrap = 'wrap';
    
    const cloudTitle = document.createElement('span');
    cloudTitle.textContent = 'Cloud Games';
    cloudHeader.appendChild(cloudTitle);
    
    const refreshBtn = document.createElement('button');
    refreshBtn.id = 'refreshCloudGamesBtn';
    refreshBtn.className = 'icon-button';
    refreshBtn.innerHTML = '<i class="fas fa-sync" style="color: #333;"></i>';
    refreshBtn.title = 'Refresh Cloud Games';
    refreshBtn.onclick = populateCloudGames;
    cloudHeader.appendChild(refreshBtn);
    
    const setServerBtn = document.createElement('button');
    setServerBtn.id = 'setServerBtn';
    setServerBtn.className = 'icon-button';
    setServerBtn.innerHTML = '<i class="fas fa-server" style="color: #333;"></i>';
    setServerBtn.title = 'Set Server Address';
    setServerBtn.style.width = 'auto';
    setServerBtn.style.padding = '5px 10px';
    setServerBtn.onclick = showSetServerDialog;
    cloudHeader.appendChild(setServerBtn);
    
    // Server URL display
    const serverUrlDisplay = document.createElement('span');
    serverUrlDisplay.id = 'serverUrlDisplay';
    serverUrlDisplay.style.fontSize = '0.75em';
    serverUrlDisplay.style.color = '#666';
    serverUrlDisplay.style.marginLeft = 'auto';
    serverUrlDisplay.textContent = `Server: ${typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'Not configured'}`;
    cloudHeader.appendChild(serverUrlDisplay);
    
    cloudGamesContainer.appendChild(cloudHeader);
    
    const cloudGamesList = document.createElement('div');
    cloudGamesList.id = 'cloudGamesList';
    cloudGamesList.textContent = 'Loading...';
    cloudGamesContainer.appendChild(cloudGamesList);
    
    teamListElement.appendChild(cloudGamesContainer);

    // Populate cloud games asynchronously
    populateCloudGames();

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

async function populateCloudGames() {
    const listElement = document.getElementById('cloudGamesList');
    if (!listElement) return;

    if (typeof listServerGames !== 'function') {
        listElement.innerHTML = '<p>Cloud sync not available.</p>';
        return;
    }

    try {
        const games = await listServerGames();
        
        if (games.length === 0) {
            listElement.innerHTML = '<p>No games found on server.</p>';
            return;
        }

        const table = document.createElement('table');
        table.classList.add('team-selection-table');
        table.style.marginTop = '10px';

        // Group by team
        const gamesByTeam = {};
        games.forEach(game => {
            const teamName = game.team || 'Unknown Team';
            if (!gamesByTeam[teamName]) {
                gamesByTeam[teamName] = [];
            }
            gamesByTeam[teamName].push(game);
        });

        Object.keys(gamesByTeam).sort().forEach(teamName => {
            const teamRow = document.createElement('tr');
            teamRow.classList.add('team-row');
            
            const teamNameCell = document.createElement('td');
            teamNameCell.textContent = teamName;
            teamNameCell.classList.add('team-name');
            teamRow.appendChild(teamNameCell);

            // Spacer for delete button column to match above table
            const spacerCell = document.createElement('td');
            teamRow.appendChild(spacerCell);

            const gamesCell = document.createElement('td');
            const gamesList = document.createElement('ul');
            gamesList.classList.add('games-list');

            gamesByTeam[teamName].forEach(game => {
                const gameItem = document.createElement('li');
                // Style fix: Flex layout for alignment
                gameItem.style.display = 'flex';
                gameItem.style.justifyContent = 'space-between';
                gameItem.style.alignItems = 'center';
                gameItem.style.padding = '5px 0';
                
                const dateStr = game.game_start_timestamp ? new Date(game.game_start_timestamp).toLocaleDateString() : 'Unknown Date';
                
                const gameText = document.createElement('span');
                gameText.textContent = `${dateStr}: vs ${game.opponent} (${game.scores.team}-${game.scores.opponent})`;
                gameItem.appendChild(gameText);

                // Buttons Container
                const buttonsDiv = document.createElement('div');
                buttonsDiv.style.display = 'flex';
                buttonsDiv.style.gap = '5px';

                // Load Button
                const loadBtn = document.createElement('button');
                // Style fix: Use dark color for text/icon
                loadBtn.innerHTML = '<i class="fas fa-download" style="color: #333;"></i> Load';
                loadBtn.classList.add('icon-button');
                loadBtn.title = 'Download to Device';
                loadBtn.style.color = '#333'; // Ensure text is visible
                loadBtn.style.width = 'auto'; // Allow width to fit text
                loadBtn.style.padding = '5px 10px';
                loadBtn.onclick = () => importCloudGame(game.game_id);
                
                // Check if we already have this game locally (by ID or roughly by timestamp/opponent)
                const isLocal = teams.some(t => t.games.some(g => g.id === game.game_id));
                if (isLocal) {
                    loadBtn.innerHTML = '<i class="fas fa-check" style="color: green;"></i> Local';
                    loadBtn.disabled = true;
                    loadBtn.style.opacity = '0.7';
                    loadBtn.style.color = '#333';
                }

                // Delete Button
                const deleteBtn = document.createElement('button');
                deleteBtn.innerHTML = '<i class="fas fa-trash" style="color: #dc3545;"></i>';
                deleteBtn.classList.add('icon-button');
                deleteBtn.title = 'Delete from Cloud';
                deleteBtn.onclick = () => deleteCloudGame(game.game_id);

                buttonsDiv.appendChild(loadBtn);
                buttonsDiv.appendChild(deleteBtn);
                gameItem.appendChild(buttonsDiv);
                
                gamesList.appendChild(gameItem);
            });

            gamesCell.appendChild(gamesList);
            teamRow.appendChild(gamesCell);
            table.appendChild(teamRow);
        });

        listElement.innerHTML = '';
        listElement.appendChild(table);
        
        // Re-attach refresh listener
        const refreshBtn = document.getElementById('refreshCloudGamesBtn');
        if (refreshBtn) {
            // Style fix: Ensure refresh icon is visible
            refreshBtn.innerHTML = '<i class="fas fa-sync" style="color: #333;"></i>';
            refreshBtn.onclick = populateCloudGames;
        }

    } catch (error) {
        console.error('Error populating cloud games:', error);
        listElement.innerHTML = '<p>Error loading cloud games. Check connection.</p>';
    }
}

async function deleteCloudGame(gameId) {
    if (!confirm('Are you sure you want to delete this game from the cloud? This cannot be undone.')) return;
    
    try {
        await deleteGameFromCloud(gameId);
        populateCloudGames(); // Refresh list
    } catch (error) {
        alert('Failed to delete game: ' + error.message);
    }
}

async function importCloudGame(gameId) {
    if (!confirm('Download this game from the cloud?')) return;

    try {
        const game = await loadGameFromCloud(gameId);
        if (!game) throw new Error('Failed to load game data');

        console.log('Importing game:', game);

        // Find or create team
        let team = teams.find(t => t.name === game.team);
        if (!team) {
            if (confirm(`Team "${game.team}" does not exist locally. Create it?`)) {
                team = new Team(game.team);
                teams.push(team);
            } else {
                return;
            }
        }

        // Check if game already exists in team (by ID)
        const existingIndex = team.games.findIndex(g => g.id === game.id);
        if (existingIndex !== -1) {
            if (!confirm('This game already exists locally. Overwrite it?')) {
                return;
            }
            // Replace existing
            team.games[existingIndex] = game;
        } else {
            // Add new
            team.games.push(game);
        }
        
        // Ensure players from the game are in the roster
        // Game points contain player names. We need to make sure they exist in team.teamRoster
        const playerNames = new Set();
        if (game.points) {
            game.points.forEach(p => {
                if (p.players) p.players.forEach(name => playerNames.add(name));
            });
        }
        
        playerNames.forEach(name => {
            if (!team.teamRoster.find(p => p.name === name)) {
                // Add new player to roster
                // We don't know gender/number so use defaults
                const newPlayer = new Player(name);
                // Try to guess gender from name using existing helper if possible, or just default
                team.teamRoster.push(newPlayer);
            }
        });

        // Update storage
        saveAllTeamsData();
        
        alert('Game imported successfully!');
        showSelectTeamScreen(); // Refresh UI

    } catch (error) {
        console.error('Import failed:', error);
        alert('Failed to import game: ' + error.message);
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

function selectTeam(index) {
    currentTeam = teams[index];
    if (typeof updateTeamRosterDisplay === 'function') {
        updateTeamRosterDisplay();
    }
    showScreen('teamRosterScreen');
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
        saveNewTeamBtn.addEventListener('click', () => {
            const input = document.getElementById('newTeamNameInput');
            const newTeamName = input ? input.value.trim() : '';
            if (newTeamName) {
                // Phase 4: Create team with ID, queue for cloud sync
                const newTeam = new Team(newTeamName);
                teams.push(newTeam);
                currentTeam = newTeam;
                
                // Queue team for cloud sync if sync functions available
                if (typeof createTeamOffline === 'function') {
                    // Create the team offline (marks as _localOnly, queues for sync)
                    createTeamOffline({
                        id: newTeam.id,
                        name: newTeam.name,
                        playerIds: newTeam.playerIds,
                        lines: newTeam.lines
                    });
                }
                
                if (typeof updateTeamRosterDisplay === 'function') {
                    updateTeamRosterDisplay();
                }
                if (typeof saveAllTeamsData === 'function') {
                    saveAllTeamsData();
                }
                showScreen('teamRosterScreen');
                const modal = document.getElementById('createTeamModal');
                if (modal) {
                    modal.style.display = 'none';
                }
                if (input) {
                    input.value = '';
                }
            } else {
                alert('Please enter a team name.');
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
        restoreGamesBtn.addEventListener('click', () => {
            if (confirm('Restore saved games from storage? This will overwrite any unsaved changes.')) {
                loadTeams(false);
                // Set currentTeam to the first team if teams were loaded
                if (teams.length > 0) {
                    currentTeam = teams[0];
                }
                if (currentTeam && typeof updateTeamRosterDisplay === 'function') {
                    updateTeamRosterDisplay();
                }
                showSelectTeamScreen();
            }
        });
    }

    const clearGamesBtn = document.getElementById('clearGamesBtn');
    if (clearGamesBtn) {
        clearGamesBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all saved games? This will delete all game data for all teams. This cannot be undone.')) {
                // Clear all games from all teams
                teams.forEach(team => {
                    // Reset player stats that came from games
                    team.teamRoster.forEach(player => {
                        player.totalPointsPlayed = 0;
                        player.totalTimePlayed = 0;
                        player.completedPasses = 0;
                        player.turnovers = 0;
                        player.goals = 0;
                        player.assists = 0;
                        player.pointsWon = 0;
                        player.pointsLost = 0;
                        player.consecutivePointsPlayed = 0;
                        player.pointsPlayedPreviousGames = 0;
                    });
                    team.games = [];
                });
                
                // Save the updated data
                if (typeof saveAllTeamsData === 'function') {
                    saveAllTeamsData();
                }
                
                // Update displays
                if (currentTeam && typeof updateTeamRosterDisplay === 'function') {
                    updateTeamRosterDisplay();
                }
                showSelectTeamScreen();
                
                alert('All saved games have been cleared.');
            }
        });
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
