/*
 * Screen navigation helpers
 * Handles transitions between major app screens.
 * In-game UI is handled by the panel system (gameScreen.js / panelSystem.js).
 */
const screens = [
    document.getElementById('selectTeamScreen'),
    document.getElementById('teamRosterScreen'),
    document.getElementById('teamSettingsScreen'),
    document.getElementById('gameSummaryScreen')
];

// Non-game screens where controller polling should stop
const nonGameScreenIds = [
    'selectTeamScreen',
    'teamRosterScreen',
    'teamSettingsScreen',
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

    // Header styling — full header on non-game screens
    const headerElement = document.querySelector('header');
    if (headerElement) {
        if (screenId === 'selectTeamScreen' || screenId === 'teamRosterScreen' || screenId === 'teamSettingsScreen') {
            headerElement.classList.remove('header-compact');
            headerElement.classList.add('header-full');
        } else {
            headerElement.classList.remove('header-full');
            headerElement.classList.add('header-compact');
        }
    }

    // Manage controller polling — stop on non-game screens
    manageControllerPolling(screenId);

    // Show/hide controller role buttons
    manageControllerButtons(screenId);
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
