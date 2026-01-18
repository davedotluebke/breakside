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
const MIN_PANEL_HEIGHT = 36;

// Minimum height for Play-by-Play panel (title bar + compact button row)
// This ensures the buttons are always visible unless explicitly minimized
const PBP_MIN_CONTENT_HEIGHT = 96;

// Default expanded height when un-minimizing a panel that has no saved height
const DEFAULT_EXPANDED_HEIGHT = 150;

// Panel IDs in order (top to bottom)
// Note: gameEvents removed - now a modal popup from Play-by-Play
const PANEL_ORDER = ['header', 'roleButtons', 'playByPlay', 'selectLine', 'follow'];

// Panels that can be resized via drag (these have draggable title bars)
// Dragging a title bar resizes that panel and the one above it
const DRAGGABLE_PANELS = ['selectLine', 'follow'];

// Panels that CAN be resized (excludes fixed-height header and roleButtons)
const RESIZABLE_PANELS = ['playByPlay', 'selectLine', 'follow'];

// Default panel states
// height: null = natural/flexible height
// height: MIN_PANEL_HEIGHT = "minimized" (title bar only)
// height: number > MIN_PANEL_HEIGHT = explicit expanded height
// expandedHeight: saved height to restore when un-minimizing
const DEFAULT_PANEL_STATES = {
    header: { hidden: false, height: null, expandedHeight: null },
    roleButtons: { hidden: false, height: null, expandedHeight: null },
    playByPlay: { hidden: false, height: PBP_MIN_CONTENT_HEIGHT, expandedHeight: 250 },
    selectLine: { hidden: false, height: null, expandedHeight: null },
    follow: { hidden: false, height: null, expandedHeight: null }
};

// Current panel states
let panelStates = { ...DEFAULT_PANEL_STATES };

// Track which panel is currently "full screen maximized" (others minimized)
// null = no panel maximized, panelId = that panel is maximized
let maximizedPanelId = null;

// Store panel heights before maximize for restoration
let preMaximizeHeights = {};

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
    return panelStates[panelId] || { hidden: false, height: null, expandedHeight: null };
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
    
    // Apply hidden state
    panel.classList.toggle('hidden', state.hidden);
    
    // Special handling for Follow panel (bottom panel)
    // When minimized, it snaps to bottom of screen
    // When expanded, it fills remaining space
    if (isFollowPanel) {
        if (isMinimized) {
            // Snap to bottom: use margin-top: auto to push title bar to bottom
            panel.style.height = `${MIN_PANEL_HEIGHT}px`;
            panel.style.flex = '0 0 auto';
            panel.style.marginTop = 'auto';
            panel.classList.add('snapped-to-bottom');
        } else if (state.height !== null && state.height > MIN_PANEL_HEIGHT) {
            // Explicit expanded height
            panel.style.height = `${state.height}px`;
            panel.style.flex = '0 0 auto';
            panel.style.marginTop = '';
            panel.classList.remove('snapped-to-bottom');
        } else {
            // Fill remaining space (height: null)
            panel.style.height = '';
            panel.style.flex = '1 1 auto';
            panel.style.marginTop = '';
            panel.classList.remove('snapped-to-bottom');
        }
    } else {
        // Regular panels
        panel.style.marginTop = '';
        panel.classList.remove('snapped-to-bottom');
        
        if (state.height !== null) {
            // Explicit height set
            panel.style.height = `${state.height}px`;
            panel.style.flex = '0 0 auto';
        } else {
            // Natural height
            panel.style.height = '';
            panel.style.flex = '0 0 auto';
        }
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
 * Normally this is Follow, but if Follow is minimized (snapped to bottom), 
 * it's the last non-minimized panel above it
 */
function updateExpandingPanel() {
    const followPanel = getPanelElement('follow');
    const followMinimized = isPanelMinimized('follow');
    const followState = getPanelState('follow');
    
    // All potentially expanding panels (bottom-up order, excluding Follow)
    const expandOrder = ['selectLine', 'playByPlay'];
    
    // If Follow is not minimized and has no explicit expanded height, it handles expansion
    if (!followMinimized && (followState.height === null || followState.height > MIN_PANEL_HEIGHT)) {
        // Ensure Follow has flex-grow and expanding class
        if (followPanel) {
            if (followState.height === null) {
                followPanel.style.flex = '1 1 auto';
            }
            followPanel.classList.add('expanding');
        }
        // Remove expanding from other panels
        expandOrder.forEach(id => {
            const panel = getPanelElement(id);
            if (panel) {
                panel.classList.remove('expanding');
            }
        });
        return;
    }
    
    // Follow is minimized (snapped to bottom) - remove its expanding class
    if (followPanel) {
        followPanel.classList.remove('expanding');
    }
    
    // Find the last non-minimized panel to expand and fill the space above Follow
    let expandingPanelId = null;
    
    for (const panelId of expandOrder) {
        const state = getPanelState(panelId);
        const isMinimized = isPanelMinimized(panelId);
        if (!isMinimized && !state.hidden) {
            // This panel should expand
            expandingPanelId = panelId;
            break;
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
 * Set panel visibility
 * @param {string} panelId - Panel identifier
 * @param {boolean} visible - Whether panel should be visible
 */
function setPanelVisible(panelId, visible) {
    setPanelState(panelId, { hidden: !visible });
}

/**
 * Toggle full-screen maximize for a panel
 * - If this panel is not maximized: minimize all other resizable panels, giving
 *   maximum space to this panel. Save current heights for restoration.
 * - If this panel IS maximized: restore all panels to their pre-maximize heights.
 * @param {string} panelId - Panel identifier
 */
function toggleFullScreenPanel(panelId) {
    // Only resizable panels can be full-screen maximized
    if (!RESIZABLE_PANELS.includes(panelId)) return;
    
    if (maximizedPanelId === panelId) {
        // This panel is already maximized - restore all panels
        restoreFromFullScreen();
    } else {
        // Maximize this panel (minimize others)
        enterFullScreenPanel(panelId);
    }
}

/**
 * Enter full-screen mode for a panel
 * Saves current heights and minimizes all other resizable panels
 * @param {string} panelId - Panel to maximize
 */
function enterFullScreenPanel(panelId) {
    // Save current heights of all resizable panels for restoration
    preMaximizeHeights = {};
    RESIZABLE_PANELS.forEach(id => {
        const panel = getPanelElement(id);
        if (panel) {
            const state = getPanelState(id);
            // Store either explicit height or measured height
            preMaximizeHeights[id] = state.height !== null 
                ? state.height 
                : panel.getBoundingClientRect().height;
        }
    });
    
    // Minimize all other resizable panels and add visual indicator
    RESIZABLE_PANELS.forEach(id => {
        const panel = getPanelElement(id);
        if (id !== panelId) {
            if (!isPanelMinimized(id)) {
                minimizePanel(id);
            }
            // Add class to indicate this panel is minimized for full-screen mode
            if (panel) {
                panel.classList.add('minimized-for-fullscreen');
                panel.classList.remove('full-screen-maximized');
            }
        }
    });
    
    // Make sure the target panel is NOT minimized
    if (isPanelMinimized(panelId)) {
        maximizePanel(panelId, false); // false = don't minimize others (we already did)
    }
    
    // Add visual indicator to maximized panel
    const maximizedPanel = getPanelElement(panelId);
    if (maximizedPanel) {
        maximizedPanel.classList.add('full-screen-maximized');
        maximizedPanel.classList.remove('minimized-for-fullscreen');
    }
    
    // Track which panel is maximized
    maximizedPanelId = panelId;
    
    // Update expanding panel assignment
    updateExpandingPanel();
    savePanelStates();
}

/**
 * Restore all panels from full-screen mode
 * Restores heights saved before maximize
 */
function restoreFromFullScreen() {
    if (!maximizedPanelId) return;
    
    // Remove visual indicator classes from all panels
    RESIZABLE_PANELS.forEach(id => {
        const panel = getPanelElement(id);
        if (panel) {
            panel.classList.remove('full-screen-maximized', 'minimized-for-fullscreen');
        }
    });
    
    // Restore all panels to their pre-maximize heights
    RESIZABLE_PANELS.forEach(id => {
        const savedHeight = preMaximizeHeights[id];
        if (savedHeight !== undefined) {
            // Restore the height
            if (savedHeight <= MIN_PANEL_HEIGHT) {
                // Was minimized before
                setPanelState(id, { height: MIN_PANEL_HEIGHT });
            } else {
                // Was expanded - set height and expandedHeight
                setPanelState(id, { 
                    height: id === 'follow' ? null : savedHeight,
                    expandedHeight: savedHeight
                });
            }
        }
    });
    
    // Clear maximized state
    maximizedPanelId = null;
    preMaximizeHeights = {};
    
    // Update expanding panel assignment
    updateExpandingPanel();
    savePanelStates();
}

// =============================================================================
// Event Handlers
// =============================================================================

/**
 * Handle double-tap on title bar to toggle full-screen maximize
 * Double-tap maximizes the panel (minimizes others)
 * Double-tap again restores all panels to previous state
 * @param {string} panelId - Panel identifier
 */
let lastTapTime = {};
function handleTitleBarTap(panelId) {
    const now = Date.now();
    const lastTap = lastTapTime[panelId] || 0;
    
    if (now - lastTap < 300) {
        // Double tap detected - toggle full-screen maximize
        toggleFullScreenPanel(panelId);
        lastTapTime[panelId] = 0;
    } else {
        lastTapTime[panelId] = now;
    }
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
    panelElement: null,
    startHeights: {} // Store starting heights of all panels for absolute positioning
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
 * Get the minimum height for a panel during drag operations
 * (different from MIN_PANEL_HEIGHT which is for explicit minimize)
 * @param {string} panelId - Panel identifier
 * @returns {number}
 */
function getDragMinHeight(panelId) {
    if (panelId === 'playByPlay') {
        return PBP_MIN_CONTENT_HEIGHT;
    }
    return MIN_PANEL_HEIGHT;
}

/**
 * Start drag operation on a panel title bar
 * @param {string} panelId - Panel being dragged
 * @param {number} clientY - Starting Y coordinate
 */
function startPanelDrag(panelId, clientY) {
    // Don't allow dragging if this panel is not draggable
    if (!isPanelDraggable(panelId)) return;
    
    // Check there's at least one resizable panel above
    const abovePanelId = getPanelAbove(panelId, false);
    if (!abovePanelId) return;
    
    const panelElement = getPanelElement(panelId);
    if (!panelElement) return;
    
    // Store starting heights of ALL resizable panels for absolute positioning
    const startHeights = {};
    RESIZABLE_PANELS.forEach(id => {
        const el = getPanelElement(id);
        if (el) {
            startHeights[id] = el.getBoundingClientRect().height;
        }
    });
    
    dragState = {
        active: true,
        panelId,
        startY: clientY,
        startPanelHeight: startHeights[panelId] || 0,
        panelElement,
        startHeights
    };
    
    // Add dragging class for visual feedback
    panelElement.classList.add('dragging');
    document.body.classList.add('panel-dragging');
    
    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
}

/**
 * Update drag operation with "shoving" behavior
 * When a panel above reaches MIN_PANEL_HEIGHT, continue pushing panels above it
 * @param {number} clientY - Current Y coordinate
 */
function updatePanelDrag(clientY) {
    if (!dragState.active) return;
    
    const deltaY = clientY - dragState.startY;
    
    // Dragging up (negative delta) = make panels above smaller, this panel bigger
    // Dragging down (positive delta) = make panels above bigger, this panel smaller
    
    // Calculate how much space we need to take from/give to panels above
    let spaceNeeded = -deltaY; // Positive = need space from above, Negative = giving space to above
    
    // Get all resizable panels above the dragged panel (using STORED starting heights)
    const draggedPanelIndex = PANEL_ORDER.indexOf(dragState.panelId);
    const panelsAbove = [];
    for (let i = draggedPanelIndex - 1; i >= 0; i--) {
        const id = PANEL_ORDER[i];
        if (RESIZABLE_PANELS.includes(id)) {
            const el = getPanelElement(id);
            const startHeight = dragState.startHeights[id];
            if (el && startHeight !== undefined) {
                panelsAbove.push({ id, element: el, startHeight });
            }
        }
    }
    
    if (panelsAbove.length === 0) return;
    
    // Calculate target heights based on STARTING heights (not current)
    const targetHeights = new Map();
    
    // Initialize all panels to their starting height
    panelsAbove.forEach(p => targetHeights.set(p.id, p.startHeight));
    
    let remainingSpace = spaceNeeded;
    
    if (spaceNeeded > 0) {
        // Taking space from above (dragging up) - shrink panels from bottom to top
        for (const panel of panelsAbove) {
            if (remainingSpace <= 0) break;
            
            const startHeight = panel.startHeight;
            const minHeight = getDragMinHeight(panel.id);
            const availableSpace = startHeight - minHeight;
            
            if (availableSpace > 0) {
                const spaceToTake = Math.min(availableSpace, remainingSpace);
                targetHeights.set(panel.id, startHeight - spaceToTake);
                remainingSpace -= spaceToTake;
            } else {
                // Panel was already at minimum, keep it there
                targetHeights.set(panel.id, minHeight);
            }
        }
    } else {
        // Giving space to above (dragging down) - expand first panel above
        // Space can come from: 1) the dragged panel, 2) follow panel (if not already at bottom)
        let spaceToGive = -remainingSpace;
        
        // Calculate available space from dragged panel
        const draggedMinHeight = getDragMinHeight(dragState.panelId);
        const draggedCanGive = Math.max(0, dragState.startPanelHeight - draggedMinHeight);
        
        // Calculate available space from follow panel (if we're not dragging it)
        let followCanGive = 0;
        if (dragState.panelId !== 'follow') {
            const followStartHeight = dragState.startHeights['follow'] || 0;
            followCanGive = Math.max(0, followStartHeight - MIN_PANEL_HEIGHT);
        }
        
        // Total available space to give
        const totalAvailable = draggedCanGive + followCanGive;
        spaceToGive = Math.min(spaceToGive, totalAvailable);
        
        if (panelsAbove.length > 0 && spaceToGive > 0) {
            const firstAbove = panelsAbove[0];
            targetHeights.set(firstAbove.id, firstAbove.startHeight + spaceToGive);
        }
        remainingSpace = 0;
    }
    
    // Apply target heights to panels above
    panelsAbove.forEach(panel => {
        const targetHeight = targetHeights.get(panel.id);
        panel.element.style.height = `${targetHeight}px`;
        panel.element.style.flex = '0 0 auto';
    });
    
    // Calculate actual space taken/given
    const actualSpaceChanged = spaceNeeded - remainingSpace;
    
    // Update the dragged panel's height (unless it's Follow which fills remaining)
    if (dragState.panelId !== 'follow') {
        const minHeight = getDragMinHeight(dragState.panelId);
        const newPanelHeight = Math.max(minHeight, dragState.startPanelHeight + actualSpaceChanged);
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
    
    // Save heights for all resizable panels that may have changed
    RESIZABLE_PANELS.forEach(panelId => {
        const panel = getPanelElement(panelId);
        if (panel && panelId !== 'follow') {
            const rect = panel.getBoundingClientRect();
            // Only save if height is explicitly set (has inline style)
            if (panel.style.height) {
                setPanelState(panelId, { height: Math.round(rect.height) });
            }
        }
    });
    
    // Reset drag state
    dragState = {
        active: false,
        panelId: null,
        startY: 0,
        startPanelHeight: 0,
        panelElement: null,
        startHeights: {}
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
 * Wire up drag events for a panel title bar
 * The entire title bar is draggable, not just the handle icon
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
    
    // Mark as draggable
    titleBar.classList.add('draggable');
    if (dragHandle) {
        dragHandle.classList.add('active');
    }
    
    // Touch events on the ENTIRE title bar
    titleBar.addEventListener('touchstart', (e) => {
        // Don't start drag if touching a button
        if (e.target.closest('.panel-action-btn')) return;
        handleDragTouchStart(e, panelId);
    }, { passive: false });
    
    // Mouse events on the ENTIRE title bar
    titleBar.addEventListener('mousedown', (e) => {
        // Don't start drag if clicking a button
        if (e.target.closest('.panel-action-btn')) return;
        handleDragMouseDown(e, panelId);
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
 * @param {boolean} options.showExpandBtn - Show expand/collapse button
 * @returns {HTMLElement}
 */
function createPanelTitleBar(options) {
    const { panelId, title, showDragHandle = true, showExpandBtn = true } = options;
    
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
 * Hides all legacy screens to prevent them from showing through
 */
function showGameScreen() {
    const container = document.getElementById('gameScreenContainer');
    if (container) {
        // Hide all legacy screens to prevent them from showing through
        hideLegacyScreens();
        
        // Add body class to override any !important rules on legacy screens
        document.body.classList.add('game-screen-active');
        
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
        // Remove body class to restore normal behavior
        document.body.classList.remove('game-screen-active');
        // Note: Legacy screens will be shown by showScreen() when navigating
    }
}

/**
 * Hide all legacy screens to prevent them from showing under the panel UI
 */
function hideLegacyScreens() {
    // List of all legacy screen IDs
    const legacyScreenIds = [
        'selectTeamScreen',
        'teamRosterScreen', 
        'teamSettingsScreen',
        'beforePointScreen',
        'offensePlayByPlayScreen',
        'defensePlayByPlayScreen',
        'simpleModeScreen',
        'gameSummaryScreen'
    ];
    
    legacyScreenIds.forEach(id => {
        const screen = document.getElementById(id);
        if (screen) {
            screen.style.display = 'none';
        }
    });
    
    // Also hide the header and bottom panel
    const header = document.querySelector('header');
    if (header) {
        header.style.display = 'none';
    }
    
    const bottomPanel = document.getElementById('bottomPanel');
    if (bottomPanel) {
        bottomPanel.style.display = 'none';
    }
    
    // Hide the legacy controller role buttons (Phase 6 sub-header)
    // The new panel-based role buttons are used instead
    const legacyRoleButtons = document.getElementById('controllerRoleButtons');
    if (legacyRoleButtons) {
        legacyRoleButtons.style.display = 'none';
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
    
    // Follow panel - maximized for viewers or coaches without roles
    if (!hasRole) {
        if (!isPanelMinimized('follow')) {
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
        if (duringPoint && isActiveCoach) {
            // Auto-maximize when point starts, if Active Coach
            maximizePanel('playByPlay', false);
        } else if (!duringPoint) {
            // Auto-minimize when point ends
            minimizePanel('playByPlay');
    }
    
    // Select Line panel
    if (isActiveCoach) {
        if (duringPoint) {
            // Auto-minimize when point starts for Active Coach
            minimizePanel('selectLine');
        } else {
            // Auto-maximize when point ends
            maximizePanel('selectLine', false);
        }
    }
    
    // Note: Game Events is now a modal popup from Play-by-Play, not a panel
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
            panel.style.marginTop = '';
            panel.classList.remove('expanding', 'dragging', 'minimized', 'maximized', 'snapped-to-bottom', 'pinned');
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
window.setPanelVisible = setPanelVisible;
window.setPanelSubtitle = setPanelSubtitle;
window.resetPanelHeights = resetPanelHeights;
window.resetAllPanelStates = resetAllPanelStates;
window.updateExpandingPanel = updateExpandingPanel;
window.toggleFullScreenPanel = toggleFullScreenPanel;
window.restoreFromFullScreen = restoreFromFullScreen;

// Panel creation
window.createPanelTitleBar = createPanelTitleBar;
window.createPanelStub = createPanelStub;
window.createPanel = createPanel;

// Drag handling (exposed for testing/debugging)
window.isPanelDraggable = isPanelDraggable;
window.getDragMinHeight = getDragMinHeight;
window.DRAGGABLE_PANELS = DRAGGABLE_PANELS;
window.RESIZABLE_PANELS = RESIZABLE_PANELS;
window.PBP_MIN_CONTENT_HEIGHT = PBP_MIN_CONTENT_HEIGHT;

// Game screen management
window.showGameScreen = showGameScreen;
window.hideGameScreen = hideGameScreen;
window.isGameScreenVisible = isGameScreenVisible;

// Role and state updates
window.updatePanelsForRole = updatePanelsForRole;
window.updatePanelsForGameState = updatePanelsForGameState;

