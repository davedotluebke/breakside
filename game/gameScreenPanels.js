/*
 * Game screen — panel construction & HTML templates.
 * Builds the header, role-buttons, play-by-play, select-line, game-log and
 * follow panels and assembles the game screen container; header identity.
 * Split from the former monolithic gameScreen.js (refactor, no behavior change).
 */
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
import { currentTeam } from '../store/storage.js';
import { currentGame } from '../utils/helpers.js';
import { createPanelTitleBar } from '../ui/panelSystem.js';
import { isLineCoach } from './controllerState.js';
import { wireGameScreenEvents } from './gameScreenEvents.js';

// =============================================================================
// Game Screen State
// =============================================================================

let gameScreenInitialized = false;

// Line selection is always manual: the coach checks/unchecks players directly.
// Two one-shot action buttons augment that — Wholesale (clear all) and Auto
// (fill empty slots up to the field count). There is no persistent "mode".

// Blank-checkbox icon for Wholesale (clear the line) and a lightning-bolt icon
// for Auto (one-tap fill). Inline SVG so they inherit currentColor and need no
// extra asset load. See .select-line-action-btn in panelSystem.css.
const WHOLESALE_ICON_SVG = '<svg class="select-line-action-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const AUTO_ICON_SVG = '<svg class="select-line-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.5 L4 9 H7 L6.4 14.5 L12 6.8 H8.7 Z" fill="currentColor"/></svg>';

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
        <div class="header-menu-container">
            <button class="header-menu-btn" id="gameMenuBtn" title="Menu">
                <i class="fas fa-bars"></i>
            </button>
            <div class="header-menu-dropdown" id="gameMenuDropdown">
                <button class="menu-item" id="menuRejoinGame" style="display: none;">
                    <i class="fas fa-plug"></i> Rejoin Game
                </button>
                <button class="menu-item" id="menuLeaveGame">
                    <i class="fas fa-sign-out-alt"></i> Leave Game
                </button>
                <button class="menu-item menu-item-danger" id="menuEndGame">
                    <i class="fas fa-stop-circle"></i> End Game
                </button>
                <div class="menu-divider"></div>
                <button class="menu-item" id="menuRoster">
                    <i class="fas fa-users"></i> Edit Roster
                </button>
                <button class="menu-item" id="menuGameSettings">
                    <i class="fas fa-sliders-h"></i> Game Settings
                </button>
                <button class="menu-item" id="menuTeamSettings">
                    <i class="fas fa-shield-alt"></i> Team Settings
                </button>
                <button class="menu-item" id="menuToggleRoleButtons">
                    <i class="fas fa-user-tag"></i> Show Role Buttons
                </button>
                <div class="menu-divider" id="menuFieldFlipDivider" style="display: none;"></div>
                <button class="menu-item" id="menuSwapHomeAway" style="display: none;">
                    <i class="fas fa-exchange-alt"></i> Swap Home / Away
                </button>
                <button class="menu-item" id="menuSwapAttackDefend" style="display: none;">
                    <i class="fas fa-exchange-alt"></i> Swap Attack / Defend
                </button>
                <button class="menu-item" id="menuSwitchSides" style="display: none;">
                    <i class="fas fa-retweet"></i> Switch Sides (halftime)
                </button>
                <div class="menu-divider"></div>
                <button class="menu-item" id="menuSettings">
                    <i class="fas fa-cog"></i> Advanced Settings
                </button>
                <button class="menu-item" id="menuAbout">
                    <i class="fas fa-info-circle"></i> About / Version
                </button>
            </div>
        </div>
        
        <div class="header-logo-container">
            <img src="images/logo.wordmark.png" alt="Breakside" class="header-logo" id="gameScreenLogo">
            <span class="header-version-overlay" id="gameVersionOverlay"></span>
        </div>
        <span class="header-staging-pill header-staging-pill--game">Staging</span>

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

    // Segmented tab control
    const segRow = document.createElement('div');
    segRow.className = 'header-seg-row';
    segRow.innerHTML = `
        <div class="header-seg-control" id="headerSegControl">
            <div class="header-seg-slider" id="headerSegSlider"></div>
            <button data-tab="simple">Simple</button>
            <button data-tab="full">Full</button>
            <button data-tab="field">Field</button>
            <button data-tab="line">Line</button>
            <button data-tab="log">Log</button>
            <button data-tab="all" class="active">All</button>
        </div>
    `;
    panel.appendChild(segRow);

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
    // - Start Point button (shown between points, hidden during points)
    // - Main row: We Score, They Score, Key Play (Key Play hidden in compact via CSS)
    // - Action row: Undo, Sub, Events, More (hidden in expanded/medium via CSS)
    // Note: Score button labels use separate spans for wrapping in "full" layout
    content.innerHTML = `
        <button id="pbpStartPointBtn" class="pbp-start-point-btn" style="display: none;">
            Start Point
        </button>
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
        showDragHandle: false
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
 * Contains: compact toolbar row with toggles, gender badge, and player selection table
 * @returns {HTMLElement}
 */
function createSelectLineContent() {
    const content = document.createElement('div');
    content.className = 'select-line-content';

    content.innerHTML = `
        <div class="line-tab-action-row">
            <button id="lineTabStartPointBtn" class="pbp-start-point-btn line-tab-start-point-btn" style="display: none;">
                Start Point
            </button>
            <button id="lineTabLineupReadyBtn" class="pbp-start-point-btn line-tab-lineup-ready-btn" style="display: none;">
                Lineup Ready
            </button>
        </div>
        <div class="select-line-toolbar">
            <button class="select-line-action-btn select-line-action-btn--auto" id="panelAutoBtn" title="Auto-fill empty slots to complete the line">
                ${AUTO_ICON_SVG}<span class="select-line-action-label">Auto</span>
            </button>
            <button class="select-line-lines-btn" id="panelLinesBtn">Lines...</button>
            <button class="select-line-mode-btn" id="panelLineModeBtn" title="Choose line-planning mode">Mode: O/D</button>
            <button class="select-line-od-toggle" id="panelODToggle" title="Toggle line type">O/D</button>
            <span class="select-line-gender-badge" id="panelGenderBadge" style="display: none;"></span>
            <span class="select-line-toolbar-spacer"></span>
        </div>
        <!-- AC-only awareness label: rendered by updateLineCoachViewingLabel
             when the LC is viewing/editing a different line type than the AC.
             Hidden in solo / dual-role / matching-view cases. -->
        <div class="select-line-lc-viewing" id="selectLineLcViewing" style="display: none;"></div>
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
        title: 'Next Line',
        showDragHandle: true
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

/**
 * If the current user is the Line Coach, mirror their just-set activeType
 * into the synced `lineCoachViewing` field (with timestamp) so the Active
 * Coach's panel can render a "Line Coach: viewing the X line" sub-header.
 *
 * Gated on `isLineCoach()` so the AC's own local view never leaks into the
 * synced field. No-op when the current user doesn't hold the LC role.
 *
 * Call this from every site that writes `pendingNextLine.activeType` as a
 * direct result of a user view-toggle (currently just `handleODToggle`).
 * Auto-sync writes from `autoSelectActiveTypeForNextPoint` are intentionally
 * NOT instrumented — that function fires on both AC and LC devices and
 * isn't an explicit LC viewing action.
 */
function noteLineCoachViewing() {
    if (typeof isLineCoach !== 'function' || !isLineCoach()) return;
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (!game || !game.pendingNextLine) return;
    game.pendingNextLine.lineCoachViewing = game.pendingNextLine.activeType || 'od';
    game.pendingNextLine.lineCoachViewingAt = new Date().toISOString();
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
        showDragHandle: true
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
    // Full PBP panel — sibling of the simple Play-by-Play panel. Only
    // visible when the "Full" tab is active; hidden in All / Simple / Line / Log.
    if (window.fullPbp && typeof window.fullPbp.createPlayByPlayFullPanel === 'function') {
        stack.appendChild(window.fullPbp.createPlayByPlayFullPanel());
    }
    // Field PBP panel — spatial play-by-play entry. Sibling of the simple
    // and full PBP panels; only visible when the "Field" tab is active.
    if (window.fieldPbp && typeof window.fieldPbp.createPlayByPlayFieldPanel === 'function') {
        stack.appendChild(window.fieldPbp.createPlayByPlayFieldPanel());
    }
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

// =============================================================================
// Exports
// =============================================================================

// --- ES-module exports ---
export {
    WHOLESALE_ICON_SVG, AUTO_ICON_SVG,
    initGameScreen, updateHeaderTeamIdentities, noteLineCoachViewing,
    gameScreenInitialized,
};
// window survivor: late-bound back-edge hook (called by teams/teamSettings.js,
// which evaluates before this file)
window.updateHeaderTeamIdentities = updateHeaderTeamIdentities;
// Dropped shim (zero external references found): initGameScreen — its only
// consumer, game/gameScreenSync.js, imports it now.
