// Breakside PWA - Main Application Entry Point
// Data layer is now in data/models.js and data/storage.js

// import AudioNarrationService from './audioNarration.js';

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('./service-worker.js')
            .then(reg => console.log('Service Worker: Registered'))
            .catch(err => console.log(`Service Worker Error: ${err}`));
    });
}

/*
 * Screens & other app-wide HTML elements
 * (see screens/navigation.js for screen management helpers)
 */

/*
 * Global variables
 * These are now initialized from data modules loaded before this file
 */
// Globals are now defined before this point by data/storage.js

/*
 * Saving and loading team data
 * NOTE: Serialization functions are now in data/storage.js
 */

/************************************************************************ 
 *
 *   TEAM SELECTION SCREEN
 * 
 ************************************************************************/
// Open up with the "Select Your Team" screen
showSelectTeamScreen(true);

// Feedback link handler - opens GitHub issues page
const feedbackLink = document.getElementById('feedbackLink');
if (feedbackLink) {
    feedbackLink.addEventListener('click', function(e) {
        e.preventDefault();

        const versionInfo = appVersion ? `${appVersion.version} (Build ${appVersion.build})` : 'Unknown';
        const userAgent = navigator.userAgent;

        const body = `Please describe your experience or issue below:

---

**Device/Browser:** ${userAgent}
**App Version:** ${versionInfo}
**Steps to reproduce:**`;

        const encodedBody = encodeURIComponent(body);
        const feedbackUrl = `https://github.com/davedotluebke/ultistats/issues/new?labels=beta_feedback&title=${encodeURIComponent('Beta Feedback:')}&body=${encodedBody}`;

        window.open(feedbackUrl, '_blank');
    });
}

/************************************************************************ 
 *
 *   BEFORE GAME SCREEN
 *   TEAM ROSTER TABLE 
 * 
 ************************************************************************/
// Roster management functions are now in teams/rosterManagement.js

/************************************************************************ 
 *
 *   BEFORE POINT SCREEN
 *   SELECT PLAYERS TABLE 
 * 
 ************************************************************************/

// Event log toggle is now handled in ui/eventLogDisplay.js


/******************************************************************************/
/**************************** Offense/Defense play-by-play ********************/
/******************************************************************************/
// Offense and Defense screen code is now in playByPlay/offenseScreen.js and playByPlay/defenseScreen.js


/******************************************************************************/
/**************************** Undo Event Button *******************************/
/******************************************************************************/
// Undo functionality is now in game/gameLogic.js

/******************************************************************************/
/********************************** App Initialization ************************/
/******************************************************************************/

// Initialize header state on page load
document.addEventListener('DOMContentLoaded', function() {
    // Set initial header state based on starting screen
    const headerElement = document.querySelector('header');
    const simpleModeToggle = document.querySelector('.simple-mode-toggle');
    
    // Start with full header and hidden toggle since we start on team select
    headerElement.classList.add('header-full');
    headerElement.classList.remove('header-compact');
    simpleModeToggle.classList.add('hidden');
    
    // Initialize Simple Mode toggle to checked state (since it's now the default)
    document.getElementById('simpleModeToggle').checked = window.isSimpleMode;
    
    // Initial display of countdown timer
    document.getElementById('countdownTimer').style.display = 'none';
    
    // Initialize play-by-play modules
    if (typeof initializeSimpleModeScreen === 'function') {
        initializeSimpleModeScreen();
    }
    if (typeof initializeKeyPlayDialog === 'function') {
        initializeKeyPlayDialog();
    }
    
    // Match button widths
    matchButtonWidths();
    setTimeout(matchButtonWidths, 100);
});


/******************************************************************************/
/**************************** Countdown Timer *********************************/
/******************************************************************************/
// Timer functions are now in game/pointManagement.js

// Simple Mode Toggle
window.isSimpleMode = window.isSimpleMode ?? true;

document.getElementById('simpleModeToggle').addEventListener('change', function() {
    window.isSimpleMode = this.checked;
    
    // If we're in next line selection mode, exit it first
    if (document.body.classList.contains('next-line-mode')) {
        exitNextLineSelectionMode();
    }
    
    // Find which screen is currently visible
    let currentScreenId = null;
    for (const screen of screens) {
        if (screen && screen.style.display !== 'none') {
            currentScreenId = screen.id;
            break;
        }
    }
    
    // Only process screen transitions if we're on a play-by-play screen
    if (playByPlayScreenIds.includes(currentScreenId)) {
        if (window.isSimpleMode) {
            // When switching to simple mode, keep existing possession data
            showScreen('simpleModeScreen');
            
            // Make sure point timer is running
            if (currentPoint && !currentPoint.startTimestamp) {
                currentPoint.startTimestamp = new Date();
            }
        } else {
            // When switching back to detailed mode, determine which screen to show
            if (!currentPoint) {
                console.warn("No current point when toggling from simple mode");
                return;
            }
            
            // Check if we have any possessions in this point
            if (currentPoint.possessions.length > 0) {
                // Check if the latest possession is offensive or defensive
                const latestPossession = currentPoint.possessions[currentPoint.possessions.length - 1];
                if (latestPossession.offensive) {
                    updateOffensivePossessionScreen();
                    showScreen('offensePlayByPlayScreen');
                } else {
                    updateDefensivePossessionScreen();
                    showScreen('defensePlayByPlayScreen');
                }
            } else {
                // No possessions yet, use the starting position of the point
                if (currentPoint.startingPosition === 'offense') {
                    // Create the first possession as offensive
                    currentPoint.addPossession(new Possession(true));
                    updateOffensivePossessionScreen();
                    showScreen('offensePlayByPlayScreen');
                } else {
                    // Create the first possession as defensive
                    currentPoint.addPossession(new Possession(false));
                    updateDefensivePossessionScreen();
                    showScreen('defensePlayByPlayScreen');
                }
            }
        }
    }
});

// updateGameSummaryRosterDisplay is now in teams/rosterManagement.js

