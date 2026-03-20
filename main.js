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
 *   │   └── gameScreen.js       # Panel-based in-game UI
 *   │
 *   ├── playByPlay/              # Play-by-play dialogs
 *   │   ├── scoreAttribution.js # Score attribution dialog (thrower/receiver)
 *   │   ├── keyPlayDialog.js    # Key play dialog for recording important events
 *   │   └── pullDialog.js       # Pull dialog for defensive points
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
            .then(reg => {
                console.log('Service Worker: Registered');
                
                // Store registration globally for manual update checks
                window.swRegistration = reg;
                
                // Check for updates immediately
                reg.update().catch(err => console.log('SW update check failed:', err));
                
                // Check for updates periodically (every 5 minutes while app is open)
                setInterval(() => {
                    reg.update().catch(err => console.log('SW update check failed:', err));
                }, 5 * 60 * 1000);
                
                // Listen for new service worker installing
                reg.addEventListener('updatefound', () => {
                    const newWorker = reg.installing;
                    console.log('Service Worker: Update found, installing...');
                    
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'activated') {
                            console.log('Service Worker: New version activated, reloading...');
                            // Reload to get the new version
                            window.location.reload();
                        }
                    });
                });
            })
            .catch(err => console.log(`Service Worker Error: ${err}`));
    });
}

/**
 * Check for app updates by fetching the latest version.json from server
 * @returns {Promise<{hasUpdate: boolean, currentBuild: string, latestBuild: string}>}
 */
async function checkForAppUpdate() {
    try {
        // Fetch with cache-busting to get the latest version
        const response = await fetch('./version.json?t=' + Date.now());
        if (!response.ok) {
            return { hasUpdate: false, error: 'Failed to fetch version' };
        }
        const serverVersion = await response.json();

        const currentBuild = window.APP_BUILD || 'unknown';
        const latestBuild = serverVersion.build || 'unknown';

        // Check build number change (production commits)
        const buildChanged = currentBuild !== latestBuild && latestBuild !== 'unknown';

        // Check deploy stamp change (staging deploys without a commit)
        const currentStamp = window.APP_DEPLOY_STAMP || null;
        const latestStamp = serverVersion.deployStamp || null;
        const stampChanged = latestStamp && currentStamp !== latestStamp;

        return {
            hasUpdate: buildChanged || stampChanged,
            currentBuild,
            latestBuild: stampChanged && !buildChanged ? `${latestBuild} (redeployed)` : latestBuild,
            version: serverVersion.version
        };
    } catch (error) {
        console.error('Error checking for updates:', error);
        return { hasUpdate: false, error: error.message };
    }
}

/**
 * Force an app update by triggering service worker update and reload
 */
async function forceAppUpdate() {
    if (!window.swRegistration) {
        alert('Service worker not available. Try refreshing the page.');
        return;
    }
    
    try {
        // Force the service worker to check for updates
        await window.swRegistration.update();
        
        // Clear all caches
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
        
        // Reload the page to get the new version
        window.location.reload(true);
    } catch (error) {
        console.error('Error forcing update:', error);
        alert('Update failed: ' + error.message);
    }
}

// Export for use in other modules
window.checkForAppUpdate = checkForAppUpdate;
window.forceAppUpdate = forceAppUpdate;

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

// =============================================================================
// App Hamburger Menu
// =============================================================================

let appVersionTimeout = null;

function openAppFeedback() {
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
}

function showAppVersionOverlay() {
    const versionOverlay = document.getElementById('versionOverlay');
    if (!versionOverlay) return;

    if (appVersionTimeout) clearTimeout(appVersionTimeout);

    let versionText = appVersion
        ? `v${appVersion.version} (${appVersion.build})`
        : 'v?.?.?';
    if (window.APP_DEPLOY_LABEL) {
        versionText += ` [${window.APP_DEPLOY_LABEL}]`;
    }
    versionOverlay.textContent = versionText;
    versionOverlay.style.display = 'flex';

    appVersionTimeout = setTimeout(() => {
        versionOverlay.style.display = 'none';
    }, 3000);
}

function closeAppMenu() {
    const dropdown = document.getElementById('appMenuDropdown');
    if (dropdown) dropdown.classList.remove('visible');
}

function updateAppMenuState() {
    const hasTeam = typeof currentTeam !== 'undefined' && currentTeam;
    const rosterBtn = document.getElementById('menuAppRoster');
    const settingsBtn = document.getElementById('menuAppTeamSettings');
    const switchBtn = document.getElementById('menuSwitchTeam');

    if (rosterBtn) rosterBtn.disabled = !hasTeam;
    if (settingsBtn) settingsBtn.disabled = !hasTeam;

    // Hide Switch Team when already on Select Team screen
    if (switchBtn) {
        const onSelectScreen = document.getElementById('selectTeamScreen')?.style.display !== 'none';
        switchBtn.style.display = onSelectScreen ? 'none' : '';
    }
}

function initializeAppMenu() {
    const menuBtn = document.getElementById('appMenuBtn');
    if (menuBtn) {
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dropdown = document.getElementById('appMenuDropdown');
            if (dropdown) {
                dropdown.classList.toggle('visible');
                if (dropdown.classList.contains('visible')) {
                    updateAppMenuState();
                }
            }
        });
    }

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('appMenuDropdown');
        const btn = document.getElementById('appMenuBtn');
        if (dropdown && dropdown.classList.contains('visible')) {
            if (!dropdown.contains(e.target) && e.target !== btn) {
                closeAppMenu();
            }
        }
    });

    // Menu item handlers
    document.getElementById('menuSwitchTeam')?.addEventListener('click', () => {
        closeAppMenu();
        if (typeof showSelectTeamScreen === 'function') showSelectTeamScreen();
    });

    document.getElementById('menuAppRoster')?.addEventListener('click', () => {
        closeAppMenu();
        showScreen('teamRosterScreen');
        if (typeof showEditRosterSubscreen === 'function') showEditRosterSubscreen();
    });

    document.getElementById('menuAppTeamSettings')?.addEventListener('click', () => {
        closeAppMenu();
        if (typeof showTeamSettingsScreen === 'function') showTeamSettingsScreen();
    });

    document.getElementById('menuAppFeedback')?.addEventListener('click', () => {
        closeAppMenu();
        openAppFeedback();
    });

    document.getElementById('menuAppAbout')?.addEventListener('click', () => {
        closeAppMenu();
        showAppVersionOverlay();
    });

    // Logo tap also shows version
    const headerLogo = document.getElementById('headerLogo');
    if (headerLogo) {
        headerLogo.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showAppVersionOverlay();
        });
    }
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
    
    // Load current app version and deploy stamp
    fetch('./version.json')
        .then(r => r.json())
        .then(v => {
            window.APP_VERSION = v.version || 'unknown';
            window.APP_BUILD = v.build || 'unknown';
            window.APP_DEPLOY_STAMP = v.deployStamp || null;
            window.APP_DEPLOY_LABEL = v.deployLabel || null;
            console.log(`App version: ${window.APP_VERSION} (Build ${window.APP_BUILD})${window.APP_DEPLOY_STAMP ? ' deploy:' + window.APP_DEPLOY_STAMP : ''}${window.APP_DEPLOY_LABEL ? ' [' + window.APP_DEPLOY_LABEL + ']' : ''}`);
        })
        .catch(err => console.log('Could not load version.json:', err));
    
    // Initialize app hamburger menu
    initializeAppMenu();

    // Game summary back button
    const backFromSummaryBtn = document.getElementById('backFromSummaryBtn');
    if (backFromSummaryBtn) {
        backFromSummaryBtn.addEventListener('click', () => {
            if (typeof updateTeamRosterDisplay === 'function') updateTeamRosterDisplay();
            showScreen('teamRosterScreen');
        });
    }
    
    // Initial display of countdown timer
    document.getElementById('countdownTimer').style.display = 'none';
    
    // Initialize play-by-play modules
    if (typeof initializeScoreAttributionDialog === 'function') {
        initializeScoreAttributionDialog();
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



