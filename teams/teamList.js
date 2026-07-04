/*
 * Team & game list rendering
 * Handles team/game/event list building, team selection, join/create-team
 * dialogs, and the legacy resume/delete/select-team helpers.
 *
 * Split out of teamSelection.js (D2 refactor) — see teamSelection.js for
 * sync-status UI, syncStatusUI.js; event dialogs, eventDialogs.js; and
 * active-game polling, activeGamePolling.js.
 */
import { Team, isTestTeam } from '../store/models.js';
import {
    teams, currentTeam, setCurrentTeam, setCurrentEvent, setCurrentTeamRole,
    saveAllTeamsData, serializeTeam, deserializeTeams, deserializePlayer,
    deserializeTournamentEvent,
} from '../store/storage.js';
import {
    authFetch, API_BASE_URL, listServerGames, listTeamEvents, updateGamePhase,
    deleteGameFromCloud, deleteTeamFromCloud, loadGameFromCloud, syncUserTeams,
    createTeamOffline, clearSyncData,
} from '../store/sync.js';
import { getPlayerFromName, isPointInProgress } from '../utils/helpers.js';
import { showScreen, showEditRosterScreen, showStartGameScreen } from '../screens/navigation.js';
import { buildSyncStatusHTML } from './syncStatusUI.js';
import {
    showCreateEventDialog, showEventSettingsDialog, startNewEventGame,
    showEventRosterScreen,
} from './eventDialogs.js';
import { updateTeamRosterDisplay } from './rosterManagement.js';
import { showTeamSettingsScreen } from './teamSettings.js';
import { showGameSummaryFromList } from './gameSummary.js';
import { downloadJSON } from '../game/gameLogic.js';

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
    header.style.justifyContent = 'center';
    header.style.alignItems = 'center';
    header.style.gap = '10px';
    header.style.marginBottom = '10px';

    const title = document.createElement('h3');
    title.textContent = 'Teams, Events, and Games';
    title.style.margin = '0';
    header.appendChild(title);

    teamsContainer.appendChild(header);

    // Compact actions row: join an existing team, or create a new one.
    // The invite-code entry lives in the Join-a-Team modal (with QR scanning to come).
    const joinSection = document.createElement('div');
    joinSection.className = 'teams-actions';
    joinSection.innerHTML = `
        <button class="teams-action-btn teams-action-join" onclick="openJoinTeamModal()">
            <i class="fas fa-sign-in-alt"></i> Join a team
        </button>
        <button class="teams-action-btn teams-action-create" onclick="openCreateTeamModal()">
            <i class="fas fa-plus"></i> Create new team
        </button>
    `;
    teamsContainer.appendChild(joinSection);

    const teamsList = document.createElement('div');
    teamsList.id = 'cloudTeamsList';
    teamsList.textContent = 'Loading...';
    teamsContainer.appendChild(teamsList);

    teamListElement.appendChild(teamsContainer);

    // Populate teams and games asynchronously
    populateCloudTeamsAndGames();

    showScreen('selectTeamScreen');
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

// Cached team objects from last populateCloudTeamsAndGames() (read by activeGamePolling.js)
let _cloudTeamsCache = [];

async function populateCloudTeamsAndGames() {
    const listElement = document.getElementById('cloudTeamsList');
    if (!listElement) return;

    // Check if user is authenticated. Fetching cloud teams needs a live
    // session + connectivity, so we still can't proceed here — but tell an
    // offline / Supabase-down user that rather than wrongly nagging them to
    // sign in (they may already be signed in, just offline).
    const auth = window.breakside?.auth;
    if (!auth?.isAuthenticated?.()) {
        listElement.innerHTML = (auth?.canActOffline?.() ?? !navigator.onLine)
            ? '<p>You\'re offline. Your teams will load when you\'re back online.</p>'
            : '<p>Please sign in to view your teams.</p>';
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
                <p class="text-hint">
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
                settingsBtn.innerHTML = '<i class="fas fa-cog"></i><span class="icon-button-label">Team settings</span>';
                settingsBtn.classList.add('icon-button', 'team-settings-btn');
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
                deleteTeamBtn.innerHTML = '<i class="fas fa-trash icon-danger"></i>';
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
                setCurrentTeamRole(role);
                selectCloudTeam(team, { landOn: 'roster' });
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
                    selectCloudTeam(team, { landOn: 'startGame' });
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

        // Preserve scroll position across the rebuild. The teams screen
        // auto-refreshes every ~10s; without this, emptying then refilling the
        // list collapses page height and the browser resets scroll, yanking the
        // user back up while they're reading older teams near the bottom.
        const scroller = document.scrollingElement || document.documentElement;
        const prevScrollTop = scroller.scrollTop;

        listElement.innerHTML = '';
        listElement.appendChild(container);
        _expandStateInitialized = true;

        // Restore after the new content is in place (clamped to the new max).
        scroller.scrollTop = prevScrollTop;

    } catch (error) {
        console.error('Error populating cloud teams:', error);
        listElement.innerHTML = '<p>Error loading teams. Check connection and try again.</p>';
    }
}

// Keep old function name for backwards compatibility
async function populateCloudGames() {
    return populateCloudTeamsAndGames();
}

async function deleteCloudGame(gameId, team = null) {
    // Skip the confirm for test teams (throwaway dev data).
    const skipConfirm = typeof isTestTeam === 'function' && isTestTeam(team);
    if (!skipConfirm && !confirm('Are you sure you want to delete this game from the cloud? This cannot be undone.')) return;

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
async function deleteCloudGameWithConfirm(gameId, team = null) {
    // Skip the confirm for test teams (throwaway dev data).
    const skipConfirm = typeof isTestTeam === 'function' && isTestTeam(team);
    if (!skipConfirm && !confirm('Are you sure you want to delete this game? This cannot be undone.')) return;

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
async function selectCloudTeam(cloudTeam, options = {}) {
    console.log('📥 Selecting cloud team:', cloudTeam.name);
    // landOn: 'roster' opens the Edit Roster screen directly; anything else
    // (default) opens the Start/Continue Game screen.
    const landOn = options.landOn || 'startGame';

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

        setCurrentTeam(localTeam);

        if (typeof updateTeamRosterDisplay === 'function') {
            updateTeamRosterDisplay();
        }
        if (landOn === 'roster' && typeof showEditRosterScreen === 'function') {
            showEditRosterScreen('selectTeamScreen');
        } else if (typeof showStartGameScreen === 'function') {
            showStartGameScreen('selectTeamScreen');
        } else {
            showScreen('teamRosterScreen');
        }

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
                setCurrentTeam(teams.length > 0 ? teams[0] : null);
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
/**
 * Whether a game record matches the given canonical game id. The local Game
 * `.id` is canonical and the server mirrors it as `game_id`; call sites pass
 * the server `game_id`. Normalize so dedupe works whether a record carries
 * `.id`, `.game_id`, or both — otherwise a divergence pushes the same game
 * twice into `currentTeam.games`.
 */
function gameMatchesId(g, gameId) {
    return !!g && (g.id === gameId || g.game_id === gameId);
}

async function resumeCloudGame(cloudTeam, gameId, role) {
    console.log('📥 Resuming cloud game:', gameId, role ? `(${role})` : '');

    try {
        // Set the team role before entering the game screen
        setCurrentTeamRole(role || 'coach');

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
        const existingIndex = currentTeam.games.findIndex(g => gameMatchesId(g, gameId));
        if (existingIndex !== -1) {
            // Remove existing game from its current position
            currentTeam.games.splice(existingIndex, 1);
        }
        // Add game to end of array so currentGame() returns it
        currentTeam.games.push(game);

        // If game is part of an event, set currentEvent
        if (game.eventId && typeof listTeamEvents === 'function') {
            try {
                const events = await listTeamEvents(cloudTeam.id);
                const ev = events.find(e => e.id === game.eventId);
                if (ev) {
                    setCurrentEvent(deserializeTournamentEvent(ev));
                }
            } catch (e) {
                console.warn('Could not load event for game:', e);
            }
        }

        // Save local state
        if (typeof saveAllTeamsData === 'function') {
            saveAllTeamsData();
        }

        // Navigate to panel-based game screen
        // late-bound back-edge (gameScreenSync/gameScreenEvents live "above"
        // this layer); see ARCHITECTURE.md § ES modules — the window shims at
        // the owners are kept deliberately.
        if (typeof window.enterGameScreen === 'function') {
            window.enterGameScreen();
            const pointInProgress = typeof isPointInProgress === 'function' && isPointInProgress();
            if (!pointInProgress && typeof window.transitionToBetweenPoints === 'function') {
                window.transitionToBetweenPoints();
            }
        }

    } catch (error) {
        console.error('Error resuming cloud game:', error);
        alert('Failed to resume game: ' + error.message);
    }
}

/**
 * Open a completed game's summary from the team list.
 * Loads the game from cloud, adds to local state, then shows the summary screen.
 */
async function openCompletedGameSummary(cloudTeam, gameId) {
    try {
        await selectCloudTeam(cloudTeam);

        if (typeof loadGameFromCloud !== 'function') {
            throw new Error('Game loading not available');
        }

        const game = await loadGameFromCloud(gameId);
        if (!game) {
            throw new Error('Failed to load game data');
        }

        // Ensure game is in local state
        const existingIndex = currentTeam.games.findIndex(g => gameMatchesId(g, gameId));
        if (existingIndex !== -1) {
            currentTeam.games.splice(existingIndex, 1);
        }
        currentTeam.games.push(game);

        if (typeof showGameSummaryFromList === 'function') {
            showGameSummaryFromList(game);
        }
    } catch (error) {
        console.error('Error opening game summary:', error);
        alert('Failed to load game: ' + error.message);
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
        setCurrentTeam(teams[index]);
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
                        setCurrentTeam(newTeams[0]);
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

    // Create-team modal close button (scoped to that modal).
    const createTeamModal = document.getElementById('createTeamModal');
    const createTeamClose = createTeamModal?.querySelector('.close');
    if (createTeamClose) {
        createTeamClose.addEventListener('click', () => {
            createTeamModal.style.display = 'none';
        });
    }

    // Join-a-Team (invite code) modal wiring.
    const joinInput = document.getElementById('teamsJoinCodeInput');
    const joinBtn = document.getElementById('teamsJoinBtn');
    const joinModalClose = document.getElementById('closeJoinTeamCodeModal');
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
    if (joinModalClose) {
        joinModalClose.addEventListener('click', closeJoinTeamModal);
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

            // Offline-first: only hard-block when the user is genuinely signed
            // out *and* online (i.e. we can reach Supabase and confirmed there's
            // no session). Offline / Supabase-down falls through to the local
            // create + queue-for-sync path below.
            const auth = window.breakside?.auth;
            const isAuthed = auth?.isAuthenticated?.() === true;
            const canOffline = auth?.canActOffline?.() ?? !navigator.onLine;
            if (!isAuthed && !canOffline) {
                alert('Please sign in to create a team.');
                return;
            }

            // Disable button while creating
            saveNewTeamBtn.disabled = true;
            saveNewTeamBtn.textContent = 'Creating...';

            // Shared offline fallback: create the team locally and queue for sync.
            const createTeamLocally = () => {
                console.log('📴 Offline - creating team locally and queueing for sync');
                const newTeam = new Team(newTeamName);
                teams.push(newTeam);
                setCurrentTeam(newTeam);

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
            };

            try {
                // Not authenticated but allowed to act offline (offline or
                // Supabase unreachable): skip the server round-trip entirely.
                if (!isAuthed) {
                    createTeamLocally();
                    return;
                }

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
                setCurrentTeam(newTeam);

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
                    createTeamLocally();
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
                    setCurrentTeam(teams[0]);
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
                setCurrentTeam(null);

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
        closeJoinTeamModal();
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

/**
 * Open/close the Join-a-Team (invite code) modal, and open the Create-Team modal.
 * Invoked from the compact actions row on the teams screen.
 */
function openJoinTeamModal() {
    const modal = document.getElementById('joinTeamCodeModal');
    if (!modal) return;
    const input = document.getElementById('teamsJoinCodeInput');
    if (input) input.value = '';
    modal.style.display = 'block';
    if (input) input.focus();
}

function closeJoinTeamModal() {
    const modal = document.getElementById('joinTeamCodeModal');
    if (modal) modal.style.display = 'none';
}

function openCreateTeamModal() {
    const modal = document.getElementById('createTeamModal');
    if (!modal) return;
    const input = document.getElementById('newTeamNameInput');
    if (input) input.value = '';
    modal.style.display = 'block';
    if (input) input.focus();
}

/**
 * Render a single game list item
 * @param {object} game - Game metadata from the server
 * @param {object} team - Parent team
 * @param {string} role - 'coach' | 'viewer'
 * @param {object} [parentEvent] - If set and event has phases, render a phase picker
 */
function renderGameItem(game, team, role, parentEvent) {
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
    if (game.game_end_timestamp && role === 'coach') {
        const reviewBtn = document.createElement('button');
        reviewBtn.textContent = 'Review';
        reviewBtn.className = 'game-join-btn game-watch-btn';
        reviewBtn.title = 'Review Game';
        reviewBtn.onclick = (e) => {
            e.stopPropagation();
            openCompletedGameSummary(team, game.game_id);
        };
        line2.appendChild(reviewBtn);
    }
    if (role === 'viewer') {
        const watchBtn = document.createElement('button');
        watchBtn.textContent = game.game_end_timestamp ? 'Review' : 'Watch';
        watchBtn.className = 'game-join-btn game-watch-btn';
        watchBtn.title = game.game_end_timestamp ? 'Review Game' : 'Watch Live';
        watchBtn.onclick = (e) => {
            e.stopPropagation();
            if (game.game_end_timestamp) {
                openCompletedGameSummary(team, game.game_id);
            } else {
                resumeCloudGame(team, game.game_id, role);
            }
        };
        line2.appendChild(watchBtn);
    }

    // --- Inline phase picker (event games with phases configured, coach only) ---
    // Sits between the Review/Join button and the trash icon so each game item
    // stays one row tall.
    if (role === 'coach' && parentEvent && (parentEvent.phases || []).length > 0) {
        const select = document.createElement('select');
        select.className = 'game-phase-select';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'Select phase';
        select.appendChild(noneOpt);
        parentEvent.phases.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            select.appendChild(opt);
        });
        select.value = game.phase || '';
        select.onclick = (e) => e.stopPropagation();
        select.onchange = async (e) => {
            e.stopPropagation();
            const newPhase = select.value || null;
            select.disabled = true;
            try {
                await updateGamePhase(game.game_id, newPhase);
                game.phase = newPhase;
            } catch (err) {
                alert('Failed to update phase: ' + err.message);
                select.value = game.phase || '';
            } finally {
                select.disabled = false;
            }
        };
        line2.appendChild(select);
    }

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    line2.appendChild(spacer);

    if (role === 'coach') {
        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = '<i class="fas fa-trash icon-danger"></i>';
        deleteBtn.classList.add('icon-button');
        deleteBtn.title = 'Delete Game';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteCloudGameWithConfirm(game.game_id, team);
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

    // Event header — two rows: [name + W-L] on top, [roster | settings] below.
    const header = document.createElement('div');
    header.className = 'event-header';

    const headerTop = document.createElement('div');
    headerTop.className = 'event-header-top';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'event-name';
    nameSpan.textContent = event.name;
    if (event.status === 'closed') {
        nameSpan.textContent += ' (closed)';
    }
    headerTop.appendChild(nameSpan);
    header.appendChild(headerTop);

    if (role === 'coach') {
        const headerBtns = document.createElement('div');
        headerBtns.className = 'event-header-btns';

        // Roster label collapses "Event roster" → "Roster" → icon-only;
        // the settings label drops out first. See @container rules in css/teams.css.
        const rosterBtn = document.createElement('button');
        rosterBtn.innerHTML = '<i class="fas fa-users"></i>' +
            '<span class="ev-btn-label ev-roster-full">Event roster</span>' +
            '<span class="ev-btn-label ev-roster-short">Roster</span>';
        rosterBtn.classList.add('icon-button', 'event-header-btn');
        rosterBtn.title = 'Event Roster';
        rosterBtn.onclick = (e) => {
            e.stopPropagation();
            showEventRosterScreen(event, team);
        };
        headerBtns.appendChild(rosterBtn);

        const settingsBtn = document.createElement('button');
        settingsBtn.innerHTML = '<i class="fas fa-cog"></i>' +
            '<span class="ev-btn-label ev-settings-label">Event settings</span>';
        settingsBtn.classList.add('icon-button', 'event-header-btn');
        settingsBtn.title = 'Event Settings';
        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            showEventSettingsDialog(event, team);
        };
        headerBtns.appendChild(settingsBtn);

        header.appendChild(headerBtns);
    }

    container.appendChild(header);

    // Event games — bucket by phase if phases configured
    if (games.length > 0) {
        const phases = event.phases || [];
        if (phases.length === 0) {
            const gamesList = document.createElement('ul');
            gamesList.className = 'games-list event-games-list';
            games.forEach(game => {
                gamesList.appendChild(renderGameItem(game, team, role, event));
            });
            container.appendChild(gamesList);
        } else {
            // Group into ordered phase buckets, then an "Unassigned" bucket
            const buckets = new Map();
            phases.forEach(p => buckets.set(p, []));
            const unassigned = [];
            games.forEach(g => {
                if (g.phase && buckets.has(g.phase)) {
                    buckets.get(g.phase).push(g);
                } else {
                    unassigned.push(g);
                }
            });
            buckets.forEach((bucketGames, phaseLabel) => {
                if (bucketGames.length === 0) return;
                const phaseHeader = document.createElement('div');
                phaseHeader.className = 'event-phase-header';
                phaseHeader.textContent = phaseLabel;
                container.appendChild(phaseHeader);
                const gamesList = document.createElement('ul');
                gamesList.className = 'games-list event-games-list';
                bucketGames.forEach(game => {
                    gamesList.appendChild(renderGameItem(game, team, role, event));
                });
                container.appendChild(gamesList);
            });
            if (unassigned.length > 0) {
                const phaseHeader = document.createElement('div');
                phaseHeader.className = 'event-phase-header event-phase-unassigned';
                phaseHeader.textContent = 'Unassigned';
                container.appendChild(phaseHeader);
                const gamesList = document.createElement('ul');
                gamesList.className = 'games-list event-games-list';
                unassigned.forEach(game => {
                    gamesList.appendChild(renderGameItem(game, team, role, event));
                });
                container.appendChild(gamesList);
            }
        }
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
        const record = document.createElement('span');
        record.className = 'event-record';
        record.textContent = `${wins}W-${losses}L`;
        header.querySelector('.event-header-top').appendChild(record);
    }

    return container;
}

// --- ES-module exports ---
// _cloudTeamsCache is a live binding read by teams/activeGamePolling.js.
export {
    showSelectTeamScreen, isGameActive, populateCloudTeamsAndGames,
    selectCloudTeam, resumeCloudGame, _cloudTeamsCache,
};
// window survivor: late-bound back-edge hook (called by auth/loginScreen.js,
// store/sync.js, screens/navigation.js — all evaluate before this file and
// cannot import from it without a cycle/reorder)
window.showSelectTeamScreen = showSelectTeamScreen;
// window survivor: referenced by generated-HTML onclick
window.openJoinTeamModal = openJoinTeamModal;
// window survivor: referenced by generated-HTML onclick
window.openCreateTeamModal = openCreateTeamModal;
