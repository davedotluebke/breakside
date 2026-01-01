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
    
    // Update handoff timeout from server if provided
    if (data.handoffTimeoutSeconds) {
        handoffTimeoutSeconds = data.handoffTimeoutSeconds;
    }
    
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
    
    // Handle handoff UI based on server state
    if (controllerState.hasPendingHandoffForMe && controllerState.pendingHandoff) {
        // Server says there's a pending handoff for us
        showHandoffRequestUI(controllerState.pendingHandoff);
    } else {
        // Server says no pending handoff - clear resolved flag and hide any toast
        if (handoffResolved) {
            console.log('🎮 Server confirmed handoff resolved, clearing flag');
            handoffResolved = false;
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
let handoffToastElement = null;
let currentHandoffId = null; // Track which handoff we're showing to avoid duplicates
let handoffResolved = false; // Prevent new toasts after accept/deny until server confirms

// Handoff timeout - fetched from server, fallback to 10s
let handoffTimeoutSeconds = 10;

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
    toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
    
    // Add swipe-to-dismiss functionality
    addSwipeToDismiss(toast);
    
    container.appendChild(toast);
    
    // Auto-remove after duration
    const autoRemoveTimeout = setTimeout(() => {
        dismissToast(toast);
    }, duration);
    
    // Store timeout so we can cancel it if manually dismissed
    toast.dataset.timeoutId = autoRemoveTimeout;
    
    // Also log to event log if available
    if (typeof logEvent === 'function') {
        logEvent(`🎮 ${message}`);
    }
    console.log(`🎮 Controller [${type}]: ${message}`);
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
 * Add swipe-to-dismiss functionality to a toast
 * @param {HTMLElement} toast - The toast element
 */
function addSwipeToDismiss(toast) {
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
        
        // If swiped up more than 50px, dismiss immediately (no animation flicker)
        if (deltaY < -50) {
            dismissToast(toast, true);
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
    
    // Mouse events (for desktop testing)
    toast.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
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
 * Show handoff request as a toast notification with countdown
 * @param {object} handoff - Pending handoff data
 */
function showHandoffRequestUI(handoff) {
    const container = document.getElementById('toastContainer');
    if (!container) {
        console.log(`🎮 Handoff requested by ${handoff.requesterName} for ${handoff.role}`);
        return;
    }
    
    // Don't create new toasts if we just resolved a handoff (wait for server to confirm)
    if (handoffResolved) {
        console.log('🎮 Handoff already resolved, waiting for server confirmation');
        return;
    }
    
    // Create unique ID for this handoff to avoid duplicates from polling
    const handoffId = `${handoff.requesterId}-${handoff.role}-${handoff.requestedAt}`;
    
    // If we're already showing this exact handoff, don't recreate
    if (currentHandoffId === handoffId && handoffToastElement && handoffToastElement.parentElement) {
        return;
    }
    
    // Hide any existing handoff toast (different handoff)
    hideHandoffRequestUI();
    
    currentHandoffId = handoffId;
    
    const requesterName = handoff.requesterName || 'A coach';
    const roleName = handoff.role === 'activeCoach' ? 'Play-by-Play' : 'Next Line';
    
    // Use server-provided timeout (with fallback)
    const totalMs = handoffTimeoutSeconds * 1000;
    
    console.log(`🎮 Creating handoff toast: ${requesterName} wants ${roleName}, ${handoffTimeoutSeconds}s countdown`);
    
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
    
    // Cleanup function - marks handoff as resolved to prevent recreation
    const cleanup = () => {
        console.log('🎮 Cleaning up handoff toast');
        clearInterval(handoffCountdownInterval);
        handoffCountdownInterval = null;
        if (toast.parentElement) {
            toast.remove();
        }
        handoffToastElement = null;
        currentHandoffId = null;
        handoffResolved = true; // Prevent recreation until server confirms no pending handoff
    };
    
    // Accept handler
    const handleAcceptLocal = () => {
        console.log('🎮 Accept clicked/triggered');
        cleanup();
        handleHandoffAccept();
    };
    
    // Deny handler
    const handleDenyLocal = () => {
        console.log('🎮 Deny clicked');
        cleanup();
        handleHandoffDeny();
    };
    
    acceptBtn.addEventListener('click', handleAcceptLocal);
    denyBtn.addEventListener('click', handleDenyLocal);
    
    // Swipe-to-dismiss counts as Accept
    addHandoffSwipeToDismiss(toast, handleAcceptLocal);
    
    container.appendChild(toast);
    handoffToastElement = toast;
    
    // Start countdown animation (client-side, starts fresh each time)
    const startTime = Date.now();
    const endTime = startTime + totalMs;
    
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
        countdownOverlay.style.background = `linear-gradient(to bottom, #28a745 0%, #28a745 ${fillPercent}%, transparent ${fillPercent}%, transparent 100%)`;
        
        if (remaining <= 0) {
            // Auto-accept: show click animation then accept
            console.log('🎮 Countdown complete, auto-accepting');
            clearInterval(handoffCountdownInterval);
            handoffCountdownInterval = null;
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
 * Add swipe-to-dismiss for handoff toast (swipe = accept)
 * @param {HTMLElement} toast - The toast element
 * @param {Function} onAccept - Callback when swiped away
 */
function addHandoffSwipeToDismiss(toast, onAccept) {
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
        
        // Only allow swiping up
        if (deltaY < 0) {
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
        
        // If swiped up more than 50px, accept
        if (deltaY < -50) {
            onAccept();
        } else {
            toast.style.transform = '';
            toast.style.opacity = '';
        }
    };
    
    toast.addEventListener('touchstart', handleStart, { passive: true });
    toast.addEventListener('touchmove', handleMove, { passive: false });
    toast.addEventListener('touchend', handleEnd);
    toast.addEventListener('touchcancel', handleEnd);
    
    toast.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
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

