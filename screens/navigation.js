/*
 * Screen navigation helpers
 * Handles transitions between major app screens
 */
const screens = [
    document.getElementById('selectTeamScreen'),
    document.getElementById('teamRosterScreen'),
    document.getElementById('teamSettingsScreen'),
    document.getElementById('beforePointScreen'),
    document.getElementById('offensePlayByPlayScreen'),
    document.getElementById('defensePlayByPlayScreen'),
    document.getElementById('simpleModeScreen'),
    document.getElementById('gameSummaryScreen')
];

const playByPlayScreenIds = [
    'offensePlayByPlayScreen',
    'defensePlayByPlayScreen',
    'simpleModeScreen'
];

// Phase 4: Screens where controller polling should be active
// These are screens where the game is actively being played/managed
const activeGameScreenIds = [
    'beforePointScreen',
    'offensePlayByPlayScreen',
    'defensePlayByPlayScreen',
    'simpleModeScreen'
];

// Phase 4: Screens where controller polling should stop
// (game is over or we're not in a game context)
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

    if (targetScreen.classList && targetScreen.classList.contains('in-game-content')) {
        const bottomPanel = document.getElementById('bottomPanel');
        if (bottomPanel) {
            bottomPanel.style.display = 'flex';
        }
        if (typeof matchButtonWidths === 'function') {
            matchButtonWidths();
            setTimeout(matchButtonWidths, 100);
        }
    } else {
        const bottomPanel = document.getElementById('bottomPanel');
        if (bottomPanel) {
            bottomPanel.style.display = 'none';
        }
    }

    const headerElement = document.querySelector('header');
    const simpleModeToggle = document.querySelector('.simple-mode-toggle');

    if (headerElement && simpleModeToggle) {
        if (screenId === 'selectTeamScreen' || screenId === 'teamRosterScreen' || screenId === 'teamSettingsScreen') {
            headerElement.classList.remove('header-compact');
            headerElement.classList.add('header-full');
            simpleModeToggle.classList.add('hidden');
        } else {
            headerElement.classList.remove('header-full');
            headerElement.classList.add('header-compact');
            simpleModeToggle.classList.remove('hidden');
        }
    }

    const simpleModeCheckbox = document.getElementById('simpleModeToggle');
    if (simpleModeCheckbox) {
        if (screenId === 'simpleModeScreen') {
            simpleModeCheckbox.checked = true;
        } else if (playByPlayScreenIds.includes(screenId) && screenId !== 'simpleModeScreen') {
            simpleModeCheckbox.checked = false;
        }
    }

    if (screenId === 'beforePointScreen') {
        if (typeof shouldClearSelectionsInLineDialog !== 'undefined') {
            shouldClearSelectionsInLineDialog = true;
        }
        if (typeof updateActivePlayersList === 'function') {
            updateActivePlayersList();
        }
        if (typeof checkPlayerCount === 'function') {
            checkPlayerCount();
        }
    }
    
    // Phase 4: Manage controller polling based on screen
    manageControllerPolling(screenId);
}

/**
 * Phase 4: Manage controller polling based on current screen
 * 
 * Starts polling when entering an active game screen (if not already running).
 * Stops polling when entering a non-game screen (game ended or left).
 * 
 * @param {string} screenId - The screen being shown
 */
function manageControllerPolling(screenId) {
    // Check if controller polling functions are available
    if (typeof startControllerPolling !== 'function' || 
        typeof stopControllerPolling !== 'function') {
        return;
    }
    
    if (activeGameScreenIds.includes(screenId)) {
        // Entering an active game screen - ensure polling is running
        try {
            const game = typeof currentGame === 'function' ? currentGame() : null;
            if (game && game.id) {
                // Check if polling is already running for this game
                const alreadyPolling = typeof isControllerPollingActive === 'function' && 
                                       isControllerPollingActive() &&
                                       typeof getPollingGameId === 'function' &&
                                       getPollingGameId() === game.id;
                if (alreadyPolling) {
                    // Already polling this game, no action needed
                    return;
                }
                startControllerPolling(game.id);
            }
        } catch (e) {
            // No current game, don't start polling
            console.log('No active game for controller polling');
        }
    } else if (nonGameScreenIds.includes(screenId)) {
        // Entering a non-game screen - stop polling
        stopControllerPolling();
    }
}
