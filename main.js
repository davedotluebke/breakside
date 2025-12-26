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

/******************************************************************************/
/********************************** Auth Initialization ***********************/
/******************************************************************************/

// Initialize authentication
async function initializeApp() {
    // Check if we're returning from Supabase auth (has hash params like #access_token)
    const hasAuthCallback = window.location.hash.includes('access_token') || 
                           window.location.hash.includes('refresh_token') ||
                           window.location.hash.includes('error_description');
    
    // Initialize auth module
    if (window.breakside?.auth?.initializeAuth) {
        try {
            // Wait for auth to initialize (async function)
            await window.breakside.auth.initializeAuth();
            
            // Listen for auth state changes
            window.breakside.auth.onAuthStateChange(handleAuthStateChange);
            
            // Check if user is already logged in
            const loggedIn = window.breakside.auth.isAuthenticated();
            
            if (loggedIn) {
                // User is logged in, show the app
                console.log('User is authenticated, showing app');
                hideAuthScreenAndShowApp();
                
                // Show PWA install prompt for newly authenticated users
                if (hasAuthCallback || sessionStorage.getItem('breakside_just_signed_in')) {
                    sessionStorage.removeItem('breakside_just_signed_in');
                    // Clean up the URL hash
                    if (hasAuthCallback) {
                        history.replaceState(null, '', window.location.pathname);
                    }
                    showPwaInstallPrompt();
                }
            } else {
                // User is not logged in
                // If not returning from auth callback, redirect to landing page
                if (!hasAuthCallback) {
                    console.log('User not authenticated, redirecting to landing page');
                    window.location.href = '/landing/';
                    return;
                }
                // If returning from auth but not logged in, something went wrong
                // Show auth screen to let them try again
                console.log('Auth callback but not authenticated, showing login');
                if (window.breakside?.loginScreen?.showAuthScreen) {
                    window.breakside.loginScreen.showAuthScreen();
                }
            }
        } catch (error) {
            // Auth failed to initialize, allow offline mode
            console.warn('Auth initialization failed, running in offline mode:', error);
            showSelectTeamScreen(true);
        }
    } else {
        // Auth module not loaded, allow offline mode
        console.warn('Auth module not loaded, running in offline mode');
        showSelectTeamScreen(true);
    }
}

/**
 * Handle auth state changes
 */
function handleAuthStateChange(event, session) {
    console.log('Auth state change:', event);
    
    switch (event) {
        case 'SIGNED_IN':
            hideAuthScreenAndShowApp();
            // Mark that user just signed in (for PWA prompt)
            sessionStorage.setItem('breakside_just_signed_in', 'true');
            break;
        case 'SIGNED_OUT':
            // Redirect to landing page on sign out
            window.location.href = '/landing/';
            break;
        case 'TOKEN_REFRESHED':
            // Token was refreshed, no action needed
            break;
    }
}

/**
 * Hide auth screen and show the main app
 */
function hideAuthScreenAndShowApp() {
    if (window.breakside?.loginScreen?.hideAuthScreen) {
        window.breakside.loginScreen.hideAuthScreen();
    }
    showSelectTeamScreen(true);
}

/**
 * Show PWA installation prompt
 * Different messaging for desktop vs mobile
 */
function showPwaInstallPrompt() {
    // Don't show if already dismissed or if running as installed PWA
    if (localStorage.getItem('breakside_pwa_prompt_dismissed')) {
        return;
    }
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
        return; // Already running as PWA
    }
    
    const modal = document.getElementById('pwaInstallModal');
    if (!modal) return;
    
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const messageEl = document.getElementById('pwaInstallMessage');
    const instructionsLink = document.getElementById('pwaInstructionsLink');
    const installBtn = document.getElementById('pwaInstallBtn');
    
    if (isMobile) {
        // Mobile: Direct install prompt
        if (isIOS) {
            messageEl.innerHTML = `
                <p>To install: tap <strong>Share</strong> <span style="font-size: 1.2em;">⬆️</span> then <strong>"Add to Home Screen"</strong>.</p>
                <p>Open from your home screen and sign in again.</p>
            `;
            installBtn.style.display = 'none';
            instructionsLink.style.display = 'none';
        } else {
            // Android - can use beforeinstallprompt if available
            messageEl.innerHTML = `
                <p>Add Breakside to your home screen for the best experience.</p>
                <p>After installing, open it and sign in again.</p>
            `;
            if (window.deferredInstallPrompt) {
                installBtn.style.display = 'inline-block';
                installBtn.onclick = async () => {
                    window.deferredInstallPrompt.prompt();
                    const { outcome } = await window.deferredInstallPrompt.userChoice;
                    if (outcome === 'accepted') {
                        closePwaInstallModal(true);
                    }
                };
            } else {
                installBtn.style.display = 'none';
                messageEl.innerHTML += `
                    <p style="font-size: 0.9em; color: #666;">Tap your browser's menu (⋮) and select "Add to Home Screen" or "Install App".</p>
                `;
            }
            instructionsLink.style.display = 'none';
        }
    } else {
        // Desktop: Point them to mobile
        messageEl.innerHTML = `
            <p>Install Breakside on your phone for the best sideline experience.</p>
            <p>Visit <strong>breakside.pro</strong> on your mobile device and sign in.</p>
        `;
        installBtn.style.display = 'none';
        instructionsLink.style.display = 'inline-block';
        instructionsLink.href = '/landing/#install';
    }
    
    modal.style.display = 'flex';
}

/**
 * Close PWA install modal
 */
function closePwaInstallModal(installed = false) {
    const modal = document.getElementById('pwaInstallModal');
    if (modal) {
        modal.style.display = 'none';
    }
    if (!installed) {
        // Remember they dismissed it (but allow showing again next session)
        localStorage.setItem('breakside_pwa_prompt_dismissed', 'true');
    }
}

// Capture the beforeinstallprompt event for Android
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.deferredInstallPrompt = e;
});

// Initialize the app when DOM is ready
// Note: We delay this slightly to ensure all modules are loaded
setTimeout(initializeApp, 100);

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

// Version display - tap logo to show version for 3 seconds
const logoContainer = document.getElementById('logoContainer');
const versionOverlay = document.getElementById('versionOverlay');
let versionTimeout = null;

if (logoContainer && versionOverlay) {
    logoContainer.addEventListener('click', function(e) {
        // Don't interfere with feedback link - only trigger on logo image tap
        if (e.target.id === 'headerLogo' || e.target.closest('#headerLogo')) {
            e.preventDefault();
            e.stopPropagation();
            
            // Clear any existing timeout
            if (versionTimeout) {
                clearTimeout(versionTimeout);
            }
            
            // Show version
            const versionText = appVersion 
                ? `v${appVersion.version} (${appVersion.build})`
                : 'v?.?.?';
            versionOverlay.textContent = versionText;
            versionOverlay.style.display = 'flex';
            
            // Hide after 3 seconds
            versionTimeout = setTimeout(() => {
                versionOverlay.style.display = 'none';
            }, 3000);
        }
    });
}

/******************************************************************************/
/********************************** App Initialization ************************/
/******************************************************************************/

// Initialize header state on page load
document.addEventListener('DOMContentLoaded', function() {
    // Initialize login screen
    if (window.breakside?.loginScreen?.initializeLoginScreen) {
        window.breakside.loginScreen.initializeLoginScreen();
    }
    
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

