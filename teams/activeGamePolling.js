/*
 * Active-game polling (auto-join prompt) and the teams-screen auto-refresh
 * interval. Split out of teamSelection.js (D2 refactor).
 */
import { listServerGames } from '../store/sync.js';
import { _cloudTeamsCache, isGameActive, resumeCloudGame } from './teamList.js';
import { doFullRefresh } from './syncStatusUI.js';

// Active-game polling state
let _activeGamePollInterval = null;
const _dismissedActiveGames = new Set();  // game IDs user dismissed this session
let _previousActiveGameIds = new Set();   // game IDs that were active last poll

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
    }, (window.advancedSettings?.getRefreshIntervalMs?.() || 10000));
}

function stopAutoRefresh() {
    if (_autoRefreshInterval) {
        clearInterval(_autoRefreshInterval);
        _autoRefreshInterval = null;
    }
}

// Start auto-refresh on load
startAutoRefresh();

// --- ES-module exports; window.* shims below are transitional for
// --- not-yet-converted classic scripts (removed at end of migration).
export { startActiveGamePolling, stopActiveGamePolling };
// startActiveGamePolling: called bare by converted screens/navigation.js
// (typeof-guarded) and classic game/gameScreenSync.js.
window.startActiveGamePolling = startActiveGamePolling;
// stopActiveGamePolling: called bare by classic game/gameScreenSync.js.
window.stopActiveGamePolling = stopActiveGamePolling;
