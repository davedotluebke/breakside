/*
 * Panel System - Resize, Pin, and Min/Max Logic
 * Phase 6b: Panel Container Foundation
 * 
 * This module provides the core panel management functionality for the in-game UI.
 * Each panel can be:
 * - Minimized (collapsed to title bar only)
 * - Maximized (expanded to show full content)
 * - Pinned (locked to current size, survives auto-resize behaviors)
 * - Resized via drag handle (draggable title bars)
 * 
 * Panel state is saved to localStorage per-client.
 */

// =============================================================================
// Panel State Management
// =============================================================================

const PANEL_STATE_KEY = 'breakside_panel_states';

// Minimum height for panels (title bar height only)
const MIN_PANEL_HEIGHT = 44;

// Default expanded height when un-minimizing a panel that has no saved height
const DEFAULT_EXPANDED_HEIGHT = 150;

// Panel IDs in order (top to bottom)
const PANEL_ORDER = ['header', 'roleButtons', 'playByPlay', 'selectLine', 'gameEvents', 'follow'];

// Panels that can be resized via drag (these have draggable title bars)
// Dragging a title bar resizes that panel and the one above it
const DRAGGABLE_PANELS = ['selectLine', 'gameEvents', 'follow'];

// Panels that CAN be resized (excludes fixed-height header and roleButtons)
const RESIZABLE_PANELS = ['playByPlay', 'selectLine', 'gameEvents', 'follow'];

// Default panel states
// height: null = natural/flexible height
// height: MIN_PANEL_HEIGHT = "minimized" (title bar only)
// height: number > MIN_PANEL_HEIGHT = explicit expanded height
// expandedHeight: saved height to restore when un-minimizing
const DEFAULT_PANEL_STATES = {
    header: { pinned: true, hidden: false, height: null, expandedHeight: null },
    roleButtons: { pinned: true, hidden: false, height: null, expandedHeight: null },
    playByPlay: { pinned: false, hidden: false, height: MIN_PANEL_HEIGHT, expandedHeight: null },
    selectLine: { pinned: false, hidden: false, height: null, expandedHeight: null },
    gameEvents: { pinned: false, hidden: false, height: MIN_PANEL_HEIGHT, expandedHeight: null },
    follow: { pinned: false, hidden: false, height: null, expandedHeight: null }
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
    return panelStates[panelId] || { pinned: false, hidden: false, height: null, expandedHeight: null };
}

/**
 * Check if a panel is currently minimized (height = title bar only)
 * @param {string} panelId - Panel identifier
 * @returns {boolean}
 */
function isPanelMinimized(panelId) {
    const state = getPanelState(panelId);
    return state.height !== null && state.height <= MIN_PANEL_HEIGHT;
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
    // Update which panel should expand (may have changed due to minimize/maximize)
    updateExpandingPanel();
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
    const isFollowPanel = panelId === 'follow';
    const isMinimized = isPanelMinimized(panelId);
    
    // Apply pinned state
    panel.classList.toggle('pinned', state.pinned);
    
    // Apply hidden state
    panel.classList.toggle('hidden', state.hidden);
    
    // Apply height
    // height: null = natural/flexible
    // height: MIN_PANEL_HEIGHT = minimized (title bar only)
    // height: number > MIN_PANEL_HEIGHT = explicit expanded height
    if (state.height !== null) {
        // Explicit height set
        panel.style.height = `${state.height}px`;
        panel.style.flex = '0 0 auto';
    } else if (isFollowPanel) {
        // Follow panel with no explicit height: fill remaining space
        panel.style.height = '';
        panel.style.flex = '1 1 auto';
    } else {
        // Other panels with no explicit height: natural height
        panel.style.height = '';
        panel.style.flex = '0 0 auto';
    }
    
    // Update pin button appearance
    const pinBtn = panel.querySelector('.panel-pin-btn');
    if (pinBtn) {
        pinBtn.classList.toggle('active', state.pinned);
        pinBtn.title = state.pinned ? 'Unpin panel' : 'Pin panel';
    }
    
    // Update expand/collapse button icon based on minimized state
    const expandBtn = panel.querySelector('.panel-expand-btn');
    if (expandBtn) {
        const icon = expandBtn.querySelector('i');
        if (icon) {
            icon.className = isMinimized ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
        }
        expandBtn.title = isMinimized ? 'Expand panel' : 'Collapse panel';
    }
}

/**
 * Apply all panel states to DOM
 */
function applyAllPanelStates() {
    Object.keys(panelStates).forEach(panelId => {
        applyPanelState(panelId);
    });
    // After applying individual states, update which panel should expand
    updateExpandingPanel();
}

/**
 * Determine which panel should expand to fill remaining space
 * Normally this is Follow, but if Follow is minimized, it's the last non-minimized panel
 */
function updateExpandingPanel() {
    const followPanel = getPanelElement('follow');
    const followMinimized = isPanelMinimized('follow');
    const followState = getPanelState('follow');
    
    // If Follow is not minimized and has no explicit height, it handles expansion
    if (!followMinimized && followState.height === null) {
        // Ensure Follow has flex-grow and expanding class
        if (followPanel) {
            followPanel.style.flex = '1 1 auto';
            followPanel.classList.add('expanding');
        }
        // Remove expanding from other panels
        ['playByPlay', 'selectLine', 'gameEvents'].forEach(id => {
            const panel = getPanelElement(id);
            if (panel) {
                panel.classList.remove('expanding');
            }
        });
        return;
    }
    
    // Follow is minimized or has explicit height - remove its expanding class
    if (followPanel) {
        followPanel.classList.remove('expanding');
    }
    
    // Find the last non-minimized panel without explicit height to expand
    // Order from bottom up (excluding Follow): gameEvents, selectLine, playByPlay
    const expandOrder = ['gameEvents', 'selectLine', 'playByPlay'];
    let expandingPanelId = null;
    
    for (const panelId of expandOrder) {
        const state = getPanelState(panelId);
        const isMinimized = isPanelMinimized(panelId);
        if (!isMinimized && !state.hidden) {
            // This panel should expand if it doesn't have explicit height > MIN
            // (panels with explicit expanded heights keep those heights)
            if (state.height === null || state.height <= MIN_PANEL_HEIGHT) {
                expandingPanelId = panelId;
                break;
            }
        }
    }
    
    // Apply expanding class and flex-grow to the expanding panel, remove from others
    expandOrder.forEach(id => {
        const panel = getPanelElement(id);
        if (panel) {
            if (id === expandingPanelId) {
                panel.style.flex = '1 1 auto';
                panel.style.height = ''; // Clear explicit height to allow flex
                panel.classList.add('expanding');
            } else {
                panel.classList.remove('expanding');
            }
        }
    });
}

// =============================================================================
// Panel Actions
// =============================================================================

/**
 * Toggle panel minimized state
 * Minimized = height set to MIN_PANEL_HEIGHT (title bar only)
 * Expanded = height restored to expandedHeight or default
 * @param {string} panelId - Panel identifier
 */
function togglePanelMinimized(panelId) {
    if (isPanelMinimized(panelId)) {
        maximizePanel(panelId, false);
    } else {
        minimizePanel(panelId);
    }
}

/**
 * Minimize a panel (set height to title bar only)
 * @param {string} panelId - Panel identifier
 */
function minimizePanel(panelId) {
    const panel = getPanelElement(panelId);
    const state = getPanelState(panelId);
    
    // Save current height before minimizing (so we can restore it later)
    let currentHeight = state.height;
    if (currentHeight === null && panel) {
        // Measure actual height if not explicitly set
        currentHeight = panel.getBoundingClientRect().height;
    }
    
    // Only save expandedHeight if current height is actually expanded
    const expandedHeight = (currentHeight && currentHeight > MIN_PANEL_HEIGHT) 
        ? currentHeight 
        : state.expandedHeight;
    
    setPanelState(panelId, { 
        height: MIN_PANEL_HEIGHT,
        expandedHeight: expandedHeight
    });
}

/**
 * Maximize a panel (restore to expanded height)
 * @param {string} panelId - Panel identifier
 * @param {boolean} minimizeOthers - If true, minimize non-pinned panels
 */
function maximizePanel(panelId, minimizeOthers = true) {
    if (minimizeOthers) {
        // Minimize all non-pinned resizable panels except the one being maximized
        RESIZABLE_PANELS.forEach(id => {
            if (id !== panelId) {
                const state = getPanelState(id);
                if (!state.pinned && !isPanelMinimized(id)) {
                    minimizePanel(id);
                }
            }
        });
    }
    
    const state = getPanelState(panelId);
    
    // Restore to expandedHeight, or default, or null (natural height)
    // For Follow panel, use null to let it flex-fill
    let newHeight;
    if (panelId === 'follow') {
        newHeight = null; // Follow uses flex to fill space
    } else if (state.expandedHeight && state.expandedHeight > MIN_PANEL_HEIGHT) {
        newHeight = state.expandedHeight;
    } else {
        newHeight = DEFAULT_EXPANDED_HEIGHT;
    }
    
    setPanelState(panelId, { height: newHeight });
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
// Drag-to-Resize Handling
// =============================================================================

// Drag state
let dragState = {
    active: false,
    panelId: null,
    startY: 0,
    startPanelHeight: 0,
    startAboveHeight: 0,
    abovePanelId: null,
    panelElement: null,
    aboveElement: null
};

/**
 * Get the panel above a given panel that can be resized
 * @param {string} panelId - Current panel identifier
 * @param {boolean} mustBeExpanded - If true, only return non-minimized panels
 * @returns {string|null} Panel ID above, or null if none
 */
function getPanelAbove(panelId, mustBeExpanded = false) {
    const index = PANEL_ORDER.indexOf(panelId);
    if (index <= 0) return null;
    
    // Find the nearest visible, RESIZABLE panel above
    for (let i = index - 1; i >= 0; i--) {
        const aboveId = PANEL_ORDER[i];
        
        // Skip non-resizable panels (header, roleButtons)
        if (!RESIZABLE_PANELS.includes(aboveId)) {
            continue;
        }
        
        const aboveState = getPanelState(aboveId);
        if (aboveState.hidden) {
            continue;
        }
        
        // If we require expanded panels, skip minimized ones
        if (mustBeExpanded && isPanelMinimized(aboveId)) {
            continue;
        }
        
        return aboveId;
    }
    return null;
}

/**
 * Check if a panel is draggable
 * @param {string} panelId - Panel identifier
 * @returns {boolean}
 */
function isPanelDraggable(panelId) {
    return DRAGGABLE_PANELS.includes(panelId);
}

/**
 * Start drag operation on a panel title bar
 * @param {string} panelId - Panel being dragged
 * @param {number} clientY - Starting Y coordinate
 */
function startPanelDrag(panelId, clientY) {
    // Don't allow dragging if THIS panel's title bar is pinned
    const state = getPanelState(panelId);
    if (state.pinned) return;
    
    // Don't allow dragging if this panel is not draggable
    if (!isPanelDraggable(panelId)) return;
    
    // Find the nearest RESIZABLE panel above (may be minimized)
    const abovePanelId = getPanelAbove(panelId, false);
    if (!abovePanelId) return;
    
    // If the panel above is minimized, un-minimize it first
    // This ensures we always have a panel to resize
    if (isPanelMinimized(abovePanelId)) {
        // Un-minimize by restoring to expanded height
        maximizePanel(abovePanelId, false);
    }
    
    // Note: We DO allow dragging even if panel above is pinned.
    // Pinning freezes a title bar's position, not the panel's content size.
    // Dragging this title bar resizes the panel above's content, but doesn't
    // move the panel above's title bar.
    
    const panelElement = getPanelElement(panelId);
    const aboveElement = getPanelElement(abovePanelId);
    
    if (!panelElement || !aboveElement) return;
    
    // Get current heights
    const panelRect = panelElement.getBoundingClientRect();
    const aboveRect = aboveElement.getBoundingClientRect();
    
    dragState = {
        active: true,
        panelId,
        startY: clientY,
        startPanelHeight: panelRect.height,
        startAboveHeight: aboveRect.height,
        abovePanelId,
        panelElement,
        aboveElement
    };
    
    // Add dragging class for visual feedback
    panelElement.classList.add('dragging');
    document.body.classList.add('panel-dragging');
    
    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
}

/**
 * Update drag operation
 * @param {number} clientY - Current Y coordinate
 */
function updatePanelDrag(clientY) {
    if (!dragState.active) return;
    
    const deltaY = clientY - dragState.startY;
    
    // Dragging up (negative delta) = make panel above smaller, this panel bigger
    // Dragging down (positive delta) = make panel above bigger, this panel smaller
    
    let newAboveHeight = dragState.startAboveHeight + deltaY;
    let newPanelHeight = dragState.startPanelHeight - deltaY;
    
    // Enforce minimum heights
    if (newAboveHeight < MIN_PANEL_HEIGHT) {
        const diff = MIN_PANEL_HEIGHT - newAboveHeight;
        newAboveHeight = MIN_PANEL_HEIGHT;
        newPanelHeight -= diff;
    }
    
    if (newPanelHeight < MIN_PANEL_HEIGHT) {
        const diff = MIN_PANEL_HEIGHT - newPanelHeight;
        newPanelHeight = MIN_PANEL_HEIGHT;
        newAboveHeight -= diff;
    }
    
    // For the Follow panel, we don't set explicit height (it fills remaining space)
    // Instead, we only resize the panel above it
    if (dragState.panelId === 'follow') {
        dragState.aboveElement.style.height = `${newAboveHeight}px`;
        dragState.aboveElement.style.flex = '0 0 auto';
    } else {
        // Apply new heights
        dragState.aboveElement.style.height = `${newAboveHeight}px`;
        dragState.aboveElement.style.flex = '0 0 auto';
        dragState.panelElement.style.height = `${newPanelHeight}px`;
        dragState.panelElement.style.flex = '0 0 auto';
    }
}

/**
 * End drag operation and save state
 */
function endPanelDrag() {
    if (!dragState.active) return;
    
    // Remove visual feedback
    if (dragState.panelElement) {
        dragState.panelElement.classList.remove('dragging');
    }
    document.body.classList.remove('panel-dragging');
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    
    // Save the new heights
    if (dragState.aboveElement && dragState.abovePanelId) {
        const aboveRect = dragState.aboveElement.getBoundingClientRect();
        setPanelState(dragState.abovePanelId, { height: Math.round(aboveRect.height) });
    }
    
    // Save current panel height (unless it's Follow)
    if (dragState.panelElement && dragState.panelId && dragState.panelId !== 'follow') {
        const panelRect = dragState.panelElement.getBoundingClientRect();
        setPanelState(dragState.panelId, { height: Math.round(panelRect.height) });
    }
    
    // Reset drag state
    dragState = {
        active: false,
        panelId: null,
        startY: 0,
        startPanelHeight: 0,
        startAboveHeight: 0,
        abovePanelId: null,
        panelElement: null,
        aboveElement: null
    };
}

/**
 * Handle touch start on a draggable title bar
 * @param {TouchEvent} e - Touch event
 * @param {string} panelId - Panel identifier
 */
function handleDragTouchStart(e, panelId) {
    // Only handle single touch
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    startPanelDrag(panelId, touch.clientY);
}

/**
 * Handle touch move during drag
 * @param {TouchEvent} e - Touch event
 */
function handleDragTouchMove(e) {
    if (!dragState.active) return;
    
    // Prevent scrolling while dragging
    e.preventDefault();
    
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    updatePanelDrag(touch.clientY);
}

/**
 * Handle touch end during drag
 * @param {TouchEvent} e - Touch event
 */
function handleDragTouchEnd(e) {
    endPanelDrag();
}

/**
 * Handle mouse down on a draggable title bar
 * @param {MouseEvent} e - Mouse event
 * @param {string} panelId - Panel identifier
 */
function handleDragMouseDown(e, panelId) {
    // Only left mouse button
    if (e.button !== 0) return;
    
    startPanelDrag(panelId, e.clientY);
}

/**
 * Handle mouse move during drag
 * @param {MouseEvent} e - Mouse event
 */
function handleDragMouseMove(e) {
    if (!dragState.active) return;
    
    e.preventDefault();
    updatePanelDrag(e.clientY);
}

/**
 * Handle mouse up during drag
 * @param {MouseEvent} e - Mouse event
 */
function handleDragMouseUp(e) {
    endPanelDrag();
}

/**
 * Wire up drag handle events for a panel title bar
 * @param {HTMLElement} titleBar - Title bar element
 * @param {string} panelId - Panel identifier
 */
function wireDragHandleEvents(titleBar, panelId) {
    if (!isPanelDraggable(panelId)) {
        // Mark as not draggable
        titleBar.classList.add('not-draggable');
        return;
    }
    
    const dragHandle = titleBar.querySelector('.panel-drag-handle');
    if (!dragHandle) return;
    
    // Mark as draggable
    titleBar.classList.add('draggable');
    dragHandle.classList.add('active');
    
    // Touch events on the drag handle
    dragHandle.addEventListener('touchstart', (e) => {
        handleDragTouchStart(e, panelId);
    }, { passive: false });
    
    // Mouse events on the drag handle
    dragHandle.addEventListener('mousedown', (e) => {
        handleDragMouseDown(e, panelId);
        e.stopPropagation(); // Prevent title bar click
    });
}

/**
 * Set up global drag event listeners
 */
function initDragListeners() {
    // Global touch move/end handlers
    document.addEventListener('touchmove', handleDragTouchMove, { passive: false });
    document.addEventListener('touchend', handleDragTouchEnd);
    document.addEventListener('touchcancel', handleDragTouchEnd);
    
    // Global mouse move/up handlers
    document.addEventListener('mousemove', handleDragMouseMove);
    document.addEventListener('mouseup', handleDragMouseUp);
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
    titleBar.dataset.panelId = panelId;
    
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
    
    // Double-tap handler for title bar (but not when dragging)
    titleBar.addEventListener('click', (e) => {
        // Don't trigger tap if we just finished dragging
        if (!dragState.active) {
            handleTitleBarTap(panelId);
        }
    });
    
    // Wire up drag handle events
    wireDragHandleEvents(titleBar, panelId);
    
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
        if (!followState.pinned && !isPanelMinimized('follow')) {
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
        const gameEventsState = getPanelState('gameEvents');
        if (duringPoint && !gameEventsState.pinned) {
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

/**
 * Reset all panel heights to defaults
 * Clears saved heights and removes explicit height styles
 */
function resetPanelHeights() {
    Object.keys(panelStates).forEach(panelId => {
        // Clear saved height
        panelStates[panelId].height = null;
        
        // Clear explicit height style
        const panel = getPanelElement(panelId);
        if (panel) {
            panel.style.height = '';
            if (panelId === 'follow') {
                panel.style.flex = '1 1 auto';
            } else {
                panel.style.flex = '0 0 auto';
            }
        }
    });
    savePanelStates();
    console.log('🎛️ Panel heights reset');
}

/**
 * Reset all panel states to defaults (nuclear option)
 * Clears everything from localStorage and reloads defaults
 */
function resetAllPanelStates() {
    localStorage.removeItem(PANEL_STATE_KEY);
    panelStates = JSON.parse(JSON.stringify(DEFAULT_PANEL_STATES));
    
    // Clear all inline styles from panels
    Object.keys(panelStates).forEach(panelId => {
        const panel = getPanelElement(panelId);
        if (panel) {
            panel.style.height = '';
            panel.style.flex = '';
            panel.classList.remove('expanding', 'dragging', 'minimized', 'maximized');
        }
    });
    
    applyAllPanelStates();
    console.log('🎛️ All panel states reset to defaults');
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
    initDragListeners();
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
window.isPanelMinimized = isPanelMinimized;

// Panel actions
window.togglePanelMinimized = togglePanelMinimized;
window.minimizePanel = minimizePanel;
window.maximizePanel = maximizePanel;
window.togglePanelPinned = togglePanelPinned;
window.setPanelVisible = setPanelVisible;
window.setPanelSubtitle = setPanelSubtitle;
window.resetPanelHeights = resetPanelHeights;
window.resetAllPanelStates = resetAllPanelStates;
window.updateExpandingPanel = updateExpandingPanel;

// Panel creation
window.createPanelTitleBar = createPanelTitleBar;
window.createPanelStub = createPanelStub;
window.createPanel = createPanel;

// Drag handling (exposed for testing/debugging)
window.isPanelDraggable = isPanelDraggable;
window.DRAGGABLE_PANELS = DRAGGABLE_PANELS;
window.RESIZABLE_PANELS = RESIZABLE_PANELS;

// Game screen management
window.showGameScreen = showGameScreen;
window.hideGameScreen = hideGameScreen;
window.isGameScreenVisible = isGameScreenVisible;

// Role and state updates
window.updatePanelsForRole = updatePanelsForRole;
window.updatePanelsForGameState = updatePanelsForGameState;

