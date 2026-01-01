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
// UI Helpers (Phase 6 Implementation)
// =============================================================================

// Handoff countdown state
let handoffCountdownInterval = null;
let handoffCountdownSeconds = 5;

/**
 * Show a toast notification for controller events
 * @param {string} message - Message to display
 * @param {string} type - 'success', 'info', 'warning', 'error'
 * @param {number} duration - Duration in ms (default 4000)
 */
function showControllerToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) {
        console.log(`🎮 Controller [${type}]: ${message}`);
        return;
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
    toast.querySelector('.toast-close').addEventListener('click', () => {
        dismissToast(toast);
    });
    
    // Add swipe-to-dismiss functionality
    addSwipeToDismiss(toast);
    
    container.appendChild(toast);
    
    // Auto-remove after duration
    const autoRemoveTimeout = setTimeout(() => {
        if (toast.parentElement) {
            dismissToast(toast);
        }
    }, duration);
    
    // Store timeout so we can clear it if manually dismissed
    toast._autoRemoveTimeout = autoRemoveTimeout;
    
    // Also log to event log if available
    if (typeof logEvent === 'function') {
        logEvent(`🎮 ${message}`);
    }
    console.log(`🎮 Controller [${type}]: ${message}`);
}

/**
 * Dismiss a toast with animation
 * @param {HTMLElement} toast - The toast element
 * @param {string} direction - 'up', 'left', or 'right'
 */
function dismissToast(toast, direction = 'up') {
    if (!toast || !toast.parentElement) return;
    
    // Clear auto-remove timeout
    if (toast._autoRemoveTimeout) {
        clearTimeout(toast._autoRemoveTimeout);
    }
    
    // Add appropriate animation class
    if (direction === 'left') {
        toast.classList.add('toast-swipe-left');
    } else if (direction === 'right') {
        toast.classList.add('toast-swipe-right');
    } else {
        toast.classList.add('toast-hiding');
    }
    
    // Remove after animation
    setTimeout(() => toast.remove(), 300);
}

/**
 * Add swipe-to-dismiss touch handlers to a toast
 * @param {HTMLElement} toast - The toast element
 */
function addSwipeToDismiss(toast) {
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let isDragging = false;
    let isHorizontalSwipe = null; // null = undecided, true = horizontal, false = vertical
    
    // Use capture phase so we get events before child elements (like the close button)
    toast.addEventListener('touchstart', (e) => {
        // Get touch position
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        currentX = 0;
        isDragging = true;
        isHorizontalSwipe = null;
        toast.classList.add('toast-swiping');
    }, { passive: true, capture: true });
    
    toast.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        
        const deltaX = e.touches[0].clientX - startX;
        const deltaY = e.touches[0].clientY - startY;
        
        // Decide direction on first significant movement
        if (isHorizontalSwipe === null && (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10)) {
            isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY);
        }
        
        // Only handle horizontal swipes
        if (isHorizontalSwipe) {
            e.preventDefault(); // Prevent page scroll
            e.stopPropagation(); // Prevent child elements from getting this
            currentX = deltaX;
            const opacity = Math.max(0.3, 1 - Math.abs(deltaX) / 200);
            toast.style.transform = `translateX(${deltaX}px)`;
            toast.style.opacity = opacity;
        }
    }, { passive: false, capture: true }); // Must be non-passive to call preventDefault
    
    toast.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        
        const wasSwiping = isHorizontalSwipe;
        isDragging = false;
        isHorizontalSwipe = null;
        toast.classList.remove('toast-swiping');
        
        // If swiped far enough, dismiss
        const threshold = 80;
        if (Math.abs(currentX) > threshold) {
            e.preventDefault();
            e.stopPropagation();
            dismissToast(toast, currentX > 0 ? 'right' : 'left');
        } else if (wasSwiping) {
            // Snap back (was swiping but didn't meet threshold)
            toast.style.transform = '';
            toast.style.opacity = '';
        }
        // If not swiping, let the event through for close button clicks
    }, { passive: false, capture: true });
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
        return;
    }
    
    const myUserId = getCurrentUserId();
    
    // Update Active Coach button
    updateRoleButton(
        activeCoachBtn, 
        activeCoachHolder, 
        state.activeCoach, 
        myUserId, 
        state.myRole === 'activeCoach',
        state.pendingHandoff?.role === 'activeCoach' && state.pendingHandoff?.requesterId === myUserId
    );
    
    // Update Line Coach button
    updateRoleButton(
        lineCoachBtn, 
        lineCoachHolder, 
        state.lineCoach, 
        myUserId, 
        state.myRole === 'lineCoach',
        state.pendingHandoff?.role === 'lineCoach' && state.pendingHandoff?.requesterId === myUserId
    );
    
    // Log state changes
    if (state.myRole !== previousState?.myRole) {
        console.log(`🎮 Role changed: ${previousState?.myRole || 'none'} → ${state.myRole || 'none'}`);
    }
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
    button.classList.remove('has-role', 'other-has-role', 'pending-handoff');
    
    if (iHaveRole) {
        // I have this role
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
        // Role is available
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
 * Show handoff request UI with countdown timer
 * @param {object} handoff - Pending handoff data
 */
function showHandoffRequestUI(handoff) {
    const panel = document.getElementById('handoffPanel');
    const requesterNameSpan = document.getElementById('handoffRequesterName');
    const roleNameSpan = document.getElementById('handoffRoleName');
    const countdownSecondsSpan = document.getElementById('countdownSeconds');
    const countdownBar = document.getElementById('countdownBar');
    
    if (!panel || !requesterNameSpan || !roleNameSpan) {
        console.log(`🎮 Handoff requested by ${handoff.requesterName} for ${handoff.role}`);
        return;
    }
    
    // Set content
    requesterNameSpan.textContent = handoff.requesterName || 'A coach';
    roleNameSpan.textContent = handoff.role === 'activeCoach' ? 'Play-by-Play' : 'Next Line';
    
    // Calculate remaining time
    const expiresAt = new Date(handoff.expiresAt);
    const now = new Date();
    handoffCountdownSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
    
    // Show panel and hide header
    panel.style.display = 'block';
    document.body.classList.add('handoff-active');
    
    // Start countdown
    if (handoffCountdownInterval) {
        clearInterval(handoffCountdownInterval);
    }
    
    const startSeconds = handoffCountdownSeconds;
    updateCountdownDisplay(countdownSecondsSpan, countdownBar, handoffCountdownSeconds, startSeconds);
    
    handoffCountdownInterval = setInterval(() => {
        handoffCountdownSeconds--;
        updateCountdownDisplay(countdownSecondsSpan, countdownBar, handoffCountdownSeconds, startSeconds);
        
        if (handoffCountdownSeconds <= 0) {
            clearInterval(handoffCountdownInterval);
            handoffCountdownInterval = null;
            // Auto-accept will be handled by server/polling
        }
    }, 1000);
    
    if (typeof logEvent === 'function') {
        logEvent(`📲 ${handoff.requesterName} is requesting the ${handoff.role === 'activeCoach' ? 'Play-by-Play' : 'Next Line'} role...`);
    }
}

/**
 * Update the countdown display
 * @param {HTMLElement} secondsSpan - The span showing seconds remaining
 * @param {HTMLElement} bar - The progress bar element
 * @param {number} seconds - Seconds remaining
 * @param {number} startSeconds - Starting seconds for percentage calculation
 */
function updateCountdownDisplay(secondsSpan, bar, seconds, startSeconds) {
    if (secondsSpan) {
        secondsSpan.textContent = seconds;
    }
    if (bar) {
        const percentage = (seconds / startSeconds) * 100;
        bar.style.width = `${percentage}%`;
    }
}

/**
 * Hide handoff request UI
 */
function hideHandoffRequestUI() {
    const panel = document.getElementById('handoffPanel');
    if (panel) {
        panel.style.display = 'none';
    }
    document.body.classList.remove('handoff-active');
    
    if (handoffCountdownInterval) {
        clearInterval(handoffCountdownInterval);
        handoffCountdownInterval = null;
    }
    
    console.log('🎮 Handoff UI hidden');
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
    
    if (controllerState.myRole === 'activeCoach') {
        // Already have role - offer to release
        if (confirm('Release Play-by-Play control?')) {
            await releaseControllerRole(gameId, 'activeCoach');
        }
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
    
    if (controllerState.myRole === 'lineCoach') {
        // Already have role - offer to release
        if (confirm('Release Next Line control?')) {
            await releaseControllerRole(gameId, 'lineCoach');
        }
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
    
    // Handoff panel button handlers
    const acceptBtn = document.getElementById('handoffAcceptBtn');
    const denyBtn = document.getElementById('handoffDenyBtn');
    
    if (acceptBtn) {
        acceptBtn.addEventListener('click', handleHandoffAccept);
    }
    if (denyBtn) {
        denyBtn.addEventListener('click', handleHandoffDeny);
    }
    
    console.log('🎮 Controller UI initialized');
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

// UI (Phase 6)
window.setControllerButtonsVisible = setControllerButtonsVisible;
window.showControllerToast = showControllerToast;
window.hideHandoffRequestUI = hideHandoffRequestUI;

