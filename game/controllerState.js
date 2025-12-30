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

// =============================================================================
// State
// =============================================================================

// Current controller state
let controllerState = {
    activeCoach: null,      // { userId, displayName, claimedAt, lastPing }
    lineCoach: null,        // { userId, displayName, claimedAt, lastPing }
    pendingHandoff: null,   // { role, requesterId, requesterName, currentHolderId, requestedAt, expiresAt }
    myRole: null,           // 'activeCoach' | 'lineCoach' | null
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
                console.log('Controller: Not authenticated');
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
                showControllerToast('You are now Active Coach', 'success');
                updateLocalControllerState({ 
                    state: data.state, 
                    myRole: 'activeCoach',
                    hasPendingHandoffForMe: false
                });
            } else if (data.status === 'handoff_requested') {
                showControllerToast('Handoff request sent...', 'info');
                updateLocalControllerState({ 
                    state: data.state, 
                    myRole: controllerState.myRole 
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
                showControllerToast('You are now Line Coach', 'success');
                updateLocalControllerState({ 
                    state: data.state, 
                    myRole: 'lineCoach',
                    hasPendingHandoffForMe: false 
                });
            } else if (data.status === 'handoff_requested') {
                showControllerToast('Handoff request sent...', 'info');
                updateLocalControllerState({ 
                    state: data.state, 
                    myRole: controllerState.myRole 
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
            showControllerToast(`Released ${roleLabel} role`, 'info');
            updateLocalControllerState({ 
                state: data.state, 
                myRole: null,
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
                showControllerToast('Handoff accepted - role transferred', 'info');
                updateLocalControllerState({ 
                    state: data.state, 
                    myRole: null,
                    hasPendingHandoffForMe: false
                });
            } else {
                showControllerToast('Handoff denied', 'info');
                updateLocalControllerState({ 
                    state: data.state, 
                    myRole: controllerState.myRole,
                    hasPendingHandoffForMe: false
                });
            }
            hideHandoffRequestUI();
            return { success: true, ...data };
        } else {
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
            
            // Update local state
            const myUserId = getCurrentUserId();
            let myRole = null;
            if (data.controllerState?.activeCoach?.userId === myUserId) {
                myRole = 'activeCoach';
            } else if (data.controllerState?.lineCoach?.userId === myUserId) {
                myRole = 'lineCoach';
            }
            
            updateLocalControllerState({
                state: data.controllerState,
                myRole: myRole,
                hasPendingHandoffForMe: data.hasPendingHandoffForMe
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
    
    controllerState = {
        activeCoach: data.state?.activeCoach || null,
        lineCoach: data.state?.lineCoach || null,
        pendingHandoff: data.state?.pendingHandoff || null,
        myRole: data.myRole !== undefined ? data.myRole : controllerState.myRole,
        hasPendingHandoffForMe: data.hasPendingHandoffForMe || false,
        lastUpdate: new Date()
    };
    
    // Trigger UI update if function exists
    if (typeof updateControllerUI === 'function') {
        updateControllerUI(controllerState, previousState);
    }
    
    // Show handoff request UI if there's a pending handoff for this user
    if (controllerState.hasPendingHandoffForMe && controllerState.pendingHandoff) {
        showHandoffRequestUI(controllerState.pendingHandoff);
    }
    
    // Adjust polling interval based on role
    if (currentGameIdForPolling) {
        adjustPollingInterval();
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
    
    // Stop any existing polling
    stopControllerPolling();
    
    currentGameIdForPolling = gameId;
    
    // Initial fetch
    fetchControllerState(gameId);
    
    // Start polling
    const interval = controllerState.myRole ? PING_INTERVAL_ACTIVE : PING_INTERVAL_IDLE;
    controllerPollIntervalId = setInterval(() => {
        if (currentGameIdForPolling) {
            pingController(currentGameIdForPolling);
        }
    }, interval);
    
    console.log(`🎮 Controller polling started for game ${gameId} (${interval}ms)`);
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
    console.log('🎮 Controller polling stopped');
}

/**
 * Adjust polling interval based on current role
 */
function adjustPollingInterval() {
    if (!controllerPollIntervalId || !currentGameIdForPolling) return;
    
    // Clear existing interval
    clearInterval(controllerPollIntervalId);
    
    // Set new interval based on role
    const interval = controllerState.myRole ? PING_INTERVAL_ACTIVE : PING_INTERVAL_IDLE;
    controllerPollIntervalId = setInterval(() => {
        if (currentGameIdForPolling) {
            pingController(currentGameIdForPolling);
        }
    }, interval);
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
// Role Checks
// =============================================================================

/**
 * Get current user's controller role
 * @returns {string|null} 'activeCoach', 'lineCoach', or null
 */
function getMyControllerRole() {
    return controllerState.myRole;
}

/**
 * Check if current user is Active Coach
 * @returns {boolean}
 */
function isActiveCoach() {
    return controllerState.myRole === 'activeCoach';
}

/**
 * Check if current user is Line Coach
 * @returns {boolean}
 */
function isLineCoach() {
    return controllerState.myRole === 'lineCoach';
}

/**
 * Check if user can edit play-by-play events
 * Allowed if: Active Coach, or no one has claimed Active Coach
 * @returns {boolean}
 */
function canEditPlayByPlay() {
    return controllerState.myRole === 'activeCoach' || !controllerState.activeCoach;
}

/**
 * Check if user can edit lineup
 * Allowed if: Line Coach, Active Coach, or no one has claimed either role
 * @returns {boolean}
 */
function canEditLineup() {
    return controllerState.myRole === 'lineCoach' || 
           controllerState.myRole === 'activeCoach' || 
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
// UI Helpers (stubs - to be implemented in Phase 6)
// =============================================================================

/**
 * Show a toast notification for controller events
 * @param {string} message - Message to display
 * @param {string} type - 'success', 'info', 'error'
 */
function showControllerToast(message, type = 'info') {
    // Use existing logEvent for now, will be replaced with proper toast in Phase 6
    if (typeof logEvent === 'function') {
        logEvent(`🎮 ${message}`);
    }
    console.log(`🎮 Controller [${type}]: ${message}`);
}

/**
 * Update controller UI elements
 * Stub - to be implemented in Phase 6
 * @param {object} state - Current controller state
 * @param {object} previousState - Previous controller state
 */
function updateControllerUI(state, previousState) {
    // Will be implemented in Phase 6
    // For now, just log state changes
    if (state.myRole !== previousState?.myRole) {
        console.log(`🎮 Role changed: ${previousState?.myRole || 'none'} → ${state.myRole || 'none'}`);
    }
}

/**
 * Show handoff request UI
 * Stub - to be implemented in Phase 6
 * @param {object} handoff - Pending handoff data
 */
function showHandoffRequestUI(handoff) {
    // Will be implemented in Phase 6 with countdown timer
    console.log(`🎮 Handoff requested by ${handoff.requesterName} for ${handoff.role}`);
    
    // For now, auto-accept after a short delay (simulating user action)
    // In Phase 6, this will show a UI with countdown
    if (typeof logEvent === 'function') {
        logEvent(`📲 ${handoff.requesterName} is requesting the ${handoff.role === 'activeCoach' ? 'Active Coach' : 'Line Coach'} role...`);
    }
}

/**
 * Hide handoff request UI
 * Stub - to be implemented in Phase 6
 */
function hideHandoffRequestUI() {
    // Will be implemented in Phase 6
    console.log('🎮 Handoff UI hidden');
}


// =============================================================================
// Exports
// =============================================================================

// State access
window.getControllerState = getControllerState;
window.getMyControllerRole = getMyControllerRole;

// Role checks
window.isActiveCoach = isActiveCoach;
window.isLineCoach = isLineCoach;
window.canEditPlayByPlay = canEditPlayByPlay;
window.canEditLineup = canEditLineup;

// Actions
window.claimActiveCoach = claimActiveCoach;
window.claimLineCoach = claimLineCoach;
window.releaseControllerRole = releaseControllerRole;
window.respondToHandoff = respondToHandoff;

// Polling
window.startControllerPolling = startControllerPolling;
window.stopControllerPolling = stopControllerPolling;
window.fetchControllerState = fetchControllerState;
window.isControllerPollingActive = isControllerPollingActive;
window.getPollingGameId = getPollingGameId;

