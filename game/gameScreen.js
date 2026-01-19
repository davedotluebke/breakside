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

// Max team name length that fits in the score display
const MAX_TEAM_NAME_LENGTH = 6;

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
        
        <div class="header-logo-container">
            <img src="images/logo.disc.only.png" alt="Breakside" class="header-logo" id="gameScreenLogo">
            <span class="header-version-overlay" id="gameVersionOverlay"></span>
        </div>
        
        <div class="header-score-display">
            <div class="header-team-identity header-team-us" id="headerTeamUs">
                <span class="team-identity-text">Us</span>
            </div>
            <span class="header-score-value header-score-us" id="gameScoreUs">0</span>
            <span class="header-score-separator">–</span>
            <span class="header-score-value header-score-them" id="gameScoreThem">0</span>
            <div class="header-team-identity header-team-them" id="headerTeamThem">
                <span class="team-identity-text">Them</span>
            </div>
        </div>
        
        <div class="header-timer-container" id="gameTimerContainer" title="Toggle timer mode">
            <span class="header-timer-value" id="gameTimerValue">0:00</span>
            <span class="header-timer-label" id="gameTimerLabel">point</span>
            <button class="header-timer-pause-btn" id="gameTimerPauseBtn" title="Pause/Resume">
                <i class="fas fa-pause"></i>
            </button>
        </div>
    `;
    
    return content;
}

// Track whether to show icon or symbol for our team (tap to toggle)
let showTeamIcon = true;

/**
 * Get the team identity display for the header
 * Shows EITHER icon OR symbol (tappable to toggle between them)
 * Fallback priority: icon > symbol > short name > "Us"
 * @param {Object} team - Team object (may have name, teamSymbol, iconUrl)
 * @param {string} fallback - Fallback text ("Us" or "Them")
 * @returns {Object} { html: string, canToggle: boolean }
 */
function getTeamIdentityDisplay(team, fallback) {
    if (!team) {
        return { html: `<span class="team-identity-text team-identity-fallback">${fallback}</span>`, canToggle: false };
    }
    
    const hasIcon = !!team.iconUrl;
    const hasSymbol = !!team.teamSymbol;
    const hasShortName = team.name && team.name.length <= MAX_TEAM_NAME_LENGTH;
    
    // If we have both icon and symbol, show based on toggle state
    if (hasIcon && hasSymbol) {
        if (showTeamIcon) {
            return {
                html: `<img src="${team.iconUrl}" alt="${team.name}" class="team-identity-icon-large" onerror="this.parentElement.click()">`,
                canToggle: true
            };
        } else {
            return {
                html: `<span class="team-identity-symbol-large">${team.teamSymbol}</span>`,
                canToggle: true
            };
        }
    }
    
    // Only icon available
    if (hasIcon) {
        return { 
            html: `<img src="${team.iconUrl}" alt="${team.name}" class="team-identity-icon-large" onerror="this.style.display='none'">`,
            canToggle: false 
        };
    }
    
    // Only symbol available
    if (hasSymbol) {
        return { html: `<span class="team-identity-symbol-large">${team.teamSymbol}</span>`, canToggle: false };
    }
    
    // Short team name
    if (hasShortName) {
        return { html: `<span class="team-identity-text">${team.name}</span>`, canToggle: false };
    }
    
    // Fallback
    return { html: `<span class="team-identity-text team-identity-fallback">${fallback}</span>`, canToggle: false };
}

/**
 * Get opponent identity display for the header
 * Opponent doesn't have icon, so: (1) Name if ≤6 chars (large), (2) "Them" (small fallback)
 * @param {string} opponentName - Opponent name from game
 * @returns {Object} { html: string }
 */
function getOpponentIdentityDisplay(opponentName) {
    if (opponentName && opponentName.length <= MAX_TEAM_NAME_LENGTH) {
        // Use large symbol style for short opponent names to match team symbol size
        return { html: `<span class="team-identity-symbol-large">${opponentName}</span>` };
    }
    return { html: `<span class="team-identity-text team-identity-fallback">Them</span>` };
}

/**
 * Toggle between icon and symbol display for our team
 */
function toggleTeamIdentityDisplay() {
    showTeamIcon = !showTeamIcon;
    updateHeaderTeamIdentities();
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

// =============================================================================
// Play-by-Play Panel Content
// =============================================================================

/**
 * Create the Play-by-Play panel content
 * Three layout modes (based on panel height):
 * - Expanded (vertical): Large buttons stacked vertically, like legacy Simple Mode
 * - Medium: Score buttons row + Key Play with action buttons row
 * - Compact (horizontal): Single row with all buttons
 * @returns {HTMLElement}
 */
function createPlayByPlayContent() {
    const content = document.createElement('div');
    content.className = 'pbp-panel-content layout-compact';
    
    content.innerHTML = `
        <div class="pbp-score-row">
            <button id="pbpWeScoreBtn" class="pbp-btn pbp-btn-score pbp-btn-us" title="We Score">
                <i class="fas fa-plus-circle"></i>
                <span class="pbp-btn-label">We Score</span>
            </button>
            <button id="pbpTheyScoreBtn" class="pbp-btn pbp-btn-score pbp-btn-them" title="They Score">
                <i class="fas fa-minus-circle"></i>
                <span class="pbp-btn-label">They Score</span>
            </button>
        </div>
        <div class="pbp-secondary-row">
            <button id="pbpKeyPlayBtn" class="pbp-btn pbp-btn-secondary" title="Key Play">
                <i class="fas fa-star"></i>
                <span class="pbp-btn-label">Key Play</span>
            </button>
            <button id="pbpUndoBtn" class="pbp-btn pbp-btn-action" title="Undo">
                <i class="fas fa-undo"></i>
                <span class="pbp-btn-label">Undo</span>
            </button>
            <button id="pbpSubPlayersBtn" class="pbp-btn pbp-btn-action" title="Sub Players">
                <i class="fas fa-exchange-alt"></i>
                <span class="pbp-btn-label">Sub</span>
            </button>
            <button id="pbpGameEventsBtn" class="pbp-btn pbp-btn-action" title="Game Events">
                <i class="fas fa-flag"></i>
                <span class="pbp-btn-label">Events</span>
            </button>
            <button id="pbpMoreBtn" class="pbp-btn pbp-btn-more" title="More Options">
                <i class="fas fa-ellipsis-h"></i>
            </button>
        </div>
    `;
    
    return content;
}

/**
 * Create the Play-by-Play panel with actual content
 * Note: No drag handle - this panel's title bar is not draggable
 * @returns {HTMLElement}
 */
function createPlayByPlayPanel() {
    const panel = document.createElement('div');
    panel.id = 'panel-playByPlay';
    panel.className = 'game-panel panel-playByPlay';
    
    // Create title bar (no drag handle - panels above aren't resizable)
    const titleBar = createPanelTitleBar({
        panelId: 'playByPlay',
        title: 'Play-by-Play',
        showDragHandle: false,
        showExpandBtn: true
    });
    panel.appendChild(titleBar);
    
    // Create content area
    const contentArea = document.createElement('div');
    contentArea.className = 'panel-content';
    contentArea.id = 'panel-playByPlay-content';
    contentArea.appendChild(createPlayByPlayContent());
    panel.appendChild(contentArea);
    
    return panel;
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
 * Create the Game Log panel content
 * @returns {HTMLElement}
 */
function createGameLogContent() {
    const content = document.createElement('div');
    content.className = 'game-log-content';
    
    content.innerHTML = `
        <div class="game-log-status" id="gameLogStatus">
            <div class="game-log-teams">
                <span class="game-log-team-us" id="gameLogTeamUs">Us</span>
                <span class="game-log-vs">vs</span>
                <span class="game-log-team-them" id="gameLogTeamThem">Them</span>
            </div>
            <div class="game-log-score" id="gameLogScore">0 – 0</div>
        </div>
        <div class="game-log-events" id="gameLogEvents">
            <div class="game-log-placeholder">
                <i class="fas fa-list"></i>
                <span>Game events will appear here</span>
            </div>
        </div>
    `;
    
    return content;
}

/**
 * Create the Game Log (Follow) panel with actual content
 * @returns {HTMLElement}
 */
function createFollowPanel() {
    const panel = document.createElement('div');
    panel.id = 'panel-follow';
    panel.className = 'game-panel panel-follow fills-remaining';
    
    // Create title bar
    const titleBar = createPanelTitleBar({
        panelId: 'follow',
        title: 'Game Log',
        showDragHandle: true,
        showExpandBtn: true
    });
    panel.appendChild(titleBar);
    
    // Create content area
    const contentArea = document.createElement('div');
    contentArea.className = 'panel-content';
    contentArea.id = 'panel-follow-content';
    contentArea.appendChild(createGameLogContent());
    panel.appendChild(contentArea);
    
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

// Version overlay timeout
let gameVersionTimeout = null;

/**
 * Wire up all game screen event handlers
 */
function wireGameScreenEvents() {
    // Menu button
    const menuBtn = document.getElementById('gameMenuBtn');
    if (menuBtn) {
        menuBtn.addEventListener('click', handleGameMenuClick);
    }
    
    // Wire up Play-by-Play panel events
    wirePlayByPlayEvents();
    
    // Logo tap - show version
    const logo = document.getElementById('gameScreenLogo');
    const versionOverlay = document.getElementById('gameVersionOverlay');
    if (logo && versionOverlay) {
        logo.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Clear any existing timeout
            if (gameVersionTimeout) {
                clearTimeout(gameVersionTimeout);
            }
            
            // Show version
            const versionText = typeof appVersion !== 'undefined' && appVersion
                ? `v${appVersion.version} (${appVersion.build})`
                : 'v?.?.?';
            versionOverlay.textContent = versionText;
            versionOverlay.classList.add('visible');
            
            // Hide after 3 seconds
            gameVersionTimeout = setTimeout(() => {
                versionOverlay.classList.remove('visible');
            }, 3000);
        });
    }
    
    // Timer toggle (clicking on timer value/label area)
    const timerContainer = document.getElementById('gameTimerContainer');
    if (timerContainer) {
        timerContainer.addEventListener('click', (e) => {
            // Only toggle if not clicking the pause button
            if (!e.target.closest('.header-timer-pause-btn')) {
                handleTimerToggle();
            }
        });
    }
    
    // Timer pause button
    const pauseBtn = document.getElementById('gameTimerPauseBtn');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', handleTimerPauseClick);
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
 * Handle timer toggle click (tapping on timer value)
 */
let timerMode = 'point'; // 'point' or 'game'
let pointTimerPaused = false;
let pointPausedAt = null;  // When the timer was paused

function handleTimerToggle() {
    timerMode = timerMode === 'point' ? 'game' : 'point';
    updateTimerDisplay();
    updateTimerPauseButton();
}

/**
 * Handle timer pause/resume button click
 */
function handleTimerPauseClick(e) {
    e.stopPropagation(); // Don't trigger timer mode toggle
    
    if (timerMode !== 'point') {
        // Game clock cannot be paused
        return;
    }
    
    const point = getCurrentPoint();
    if (!point || !point.startTimestamp) {
        // No active point, nothing to pause
        return;
    }
    
    if (pointTimerPaused) {
        // Resume: add paused duration to totalPointTime
        if (pointPausedAt && point.lastPauseTime) {
            const pausedDuration = Date.now() - new Date(point.lastPauseTime).getTime();
            point.totalPointTime = (point.totalPointTime || 0) + pausedDuration;
        }
        point.lastPauseTime = null;
        pointTimerPaused = false;
        pointPausedAt = null;
    } else {
        // Pause: record pause time
        point.lastPauseTime = new Date().toISOString();
        pointTimerPaused = true;
        pointPausedAt = Date.now();
    }
    
    updateTimerPauseButton();
    updateTimerDisplay();
    
    // Save the change
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

/**
 * Update pause button visibility and state
 */
function updateTimerPauseButton() {
    const pauseBtn = document.getElementById('gameTimerPauseBtn');
    if (!pauseBtn) return;
    
    // Only show pause button for point timer
    if (timerMode !== 'point') {
        pauseBtn.style.display = 'none';
        return;
    }
    
    pauseBtn.style.display = 'flex';
    const icon = pauseBtn.querySelector('i');
    if (icon) {
        icon.className = pointTimerPaused ? 'fas fa-play' : 'fas fa-pause';
    }
    pauseBtn.classList.toggle('paused', pointTimerPaused);
}

/**
 * Get the current point from the game
 * @returns {Point|null}
 */
function getCurrentPoint() {
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    
    if (game && game.points && game.points.length > 0) {
        return game.points[game.points.length - 1];
    }
    return null;
}

/**
 * Auto-resume point timer when a play-by-play event is recorded
 * Call this from event handlers
 */
function autoResumePointTimer() {
    if (pointTimerPaused) {
        const point = getCurrentPoint();
        if (point && point.lastPauseTime) {
            const pausedDuration = Date.now() - new Date(point.lastPauseTime).getTime();
            point.totalPointTime = (point.totalPointTime || 0) + pausedDuration;
            point.lastPauseTime = null;
        }
        pointTimerPaused = false;
        pointPausedAt = null;
        updateTimerPauseButton();
    }
}

// Export for use by play-by-play handlers
window.autoResumePointTimer = autoResumePointTimer;

// =============================================================================
// Play-by-Play Panel Events
// =============================================================================

// Track expanded state of Play-by-Play panel
let pbpExpandedRowVisible = false;

/**
 * Wire up Play-by-Play panel event handlers
 */
function wirePlayByPlayEvents() {
    // We Score button
    const weScoreBtn = document.getElementById('pbpWeScoreBtn');
    if (weScoreBtn) {
        weScoreBtn.addEventListener('click', handlePbpWeScore);
    }
    
    // They Score button
    const theyScoreBtn = document.getElementById('pbpTheyScoreBtn');
    if (theyScoreBtn) {
        theyScoreBtn.addEventListener('click', handlePbpTheyScore);
    }
    
    // Key Play button
    const keyPlayBtn = document.getElementById('pbpKeyPlayBtn');
    if (keyPlayBtn) {
        keyPlayBtn.addEventListener('click', handlePbpKeyPlay);
    }
    
    // More button (toggle expanded row)
    const moreBtn = document.getElementById('pbpMoreBtn');
    if (moreBtn) {
        moreBtn.addEventListener('click', togglePbpExpandedRow);
    }
    
    // Undo button
    const undoBtn = document.getElementById('pbpUndoBtn');
    if (undoBtn) {
        undoBtn.addEventListener('click', handlePbpUndo);
    }
    
    // Sub Players button
    const subPlayersBtn = document.getElementById('pbpSubPlayersBtn');
    if (subPlayersBtn) {
        subPlayersBtn.addEventListener('click', handlePbpSubPlayers);
    }
    
    // Game Events button
    const gameEventsBtn = document.getElementById('pbpGameEventsBtn');
    if (gameEventsBtn) {
        gameEventsBtn.addEventListener('click', handlePbpGameEvents);
    }
}

/**
 * Toggle the action buttons visibility in compact mode
 * In compact mode, the "..." button shows/hides the action buttons
 */
function togglePbpExpandedRow() {
    const content = document.querySelector('.pbp-panel-content');
    const moreBtn = document.getElementById('pbpMoreBtn');
    
    if (content) {
        pbpExpandedRowVisible = !pbpExpandedRowVisible;
        content.classList.toggle('show-actions', pbpExpandedRowVisible);
    }
    
    if (moreBtn) {
        moreBtn.classList.toggle('active', pbpExpandedRowVisible);
        const icon = moreBtn.querySelector('i');
        if (icon) {
            icon.className = pbpExpandedRowVisible ? 'fas fa-chevron-up' : 'fas fa-ellipsis-h';
        }
    }
}

/**
 * Handle "We Score" button click
 * Shows score attribution dialog from existing simpleModeScreen.js
 */
function handlePbpWeScore() {
    // Check if user has Active Coach role
    if (!canEditPlayByPlayPanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need Play-by-Play control to record scores', 'warning');
        }
        return;
    }
    
    // Auto-resume timer if paused
    autoResumePointTimer();
    
    // Stop the point timer
    const point = getCurrentPoint();
    if (point && point.startTimestamp) {
        point.totalPointTime = (point.totalPointTime || 0) + (Date.now() - new Date(point.startTimestamp).getTime());
        point.startTimestamp = null;
    }
    
    // Use the existing score attribution dialog from simpleModeScreen.js
    if (typeof showScoreAttributionDialog === 'function') {
        showScoreAttributionDialog();
    } else {
        console.warn('showScoreAttributionDialog not available');
    }
}

/**
 * Handle "They Score" button click
 */
function handlePbpTheyScore() {
    // Check if user has Active Coach role
    if (!canEditPlayByPlayPanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need Play-by-Play control to record scores', 'warning');
        }
        return;
    }
    
    // Auto-resume timer if paused
    autoResumePointTimer();
    
    // Stop the point timer
    const point = getCurrentPoint();
    if (point && point.startTimestamp) {
        point.totalPointTime = (point.totalPointTime || 0) + (Date.now() - new Date(point.startTimestamp).getTime());
        point.startTimestamp = null;
    }
    
    // Update score and move to next point
    if (typeof updateScore === 'function' && typeof Role !== 'undefined') {
        updateScore(Role.OPPONENT);
    }
    
    if (typeof moveToNextPoint === 'function') {
        moveToNextPoint();
    }
}

/**
 * Handle "Key Play" button click
 * Opens the existing key play dialog
 */
function handlePbpKeyPlay() {
    // Check if user has Active Coach role
    if (!canEditPlayByPlayPanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need Play-by-Play control to record key plays', 'warning');
        }
        return;
    }
    
    // Use existing key play dialog from keyPlayDialog.js
    if (typeof showKeyPlayDialog === 'function') {
        showKeyPlayDialog();
    } else {
        console.warn('showKeyPlayDialog not available');
    }
}

/**
 * Handle "Undo" button click
 */
function handlePbpUndo() {
    // Check if user has Active Coach role
    if (!canEditPlayByPlayPanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need Play-by-Play control to undo', 'warning');
        }
        return;
    }
    
    // Use existing undo functionality
    if (typeof handleUndo === 'function') {
        handleUndo();
    } else {
        console.warn('handleUndo not available');
    }
}

/**
 * Handle "Sub Players" button click
 * Opens modal for mid-point injury substitutions
 */
function handlePbpSubPlayers() {
    // Check if user has Active Coach role
    if (!canEditPlayByPlayPanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need Play-by-Play control to sub players', 'warning');
        }
        return;
    }
    
    // TODO: Implement mid-point substitution modal
    if (typeof showControllerToast === 'function') {
        showControllerToast('Mid-point substitutions coming soon', 'info');
    }
}

/**
 * Handle "Game Events" button click
 * Opens modal with End Game, Timeout, Half Time, Switch Sides
 */
function handlePbpGameEvents() {
    // Check if user has Active Coach role
    if (!canEditPlayByPlayPanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need Play-by-Play control to manage game events', 'warning');
        }
        return;
    }
    
    showGameEventsModal();
}

/**
 * Check if current user can edit play-by-play
 * Uses the global canEditPlayByPlay from controllerState.js if available
 * @returns {boolean}
 */
function canEditPlayByPlayPanel() {
    // Use the global canEditPlayByPlay from controllerState.js
    if (typeof window.canEditPlayByPlay === 'function') {
        return window.canEditPlayByPlay();
    }
    // Fallback: check if we have Active Coach role
    if (typeof getMyControllerRole === 'function') {
        const role = getMyControllerRole();
        // Note: role could be 'activeCoach', 'lineCoach', or 'both'
        return role === 'activeCoach' || role === 'both';
    }
    // If controller system not available, allow (offline mode)
    return true;
}

/**
 * Show the Game Events modal
 */
function showGameEventsModal() {
    // Check if modal already exists
    let modal = document.getElementById('gameEventsModal');
    if (!modal) {
        modal = createGameEventsModal();
        document.body.appendChild(modal);
    }
    
    // Update button states based on game state
    updateGameEventsModalState();
    
    // Show modal
    modal.style.display = 'flex';
}

/**
 * Create the Game Events modal
 * @returns {HTMLElement}
 */
function createGameEventsModal() {
    const modal = document.createElement('div');
    modal.id = 'gameEventsModal';
    modal.className = 'modal game-events-modal';
    
    modal.innerHTML = `
        <div class="modal-content game-events-modal-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>Game Events</h2>
                <span class="close" id="gameEventsModalClose">&times;</span>
            </div>
            <div class="game-events-buttons">
                <button id="geTimeoutBtn" class="ge-btn ge-btn-timeout">
                    <i class="fas fa-hand-paper"></i>
                    <span>Timeout</span>
                </button>
                <button id="geHalfTimeBtn" class="ge-btn ge-btn-halftime">
                    <i class="fas fa-pause-circle"></i>
                    <span>Half Time</span>
                </button>
                <button id="geSwitchSidesBtn" class="ge-btn ge-btn-switch">
                    <i class="fas fa-exchange-alt"></i>
                    <span>Switch Sides</span>
                </button>
                <button id="geEndGameBtn" class="ge-btn ge-btn-endgame">
                    <i class="fas fa-flag-checkered"></i>
                    <span>End Game</span>
                </button>
            </div>
        </div>
    `;
    
    // Wire up modal events
    const closeBtn = modal.querySelector('#gameEventsModalClose');
    if (closeBtn) {
        closeBtn.addEventListener('click', hideGameEventsModal);
    }
    
    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            hideGameEventsModal();
        }
    });
    
    // Timeout button
    const timeoutBtn = modal.querySelector('#geTimeoutBtn');
    if (timeoutBtn) {
        timeoutBtn.addEventListener('click', handleGameEventTimeout);
    }
    
    // Half Time button
    const halfTimeBtn = modal.querySelector('#geHalfTimeBtn');
    if (halfTimeBtn) {
        halfTimeBtn.addEventListener('click', handleGameEventHalfTime);
    }
    
    // Switch Sides button
    const switchSidesBtn = modal.querySelector('#geSwitchSidesBtn');
    if (switchSidesBtn) {
        switchSidesBtn.addEventListener('click', handleGameEventSwitchSides);
    }
    
    // End Game button
    const endGameBtn = modal.querySelector('#geEndGameBtn');
    if (endGameBtn) {
        endGameBtn.addEventListener('click', handleGameEventEndGame);
    }
    
    return modal;
}

/**
 * Hide the Game Events modal
 */
function hideGameEventsModal() {
    const modal = document.getElementById('gameEventsModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Update Game Events modal button states based on current game state
 */
function updateGameEventsModalState() {
    const point = getCurrentPoint();
    const duringPoint = point && point.startTimestamp && !point.endTimestamp;
    
    // Timeout: available anytime
    const timeoutBtn = document.getElementById('geTimeoutBtn');
    if (timeoutBtn) {
        timeoutBtn.disabled = false;
        timeoutBtn.classList.remove('disabled');
    }
    
    // Half Time, Switch Sides, End Game: only between points
    const halfTimeBtn = document.getElementById('geHalfTimeBtn');
    const switchSidesBtn = document.getElementById('geSwitchSidesBtn');
    const endGameBtn = document.getElementById('geEndGameBtn');
    
    [halfTimeBtn, switchSidesBtn, endGameBtn].forEach(btn => {
        if (btn) {
            btn.disabled = duringPoint;
            btn.classList.toggle('disabled', duringPoint);
        }
    });
}

/**
 * Handle Timeout game event
 */
function handleGameEventTimeout() {
    if (typeof showControllerToast === 'function') {
        showControllerToast('Timeout called', 'info');
    }
    
    // Log the event (future: add to game log)
    console.log('Game Event: Timeout');
    
    hideGameEventsModal();
}

/**
 * Handle Half Time game event
 */
function handleGameEventHalfTime() {
    if (typeof showControllerToast === 'function') {
        showControllerToast('Half Time', 'info');
    }
    
    // Log the event
    console.log('Game Event: Half Time');
    
    hideGameEventsModal();
}

/**
 * Handle Switch Sides game event
 */
function handleGameEventSwitchSides() {
    if (typeof showControllerToast === 'function') {
        showControllerToast('Switching sides', 'info');
    }
    
    // Log the event
    console.log('Game Event: Switch Sides');
    
    hideGameEventsModal();
}

/**
 * Handle End Game game event
 */
function handleGameEventEndGame() {
    hideGameEventsModal();
    
    // Use existing end game functionality
    if (typeof endGameConfirm === 'function') {
        endGameConfirm();
    } else if (typeof showScreen === 'function') {
        // Fallback: go to game summary
        exitGameScreen();
        showScreen('gameSummaryScreen');
    }
}

/**
 * Update Play-by-Play panel state based on role
 * Buttons are enabled as long as user has Active Coach role
 * (Score buttons are used to END a point, so they should be available anytime)
 */
function updatePlayByPlayPanelState() {
    const panel = document.getElementById('panel-playByPlay');
    if (!panel) return;
    
    const hasActiveCoachRole = canEditPlayByPlayPanel();
    
    // Disable panel visually if not Active Coach (but don't block pointer events on whole panel)
    panel.classList.toggle('role-disabled', !hasActiveCoachRole);
    
    // All buttons are enabled if user has Active Coach role
    const allButtons = panel.querySelectorAll('.pbp-btn');
    allButtons.forEach(btn => {
        btn.disabled = !hasActiveCoachRole;
        btn.classList.toggle('disabled', !hasActiveCoachRole);
    });
    
    // Update panel layout based on height
    updatePlayByPlayLayout();
}

/**
 * Update Play-by-Play panel layout based on available height
 * Three layout modes:
 * - Expanded (>250px): vertical layout with large buttons (like legacy Simple Mode)
 * - Medium (120-250px): two rows (score buttons + secondary row)
 * - Compact (<120px): single row
 */
function updatePlayByPlayLayout() {
    const panel = document.getElementById('panel-playByPlay');
    const content = panel?.querySelector('.pbp-panel-content');
    if (!panel || !content) return;
    
    // Get the content area height (panel height minus title bar)
    const panelRect = panel.getBoundingClientRect();
    const titleBar = panel.querySelector('.panel-title-bar');
    const titleBarHeight = titleBar ? titleBar.getBoundingClientRect().height : 36;
    const contentHeight = panelRect.height - titleBarHeight;
    
    // Thresholds for switching layouts
    const EXPANDED_THRESHOLD = 250;  // Above this: expanded vertical layout
    const MEDIUM_THRESHOLD = 120;    // Above this: two-row layout
    
    // Remove all layout classes first
    content.classList.remove('layout-expanded', 'layout-medium', 'layout-compact');
    
    if (contentHeight >= EXPANDED_THRESHOLD) {
        content.classList.add('layout-expanded');
    } else if (contentHeight >= MEDIUM_THRESHOLD) {
        content.classList.add('layout-medium');
    } else {
        content.classList.add('layout-compact');
    }
}

// ResizeObserver instance for Play-by-Play panel
let pbpResizeObserver = null;

/**
 * Set up ResizeObserver to update layout when panel is resized
 */
function setupPlayByPlayResizeObserver() {
    const panel = document.getElementById('panel-playByPlay');
    if (!panel) return;
    
    // Clean up existing observer
    if (pbpResizeObserver) {
        pbpResizeObserver.disconnect();
    }
    
    // Create new observer
    pbpResizeObserver = new ResizeObserver((entries) => {
        // Debounce layout updates during drag
        requestAnimationFrame(() => {
            updatePlayByPlayLayout();
        });
    });
    
    pbpResizeObserver.observe(panel);
    
    // Initial layout update
    updatePlayByPlayLayout();
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
    
    // Also update game log score
    updateGameLogScore(usScore, themScore);
}

// =============================================================================
// Game Log Panel Updates
// =============================================================================

/**
 * Update the Game Log panel status (teams and score)
 */
function updateGameLogStatus() {
    const teamUsEl = document.getElementById('gameLogTeamUs');
    const teamThemEl = document.getElementById('gameLogTeamThem');
    const scoreEl = document.getElementById('gameLogScore');
    
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    
    if (!game) return;
    
    // Update team names
    const teamName = game.team || 'Us';
    const opponentName = game.opponent || 'Them';
    
    if (teamUsEl) teamUsEl.textContent = teamName;
    if (teamThemEl) teamThemEl.textContent = opponentName;
    
    // Update score
    const usScore = game.scores ? game.scores[Role.TEAM] : 0;
    const themScore = game.scores ? game.scores[Role.OPPONENT] : 0;
    
    if (scoreEl) scoreEl.textContent = `${usScore} – ${themScore}`;
}

/**
 * Update just the score in the Game Log panel
 * @param {number} usScore - Our team's score
 * @param {number} themScore - Opponent's score
 */
function updateGameLogScore(usScore, themScore) {
    const scoreEl = document.getElementById('gameLogScore');
    if (scoreEl) {
        scoreEl.textContent = `${usScore} – ${themScore}`;
    }
}

/**
 * Update the Game Log panel event list
 * Uses summarizeGame() to get the game summary text
 */
function updateGameLogEvents() {
    const eventsEl = document.getElementById('gameLogEvents');
    if (!eventsEl) return;
    
    // Check if game screen is visible
    if (!isGameScreenVisible()) return;
    
    // Get game summary
    let summary = '';
    if (typeof summarizeGame === 'function') {
        summary = summarizeGame();
    }
    
    if (!summary || summary.trim() === '') {
        // Show placeholder when no events
        eventsEl.innerHTML = `
            <div class="game-log-placeholder">
                <i class="fas fa-list"></i>
                <span>Game events will appear here</span>
            </div>
        `;
        return;
    }
    
    // Format the summary for display
    // Split into lines and wrap each in a div for styling
    const lines = summary.split('\n');
    let html = '';
    
    for (const line of lines) {
        if (!line.trim()) continue;
        
        // Add CSS class based on line content
        let lineClass = 'game-log-line';
        
        if (line.includes(' scores!')) {
            lineClass += ' game-log-score-event';
            if (line.includes(getTeamName())) {
                lineClass += ' game-log-us-scores';
            } else {
                lineClass += ' game-log-them-scores';
            }
        } else if (line.startsWith('Point ') && line.includes('roster:')) {
            lineClass += ' game-log-point-header';
        } else if (line.includes('Current score:')) {
            lineClass += ' game-log-current-score';
        } else if (line.includes('pulls to')) {
            lineClass += ' game-log-pull';
        } else if (line.startsWith('App Version:') || line.startsWith('Game Summary:')) {
            lineClass += ' game-log-header';
        } else if (line.includes('roster:')) {
            lineClass += ' game-log-roster';
        }
        
        html += `<div class="${lineClass}">${escapeHtml(line)}</div>`;
    }
    
    eventsEl.innerHTML = html;
    
    // Auto-scroll to bottom
    eventsEl.scrollTop = eventsEl.scrollHeight;
}

/**
 * Get the team name for display
 * @returns {string}
 */
function getTeamName() {
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    return game?.team || 'Us';
}

/**
 * Escape HTML entities to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Full update of the Game Log panel
 * Call this when entering game screen or when game changes significantly
 */
function updateGameLogPanel() {
    updateGameLogStatus();
    updateGameLogEvents();
}

/**
 * Update the team identity displays in the header
 * Call this when entering game screen or when team data changes
 */
function updateHeaderTeamIdentities() {
    const usContainer = document.getElementById('headerTeamUs');
    const themContainer = document.getElementById('headerTeamThem');
    
    if (!usContainer || !themContainer) return;
    
    // Get current team and game
    let team = null;
    let game = null;
    
    if (typeof currentTeam !== 'undefined' && currentTeam) {
        team = currentTeam;
    }
    
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    
    // Update our team identity
    const usDisplay = getTeamIdentityDisplay(team, 'Us');
    usContainer.innerHTML = usDisplay.html;
    usContainer.classList.toggle('can-toggle', usDisplay.canToggle);
    
    // Add click handler for toggling if we can toggle
    if (usDisplay.canToggle) {
        usContainer.onclick = toggleTeamIdentityDisplay;
        usContainer.style.cursor = 'pointer';
    } else {
        usContainer.onclick = null;
        usContainer.style.cursor = 'default';
    }
    
    // Update opponent identity
    const opponentName = game ? game.opponent : null;
    const themDisplay = getOpponentIdentityDisplay(opponentName);
    themContainer.innerHTML = themDisplay.html;
}

/**
 * Update the timer display
 * Shows either point timer or game clock (with cap countdown)
 */
function updateTimerDisplay() {
    const valueEl = document.getElementById('gameTimerValue');
    const labelEl = document.getElementById('gameTimerLabel');
    const containerEl = document.getElementById('gameTimerContainer');
    
    if (!valueEl || !labelEl) return;
    
    // Remove all timer state classes
    valueEl.classList.remove('timer-warning', 'timer-danger', 'timer-negative', 'timer-paused');
    
    // Get game for cap calculation
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    
    if (timerMode === 'point') {
        // Show point timer
        labelEl.textContent = 'point';
        
        const point = getCurrentPoint();
        if (point && point.startTimestamp) {
            let elapsed;
            const startTime = new Date(point.startTimestamp).getTime();
            const previousPausedTime = point.totalPointTime || 0;
            
            if (pointTimerPaused && pointPausedAt) {
                // Show time when paused - subtract accumulated pause time from previous cycles
                elapsed = Math.floor((pointPausedAt - startTime - previousPausedTime) / 1000);
                valueEl.classList.add('timer-paused');
            } else {
                // Active timer - subtract any accumulated pause time
                const now = Date.now();
                elapsed = Math.floor((now - startTime - previousPausedTime) / 1000);
            }
            valueEl.textContent = formatTime(elapsed);
            
            // Add warning colors for long points
            if (elapsed > 180) { // 3+ minutes
                valueEl.classList.add('timer-danger');
            } else if (elapsed > 120) { // 2+ minutes
                valueEl.classList.add('timer-warning');
            }
        } else {
            valueEl.textContent = '0:00';
        }
    } else {
        // Show game clock (with cap countdown if applicable)
        labelEl.textContent = 'game';
        
        if (game && game.gameStartTimestamp) {
            const startTime = new Date(game.gameStartTimestamp).getTime();
            const now = Date.now();
            const elapsedMs = now - startTime;
            const elapsedSeconds = Math.floor(elapsedMs / 1000);
            
            // If game has ended, just show total game time
            if (game.gameEndTimestamp) {
                const endTime = new Date(game.gameEndTimestamp).getTime();
                const totalSeconds = Math.floor((endTime - startTime) / 1000);
                valueEl.textContent = formatTime(totalSeconds);
            } else {
                // Check if we should show countdown to cap
                // Only use cap countdown for active games (started within last 3 hours)
                const threeHoursMs = 3 * 60 * 60 * 1000;
                let capTime = null;
                
                if (elapsedMs < threeHoursMs) {
                    if (game.roundEndTime) {
                        capTime = new Date(game.roundEndTime).getTime();
                    } else if (game.gameDurationMinutes) {
                        capTime = startTime + (game.gameDurationMinutes * 60 * 1000);
                    }
                }
                
                if (capTime) {
                    const remainingMs = capTime - now;
                    const remainingSeconds = Math.floor(remainingMs / 1000);
                    
                    if (remainingSeconds <= -1800) {
                        // More than 30 min past cap - just show elapsed time
                        valueEl.textContent = formatTime(elapsedSeconds);
                    } else if (remainingSeconds <= 0) {
                        // Cap exceeded but within 30 min - show negative time in red
                        valueEl.textContent = formatTime(remainingSeconds);
                        valueEl.classList.add('timer-negative');
                    } else if (remainingSeconds <= 300) { // Under 5 minutes
                        // Show countdown
                        valueEl.textContent = formatTime(remainingSeconds);
                        if (remainingSeconds <= 60) {
                            valueEl.classList.add('timer-danger');
                        } else if (remainingSeconds <= 180) {
                            valueEl.classList.add('timer-warning');
                        }
                    } else {
                        // Show elapsed time
                        valueEl.textContent = formatTime(elapsedSeconds);
                    }
                } else {
                    // No cap or old game - just show elapsed time
                    valueEl.textContent = formatTime(elapsedSeconds);
                }
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
    
    // Reset timer pause state when entering
    pointTimerPaused = false;
    pointPausedAt = null;
    
    // Update displays
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    
    if (game) {
        // Update score
        const usScore = game.scores ? game.scores[Role.TEAM] : 0;
        const themScore = game.scores ? game.scores[Role.OPPONENT] : 0;
        updateGameScreenScore(usScore, themScore);
    }
    
    // Update team identities in header
    updateHeaderTeamIdentities();
    
    // Update timer display and pause button
    updateTimerDisplay();
    updateTimerPauseButton();
    
    // Start timer updates
    startGameScreenTimerLoop();
    
    // Update game log panel
    updateGameLogPanel();
    
    // Update role buttons from controller state
    if (typeof getControllerState === 'function') {
        const state = getControllerState();
        updateGameScreenRoleButtons(state);
        updatePanelsForRole(state.myRole);
    }
    
    // Update Play-by-Play panel state (based on role only)
    updatePlayByPlayPanelState();
    
    // Set up ResizeObserver for Play-by-Play panel layout
    setupPlayByPlayResizeObserver();
    
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
window.updateHeaderTeamIdentities = updateHeaderTeamIdentities;
window.autoResumePointTimer = autoResumePointTimer;

// Game Log panel
window.updateGameLogPanel = updateGameLogPanel;
window.updateGameLogEvents = updateGameLogEvents;
window.updateGameLogStatus = updateGameLogStatus;

// Play-by-Play panel
window.updatePlayByPlayPanelState = updatePlayByPlayPanelState;
window.showGameEventsModal = showGameEventsModal;
window.hideGameEventsModal = hideGameEventsModal;

