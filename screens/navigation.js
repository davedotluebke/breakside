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
}

function showEditRosterSubscreen() {
    document.getElementById('startGameSubscreen').style.display = 'none';
    document.getElementById('editRosterSubscreen').style.display = '';
    if (typeof updateTeamRosterDisplay === 'function') updateTeamRosterDisplay();
}

// Wire subscreen buttons once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const showRosterBtn = document.getElementById('showRosterBtn');
    if (showRosterBtn) {
        showRosterBtn.addEventListener('click', showEditRosterSubscreen);
    }
    const backToStartBtn = document.getElementById('backToStartGameBtn');
    if (backToStartBtn) {
        backToStartBtn.addEventListener('click', showStartGameSubscreen);
    }
});
