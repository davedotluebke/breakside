/*
 * Panel System - Resize, Pin, and Min/Max Logic
 * Phase 6b: Panel Container Foundation
 * 
 * This module provides the core panel management functionality for the in-game UI.
 * Each panel can be:
 * - Minimized (collapsed to title bar only)
 * - Maximized (expanded to show full content)
 * - Pinned (locked to current size, survives auto-resize behaviors)
 * - Resized via drag handle
 * 
 * Panel state is saved to localStorage per-client.
 */

// =============================================================================
// Panel State Management
// =============================================================================

const PANEL_STATE_KEY = 'breakside_panel_states';

// Default panel states
const DEFAULT_PANEL_STATES = {
    header: { minimized: false, pinned: true, hidden: false },
    roleButtons: { minimized: false, pinned: true, hidden: false },
    playByPlay: { minimized: true, pinned: false, hidden: false },
    selectLine: { minimized: false, pinned: false, hidden: false },
    gameEvents: { minimized: true, pinned: false, hidden: false },
    follow: { minimized: false, pinned: false, hidden: false }
};

// Current panel states
let panelStates = { ...DEFAULT_PANEL_STATES };

/**
 * Load panel states from localStorage
 */
function loadPanelStates() {
    try {
        const saved = localStorage.getItem(PANEL_STATE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            panelStates = { ...DEFAULT_PANEL_STATES, ...parsed };
        }
    } catch (e) {
        console.warn('Failed to load panel states:', e);
        panelStates = { ...DEFAULT_PANEL_STATES };
    }
}

/**
 * Save panel states to localStorage
 */
function savePanelStates() {
    try {
        localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(panelStates));
    } catch (e) {
        console.warn('Failed to save panel states:', e);
    }
}

/**
 * Get state for a specific panel
 * @param {string} panelId - Panel identifier
 * @returns {object} Panel state
 */
function getPanelState(panelId) {
    return panelStates[panelId] || { minimized: false, pinned: false, hidden: false };
}

/**
 * Set state for a specific panel
 * @param {string} panelId - Panel identifier
 * @param {object} state - State properties to update
 */
function setPanelState(panelId, state) {
    panelStates[panelId] = { ...getPanelState(panelId), ...state };
    savePanelStates();
    applyPanelState(panelId);
}

// =============================================================================
// Panel DOM Operations
// =============================================================================

/**
 * Get panel element by ID
 * @param {string} panelId - Panel identifier
 * @returns {HTMLElement|null}
 */
function getPanelElement(panelId) {
    return document.getElementById(`panel-${panelId}`);
}

/**
 * Apply current state to a panel's DOM
 * @param {string} panelId - Panel identifier
 */
function applyPanelState(panelId) {
    const panel = getPanelElement(panelId);
    if (!panel) return;
    
    const state = getPanelState(panelId);
    
    // Apply minimized state
    panel.classList.toggle('minimized', state.minimized);
    panel.classList.toggle('maximized', !state.minimized);
    
    // Apply pinned state
    panel.classList.toggle('pinned', state.pinned);
    
    // Apply hidden state
    panel.classList.toggle('hidden', state.hidden);
    
    // Update pin button appearance
    const pinBtn = panel.querySelector('.panel-pin-btn');
    if (pinBtn) {
        pinBtn.classList.toggle('active', state.pinned);
        pinBtn.title = state.pinned ? 'Unpin panel' : 'Pin panel';
    }
    
    // Update expand/collapse button
    const expandBtn = panel.querySelector('.panel-expand-btn');
    if (expandBtn) {
        const icon = expandBtn.querySelector('i');
        if (icon) {
            icon.className = state.minimized ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
        }
        expandBtn.title = state.minimized ? 'Expand panel' : 'Collapse panel';
    }
}

/**
 * Apply all panel states to DOM
 */
function applyAllPanelStates() {
    Object.keys(panelStates).forEach(panelId => {
        applyPanelState(panelId);
    });
}

// =============================================================================
// Panel Actions
// =============================================================================

/**
 * Toggle panel minimized state
 * @param {string} panelId - Panel identifier
 */
function togglePanelMinimized(panelId) {
    const state = getPanelState(panelId);
    setPanelState(panelId, { minimized: !state.minimized });
}

/**
 * Minimize a panel
 * @param {string} panelId - Panel identifier
 */
function minimizePanel(panelId) {
    setPanelState(panelId, { minimized: true });
}

/**
 * Maximize a panel
 * @param {string} panelId - Panel identifier
 * @param {boolean} minimizeOthers - If true, minimize non-pinned panels
 */
function maximizePanel(panelId, minimizeOthers = true) {
    if (minimizeOthers) {
        // Minimize all non-pinned panels except the one being maximized
        Object.keys(panelStates).forEach(id => {
            if (id !== panelId && id !== 'header' && id !== 'roleButtons') {
                const state = getPanelState(id);
                if (!state.pinned) {
                    setPanelState(id, { minimized: true });
                }
            }
        });
    }
    setPanelState(panelId, { minimized: false });
}

/**
 * Toggle panel pinned state
 * @param {string} panelId - Panel identifier
 */
function togglePanelPinned(panelId) {
    const state = getPanelState(panelId);
    setPanelState(panelId, { pinned: !state.pinned });
}

/**
 * Set panel visibility
 * @param {string} panelId - Panel identifier
 * @param {boolean} visible - Whether panel should be visible
 */
function setPanelVisible(panelId, visible) {
    setPanelState(panelId, { hidden: !visible });
}

// =============================================================================
// Event Handlers
// =============================================================================

/**
 * Handle double-tap on title bar to toggle min/max
 * @param {string} panelId - Panel identifier
 */
let lastTapTime = {};
function handleTitleBarTap(panelId) {
    const now = Date.now();
    const lastTap = lastTapTime[panelId] || 0;
    
    if (now - lastTap < 300) {
        // Double tap detected
        togglePanelMinimized(panelId);
        lastTapTime[panelId] = 0;
    } else {
        lastTapTime[panelId] = now;
    }
}

/**
 * Handle pin button click
 * @param {Event} e - Click event
 * @param {string} panelId - Panel identifier
 */
function handlePinClick(e, panelId) {
    e.stopPropagation();
    togglePanelPinned(panelId);
}

/**
 * Handle expand/collapse button click
 * @param {Event} e - Click event
 * @param {string} panelId - Panel identifier
 */
function handleExpandClick(e, panelId) {
    e.stopPropagation();
    togglePanelMinimized(panelId);
}

// =============================================================================
// Panel Creation Helpers
// =============================================================================

/**
 * Create a panel title bar element
 * @param {object} options - Title bar options
 * @param {string} options.panelId - Panel identifier
 * @param {string} options.title - Panel title text
 * @param {boolean} options.showDragHandle - Show drag handle
 * @param {boolean} options.showPinBtn - Show pin button
 * @param {boolean} options.showExpandBtn - Show expand/collapse button
 * @returns {HTMLElement}
 */
function createPanelTitleBar(options) {
    const { panelId, title, showDragHandle = true, showPinBtn = true, showExpandBtn = true } = options;
    
    const titleBar = document.createElement('div');
    titleBar.className = 'panel-title-bar';
    
    // Drag handle
    if (showDragHandle) {
        const dragHandle = document.createElement('div');
        dragHandle.className = 'panel-drag-handle';
        dragHandle.innerHTML = `
            <div class="panel-drag-handle-line"></div>
            <div class="panel-drag-handle-line"></div>
            <div class="panel-drag-handle-line"></div>
        `;
        titleBar.appendChild(dragHandle);
    }
    
    // Title
    const titleEl = document.createElement('span');
    titleEl.className = 'panel-title';
    titleEl.textContent = title;
    titleBar.appendChild(titleEl);
    
    // Subtitle (for minimized state info)
    const subtitleEl = document.createElement('span');
    subtitleEl.className = 'panel-subtitle';
    subtitleEl.id = `panel-${panelId}-subtitle`;
    titleBar.appendChild(subtitleEl);
    
    // Actions container
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    
    // Pin button
    if (showPinBtn) {
        const pinBtn = document.createElement('button');
        pinBtn.className = 'panel-action-btn panel-pin-btn';
        pinBtn.title = 'Pin panel';
        pinBtn.innerHTML = '<i class="fas fa-thumbtack"></i>';
        pinBtn.onclick = (e) => handlePinClick(e, panelId);
        actions.appendChild(pinBtn);
    }
    
    // Expand/collapse button
    if (showExpandBtn) {
        const expandBtn = document.createElement('button');
        expandBtn.className = 'panel-action-btn panel-expand-btn';
        expandBtn.title = 'Collapse panel';
        expandBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
        expandBtn.onclick = (e) => handleExpandClick(e, panelId);
        actions.appendChild(expandBtn);
    }
    
    titleBar.appendChild(actions);
    
    // Double-tap handler for title bar
    titleBar.addEventListener('click', () => handleTitleBarTap(panelId));
    
    return titleBar;
}

/**
 * Create a stub panel content (placeholder during development)
 * @param {object} options - Stub options
 * @param {string} options.icon - FontAwesome icon class
 * @param {string} options.text - Description text
 * @param {string} options.legacyScreen - ID of legacy screen to link to
 * @param {string} options.legacyLabel - Button label for legacy link
 * @returns {HTMLElement}
 */
function createPanelStub(options) {
    const { icon = 'fa-cog', text = 'Panel content coming soon...', legacyScreen, legacyLabel = 'Use Old Screen' } = options;
    
    const stub = document.createElement('div');
    stub.className = 'panel-stub';
    
    stub.innerHTML = `
        <div class="panel-stub-icon">
            <i class="fas ${icon}"></i>
        </div>
        <div class="panel-stub-text">${text}</div>
        ${legacyScreen ? `
            <button class="panel-stub-action" data-legacy-screen="${legacyScreen}">
                ${legacyLabel} <i class="fas fa-arrow-right"></i>
            </button>
        ` : ''}
    `;
    
    // Wire up legacy screen button
    const legacyBtn = stub.querySelector('.panel-stub-action');
    if (legacyBtn) {
        legacyBtn.addEventListener('click', () => {
            const screenId = legacyBtn.dataset.legacyScreen;
            if (screenId && typeof showScreen === 'function') {
                // Hide game screen container and show legacy screen
                hideGameScreen();
                showScreen(screenId);
            }
        });
    }
    
    return stub;
}

/**
 * Create a complete panel element
 * @param {object} options - Panel options
 * @param {string} options.id - Panel identifier (e.g., 'playByPlay')
 * @param {string} options.className - Additional class names
 * @param {string} options.title - Panel title
 * @param {boolean} options.showDragHandle - Show drag handle in title bar
 * @param {boolean} options.showPinBtn - Show pin button
 * @param {boolean} options.showExpandBtn - Show expand/collapse button
 * @param {HTMLElement|null} options.content - Content element (or null for stub)
 * @param {object} options.stubOptions - Options for stub if no content provided
 * @returns {HTMLElement}
 */
function createPanel(options) {
    const {
        id,
        className = '',
        title,
        showDragHandle = true,
        showPinBtn = true,
        showExpandBtn = true,
        content = null,
        stubOptions = {}
    } = options;
    
    const panel = document.createElement('div');
    panel.id = `panel-${id}`;
    panel.className = `game-panel panel-${id} ${className}`.trim();
    
    // Add title bar
    const titleBar = createPanelTitleBar({
        panelId: id,
        title,
        showDragHandle,
        showPinBtn,
        showExpandBtn
    });
    panel.appendChild(titleBar);
    
    // Add content area
    const contentArea = document.createElement('div');
    contentArea.className = 'panel-content';
    contentArea.id = `panel-${id}-content`;
    
    if (content) {
        contentArea.appendChild(content);
    } else {
        contentArea.appendChild(createPanelStub(stubOptions));
    }
    
    panel.appendChild(contentArea);
    
    return panel;
}

// =============================================================================
// Game Screen Management
// =============================================================================

/**
 * Show the game screen container
 */
function showGameScreen() {
    const container = document.getElementById('gameScreenContainer');
    if (container) {
        container.classList.add('active');
        loadPanelStates();
        applyAllPanelStates();
    }
}

/**
 * Hide the game screen container
 */
function hideGameScreen() {
    const container = document.getElementById('gameScreenContainer');
    if (container) {
        container.classList.remove('active');
    }
}

/**
 * Check if game screen is currently visible
 * @returns {boolean}
 */
function isGameScreenVisible() {
    const container = document.getElementById('gameScreenContainer');
    return container && container.classList.contains('active');
}

// =============================================================================
// Role-Based Panel Behavior
// =============================================================================

/**
 * Update panels based on user's controller role
 * @param {string|null} role - 'activeCoach', 'lineCoach', or null
 */
function updatePanelsForRole(role) {
    const isActiveCoach = role === 'activeCoach';
    const isLineCoach = role === 'lineCoach';
    const hasRole = isActiveCoach || isLineCoach;
    
    // Role buttons panel - hide for viewers
    const isViewer = typeof getControllerState === 'function' && 
                     !getControllerState().activeCoach && 
                     !getControllerState().lineCoach;
    // For now, show role buttons for all coaches
    setPanelVisible('roleButtons', true);
    
    // Play-by-Play panel disabled if not Active Coach
    const playByPlayPanel = getPanelElement('playByPlay');
    if (playByPlayPanel) {
        playByPlayPanel.classList.toggle('disabled', !isActiveCoach && hasRole);
    }
    
    // Select Line panel - Line Coach keeps it open during points
    // (This auto-behavior will be implemented in Step 7)
    
    // Game Events panel disabled during points, enabled between points for Active Coach
    const gameEventsPanel = getPanelElement('gameEvents');
    if (gameEventsPanel) {
        gameEventsPanel.classList.toggle('disabled', !isActiveCoach && hasRole);
    }
    
    // Follow panel - maximized for viewers or coaches without roles
    // But respect user's explicit choice if they've minimized or pinned it
    if (!hasRole) {
        const followState = getPanelState('follow');
        if (!followState.pinned && !followState.minimized) {
            maximizePanel('follow', false);
        }
    }
}

/**
 * Update panels based on game state (during point vs between points)
 * @param {boolean} duringPoint - Whether a point is currently in progress
 */
function updatePanelsForGameState(duringPoint) {
    const role = typeof getMyControllerRole === 'function' ? getMyControllerRole() : null;
    const isActiveCoach = role === 'activeCoach';
    
    // Play-by-Play panel
    const playByPlayState = getPanelState('playByPlay');
    if (!playByPlayState.pinned) {
        if (duringPoint && isActiveCoach) {
            // Auto-maximize when point starts, if Active Coach
            maximizePanel('playByPlay', false);
        } else if (!duringPoint) {
            // Auto-minimize when point ends
            minimizePanel('playByPlay');
        }
    }
    
    // Select Line panel
    const selectLineState = getPanelState('selectLine');
    if (!selectLineState.pinned && isActiveCoach) {
        if (duringPoint) {
            // Auto-minimize when point starts for Active Coach
            minimizePanel('selectLine');
        } else {
            // Auto-maximize when point ends
            maximizePanel('selectLine', false);
        }
    }
    
    // Game Events panel - disabled during points
    const gameEventsPanel = getPanelElement('gameEvents');
    if (gameEventsPanel) {
        gameEventsPanel.classList.toggle('disabled', duringPoint);
        if (duringPoint && !getPanelState('gameEvents').pinned) {
            minimizePanel('gameEvents');
        }
    }
}

// =============================================================================
// Panel Subtitle Updates
// =============================================================================

/**
 * Update the subtitle for a panel (shown when minimized)
 * @param {string} panelId - Panel identifier
 * @param {string} text - Subtitle text
 */
function setPanelSubtitle(panelId, text) {
    const subtitle = document.getElementById(`panel-${panelId}-subtitle`);
    if (subtitle) {
        subtitle.textContent = text || '';
    }
}

// =============================================================================
// Initialize Panel System
// =============================================================================

/**
 * Initialize the panel system
 * Called once when the app loads
 */
function initPanelSystem() {
    loadPanelStates();
    console.log('🎛️ Panel system initialized');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPanelSystem);
} else {
    initPanelSystem();
}

// =============================================================================
// Exports
// =============================================================================

// State management
window.getPanelState = getPanelState;
window.setPanelState = setPanelState;
window.loadPanelStates = loadPanelStates;
window.savePanelStates = savePanelStates;

// Panel actions
window.togglePanelMinimized = togglePanelMinimized;
window.minimizePanel = minimizePanel;
window.maximizePanel = maximizePanel;
window.togglePanelPinned = togglePanelPinned;
window.setPanelVisible = setPanelVisible;
window.setPanelSubtitle = setPanelSubtitle;

// Panel creation
window.createPanelTitleBar = createPanelTitleBar;
window.createPanelStub = createPanelStub;
window.createPanel = createPanel;

// Game screen management
window.showGameScreen = showGameScreen;
window.hideGameScreen = hideGameScreen;
window.isGameScreenVisible = isGameScreenVisible;

// Role and state updates
window.updatePanelsForRole = updatePanelsForRole;
window.updatePanelsForGameState = updatePanelsForGameState;

