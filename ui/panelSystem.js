/*
 * Panel System - Drag-to-Resize Layout
 * Phase 6b: Panel Container Foundation
 *
 * This module provides the core panel management functionality for the in-game UI.
 * Panels are resized solely by dragging title bars. The Follow (Game Log) panel
 * absorbs remaining space via flex-fill.
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

// Minimum height for Follow (Game Log) panel (~36px title bar + ~44px for 2 lines of log content)
const FOLLOW_MIN_HEIGHT = 80;


// Panel IDs in order (top to bottom)
// Note: gameEvents removed - now a modal popup from Play-by-Play
// playByPlayFull is the Full-mode PBP panel — only visible when the "Full"
// tab is active. Hidden by default everywhere else (including the All view,
// which keeps Simple-mode PBP only — see docs/full-pbp-requirements.md).
const PANEL_ORDER = ['header', 'roleButtons', 'playByPlay', 'playByPlayFull', 'selectLine', 'selectOLine', 'selectDLine', 'follow'];

// Panels that can be resized via drag (these have draggable title bars)
// Dragging a title bar resizes that panel and the one above it
const DRAGGABLE_PANELS = ['selectLine', 'selectOLine', 'selectDLine', 'follow'];

// Panels that CAN be resized (excludes fixed-height header and roleButtons)
// Note: playByPlayFull is full-tab-only and never resized via drag.
const RESIZABLE_PANELS = ['playByPlay', 'selectLine', 'selectOLine', 'selectDLine', 'follow'];

// Default panel states
// height: null = natural/flexible height (Follow uses flex-fill)
// height: MIN_PANEL_HEIGHT = "minimized" (title bar only)
// height: number > MIN_PANEL_HEIGHT = explicit drag height
const DEFAULT_PANEL_STATES = {
    header: { hidden: false, height: null },
    roleButtons: { hidden: false, height: null },
    playByPlay: { hidden: false, height: PBP_MIN_CONTENT_HEIGHT },
    playByPlayFull: { hidden: true, height: null },
    selectLine: { hidden: false, height: null },
    selectOLine: { hidden: true, height: null },
    selectDLine: { hidden: true, height: null },
    follow: { hidden: false, height: null }
};

// Current panel states
let panelStates = { ...DEFAULT_PANEL_STATES };

// Track whether another coach has been seen in the current game session.
// Once true, role buttons stay visible until the game screen is exited.
let _multiCoachDetected = false;

/**
 * Load panel states from localStorage
 */
function loadPanelStates() {
    try {
        const saved = localStorage.getItem(PANEL_STATE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            panelStates = { ...DEFAULT_PANEL_STATES, ...parsed };
            // Strip legacy expandedHeight from saved state
            Object.keys(panelStates).forEach(id => {
                delete panelStates[id].expandedHeight;
            });
            // Always reset Follow to flex-fill on load to prevent stale
            // minimized state from hiding the game log
            if (panelStates.follow) {
                panelStates.follow.height = null;
            }
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
    return panelStates[panelId] || { hidden: false, height: null };
}

/**
 * Check if a panel is currently minimized (height = title bar only)
 * @param {string} panelId - Panel identifier
 * @returns {boolean}
 */
function isPanelMinimized(panelId) {
    const state = getPanelState(panelId);
    const minHeight = panelId === 'follow' ? FOLLOW_MIN_HEIGHT : MIN_PANEL_HEIGHT;
    return state.height !== null && state.height <= minHeight;
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

    // Apply hidden state
    panel.classList.toggle('hidden', state.hidden);

    // Follow panel: either explicit drag height or flex-fill
    if (isFollowPanel) {
        panel.style.marginTop = '';
        panel.classList.remove('snapped-to-bottom');
        if (state.height !== null && state.height > 0) {
            panel.style.height = `${state.height}px`;
            panel.style.flex = '0 0 auto';
        } else {
            // Fill remaining space (height: null)
            panel.style.height = '';
            panel.style.flex = '1 1 auto';
        }
    } else {
        // Regular panels
        panel.style.marginTop = '';
        panel.classList.remove('snapped-to-bottom');

        if (state.height !== null) {
            panel.style.height = `${state.height}px`;
            panel.style.flex = '0 0 auto';
        } else {
            panel.style.height = '';
            panel.style.flex = '0 0 auto';
        }
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
    const followState = getPanelState('follow');
    const followAtMin = followState.height !== null && followState.height <= getDragMinHeight('follow');

    // All potentially expanding panels (bottom-up order, excluding Follow)
    // Include split panels when visible
    const expandOrder = [];
    if (!getPanelState('selectDLine').hidden) expandOrder.push('selectDLine');
    if (!getPanelState('selectOLine').hidden) expandOrder.push('selectOLine');
    if (!getPanelState('selectLine').hidden) expandOrder.push('selectLine');
    expandOrder.push('playByPlay');

    // If Follow is not at minimum and has no explicit height, it handles expansion
    if (!followAtMin && (followState.height === null || followState.height > getDragMinHeight('follow'))) {
        if (followPanel) {
            if (followState.height === null) {
                followPanel.style.flex = '1 1 auto';
            }
            followPanel.classList.add('expanding');
        }
        expandOrder.forEach(id => {
            const panel = getPanelElement(id);
            if (panel) panel.classList.remove('expanding');
        });
        return;
    }

    // Follow is at minimum - remove its expanding class
    if (followPanel) {
        followPanel.classList.remove('expanding');
    }

    // Find the last non-minimized panel to expand
    let expandingPanelId = null;
    for (const panelId of expandOrder) {
        const state = getPanelState(panelId);
        const atMin = state.height !== null && state.height <= getDragMinHeight(panelId);
        if (!atMin && !state.hidden) {
            expandingPanelId = panelId;
            break;
        }
    }

    expandOrder.forEach(id => {
        const panel = getPanelElement(id);
        if (panel) {
            if (id === expandingPanelId) {
                panel.style.flex = '1 1 auto';
                panel.style.height = '';
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
 * Minimize a panel (set height to minimum)
 * Used by split mode transitions.
 * @param {string} panelId - Panel identifier
 */
function minimizePanel(panelId) {
    const minHeight = panelId === 'follow' ? FOLLOW_MIN_HEIGHT : MIN_PANEL_HEIGHT;
    setPanelState(panelId, { height: minHeight });
}

/**
 * Maximize a panel (set to flex-fill or a reasonable default)
 * Used by split mode transitions.
 * @param {string} panelId - Panel identifier
 * @param {boolean} _minimizeOthers - Ignored (kept for call-site compat)
 */
function maximizePanel(panelId, _minimizeOthers = true) {
    // Follow uses flex to fill space; others get null (natural height)
    setPanelState(panelId, { height: null });
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
// Drag-to-Resize Handling
// =============================================================================

// Setting: fully-physical panel dragging
// When enabled, pushed panels stay where pushed (even when dragging back within
// the same gesture). When disabled, panels spring back to their start-of-gesture
// position when the drag reverses.
const PHYSICAL_DRAG_KEY = 'breakside_physical_drag';
let fullyPhysicalPanelDragging = localStorage.getItem(PHYSICAL_DRAG_KEY) !== 'false';

function setFullyPhysicalPanelDragging(enabled) {
    fullyPhysicalPanelDragging = enabled;
    localStorage.setItem(PHYSICAL_DRAG_KEY, enabled ? 'true' : 'false');
}

// Drag state
let dragState = {
    active: false,
    panelId: null,
    panelElement: null,
    panels: null,       // ordered list of {id, element, minHeight}
    heights: null,      // current heights (physical: persists; spring-back: reset each frame)
    startHeights: null,  // initial heights snapshot for spring-back reset
    draggedIndex: -1,
    startY: 0,
    lastClientY: 0
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
    if (panelId === 'follow') {
        return FOLLOW_MIN_HEIGHT;
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

    // Ensure follow is in flex-fill mode before measuring
    const followState = getPanelState('follow');
    if (followState.height !== null) {
        const followEl = getPanelElement('follow');
        if (followEl) {
            followEl.classList.remove('snapped-to-bottom');
            followEl.style.marginTop = '';
            followEl.style.height = '';
            followEl.style.flex = '1 1 auto';
            panelStates['follow'] = { ...followState, height: null };
        }
    }
    savePanelStates();

    // Build ordered list of visible resizable panels with measured heights.
    // Skip panels that are hidden OR have display:none (e.g. selectLine in split mode)
    const panels = [];
    let draggedIndex = -1;
    RESIZABLE_PANELS.forEach(id => {
        const st = getPanelState(id);
        if (st.hidden) return;
        const el = getPanelElement(id);
        if (!el) return;
        if (el.style.display === 'none' || el.offsetParent === null) return;
        if (id === panelId) draggedIndex = panels.length;
        panels.push({
            id,
            element: el,
            minHeight: getDragMinHeight(id)
        });
    });

    if (draggedIndex < 1) return; // need at least one panel above

    // Measure heights and freeze non-follow panels to explicit heights
    const heights = panels.map((p, i) => {
        const h = p.element.getBoundingClientRect().height;
        if (p.id !== 'follow') {
            p.element.style.height = `${h}px`;
            p.element.style.flex = '0 0 auto';
        }
        return h;
    });

    dragState = {
        active: true,
        panelId,
        panelElement,
        panels,
        heights,
        startHeights: heights.slice(), // copy for spring-back reset
        draggedIndex,
        startY: clientY,
        lastClientY: clientY
    };

    // Add dragging class for visual feedback
    panelElement.classList.add('dragging');
    document.body.classList.add('panel-dragging');

    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
}

/**
 * Move title bar `i` by `delta` pixels. Recursively pushes neighbors.
 *
 * Moving title bar i down grows panel i-1, shrinks panel i.
 * Moving title bar i up shrinks panel i-1, grows panel i.
 *
 * @param {number} i - Title bar index in dragState.panels
 * @param {number} delta - Requested movement (negative=up, positive=down)
 * @param {number[]} heights - Current heights array (mutated in place)
 * @param {Array} panels - Panel info array from dragState
 * @returns {number} Actual movement applied
 */
function moveTitleBar(i, delta, heights, panels) {
    if (delta === 0) return 0;
    const lastIdx = panels.length - 1;

    if (delta > 0) {
        // Moving down: panel i shrinks, panel i-1 grows
        const canShrink = heights[i] - panels[i].minHeight;
        let available = canShrink;
        // If panel i is not the follow (last) panel, we can push bar i+1 down
        if (available < delta && i < lastIdx) {
            const pushed = moveTitleBar(i + 1, delta - available, heights, panels);
            available += pushed;
        }
        const actual = Math.min(delta, Math.max(0, available));
        heights[i - 1] += actual;
        heights[i] -= actual;
        return actual;
    } else {
        // Moving up: panel i-1 shrinks, panel i grows
        const canShrink = heights[i - 1] - panels[i - 1].minHeight;
        let available = canShrink;
        // Can push bar i-1 up if i-1 > 0 (bar 0 is pinned)
        if (available < -delta && i - 1 > 0) {
            const pushed = moveTitleBar(i - 1, delta + available, heights, panels);
            available += -pushed; // pushed is negative
        }
        const actual = Math.max(delta, -Math.max(0, available));
        heights[i - 1] += actual; // shrinks (actual is negative)
        heights[i] -= actual;     // grows
        return actual;
    }
}

/**
 * Update drag operation with cascading "push" behavior.
 *
 * Two modes:
 * - Spring-back (default): resets heights to start each frame, applies absolute delta.
 *   Panels spring back when the finger reverses direction.
 * - Physical: applies incremental delta each frame. Pushed panels stay where pushed
 *   because nothing asks them to move back.
 *
 * @param {number} clientY - Current Y coordinate
 */
function updatePanelDrag(clientY) {
    if (!dragState.active) return;

    const { panels, draggedIndex, startHeights } = dragState;
    const heights = dragState.heights;

    let delta;
    if (fullyPhysicalPanelDragging) {
        // Incremental delta from last frame — pushed panels stay put
        delta = clientY - dragState.lastClientY;
        dragState.lastClientY = clientY;
    } else {
        // Absolute delta from start — reset heights each frame for spring-back
        delta = clientY - dragState.startY;
        for (let i = 0; i < heights.length; i++) {
            heights[i] = startHeights[i];
        }
    }

    moveTitleBar(draggedIndex, delta, heights, panels);

    // Apply heights to DOM — follow (last panel) stays as flex-fill
    for (let i = 0; i < panels.length; i++) {
        const p = panels[i];
        if (p.id === 'follow') {
            // Keep game log scroll anchored to bottom during drag
            const eventsEl = document.getElementById('gameLogEvents');
            if (eventsEl) {
                eventsEl.scrollTop = eventsEl.scrollHeight - eventsEl.clientHeight;
            }
            continue;
        }
        p.element.style.height = `${heights[i]}px`;
        p.element.style.flex = '0 0 auto';
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

    // Save final heights for all panels that were part of the drag
    if (dragState.panels) {
        dragState.panels.forEach((p, i) => {
            if (p.id === 'follow') {
                // Ensure follow is back in flex-fill mode
                const eventsEl = document.getElementById('gameLogEvents');
                const savedScrollTop = eventsEl ? eventsEl.scrollTop : 0;
                setPanelState('follow', { height: null });
                if (eventsEl) {
                    requestAnimationFrame(() => {
                        eventsEl.scrollTop = savedScrollTop;
                    });
                }
            } else {
                setPanelState(p.id, { height: Math.round(dragState.heights[i]) });
            }
        });
    }

    // Reset drag state
    dragState = {
        active: false,
        panelId: null,
        panelElement: null,
        panels: null,
        heights: null,
        startHeights: null,
        draggedIndex: -1,
        startY: 0,
        lastClientY: 0
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
    
    // Mark as draggable - the grip icon is inline with the title
    titleBar.classList.add('draggable');
    
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
 * @returns {HTMLElement}
 */
function createPanelTitleBar(options) {
    const { panelId, title, showDragHandle = true } = options;

    const titleBar = document.createElement('div');
    titleBar.className = 'panel-title-bar';
    titleBar.dataset.panelId = panelId;

    // Title with optional inline grip icon for draggable panels
    const titleEl = document.createElement('span');
    titleEl.className = 'panel-title';
    titleEl.id = `panel-${panelId}-title`;
    if (showDragHandle) {
        titleEl.innerHTML = `<i class="fas fa-grip-vertical panel-grip-icon"></i><span class="panel-title-text">${title}</span>`;
    } else {
        titleEl.innerHTML = `<span class="panel-title-text">${title}</span>`;
    }
    titleBar.appendChild(titleEl);

    // Subtitle (shown when panel is small)
    const subtitleEl = document.createElement('span');
    subtitleEl.className = 'panel-subtitle';
    subtitleEl.id = `panel-${panelId}-subtitle`;
    titleBar.appendChild(subtitleEl);

    // Actions container (for O/D toggle injection, etc.)
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    titleBar.appendChild(actions);

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
        showDragHandle
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
        loadActiveTab();
        applyAllPanelStates();
        applyTabState();
        // Position slider after DOM is rendered
        requestAnimationFrame(() => updateSegmentedSlider());
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
    // Hide all non-game screens
    const screenIds = [
        'selectTeamScreen',
        'teamRosterScreen',
        'teamSettingsScreen',
        'gameSummaryScreen'
    ];

    screenIds.forEach(id => {
        const screen = document.getElementById(id);
        if (screen) {
            screen.style.display = 'none';
        }
    });

    // Also hide the header
    const header = document.querySelector('header');
    if (header) {
        header.style.display = 'none';
    }

    // Hide the controller role buttons sub-header
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
 * Uses the isActiveCoach() and isLineCoach() functions directly for accurate role checking.
 */
function updatePanelsForRole() {
    // Use the authoritative boolean role checks
    const hasActiveCoach = typeof window.isActiveCoach === 'function' && window.isActiveCoach();
    const hasLineCoach = typeof window.isLineCoach === 'function' && window.isLineCoach();
    const hasAnyRole = hasActiveCoach || hasLineCoach;

    // Viewer mode: show only game log with spectating badge
    const isViewerMode = typeof window.isViewer === 'function' && window.isViewer();
    if (isViewerMode) {
        setPanelVisible('roleButtons', true);
        const content = document.querySelector('#panel-roleButtons .panel-content');
        if (content) {
            content.innerHTML = '<div class="spectating-badge"><i class="fas fa-eye"></i> Spectating</div>';
        }
        setPanelVisible('playByPlay', false);
        setPanelVisible('selectLine', false);
        setPanelVisible('selectOLine', false);
        setPanelVisible('selectDLine', false);
        if (isPanelMinimized('follow')) {
            maximizePanel('follow', false);
        }
        return;
    }

    // Ensure coach panels are visible (viewer mode may have hidden them
    // in a previous session, and the hidden state persists in localStorage)
    setPanelVisible('playByPlay', true);
    const inSplitMode = typeof window.isSplitMode === 'function' && window.isSplitMode();
    if (!inSplitMode) {
        setPanelVisible('selectLine', true);
    }

    // Hide role buttons when solo coaching.
    // Server tracks how many coaches are actively polling this game.
    // Once we detect multiple coaches, latch visible for the session.
    const state = typeof getControllerState === 'function' ? getControllerState() : {};
    if ((state.connectedCoaches?.length || 0) > 1) {
        _multiCoachDetected = true;
    }
    setPanelVisible('roleButtons', _multiCoachDetected);

    // Play-by-Play panel disabled if not Active Coach (but has some other role)
    const playByPlayPanel = getPanelElement('playByPlay');
    if (playByPlayPanel) {
        playByPlayPanel.classList.toggle('disabled', !hasActiveCoach && hasLineCoach);
    }

    // Re-apply tab state so single-tab mode overrides the visibility changes above
    if (activeTab !== 'all') {
        applyTabState();
    }
}

/**
 * Update panels based on game state (during point vs between points)
 * No-op: panels are now resized solely by dragging.
 * @param {boolean} duringPoint - Whether a point is currently in progress
 */
function updatePanelsForGameState(duringPoint) {
    // No auto-resize — panels are drag-only
}

// =============================================================================
// Panel Subtitle Updates
// =============================================================================

/**
 * Update the subtitle for a panel (shown when minimized)
 * @param {string} panelId - Panel identifier
 * @param {string} text - Subtitle text
 */
function setPanelSubtitle(panelId, text, useHtml = false) {
    const subtitle = document.getElementById(`panel-${panelId}-subtitle`);
    if (subtitle) {
        if (useHtml) {
            subtitle.innerHTML = text || '';
        } else {
            subtitle.textContent = text || '';
        }
    }
}

/**
 * Set a panel's title text dynamically
 * @param {string} panelId - Panel identifier
 * @param {string} text - New title text
 */
function setPanelTitle(panelId, text) {
    const titleEl = document.getElementById(`panel-${panelId}-title`);
    if (titleEl) {
        const titleText = titleEl.querySelector('.panel-title-text');
        if (titleText) {
            titleText.textContent = text || '';
        }
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

// =============================================================================
// Tab System - Segmented Control Navigation
// =============================================================================

const TAB_STATE_KEY = 'breakside_active_tab';

// Current active tab: 'simple' | 'full' | 'line' | 'all' | 'log'
// (Legacy 'play' is migrated to 'simple' on load.)
let activeTab = 'all';

// Track which PBP tab the user last visited (Simple or Full). Used by the
// "Start Point" button on the Line tab to auto-navigate to the coach's
// preferred play-by-play surface (phase 6).
const LAST_PBP_TAB_KEY = 'breakside_last_pbp_tab';
let lastPbpTab = 'simple';

// Which panels belong to each tab. The Full tab uses its own dedicated
// panel (playByPlayFull); the All tab leaves it hidden and keeps Simple
// PBP only — screen real estate is too tight to fit Full alongside Line +
// Log without an iPad-class viewport.
const TAB_PANELS = {
    simple: ['playByPlay'],
    full:   ['playByPlayFull'],
    line:   ['selectLine'],
    all:    null, // null = show all panels with normal panel states
    log:    ['follow']
};

/**
 * Load active tab from localStorage. Migrates legacy 'play' value to
 * 'simple' (the new name for the simple-mode PBP tab).
 */
function loadActiveTab() {
    try {
        const saved = localStorage.getItem(TAB_STATE_KEY);
        if (saved === 'play') {
            activeTab = 'simple';
        } else if (saved && TAB_PANELS.hasOwnProperty(saved)) {
            activeTab = saved;
        }
        const savedLast = localStorage.getItem(LAST_PBP_TAB_KEY);
        if (savedLast === 'simple' || savedLast === 'full') {
            lastPbpTab = savedLast;
        }
    } catch (e) {
        activeTab = 'all';
    }
}

/**
 * Save active tab to localStorage
 */
function saveActiveTab() {
    try {
        localStorage.setItem(TAB_STATE_KEY, activeTab);
    } catch (e) {
        // ignore
    }
}

/**
 * Switch to a tab
 * @param {string} tabName - 'play' | 'line' | 'all' | 'log'
 */
function switchTab(tabName) {
    if (!TAB_PANELS.hasOwnProperty(tabName)) return;
    if (tabName === activeTab) return;

    activeTab = tabName;
    saveActiveTab();

    // Remember which PBP tab was last used so the Line tab's Start Point
    // button (phase 6) can auto-navigate back to it.
    if (tabName === 'simple' || tabName === 'full') {
        lastPbpTab = tabName;
        try { localStorage.setItem(LAST_PBP_TAB_KEY, tabName); } catch (e) { /* ignore */ }
    }

    applyTabState();
    updateSegmentedSlider();
}

/**
 * Apply the current tab state to panels
 * In 'all' mode, restore normal panel behavior.
 * In single-tab mode, show only that tab's panel(s) full-screen.
 */
function applyTabState() {
    // playByPlayFull is a content panel like the others, but only ever
    // visible in the Full tab — never in All. Listed here so the tab
    // switcher can hide/show it consistently with the rest.
    const contentPanels = ['playByPlay', 'playByPlayFull', 'selectLine', 'selectOLine', 'selectDLine', 'follow'];
    const inSplitMode = typeof window.isSplitMode === 'function' && window.isSplitMode();

    if (activeTab === 'all') {
        // Restore normal panel mode
        contentPanels.forEach(id => {
            const panel = getPanelElement(id);
            if (panel) panel.classList.remove('tab-fullscreen');
        });
        // Re-apply saved panel states (restores heights, visibility)
        applyAllPanelStates();
        // Respect split mode
        if (inSplitMode) {
            setPanelVisible('selectLine', false);
            setPanelVisible('selectOLine', true);
            setPanelVisible('selectDLine', true);
        } else {
            setPanelVisible('selectLine', true);
            setPanelVisible('selectOLine', false);
            setPanelVisible('selectDLine', false);
        }
        setPanelVisible('playByPlay', true);
        // All view keeps Simple-mode PBP only — Full panel stays hidden.
        setPanelVisible('playByPlayFull', false);
        setPanelVisible('follow', true);
    } else {
        // Single-tab mode: determine which panels to show
        let showPanels = [...(TAB_PANELS[activeTab] || [])];

        // Line tab: respect split mode
        if (activeTab === 'line' && inSplitMode) {
            showPanels = ['selectOLine', 'selectDLine'];
        }

        contentPanels.forEach(id => {
            const panel = getPanelElement(id);
            if (!panel) return;
            const shouldShow = showPanels.includes(id);
            panel.classList.toggle('hidden', !shouldShow);
            panel.classList.toggle('tab-fullscreen', shouldShow);
            if (shouldShow) {
                // Clear explicit height so flex-fill works
                panel.style.height = '';
                panel.style.flex = '1 1 auto';
            }
        });

        // Refresh the Full panel's content when it becomes visible so the
        // mode pill / "no active point" message reflect current state.
        if (activeTab === 'full' && window.fullPbp) {
            if (typeof window.fullPbp.wireEvents === 'function') window.fullPbp.wireEvents();
            if (typeof window.fullPbp.render === 'function') window.fullPbp.render();
        }

        // Log tab: auto-scroll the game log to the bottom so the most
        // recent events are visible immediately on tab entry. Without
        // this, switching to Log mid-game often shows stale content the
        // user has to scroll to dismiss.
        if (activeTab === 'log') {
            const eventsEl = document.getElementById('gameLogEvents');
            if (eventsEl) {
                requestAnimationFrame(() => {
                    eventsEl.scrollTop = eventsEl.scrollHeight;
                });
            }
        }
    }

    // Update segmented control button states
    const segControl = document.getElementById('headerSegControl');
    if (segControl) {
        segControl.querySelectorAll('button[data-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === activeTab);
        });
    }

    // After tab switch, update PBP layout if visible (it may now have more space)
    if (typeof updatePlayByPlayLayout === 'function') {
        requestAnimationFrame(() => updatePlayByPlayLayout());
    }
}

/**
 * Update the segmented control slider position
 */
function updateSegmentedSlider() {
    const slider = document.getElementById('headerSegSlider');
    const segControl = document.getElementById('headerSegControl');
    if (!slider || !segControl) return;

    const activeBtn = segControl.querySelector(`button[data-tab="${activeTab}"]`);
    if (!activeBtn) return;

    slider.style.left = activeBtn.offsetLeft + 'px';
    slider.style.width = activeBtn.offsetWidth + 'px';
}

/**
 * Get the current active tab
 * @returns {string}
 */
function getActiveTab() {
    return activeTab;
}

/**
 * Get the most recently visited PBP tab ('simple' or 'full').
 * Used by the Line-tab Start Point button (phase 6) to auto-navigate
 * back to the user's preferred play-by-play surface.
 */
function getLastPbpTab() {
    return lastPbpTab;
}

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
window.minimizePanel = minimizePanel;
window.maximizePanel = maximizePanel;
window.setPanelVisible = setPanelVisible;
window.setPanelSubtitle = setPanelSubtitle;
window.setPanelTitle = setPanelTitle;
window.resetPanelHeights = resetPanelHeights;
window.resetAllPanelStates = resetAllPanelStates;
window.updateExpandingPanel = updateExpandingPanel;

// Panel creation
window.createPanelTitleBar = createPanelTitleBar;
window.createPanelStub = createPanelStub;
window.createPanel = createPanel;

// Drag handling (exposed for testing/debugging)
window.isPanelDraggable = isPanelDraggable;
window.getDragMinHeight = getDragMinHeight;
window.DRAGGABLE_PANELS = DRAGGABLE_PANELS;
window.setFullyPhysicalPanelDragging = setFullyPhysicalPanelDragging;
window.getFullyPhysicalPanelDragging = function() { return fullyPhysicalPanelDragging; };
window.RESIZABLE_PANELS = RESIZABLE_PANELS;
window.PBP_MIN_CONTENT_HEIGHT = PBP_MIN_CONTENT_HEIGHT;
window.FOLLOW_MIN_HEIGHT = FOLLOW_MIN_HEIGHT;

// Multi-coach detection controls (latch for role button visibility)
window.resetMultiCoachDetected = function() { _multiCoachDetected = false; };
window.forceMultiCoachDetected = function() { _multiCoachDetected = true; };

// Game screen management
window.showGameScreen = showGameScreen;
window.hideGameScreen = hideGameScreen;
window.isGameScreenVisible = isGameScreenVisible;

// Role and state updates
window.updatePanelsForRole = updatePanelsForRole;
window.updatePanelsForGameState = updatePanelsForGameState;

// Tab system
window.switchTab = switchTab;
window.getActiveTab = getActiveTab;
window.getLastPbpTab = getLastPbpTab;
window.applyTabState = applyTabState;
window.updateSegmentedSlider = updateSegmentedSlider;

