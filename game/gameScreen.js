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
 * - Medium: We Score | They Score | Key Play row, then Undo | Sub | Events row
 * - Compact (horizontal): Single row with "..." to expand
 * @returns {HTMLElement}
 */
function createPlayByPlayContent() {
    const content = document.createElement('div');
    content.className = 'pbp-panel-content layout-compact';
    
    // Structure: 
    // - Main row: We Score, They Score, Key Play (Key Play hidden in compact via CSS)
    // - Action row: Undo, Sub, Events, More (hidden in expanded/medium via CSS)
    // Note: Score button labels use separate spans for wrapping in "full" layout
    content.innerHTML = `
        <div class="pbp-main-buttons">
            <button id="pbpWeScoreBtn" class="pbp-btn pbp-btn-score pbp-btn-us" title="We Score">
                <i class="fas fa-plus-circle"></i>
                <span class="pbp-btn-label"><span class="pbp-label-word">We</span> <span class="pbp-label-word">Score</span></span>
            </button>
            <button id="pbpTheyScoreBtn" class="pbp-btn pbp-btn-score pbp-btn-them" title="They Score">
                <i class="fas fa-minus-circle"></i>
                <span class="pbp-btn-label"><span class="pbp-label-word">They</span> <span class="pbp-label-word">Score</span></span>
            </button>
            <button id="pbpKeyPlayBtn" class="pbp-btn pbp-btn-keyplay" title="Key Play">
                <i class="fas fa-star"></i>
                <span class="pbp-btn-label"><span class="pbp-label-word">Key</span> <span class="pbp-label-word">Play</span></span>
            </button>
        </div>
        <div class="pbp-action-buttons">
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

// =============================================================================
// Select Next Line Panel Content
// =============================================================================

/**
 * Create the Select Next Line panel content
 * Contains: header row with toggles, Start Point button, Lines button, 
 * gender ratio display, and player selection table
 * Also includes a compact view for when panel is very small
 * @returns {HTMLElement}
 */
function createSelectLineContent() {
    const content = document.createElement('div');
    content.className = 'select-line-content';
    
    content.innerHTML = `
        <!-- Compact view - shown when panel is very small -->
        <div class="select-line-compact-view" id="selectLineCompactView" style="display: none;">
            <span class="compact-line-type-link" id="compactLineTypeLink">O/D: </span>
            <span class="compact-player-list" id="compactPlayerList"></span>
        </div>
        
        <!-- Full view - normal table UI -->
        <div class="select-line-full-view" id="selectLineFullView">
            <div class="select-line-header-row">
                <span class="select-line-stats-toggle" id="panelStatsToggle">(Game)</span>
                <button class="select-line-od-toggle" id="panelODToggle" title="Toggle O/D/O-D line (coming soon)">
                    O/D
                </button>
            </div>
            <div class="select-line-top-row">
                <button class="select-line-start-btn" id="panelStartPointBtn">
                    Start Point
                </button>
                <button class="select-line-lines-btn" id="panelLinesBtn">
                    Lines...
                </button>
            </div>
            <div class="select-line-gender-ratio" id="panelGenderRatioDisplay" style="display: none;">
                <span>Gender Ratio: </span><span id="panelGenderRatioText"></span>
            </div>
            <div class="select-line-starting-ratio" id="panelStartingRatioSelection" style="display: none;">
                <label>Starting Ratio: </label>
                <input type="radio" id="panelStartingRatioFMP" name="panelStartingRatio" value="FMP">
                <label for="panelStartingRatioFMP">FMP</label>
                <input type="radio" id="panelStartingRatioMMP" name="panelStartingRatio" value="MMP">
                <label for="panelStartingRatioMMP">MMP</label>
            </div>
            <div class="select-line-table-container" id="panelTableContainer">
                <table class="panel-player-table" id="panelActivePlayersTable">
                    <thead>
                        <tr>
                            <th></th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        <!-- Player rows will be dynamically added here -->
                    </tbody>
                </table>
            </div>
        </div>
        <div class="select-line-readonly-overlay" id="panelReadonlyOverlay" style="display: none;">
            <span class="readonly-badge">View Only</span>
        </div>
    `;
    
    return content;
}

/**
 * Create the Select Next Line panel with actual content
 * @returns {HTMLElement}
 */
function createSelectLinePanel() {
    const panel = document.createElement('div');
    panel.id = 'panel-selectLine';
    panel.className = 'game-panel panel-selectLine';
    
    // Create title bar
    const titleBar = createPanelTitleBar({
        panelId: 'selectLine',
        title: 'Select Next Line',
        showDragHandle: true,
        showExpandBtn: true
    });
    panel.appendChild(titleBar);
    
    // Create content area with actual content
    const contentArea = document.createElement('div');
    contentArea.className = 'panel-content';
    contentArea.id = 'panel-selectLine-content';
    contentArea.appendChild(createSelectLineContent());
    panel.appendChild(contentArea);
    
    return panel;
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
    
    // Wire up Select Next Line panel events
    wireSelectLineEvents();
    
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
 * Toggle the Play-by-Play panel to medium layout when "..." is clicked
 * This expands the panel to show all action buttons
 */
function togglePbpExpandedRow() {
    // Expand the Play-by-Play panel to medium layout height
    // This uses the panelSystem API to resize the panel
    const panel = document.querySelector('.panel-playByPlay');
    if (!panel) return;
    
    const currentHeight = panel.getBoundingClientRect().height;
    const MEDIUM_MIN_HEIGHT = 150; // Enough for two rows of buttons
    
    if (currentHeight < MEDIUM_MIN_HEIGHT) {
        // Expand to medium height
        panel.style.height = `${MEDIUM_MIN_HEIGHT}px`;
        panel.style.flex = '0 0 auto';
        
        // Try to use panelSystem API if available
        if (typeof window.setPanelState === 'function') {
            window.setPanelState('playByPlay', { height: MEDIUM_MIN_HEIGHT, expandedHeight: MEDIUM_MIN_HEIGHT });
        }
        
        // Trigger layout update
        updatePlayByPlayLayout();
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
    
    // Ensure the dialog is visible by moving it to body if needed
    ensureDialogVisible('scoreAttributionDialog');
    
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
    
    // Update UI for between-points state
    transitionToBetweenPoints();
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
    
    // Ensure the dialog is visible by moving it to body if needed
    ensureDialogVisible('keyPlayDialog');
    
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
    
    // Use existing undo functionality from gameLogic.js
    if (typeof undoEvent === 'function') {
        undoEvent();
        // Update the game log after undo
        updateGameLogEvents();
    } else {
        console.warn('undoEvent not available');
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
 * Ensure a dialog element is visible by moving it to body if needed.
 * This fixes the issue where dialogs inside simpleModeScreen are hidden
 * when the game screen container is active (parent has display: none !important).
 * @param {string} dialogId - The ID of the dialog element
 */
function ensureDialogVisible(dialogId) {
    const dialog = document.getElementById(dialogId);
    if (!dialog) return;
    
    // If dialog's parent is not body, move it to body
    // This ensures it can be displayed above all other content
    if (dialog.parentElement !== document.body) {
        document.body.appendChild(dialog);
        console.log(`📦 Moved ${dialogId} to body for visibility`);
    }
}

/**
 * Transition UI to "between points" state after a score.
 * - Update the score display and game log
 * - Maximize the Select Next Line panel
 * - Minimize the Play-by-Play panel
 */
function transitionToBetweenPoints() {
    // Reset conflict tracking for new between-points phase
    lastConflictToastPointIndex = -1;
    
    // Update score display
    let game;
    if (typeof currentGame === 'function') {
        game = currentGame();
    } else if (typeof currentGame !== 'undefined') {
        game = currentGame;
    }
    
    if (game) {
        const usScore = game.scores ? game.scores[Role.TEAM] : 0;
        const themScore = game.scores ? game.scores[Role.OPPONENT] : 0;
        updateGameScreenScore(usScore, themScore);
        
        // Refresh pending line selections from cloud (for multi-device sync)
        // This ensures Active Coach sees Line Coach's selections after point ends
        if (game.id && typeof refreshPendingLineFromCloud === 'function') {
            refreshPendingLineFromCloud(game.id).then(updated => {
                if (updated) {
                    // Re-update the panel with fresh data
                    updateSelectLinePanel();
                }
            }).catch(err => {
                console.warn('Failed to refresh pending line:', err);
            });
        }
    }
    
    // Update game log
    updateGameLogEvents();
    
    // Auto-select appropriate line type based on who scored
    selectAppropriateLineAtPointEnd();
    
    // Update Select Next Line panel with latest data
    updateSelectLinePanel();
    
    // Maximize Select Next Line panel (for line selection)
    if (typeof maximizePanel === 'function') {
        maximizePanel('selectLine', false);
    }
    
    // Minimize Play-by-Play panel (point is over)
    if (typeof minimizePanel === 'function') {
        minimizePanel('playByPlay');
    }
    
    // Update Play-by-Play panel state (buttons now disabled since point ended)
    updatePlayByPlayPanelState();
    
    // Save data
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
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
 * Update Play-by-Play panel state based on role and point status
 * - Score buttons (We Score, They Score): enabled only DURING a point
 * - Key Play: enabled only DURING a point
 * - Undo, Events, More: enabled anytime (if Active Coach)
 */
function updatePlayByPlayPanelState() {
    const panel = document.getElementById('panel-playByPlay');
    if (!panel) return;
    
    const hasActiveCoachRole = canEditPlayByPlayPanel();
    const pointInProgress = typeof isPointInProgress === 'function' && isPointInProgress();
    
    // Disable panel visually if not Active Coach (but don't block pointer events on whole panel)
    panel.classList.toggle('role-disabled', !hasActiveCoachRole);
    
    // Score buttons - only enabled DURING a point
    const weScoreBtn = document.getElementById('pbpWeScoreBtn');
    const theyScoreBtn = document.getElementById('pbpTheyScoreBtn');
    const keyPlayBtn = document.getElementById('pbpKeyPlayBtn');
    
    const scoreButtonsEnabled = hasActiveCoachRole && pointInProgress;
    [weScoreBtn, theyScoreBtn, keyPlayBtn].forEach(btn => {
        if (btn) {
            btn.disabled = !scoreButtonsEnabled;
            btn.classList.toggle('disabled', !scoreButtonsEnabled);
        }
    });
    
    // Action buttons (Undo, Events, More) - enabled anytime if Active Coach
    const undoBtn = document.getElementById('pbpUndoBtn');
    const eventsBtn = document.getElementById('pbpEventsBtn');
    const moreBtn = document.getElementById('pbpMoreBtn');
    
    [undoBtn, eventsBtn, moreBtn].forEach(btn => {
        if (btn) {
            btn.disabled = !hasActiveCoachRole;
            btn.classList.toggle('disabled', !hasActiveCoachRole);
        }
    });
    
    // Update panel layout based on height
    updatePlayByPlayLayout();
    
    // Update Game Events modal buttons if it's open
    updateGameEventsModalState();
}

/**
 * Update Game Events modal button states based on point status
 * - Timeout: enabled anytime (can be called during or between points)
 * - Halftime, Switch Sides, End Game: enabled BETWEEN points only
 */
function updateGameEventsModalState() {
    const modal = document.getElementById('gameEventsModal');
    if (!modal || modal.style.display === 'none') return;
    
    const hasActiveCoachRole = canEditPlayByPlayPanel();
    const pointInProgress = typeof isPointInProgress === 'function' && isPointInProgress();
    
    // Timeout - enabled anytime (can be called during or between points)
    const timeoutBtn = modal.querySelector('#geTimeoutBtn');
    if (timeoutBtn) {
        timeoutBtn.disabled = !hasActiveCoachRole;
        timeoutBtn.classList.toggle('disabled', !hasActiveCoachRole);
    }
    
    // Halftime, Switch Sides, End Game - enabled BETWEEN points only
    const halfTimeBtn = modal.querySelector('#geHalfTimeBtn');
    const switchSidesBtn = modal.querySelector('#geSwitchSidesBtn');
    const endGameBtn = modal.querySelector('#geEndGameBtn');
    
    const betweenPointsEnabled = hasActiveCoachRole && !pointInProgress;
    [halfTimeBtn, switchSidesBtn, endGameBtn].forEach(btn => {
        if (btn) {
            btn.disabled = !betweenPointsEnabled;
            btn.classList.toggle('disabled', !betweenPointsEnabled);
        }
    });
}

/**
 * Update Play-by-Play panel layout based on available height
 * Layout modes:
 * - Full (>500px): square buttons with wrapped text, spread vertically
 * - Expanded (350-500px): vertical layout with wide horizontal buttons
 * - Medium-tall (200-350px): two rows, tall buttons with wrapped text
 * - Medium (120-200px): two rows, shorter buttons with single-line text
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
    
    // Thresholds for switching layouts (content height, excludes title bar)
    const FULL_THRESHOLD = 500;         // Above this: full layout with square buttons
    const EXPANDED_THRESHOLD = 350;     // Above this: expanded vertical layout
    const MEDIUM_TALL_THRESHOLD = 200;  // Above this: medium with wrapped text
    const MEDIUM_THRESHOLD = 120;       // Above this: medium with single-line text
    
    // Remove all layout classes first
    content.classList.remove('layout-full', 'layout-expanded', 'layout-medium', 'layout-medium-tall', 'layout-compact');
    
    if (contentHeight >= FULL_THRESHOLD) {
        content.classList.add('layout-full');
    } else if (contentHeight >= EXPANDED_THRESHOLD) {
        content.classList.add('layout-expanded');
    } else if (contentHeight >= MEDIUM_TALL_THRESHOLD) {
        content.classList.add('layout-medium', 'layout-medium-tall');
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
// Select Next Line Panel
// =============================================================================

// Track stats display mode for panel (Game vs Total)
let panelShowingTotalStats = false;

// Track conflict detection state
let lastConflictToastPointIndex = -1;  // Prevent multiple toasts per point
let localLineEditTimestamps = {
    oLine: 0,
    dLine: 0,
    odLine: 0
};

/**
 * Wire up Select Next Line panel event handlers
 */
function wireSelectLineEvents() {
    // Stats toggle (Game/Total)
    const statsToggle = document.getElementById('panelStatsToggle');
    if (statsToggle) {
        statsToggle.addEventListener('click', handlePanelStatsToggle);
    }
    
    // O/D toggle button - cycles between O/D, O, and D lines
    const odToggle = document.getElementById('panelODToggle');
    if (odToggle) {
        odToggle.addEventListener('click', handleODToggle);
    }
    
    // Start Point button
    const startPointBtn = document.getElementById('panelStartPointBtn');
    if (startPointBtn) {
        startPointBtn.addEventListener('click', handlePanelStartPoint);
    }
    
    // Lines button
    const linesBtn = document.getElementById('panelLinesBtn');
    if (linesBtn) {
        linesBtn.addEventListener('click', handlePanelLinesClick);
    }
    
    // Player table checkbox changes (delegated)
    const tableContainer = document.getElementById('panelTableContainer');
    if (tableContainer) {
        tableContainer.addEventListener('change', handlePanelCheckboxChange);
    }
    
    // Starting gender ratio radio buttons
    const fmpRadio = document.getElementById('panelStartingRatioFMP');
    const mmpRadio = document.getElementById('panelStartingRatioMMP');
    if (fmpRadio) {
        fmpRadio.addEventListener('change', handlePanelStartingRatioChange);
    }
    if (mmpRadio) {
        mmpRadio.addEventListener('change', handlePanelStartingRatioChange);
    }
}

/**
 * Handle stats toggle click (Game/Total)
 */
function handlePanelStatsToggle() {
    panelShowingTotalStats = !panelShowingTotalStats;
    const toggle = document.getElementById('panelStatsToggle');
    if (toggle) {
        toggle.textContent = panelShowingTotalStats ? '(Total)' : '(Game)';
    }
    // Refresh table to show correct stats
    updateSelectLineTable();
}

/**
 * Handle O/D toggle button click
 * Cycles between 'od' → 'o' → 'd' → 'od'
 */
function handleODToggle() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;
    
    // Check if user can edit
    if (!canEditSelectLinePanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('You need a coach role to change line type', 'warning');
        }
        return;
    }
    
    // Save current selections before switching (don't update timestamp - just viewing)
    savePanelSelectionsToPendingNextLine(false);
    
    // Cycle to next type: od → o → d → od
    const currentType = game.pendingNextLine.activeType || 'od';
    let nextType;
    switch (currentType) {
        case 'od': nextType = 'o'; break;
        case 'o': nextType = 'd'; break;
        case 'd': nextType = 'od'; break;
        default: nextType = 'od';
    }
    
    // Update active type (local-only, not synced)
    game.pendingNextLine.activeType = nextType;
    
    // Save game state
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
    
    // Refresh the table to show the new line's selections
    updateSelectLineTable();
    
    // Update button text
    updateODToggleButton();
    
    // Update start point button state (in case player count changed)
    updateStartPointButtonState();
    
    // Show feedback
    const typeLabels = { od: 'O/D', o: 'Offense', d: 'Defense' };
    if (typeof showControllerToast === 'function') {
        showControllerToast(`Switched to ${typeLabels[nextType]} line`, 'info');
    }
}

/**
 * Update the O/D toggle button text to show current mode
 */
function updateODToggleButton() {
    const btn = document.getElementById('panelODToggle');
    if (!btn) return;
    
    const game = typeof currentGame === 'function' ? currentGame() : null;
    const activeType = game?.pendingNextLine?.activeType || 'od';
    
    // Update button text
    const typeLabels = { od: 'O/D', o: 'O', d: 'D' };
    btn.textContent = typeLabels[activeType] || 'O/D';
    
    // Update title/tooltip
    const typeDescriptions = { 
        od: 'General line (tap to switch to Offense)', 
        o: 'Offense line (tap to switch to Defense)', 
        d: 'Defense line (tap to switch to O/D)' 
    };
    btn.title = typeDescriptions[activeType] || 'Toggle O/D/O-D line';
}

/**
 * Handle Start Point button click
 * Validates selection and starts the point with role-aware panel transitions
 */
function handlePanelStartPoint() {
    console.log('🏃 handlePanelStartPoint called');
    
    // Check if point is already in progress
    if (typeof isPointInProgress === 'function' && isPointInProgress()) {
        console.log('🏃 Point already in progress, ignoring');
        return;
    }
    
    // Check if we can start a point (need Active Coach role, not just lineup edit)
    if (!canEditPlayByPlayPanel()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('Only the Active Coach can start a new point', 'warning');
        }
        return;
    }
    
    // Get selected players
    const selectedPlayers = getSelectedPlayersFromPanel();
    console.log('🏃 Selected players:', selectedPlayers);
    
    // Get expected player count
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput')?.value || '7', 10);
    
    // Validate player count
    if (selectedPlayers.length === 0) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('Please select players for the point', 'warning');
        }
        return;
    }
    
    // Warn but allow if count is wrong
    if (selectedPlayers.length !== expectedCount) {
        console.warn(`Starting point with ${selectedPlayers.length} players (expected ${expectedCount})`);
    }
    
    // Update the legacy activePlayersTable checkboxes to match panel selections
    syncPanelSelectionsToLegacy(selectedPlayers);
    
    // Note: Don't stop game state refresh - viewers need updates during points
    // The refresh logic handles Active Coach differently (no full refresh during point)
    
    // Use existing startNextPoint logic from pointManagement.js
    if (typeof startNextPoint === 'function') {
        console.log('🏃 Calling startNextPoint()');
        startNextPoint();
        
        // Role-aware panel transitions (only if we didn't navigate away)
        // startNextPoint may have called enterGameScreen which handles this
        if (isGameScreenVisible()) {
            const state = typeof getControllerState === 'function' ? getControllerState() : {};
            const hasActiveCoach = state.isActiveCoach;
            
            if (hasActiveCoach) {
                // Active Coach: minimize Select Line, maximize Play-by-Play
                if (typeof minimizePanel === 'function') {
                    minimizePanel('selectLine');
                }
                if (typeof maximizePanel === 'function') {
                    maximizePanel('playByPlay', false);
                }
            }
            // If only Line Coach: leave panels unchanged so they can work on next line
            
            // Update displays
            updateSelectLinePanelState();
            
            // Update Play-by-Play panel state (buttons now enabled since point started)
            updatePlayByPlayPanelState();
        }
    } else {
        console.warn('🏃 startNextPoint function not available');
    }
}

/**
 * Handle Lines button click
 * Opens the line selection dialog
 */
function handlePanelLinesClick() {
    if (typeof showLineSelectionDialog === 'function') {
        showLineSelectionDialog();
    } else {
        console.warn('showLineSelectionDialog not available');
    }
}

/**
 * Check for conflicts when editing the line
 * Warns if another coach edited the same line type within the last 5 seconds
 */
function checkForLineEditConflict() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;
    
    // Only check between points
    if (typeof isPointInProgress === 'function' && isPointInProgress()) return;
    
    // Check if we already showed a toast for this point
    const currentPointIndex = game.points.length;
    if (lastConflictToastPointIndex === currentPointIndex) return;
    
    const activeType = game.pendingNextLine.activeType || 'od';
    const lineKey = activeType + 'Line';
    
    // Get the modification timestamp for the current line type
    const modTimestampKey = activeType + 'LineModifiedAt';
    const remoteModTimestamp = game.pendingNextLine[modTimestampKey];
    
    if (!remoteModTimestamp) return;
    
    const remoteTime = new Date(remoteModTimestamp).getTime();
    const now = Date.now();
    const fiveSecondsAgo = now - 5000;
    const localEditTime = localLineEditTimestamps[lineKey] || 0;
    
    // If remote timestamp is newer than our last edit AND within 5 seconds,
    // someone else edited after us
    if (remoteTime > localEditTime && remoteTime > fiveSecondsAgo) {
        // Get the other coach's name from controller state
        const state = typeof getControllerState === 'function' ? getControllerState() : {};
        let otherCoachName = null;
        
        if (state.isActiveCoach && state.lineCoach) {
            otherCoachName = state.lineCoach.displayName;
        } else if (state.isLineCoach && state.activeCoach) {
            otherCoachName = state.activeCoach.displayName;
        }
        
        if (otherCoachName) {
            if (typeof showControllerToast === 'function') {
                showControllerToast(`Warning: ${otherCoachName} is also editing this line`, 'warning');
            }
            lastConflictToastPointIndex = currentPointIndex;
        }
    }
}

/**
 * Handle checkbox change in the player selection table
 * @param {Event} e - Change event
 */
function handlePanelCheckboxChange(e) {
    if (!e.target || !e.target.matches('input[type="checkbox"]')) return;
    
    // Check permission
    if (!canEditSelectLinePanel()) {
        // Revert the change
        e.target.checked = !e.target.checked;
        if (typeof showControllerToast === 'function') {
            showControllerToast('Only the Line Coach can edit during a point', 'warning');
        }
        return;
    }
    
    // Check for conflicts with other coach before saving
    checkForLineEditConflict();
    
    // Save to pending next line
    savePanelSelectionsToPendingNextLine();
    
    // Update Start Point button state
    updateStartPointButtonState();
    
    // Sync to legacy table for compatibility
    const selectedPlayers = getSelectedPlayersFromPanel();
    syncPanelSelectionsToLegacy(selectedPlayers);
    
    // Keep compact view in sync
    updateSelectLineCompactView();
}

/**
 * Handle starting gender ratio selection change
 */
function handlePanelStartingRatioChange(e) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game) return;
    
    game.startingGenderRatio = e.target.value;
    
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
    
    // Refresh display
    updateSelectLinePanel();
}

/**
 * Check if user can edit the Select Line panel
 * During point: Only Line Coach
 * Between points: Line Coach OR Active Coach
 * @returns {boolean}
 */
function canEditSelectLinePanel() {
    const state = typeof getControllerState === 'function' ? getControllerState() : {};
    const duringPoint = typeof isPointInProgress === 'function' ? isPointInProgress() : false;
    
    // If no controller system, allow editing
    if (!state.activeCoach && !state.lineCoach) {
        return true;
    }
    
    if (duringPoint) {
        // During point: Line Coach only
        return state.isLineCoach;
    } else {
        // Between points: Either coach
        return state.isLineCoach || state.isActiveCoach;
    }
}

/**
 * Get selected player names from the panel table
 * @returns {string[]} Array of player names
 */
function getSelectedPlayersFromPanel() {
    const checkboxes = document.querySelectorAll('#panelActivePlayersTable input[type="checkbox"]');
    const selectedPlayers = [];
    
    checkboxes.forEach(checkbox => {
        if (checkbox.checked && checkbox.dataset.playerName) {
            selectedPlayers.push(checkbox.dataset.playerName);
        }
    });
    
    return selectedPlayers;
}

/**
 * Save panel selections to the game's pendingNextLine
 */
/**
 * Save panel selections to pending next line
 * @param {boolean} updateTimestamp - Whether to update the modification timestamp (default: true)
 *   Set to false when just switching views (toggle), true when actually changing selections
 */
function savePanelSelectionsToPendingNextLine(updateTimestamp = true) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;
    
    const selectedPlayers = getSelectedPlayersFromPanel();
    const activeType = game.pendingNextLine.activeType || 'od';
    
    // Update the appropriate line array
    game.pendingNextLine[activeType + 'Line'] = selectedPlayers;
    
    // Only update the modification timestamp if actual selections changed
    // (not just viewing via toggle)
    if (updateTimestamp) {
        game.pendingNextLine[activeType + 'LineModifiedAt'] = new Date().toISOString();
        // Track our local edit time for conflict detection
        localLineEditTimestamps[activeType + 'Line'] = Date.now();
    }
    
    // Save (triggers sync)
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

/**
 * Sync panel selections to the legacy activePlayersTable
 * @param {string[]} selectedPlayers - Array of player names
 */
function syncPanelSelectionsToLegacy(selectedPlayers) {
    const legacyCheckboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
    if (!currentTeam || !currentTeam.teamRoster) return;
    
    legacyCheckboxes.forEach((checkbox, index) => {
        if (index < currentTeam.teamRoster.length) {
            checkbox.checked = selectedPlayers.includes(currentTeam.teamRoster[index].name);
        }
    });
    
    // Update legacy button state
    if (typeof checkPlayerCount === 'function') {
        checkPlayerCount();
    }
}

/**
 * Check gender ratio for panel-selected players
 * Returns true if ratio is correct, false if wrong
 * @param {string[]} selectedPlayerNames - Array of selected player names
 * @param {number} expectedCount - Expected player count
 */
function checkPanelGenderRatio(selectedPlayerNames, expectedCount) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.alternateGenderRatio || game.alternateGenderRatio === 'No') {
        return true; // Not checking gender ratio
    }
    
    if (selectedPlayerNames.length !== expectedCount) {
        return true; // Wrong count, handled elsewhere
    }
    
    // Get player objects and count genders
    let fmpCount = 0;
    let mmpCount = 0;
    selectedPlayerNames.forEach(name => {
        const player = currentTeam?.teamRoster?.find(p => p.name === name);
        if (player) {
            if (player.gender === Gender.FMP) fmpCount++;
            else if (player.gender === Gender.MMP) mmpCount++;
        }
    });
    
    // Handle fixed ratio (e.g., "4:3", "3:2")
    if (game.alternateGenderRatio !== 'Alternating') {
        const ratioParts = game.alternateGenderRatio.split(':');
        if (ratioParts.length === 2) {
            const expectedFmp = parseInt(ratioParts[0], 10);
            const expectedMmp = parseInt(ratioParts[1], 10);
            return fmpCount === expectedFmp && mmpCount === expectedMmp;
        }
    }
    
    // Handle alternating ratio
    const expectedRatio = typeof getExpectedGenderRatio === 'function' 
        ? getExpectedGenderRatio(game) 
        : null;
    if (!expectedRatio) return true; // No ratio set yet
    
    // Determine expected counts based on player count and ratio
    const expectedCounts = typeof getExpectedGenderCounts === 'function'
        ? getExpectedGenderCounts(expectedCount, expectedRatio)
        : null;
    if (!expectedCounts) return true;
    
    return fmpCount === expectedCounts.fmp && mmpCount === expectedCounts.mmp;
}

/**
 * Update the Start Point button state (text and warning states)
 * Shows feedback colors (desaturated when point in progress)
 */
function updateStartPointButtonState() {
    const btn = document.getElementById('panelStartPointBtn');
    if (!btn) return;
    
    const selectedPlayers = getSelectedPlayersFromPanel();
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput')?.value || '7', 10);
    
    // Check if point is in progress
    const pointInProgress = typeof isPointInProgress === 'function' && isPointInProgress();
    
    // Debug logging
    const latestPoint = typeof getLatestPoint === 'function' ? getLatestPoint() : null;
    console.log('📍 updateStartPointButtonState:', {
        pointInProgress,
        latestPointWinner: latestPoint?.winner,
        latestPointStartTimestamp: latestPoint?.startTimestamp,
        latestPointPossessionsLength: latestPoint?.possessions?.length
    });
    
    // Reset all states
    btn.classList.remove('warning', 'inactive', 'point-in-progress', 
        'feedback-ok', 'feedback-count-warning', 'feedback-gender-warning');
    btn.disabled = false;
    
    // Calculate feedback state regardless of point status
    const game = typeof currentGame === 'function' ? currentGame() : null;
    let genderRatioWarning = false;
    let startingRatioRequired = false;
    
    if (game && game.alternateGenderRatio && game.alternateGenderRatio !== 'No') {
        if (game.alternateGenderRatio === 'Alternating' && !game.startingGenderRatio && game.points.length === 0) {
            startingRatioRequired = true;
        } else if (selectedPlayers.length === expectedCount) {
            // Use panel-specific gender ratio check
            genderRatioWarning = !checkPanelGenderRatio(selectedPlayers, expectedCount);
        }
    }
    
    // Determine feedback class
    let feedbackClass = '';
    if (selectedPlayers.length === 0) {
        feedbackClass = 'inactive';
    } else if (startingRatioRequired) {
        feedbackClass = 'inactive';
    } else if (selectedPlayers.length !== expectedCount) {
        feedbackClass = 'feedback-count-warning';  // Wrong player count (red)
    } else if (genderRatioWarning) {
        feedbackClass = 'feedback-gender-warning';  // Wrong gender ratio (orange)
    } else {
        feedbackClass = 'feedback-ok';  // All good (green)
    }
    
    // If point is in progress, disable button but show feedback
    if (pointInProgress) {
        btn.textContent = 'Point in progress';
        btn.classList.add('point-in-progress');
        if (feedbackClass) {
            btn.classList.add(feedbackClass);
        }
        btn.disabled = true;
        return;
    }
    
    // Point not in progress - normal behavior
    // Determine starting position
    const startOn = typeof determineStartingPosition === 'function' 
        ? determineStartingPosition() 
        : 'offense';
    
    // Set button text
    const startOnLabel = startOn.charAt(0).toUpperCase() + startOn.slice(1);
    btn.textContent = `Start Point (${startOnLabel})`;
    
    // Apply the feedback class (will show saturated colors when not point-in-progress)
    if (feedbackClass) {
        btn.classList.add(feedbackClass);
    }
}

/**
 * Update the Select Line panel based on game state and permissions
 */
function updateSelectLinePanelState() {
    const canEdit = canEditSelectLinePanel();
    const panel = document.getElementById('panel-selectLine');
    const readonlyOverlay = document.getElementById('panelReadonlyOverlay');
    
    // Update readonly overlay
    if (readonlyOverlay) {
        readonlyOverlay.style.display = canEdit ? 'none' : 'flex';
    }
    
    // Update panel visual state
    if (panel) {
        panel.classList.toggle('readonly', !canEdit);
    }
    
    // Disable/enable checkboxes
    const checkboxes = document.querySelectorAll('#panelActivePlayersTable input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.disabled = !canEdit;
    });
    
    // Update Start Point button state (handles disabled state based on point status)
    updateStartPointButtonState();
    
    // Update gender ratio display
    updatePanelGenderRatioDisplay();
}

/**
 * Update gender ratio display in the panel
 */
function updatePanelGenderRatioDisplay() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    const display = document.getElementById('panelGenderRatioDisplay');
    const text = document.getElementById('panelGenderRatioText');
    const ratioSelection = document.getElementById('panelStartingRatioSelection');
    
    if (!game || !game.alternateGenderRatio || game.alternateGenderRatio === 'No') {
        if (display) display.style.display = 'none';
        if (ratioSelection) ratioSelection.style.display = 'none';
        return;
    }
    
    // Show gender ratio display
    if (display) display.style.display = 'block';
    
    // Fixed ratio (e.g., "4:3")
    if (game.alternateGenderRatio !== 'Alternating') {
        if (text) text.textContent = `${game.alternateGenderRatio} FMP:MMP`;
        if (ratioSelection) ratioSelection.style.display = 'none';
        return;
    }
    
    // Alternating ratio
    const expectedRatio = typeof getExpectedGenderRatio === 'function' 
        ? getExpectedGenderRatio(game) 
        : null;
    
    if (expectedRatio) {
        if (text) text.textContent = `+${expectedRatio} point`;
        if (ratioSelection) ratioSelection.style.display = 'none';
    } else {
        // Need to select starting ratio
        if (text) text.textContent = 'Select starting ratio';
        if (ratioSelection) ratioSelection.style.display = 'block';
    }
}

/**
 * Select the appropriate line type at the end of a point
 * Logic:
 * - If O/D line was modified after the point started, use O/D line
 * - Otherwise, use O line (if team will be on offense) or D line (if team will be on defense)
 */
function selectAppropriateLineAtPointEnd() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;
    
    // Get the last completed point
    const latestPoint = typeof getLatestPoint === 'function' ? getLatestPoint() : null;
    if (!latestPoint || !latestPoint.winner) return; // No completed point yet
    
    const pointStartTime = latestPoint.startTimestamp 
        ? new Date(latestPoint.startTimestamp).getTime() 
        : 0;
    
    // Get modification timestamps for all line types
    const odLineModTime = game.pendingNextLine.odLineModifiedAt
        ? new Date(game.pendingNextLine.odLineModifiedAt).getTime()
        : 0;
    const oLineModTime = game.pendingNextLine.oLineModifiedAt
        ? new Date(game.pendingNextLine.oLineModifiedAt).getTime()
        : 0;
    const dLineModTime = game.pendingNextLine.dLineModifiedAt
        ? new Date(game.pendingNextLine.dLineModifiedAt).getTime()
        : 0;
    
    let selectedType;
    
    // Priority 1: If O/D line was modified DURING this point, use it
    if (odLineModTime > pointStartTime) {
        selectedType = 'od';
        console.log('📋 Auto-selecting O/D line (modified during point)');
    }
    // Priority 2: If O and D lines have NEVER been modified, stay on O/D
    // (user is using single-line workflow)
    else if (oLineModTime === 0 && dLineModTime === 0) {
        selectedType = 'od';
        console.log('📋 Staying on O/D line (O and D lines never modified - single-line workflow)');
    }
    // Priority 3: Use O or D line based on who scored
    else {
        if (latestPoint.winner === 'team') {
            // Team scored - will be on defense next
            selectedType = 'd';
            console.log('📋 Auto-selecting D line (team scored, will be on defense)');
        } else {
            // Opponent scored - will be on offense next
            selectedType = 'o';
            console.log('📋 Auto-selecting O line (opponent scored, will be on offense)');
        }
    }
    
    // Only update if different from current (local-only, not synced)
    if (game.pendingNextLine.activeType !== selectedType) {
        game.pendingNextLine.activeType = selectedType;
        
        // Save game state (activeType won't be synced to cloud)
        if (typeof saveAllTeamsData === 'function') {
            saveAllTeamsData();
        }
    }
}

/**
 * Update the Select Line panel table with current roster and selections
 */
function updateSelectLineTable() {
    const table = document.getElementById('panelActivePlayersTable');
    if (!table) return;
    
    const tableBody = table.querySelector('tbody');
    const tableHead = table.querySelector('thead');
    if (!tableBody || !tableHead) return;
    
    // Clear existing content
    tableBody.innerHTML = '';
    tableHead.innerHTML = '';
    
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !currentTeam || !currentTeam.teamRoster) return;
    
    // Get current pending selections
    const pendingLine = game.pendingNextLine || {};
    const activeType = pendingLine.activeType || 'od';
    const selectedPlayers = pendingLine[activeType + 'Line'] || [];
    
    // Create header rows (score display)
    const runningScores = typeof getRunningScores === 'function' 
        ? getRunningScores() 
        : { team: [0], opponent: [0] };
    
    const teamScoreRow = document.createElement('tr');
    const opponentScoreRow = document.createElement('tr');
    
    // Add score cells helper
    const addScoreCells = (row, teamName, scores) => {
        const nameCell = document.createElement('th');
        nameCell.textContent = teamName;
        nameCell.setAttribute('colspan', '3');
        nameCell.classList.add('active-header-teams');
        row.appendChild(nameCell);
        
        scores.forEach((score, index) => {
            const scoreCell = document.createElement('th');
            scoreCell.textContent = score;
            
            // Color score cells based on gender ratio
            if (game.alternateGenderRatio === 'Alternating' && game.startingGenderRatio) {
                const genderRatio = typeof getGenderRatioForPoint === 'function'
                    ? getGenderRatioForPoint(game, index)
                    : null;
                if (genderRatio === 'FMP') scoreCell.classList.add('score-cell-fmp');
                else if (genderRatio === 'MMP') scoreCell.classList.add('score-cell-mmp');
            }
            
            row.appendChild(scoreCell);
        });
    };
    
    addScoreCells(teamScoreRow, game.team, runningScores.team);
    addScoreCells(opponentScoreRow, game.opponent, runningScores.opponent);
    
    tableHead.appendChild(teamScoreRow);
    tableHead.appendChild(opponentScoreRow);
    
    // Get last point players for sorting
    const lastPointPlayers = game.points.length > 0
        ? game.points[game.points.length - 1].players
        : [];
    
    // Sort roster (played last point, played any points, not played)
    const sortedRoster = [...currentTeam.teamRoster].sort((a, b) => {
        const aLastPoint = lastPointPlayers.includes(a.name);
        const bLastPoint = lastPointPlayers.includes(b.name);
        const aPlayedAny = game.points.some(p => p.players.includes(a.name));
        const bPlayedAny = game.points.some(p => p.players.includes(b.name));
        
        if (aLastPoint && !bLastPoint) return -1;
        if (!aLastPoint && bLastPoint) return 1;
        if (aPlayedAny && !bPlayedAny) return -1;
        if (!aPlayedAny && bPlayedAny) return 1;
        return a.name.localeCompare(b.name);
    });
    
    // Create player rows
    sortedRoster.forEach((player, idx) => {
        const row = document.createElement('tr');
        
        // Checkbox column
        const checkboxCell = document.createElement('td');
        checkboxCell.classList.add('active-checkbox-column');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('active-checkbox');
        checkbox.checked = selectedPlayers.includes(player.name);
        checkbox.dataset.playerName = player.name;
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);
        
        // Name column
        const nameCell = document.createElement('td');
        nameCell.classList.add('active-name-column');
        nameCell.textContent = typeof formatPlayerName === 'function' 
            ? formatPlayerName(player) 
            : player.name;
        
        // Gender color coding
        if (player.gender === Gender.FMP) nameCell.classList.add('player-fmp');
        else if (player.gender === Gender.MMP) nameCell.classList.add('player-mmp');
        
        // Click name to toggle checkbox
        nameCell.style.cursor = 'pointer';
        nameCell.addEventListener('click', () => checkbox.click());
        row.appendChild(nameCell);
        
        // Time column
        const timeCell = document.createElement('td');
        timeCell.classList.add('active-time-column');
        if (panelShowingTotalStats) {
            timeCell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(player.totalTimePlayed || 0)
                : '0:00';
        } else {
            const gameTime = typeof getPlayerGameTime === 'function'
                ? getPlayerGameTime(player.name)
                : 0;
            timeCell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(gameTime)
                : '0:00';
        }
        row.appendChild(timeCell);
        
        // Point participation columns
        let runningPointTotal = panelShowingTotalStats ? (player.pointsPlayedPreviousGames || 0) : 0;
        game.points.forEach(point => {
            const pointCell = document.createElement('td');
            pointCell.classList.add('active-points-columns');
            if (point.players.includes(player.name)) {
                runningPointTotal++;
                pointCell.textContent = `${runningPointTotal}`;
            } else {
                pointCell.textContent = '-';
            }
            row.appendChild(pointCell);
        });
        
        tableBody.appendChild(row);
    });
    
    // Apply sticky columns
    requestAnimationFrame(() => {
        makePanelColumnsSticky();
    });
    
    // Keep compact view in sync
    updateSelectLineCompactView();
}

/**
 * Update only the time cells in the Select Line table
 * Lightweight function called every second during a point
 */
function updateSelectLineTimeCells() {
    const table = document.getElementById('panelActivePlayersTable');
    if (!table) return;
    
    const timeCells = table.querySelectorAll('.active-time-column');
    if (timeCells.length === 0) return;
    
    // Get all checkboxes to map cells to players
    const checkboxes = table.querySelectorAll('.active-checkbox');
    
    timeCells.forEach((cell, index) => {
        const checkbox = checkboxes[index];
        if (!checkbox) return;
        
        const playerName = checkbox.dataset.playerName;
        if (!playerName) return;
        
        // Find the player in the roster
        const player = currentTeam?.teamRoster?.find(p => p.name === playerName);
        if (!player) return;
        
        // Calculate time based on current display mode
        if (panelShowingTotalStats) {
            // Total stats: player's total time + current game time
            const gameTime = typeof getPlayerGameTime === 'function'
                ? getPlayerGameTime(playerName)
                : 0;
            const totalTime = (player.totalTimePlayed || 0) + gameTime;
            cell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(totalTime)
                : '0:00';
        } else {
            // Game stats: just game time (includes current point if playing)
            const gameTime = typeof getPlayerGameTime === 'function'
                ? getPlayerGameTime(playerName)
                : 0;
            cell.textContent = typeof formatPlayTime === 'function'
                ? formatPlayTime(gameTime)
                : '0:00';
        }
    });
}

// =============================================================================
// Select Line Panel - Compact View
// =============================================================================

// Height threshold for compact mode (in pixels)
const COMPACT_VIEW_THRESHOLD = 60;

// ResizeObserver for detecting panel height changes
let selectLinePanelResizeObserver = null;

/**
 * Update the compact view display with current line selection
 * Shows line type prefix and comma-separated player names with gender colors
 * Truncates names only as needed to fit all players on one line
 */
function updateSelectLineCompactView() {
    const compactView = document.getElementById('selectLineCompactView');
    if (!compactView) return;
    
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game) return;
    
    // Get current pending selections
    const pendingLine = game.pendingNextLine || {};
    const activeType = pendingLine.activeType || 'od';
    const lineKey = activeType + 'Line';
    const selectedNames = pendingLine[lineKey] || [];
    
    // Update line type link
    const linkEl = document.getElementById('compactLineTypeLink');
    if (linkEl) {
        const typeLabels = { o: 'O: ', d: 'D: ', od: 'O/D: ' };
        linkEl.textContent = typeLabels[activeType] || 'O/D: ';
    }
    
    // Update player list
    const listEl = document.getElementById('compactPlayerList');
    if (!listEl) return;
    
    listEl.innerHTML = ''; // Clear existing
    
    if (selectedNames.length === 0) {
        listEl.textContent = '(none selected yet)';
        return;
    }
    
    const roster = currentTeam?.teamRoster || [];
    
    // Get first names for all selected players
    const firstNames = selectedNames.map(name => name.split(' ')[0]);
    
    // Calculate available width for player names
    // Account for the line type link width and some padding
    const containerWidth = compactView.clientWidth;
    const linkWidth = linkEl ? linkEl.offsetWidth : 40;
    const padding = 24; // Left + right padding
    const availableWidth = containerWidth - linkWidth - padding;
    
    // Build the display with smart truncation
    // Start with full first names and progressively truncate if needed
    const displayNames = renderCompactPlayerNames(firstNames, selectedNames, roster, listEl, availableWidth);
}

/**
 * Render player names with smart truncation to fit available width
 * @param {string[]} firstNames - Array of first names
 * @param {string[]} fullNames - Array of full names (for roster lookup)
 * @param {Array} roster - Team roster for gender lookup
 * @param {HTMLElement} container - Container element to render into
 * @param {number} availableWidth - Available width in pixels
 */
function renderCompactPlayerNames(firstNames, fullNames, roster, container, availableWidth) {
    const SEPARATOR = ', ';
    const ELLIPSIS = '…';
    const CHAR_WIDTH_ESTIMATE = 8; // Approximate pixels per character
    
    // Calculate total length with full first names
    const separatorLength = (firstNames.length - 1) * SEPARATOR.length;
    const totalChars = firstNames.reduce((sum, name) => sum + name.length, 0) + separatorLength;
    const estimatedWidth = totalChars * CHAR_WIDTH_ESTIMATE;
    
    let displayNames = [...firstNames];
    
    // If estimated width exceeds available, progressively truncate longest names
    if (estimatedWidth > availableWidth) {
        const targetChars = Math.floor(availableWidth / CHAR_WIDTH_ESTIMATE) - separatorLength;
        const charsPerName = Math.max(2, Math.floor(targetChars / firstNames.length));
        
        // Sort names by length (longest first) to truncate them first
        const namesByLength = firstNames
            .map((name, idx) => ({ name, idx, len: name.length }))
            .sort((a, b) => b.len - a.len);
        
        let totalUsed = firstNames.reduce((sum, n) => sum + n.length, 0);
        
        // Truncate longest names first until we fit
        for (const item of namesByLength) {
            if (totalUsed <= targetChars) break;
            
            const maxLen = Math.max(2, charsPerName);
            if (item.name.length > maxLen) {
                const truncatedLen = maxLen - 1; // Leave room for ellipsis
                const savings = item.name.length - truncatedLen;
                displayNames[item.idx] = item.name.substring(0, truncatedLen) + ELLIPSIS;
                totalUsed -= savings;
            }
        }
    }
    
    // Render the names with gender colors
    displayNames.forEach((displayName, index) => {
        if (index > 0) {
            container.appendChild(document.createTextNode(SEPARATOR));
        }
        
        const span = document.createElement('span');
        const player = roster.find(p => p.name === fullNames[index]);
        
        span.textContent = displayName;
        
        // Apply gender color
        if (player) {
            if (player.gender === Gender.FMP) span.classList.add('player-fmp');
            else if (player.gender === Gender.MMP) span.classList.add('player-mmp');
        }
        
        container.appendChild(span);
    });
}

/**
 * Cycle through line types when compact view link is tapped
 * Cycles: O → D → O/D → O...
 */
function handleCompactLineTypeTap() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game) return;
    
    // Initialize pendingNextLine if needed
    if (!game.pendingNextLine) {
        game.pendingNextLine = {
            activeType: 'od',
            odLine: [],
            oLine: [],
            dLine: []
        };
    }
    
    const currentType = game.pendingNextLine.activeType || 'od';
    const cycleOrder = ['o', 'd', 'od'];
    const currentIndex = cycleOrder.indexOf(currentType);
    const nextIndex = (currentIndex + 1) % cycleOrder.length;
    
    // Update active type (local-only, not synced)
    game.pendingNextLine.activeType = cycleOrder[nextIndex];
    
    // Update compact view to show new line
    updateSelectLineCompactView();
    
    // Also update the full view so it's in sync when panel expands
    // Update the O/D toggle button
    updateODToggleButton();
    updateSelectLineTable();
    
    // Save changes
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
}

/**
 * Check panel content height and switch between compact/full views
 * Called when panel is resized
 */
function checkSelectLinePanelCompactMode() {
    const panel = document.getElementById('panel-selectLine');
    if (!panel) return;
    
    const contentArea = panel.querySelector('.panel-content');
    if (!contentArea) return;
    
    const compactView = document.getElementById('selectLineCompactView');
    const fullView = document.getElementById('selectLineFullView');
    
    if (!compactView || !fullView) return;
    
    // Get the content area height (excludes title bar)
    const contentHeight = contentArea.clientHeight;
    
    const isCompact = contentHeight < COMPACT_VIEW_THRESHOLD;
    
    if (isCompact) {
        compactView.style.display = 'block';
        fullView.style.display = 'none';
        updateSelectLineCompactView();
    } else {
        compactView.style.display = 'none';
        fullView.style.display = 'flex';
    }
}

/**
 * Initialize the compact view resize observer
 * Sets up a ResizeObserver to detect when the panel content area changes size
 */
function initSelectLineCompactViewObserver() {
    const panel = document.getElementById('panel-selectLine');
    if (!panel) return;
    
    const contentArea = panel.querySelector('.panel-content');
    if (!contentArea) return;
    
    // Clean up any existing observer
    if (selectLinePanelResizeObserver) {
        selectLinePanelResizeObserver.disconnect();
    }
    
    // Create new observer
    selectLinePanelResizeObserver = new ResizeObserver((entries) => {
        // Debounce check to avoid excessive updates during drag
        requestAnimationFrame(() => {
            checkSelectLinePanelCompactMode();
        });
    });
    
    selectLinePanelResizeObserver.observe(contentArea);
    
    // Wire up click handler for line type cycling
    const linkEl = document.getElementById('compactLineTypeLink');
    if (linkEl) {
        linkEl.addEventListener('click', handleCompactLineTypeTap);
    }
    
    // Do initial check
    checkSelectLinePanelCompactMode();
}

/**
 * Make panel table columns sticky (similar to legacy makeColumnsSticky)
 */
function makePanelColumnsSticky() {
    const checkboxCells = document.querySelectorAll('#panelActivePlayersTable .active-checkbox-column');
    const nameCells = document.querySelectorAll('#panelActivePlayersTable .active-name-column');
    const timeCells = document.querySelectorAll('#panelActivePlayersTable .active-time-column');
    const headerCells = document.querySelectorAll('#panelActivePlayersTable .active-header-teams');
    
    if (checkboxCells.length === 0) return;
    
    // Get widths
    const checkboxWidth = checkboxCells[0].getBoundingClientRect().width || 30;
    const nameWidth = nameCells.length > 0 ? nameCells[0].getBoundingClientRect().width : 0;
    
    // Apply sticky styles to checkbox column
    checkboxCells.forEach(cell => {
        cell.style.position = 'sticky';
        cell.style.left = '0';
        cell.style.zIndex = '4';
        cell.style.backgroundColor = '#fafafa';
        cell.style.boxShadow = 'inset -2px 0 0 0 #888, inset 1px 0 0 0 grey, inset 0 -1px 0 0 grey';
        cell.style.border = 'none';
    });
    
    // Apply sticky styles to name column
    nameCells.forEach(cell => {
        cell.style.position = 'sticky';
        cell.style.left = `${checkboxWidth}px`;
        cell.style.zIndex = '3';
        cell.style.backgroundColor = '#fafafa';
        cell.style.boxShadow = 'inset -2px 0 0 0 #888, inset 0 -1px 0 0 grey';
        cell.style.border = 'none';
    });
    
    // Apply sticky styles to time column
    timeCells.forEach(cell => {
        cell.style.position = 'sticky';
        cell.style.left = `${checkboxWidth + nameWidth}px`;
        cell.style.zIndex = '3';
        cell.style.backgroundColor = '#fafafa';
        cell.style.boxShadow = 'inset -2px 0 0 0 #888, inset 0 -1px 0 0 grey';
        cell.style.border = 'none';
    });
    
    // Apply sticky styles to header cells
    headerCells.forEach(cell => {
        cell.style.position = 'sticky';
        cell.style.left = '0';
        cell.style.zIndex = '5';
        cell.style.backgroundColor = '#fafafa';
        cell.style.boxShadow = 'inset -2px 0 0 0 #888, inset 1px 0 0 0 grey, inset 0 -1px 0 0 grey';
        cell.style.border = 'none';
    });
    
    // Scroll to right (show most recent points)
    const tableContainer = document.getElementById('panelTableContainer');
    if (tableContainer) {
        tableContainer.scrollLeft = tableContainer.scrollWidth;
    }
}

/**
 * Full update of the Select Line panel
 * Called when entering game screen or game state changes
 */
function updateSelectLinePanel() {
    updateSelectLineTable();
    updateSelectLinePanelState();
    updateODToggleButton();
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
    
    // Check if we're in "local mode" - no roles claimed by anyone
    // In this case, the user has implicit control of both roles
    const isLocalMode = !state.activeCoach && !state.lineCoach;
    
    // Update Active Coach button
    const iAmActiveCoach = state.activeCoach?.userId === myUserId;
    activeBtn.classList.remove('has-role', 'other-has-role', 'pending-handoff', 'role-available');
    
    if (iAmActiveCoach || isLocalMode) {
        // I explicitly have this role OR local mode (no server/sharing)
        activeBtn.classList.add('has-role');
        if (activeHolder) activeHolder.textContent = isLocalMode ? 'You (local)' : 'You';
    } else if (state.pendingHandoff?.role === 'activeCoach' && state.pendingHandoff?.requesterId === myUserId) {
        // I've requested this role
        activeBtn.classList.add('pending-handoff');
        if (activeHolder) activeHolder.textContent = 'Requesting...';
    } else if (state.activeCoach) {
        // Someone else has this role
        activeBtn.classList.add('other-has-role');
        if (activeHolder) activeHolder.textContent = state.activeCoach.displayName || 'Someone';
    } else {
        // Role is truly unclaimed (rare - only after timeout)
        activeBtn.classList.add('role-available');
        if (activeHolder) activeHolder.textContent = 'Available';
    }
    
    // Update Line Coach button
    const iAmLineCoach = state.lineCoach?.userId === myUserId;
    lineBtn.classList.remove('has-role', 'other-has-role', 'pending-handoff', 'role-available');
    
    if (iAmLineCoach || isLocalMode) {
        // I explicitly have this role OR local mode (no server/sharing)
        lineBtn.classList.add('has-role');
        if (lineHolder) lineHolder.textContent = isLocalMode ? 'You (local)' : 'You';
    } else if (state.pendingHandoff?.role === 'lineCoach' && state.pendingHandoff?.requesterId === myUserId) {
        // I've requested this role
        lineBtn.classList.add('pending-handoff');
        if (lineHolder) lineHolder.textContent = 'Requesting...';
    } else if (state.lineCoach) {
        // Someone else has this role
        lineBtn.classList.add('other-has-role');
        if (lineHolder) lineHolder.textContent = state.lineCoach.displayName || 'Someone';
    } else {
        // Role is truly unclaimed (rare - only after timeout)
        lineBtn.classList.add('role-available');
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
            // Also update player time cells in Select Line panel
            updateSelectLineTimeCells();
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
    
    // Move dialogs to body so they can be displayed above the game screen
    // These dialogs are children of simpleModeScreen which gets hidden
    ensureDialogVisible('scoreAttributionDialog');
    ensureDialogVisible('keyPlayDialog');
    
    // Show the game screen
    showGameScreen();
    
    // Un-minimize the Play-by-Play panel when a point starts
    // (it's typically minimized between points when Select Next Line is maximized)
    if (typeof maximizePanel === 'function' && typeof isPanelMinimized === 'function') {
        if (isPanelMinimized('playByPlay')) {
            maximizePanel('playByPlay', false); // false = don't minimize other panels
        }
    }
    
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
        
        // Start controller polling for this game
        if (game.id && typeof startControllerPolling === 'function') {
            startControllerPolling(game.id);
        }
    }
    
    // Update team identities in header
    updateHeaderTeamIdentities();
    
    // Update timer display and pause button
    updateTimerDisplay();
    updateTimerPauseButton();
    
    // Start timer updates
    startGameScreenTimerLoop();
    
    // Start game state refresh for syncing with other clients
    startGameStateRefresh();
    
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
    
    // Update Select Next Line panel
    updateSelectLinePanel();
    
    // Set up ResizeObserver for Play-by-Play panel layout
    setupPlayByPlayResizeObserver();
    
    // Set up ResizeObserver for Select Line panel compact view
    initSelectLineCompactViewObserver();
    
    console.log('🎮 Entered game screen');
}

/**
 * Exit the game screen UI
 * Returns to legacy navigation
 */
function exitGameScreen() {
    hideGameScreen();
    stopGameScreenTimerLoop();
    stopGameStateRefresh();
    console.log('🎮 Exited game screen');
}

// =============================================================================
// Integration with Controller State
// =============================================================================

// Track game state refresh interval
let gameStateRefreshIntervalId = null;

/**
 * Start periodic refresh of game state from cloud.
 * - Active Coach: Only refresh pending line (they push game data, not pull)
 * - Everyone else: Refresh full game state (scores, points, events)
 */
function startGameStateRefresh() {
    if (gameStateRefreshIntervalId) {
        return; // Already running
    }
    
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.id) {
        return;
    }
    
    const gameId = game.id;
    
    // Refresh every 3 seconds
    gameStateRefreshIntervalId = setInterval(async () => {
        // Stop if no longer visible
        if (!isGameScreenVisible()) {
            stopGameStateRefresh();
            return;
        }
        
        // Check if we're the Active Coach
        const state = typeof getControllerState === 'function' ? getControllerState() : {};
        const isActiveCoach = state.isActiveCoach;
        
        if (isActiveCoach) {
            // Active Coach: Only refresh pending line (between points)
            // They are the authoritative source for game data
            if (typeof isPointInProgress === 'function' && !isPointInProgress()) {
                if (typeof refreshPendingLineFromCloud === 'function') {
                    const updated = await refreshPendingLineFromCloud(gameId);
                    if (updated) {
                        updateSelectLinePanel();
                    }
                }
            }
        } else {
            // Line Coach / Viewer: Refresh full game state
            if (typeof refreshGameStateFromCloud === 'function') {
                const updated = await refreshGameStateFromCloud(gameId);
                if (updated) {
                    // Update all UI elements
                    updateGameScreenAfterRefresh();
                }
            }
        }
    }, 3000);
    
    console.log('🔄 Started game state refresh polling');
}

/**
 * Stop periodic refresh of game state
 */
function stopGameStateRefresh() {
    if (gameStateRefreshIntervalId) {
        clearInterval(gameStateRefreshIntervalId);
        gameStateRefreshIntervalId = null;
        console.log('⏹️ Stopped game state refresh polling');
    }
}

// Aliases for backwards compatibility
function startPendingLineRefresh() { startGameStateRefresh(); }
function stopPendingLineRefresh() { stopGameStateRefresh(); }

/**
 * Update all game screen UI elements after a game state refresh
 */
function updateGameScreenAfterRefresh() {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game) return;
    
    // Update score display
    const usScore = game.scores ? game.scores[Role.TEAM] : 0;
    const themScore = game.scores ? game.scores[Role.OPPONENT] : 0;
    updateGameScreenScore(usScore, themScore);
    
    // Update game log panel
    updateGameLogPanel();
    updateGameLogEvents();
    
    // Update Select Line panel (player stats, etc.)
    updateSelectLinePanel();
    updateSelectLineTable();
    
    // Update Play-by-Play panel state
    updatePlayByPlayPanelState();
    
    console.log('🔄 Updated UI after game state refresh');
}

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
        // Update Select Line panel permissions when roles change
        updateSelectLinePanelState();
        
        // Always keep game state refresh running (for viewers to see updates)
        startGameStateRefresh();
    }
};

// =============================================================================
// Integration with moveToNextPoint
// =============================================================================

// Hook into moveToNextPoint to handle panel UI transitions
// This is called after a score event to prepare for the next point
const originalMoveToNextPoint = window.moveToNextPoint;
window.moveToNextPoint = function() {
    // Call original if it exists
    if (typeof originalMoveToNextPoint === 'function') {
        originalMoveToNextPoint();
    }
    
    // If game screen is visible, transition to between-points state
    if (isGameScreenVisible()) {
        transitionToBetweenPoints();
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

// Between-points transition
window.transitionToBetweenPoints = transitionToBetweenPoints;
window.ensureDialogVisible = ensureDialogVisible;

// Select Next Line panel
window.updateSelectLinePanel = updateSelectLinePanel;
window.updateSelectLineTable = updateSelectLineTable;
window.updateSelectLinePanelState = updateSelectLinePanelState;
window.canEditSelectLinePanel = canEditSelectLinePanel;
window.getSelectedPlayersFromPanel = getSelectedPlayersFromPanel;
window.savePanelSelectionsToPendingNextLine = savePanelSelectionsToPendingNextLine;

