/********************************************************************
 * Breakside PWA - Main Application Entry Point                     *
 ********************************************************************
 *
 *   File Structure Map
 *
 *   ultistats/
 *   ├── data/                    # Data layer
 *   │   ├── models.js           # Data structure definitions (Player, Game, Team, Point, Possession, Event classes)
 *   │   └── storage.js          # Serialization/deserialization and local storage operations
 *   │
 *   ├── utils/                   # Utility functions
 *   │   ├── helpers.js          # Pure utility functions and current state accessors
 *   │   └── statistics.js       # Statistics calculation and game summary generation
 *   │
 *   ├── screens/                 # Screen management
 *   │   └── navigation.js       # Screen navigation and state management
 *   │
 *   ├── teams/                   # Team management
 *   │   ├── teamSelection.js    # Team selection screen and team CRUD operations
 *   │   └── rosterManagement.js # Roster display, player management, and line management
 *   │
 *   ├── game/                    # Game core logic
 *   │   ├── gameLogic.js        # Game initialization, scoring, and undo functionality
 *   │   ├── pointManagement.js  # Point creation, timing, and transitions
 *   │   └── beforePointScreen.js # Before Point screen with player selection and line management
 *   │
 *   ├── playByPlay/              # Play-by-play tracking screens
 *   │   ├── offenseScreen.js    # Offensive possession tracking and event creation
 *   │   ├── defenseScreen.js    # Defensive possession tracking and event creation
 *   │   ├── simpleModeScreen.js # Simple mode scoring and score attribution
 *   │   └── keyPlayDialog.js    # Key play dialog for recording important events
 *   │
 *   ├── ui/                      # UI update functions
 *   │   ├── activePlayersDisplay.js # Active players table rendering and management
 *   │   ├── eventLogDisplay.js   # Event log management and display
 *   │   └── buttonLayout.js      # UI consistency functions (button width matching)
 *   │
 *   ├── main.js                  # Application bootstrap (~200 lines)
 *   │                            # - Service worker registration
 *   │                            # - App initialization
 *   │                            # - Simple mode toggle coordination
 *   │                            # - Module coordination
 *   │
 *   ├── index.html              # Main HTML with module script tags
 *   ├── main.css                # Application styles
 *   ├── manifest.json           # PWA manifest
 *   └── service-worker.js       # Service worker for offline functionality
 *
 ************************************************************************/

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('./service-worker.js')
            .then(reg => console.log('Service Worker: Registered'))
            .catch(err => console.log(`Service Worker Error: ${err}`));
    });
}

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
    
    if (typeof initializePullDialog === 'function') {
        initializePullDialog();
    }
    
    // Match button widths
    matchButtonWidths();
    setTimeout(matchButtonWidths, 100);
});

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

