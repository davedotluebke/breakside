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

    // Join Team section — invite code input at top of teams screen
    const joinSection = document.createElement('div');
    joinSection.className = 'teams-join-section';
    joinSection.innerHTML = `
        <div class="teams-join-form">
            <input type="text" id="teamsJoinCodeInput" placeholder="Invite code" maxlength="5" class="join-code-input">
            <button id="teamsJoinBtn" class="join-btn">Join Team</button>
        </div>
    `;
    teamsContainer.appendChild(joinSection);

    // Wire up join team from teams screen
    setTimeout(() => {
        const joinInput = document.getElementById('teamsJoinCodeInput');
        const joinBtn = document.getElementById('teamsJoinBtn');
        if (joinInput) {
            joinInput.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
            joinInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && typeof handleJoinCodeFromTeamsScreen === 'function') {
                    handleJoinCodeFromTeamsScreen();
                }
            });
        }
        if (joinBtn) {
            joinBtn.addEventListener('click', () => {
                if (typeof handleJoinCodeFromTeamsScreen === 'function') {
                    handleJoinCodeFromTeamsScreen();
                }
            });
        }
    }, 0);
    
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

// Active-game polling state
let _activeGamePollInterval = null;
const _dismissedActiveGames = new Set();  // game IDs user dismissed this session
let _previousActiveGameIds = new Set();   // game IDs that were active last poll
let _cloudTeamsCache = [];                // cached team objects from last populateCloudTeamsAndGames()

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
        _cloudTeamsCache = userTeams;

        // Also fetch games and events
        let allGames = [];
        if (typeof listServerGames === 'function') {
            allGames = await listServerGames();
        }

        // Fetch events for all teams
        const eventsByTeamId = {};
        await Promise.all(userTeams.map(async ({ team }) => {
            try {
                if (typeof listTeamEvents === 'function') {
                    eventsByTeamId[team.id] = await listTeamEvents(team.id);
                }
            } catch (e) {
                console.warn(`Failed to fetch events for team ${team.id}:`, e);
                eventsByTeamId[team.id] = [];
            }
        }));
        
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
            
            // Right side buttons (coaches only)
            if (role === 'coach') {
                const topRight = document.createElement('div');
                topRight.style.display = 'flex';
                topRight.style.gap = '4px';

                const settingsBtn = document.createElement('button');
                settingsBtn.innerHTML = '<i class="fas fa-cog"></i>';
                settingsBtn.classList.add('icon-button');
                settingsBtn.title = 'Team Settings';
                settingsBtn.onclick = (e) => {
                    e.stopPropagation();
                    selectCloudTeam(team).then(() => {
                        if (typeof showTeamSettingsScreen === 'function') {
                            showTeamSettingsScreen('selectTeamScreen');
                        }
                    });
                };
                topRight.appendChild(settingsBtn);

                const deleteTeamBtn = document.createElement('button');
                deleteTeamBtn.innerHTML = '<i class="fas fa-trash" style="color: #dc3545;"></i>';
                deleteTeamBtn.classList.add('icon-button');
                deleteTeamBtn.title = 'Delete Team';
                deleteTeamBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteCloudTeam(team);
                };
                topRight.appendChild(deleteTeamBtn);

                topRow.appendChild(topRight);
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
            } else if (role === 'viewer') {
                const roleBadge = document.createElement('span');
                roleBadge.className = 'role-badge viewer-badge';
                roleBadge.innerHTML = '<i class="fas fa-eye"></i> <span class="role-badge-text">Viewer</span>';
                roleBadge.title = 'Viewer';
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
                if (typeof window.setCurrentTeamRole === 'function') {
                    window.setCurrentTeamRole(role);
                }
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

            // Get events for this team
            const teamEvents = eventsByTeamId[team.id] || [];
            const eventMap = {};
            teamEvents.forEach(ev => { eventMap[ev.id] = ev; });

            // Group games by eventId
            const eventGameIds = new Set();
            const gamesByEventId = {};
            teamGames.forEach(game => {
                const eid = game.eventId || null;
                if (eid && eventMap[eid]) {
                    if (!gamesByEventId[eid]) gamesByEventId[eid] = [];
                    gamesByEventId[eid].push(game);
                    eventGameIds.add(game.game_id);
                }
            });
            const standaloneGames = teamGames.filter(g => !eventGameIds.has(g.game_id));

            // Build interleaved list: events and standalone games sorted by most recent activity
            const renderItems = [];

            // Add events with their latest game timestamp
            teamEvents.forEach(ev => {
                const evGames = gamesByEventId[ev.id] || [];
                const latestTs = getMostRecentGameTimestamp(evGames);
                renderItems.push({ type: 'event', event: ev, games: evGames, sortTs: latestTs || new Date(ev.createdAt || 0).getTime() });
            });

            // Add standalone games
            standaloneGames.forEach(game => {
                const ts = game.game_start_timestamp ? new Date(game.game_start_timestamp).getTime() : 0;
                renderItems.push({ type: 'game', game: game, sortTs: ts });
            });

            // Sort newest first
            renderItems.sort((a, b) => b.sortTs - a.sortTs);

            if (renderItems.length === 0 && teamEvents.length === 0) {
                const noGamesMsg = document.createElement('div');
                noGamesMsg.className = 'no-games-message';
                noGamesMsg.textContent = 'No games yet';
                gamesContainer.appendChild(noGamesMsg);
            } else {
                renderItems.forEach(item => {
                    if (item.type === 'event') {
                        gamesContainer.appendChild(renderEventContainer(item.event, item.games, team, role));
                    } else {
                        const gamesList = document.createElement('ul');
                        gamesList.className = 'games-list';
                        gamesList.appendChild(renderGameItem(item.game, team, role));
                        gamesContainer.appendChild(gamesList);
                    }
                });
            }

            // Buttons row for coaches
            if (role === 'coach') {
                const btnRow = document.createElement('div');
                btnRow.className = 'team-action-buttons';

                const newGameBtn = document.createElement('button');
                newGameBtn.className = 'new-game-btn';
                newGameBtn.innerHTML = '<i class="fas fa-plus"></i> New Game';
                newGameBtn.onclick = (e) => {
                    e.stopPropagation();
                    selectCloudTeam(team);
                };
                btnRow.appendChild(newGameBtn);

                const newEventBtn = document.createElement('button');
                newEventBtn.className = 'new-game-btn new-event-btn';
                newEventBtn.innerHTML = '<i class="fas fa-trophy"></i> New Event';
                newEventBtn.onclick = (e) => {
                    e.stopPropagation();
                    showCreateEventDialog(team);
                };
                btnRow.appendChild(newEventBtn);

                gamesContainer.appendChild(btnRow);
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
async function resumeCloudGame(cloudTeam, gameId, role) {
    console.log('📥 Resuming cloud game:', gameId, role ? `(${role})` : '');

    try {
        // Set the team role before entering the game screen
        if (typeof window.setCurrentTeamRole === 'function') {
            window.setCurrentTeamRole(role || 'coach');
        }

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
        
        // Navigate to panel-based game screen
        if (typeof enterGameScreen === 'function') {
            enterGameScreen();
            const pointInProgress = typeof isPointInProgress === 'function' && isPointInProgress();
            if (!pointInProgress && typeof transitionToBetweenPoints === 'function') {
                transitionToBetweenPoints();
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
    const pendingBadge = totalPending > 0
        ? `<span class="pending-badge" onclick="showPendingSyncDialog()" style="cursor: pointer;">${totalPending} pending</span>`
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
        </div>
        ${pendingBadge}
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
    const label = window.APP_DEPLOY_LABEL;
    let versionLine = `Version: ${version} (Build ${build})${label ? ' [' + label + ']' : ''}`;
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

/**
 * Show the pending sync dialog with a summary of queued items.
 */
function showPendingSyncDialog() {
    const items = typeof getSyncQueueItems === 'function' ? getSyncQueueItems() : [];
    const listEl = document.getElementById('pendingSyncList');
    if (!listEl) return;

    if (items.length === 0) {
        listEl.innerHTML = '<p style="color:#888; font-style:italic;">No pending updates.</p>';
    } else {
        const maxShown = 3;
        const lines = items.slice(0, maxShown).map(item => {
            const label = describeSyncItem(item);
            const age = formatSyncAge(item.timestamp);
            const retryNote = item.retryCount > 0
                ? ` <span style="color:#c00; font-size:0.8rem;">(${item.retryCount} failed attempt${item.retryCount > 1 ? 's' : ''})</span>`
                : '';
            return `<div style="padding: 0.4rem 0; border-bottom: 1px solid #eee;">
                <span style="font-weight:600;">${item.action}</span> ${label}${retryNote}
                <div style="font-size:0.8rem; color:#888;">${age}</div>
            </div>`;
        });
        if (items.length > maxShown) {
            lines.push(`<div style="padding: 0.4rem 0; color: #888; font-style: italic;">...and ${items.length - maxShown} more</div>`);
        }
        listEl.innerHTML = lines.join('');
    }

    document.getElementById('pendingSyncDialog').style.display = 'block';
}

/**
 * Describe a sync queue item for display (team name, game opponent, player name).
 */
function describeSyncItem(item) {
    const data = item.data || {};
    if (item.type === 'game') {
        const team = data.team || '?';
        const opponent = data.opponent || '?';
        return `game: ${team} vs ${opponent}`;
    }
    if (item.type === 'team') {
        return `team: ${data.name || item.id}`;
    }
    if (item.type === 'player') {
        return `player: ${data.name || item.id}`;
    }
    return `${item.type}: ${item.id}`;
}

/**
 * Format how long ago a sync item was queued.
 */
function formatSyncAge(timestamp) {
    if (!timestamp) return '';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function closePendingSyncDialog() {
    document.getElementById('pendingSyncDialog').style.display = 'none';
}

function confirmClearSyncQueue() {
    if (!confirm('Discard all pending updates? These changes will be lost.')) return;
    if (typeof clearSyncQueue === 'function') {
        clearSyncQueue();
    }
    closePendingSyncDialog();
    updateSyncStatusDisplay();
}

// Close pending sync dialog on backdrop click
window.addEventListener('click', function(event) {
    const dialog = document.getElementById('pendingSyncDialog');
    if (event.target === dialog) {
        closePendingSyncDialog();
    }
});

/**
 * Handle invite code entry from the teams screen.
 * Reuses the join logic from teamSettings.js but reads from the teams-screen input.
 */
async function handleJoinCodeFromTeamsScreen() {
    const input = document.getElementById('teamsJoinCodeInput');
    if (!input) return;

    const code = input.value.trim().toUpperCase();
    if (code.length !== 5) {
        alert('Please enter a 5-character invite code');
        return;
    }

    if (!window.breakside?.auth?.isAuthenticated?.()) {
        alert('Please sign in to join a team');
        return;
    }

    try {
        const response = await authFetch(`${API_BASE_URL}/api/invites/${code}/info`);

        if (response.status === 404) {
            alert('Invite not found. Please check the code and try again.');
            return;
        }
        if (response.status === 410) {
            const data = await response.json();
            alert(data.detail || 'This invite has expired or been revoked.');
            return;
        }
        if (!response.ok) {
            throw new Error('Failed to load invite info');
        }

        const info = await response.json();

        if (!confirm(`Join "${info.teamName}" as ${info.role}?\nInvited by ${info.invitedBy || 'a coach'}`)) {
            return;
        }

        const headers = {};
        const redeemResponse = await authFetch(`${API_BASE_URL}/api/invites/${code}/redeem`, {
            method: 'POST',
            headers
        });

        if (redeemResponse.status === 409) {
            alert("You're already on this team!");
            return;
        }
        if (!redeemResponse.ok) {
            const data = await redeemResponse.json();
            throw new Error(data.detail || 'Failed to join team');
        }

        const result = await redeemResponse.json();
        input.value = '';
        alert(`Joined ${result.team?.name || 'the team'} as ${result.membership?.role || 'member'}!`);

        if (typeof syncUserTeams === 'function') {
            await syncUserTeams();
        }
        showSelectTeamScreen();

    } catch (error) {
        console.error('Error joining team:', error);
        alert('Failed to join team: ' + error.message);
    }
}

// Make functions available globally for onclick handlers
window.handleSignOut = handleSignOut;
window.doFullRefresh = doFullRefresh;
window.showConnectionInfo = showConnectionInfo;
window.confirmAppUpdate = confirmAppUpdate;
window.handleJoinCodeFromTeamsScreen = handleJoinCodeFromTeamsScreen;

// =============================================================================
// Active-Game Polling (auto-join prompt)
// =============================================================================

/**
 * Start polling for active games across the user's teams.
 * Shows a toast when another coach starts or resumes a game.
 */
function startActiveGamePolling() {
    if (_activeGamePollInterval) return; // already polling
    if (!window.breakside?.auth?.isAuthenticated?.()) return;
    if (!navigator.onLine) return;

    checkForActiveGames(); // immediate first check
    _activeGamePollInterval = setInterval(checkForActiveGames, 30000);
    console.log('📡 Active-game polling started');
}

/**
 * Stop active-game polling.
 */
function stopActiveGamePolling() {
    if (_activeGamePollInterval) {
        clearInterval(_activeGamePollInterval);
        _activeGamePollInterval = null;
        console.log('📡 Active-game polling stopped');
    }
}

/**
 * Check for newly active games and show toast notifications.
 */
async function checkForActiveGames() {
    if (!navigator.onLine) return;
    if (typeof listServerGames !== 'function') return;

    try {
        const allGames = await listServerGames();
        // Active games that haven't ended
        const activeGames = allGames.filter(g => isGameActive(g) && !g.game_end_timestamp);
        const currentActiveIds = new Set(activeGames.map(g => g.game_id));

        for (const game of activeGames) {
            if (_previousActiveGameIds.has(game.game_id)) continue; // not new
            if (_dismissedActiveGames.has(game.game_id)) continue;  // user dismissed

            // Find the team from our cache
            const teamEntry = _cloudTeamsCache.find(t => t.team.id === game.teamId);
            if (!teamEntry) continue; // not our team or cache not populated yet

            const coachNames = (game.activeCoaches || []).join(', ') || 'A coach';
            const opponent = game.opponent || 'Unknown';
            const message = `${coachNames} coaching vs ${opponent}. Tap to join`;

            const gameId = game.game_id;
            const cloudTeam = teamEntry.team;
            const teamRole = teamEntry.role || 'coach';

            const toastMessage = teamRole === 'viewer'
                ? `${coachNames} coaching vs ${opponent}. Tap to watch`
                : message;

            if (typeof showControllerToast === 'function') {
                showControllerToast(toastMessage, 'info', 8000, {
                    onTap: () => {
                        _dismissedActiveGames.delete(gameId);
                        resumeCloudGame(cloudTeam, gameId, teamRole);
                    },
                    onDismiss: () => {
                        _dismissedActiveGames.add(gameId);
                    }
                });
            }
        }

        _previousActiveGameIds = currentActiveIds;
    } catch (error) {
        console.warn('Active-game poll failed:', error);
    }
}

// Export polling functions
window.startActiveGamePolling = startActiveGamePolling;
window.stopActiveGamePolling = stopActiveGamePolling;

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

// =============================================================================
// Event UI Helpers
// =============================================================================

/**
 * Render a single game list item
 */
function renderGameItem(game, team, role) {
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
            resumeCloudGame(team, game.game_id, role);
        };
        line2.appendChild(joinBtn);
    }
    if (role === 'viewer') {
        const watchBtn = document.createElement('button');
        watchBtn.textContent = game.game_end_timestamp ? 'Review' : 'Watch';
        watchBtn.className = 'game-join-btn game-watch-btn';
        watchBtn.title = game.game_end_timestamp ? 'Review Game' : 'Watch Live';
        watchBtn.onclick = (e) => {
            e.stopPropagation();
            resumeCloudGame(team, game.game_id, role);
        };
        line2.appendChild(watchBtn);
    }

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

    return gameItem;
}

/**
 * Render an event container with its games
 */
function renderEventContainer(event, games, team, role) {
    const container = document.createElement('div');
    container.className = 'event-container';
    if (event.status === 'closed') {
        container.classList.add('event-closed');
    }

    // Event header
    const header = document.createElement('div');
    header.className = 'event-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'event-name';
    nameSpan.textContent = event.name;
    if (event.status === 'closed') {
        nameSpan.textContent += ' (closed)';
    }
    header.appendChild(nameSpan);

    if (role === 'coach') {
        const headerBtns = document.createElement('span');
        headerBtns.className = 'event-header-btns';

        const rosterBtn = document.createElement('button');
        rosterBtn.innerHTML = '<i class="fas fa-users"></i>';
        rosterBtn.classList.add('icon-button');
        rosterBtn.title = 'Event Roster';
        rosterBtn.onclick = (e) => {
            e.stopPropagation();
            showEventRosterScreen(event, team);
        };
        headerBtns.appendChild(rosterBtn);

        const settingsBtn = document.createElement('button');
        settingsBtn.innerHTML = '<i class="fas fa-cog"></i>';
        settingsBtn.classList.add('icon-button');
        settingsBtn.title = 'Event Settings';
        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            showEventSettingsDialog(event, team);
        };
        headerBtns.appendChild(settingsBtn);

        header.appendChild(headerBtns);
    }

    container.appendChild(header);

    // Event games
    if (games.length > 0) {
        const gamesList = document.createElement('ul');
        gamesList.className = 'games-list event-games-list';
        games.forEach(game => {
            gamesList.appendChild(renderGameItem(game, team, role));
        });
        container.appendChild(gamesList);
    }

    // "New Event Game" button for coaches (only open events)
    if (role === 'coach' && event.status !== 'closed') {
        const newGameBtn = document.createElement('button');
        newGameBtn.className = 'new-game-btn event-new-game-btn';
        newGameBtn.innerHTML = '<i class="fas fa-plus"></i> New Event Game';
        newGameBtn.onclick = (e) => {
            e.stopPropagation();
            startNewEventGame(event, team);
        };
        container.appendChild(newGameBtn);
    }

    // W-L record
    const wins = games.filter(g => (g.scores?.team || 0) > (g.scores?.opponent || 0)).length;
    const losses = games.filter(g => (g.scores?.opponent || 0) > (g.scores?.team || 0)).length;
    if (games.length > 0) {
        const record = document.createElement('div');
        record.className = 'event-record';
        record.textContent = `${wins}W-${losses}L`;
        header.insertBefore(record, header.querySelector('.event-header-btns'));
    }

    return container;
}

/**
 * Show create event dialog
 */
function showCreateEventDialog(team) {
    // Remove existing dialog if any
    const existing = document.getElementById('createEventModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'createEventModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>New Event</h2>
                <span class="close">&times;</span>
            </div>
            <div style="padding: 0.5rem 0;">
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label>Event Name</label>
                    <input type="text" id="newEventName" placeholder="e.g. Spring League" style="width: 100%; padding: 8px; box-sizing: border-box;">
                </div>
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label>Gender Ratio</label>
                    <select id="newEventGenderRatio" style="width: 100%; padding: 8px;">
                        <option value="No">No</option>
                        <option value="Alternating">Alternating</option>
                    </select>
                </div>
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label><input type="checkbox" id="newEventAltPulls"> Alternate Gender Pulls</label>
                </div>
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label>Players Per Side</label>
                    <input type="number" id="newEventPlayersPerSide" value="7" min="2" max="7" style="width: 80px; padding: 8px;">
                </div>
                <button id="createEventBtn" class="primary-btn" style="width: 100%;">Create Event</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close handler
    modal.querySelector('.close').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    // Create handler
    document.getElementById('createEventBtn').onclick = async () => {
        const name = document.getElementById('newEventName').value.trim();
        if (!name) { alert('Event name is required'); return; }

        const eventData = {
            name: name,
            teamId: team.id,
            status: 'open',
            defaults: {
                alternateGenderRatio: document.getElementById('newEventGenderRatio').value,
                alternateGenderPulls: document.getElementById('newEventAltPulls').checked,
                playersPerSide: parseInt(document.getElementById('newEventPlayersPerSide').value) || 7
            },
            roster: {
                playerIds: team.playerIds || [],
                pickupPlayers: []
            }
        };

        try {
            await createEventOnCloud(eventData);
            modal.remove();
            populateCloudTeamsAndGames();
        } catch (error) {
            alert('Failed to create event: ' + error.message);
        }
    };

    // Focus name input
    document.getElementById('newEventName').focus();
}

/**
 * Show event settings dialog
 */
function showEventSettingsDialog(event, team) {
    const existing = document.getElementById('eventSettingsModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'eventSettingsModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>Event Settings</h2>
                <span class="close">&times;</span>
            </div>
            <div style="padding: 0.5rem 0;">
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label>Event Name</label>
                    <input type="text" id="editEventName" value="${event.name}" style="width: 100%; padding: 8px; box-sizing: border-box;">
                </div>
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label>Gender Ratio</label>
                    <select id="editEventGenderRatio" style="width: 100%; padding: 8px;">
                        <option value="No" ${(event.defaults?.alternateGenderRatio || 'No') === 'No' ? 'selected' : ''}>No</option>
                        <option value="Alternating" ${event.defaults?.alternateGenderRatio === 'Alternating' ? 'selected' : ''}>Alternating</option>
                    </select>
                </div>
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label><input type="checkbox" id="editEventAltPulls" ${event.defaults?.alternateGenderPulls ? 'checked' : ''}> Alternate Gender Pulls</label>
                </div>
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label>Players Per Side</label>
                    <input type="number" id="editEventPlayersPerSide" value="${event.defaults?.playersPerSide || 7}" min="2" max="7" style="width: 80px; padding: 8px;">
                </div>
                <div class="form-group" style="margin-bottom: 0.75rem;">
                    <label>Status</label>
                    <select id="editEventStatus" style="width: 100%; padding: 8px;">
                        <option value="open" ${event.status === 'open' ? 'selected' : ''}>Open</option>
                        <option value="closed" ${event.status === 'closed' ? 'selected' : ''}>Closed</option>
                    </select>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button id="saveEventSettingsBtn" class="primary-btn" style="flex: 1;">Save</button>
                    <button id="deleteEventBtn" class="secondary-btn" style="flex: 0; color: #dc3545;">Delete</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.close').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    document.getElementById('saveEventSettingsBtn').onclick = async () => {
        const updatedData = {
            ...event,
            name: document.getElementById('editEventName').value.trim() || event.name,
            status: document.getElementById('editEventStatus').value,
            defaults: {
                alternateGenderRatio: document.getElementById('editEventGenderRatio').value,
                alternateGenderPulls: document.getElementById('editEventAltPulls').checked,
                playersPerSide: parseInt(document.getElementById('editEventPlayersPerSide').value) || 7
            }
        };

        try {
            await updateEventOnCloud(event.id, updatedData);
            modal.remove();
            populateCloudTeamsAndGames();
        } catch (error) {
            alert('Failed to update event: ' + error.message);
        }
    };

    document.getElementById('deleteEventBtn').onclick = async () => {
        if (!confirm(`Delete event "${event.name}"? This will not delete the games, but they will become standalone.`)) return;
        try {
            await deleteEventFromCloud(event.id);
            modal.remove();
            populateCloudTeamsAndGames();
        } catch (error) {
            alert('Failed to delete event: ' + error.message);
        }
    };
}

/**
 * Start a new game within an event — pre-fills defaults from the event
 */
async function startNewEventGame(event, team) {
    // Select the team first (ensures currentTeam is set)
    await selectCloudTeam(team);

    // Set the current event
    currentEvent = typeof deserializeTournamentEvent === 'function'
        ? deserializeTournamentEvent(event)
        : event;

    // Pre-fill game settings from event defaults
    const defaults = event.defaults || {};
    const enforceSelect = document.getElementById('enforceGenderRatioSelect');
    if (enforceSelect && defaults.alternateGenderRatio) {
        enforceSelect.value = defaults.alternateGenderRatio;
    }
    const altPullsCheckbox = document.getElementById('alternateGenderPullsCheckbox');
    if (altPullsCheckbox) {
        altPullsCheckbox.checked = defaults.alternateGenderPulls || false;
    }
    const playersInput = document.getElementById('playersOnFieldInput');
    if (playersInput && defaults.playersPerSide) {
        playersInput.value = defaults.playersPerSide;
    }

    // Show the roster screen where Start Game buttons are
    showScreen('teamRosterScreen');
}

/**
 * Navigate to event roster screen
 */
function showEventRosterScreen(event, team) {
    if (typeof showEventRosterUI === 'function') {
        selectCloudTeam(team).then(() => {
            showEventRosterUI(event);
        });
    } else {
        alert('Event roster screen not available yet.');
    }
}
