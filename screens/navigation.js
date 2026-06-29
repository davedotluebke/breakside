/*
 * Screen navigation helpers
 * Handles transitions between major app screens.
 * In-game UI is handled by the panel system (gameScreen.js / panelSystem.js).
 */
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
    if (nonGameScreenIds.includes(screenId) && typeof startActiveGamePolling === 'function') {
        startActiveGamePolling();
    }
}

/**
 * Show/hide controller role buttons based on current screen.
 * Controller buttons are only visible on the panel-based game screen,
 * so hide them on all navigation-managed screens.
 */
function manageControllerButtons(screenId) {
    if (typeof setControllerButtonsVisible !== 'function') {
        return;
    }
    // All screens managed by showScreen() are non-game screens
    setControllerButtonsVisible(false);
}

/**
 * Manage controller polling based on current screen.
 * Stops polling when entering a non-game screen.
 */
function manageControllerPolling(screenId) {
    if (typeof startControllerPolling !== 'function' ||
        typeof stopControllerPolling !== 'function') {
        return;
    }

    if (nonGameScreenIds.includes(screenId)) {
        stopControllerPolling();
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
    if (typeof configureStartGameMode === 'function') {
        configureStartGameMode(false);
    }
}

function showEditRosterSubscreen() {
    document.getElementById('startGameSubscreen').style.display = 'none';
    document.getElementById('editRosterSubscreen').style.display = '';
    if (typeof updateTeamRosterDisplay === 'function') updateTeamRosterDisplay();
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
    if (typeof enterGameScreen === 'function' && currentTeam &&
        currentTeam.games && currentTeam.games.length > 0) {
        enterGameScreen();
        if (typeof isPointInProgress === 'function' && isPointInProgress() === false &&
            typeof transitionToBetweenPoints === 'function') {
            transitionToBetweenPoints();
        }
    }
}

// Back from either roster-flow subscreen — returns to the live game when we
// came from one, otherwise to the team list.
function rosterFlowBack() {
    if (_rosterFlowReturn === 'gameScreen') {
        returnToGameFromRoster();
    } else if (typeof showSelectTeamScreen === 'function') {
        showSelectTeamScreen();
    } else {
        showScreen('selectTeamScreen');
    }
}

// Open the Edit Roster screen as a standalone destination.
function showEditRosterScreen(returnTarget) {
    setRosterFlowReturn(returnTarget);
    // Recompute scoped stats on entry so newly-played points / added games show.
    if (typeof invalidateRosterStatsCache === 'function') invalidateRosterStatsCache();
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
    if (typeof configureStartGameMode === 'function') {
        configureStartGameMode(returnTarget === 'gameScreen');
    }
}

// Wire subscreen buttons once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const showRosterBtn = document.getElementById('showRosterBtn');
    if (showRosterBtn) {
        // Cross-link from Start Game → Edit Roster, preserving the return target.
        showRosterBtn.addEventListener('click', showEditRosterSubscreen);
    }
    const backFromRosterBtn = document.getElementById('backToStartGameBtn');
    if (backFromRosterBtn) {
        backFromRosterBtn.addEventListener('click', rosterFlowBack);
    }
    const backFromStartGameBtn = document.getElementById('backFromStartGameBtn');
    if (backFromStartGameBtn) {
        backFromStartGameBtn.addEventListener('click', rosterFlowBack);
    }
});
