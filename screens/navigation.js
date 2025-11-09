/*
 * Screen navigation helpers
 * Handles transitions between major app screens
 */
const screens = [
    document.getElementById('selectTeamScreen'),
    document.getElementById('teamRosterScreen'),
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
        if (screenId === 'selectTeamScreen' || screenId === 'teamRosterScreen') {
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
}
