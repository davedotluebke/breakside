/*
 * Active-game polling (auto-join prompt) and the teams-screen auto-refresh
 * interval. Split out of teamSelection.js (D2 refactor).
 */
import { listServerGames } from '../store/sync.js';
import { _cloudTeamsCache, isGameActive, resumeCloudGame } from './teamList.js';
import { doFullRefresh } from './syncStatusUI.js';
import { showControllerToast } from '../game/controllerState.js';
import { log } from '../utils/logger.js';

// Active-game polling state. Both loops in this file are driven by the power
// manager's shared base tick rather than their own setInterval, so they fire
// on the same moments as the other out-of-game polls and share one radio wake
// (see utils/powerPolicy.js § TICK_DRIVEN_LOOPS). These flags are only
// "subscribed or not"; the cadence lives in the schedule.
let _activeGamePollRunning = false;
const _dismissedActiveGames = new Set();  // game IDs user dismissed this session
let _previousActiveGameIds = new Set();   // game IDs that were active last poll

/**
 * Start polling for active games across the user's teams.
 * Shows a toast when another coach starts or resumes a game.
 */
function startActiveGamePolling() {
    if (_activeGamePollRunning) return; // already polling
    if (!window.breakside?.auth?.isAuthenticated?.()) return;
    if (!navigator.onLine) return;

    _activeGamePollRunning = true;
    checkForActiveGames(); // immediate first check
    log('📡 Active-game polling started');
}

/**
 * Stop active-game polling.
 */
function stopActiveGamePolling() {
    if (_activeGamePollRunning) {
        _activeGamePollRunning = false;
        log('📡 Active-game polling stopped');
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

// Team-screen auto-refresh, on the shared tick (cadence from the Cloud
// refresh interval setting — see utils/powerPolicy.js loopPeriods).
let _autoRefreshRunning = false;

function startAutoRefresh() {
    _autoRefreshRunning = true;
}

function stopAutoRefresh() {
    _autoRefreshRunning = false;
}

// Start auto-refresh on load
startAutoRefresh();

// Power plan: both of these are network polls that only ever act on the team
// screen, so there is nothing for them to do while the page is hidden or while
// the coach is inside a game. startActiveGamePolling() keeps its own auth /
// online guards; this only decides whether they're subscribed to the tick.
document.addEventListener('breakside:power-plan', (e) => {
    const plan = e.detail?.plan;
    if (!plan) return;

    if (plan.teamAutoRefresh) startAutoRefresh();
    else stopAutoRefresh();

    if (plan.activeGamePoll) startActiveGamePolling();
    else stopActiveGamePolling();
});

// The tick. Both bodies are exactly what their setIntervals used to run; only
// the clock they hang off has changed.
document.addEventListener('breakside:power-tick', (e) => {
    const due = e.detail?.due;
    if (!due) return;

    if (_autoRefreshRunning && due.includes('teamAutoRefresh')) {
        window.powerLog?.countWakeup?.('teamAutoRefresh');
        // Only auto-refresh when the select team screen is visible
        const syncContainer = document.getElementById('syncStatusContainer');
        const selectScreen = document.getElementById('selectTeamScreen');
        if (syncContainer && selectScreen && selectScreen.style.display !== 'none') {
            doFullRefresh(true); // silent refresh
        }
    }

    if (_activeGamePollRunning && due.includes('activeGamePoll')) {
        window.powerLog?.countWakeup?.('activeGamePoll');
        checkForActiveGames();
    }
});

// --- ES-module exports ---
export { startActiveGamePolling, stopActiveGamePolling };
// window survivor: late-bound back-edge hook (called by screens/navigation.js,
// which evaluates before this file and cannot import from it without a reorder)
window.startActiveGamePolling = startActiveGamePolling;
