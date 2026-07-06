/*
 * Game screen — menu, game-event handlers, sub modal & play-by-play panel state.
 * Wires the game menu / tab controls, handles PBP score/undo/sub buttons and
 * game events (timeout, half, switch sides, end game), and manages the
 * play-by-play panel/start-point button state.
 * Split from the former monolithic gameScreen.js (refactor, no behavior change).
 */
import { Role, Gender, Other, Possession, isTestGame } from '../store/models.js';
import { teams, currentTeam, saveAllTeamsData } from '../store/storage.js';
import {
    currentGame, getLatestPoint, isPointInProgress,
    determineStartingPosition, formatPlayerName,
} from '../utils/helpers.js';
import { refreshPendingLineFromCloud } from '../store/sync.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import {
    hideGameScreen, setPanelVisible, switchTab, getActiveTab,
    updateSegmentedSlider,
} from '../ui/panelSystem.js';
import {
    showScreen, showEditRosterScreen, showEditRosterSubscreen,
    showStartGameScreen,
} from '../screens/navigation.js';
import { showSelectTeamScreen } from '../teams/teamList.js';
import { showTeamSettingsScreen } from '../teams/teamSettings.js';
import { showGameSummaryPostGame } from '../teams/gameSummary.js';
import { showConnectionInfo } from '../teams/syncStatusUI.js';
import { moveToNextPoint, stopCountdown } from './pointManagement.js';
import { updateScore, undoEvent, appVersion } from './gameLogic.js';
import {
    getControllerState, isActiveCoach, isLineCoach, releaseControllerRole,
    stopControllerPolling, getPollingGameId, showControllerToast,
    handleActiveCoachClick, handleLineCoachClick,
} from './controllerState.js';
import { WHOLESALE_ICON_SVG, AUTO_ICON_SVG } from './gameScreenPanels.js';
import {
    autoResumePointTimer, handleTimerToggle, handleTimerPauseClick,
} from './gameTimer.js';
import {
    wireSelectLineEvents, handlePanelStartPoint, clearLineSelection,
    autoFillLineSelection, checkPanelGenderRatio, getEffectiveLineForNextPoint,
    getSelectedPlayersFromPanel, selectAppropriateLineAtPointEnd,
    updateSelectLinePanel, setLastConflictToastPointIndex,
} from './selectLine.js';
import {
    exitGameScreen, updateGameScreenScore, updateGameLogEvents,
    startGameStateRefresh,
} from './gameScreenSync.js';
// Cycle note: scoreAttribution/keyPlayDialog import nothing from this file
// (they pull from models/helpers/storage/gameLogic/pointManagement/
// controllerState only), and neither side calls across at module-eval time,
// so these back-edge imports are safe.
import { showScoreAttributionDialog } from '../playByPlay/scoreAttribution.js';
import { showKeyPlayDialog } from '../playByPlay/keyPlayDialog.js';

// =============================================================================
// Event Wiring
// =============================================================================

// Version overlay timeout
let gameVersionTimeout = null;

/**
 * Wire up all game screen event handlers
 */
function wireGameScreenEvents() {
    // Menu button - toggle dropdown
    const menuBtn = document.getElementById('gameMenuBtn');
    if (menuBtn) {
        menuBtn.addEventListener('click', handleGameMenuClick);
    }
    
    // Menu dropdown items
    const rejoinGameBtn = document.getElementById('menuRejoinGame');
    if (rejoinGameBtn) {
        rejoinGameBtn.addEventListener('click', handleRejoinGame);
    }

    const leaveGameBtn = document.getElementById('menuLeaveGame');
    if (leaveGameBtn) {
        leaveGameBtn.addEventListener('click', handleLeaveGame);
    }
    
    const endGameBtn = document.getElementById('menuEndGame');
    if (endGameBtn) {
        endGameBtn.addEventListener('click', handleEndGame);
    }
    
    const aboutBtn = document.getElementById('menuAbout');
    if (aboutBtn) {
        aboutBtn.addEventListener('click', handleMenuAbout);
    }

    const settingsBtn = document.getElementById('menuSettings');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            closeGameMenu();
            // Open the real per-device settings (Audio Narration, Sync, Field,
            // Hints). Same dialog the app-level hamburger's "Advanced Settings"
            // opens — the in-game menu previously showed a stale panel-drag
            // toggle instead.
            if (window.advancedSettings && typeof window.advancedSettings.showAdvancedSettings === 'function') {
                window.advancedSettings.showAdvancedSettings();
            }
        });
    }

    const rosterBtn = document.getElementById('menuRoster');
    if (rosterBtn) {
        rosterBtn.addEventListener('click', () => {
            closeGameMenu();
            if (typeof hideGameScreen === 'function') hideGameScreen();
            if (typeof showEditRosterScreen === 'function') {
                showEditRosterScreen('gameScreen');
            } else {
                showScreen('teamRosterScreen');
                if (typeof showEditRosterSubscreen === 'function') showEditRosterSubscreen();
            }
            // Ensure "Continue Game" button is active so user can return
            const continueBtn = document.getElementById('continueGameBtn');
            if (continueBtn) continueBtn.classList.remove('inactive');
        });
    }

    const gameSettingsBtn = document.getElementById('menuGameSettings');
    if (gameSettingsBtn) {
        gameSettingsBtn.addEventListener('click', () => {
            closeGameMenu();
            if (typeof hideGameScreen === 'function') hideGameScreen();
            if (typeof showStartGameScreen === 'function') {
                showStartGameScreen('gameScreen');
            }
        });
    }

    const teamSettingsBtn = document.getElementById('menuTeamSettings');
    if (teamSettingsBtn) {
        teamSettingsBtn.addEventListener('click', () => {
            closeGameMenu();
            if (typeof hideGameScreen === 'function') hideGameScreen();
            if (typeof showTeamSettingsScreen === 'function') showTeamSettingsScreen('gameScreen');
        });
    }

    const toggleRoleBtn = document.getElementById('menuToggleRoleButtons');
    if (toggleRoleBtn) {
        toggleRoleBtn.addEventListener('click', () => {
            closeGameMenu();
            const panel = document.getElementById('panel-roleButtons');
            const isVisible = panel && !panel.classList.contains('hidden');
            if (isVisible) {
                if (typeof setPanelVisible === 'function') setPanelVisible('roleButtons', false);
            } else {
                // Set the latch so auto-hide doesn't undo this
                if (typeof window.forceMultiCoachDetected === 'function') window.forceMultiCoachDetected();
                if (typeof setPanelVisible === 'function') setPanelVisible('roleButtons', true);
            }
        });
    }

    // Field tab orientation flips
    const swapHomeAwayBtn = document.getElementById('menuSwapHomeAway');
    if (swapHomeAwayBtn) {
        swapHomeAwayBtn.addEventListener('click', () => {
            closeGameMenu();
            if (window.fieldPbp && typeof window.fieldPbp.swapHomeAway === 'function') window.fieldPbp.swapHomeAway();
        });
    }
    const swapAttackDefendBtn = document.getElementById('menuSwapAttackDefend');
    if (swapAttackDefendBtn) {
        swapAttackDefendBtn.addEventListener('click', () => {
            closeGameMenu();
            if (window.fieldPbp && typeof window.fieldPbp.swapAttackDefend === 'function') window.fieldPbp.swapAttackDefend();
        });
    }
    const switchSidesBtn2 = document.getElementById('menuSwitchSides');
    if (switchSidesBtn2) {
        switchSidesBtn2.addEventListener('click', () => {
            closeGameMenu();
            applySwitchSides();
        });
    }

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('gameMenuDropdown');
        const menuBtn = document.getElementById('gameMenuBtn');
        if (dropdown && dropdown.classList.contains('visible')) {
            if (!dropdown.contains(e.target) && e.target !== menuBtn) {
                closeGameMenu();
            }
        }
    });
    
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
            let versionText = typeof appVersion !== 'undefined' && appVersion
                ? `v${appVersion.version} (${appVersion.build})`
                : 'v?.?.?';
            if (window.APP_DEPLOY_LABEL) {
                versionText += ` [${window.APP_DEPLOY_LABEL}]`;
            }
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

    // Segmented tab control
    wireTabControlEvents();
}

/**
 * Wire up segmented tab control events
 */
function wireTabControlEvents() {
    const segControl = document.getElementById('headerSegControl');
    if (!segControl) return;

    const buttons = segControl.querySelectorAll('button[data-tab]');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            if (typeof switchTab === 'function') {
                switchTab(btn.dataset.tab);
            }
        });
    });

    // Position slider on initial active button
    requestAnimationFrame(() => {
        if (typeof updateSegmentedSlider === 'function') {
            updateSegmentedSlider();
        }
    });

    // Reposition slider on resize / orientation change. Defer to the next
    // frame so the measurement runs after the browser has reflowed to the
    // new viewport — measuring synchronously here reads stale (pre-reflow)
    // button geometry, which left the slider mis-sized when rotating back
    // to portrait. orientationchange is included because some mobile
    // browsers fire it without a paired resize.
    const repositionSlider = () => {
        requestAnimationFrame(() => {
            if (typeof updateSegmentedSlider === 'function') {
                updateSegmentedSlider();
            }
        });
    };
    window.addEventListener('resize', repositionSlider);
    window.addEventListener('orientationchange', repositionSlider);
}

/**
 * Handle menu button click - toggle dropdown menu
 */
function handleGameMenuClick(e) {
    e.stopPropagation();
    const dropdown = document.getElementById('gameMenuDropdown');
    if (dropdown) {
        dropdown.classList.toggle('visible');

        // Show "Rejoin Game" whenever controller polling isn't active.
        // The previous version also required `currentGame()` to return a
        // game with an id, but in the PWA-reload-from-background case
        // `currentTeam` may not have been restored yet — leaving the
        // user looking at a stale game-screen DOM with no live state, and
        // hiding the very button they need. The handler itself bails
        // gracefully if there's nothing to rejoin.
        const rejoinGameBtn = document.getElementById('menuRejoinGame');
        if (rejoinGameBtn) {
            const pollingActive = (typeof window.isControllerPollingActive === 'function')
                && window.isControllerPollingActive();
            const showRejoin = !pollingActive;
            rejoinGameBtn.style.display = showRejoin ? '' : 'none';
            console.log('🔌 Rejoin Game visibility:',
                { pollingActive, showRejoin,
                  pollingGameId: (typeof window.getPollingGameId === 'function') ? window.getPollingGameId() : '(unavailable)',
                  hasCurrentGame: !!(typeof currentGame === 'function' && currentGame()?.id) });
        } else {
            console.warn('🔌 Rejoin Game button not found in DOM — HTML may be stale');
        }

        // Field orientation flips only make sense on the Field tab — show them
        // there, hide elsewhere.
        const onFieldTab = (typeof window.getActiveTab === 'function') && window.getActiveTab() === 'field';
        ['menuFieldFlipDivider', 'menuSwapHomeAway', 'menuSwapAttackDefend', 'menuSwitchSides'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = onFieldTab ? '' : 'none';
        });

        // Update role buttons toggle label
        const toggleRoleBtn = document.getElementById('menuToggleRoleButtons');
        if (toggleRoleBtn) {
            const rolePanel = document.getElementById('panel-roleButtons');
            const roleVisible = rolePanel && !rolePanel.classList.contains('hidden');
            toggleRoleBtn.innerHTML = roleVisible
                ? '<i class="fas fa-user-tag"></i> Hide Role Buttons'
                : '<i class="fas fa-user-tag"></i> Show Role Buttons';
        }

        // Hide End Game for viewers, disable for non-role-holding coaches
        const endGameBtn = document.getElementById('menuEndGame');
        if (endGameBtn) {
            const viewerMode = typeof window.isViewer === 'function' && window.isViewer();
            if (viewerMode) {
                endGameBtn.style.display = 'none';
            } else {
                endGameBtn.style.display = '';
                const canEnd = canEditPlayByPlayPanel() ||
                    (typeof isLineCoach === 'function' && isLineCoach());
                endGameBtn.disabled = !canEnd;
                endGameBtn.title = canEnd ? 'End the game' : 'Only Active or Line Coach can end the game';
            }
        }
    }
}

/**
 * Close the menu dropdown
 */
function closeGameMenu() {
    const dropdown = document.getElementById('gameMenuDropdown');
    if (dropdown) {
        dropdown.classList.remove('visible');
    }
}

/**
 * Handle "Rejoin Game" — re-establish controller polling without
 * leaving the game screen.
 *
 * Triggered when the user is still on the game screen but polling has
 * been stopped (PWA reload from background, network blip, etc.). The
 * fix is just to call startControllerPolling with the current in-memory
 * game id; that re-installs the ping interval, fetches fresh server
 * state, and the existing role-claim UI handles re-acquiring roles.
 */
function handleRejoinGame() {
    closeGameMenu();

    // Try a couple of paths to find the in-progress game id. The
    // straightforward `currentGame()` works in the common case, but if
    // the JS context restarted (PWA reloaded from background) and
    // `currentTeam` hasn't been restored yet, we may need to look in
    // localStorage. As a last resort, walk the in-memory `teams` array
    // for any non-ended game.
    let game = (typeof currentGame === 'function') ? currentGame() : null;
    let resolvedFrom = 'currentGame()';

    if (!game?.id && typeof teams !== 'undefined' && Array.isArray(teams)) {
        for (const team of teams) {
            if (!team?.games?.length) continue;
            const inProgress = team.games.find(g => g && !g.gameEndTimestamp);
            if (inProgress?.id) {
                game = inProgress;
                resolvedFrom = `teams[${team.teamName || '?'}].games`;
                break;
            }
        }
    }

    console.log('🔌 Rejoin Game tapped — resolved:', { game: game?.id, resolvedFrom });

    if (!game?.id) {
        if (typeof showControllerToast === 'function') {
            showControllerToast(
                'No in-progress game found — leave and rejoin from the team list',
                'warning', 4000);
        }
        return;
    }

    if (typeof window.startControllerPolling === 'function') {
        window.startControllerPolling(game.id);
    }
    // Game-state refresh may also have been stopped — restart it so the
    // viewer/Line-Coach branches see live updates again.
    if (typeof startGameStateRefresh === 'function') {
        startGameStateRefresh();
    }
    if (typeof showControllerToast === 'function') {
        showControllerToast('Reconnected — tap a role button to reclaim it', 'success', 3500);
    }
}

/**
 * Handle Leave Game - exit without ending
 */
function handleLeaveGame() {
    closeGameMenu();

    // Test games are leave/rejoined constantly during dev — skip the confirm.
    const skipConfirm = typeof isTestGame === 'function'
        && typeof currentGame === 'function' && isTestGame(currentGame());
    if (skipConfirm || confirm('Leave this game? You can rejoin later.')) {
        // Release any held roles. releaseControllerRole requires the specific
        // role ('activeCoach'/'lineCoach') — calling it with none sends
        // {role: undefined} and releases nothing, leaving a stale holder until
        // ping-timeout. Release each role this user actually holds.
        if (typeof releaseControllerRole === 'function') {
            const gameId = typeof getPollingGameId === 'function' ? getPollingGameId() : null;
            if (gameId) {
                const heldRoles = [];
                if (typeof isActiveCoach === 'function' && isActiveCoach()) heldRoles.push('activeCoach');
                if (typeof isLineCoach === 'function' && isLineCoach()) heldRoles.push('lineCoach');
                heldRoles.forEach(role => {
                    releaseControllerRole(gameId, role).catch(err => {
                        console.log(`Could not release ${role} role:`, err);
                    });
                });
            }
        }
        
        // Stop polling
        if (typeof stopControllerPolling === 'function') {
            stopControllerPolling();
        }
        
        // Exit game screen and return to team selection
        exitGameScreen();
        if (typeof showSelectTeamScreen === 'function') {
            showSelectTeamScreen();
        } else if (typeof showScreen === 'function') {
            showScreen('teamSelectScreen');
        }
    }
}

/**
 * Handle End Game - end the game (requires Active or Line Coach role)
 */
function handleEndGame() {
    closeGameMenu();
    
    // Check if user has permission
    const isActive = canEditPlayByPlayPanel();
    const isLine = typeof isLineCoach === 'function' && isLineCoach();
    
    if (!isActive && !isLine) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('Only Active or Line Coach can end the game', 'warning');
        }
        return;
    }
    
    // Use existing end game confirmation if available
    // (endGameConfirm has no module owner — legacy global, not defined
    // anywhere in the current codebase, so the fallback below always runs)
    if (typeof window.endGameConfirm === 'function') {
        window.endGameConfirm();
    } else {
        // Fallback: implement end game logic directly
        // Skip the confirm for test games (throwaway dev data).
        const skipEndConfirm = typeof isTestGame === 'function'
            && typeof currentGame === 'function' && isTestGame(currentGame());
        if (!skipEndConfirm && !confirm('Are you sure you want to end the game?')) {
            return;
        }
        
        // Stop any running timers
        if (typeof stopCountdown === 'function') {
            stopCountdown();
        }
        
        // Set game end timestamp
        if (typeof currentGame === 'function' && currentGame()) {
            currentGame().gameEndTimestamp = new Date();
        }
        
        // Exit game screen
        exitGameScreen();
        
        // Show game summary screen
        if (typeof showGameSummaryPostGame === 'function') {
            showGameSummaryPostGame();
        }

        // Save data
        if (typeof saveAllTeamsData === 'function') {
            saveAllTeamsData();
        }
    }
}

/**
 * Handle About/Version - show connection info toast
 */
function handleMenuAbout() {
    closeGameMenu();
    
    // Use the same function as the Online status tap
    if (typeof showConnectionInfo === 'function') {
        showConnectionInfo();
    }
}

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

    // Line tab's Undo + Events buttons — same handlers as the PBP row's
    // (role checks included). Visibility is managed by
    // updateLineTabStartPointBtn (shown only while the Line tab is active).
    const lineTabUndoBtn = document.getElementById('lineTabUndoBtn');
    if (lineTabUndoBtn) {
        lineTabUndoBtn.addEventListener('click', handlePbpUndo);
    }
    const lineTabGameEventsBtn = document.getElementById('lineTabGameEventsBtn');
    if (lineTabGameEventsBtn) {
        lineTabGameEventsBtn.addEventListener('click', handlePbpGameEvents);
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
    
    // Start Point button (shown when Select Line panel is minimized)
    const pbpStartPointBtn = document.getElementById('pbpStartPointBtn');
    if (pbpStartPointBtn) {
        pbpStartPointBtn.addEventListener('click', handlePanelStartPoint);
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
    const MEDIUM_MIN_HEIGHT = 160; // Content must be ≥120px for medium layout (+ ~36px title bar)

    if (currentHeight < MEDIUM_MIN_HEIGHT) {
        // Expand to medium height
        panel.style.height = `${MEDIUM_MIN_HEIGHT}px`;
        panel.style.flex = '0 0 auto';
        
        // Try to use panelSystem API if available
        if (typeof window.setPanelState === 'function') {
            window.setPanelState('playByPlay', { height: MEDIUM_MIN_HEIGHT });
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
    const point = getLatestPoint();
    if (point && point.startTimestamp) {
        point.totalPointTime = (point.totalPointTime || 0) + (Date.now() - new Date(point.startTimestamp).getTime());
        point.startTimestamp = null;
    }
    
    // Ensure the dialog is visible by moving it to body if needed
    ensureDialogVisible('scoreAttributionDialog');
    
    // Use the existing score attribution dialog from scoreAttribution.js.
    // Simple mode doesn't track O/D possession, so Callahan is a valid option
    // here (unlike the offense-only Field / Full PBP score flows).
    if (typeof showScoreAttributionDialog === 'function') {
        showScoreAttributionDialog({ callahanApplicable: true });
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
    const point = getLatestPoint();
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
    
    // Check if point is in progress
    if (typeof isPointInProgress === 'function' && !isPointInProgress()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('No point in progress - use Select Next Line instead', 'info');
        }
        return;
    }
    
    showSubPlayersModal();
}

// =============================================================================
// Sub Players Modal (for mid-point injury substitutions)
// =============================================================================

/**
 * Create the Sub Players modal if it doesn't exist
 */
function createSubPlayersModal() {
    if (document.getElementById('subPlayersModal')) {
        return document.getElementById('subPlayersModal');
    }
    
    const modal = document.createElement('div');
    modal.id = 'subPlayersModal';
    modal.className = 'modal sub-players-modal';
    
    modal.innerHTML = `
        <div class="modal-content sub-players-modal-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>Substitute Players</h2>
                <span class="close" id="subPlayersModalClose">&times;</span>
            </div>
            <div class="sub-players-info">
                <span id="subPlayersCount">7 selected</span>
                <span class="sub-players-actions">
                    <button class="select-line-action-btn" id="subWholesaleBtn" title="Clear all selected players">
                        ${WHOLESALE_ICON_SVG}<span class="select-line-action-label">Wholesale</span>
                    </button>
                    <button class="select-line-action-btn" id="subAutoBtn" title="Auto-fill empty slots to complete the line">
                        ${AUTO_ICON_SVG}<span class="select-line-action-label">Auto</span>
                    </button>
                </span>
            </div>
            <div class="sub-players-table-container" id="subPlayersTableContainer">
                <table class="panel-player-table" id="subPlayersTable">
                    <tbody>
                        <!-- Player rows populated dynamically -->
                    </tbody>
                </table>
            </div>
            <div class="sub-players-buttons">
                <button id="subPlayersCancelBtn" class="ge-btn">Cancel</button>
                <button id="subPlayersConfirmBtn" class="ge-btn ge-btn-confirm">Confirm</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Wire up event handlers
    document.getElementById('subPlayersModalClose').addEventListener('click', hideSubPlayersModal);
    document.getElementById('subPlayersCancelBtn').addEventListener('click', hideSubPlayersModal);
    document.getElementById('subPlayersConfirmBtn').addEventListener('click', confirmSubstitution);
    document.getElementById('subWholesaleBtn')?.addEventListener('click', () => clearLineSelection('sub'));
    document.getElementById('subAutoBtn')?.addEventListener('click', () => autoFillLineSelection('sub'));
    
    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            hideSubPlayersModal();
        }
    });
    
    return modal;
}

/**
 * Show the Sub Players modal and populate with current point players
 */
function showSubPlayersModal() {
    const modal = createSubPlayersModal();
    populateSubPlayersTable();
    modal.style.display = 'block';
}

/**
 * Hide the Sub Players modal
 */
function hideSubPlayersModal() {
    const modal = document.getElementById('subPlayersModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Populate the Sub Players table with current roster
 * Current point players are checked, others are unchecked
 */
function populateSubPlayersTable() {
    const tableBody = document.querySelector('#subPlayersTable tbody');
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    
    const point = getLatestPoint();
    if (!currentTeam || !currentTeam.teamRoster || !point) {
        tableBody.innerHTML = '<tr><td colspan="2">No active point</td></tr>';
        return;
    }
    
    // Get current point players
    const currentPlayers = point.players || [];
    
    // Sort roster: current players first, then alphabetical
    const sortedRoster = [...currentTeam.teamRoster].sort((a, b) => {
        const aInPoint = currentPlayers.includes(a.name);
        const bInPoint = currentPlayers.includes(b.name);
        if (aInPoint && !bInPoint) return -1;
        if (!aInPoint && bInPoint) return 1;
        return a.name.localeCompare(b.name);
    });
    
    sortedRoster.forEach(player => {
        const row = document.createElement('tr');
        
        // Checkbox cell
        const checkboxCell = document.createElement('td');
        checkboxCell.style.width = '40px';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = currentPlayers.includes(player.name);
        checkbox.dataset.playerName = player.name;
        checkbox.addEventListener('change', updateSubPlayersCount);
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);
        
        // Name cell with gender color
        const nameCell = document.createElement('td');
        nameCell.textContent = typeof formatPlayerName === 'function' 
            ? formatPlayerName(player) 
            : player.name;
        if (player.gender === Gender.FMP) nameCell.classList.add('player-fmp');
        else if (player.gender === Gender.MMP) nameCell.classList.add('player-mmp');
        nameCell.style.cursor = 'pointer';
        nameCell.addEventListener('click', () => checkbox.click());
        row.appendChild(nameCell);
        
        tableBody.appendChild(row);
    });
    
    updateSubPlayersCount();
}

/**
 * Update the selected player count display
 */
function updateSubPlayersCount() {
    const countEl = document.getElementById('subPlayersCount');
    if (!countEl) return;

    const checkboxes = document.querySelectorAll('#subPlayersTable input[type="checkbox"]');
    const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    
    countEl.textContent = `${checkedCount} selected`;
    
    // Update confirm button state
    const confirmBtn = document.getElementById('subPlayersConfirmBtn');
    if (confirmBtn) {
        // Disable if no players selected
        confirmBtn.disabled = checkedCount === 0;
    }
}

/**
 * Confirm the substitution and update the current point
 */
function confirmSubstitution() {
    const point = getLatestPoint();
    if (!point) {
        hideSubPlayersModal();
        return;
    }
    
    const checkboxes = document.querySelectorAll('#subPlayersTable input[type="checkbox"]');
    const newPlayers = [];
    
    checkboxes.forEach(cb => {
        if (cb.checked) {
            newPlayers.push(cb.dataset.playerName);
        }
    });
    
    // Determine who came in and who went out
    const previousPlayers = point.players || [];
    const playersOut = previousPlayers.filter(p => !newPlayers.includes(p));
    const playersIn = newPlayers.filter(p => !previousPlayers.includes(p));
    
    // Nothing changed
    if (playersOut.length === 0 && playersIn.length === 0) {
        hideSubPlayersModal();
        return;
    }
    
    // Track substituted-out players for points-played counting
    if (!point.substitutedOutPlayers) {
        point.substitutedOutPlayers = [];
    }
    playersOut.forEach(p => {
        if (!point.substitutedOutPlayers.includes(p)) {
            point.substitutedOutPlayers.push(p);
        }
    });

    // Track substituted-in players too — they also played only part of the
    // point, so the line table italicizes them the same as subbed-out.
    if (!point.substitutedInPlayers) {
        point.substitutedInPlayers = [];
    }
    playersIn.forEach(p => {
        if (!point.substitutedInPlayers.includes(p)) {
            point.substitutedInPlayers.push(p);
        }
    });
    
    // Update current point players
    point.players = newPlayers;
    
    // Log substitution event(s)
    // Get the current possession to add the event to
    const currentPossession = point.possessions.length > 0
        ? point.possessions[point.possessions.length - 1]
        : null;
    
    // Create description for the substitution
    let subDescription = '';
    if (playersIn.length > 0 && playersOut.length > 0) {
        // Format: "Sub: Alice, Bob in for Charlie, Dave"
        const inNames = playersIn.map(name => name.split(' ')[0]).join(', ');
        const outNames = playersOut.map(name => name.split(' ')[0]).join(', ');
        subDescription = `Sub: ${inNames} in for ${outNames}`;
    } else if (playersIn.length > 0) {
        const inNames = playersIn.map(name => name.split(' ')[0]).join(', ');
        subDescription = `Sub: ${inNames} added`;
    } else if (playersOut.length > 0) {
        const outNames = playersOut.map(name => name.split(' ')[0]).join(', ');
        subDescription = `Sub: ${outNames} removed`;
    }
    
    // Create an Other event with the injury flag and description
    const subEvent = new Other({
        injury: true,
        description: subDescription
    });
    
    // Add to current possession if it exists
    if (currentPossession) {
        currentPossession.events.push(subEvent);
    }
    
    // Log to event log
    if (typeof logEvent === 'function') {
        logEvent(subDescription);
    }
    
    // Save and update UI
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
    
    hideSubPlayersModal();
    
    // Update game log if it exists
    if (typeof updateGameLogEvents === 'function') {
        updateGameLogEvents();
    }
    
    // Show confirmation toast
    if (typeof showControllerToast === 'function') {
        showControllerToast(subDescription, 'success');
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
    // Fallback: check if we have Active Coach role using the boolean flag
    if (typeof window.isActiveCoach === 'function') {
        return window.isActiveCoach();
    }
    // If controller system not available, allow (offline mode)
    return true;
}

/**
 * Ensure a dialog element is visible by moving it to body if needed.
 * This fixes the issue where dialogs could be hidden by parent elements
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
    // Reset conflict tracking for new between-points phase (module-scoped
    // state owned by game/selectLine.js — written via its exported setter)
    setLastConflictToastPointIndex(-1);
    
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
        
        // Default next-line selection to the 7 who finished the point (reflects any mid-point subs).
        // O/D line: overwrite only if NOT modified during the just-finished point (compare to point start).
        // O and D lines: overwrite only if they have NEVER been modified this game (separate O/D pools).
        const lastPoint = game.points.length > 0 ? game.points[game.points.length - 1] : null;
        if (lastPoint && lastPoint.players && lastPoint.players.length > 0 && game.pendingNextLine) {
            // Reliable "this point started" reference for the OD-line "modified
            // during this point?" check. We can't use lastPoint.startTimestamp
            // because the score handlers (Simple-mode and Full-mode score taps,
            // and opponent-score) null it to stop the timer, and updateScore
            // then re-sets it to `new Date()` — making it equal to score-time
            // rather than actual point-start. That breaks the original check:
            // any odLine edit made during the point ends up older than the
            // (artificial) "point start" and the line gets clobbered.
            //
            // Use the *previous* point's endTimestamp instead — it's never
            // mutated, and "after the previous point ended" naturally covers
            // both the between-points window AND the current live point, which
            // is what "modified for this upcoming next-point" should mean.
            // For the first point, fall back to gameStartTimestamp.
            const previousPoint = game.points.length > 1
                ? game.points[game.points.length - 2]
                : null;
            const pointStartTime = previousPoint && previousPoint.endTimestamp
                ? new Date(previousPoint.endTimestamp).getTime()
                : (game.gameStartTimestamp
                    ? new Date(game.gameStartTimestamp).getTime()
                    : 0);
            const endingLine = [...lastPoint.players];
            // O/D line: reset to ending 7 unless user explicitly changed mode
            // (wholesale/auto) or modified at any time during this point's
            // window. ALSO reset if the line is currently empty — a
            // *ModifiedAt timestamp doesn't mean the line is useful; an LC
            // who cleared all checkboxes (or any path that left it empty)
            // shouldn't poison every subsequent point with an unstartable
            // empty lineup.
            const odLineCur = game.pendingNextLine.odLine || [];
            const odModTime = game.pendingNextLine.odLineModifiedAt
                ? new Date(game.pendingNextLine.odLineModifiedAt).getTime()
                : 0;
            if (odModTime <= pointStartTime || odLineCur.length === 0) {
                game.pendingNextLine.odLine = endingLine;
            }
            // O and D lines: reset if never modified this game OR currently
            // empty (same empty-line reasoning as above). Without the
            // empty-fallback, an emptied O/D line stays empty across points
            // and — combined with fix8's same-side-only invariant — leaves
            // the AC's Start Point button greyed forever after the line is
            // ever cleared.
            const gameStartTime = game.gameStartTimestamp
                ? new Date(game.gameStartTimestamp).getTime()
                : 0;
            ['o', 'd'].forEach(type => {
                const lineKey = type + 'Line';
                const modKey = lineKey + 'ModifiedAt';
                const lineCur = game.pendingNextLine[lineKey] || [];
                const modTime = game.pendingNextLine[modKey]
                    ? new Date(game.pendingNextLine[modKey]).getTime()
                    : 0;
                if (modTime <= gameStartTime || lineCur.length === 0) {
                    game.pendingNextLine[lineKey] = endingLine;
                }
            });
        }
        
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
    
    // Show modal FIRST — updateGameEventsModalState early-returns while the
    // modal is display:none, so updating before showing left stale states on
    // every reopen (e.g. mid-point Injury-Sub-enabled states surviving into
    // a between-points open).
    modal.style.display = 'flex';

    // Update button states based on game state
    updateGameEventsModalState();
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
                <button id="geInjurySubBtn" class="ge-btn ge-btn-injurysub">
                    <i class="fas fa-exchange-alt"></i>
                    <span>Injury Sub</span>
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

    // Injury Sub button — same flow as the top-level Sub button on Simple
    // mode's PBP panel; available redundantly via the Events modal so
    // Full mode (which doesn't expose a top-level Sub) can still reach it.
    const injurySubBtn = modal.querySelector('#geInjurySubBtn');
    if (injurySubBtn) {
        injurySubBtn.addEventListener('click', handleGameEventInjurySub);
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
 * Handle Injury Sub from the Game Events modal. Routes through
 * handlePbpSubPlayers so the role check + point-in-progress guard +
 * sub-players modal all work the same as Simple mode's top-level Sub
 * button. Closes this modal first so the user sees the sub-players
 * UI cleanly.
 */
function handleGameEventInjurySub() {
    // Between points the button renders disabled (class-only, so this
    // handler still runs) — surface the same toast as the dedicated Sub
    // button rather than doing nothing, and keep the Events modal open.
    if (typeof isPointInProgress === 'function' && !isPointInProgress()) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('No point in progress - use Select Next Line instead', 'info');
        }
        return;
    }
    hideGameEventsModal();
    if (typeof handlePbpSubPlayers === 'function') {
        handlePbpSubPlayers();
    }
}

/**
 * Handle Timeout game event — ask who called it before recording anything.
 * The Other{timeout} event is only created once Us/Them/Neither is chosen
 * in the follow-up dialog; closing it (X or backdrop tap) cancels with no
 * event recorded.
 */
function handleGameEventTimeout() {
    hideGameEventsModal();

    const game = (typeof currentGame === 'function') ? currentGame() : null;
    if (!game || !game.points || !game.points.length) {
        // Nowhere to attach the event yet (game not started / no first point).
        if (typeof showControllerToast === 'function') {
            showControllerToast('No point recorded yet — timeout not saved', 'warning');
        }
        return;
    }

    showTimeoutWhoModal();
}

/**
 * Show the "Who called timeout?" modal (created lazily, like the Game
 * Events modal itself).
 */
function showTimeoutWhoModal() {
    let modal = document.getElementById('timeoutWhoModal');
    if (!modal) {
        modal = createTimeoutWhoModal();
        document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
}

/**
 * Hide the "Who called timeout?" modal
 */
function hideTimeoutWhoModal() {
    const modal = document.getElementById('timeoutWhoModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Create the "Who called timeout?" modal
 * @returns {HTMLElement}
 */
function createTimeoutWhoModal() {
    const modal = document.createElement('div');
    modal.id = 'timeoutWhoModal';
    modal.className = 'modal game-events-modal';

    modal.innerHTML = `
        <div class="modal-content game-events-modal-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>Who called timeout?</h2>
                <span class="close" id="timeoutWhoModalClose">&times;</span>
            </div>
            <div class="game-events-buttons timeout-who-buttons">
                <button id="toWhoUsBtn" class="ge-btn ge-btn-who-us">
                    <i class="fas fa-users"></i>
                    <span>Us</span>
                </button>
                <button id="toWhoThemBtn" class="ge-btn ge-btn-who-them">
                    <i class="fas fa-user-friends"></i>
                    <span>Them</span>
                </button>
                <button id="toWhoNeitherBtn" class="ge-btn ge-btn-who-neither">
                    <i class="fas fa-minus-circle"></i>
                    <span>Neither</span>
                </button>
            </div>
        </div>
    `;

    // X / backdrop tap = cancel: no timeout event is created.
    const closeBtn = modal.querySelector('#timeoutWhoModalClose');
    if (closeBtn) {
        closeBtn.addEventListener('click', hideTimeoutWhoModal);
    }
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            hideTimeoutWhoModal();
        }
    });

    modal.querySelector('#toWhoUsBtn').addEventListener('click', () => recordTimeout('us'));
    modal.querySelector('#toWhoThemBtn').addEventListener('click', () => recordTimeout('them'));
    modal.querySelector('#toWhoNeitherBtn').addEventListener('click', () => recordTimeout('neither'));

    return modal;
}

/**
 * Record a timeout as an Other{timeout} event on the latest point's last
 * possession. Works mid-point and between points — like Switch Sides, a
 * between-points timeout attaches to the just-finished point.
 * @param {'us'|'them'|'neither'} calledBy
 */
function recordTimeout(calledBy) {
    hideTimeoutWhoModal();

    const game = (typeof currentGame === 'function') ? currentGame() : null;
    if (!game || !game.points || !game.points.length) return;

    const point = game.points[game.points.length - 1];
    point.possessions = point.possessions || [];
    let poss = point.possessions[point.possessions.length - 1];
    if (!poss) { poss = new Possession(true); point.possessions.push(poss); }

    // Resolve the display name now — the log reads "Timeout called by
    // Rivals", not "by them" (summarize falls back to us/them for events
    // recorded before calledByName existed).
    const calledByName = calledBy === 'us' ? (game.team || null)
        : calledBy === 'them' ? (game.opponent || null)
        : null;
    // A timeout recorded after the point ended is flagged so the log
    // renderers print it after the "scores!" lines (real-world order).
    const timeoutEvent = new Other({
        timeout: true, calledBy, calledByName,
        betweenPoints: point.winner ? true : null,
    });
    poss.events.push(timeoutEvent);

    const summary = timeoutEvent.summarize().trim();
    if (typeof logEvent === 'function') logEvent(summary);
    if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    if (typeof updateGameLogEvents === 'function') updateGameLogEvents();
    // Publish so subscribed PBP tabs (Full/Field logs) repaint.
    if (window.narrationEventBus && typeof window.narrationEventBus.publish === 'function') {
        window.narrationEventBus.publish('eventAdded', { event: timeoutEvent });
    }
    if (typeof showControllerToast === 'function') {
        showControllerToast(summary, 'success');
    }
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
 * Apply a halftime "Switch Sides": teams swap ends, so the side that pulled
 * from one endzone now receives from the other.
 *
 * Two effects, kept separate:
 *  1. O/D logic — record an Other{switchsides} event on the last completed
 *     point. determineStartingPosition() already inverts the next point's
 *     starting position when it sees this flag, so who starts on O vs D for the
 *     halftime restart flips (or not, depending on the score so far). Before
 *     any point exists, just flip the game's initial startingPosition instead.
 *  2. Field display — flip the attack direction so the drawn field matches the
 *     physical end swap for the rest of the game (the per-point auto-flip then
 *     continues on top of the new base).
 *
 * Halftime happens between points; guarded to not fire mid-point.
 */
function applySwitchSides() {
    const inPoint = (typeof isPointInProgress === 'function') && isPointInProgress();
    if (inPoint) {
        if (typeof showControllerToast === 'function') {
            showControllerToast('Switch sides between points (at halftime)', 'warning');
        }
        return;
    }

    const game = (typeof currentGame === 'function') ? currentGame() : null;
    if (!game) return;

    if (game.points && game.points.length) {
        const lastPoint = game.points[game.points.length - 1];
        lastPoint.possessions = lastPoint.possessions || [];
        let poss = lastPoint.possessions[lastPoint.possessions.length - 1];
        if (!poss) { poss = new Possession(true); lastPoint.possessions.push(poss); }
        // Switch sides always happens between points (guarded above) — flag
        // it so log renderers print it after this point's score lines.
        poss.events.push(new Other({ switchsides: true, betweenPoints: true }));
    } else {
        // No points yet — switching before the first pull just flips the
        // chosen starting position.
        game.startingPosition = (game.startingPosition === 'offense') ? 'defense' : 'offense';
    }

    if (typeof logEvent === 'function') logEvent('O and D switch sides');
    if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    if (typeof updateGameLogEvents === 'function') updateGameLogEvents();

    // Flip the Field-tab display ends to match (persists + re-renders).
    if (window.fieldPbp && typeof window.fieldPbp.swapAttackDefend === 'function') {
        window.fieldPbp.swapAttackDefend();
    }
    // Nudge any subscribed views (Start Point label now reflects new O/D).
    if (window.narrationEventBus && typeof window.narrationEventBus.publish === 'function') {
        window.narrationEventBus.publish('pointChanged', {});
    }
    if (typeof showControllerToast === 'function') showControllerToast('Switched sides', 'info');
}

/**
 * Handle Switch Sides game event (from the Game Events modal).
 */
function handleGameEventSwitchSides() {
    hideGameEventsModal();
    applySwitchSides();
}

/**
 * Handle End Game game event
 */
function handleGameEventEndGame() {
    hideGameEventsModal();
    
    // Use existing end game functionality if available
    // (endGameConfirm has no module owner — legacy global, not defined
    // anywhere in the current codebase, so the fallback below always runs)
    if (typeof window.endGameConfirm === 'function') {
        window.endGameConfirm();
    } else {
        // Fallback: implement end game logic directly
        // Skip the confirm for test games (throwaway dev data).
        const skipEndConfirm = typeof isTestGame === 'function'
            && typeof currentGame === 'function' && isTestGame(currentGame());
        if (!skipEndConfirm && !confirm('Are you sure you want to end the game?')) {
            return;
        }
        
        // Stop any running timers
        if (typeof stopCountdown === 'function') {
            stopCountdown();
        }
        
        // Set game end timestamp
        if (typeof currentGame === 'function' && currentGame()) {
            currentGame().gameEndTimestamp = new Date();
        }
        
        // Exit game screen
        exitGameScreen();
        
        // Show game summary screen
        if (typeof showGameSummaryPostGame === 'function') {
            showGameSummaryPostGame();
        }

        // Save data
        if (typeof saveAllTeamsData === 'function') {
            saveAllTeamsData();
        }
    }
}

/**
 * Update Play-by-Play panel state based on role and point status
 * - Score buttons (We Score, They Score): enabled only DURING a point
 * - Key Play: enabled only DURING a point
 * - Undo, Events, More: enabled anytime (if Active Coach)
 * - Start Point button: shown between points for Active Coach
 */
function updatePlayByPlayPanelState() {
    const panel = document.getElementById('panel-playByPlay');
    if (!panel) return;
    
    const hasActiveCoachRole = canEditPlayByPlayPanel();
    const pointInProgress = typeof isPointInProgress === 'function' && isPointInProgress();
    
    // Disable panel visually if not Active Coach (but don't block pointer events on whole panel)
    panel.classList.toggle('role-disabled', !hasActiveCoachRole);
    
    // Show Start Point button when: between points and user is Active Coach
    // (Always shown when between points, regardless of Select Line panel state)
    const showStartPoint = !pointInProgress && hasActiveCoachRole;
    const pbpStartPointBtn = document.getElementById('pbpStartPointBtn');
    const mainButtons = panel.querySelector('.pbp-main-buttons');
    
    if (pbpStartPointBtn) {
        pbpStartPointBtn.style.display = showStartPoint ? 'flex' : 'none';
        if (showStartPoint) {
            // Use shared function to apply button state
            applyStartPointButtonState(pbpStartPointBtn, false);
        }
    }
    
    // Hide main score buttons when Start Point is shown
    if (mainButtons) {
        mainButtons.style.display = showStartPoint ? 'none' : 'flex';
    }
    
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

    // Keep the Line-tab Start Point button (a parallel control on the Line
    // tab — same shared state machine, different home) in sync.
    updateLineTabStartPointBtn();

    // Re-render Full PBP so its role-disabled fade and start-point button
    // reflect the current role. updatePlayByPlayPanelState is the
    // canonical "role/state changed" entry point — see controllerState.js
    // calling it on role transitions.
    if (window.fullPbp && typeof window.fullPbp.render === 'function') {
        window.fullPbp.render();
    }

    // Update Game Events modal buttons if it's open
    updateGameEventsModalState();
}

/**
 * Update the Line tab's Start Point button.
 *
 * The button mirrors the PBP panel's Start Point button (label, feedback
 * color, "Point in progress" disabled state) but lives at the top of the
 * Select Line panel and is only visible when the Line tab itself is the
 * active tab. In the All view we hide it because the PBP panel's own
 * button is already on screen — showing both would be redundant.
 */
function updateLineTabStartPointBtn() {
    const btn = document.getElementById('lineTabStartPointBtn');
    if (!btn) return;

    const onLineTab = (typeof getActiveTab === 'function') && getActiveTab() === 'line';

    // Undo + Events siblings share the same visibility lifecycle: Line tab
    // only. Left clickable regardless of role — their handlers surface the
    // role toast, matching the Start Point convention below.
    const undoBtn = document.getElementById('lineTabUndoBtn');
    if (undoBtn) {
        undoBtn.style.display = onLineTab ? 'inline-flex' : 'none';
    }
    const eventsBtn = document.getElementById('lineTabGameEventsBtn');
    if (eventsBtn) {
        eventsBtn.style.display = onLineTab ? 'inline-flex' : 'none';
    }

    // Always show on the Line tab. applyStartPointButtonState handles the
    // not-Active-Coach case with grey/inactive styling and leaves the
    // button clickable so handlePanelStartPoint can surface the
    // "only the Active Coach can start a point" toast.
    if (!onLineTab) {
        btn.style.display = 'none';
        return;
    }

    btn.style.display = 'flex';
    applyStartPointButtonState(btn, true);

    // Keep the Lineup Ready sibling in sync with the same lifecycle.
    updateLineTabLineupReadyBtn();
}

/**
 * "Lineup Ready" — multi-coach coordination signal, fire-and-forget.
 *
 * The Line Coach taps to ping the Active Coach that the next lineup is
 * set. The AC's 3-second polling refresh sees `lineupReadyAt` advance and
 * shows a toast ("X says lineup ready") — that's the whole thing. No
 * persistent "sent" badge, no per-mode disambiguation, no Intent Rule
 * branch. The LC's actual view (`lineCoachViewing`) drives auto-select at
 * point-end via Priority 1 in `getEffectiveLineForNextPoint`.
 *
 * Visibility: only the pure Line Coach sees the button. Solo coaches,
 * pure Active Coach, spectators, and viewers see nothing.
 */
function computeLineupReadyState() {
    const ctrlState = (typeof getControllerState === 'function') ? getControllerState() : {};

    // Visible only to a pure Line Coach. (A user who holds BOTH roles
    // has no one else to ping, and the AC / spectators / viewers don't
    // send pings.)
    if (!ctrlState.isLineCoach || ctrlState.isActiveCoach) {
        return { state: 'hidden' };
    }
    if (!ctrlState.activeCoach) {
        return {
            state: 'disabled', label: 'Lineup Ready',
            disabledReason: 'No Active Coach connected — nobody to ping'
        };
    }
    return { state: 'active', label: 'Lineup Ready' };
}

function updateLineTabLineupReadyBtn() {
    const btn = document.getElementById('lineTabLineupReadyBtn');
    if (!btn) return;

    const onLineTab = (typeof getActiveTab === 'function') && getActiveTab() === 'line';
    const { state, label } = computeLineupReadyState();

    if (!onLineTab || state === 'hidden') {
        btn.style.display = 'none';
        return;
    }

    btn.style.display = 'flex';
    btn.classList.remove('sent', 'inactive');
    btn.disabled = false;
    btn.textContent = label;

    if (state === 'disabled') {
        // Visually disabled but kept clickable so a tap surfaces the
        // reason via toast (handleLineupReadyTap re-checks state).
        btn.classList.add('inactive');
    }
    // state === 'active' → leave default blue style from CSS.
}

/**
 * "Lineup Ready" tap handler. Fire-and-forget: write a timestamp + name,
 * show a toast. The AC's polling picks up the new timestamp and shows
 * its own toast on the receiving side.
 */
function handleLineupReadyTap() {
    const { state, disabledReason } = computeLineupReadyState();
    if (state !== 'active') {
        if (state === 'disabled' && typeof showControllerToast === 'function' && disabledReason) {
            showControllerToast(disabledReason, 'info', 2500);
        }
        return;
    }

    const ctrlState = (typeof getControllerState === 'function') ? getControllerState() : {};
    const game = (typeof currentGame === 'function') ? currentGame() : null;
    if (!game) return;
    if (!game.pendingNextLine) game.pendingNextLine = {};

    const myName = (ctrlState.lineCoach && ctrlState.lineCoach.displayName) || 'Line Coach';
    game.pendingNextLine.lineupReadyAt = Date.now();
    game.pendingNextLine.lineupReadyBy = myName;

    if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    if (typeof showControllerToast === 'function') {
        showControllerToast('Lineup ready ping sent', 'success', 1800);
    }
}

// =============================================================================
// Shared Start Point Button Logic
// =============================================================================

/**
 * Calculate the feedback state for Start Point buttons
 * Used by both the Select Line panel and Play-by-Play panel Start Point buttons
 * @returns {object} { feedbackClass, startOnLabel, pointInProgress }
 */
function getStartPointButtonState() {
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput')?.value || '7', 10);
    const pointInProgress = typeof isPointInProgress === 'function' && isPointInProgress();
    const game = typeof currentGame === 'function' ? currentGame() : null;

    // Compute feedback against the line that will *actually* be played,
    // not what's currently visible in the panel. The Active Coach may be
    // browsing the OD line while the upcoming point uses the separate O
    // line — the button color should reflect the lineup that'll start.
    let effectivePlayers = [];
    let lineSource = 'od';
    if (game && typeof getEffectiveLineForNextPoint === 'function') {
        const effective = getEffectiveLineForNextPoint(game);
        effectivePlayers = effective.line || [];
        lineSource = effective.source;
    } else if (typeof getSelectedPlayersFromPanel === 'function') {
        effectivePlayers = getSelectedPlayersFromPanel();
    }

    let genderRatioWarning = false;
    let startingRatioRequired = false;

    if (game && game.alternateGenderRatio && game.alternateGenderRatio !== 'No') {
        if (game.alternateGenderRatio === 'Alternating' && !game.startingGenderRatio && game.points.length === 0) {
            startingRatioRequired = true;
        } else if (effectivePlayers.length === expectedCount) {
            genderRatioWarning = typeof checkPanelGenderRatio === 'function'
                ? !checkPanelGenderRatio(effectivePlayers, expectedCount)
                : false;
        }
    }

    // Determine feedback class
    let feedbackClass = '';
    if (effectivePlayers.length === 0) {
        feedbackClass = 'inactive';
    } else if (startingRatioRequired) {
        feedbackClass = 'inactive';
    } else if (effectivePlayers.length !== expectedCount) {
        feedbackClass = 'feedback-count-warning';  // Wrong player count (red)
    } else if (genderRatioWarning) {
        feedbackClass = 'feedback-gender-warning';  // Wrong gender ratio (orange)
    } else {
        feedbackClass = 'feedback-ok';  // All good (green)
    }

    // Determine starting position
    const startOn = typeof determineStartingPosition === 'function'
        ? determineStartingPosition()
        : 'offense';
    const startOnLabel = startOn.charAt(0).toUpperCase() + startOn.slice(1);

    return { feedbackClass, startOnLabel, pointInProgress, lineSource };
}

/**
 * Apply Start Point button state to a button element
 * Used by both Select Line and Play-by-Play panel Start Point buttons
 * @param {HTMLElement} btn - The button element
 * @param {boolean} showPointInProgress - Whether to show "Point in progress" when point is active
 */
function applyStartPointButtonState(btn, showPointInProgress = true) {
    if (!btn) return;

    const { feedbackClass, startOnLabel, pointInProgress, lineSource }
        = getStartPointButtonState();
    const hasActiveCoachRole = (typeof canEditPlayByPlayPanel === 'function')
        ? canEditPlayByPlayPanel() : true;

    // Reset all states
    btn.classList.remove('warning', 'inactive', 'point-in-progress',
        'feedback-ok', 'feedback-count-warning', 'feedback-gender-warning');
    btn.disabled = false;

    // Point in progress: grey-on-grey, hard-disabled. Any selection-color
    // hint (red/orange/green) here would be misleading — the button is
    // not actionable mid-point.
    if (pointInProgress && showPointInProgress) {
        btn.textContent = 'Point in progress';
        btn.classList.add('point-in-progress', 'inactive');
        btn.disabled = true;
        return;
    }

    // Label parenthetical:
    //   - O-line being used  → "Start Point (O-line)"  (offense implied)
    //   - D-line being used  → "Start Point (D-line)"  (defense implied)
    //   - Combined OD line   → "Start Point (Offense)" / "(Defense)"
    // The line type implies the side, so we don't double up.
    let label;
    if (lineSource === 'o')      label = 'Start Point (O-line)';
    else if (lineSource === 'd') label = 'Start Point (D-line)';
    else                         label = `Start Point (${startOnLabel})`;
    btn.textContent = label;

    // Apply the feedback class (green/orange/red) reflecting the current
    // line. Non-Active-Coach also gets the feedback class — they need to
    // see the same lineup warnings the Active Coach sees, just dimmed to
    // signal "you can't act on this." Combined `.inactive.feedback-*`
    // CSS rules render as desaturated red/orange/green rather than pure
    // grey-on-grey (which loses the warning information).
    if (feedbackClass) {
        btn.classList.add(feedbackClass);
    }

    // Not Active Coach: still clickable (handlePanelStartPoint surfaces
    // the role-warning toast), but visually marked as inactive. The
    // combined CSS rule keeps the feedback hue, dropping saturation +
    // dimming opacity.
    if (!hasActiveCoachRole) {
        btn.classList.add('inactive');
    }
}

/**
 * Update Game Events modal button states. Single source of truth — gates on
 * both the Active Coach role and point status:
 * - Timeout: enabled anytime (during or between points), Active Coach only
 * - Injury Sub: enabled only DURING a point (mid-point sub mechanism)
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

    // Injury Sub - only DURING a point (mid-point sub mechanism).
    // Class-only disabling (no disabled attribute): the tap must still reach
    // handleGameEventInjurySub so it can explain WHY with the same
    // "No point in progress" toast the dedicated Sub button shows, instead
    // of dying silently on a disabled attribute.
    const injurySubBtn = modal.querySelector('#geInjurySubBtn');
    if (injurySubBtn) {
        const injuryEnabled = hasActiveCoachRole && pointInProgress;
        injurySubBtn.disabled = false;
        injurySubBtn.classList.toggle('disabled', !injuryEnabled);
        injurySubBtn.setAttribute('aria-disabled', String(!injuryEnabled));
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

// --- ES-module exports ---
export {
    wireGameScreenEvents,
    canEditPlayByPlayPanel, ensureDialogVisible,
    transitionToBetweenPoints,
    updatePlayByPlayPanelState, updatePlayByPlayLayout,
    updateLineTabStartPointBtn, setupPlayByPlayResizeObserver,
    applyStartPointButtonState,
    handlePbpTheyScore, handlePbpGameEvents,
    handleLineupReadyTap, updateSubPlayersCount,
};
// window survivor: late-bound back-edge hook (called by game/gameLogic.js,
// game/pointManagement.js, screens/navigation.js, teams/rosterManagement.js,
// teams/teamList.js — all evaluate before this file)
window.transitionToBetweenPoints = transitionToBetweenPoints;
// window survivor: late-bound back-edge hook (called window-qualified by
// game/controllerState.js, which evaluates before this file)
window.updatePlayByPlayPanelState = updatePlayByPlayPanelState;
// window survivor: late-bound back-edge hook (called by ui/panelSystem.js,
// which evaluates before this file)
window.updatePlayByPlayLayout = updatePlayByPlayLayout;
// window survivor: late-bound back-edge hook (called by ui/panelSystem.js)
window.updateLineTabStartPointBtn = updateLineTabStartPointBtn;
// Dropped shims (zero external references found): showGameEventsModal,
// hideGameEventsModal, applySwitchSides, wireTabControlEvents.


