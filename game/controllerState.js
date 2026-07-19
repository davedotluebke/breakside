/*
 * Game Controller State Management
 * 
 * Handles Active Coach / Line Coach role claims and handoffs for multi-coach
 * collaboration during live games.
 * 
 * Roles:
 * - activeCoach: Has write control for play-by-play events
 * - lineCoach: Can prepare the next lineup during a point
 * 
 * Only one user can hold each role at a time. Handoffs allow smooth
 * transitions when coaches want to swap responsibilities.
 */
import { authFetch, API_BASE_URL, refreshGameStateFromCloud } from '../store/sync.js';
import { isTestGame } from '../store/models.js';
import { currentGame } from '../utils/helpers.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { showSelectTeamScreen } from '../teams/teamList.js';
import { log } from '../utils/logger.js';

// =============================================================================
// State
// =============================================================================

// Current controller state
let controllerState = {
    activeCoach: null,      // { userId, displayName, claimedAt, lastPing }
    lineCoach: null,        // { userId, displayName, claimedAt, lastPing }
    pendingHandoff: null,   // { role, requesterId, requesterName, currentHolderId, requestedAt, expiresAt }
    isActiveCoach: false,   // Whether current user holds Active Coach role
    isLineCoach: false,     // Whether current user holds Line Coach role
    hasPendingHandoffForMe: false,
    lastUpdate: null
};

// Polling configuration
const PING_INTERVAL_ACTIVE = 2000;  // 2 seconds when holding a role
const PING_INTERVAL_IDLE = 5000;    // 5 seconds when not holding a role

let controllerPollIntervalId = null;
let currentGameIdForPolling = null;


// =============================================================================
// API Functions
// =============================================================================

/**
 * Get current controller state from server
 * @param {string} gameId - The game ID
 * @returns {Promise<object|null>} Controller state or null on error
 */
async function fetchControllerState(gameId) {
    if (!gameId) {
        console.warn('fetchControllerState: No game ID provided');
        return null;
    }
    
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/controller`);
        if (!response.ok) {
            if (response.status === 401) {
                log('Controller: Not authenticated');
                return null;
            }
            throw new Error(`Failed to fetch controller state: ${response.statusText}`);
        }
        const data = await response.json();
        updateLocalControllerState(data);
        return data;
    } catch (error) {
        console.error('Error fetching controller state:', error);
        return null;
    }
}

/**
 * Claim the Active Coach role
 * @param {string} gameId - The game ID
 * @returns {Promise<object>} Result with status and state
 */
async function claimActiveCoach(gameId) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/claim-active`, {
            method: 'POST'
        });
        const data = await response.json();
        
        if (response.ok) {
            if (data.status === 'claimed') {
                myOutstandingHandoff = null;
                showControllerToast('You are now Active Coach', 'success');
                updateLocalControllerState({
                    state: data.state,
                    hasPendingHandoffForMe: false
                });
            } else if (data.status === 'handoff_requested') {
                // Record this request durably so its resolution toast fires
                // exactly once regardless of poll timing.
                myOutstandingHandoff = { key: getHandoffKey(data.state?.pendingHandoff), role: 'activeCoach' };
                // Toast stays visible for full handoff timeout, track for auto-dismiss
                const timeoutMs = (data.handoff?.expiresInSeconds ?? handoffTimeoutSeconds) * 1000;
                handoffRequestSentToast = showControllerToast('Handoff request sent...', 'info', timeoutMs);
                updateLocalControllerState({
                    state: data.state
                });
            }
            return { success: true, ...data };
        } else {
            showControllerToast(`Cannot claim role: ${data.detail || 'Unknown error'}`, 'error');
            return { success: false, error: data.detail };
        }
    } catch (error) {
        console.error('Error claiming active coach:', error);
        showControllerToast('Error claiming role', 'error');
        return { success: false, error: error.message };
    }
}

/**
 * Claim the Line Coach role
 * @param {string} gameId - The game ID
 * @returns {Promise<object>} Result with status and state
 */
async function claimLineCoach(gameId) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/claim-line`, {
            method: 'POST'
        });
        const data = await response.json();
        
        if (response.ok) {
            if (data.status === 'claimed') {
                myOutstandingHandoff = null;
                showControllerToast('You are now Line Coach', 'success');
                updateLocalControllerState({
                    state: data.state,
                    hasPendingHandoffForMe: false
                });
            } else if (data.status === 'handoff_requested') {
                // Record this request durably so its resolution toast fires
                // exactly once regardless of poll timing.
                myOutstandingHandoff = { key: getHandoffKey(data.state?.pendingHandoff), role: 'lineCoach' };
                // Toast stays visible for full handoff timeout, track for auto-dismiss
                const timeoutMs = (data.handoff?.expiresInSeconds ?? handoffTimeoutSeconds) * 1000;
                handoffRequestSentToast = showControllerToast('Handoff request sent...', 'info', timeoutMs);
                updateLocalControllerState({
                    state: data.state
                });
            }
            return { success: true, ...data };
        } else {
            showControllerToast(`Cannot claim role: ${data.detail || 'Unknown error'}`, 'error');
            return { success: false, error: data.detail };
        }
    } catch (error) {
        console.error('Error claiming line coach:', error);
        showControllerToast('Error claiming role', 'error');
        return { success: false, error: error.message };
    }
}

/**
 * Release current role
 * @param {string} gameId - The game ID
 * @param {string} role - 'activeCoach' or 'lineCoach'
 * @returns {Promise<object>} Result with status
 */
async function releaseControllerRole(gameId, role) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/release`, {
            method: 'POST',
            body: JSON.stringify({ role })
        });
        const data = await response.json();
        
        if (response.ok) {
            const roleLabel = role === 'activeCoach' ? 'Active Coach' : 'Line Coach';
            // Deliberate release — don't also fire the role-loss toast.
            if (role === 'activeCoach' || role === 'lineCoach') {
                suppressRoleLossToast[role] = true;
            }
            showControllerToast(`Released ${roleLabel} role`, 'info');
            updateLocalControllerState({
                state: data.state,
                hasPendingHandoffForMe: false
            });
            return { success: true, ...data };
        } else {
            return { success: false, error: data.detail };
        }
    } catch (error) {
        console.error('Error releasing role:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Respond to a pending handoff request
 * @param {string} gameId - The game ID
 * @param {boolean} accept - True to transfer role, false to deny
 * @returns {Promise<object>} Result with status
 */
async function respondToHandoff(gameId, accept) {
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/handoff-response`, {
            method: 'POST',
            body: JSON.stringify({ accept })
        });
        const data = await response.json();

        if (response.ok) {
            if (accept) {
                // Deliberate transfer — don't also fire the role-loss toast.
                const handedRole = controllerState.pendingHandoff?.role;
                if (handedRole) {
                    suppressRoleLossToast[handedRole] = true;
                }
                showControllerToast('Handoff accepted - role transferred', 'info');
                updateLocalControllerState({
                    state: data.state,
                    hasPendingHandoffForMe: false
                });
            } else {
                showControllerToast('Handoff denied', 'info');
                updateLocalControllerState({
                    state: data.state,
                    hasPendingHandoffForMe: false
                });
            }
            hideHandoffRequestUI();
            return { success: true, ...data };
        } else {
            // 400 with a reason (no_pending_handoff / not_holder): the server
            // already resolved this handoff some other way (auto-approve,
            // requester gone). Say so instead of failing silently — the
            // outcome itself arrives via the next poll (role-loss toast or
            // unchanged state).
            log(`🎮 Handoff response rejected: ${data.detail || 'unknown reason'}`);
            showControllerToast('Handoff was already resolved', 'info');
            hideHandoffRequestUI();
            return { success: false, error: data.detail };
        }
    } catch (error) {
        console.error('Error responding to handoff:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Ping server to keep role alive
 * @param {string} gameId - The game ID
 * @returns {Promise<object|null>} Ping result or null on error
 */
async function pingController(gameId) {
    if (!gameId) return null;
    
    try {
        const response = await authFetch(`${API_BASE_URL}/api/games/${gameId}/ping`, {
            method: 'POST'
        });
        
        if (response.ok) {
            const data = await response.json();
            
            // Update local state - role flags are computed in updateLocalControllerState
            updateLocalControllerState({
                state: data.controllerState,
                hasPendingHandoffForMe: data.hasPendingHandoffForMe,
                connectedCoaches: data.connectedCoaches
            });
            
            return data;
        }
        return null;
    } catch (error) {
        console.error('Controller ping failed:', error);
        return null;
    }
}


// =============================================================================
// State Management
// =============================================================================

/**
 * Update local controller state and trigger UI updates
 * @param {object} data - New state data from server
 */
function updateLocalControllerState(data) {
    const previousState = { ...controllerState };
    
    // Update handoff timeout from server if provided
    if (data.handoffTimeoutSeconds) {
        handoffTimeoutSeconds = data.handoffTimeoutSeconds;
    }
    
    // Determine which roles this user holds
    const myUserId = getCurrentUserId();
    const newActiveCoach = data.state?.activeCoach || null;
    const newLineCoach = data.state?.lineCoach || null;
    
    const iAmActiveCoach = newActiveCoach?.userId === myUserId;
    const iAmLineCoach = newLineCoach?.userId === myUserId;
    
    controllerState = {
        activeCoach: newActiveCoach,
        lineCoach: newLineCoach,
        pendingHandoff: data.state?.pendingHandoff || null,
        isActiveCoach: iAmActiveCoach,
        isLineCoach: iAmLineCoach,
        hasPendingHandoffForMe: data.hasPendingHandoffForMe || false,
        connectedCoaches: data.connectedCoaches || controllerState.connectedCoaches || [],
        lastUpdate: new Date()
    };
    
    // Check if a handoff request *I* made was resolved. Keyed off the durable
    // myOutstandingHandoff record rather than diffing previousState, so the
    // resolution is detected on whichever update first observes the request is
    // gone (and only once), even when a fetch and a ping both land between
    // polls. The request is resolved when the server no longer shows my exact
    // pending request (granted, denied, or expired → different/no pendingHandoff).
    if (myOutstandingHandoff) {
        const currentHandoffKey = getHandoffKey(controllerState.pendingHandoff);
        const stillPending = currentHandoffKey === myOutstandingHandoff.key;

        if (!stillPending) {
            const requestedRole = myOutstandingHandoff.role;
            myOutstandingHandoff = null;

            // Dismiss the "request sent" toast first
            if (handoffRequestSentToast && handoffRequestSentToast.parentElement) {
                dismissToast(handoffRequestSentToast);
            }
            handoffRequestSentToast = null;

            // Check if I got the role I requested
            const iGotTheRole = (requestedRole === 'activeCoach' && controllerState.isActiveCoach) ||
                               (requestedRole === 'lineCoach' && controllerState.isLineCoach);
            const roleName = requestedRole === 'activeCoach' ? 'Play-by-Play' : 'Next Line';

            if (iGotTheRole) {
                showControllerToast(`You are now ${roleName}`, 'success');
            } else {
                showControllerToast(`Handoff request for ${roleName} was denied`, 'error');
            }
        }
    }
    
    // Surface role losses the user would otherwise never learn about
    // (stale-expiry takeover, handoff auto-approve while this tab slept, …).
    notifyRoleTransitions(previousState, controllerState, myUserId);

    // Trigger UI update (module-local function — the old typeof guard is moot)
    updateControllerUI(controllerState, previousState);

    // Handle handoff UI based on server state
    if (controllerState.hasPendingHandoffForMe && controllerState.pendingHandoff) {
        // Server says there's a pending handoff for us
        showHandoffRequestUI(controllerState.pendingHandoff);
    } else {
        // Server says no pending handoff - clear the resolved-key memory and
        // hide any toast
        if (lastResolvedHandoffKey) {
            log('🎮 Server confirmed handoff resolved, clearing resolved key');
            lastResolvedHandoffKey = null;
        }
        // Hide any lingering handoff toast
        if (handoffToastElement) {
            hideHandoffRequestUI();
        }
    }
    
    // Adjust polling interval based on role
    if (currentGameIdForPolling) {
        adjustPollingInterval();
    }
}

/**
 * Toast when this user LOSES a role without having asked to (stale-expiry
 * takeover, handoff auto-approve while the tab was throttled, any server-side
 * transfer). Level-based: compares held-flags between consecutive local
 * states, so a missed poll can't drop the notification — whichever update
 * first observes the loss fires it. Deliberate losses (release, accepting a
 * handoff) set suppressRoleLossToast first and stay silent. Gains already
 * toast at their sources (claim/auto-assign/resolution paths).
 */
function notifyRoleTransitions(prev, next, myUserId) {
    for (const role of ['activeCoach', 'lineCoach']) {
        const had = role === 'activeCoach' ? prev.isActiveCoach : prev.isLineCoach;
        const have = role === 'activeCoach' ? next.isActiveCoach : next.isLineCoach;
        if (!had || have) continue;

        if (suppressRoleLossToast[role]) {
            suppressRoleLossToast[role] = false;
            continue;
        }

        const holder = next[role];
        const roleName = role === 'activeCoach' ? 'Play-by-Play' : 'Next Line';
        // Dedupe on the specific takeover (role + new holder + their claim
        // time) so racing fetch/ping updates toast at most once.
        const key = `${role}|${holder?.userId || 'vacant'}|${holder?.claimedAt || ''}`;
        if (key === lastRoleLossToastKey) continue;
        lastRoleLossToastKey = key;

        const takenByOther = holder && holder.userId !== myUserId;
        const message = takenByOther
            ? `${holder.displayName || 'Another coach'} took over ${roleName}`
            : `You no longer hold ${roleName}`;
        showControllerToast(message, 'warning', 6000);
        if (typeof logEvent === 'function') {
            logEvent(`🎮 ${message}`);
        }
    }
}

/**
 * Get the current user's ID
 * @returns {string|null} User ID or null
 */
function getCurrentUserId() {
    if (window.breakside?.auth?.getCurrentUser) {
        const user = window.breakside.auth.getCurrentUser();
        return user?.id || null;
    }
    return null;
}


// =============================================================================
// Polling
// =============================================================================

/**
 * Start controller state polling for a game
 * @param {string} gameId - The game ID to poll
 */
function startControllerPolling(gameId) {
    if (!gameId) {
        console.warn('startControllerPolling: No game ID provided');
        return;
    }

    // Viewers don't participate in controller state — they only watch via refreshGameState()
    if (typeof window.isViewer === 'function' && window.isViewer()) {
        log('👁️ Viewer mode: skipping controller polling');
        return;
    }
    
    // Stop any existing polling
    stopControllerPolling();
    
    currentGameIdForPolling = gameId;
    
    // Initial fetch
    fetchControllerState(gameId);

    // Start polling (faster interval when holding a role)
    const interval = installPingInterval();

    log(`🎮 Controller polling started for game ${gameId} (${interval}ms)`);
}

/**
 * (Re)install the controller ping interval, clearing any existing one.
 * Interval is role-based: faster while holding a role.
 * @returns {number} The interval in ms that was installed
 */
function installPingInterval() {
    if (controllerPollIntervalId) {
        clearInterval(controllerPollIntervalId);
    }
    const hasRole = controllerState.isActiveCoach || controllerState.isLineCoach;
    const interval = hasRole ? PING_INTERVAL_ACTIVE : PING_INTERVAL_IDLE;
    controllerPollIntervalId = setInterval(() => {
        if (currentGameIdForPolling) {
            window.pingController(currentGameIdForPolling); // via window: e2e test seam (tests replace window.pingController)
        }
    }, interval);
    return interval;
}

/**
 * Stop controller state polling
 */
function stopControllerPolling() {
    if (controllerPollIntervalId) {
        clearInterval(controllerPollIntervalId);
        controllerPollIntervalId = null;
    }
    currentGameIdForPolling = null;
    // Drop any outstanding handoff request so its resolution toast can't leak
    // into a later game session.
    myOutstandingHandoff = null;
    // Reset held-role flags and toast memories so the first poll of a LATER
    // game can't read this game's roles as "just lost" (false loss toast) or
    // suppress/dedupe against this game's handoffs.
    controllerState = {
        activeCoach: null,
        lineCoach: null,
        pendingHandoff: null,
        isActiveCoach: false,
        isLineCoach: false,
        hasPendingHandoffForMe: false,
        connectedCoaches: [],
        lastUpdate: null
    };
    lastResolvedHandoffKey = null;
    lastRoleLossToastKey = null;
    suppressRoleLossToast = { activeCoach: false, lineCoach: false };
    log('🎮 Controller polling stopped');
}

/**
 * Adjust polling interval based on current role
 */
function adjustPollingInterval() {
    if (!controllerPollIntervalId || !currentGameIdForPolling) return;
    installPingInterval();
}

/**
 * Check if controller polling is currently active
 * @returns {boolean} True if polling is running
 */
function isControllerPollingActive() {
    return controllerPollIntervalId !== null;
}

/**
 * Get the game ID currently being polled
 * @returns {string|null} Game ID or null if not polling
 */
function getPollingGameId() {
    return currentGameIdForPolling;
}


// =============================================================================
// Wake/Sleep Recovery (Page Visibility API)
// =============================================================================

/**
 * Handle page visibility changes (phone sleep/wake, tab switch, app switch).
 * 
 * When the page becomes hidden, browsers throttle or pause setInterval timers.
 * The server expires roles after 30 seconds without a ping. When the page
 * becomes visible again, we need to:
 * 1. Immediately ping to get the latest server state
 * 2. Re-claim any roles that were lost due to ping timeout
 * 3. Restart polling at the correct interval
 * 4. Restart game state refresh if it was stopped
 */
// Maximum game age (in hours) before prompting the user on wake
const STALE_GAME_HOURS = 6;

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;

    // Primary path: we still know our polling game id. Common case after a
    // brief screen-off; the in-memory state is intact, we just need to
    // ping aggressively to re-claim any expired roles.
    let gameId = currentGameIdForPolling;

    // Fallback: polling was stopped while we were hidden, but the game
    // screen is still mounted (we have a `currentGame()`). This happens
    // when the JS context was reset (PWA reload from background) or some
    // path nulled `currentGameIdForPolling` without navigating away.
    // Restart polling from the in-memory game id so the user isn't left
    // stranded with role buttons that error out with "No active game."
    if (!gameId) {
        const game = (typeof currentGame === 'function') ? currentGame() : null;
        if (game?.id) {
            log('🎮 Page became visible — polling was stopped; restarting from currentGame()');
            startControllerPolling(game.id);
            gameId = game.id;
        } else {
            return; // Not in a game
        }
    }

    log('🎮 Page became visible — recovering game session...');

    // --- Pause game state refresh during recovery ---
    // Prevents the refresh timer from racing with this handler and making
    // decisions based on stale controller state.
    if (typeof window.stopGameStateRefresh === 'function') {
        window.stopGameStateRefresh(); // late-bound back-edge (owner game/gameScreenSync.js keeps the shim; import would cycle)
    }

    // --- Check for ended or stale game before attempting recovery ---
    const game = typeof currentGame === 'function' ? currentGame() : null;

    if (game) {
        // Refresh game data from cloud to detect if another coach ended the game
        if (typeof refreshGameStateFromCloud === 'function') {
            try {
                await refreshGameStateFromCloud(gameId);
            } catch (e) {
                console.warn('🎮 Failed to refresh game state on wake:', e);
            }
        }

        // Gap 1: Game was ended by another coach while we were away
        if (game.gameEndTimestamp) {
            log('🎮 Game ended while away — returning to team selection');
            showControllerToast('Game has ended', 'info', 3000);
            stopControllerPolling();
            if (typeof window.exitGameScreen === 'function') {
                window.exitGameScreen(); // late-bound back-edge (owner game/gameScreenSync.js keeps the shim; import would cycle)
            }
            if (typeof showSelectTeamScreen === 'function') {
                showSelectTeamScreen();
            }
            return; // Skip role recovery
        }

        // Gap 2: Game is very old — probably abandoned
        const gameStart = game.gameStartTimestamp
            ? new Date(game.gameStartTimestamp).getTime()
            : null;
        // Test games are long-lived dev fixtures reopened across many coding
        // sessions — skip the stale-game wake nag entirely for them.
        const isTestFixture = typeof isTestGame === 'function' && isTestGame(game);
        if (isTestFixture) {
            log('🎮 Test game — skipping stale-game wake check');
        }
        if (gameStart && !isTestFixture) {
            const hoursElapsed = (Date.now() - gameStart) / (1000 * 60 * 60);
            if (hoursElapsed > STALE_GAME_HOURS) {
                // Check if there's been any recent activity (last point within the threshold)
                const lastPoint = game.points && game.points.length > 0
                    ? game.points[game.points.length - 1]
                    : null;
                const lastActivity = lastPoint?.endTimestamp
                    ? new Date(lastPoint.endTimestamp).getTime()
                    : lastPoint?.startTimestamp
                        ? new Date(lastPoint.startTimestamp).getTime()
                        : gameStart;
                const hoursSinceActivity = (Date.now() - lastActivity) / (1000 * 60 * 60);

                if (hoursSinceActivity > STALE_GAME_HOURS) {
                    log(`🎮 Game idle for ${hoursSinceActivity.toFixed(1)}h — prompting user`);
                    const keepGoing = confirm(
                        `This game has been idle for ${Math.floor(hoursSinceActivity)} hours.\n\n` +
                        'Return to the team list?'
                    );
                    if (keepGoing) {
                        stopControllerPolling();
                        if (typeof window.exitGameScreen === 'function') {
                            window.exitGameScreen(); // late-bound back-edge (owner game/gameScreenSync.js keeps the shim; import would cycle)
                        }
                        if (typeof showSelectTeamScreen === 'function') {
                            showSelectTeamScreen();
                        }
                        return; // Skip role recovery
                    }
                    // User chose to stay — continue with recovery below
                }
            }
        }
    }

    // --- Normal recovery: re-claim roles and restart polling ---

    // Remember what roles we had before the sleep
    const hadActiveCoach = controllerState.isActiveCoach;
    const hadLineCoach = controllerState.isLineCoach;

    // Always restart the polling interval unconditionally.
    // After sleep, the browser may have frozen or invalidated the previous
    // interval — checking controllerPollIntervalId is unreliable here.
    installPingInterval();

    // Immediately ping to get fresh server state, with retries.
    // The first ping after wake may fail if the network is still restoring.
    let result = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        result = await window.pingController(gameId); // via window: e2e test seam (tests replace window.pingController)
        if (result) break;
        console.warn(`🎮 Wake ping attempt ${attempt}/3 failed — retrying in 1s...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!result) {
        console.warn('🎮 All wake ping attempts failed — polling will continue retrying');
        // Don't return — let polling continue and restart game state refresh below
    }

    // Check if roles were lost during sleep and silently re-claim — but ONLY
    // if the role is now VACANT on the server. If another coach legitimately
    // took it while we slept, leave it with them (Active Coach is
    // authoritative): re-claiming would either yank control back outright (if
    // the server let it expire) or fire an unwanted handoff request. The post-
    // ping controllerState reflects fresh server state, so a null holder means
    // the role is free to retake.
    if (result) {
        const lostActiveCoach = hadActiveCoach && !controllerState.isActiveCoach;
        const lostLineCoach = hadLineCoach && !controllerState.isLineCoach;
        const activeCoachVacant = !controllerState.activeCoach;
        const lineCoachVacant = !controllerState.lineCoach;

        if (lostActiveCoach && !activeCoachVacant) {
            log('🎮 Active Coach taken by another coach during sleep — not re-claiming');
        }
        if (lostLineCoach && !lineCoachVacant) {
            log('🎮 Line Coach taken by another coach during sleep — not re-claiming');
        }

        const reclaimActive = lostActiveCoach && activeCoachVacant;
        const reclaimLine = lostLineCoach && lineCoachVacant;

        if (reclaimActive || reclaimLine) {
            log(`🎮 Roles lost during sleep and now vacant — re-claiming (active: ${reclaimActive}, line: ${reclaimLine})`);

            if (reclaimActive) {
                const claimResult = await claimActiveCoach(gameId);
                if (claimResult?.success) {
                    log('🎮 Re-claimed Active Coach after wake');
                }
            }

            if (reclaimLine) {
                const claimResult = await claimLineCoach(gameId);
                if (claimResult?.success) {
                    log('🎮 Re-claimed Line Coach after wake');
                }
            }
        }
    }

    // Restart game state refresh now that recovery is complete
    if (typeof window.startGameStateRefresh === 'function') {
        window.startGameStateRefresh(); // late-bound back-edge (owner game/gameScreenSync.js keeps the shim; import would cycle)
    }
});


// =============================================================================
// Role Checks
// =============================================================================

/**
 * Get current user's primary controller role
 * Note: User can hold both roles simultaneously. This returns the "primary" role
 * for UI purposes. Use isActiveCoach() and isLineCoach() for accurate role checks.
 * @returns {string|null} 'activeCoach', 'lineCoach', or null
 */
function getMyControllerRole() {
    // Return activeCoach if held (takes priority), otherwise lineCoach, otherwise null
    if (controllerState.isActiveCoach) return 'activeCoach';
    if (controllerState.isLineCoach) return 'lineCoach';
    return null;
}

/**
 * Check if current user is Active Coach
 * @returns {boolean}
 */
function isActiveCoach() {
    return controllerState.isActiveCoach;
}

/**
 * Check if current user is Line Coach
 * @returns {boolean}
 */
function isLineCoach() {
    return controllerState.isLineCoach;
}

/**
 * Check if user can edit play-by-play events.
 *
 * Mirrors canEditSelectLinePanel's gating pattern (introduced in commit
 * b952236): in solo / pre-multi-coach sessions there's no role
 * enforcement; once the panelSystem multi-coach latch flips, PBP edits
 * are restricted to the Active Coach. The previous fallback ("allow if
 * no Active Coach claimed") leaked edit access to spectator coaches who
 * had connected but not yet claimed a role — the same hole b952236
 * fixed for the Line panel.
 *
 * @returns {boolean}
 */
function canEditPlayByPlay() {
    if (typeof window.isViewer === 'function' && window.isViewer()) return false;
    const multiCoach = typeof window.isMultiCoachDetected === 'function'
        ? window.isMultiCoachDetected() : false;
    if (!multiCoach) return true;
    return controllerState.isActiveCoach;
}

/**
 * Check if user can edit lineup
 * Allowed if: Line Coach, Active Coach, or no one has claimed either role
 * @returns {boolean}
 */
function canEditLineup() {
    if (typeof window.isViewer === 'function' && window.isViewer()) return false;
    return controllerState.isLineCoach ||
           controllerState.isActiveCoach ||
           (!controllerState.lineCoach && !controllerState.activeCoach);
}

/**
 * Get current controller state (read-only copy)
 * @returns {object}
 */
function getControllerState() {
    return { ...controllerState };
}


// =============================================================================
// UI Helpers (Phase 6 Implementation)
// =============================================================================

// Handoff countdown state
let handoffCountdownInterval = null;
let handoffToastElement = null;
let currentHandoffId = null; // Track which handoff we're showing to avoid duplicates
// Key of the one handoff this client already resolved (accept/deny/expiry),
// kept only until the server confirms no handoff is pending. Keyed — NOT a
// boolean — so a *new* request (different key) always gets its prompt. The old
// `handoffResolved` boolean deadlocked here: if it was ever left true when the
// next request arrived, that request's prompt was suppressed for its entire
// lifetime, because the reset only runs in the no-pending branch (G11.1 bug).
let lastResolvedHandoffKey = null;
let handoffRequestSentToast = null; // Track "handoff request sent" toast for auto-dismiss

// Role-loss notification state. Losing a role is detected as a *level*
// transition (held in previousState → not held now) rather than an inferred
// event, so it survives missed polls; the dedupe key prevents re-toasting the
// same takeover when several updates race. Deliberate hand-offs (release,
// accept) suppress the next loss toast for that role.
let suppressRoleLossToast = { activeCoach: false, lineCoach: false };
let lastRoleLossToastKey = null;

// Handoff timeout - fetched from server, fallback to 10s
let handoffTimeoutSeconds = 10;

// Durable record of a handoff request *this* client made, used to fire the
// "you got it / was denied" toast exactly once. We key off a stable per-request
// id rather than frame-to-frame diffing previousState, because polling replaces
// controllerState wholesale and a fetch+ping can both land between snapshots —
// dropping the transition. Set when a claim returns 'handoff_requested',
// cleared when the request resolves (granted, denied, or expired).
// Shape: { key: string, role: 'activeCoach'|'lineCoach' } or null.
let myOutstandingHandoff = null;

/**
 * Stable id for a pending handoff. Matches the format used for the incoming
 * handoff toast (currentHandoffId) so the two never disagree.
 */
function getHandoffKey(handoff) {
    if (!handoff) return null;
    return `${handoff.requesterId}-${handoff.role}-${handoff.requestedAt}`;
}

/**
 * Show a toast notification for controller events
 * @param {string} message - Message to display
 * @param {string} type - 'success', 'info', 'warning', 'error'
 * @param {number} duration - Duration in ms (default 4000)
 * @param {object} options - Optional callbacks: { onTap, onDismiss }
 */
function showControllerToast(message, type = 'info', duration = 4000, options = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) {
        log(`🎮 Controller [${type}]: ${message}`);
        return null;
    }
    
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    // Icon based on type
    const icons = {
        success: 'fa-check-circle',
        info: 'fa-info-circle',
        warning: 'fa-exclamation-triangle',
        error: 'fa-times-circle'
    };
    
    toast.innerHTML = `
        <i class="fas ${icons[type] || icons.info}"></i>
        <span class="toast-message">${message}</span>
        <button class="toast-close">
            <i class="fas fa-times"></i>
        </button>
    `;
    
    // Close button handler
    toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));

    // Actionable toast: tap body (excluding close button) to trigger onTap
    if (options.onTap) {
        toast.classList.add('toast-actionable');
        toast.addEventListener('click', (e) => {
            // Don't trigger if they clicked the close button
            if (e.target.closest('.toast-close')) return;
            options.onTap();
            dismissToast(toast);
        });
    }

    // Store onDismiss callback for dismissToast to call
    if (options.onDismiss) {
        toast._onDismiss = options.onDismiss;
    }

    // Add swipe-to-dismiss functionality
    addSwipeToDismiss(toast, () => dismissToast(toast, true));

    container.appendChild(toast);
    
    // Auto-remove after duration (if duration > 0)
    // Duration of 0 means persistent - user must dismiss manually
    if (duration > 0) {
        const autoRemoveTimeout = setTimeout(() => {
            dismissToast(toast);
        }, duration);
        
        // Store timeout so we can cancel it if manually dismissed
        toast.dataset.timeoutId = autoRemoveTimeout;
    }
    
    // Also log to event log if available
    if (typeof logEvent === 'function') {
        logEvent(`🎮 ${message}`);
    }
    log(`🎮 Controller [${type}]: ${message}`);
    
    return toast;
}

/**
 * Dismiss a toast with animation
 * @param {HTMLElement} toast - The toast element to dismiss
 * @param {boolean} wasSwiped - If true, skip animation (already swiped away)
 */
function dismissToast(toast, wasSwiped = false) {
    if (!toast || !toast.parentElement) return;

    // Cancel auto-remove timeout
    if (toast.dataset.timeoutId) {
        clearTimeout(parseInt(toast.dataset.timeoutId));
    }

    // Call onDismiss callback if set
    if (toast._onDismiss) {
        toast._onDismiss();
    }

    if (wasSwiped) {
        // Already swiped away, just remove immediately
        toast.remove();
    } else {
        // Use animation for non-swiped dismissals
        toast.classList.add('toast-hiding');
        setTimeout(() => toast.remove(), 300);
    }
}

/**
 * Add swipe-up-to-dismiss behavior to a toast. Swiping up more than 50px
 * triggers onSwipedAway; a shorter swipe springs the toast back.
 * Shared by the regular controller toasts (swipe = dismiss) and the handoff
 * toast (swipe = accept).
 * @param {HTMLElement} toast - The toast element
 * @param {Function} onSwipedAway - Called when swiped up past the threshold
 */
function addSwipeToDismiss(toast, onSwipedAway) {
    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    const handleStart = (e) => {
        isDragging = true;
        startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
        currentY = startY;
        toast.classList.add('toast-swiping');
    };

    const handleMove = (e) => {
        if (!isDragging) return;

        currentY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
        const deltaY = currentY - startY;

        // Only allow swiping up (negative deltaY)
        if (deltaY < 0) {
            // Prevent page scroll when swiping toast
            e.preventDefault();
            toast.style.transform = `translateY(${deltaY}px)`;
            toast.style.opacity = Math.max(0, 1 + deltaY / 100);
        }
    };

    const handleEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        toast.classList.remove('toast-swiping');

        const deltaY = currentY - startY;

        // If swiped up more than 50px, complete the swipe (no animation flicker)
        if (deltaY < -50) {
            onSwipedAway();
        } else {
            // Reset position
            toast.style.transform = '';
            toast.style.opacity = '';
        }
    };

    // Touch events - use passive: false to allow preventDefault
    toast.addEventListener('touchstart', handleStart, { passive: true });
    toast.addEventListener('touchmove', handleMove, { passive: false });
    toast.addEventListener('touchend', handleEnd);
    toast.addEventListener('touchcancel', handleEnd);

    // Mouse events (for desktop testing). The document-level move/up
    // listeners are installed only for the duration of a drag and removed
    // on mouseup — attaching them permanently here used to leak one
    // mousemove+mouseup pair (and retain the toast element) per toast shown.
    const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleMouseUp);
        handleEnd();
    };
    toast.addEventListener('mousedown', (e) => {
        handleStart(e);
        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleMouseUp);
    });
}

/**
 * Notify cross-module listeners that controller UI state was updated.
 * Hook for cross-module reactions (replaces the old window.updateControllerUI
 * monkey-patch in gameScreenSync.js, which can't survive ES modules).
 */
function notifyControllerUiUpdated(state, previousState) {
    document.dispatchEvent(new CustomEvent('breakside:controller-ui-updated', { detail: { state, previousState } }));
}

/**
 * Update controller UI elements (role buttons in header)
 * @param {object} state - Current controller state
 * @param {object} previousState - Previous controller state
 */
function updateControllerUI(state, previousState) {
    const roleButtonsContainer = document.getElementById('controllerRoleButtons');
    const activeCoachBtn = document.getElementById('activeCoachBtn');
    const lineCoachBtn = document.getElementById('lineCoachBtn');
    const activeCoachHolder = document.getElementById('activeCoachHolder');
    const lineCoachHolder = document.getElementById('lineCoachHolder');

    if (!roleButtonsContainer || !activeCoachBtn || !lineCoachBtn) {
        // The legacy header role buttons no longer exist in index.html, so this
        // early return is the LIVE path — the cross-module hook must still fire
        // here (the old monkey-patch wrapper ran its body regardless).
        notifyControllerUiUpdated(state, previousState);
        return;
    }
    
    const myUserId = getCurrentUserId();
    
    // Check each role independently - user could hold both roles
    const iAmActiveCoach = state.activeCoach?.userId === myUserId;
    const iAmLineCoach = state.lineCoach?.userId === myUserId;
    
    // Update Active Coach button
    updateRoleButton(
        activeCoachBtn, 
        activeCoachHolder, 
        state.activeCoach, 
        myUserId, 
        iAmActiveCoach,
        state.pendingHandoff?.role === 'activeCoach' && state.pendingHandoff?.requesterId === myUserId
    );
    
    // Update Line Coach button
    updateRoleButton(
        lineCoachBtn, 
        lineCoachHolder, 
        state.lineCoach, 
        myUserId, 
        iAmLineCoach,
        state.pendingHandoff?.role === 'lineCoach' && state.pendingHandoff?.requesterId === myUserId
    );
    
    // Log state changes
    const prevRoles = [];
    if (previousState?.isActiveCoach) prevRoles.push('activeCoach');
    if (previousState?.isLineCoach) prevRoles.push('lineCoach');
    const currRoles = [];
    if (state.isActiveCoach) currRoles.push('activeCoach');
    if (state.isLineCoach) currRoles.push('lineCoach');
    const prevRoleStr = prevRoles.length > 0 ? prevRoles.join('+') : 'none';
    const currRoleStr = currRoles.length > 0 ? currRoles.join('+') : 'none';
    if (prevRoleStr !== currRoleStr) {
        log(`🎮 Role changed: ${prevRoleStr} → ${currRoleStr}`);
    }
    
    // Update Play-by-Play panel state when roles change
    if (typeof window.updatePlayByPlayPanelState === 'function') {
        window.updatePlayByPlayPanelState();
    }

    // Hook for cross-module reactions (replaces the old window.updateControllerUI
    // monkey-patch in gameScreenSync.js, which can't survive ES modules).
    notifyControllerUiUpdated(state, previousState);
}

/**
 * Update a single role button's appearance
 * @param {HTMLElement} button - The button element
 * @param {HTMLElement} holderSpan - The span showing who holds the role
 * @param {object|null} roleHolder - Current holder info { userId, displayName }
 * @param {string} myUserId - Current user's ID
 * @param {boolean} iHaveRole - Whether current user has this role
 * @param {boolean} isPending - Whether there's a pending handoff request from me
 */
function updateRoleButton(button, holderSpan, roleHolder, myUserId, iHaveRole, isPending) {
    // Reset classes
    button.classList.remove('has-role', 'other-has-role', 'pending-handoff', 'role-available');
    
    if (iHaveRole) {
        // I explicitly have this role
        button.classList.add('has-role');
        holderSpan.textContent = 'You';
    } else if (isPending) {
        // I've requested this role, waiting
        button.classList.add('pending-handoff');
        holderSpan.textContent = 'Requesting...';
    } else if (roleHolder) {
        // Someone else has this role
        button.classList.add('other-has-role');
        holderSpan.textContent = roleHolder.displayName || 'Someone';
    } else {
        // Role is truly unclaimed (rare - only after timeout)
        // Show as available/claimable, not as "You"
        button.classList.add('role-available');
        holderSpan.textContent = 'Available';
    }
}

/**
 * Show/hide controller role buttons based on current screen
 * Should be called when navigating between screens
 * @param {boolean} show - Whether to show the buttons
 */
function setControllerButtonsVisible(show) {
    const roleButtonsContainer = document.getElementById('controllerRoleButtons');
    if (roleButtonsContainer) {
        roleButtonsContainer.style.display = show ? 'flex' : 'none';
    }
}

/**
 * Show handoff request as a toast notification with countdown
 * @param {object} handoff - Pending handoff data
 */
function showHandoffRequestUI(handoff) {
    const container = document.getElementById('toastContainer');
    if (!container) {
    log(`🎮 Handoff requested by ${handoff.requesterName} for ${handoff.role}`);
        return;
    }
    
    // Create unique ID for this handoff to avoid duplicates from polling
    const handoffId = `${handoff.requesterId}-${handoff.role}-${handoff.requestedAt}`;

    // Skip only the SPECIFIC handoff we already resolved locally (waiting for
    // the server to confirm). A different key is a new request and must always
    // prompt — the old boolean version of this guard could suppress a fresh
    // request entirely (G11.1 latch deadlock).
    if (handoffId === lastResolvedHandoffKey) {
        log('🎮 Handoff already resolved locally, waiting for server confirmation');
        return;
    }
    
    // If we're already showing this exact handoff, don't recreate
    if (currentHandoffId === handoffId && handoffToastElement && handoffToastElement.parentElement) {
        return;
    }
    
    // Hide any existing handoff toast (different handoff)
    hideHandoffRequestUI();
    
    currentHandoffId = handoffId;
    
    const requesterName = handoff.requesterName || 'A coach';
    const roleName = handoff.role === 'activeCoach' ? 'Play-by-Play' : 'Next Line';
    
    // Use server-calculated remaining time for accurate countdown
    // expiresInSeconds is calculated by server at response time
    const remainingSeconds = handoff.expiresInSeconds ?? handoffTimeoutSeconds;
    const remainingMs = remainingSeconds * 1000;
    const totalMs = handoffTimeoutSeconds * 1000;
    
    log(`🎮 Creating handoff toast: ${requesterName} wants ${roleName}, ${remainingSeconds}s remaining`);
    
    // Create handoff toast
    const toast = document.createElement('div');
    toast.className = 'toast toast-handoff';
    toast.id = 'handoffToast'; // Add ID for easier debugging
    toast.innerHTML = `
        <span class="toast-message"><strong>${requesterName}</strong> wants to take over <strong>${roleName}</strong></span>
        <div class="handoff-toast-buttons">
            <button class="handoff-circular-btn accept-btn" title="Accept">
                <div class="countdown-overlay"></div>
                <i class="fas fa-check"></i>
            </button>
            <button class="handoff-circular-btn deny-btn" title="Deny">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;
    
    const acceptBtn = toast.querySelector('.accept-btn');
    const denyBtn = toast.querySelector('.deny-btn');
    const countdownOverlay = toast.querySelector('.countdown-overlay');
    
    // Cleanup function - remembers THIS handoff as resolved to prevent
    // recreation until the server confirms it's gone (keyed, so a new
    // request still prompts)
    const cleanup = () => {
        log('🎮 Cleaning up handoff toast');
        clearInterval(handoffCountdownInterval);
        handoffCountdownInterval = null;
        if (toast.parentElement) {
            toast.remove();
        }
        handoffToastElement = null;
        lastResolvedHandoffKey = currentHandoffId;
        currentHandoffId = null;
    };
    
    // Accept handler
    const handleAcceptLocal = () => {
        log('🎮 Accept clicked/triggered');
        cleanup();
        handleHandoffAccept();
    };
    
    // Deny handler
    const handleDenyLocal = () => {
        log('🎮 Deny clicked');
        cleanup();
        handleHandoffDeny();
    };
    
    acceptBtn.addEventListener('click', handleAcceptLocal);
    denyBtn.addEventListener('click', handleDenyLocal);
    
    // Swipe-to-dismiss counts as Accept
    addSwipeToDismiss(toast, handleAcceptLocal);
    
    container.appendChild(toast);
    handoffToastElement = toast;
    
    // Start countdown animation using server's remaining time
    const startTime = Date.now();
    const endTime = startTime + remainingMs;
    
    const updateCountdown = () => {
        // Safety check: make sure toast still exists
        if (!toast.parentElement || !countdownOverlay) {
            clearInterval(handoffCountdownInterval);
            handoffCountdownInterval = null;
            return;
        }
        
        const now = Date.now();
        const remaining = Math.max(0, endTime - now);
        const percent = Math.min(100, Math.max(0, (remaining / totalMs) * 100));
        
        // Vertical draining animation: green fills from top to bottom as time passes
        // percent = remaining time (100% at start, 0% at end)
        // fillPercent = how much green to show (0% at start, 100% at end)
        const fillPercent = 100 - percent;
        countdownOverlay.style.background = `linear-gradient(to bottom, var(--color-success) 0%, var(--color-success) ${fillPercent}%, transparent ${fillPercent}%, transparent 100%)`;
        
        if (remaining <= 0) {
            clearInterval(handoffCountdownInterval);
            handoffCountdownInterval = null;
            // Throttled-tab guard: this timer can fire long after expiry (a
            // hidden tab's timers are coalesced/paused, then flushed on
            // re-front). By then the server has already auto-approved and
            // moved on — POSTing an accept for a gone handoff just 400s, and
            // a toast about it would be noise. Only auto-accept if our local
            // state still shows this exact handoff pending.
            const stillCurrent = getHandoffKey(controllerState.pendingHandoff) === currentHandoffId;
            if (!stillCurrent) {
                log('🎮 Countdown expired for an already-resolved handoff — cleaning up silently');
                cleanup();
                return;
            }
            // Auto-accept: show click animation then accept
            log('🎮 Countdown complete, auto-accepting');
            acceptBtn.classList.add('auto-clicked');
            setTimeout(() => {
                handleAcceptLocal();
            }, 200);
        }
    };
    
    // Initial update
    updateCountdown();
    
    // Update every 50ms for smooth animation
    handoffCountdownInterval = setInterval(updateCountdown, 50);
    
    if (typeof logEvent === 'function') {
        logEvent(`📲 ${requesterName} is requesting the ${roleName} role...`);
    }
}

/**
 * Hide handoff request UI
 */
function hideHandoffRequestUI() {
    if (handoffCountdownInterval) {
        clearInterval(handoffCountdownInterval);
        handoffCountdownInterval = null;
    }
    
    if (handoffToastElement && handoffToastElement.parentElement) {
        handoffToastElement.remove();
    }
    handoffToastElement = null;
    currentHandoffId = null;
    
    log('🎮 Handoff UI hidden');
}

/**
 * Handle click on Active Coach button
 */
async function handleActiveCoachClick() {
    const gameId = currentGameIdForPolling;
    if (!gameId) {
        showControllerToast('No active game', 'warning');
        return;
    }
    
    const myUserId = getCurrentUserId();
    const iHaveRole = controllerState.activeCoach?.userId === myUserId;
    
    if (iHaveRole) {
        // Already have role - release it (no confirmation needed)
        await releaseControllerRole(gameId, 'activeCoach');
    } else {
        // Request the role
        await claimActiveCoach(gameId);
    }
}

/**
 * Handle click on Line Coach button
 */
async function handleLineCoachClick() {
    const gameId = currentGameIdForPolling;
    if (!gameId) {
        showControllerToast('No active game', 'warning');
        return;
    }
    
    const myUserId = getCurrentUserId();
    const iHaveRole = controllerState.lineCoach?.userId === myUserId;
    
    if (iHaveRole) {
        // Already have role - release it (no confirmation needed)
        await releaseControllerRole(gameId, 'lineCoach');
    } else {
        // Request the role
        await claimLineCoach(gameId);
    }
}

/**
 * Handle Accept button click in handoff panel
 */
async function handleHandoffAccept() {
    const gameId = currentGameIdForPolling;
    if (gameId) {
        await respondToHandoff(gameId, true);
    }
}

/**
 * Handle Deny button click in handoff panel
 */
async function handleHandoffDeny() {
    const gameId = currentGameIdForPolling;
    if (gameId) {
        await respondToHandoff(gameId, false);
    }
}

/**
 * Initialize controller UI event listeners
 * Called once when the app loads
 */
function initControllerUI() {
    // Role button click handlers
    const activeCoachBtn = document.getElementById('activeCoachBtn');
    const lineCoachBtn = document.getElementById('lineCoachBtn');
    
    if (activeCoachBtn) {
        activeCoachBtn.addEventListener('click', handleActiveCoachClick);
    }
    if (lineCoachBtn) {
        lineCoachBtn.addEventListener('click', handleLineCoachClick);
    }
    
    // Handoff accept/deny handlers are attached dynamically to each toast
    
    log('🎮 Controller UI initialized');
}

// Initialize UI when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initControllerUI);
} else {
    initControllerUI();
}


// =============================================================================
// Exports
// =============================================================================

// --- ES-module exports ---
export {
    getControllerState, isActiveCoach, isLineCoach, canEditPlayByPlay,
    releaseControllerRole,
    startControllerPolling, stopControllerPolling,
    isControllerPollingActive, getPollingGameId,
    setControllerButtonsVisible, showControllerToast, dismissToast,
    getCurrentUserId, pingController,
    // Role-claim click handlers: imported by game/gameScreenEvents.js for the
    // game-screen role buttons (its old typeof-guarded bare references went
    // silently dead at C6a when this file became a module).
    handleActiveCoachClick, handleLineCoachClick,
};
// window survivor: late-bound back-edge hook (called window-qualified by
// ui/panelSystem.js, which evaluates before this file)
window.getControllerState = getControllerState;
// window survivor: late-bound back-edge hook (read window-qualified by
// game/selectLine.js, playByPlay modules)
window.isActiveCoach = isActiveCoach;
// window survivor: late-bound back-edge hook (read window-qualified by
// game/selectLine.js, playByPlay modules)
window.isLineCoach = isLineCoach;
// window survivor: late-bound back-edge hook (called window-qualified by
// game/gameScreenEvents.js and playByPlay modules)
window.canEditPlayByPlay = canEditPlayByPlay;
// window survivor: e2e test seam — Playwright scenario 04 calls
// w.startControllerPolling / w.stopControllerPolling; also called by
// screens/navigation.js (evaluates before this file; late-bound back-edge)
window.startControllerPolling = startControllerPolling;
// window survivor: e2e test seam + late-bound back-edge hook (called by
// screens/navigation.js)
window.stopControllerPolling = stopControllerPolling;
// window survivor: late-bound back-edge hook (called window-qualified by
// game/gameScreenEvents.js)
window.isControllerPollingActive = isControllerPollingActive;
// window survivor: late-bound back-edge hook (called window-qualified by
// game/gameScreenEvents.js)
window.getPollingGameId = getPollingGameId;
// window survivor: late-bound back-edge hook (called by screens/navigation.js,
// which evaluates before this file)
window.setControllerButtonsVisible = setControllerButtonsVisible;
// window survivor: e2e test seam — the Playwright suite REPLACES
// window.pingController to simulate sleep (scenario 04); the polling loop
// invokes it via window.pingController so the override takes effect. PERMANENT.
window.pingController = pingController;
// Dropped shims (zero external references found): getMyControllerRole,
// canEditLineup, claimActiveCoach, claimLineCoach, respondToHandoff,
// fetchControllerState, hideHandoffRequestUI.

