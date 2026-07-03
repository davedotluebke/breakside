/*
 * Screen navigation helpers
 * Handles transitions between major app screens.
 * In-game UI is handled by the panel system (gameScreen.js / panelSystem.js).
 */
import { currentTeam } from '../store/storage.js';
import { isPointInProgress } from '../utils/helpers.js';

const screens = [
    document.getElementById('selectTeamScreen'),
    document.getElementById('teamRosterScreen'),
    document.getElementById('teamSettingsScreen'),
    document.getElementById('eventRosterScreen'),
    document.getElementById('gameSummaryScreen')
];

// Non-game screens where controller polling should stop
const nonGameScreenIds = [
    'selectTeamScreen',
    'teamRosterScreen',
    'teamSettingsScreen',
    'eventRosterScreen',
    'gameSummaryScreen'
];

function showScreen(screenId) {
    screens.forEach(screen => {
        if (screen) {
            screen.style.display = 'none';
        }
    });
    const targetScreen = document.getElementById(screenId);
    if (!targetScreen) {
        console.warn(`showScreen: screen with id "${screenId}" not found.`);
        return;
    }
    targetScreen.style.display = 'block';

    // Default to Start Game subscreen when showing teamRosterScreen
    if (screenId === 'teamRosterScreen') {
        showStartGameSubscreen();
    }

    // Ensure header is visible (hideLegacyScreens sets display:none via inline style)
    const headerElement = document.querySelector('header');
    if (headerElement) {
        headerElement.style.display = '';
    }

    // Manage controller polling — stop on non-game screens
    manageControllerPolling(screenId);

    // Show/hide controller role buttons
    manageControllerButtons(screenId);

    // Start active-game polling on non-game screens
    // late-bound back-edge (teams/activeGamePolling lives "above" this layer);
    // see ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (nonGameScreenIds.includes(screenId) && typeof window.startActiveGamePolling === 'function') {
        window.startActiveGamePolling();
    }

    // Hook point for cross-module reactions to navigation (replaces the old
    // window.showScreen monkey-patch pattern, which can't survive ES modules).
    document.dispatchEvent(new CustomEvent('breakside:screen-shown', { detail: { screenId } }));
}

/**
 * Show/hide controller role buttons based on current screen.
 * Controller buttons are only visible on the panel-based game screen,
 * so hide them on all navigation-managed screens.
 */
function manageControllerButtons(screenId) {
    // late-bound back-edge (game/controllerState lives "above" this layer);
    // see ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.setControllerButtonsVisible !== 'function') {
        return;
    }
    // All screens managed by showScreen() are non-game screens
    window.setControllerButtonsVisible(false);
}

/**
 * Manage controller polling based on current screen.
 * Stops polling when entering a non-game screen.
 */
function manageControllerPolling(screenId) {
    // late-bound back-edge (game/controllerState lives "above" this layer);
    // see ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.startControllerPolling !== 'function' ||
        typeof window.stopControllerPolling !== 'function') {
        return;
    }

    if (nonGameScreenIds.includes(screenId)) {
        window.stopControllerPolling();
    }
}

// =============================================================================
// Roster Screen Subscreens
// =============================================================================

function showStartGameSubscreen() {
    document.getElementById('startGameSubscreen').style.display = '';
    document.getElementById('editRosterSubscreen').style.display = 'none';
    // Default to new-game mode; showStartGameScreen('gameScreen') re-applies
    // mid-game mode afterward when appropriate.
    // late-bound back-edge (game/gameLogic lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.configureStartGameMode === 'function') {
        window.configureStartGameMode(false);
    }
}

// Tracks how Edit Roster was entered so its Back button knows where to go:
//  - true  → reached as a cross-link from the Start Game subscreen
//            (#showRosterBtn); Back returns to Start Game.
//  - false → reached as a top-level destination from the team list or a live
//            game (showEditRosterScreen); Back exits via rosterFlowBack.
let _editRosterCameFromStartGame = false;

function showEditRosterSubscreen() {
    document.getElementById('startGameSubscreen').style.display = 'none';
    document.getElementById('editRosterSubscreen').style.display = '';
    // late-bound back-edge (teams/rosterManagement lives "above" this layer);
    // see ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.updateTeamRosterDisplay === 'function') window.updateTeamRosterDisplay();
}

// Back handler for the Edit Roster subscreen. Returns to Start Game when Edit
// Roster was opened from there (matching the #backToStartGameBtn name),
// otherwise exits the roster screen entirely.
function editRosterBack() {
    if (_editRosterCameFromStartGame) {
        _editRosterCameFromStartGame = false;
        showStartGameSubscreen();
    } else {
        rosterFlowBack();
    }
}

// =============================================================================
// Roster / Start-Game flow navigation
//
// The two subscreens of teamRosterScreen behave as independent destinations —
// "Start/Continue Game" and "Edit Roster" — each reachable from the team list
// and from within a live game. Each remembers where its Back button returns to.
// =============================================================================
let _rosterFlowReturn = 'selectTeamScreen';

function setRosterFlowReturn(target) {
    _rosterFlowReturn = target || 'selectTeamScreen';
}

// Re-enter the live game from a roster/start-game screen (mirrors the
// Continue Game button behavior).
function returnToGameFromRoster() {
    // late-bound back-edge (gameScreenSync/gameScreenEvents live "above" this
    // layer); see ARCHITECTURE.md § ES modules — the window shim at the owner
    // is kept deliberately.
    if (typeof window.enterGameScreen === 'function' && currentTeam &&
        currentTeam.games && currentTeam.games.length > 0) {
        window.enterGameScreen();
        if (typeof isPointInProgress === 'function' && isPointInProgress() === false &&
            typeof window.transitionToBetweenPoints === 'function') {
            window.transitionToBetweenPoints();
        }
    }
}

// Back from either roster-flow subscreen — returns to the live game when we
// came from one, otherwise to the team list.
function rosterFlowBack() {
    if (_rosterFlowReturn === 'gameScreen') {
        returnToGameFromRoster();
    // late-bound back-edge (teams/teamList lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    } else if (typeof window.showSelectTeamScreen === 'function') {
        window.showSelectTeamScreen();
    } else {
        showScreen('selectTeamScreen');
    }
}

// Open the Edit Roster screen as a standalone destination.
function showEditRosterScreen(returnTarget) {
    setRosterFlowReturn(returnTarget);
    // Top-level entry: Back exits the roster screen, not to Start Game.
    _editRosterCameFromStartGame = false;
    // Recompute scoped stats on entry so newly-played points / added games show.
    // late-bound back-edge (teams/rosterManagement lives "above" this layer);
    // see ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.invalidateRosterStatsCache === 'function') window.invalidateRosterStatsCache();
    showScreen('teamRosterScreen');
    showEditRosterSubscreen();
}

// Open the Start/Continue Game screen. When returnTarget is 'gameScreen' the
// screen runs in mid-game "Game Settings" mode (edit settings for the next
// point) instead of new-game mode.
function showStartGameScreen(returnTarget) {
    setRosterFlowReturn(returnTarget);
    showScreen('teamRosterScreen');
    showStartGameSubscreen();
    // late-bound back-edge (game/gameLogic lives "above" this layer); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.configureStartGameMode === 'function') {
        window.configureStartGameMode(returnTarget === 'gameScreen');
    }
}

// Wire subscreen buttons once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const showRosterBtn = document.getElementById('showRosterBtn');
    if (showRosterBtn) {
        // Cross-link from Start Game → Edit Roster; Back should return here.
        showRosterBtn.addEventListener('click', () => {
            _editRosterCameFromStartGame = true;
            showEditRosterSubscreen();
        });
    }
    const backFromRosterBtn = document.getElementById('backToStartGameBtn');
    if (backFromRosterBtn) {
        backFromRosterBtn.addEventListener('click', editRosterBack);
    }
    const backFromStartGameBtn = document.getElementById('backFromStartGameBtn');
    if (backFromStartGameBtn) {
        backFromStartGameBtn.addEventListener('click', rosterFlowBack);
    }
});

// --- ES-module exports ---
export {
    showScreen, showEditRosterScreen, showEditRosterSubscreen,
    showStartGameScreen, returnToGameFromRoster,
};
