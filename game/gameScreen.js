/*
 * Game Screen - Panel-Based In-Game UI Entry Point
 * Phase 6b: Panel Container Foundation
 * 
 * This module creates and manages the new panel-based in-game UI.
 * It replaces the screen-based navigation for in-game functionality.
 * 
 * Panel Layout (top to bottom):
 * 1. Header Panel - Team logo, score, timer
 * 2. Role Buttons Panel - Play-by-Play and Next Line role buttons
 * 3. Play-by-Play Panel - Score buttons, key play, etc.
 * 4. Select Next Line Panel - Player selection table
 * 5. Game Events Panel - End Game, Timeout, etc.
 * 6. Follow Panel - Event log (fills remaining space)
 */

// =============================================================================
// Game Screen State
// =============================================================================

let gameScreenInitialized = false;

// =============================================================================
// Header Panel Content
// =============================================================================

/**
 * Create the header panel content
 * @returns {HTMLElement}
 */
function createHeaderContent() {
    const content = document.createElement('div');
    content.className = 'header-content-row';
    
    content.innerHTML = `
        <button class="header-menu-btn" id="gameMenuBtn" title="Menu">
            <i class="fas fa-bars"></i>
        </button>
        
        <img src="images/logo.disc.only.png" alt="Breakside" class="header-logo" id="gameScreenLogo">
        
        <div class="header-score-display">
            <span class="header-score-us" id="gameScoreUs">0</span>
            <span class="header-score-separator">-</span>
            <span class="header-score-them" id="gameScoreThem">0</span>
        </div>
        
        <div class="header-timer-container" id="gameTimerContainer" title="Toggle timer mode">
            <span class="header-timer-value" id="gameTimerValue">0:00</span>
            <span class="header-timer-label" id="gameTimerLabel">point</span>
        </div>
    `;
    
    return content;
}

/**
 * Create the header panel
 * @returns {HTMLElement}
 */
function createHeaderPanel() {
    const panel = document.createElement('div');
    panel.id = 'panel-header';
    panel.className = 'game-panel panel-header';
    
    const titleBar = document.createElement('div');
    titleBar.className = 'panel-title-bar';
    titleBar.appendChild(createHeaderContent());
    panel.appendChild(titleBar);
    
    return panel;
}

// =============================================================================
// Role Buttons Panel Content
// =============================================================================

/**
 * Create the role buttons panel content
 * @returns {HTMLElement}
 */
function createRoleButtonsContent() {
    const content = document.createElement('div');
    content.className = 'panel-content';
    content.style.padding = '6px 8px';
    content.style.display = 'flex';
    content.style.gap = '6px';
    
    content.innerHTML = `
        <button id="gameActiveCoachBtn" class="role-claim-btn" title="Play-by-Play Control">
            <span class="role-claim-label">Play-by-Play</span>
            <span id="gameActiveCoachHolder" class="role-claim-holder">Available</span>
        </button>
        <button id="gameLineCoachBtn" class="role-claim-btn" title="Next Line Control">
            <span class="role-claim-label">Next Line</span>
            <span id="gameLineCoachHolder" class="role-claim-holder">Available</span>
        </button>
    `;
    
    return content;
}

/**
 * Create the role buttons panel
 * @returns {HTMLElement}
 */
function createRoleButtonsPanel() {
    const panel = document.createElement('div');
    panel.id = 'panel-roleButtons';
    panel.className = 'game-panel panel-role-buttons';
    
    panel.appendChild(createRoleButtonsContent());
    
    return panel;
}

// =============================================================================
// Stub Panels with Legacy Screen Links
// =============================================================================

/**
 * Create the Play-by-Play panel with stub content
 * @returns {HTMLElement}
 */
function createPlayByPlayPanel() {
    return createPanel({
        id: 'playByPlay',
        title: 'Play-by-Play',
        stubOptions: {
            icon: 'fa-futbol',
            text: 'Score tracking and play-by-play controls will appear here.',
            legacyScreen: 'simpleModeScreen',
            legacyLabel: 'Use Simple Mode'
        }
    });
}

/**
 * Create the Select Next Line panel with stub content
 * @returns {HTMLElement}
 */
function createSelectLinePanel() {
    return createPanel({
        id: 'selectLine',
        title: 'Select Next Line',
        stubOptions: {
            icon: 'fa-users',
            text: 'Player selection table will appear here.',
            legacyScreen: 'beforePointScreen',
            legacyLabel: 'Use Player Selection'
        }
    });
}

// Game Events panel removed - will be a modal popup from Play-by-Play panel
// See TODO.md for implementation plan

/**
 * Create the Follow panel with stub content
 * @returns {HTMLElement}
 */
function createFollowPanel() {
    const panel = createPanel({
        id: 'follow',
        className: 'fills-remaining',
        title: 'Game Log',
        stubOptions: {
            icon: 'fa-list',
            text: 'Live game event log will appear here. Viewers and idle coaches see this panel maximized.'
        }
    });
    
    return panel;
}

// =============================================================================
// Game Screen Container
// =============================================================================

/**
 * Build the complete game screen container
 * @returns {HTMLElement}
 */
function buildGameScreenContainer() {
    const container = document.createElement('div');
    container.id = 'gameScreenContainer';
    container.className = 'game-screen-container';
    
    // Panel stack
    const stack = document.createElement('div');
    stack.className = 'panel-stack';
    
    // Add all panels in order
    // Note: Game Events is now a modal popup from Play-by-Play, not a panel
    stack.appendChild(createHeaderPanel());
    stack.appendChild(createRoleButtonsPanel());
    stack.appendChild(createPlayByPlayPanel());
    stack.appendChild(createSelectLinePanel());
    stack.appendChild(createFollowPanel());
    
    container.appendChild(stack);
    
    return container;
}

/**
 * Initialize the game screen
 * Creates the container and adds it to the DOM
 */
function initGameScreen() {
    if (gameScreenInitialized) {
        console.log('🎮 Game screen already initialized');
        return;
    }
    
    // Build and insert container
    const container = buildGameScreenContainer();
    document.body.appendChild(container);
    
    // Wire up event handlers
    wireGameScreenEvents();
    
    gameScreenInitialized = true;
    console.log('🎮 Game screen initialized');
}

// =============================================================================
// Event Wiring
// =============================================================================

/**
 * Wire up all game screen event handlers
 */
function wireGameScreenEvents() {
    // Menu button
    const menuBtn = document.getElementById('gameMenuBtn');
    if (menuBtn) {
        menuBtn.addEventListener('click', handleGameMenuClick);
    }
    
    // Timer toggle
    const timerContainer = document.getElementById('gameTimerContainer');
    if (timerContainer) {
        timerContainer.addEventListener('click', handleTimerToggle);
    }
    
    // Role buttons
    const activeCoachBtn = document.getElementById('gameActiveCoachBtn');
    const lineCoachBtn = document.getElementById('gameLineCoachBtn');
    
    if (activeCoachBtn) {
        activeCoachBtn.addEventListener('click', () => {
            if (typeof handleActiveCoachClick === 'function') {
                handleActiveCoachClick();
            }
        });
    }
    
    if (lineCoachBtn) {
        lineCoachBtn.addEventListener('click', () => {
            if (typeof handleLineCoachClick === 'function') {
                handleLineCoachClick();
            }
        });
    }
}

/**
 * Handle menu button click
 */
function handleGameMenuClick() {
    // For now, just exit to legacy before point screen
    hideGameScreen();
    if (typeof showScreen === 'function') {
        showScreen('beforePointScreen');
    }
}

/**
 * Handle timer toggle click
 */
let timerMode = 'point'; // 'point' or 'game'
function handleTimerToggle() {
    timerMode = timerMode === 'point' ? 'game' : 'point';
    updateTimerDisplay();
}

// =============================================================================
// UI Updates
// =============================================================================

/**
 * Update the score display in the header
 * @param {number} usScore - Our team's score
 * @param {number} themScore - Opponent's score
 */
function updateGameScreenScore(usScore, themScore) {
    const usEl = document.getElementById('gameScoreUs');
    const themEl = document.getElementById('gameScoreThem');
    
    if (usEl) usEl.textContent = usScore;
    if (themEl) themEl.textContent = themScore;
}

/**
 * Update the timer display
 */
function updateTimerDisplay() {
    const valueEl = document.getElementById('gameTimerValue');
    const labelEl = document.getElementById('gameTimerLabel');
    
    if (!valueEl || !labelEl) return;
    
    labelEl.textContent = timerMode;
    
    // Get appropriate time value based on mode
    if (timerMode === 'point') {
        // Show point timer
        if (typeof currentPoint !== 'undefined' && currentPoint && currentPoint.startTimestamp) {
            const elapsed = Math.floor((Date.now() - new Date(currentPoint.startTimestamp).getTime()) / 1000);
            valueEl.textContent = formatTime(elapsed);
        } else {
            valueEl.textContent = '0:00';
        }
    } else {
        // Show game timer
        if (typeof currentGame !== 'undefined' && currentGame && typeof currentGame === 'function') {
            const game = currentGame();
            if (game && game.startTimestamp) {
                const elapsed = Math.floor((Date.now() - new Date(game.startTimestamp).getTime()) / 1000);
                valueEl.textContent = formatTime(elapsed);
            } else {
                valueEl.textContent = '0:00';
            }
        } else {
            valueEl.textContent = '0:00';
        }
    }
}

/**
 * Format seconds as M:SS or MM:SS
 * @param {number} seconds - Total seconds
 * @returns {string}
 */
function formatTime(seconds) {
    const mins = Math.floor(Math.abs(seconds) / 60);
    const secs = Math.abs(seconds) % 60;
    const sign = seconds < 0 ? '-' : '';
    return `${sign}${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Update role button states in the game screen
 * Called when controller state changes
 * @param {object} state - Controller state
 */
function updateGameScreenRoleButtons(state) {
    const activeBtn = document.getElementById('gameActiveCoachBtn');
    const lineBtn = document.getElementById('gameLineCoachBtn');
    const activeHolder = document.getElementById('gameActiveCoachHolder');
    const lineHolder = document.getElementById('gameLineCoachHolder');
    
    if (!activeBtn || !lineBtn) return;
    
    const myUserId = typeof getCurrentUserId === 'function' ? getCurrentUserId() : null;
    
    // Update Active Coach button
    const iAmActiveCoach = state.activeCoach?.userId === myUserId;
    activeBtn.classList.remove('has-role', 'other-has-role', 'pending-handoff');
    
    if (iAmActiveCoach) {
        activeBtn.classList.add('has-role');
        if (activeHolder) activeHolder.textContent = 'You';
    } else if (state.pendingHandoff?.role === 'activeCoach' && state.pendingHandoff?.requesterId === myUserId) {
        activeBtn.classList.add('pending-handoff');
        if (activeHolder) activeHolder.textContent = 'Requesting...';
    } else if (state.activeCoach) {
        activeBtn.classList.add('other-has-role');
        if (activeHolder) activeHolder.textContent = state.activeCoach.displayName || 'Someone';
    } else {
        if (activeHolder) activeHolder.textContent = 'Available';
    }
    
    // Update Line Coach button
    const iAmLineCoach = state.lineCoach?.userId === myUserId;
    lineBtn.classList.remove('has-role', 'other-has-role', 'pending-handoff');
    
    if (iAmLineCoach) {
        lineBtn.classList.add('has-role');
        if (lineHolder) lineHolder.textContent = 'You';
    } else if (state.pendingHandoff?.role === 'lineCoach' && state.pendingHandoff?.requesterId === myUserId) {
        lineBtn.classList.add('pending-handoff');
        if (lineHolder) lineHolder.textContent = 'Requesting...';
    } else if (state.lineCoach) {
        lineBtn.classList.add('other-has-role');
        if (lineHolder) lineHolder.textContent = state.lineCoach.displayName || 'Someone';
    } else {
        if (lineHolder) lineHolder.textContent = 'Available';
    }
}

// =============================================================================
// Timer Update Loop
// =============================================================================

let timerUpdateInterval = null;

/**
 * Start the timer update loop
 */
function startGameScreenTimerLoop() {
    if (timerUpdateInterval) return;
    
    timerUpdateInterval = setInterval(() => {
        if (isGameScreenVisible()) {
            updateTimerDisplay();
        }
    }, 1000);
}

/**
 * Stop the timer update loop
 */
function stopGameScreenTimerLoop() {
    if (timerUpdateInterval) {
        clearInterval(timerUpdateInterval);
        timerUpdateInterval = null;
    }
}

// =============================================================================
// Game Screen Entry Point
// =============================================================================

/**
 * Enter the new game screen UI
 * Called when starting a point or entering a game
 */
function enterGameScreen() {
    // Initialize if needed
    if (!gameScreenInitialized) {
        initGameScreen();
    }
    
    // Show the game screen
    showGameScreen();
    
    // Update displays
    if (typeof currentGame !== 'undefined') {
        let game;
        if (typeof currentGame === 'function') {
            game = currentGame();
        } else {
            game = currentGame;
        }
        if (game) {
            updateGameScreenScore(game.teamScore || 0, game.opponentScore || 0);
        }
    }
    
    // Start timer updates
    startGameScreenTimerLoop();
    
    // Update role buttons from controller state
    if (typeof getControllerState === 'function') {
        const state = getControllerState();
        updateGameScreenRoleButtons(state);
        updatePanelsForRole(state.myRole);
    }
    
    console.log('🎮 Entered game screen');
}

/**
 * Exit the game screen UI
 * Returns to legacy navigation
 */
function exitGameScreen() {
    hideGameScreen();
    stopGameScreenTimerLoop();
    console.log('🎮 Exited game screen');
}

// =============================================================================
// Integration with Controller State
// =============================================================================

// Hook into controller state updates if available
const originalUpdateControllerUI = window.updateControllerUI;
window.updateControllerUI = function(state, previousState) {
    // Call original if it exists
    if (typeof originalUpdateControllerUI === 'function') {
        originalUpdateControllerUI(state, previousState);
    }
    
    // Update game screen role buttons
    if (isGameScreenVisible()) {
        updateGameScreenRoleButtons(state);
        updatePanelsForRole(state.myRole);
    }
};

// =============================================================================
// Exports
// =============================================================================

window.initGameScreen = initGameScreen;
window.enterGameScreen = enterGameScreen;
window.exitGameScreen = exitGameScreen;
window.updateGameScreenScore = updateGameScreenScore;
window.updateGameScreenRoleButtons = updateGameScreenRoleButtons;
window.isGameScreenVisible = isGameScreenVisible;

