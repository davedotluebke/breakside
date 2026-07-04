/********************************************************************
 * Breakside PWA - Main Application Entry Point                     *
 ********************************************************************
 *
 *   File Structure Map
 *
 *   ultistats/
 *   ├── store/                   # Data layer
 *   │   ├── models.js           # Data structure definitions (Player, Game, Team, Point, Possession, Event classes)
 *   │   ├── storage.js          # Serialization/deserialization, local storage, shared app state
 *   │   └── sync.js             # Server sync + offline queue
 *   │
 *   ├── utils/                   # Utility functions
 *   │   ├── helpers.js          # Pure utility functions and current state accessors
 *   │   └── eventStats.js       # Player/team stats from game events (id-keyed)
 *   │
 *   ├── screens/                 # Screen management
 *   │   └── navigation.js       # Screen navigation and state management
 *   │
 *   ├── teams/                   # Team management
 *   │   ├── teamList.js         # Team/game/event list rendering, team CRUD, join/create dialogs
 *   │   ├── eventDialogs.js     # Event creation/settings dialogs, event-game start flow
 *   │   ├── syncStatusUI.js     # Sync status indicator, full-refresh, pending-sync dialog
 *   │   ├── activeGamePolling.js # Active-game polling and teams-screen auto-refresh
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

// The full app module graph, imported in the pre-ESM <script>-tag order so
// top-level side effects (state init, DOM wiring) keep their historical
// relative ordering. Add new files here at their layer's position — see
// ARCHITECTURE.md § Module Loading. Names imported here are the ones main.js
// itself calls; bare `import './x.js'` lines are order-keeping side-effect
// imports.
import { log } from './utils/logger.js';
import './auth/config.js';
import './auth/auth.js';
import './auth/loginScreen.js';
import './store/models.js';
import './store/pendingLineLogic.js';
import './utils/helpers.js';
import { currentTeam } from './store/storage.js';
import './store/sync.js';
import './settings/advancedSettings.js';
import './utils/eventStats.js';
import './utils/tableSort.js';
import './utils/statsHelp.js';
import './utils/xlsxExport.js';
import './ui/activePlayersDisplay.js';
import './ui/eventLogDisplay.js';
import { matchButtonWidths } from './ui/buttonLayout.js';
import { isGameScreenVisible } from './ui/panelSystem.js';
import { showScreen, showEditRosterScreen, showEditRosterSubscreen } from './screens/navigation.js';
import './teams/rosterRowHelpers.js';
import { updateTeamRosterDisplay } from './teams/rosterManagement.js';
import { showSelectTeamScreen } from './teams/teamList.js';
import './teams/eventDialogs.js';
import { showConnectionInfo } from './teams/syncStatusUI.js';
import './teams/activeGamePolling.js';
import { showTeamSettingsScreen } from './teams/teamSettings.js';
import './teams/eventRoster.js';
import { getGameSummaryBackTarget } from './teams/gameSummary.js';
import './game/genderRatioDropdown.js';
import './game/undoLogic.js';
import './game/pointManagement.js';
import { appVersion } from './game/gameLogic.js';
import './game/controllerState.js';
import './ui/hints.js';
import './game/gameScreenPanels.js';
import './game/gameScreenEvents.js';
import './game/gameTimer.js';
import './game/selectLine.js';
import './game/gameScreenSync.js';
import { initializeScoreAttributionDialog } from './playByPlay/scoreAttribution.js';
import { initializeKeyPlayDialog } from './playByPlay/keyPlayDialog.js';
import { initializePullDialog } from './playByPlay/pullDialog.js';
import './playByPlay/pbpPossession.js';
import './playByPlay/fullPbp.js';
import './playByPlay/fieldPbp.js';
// narration/eventBus.js converted with C7 (the playByPlay layer imports it);
// evaluating it here — earlier than its old tag position after the pbp files —
// is harmless: its top level only builds the namespace object.
import './narration/eventBus.js';
import './narration/realtimeSession.js';
import { narrationEngine } from './narration/narrationEngine.js';
import './narration/transcriptDisplay.js';
import './narration/micButton.js';

// Skip the service worker during local development (localhost / 127.0.0.1).
// Its offline precache otherwise serves stale JS/CSS across edits, so source
// changes appear to have no effect until a manual cache purge. On localhost we
// also proactively unregister any SW + clear its caches left over from a prior
// session. Production and staging register it normally for offline support.
const SW_DISABLED_HOSTS = ['localhost', '127.0.0.1'];
const swDisabledForDev = SW_DISABLED_HOSTS.includes(location.hostname);

if ('serviceWorker' in navigator && swDisabledForDev) {
    navigator.serviceWorker.getRegistrations()
        .then(regs => regs.forEach(r => r.unregister()))
        .catch(() => {});
    if (window.caches && caches.keys) {
        caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
    }
    log('Service Worker: disabled on localhost (dev)');
}

/**
 * Whether it's unsafe to auto-reload the page right now — i.e. a game is on
 * screen or narration is recording/connecting, where a reload would drop
 * unsaved in-memory state and the live narration socket. Used to gate the
 * service-worker update reload below.
 */
function isReloadUnsafe() {
    try {
        if (narrationEngine && typeof narrationEngine.getPhase === 'function'
            && narrationEngine.getPhase() !== 'idle') {
            return true;
        }
        if (typeof isGameScreenVisible === 'function' && isGameScreenVisible()) {
            return true;
        }
    } catch (_) {
        // Be conservative but never throw from inside a SW lifecycle callback.
    }
    return false;
}

if ('serviceWorker' in navigator && !swDisabledForDev) {
    // Whether this page is already controlled by a SW at load time. A
    // controllerchange while we started uncontrolled is the first-visit
    // activation (clients.claim() on initial install), NOT an update — reloading
    // for that would be a spurious refresh, so we ignore that case below.
    const hadControllerAtLoad = !!navigator.serviceWorker.controller;
    let reloadingForUpdate = false;

    // A new service worker has taken control (an update activated). controllerchange
    // is the correct signal for "new version is now live" — more reliable than the
    // installing worker's statechange. Reload so the page runs the new assets, but
    // never mid-game/mid-recording where the reload would lose data.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadingForUpdate) return;
        if (!hadControllerAtLoad) return;  // first-visit claim, not an update
        if (isReloadUnsafe()) {
            log('Service Worker: update ready, deferring reload (game/recording active)');
            // window survivor: main.js bootstrap global (read by teams/syncStatusUI.js)
            window.__breaksideUpdatePending = true;
            return;
        }
        reloadingForUpdate = true;
        log('Service Worker: new version activated, reloading');
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('./service-worker.js')
            .then(reg => {
                log('Service Worker: Registered');

                // Store registration globally for manual update checks
                // window survivor: main.js bootstrap global (read by teams/syncStatusUI.js)
                window.swRegistration = reg;

                // Check for updates immediately
                reg.update().catch(err => log('SW update check failed:', err));

                // Check for updates periodically (every 5 minutes while app is open)
                setInterval(() => {
                    reg.update().catch(err => log('SW update check failed:', err));
                }, 5 * 60 * 1000);

                // Log when a new worker is found; the actual reload is handled by
                // the controllerchange listener above (gated on isReloadUnsafe()).
                reg.addEventListener('updatefound', () => {
                    log('Service Worker: Update found, installing...');
                });
            })
            .catch(err => log(`Service Worker Error: ${err}`));
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
        
        // Reload the page to get the new version. (The legacy reload(true)
        // forced-reload argument is a no-op in modern browsers; the cache clear
        // above is what actually refreshes assets.)
        window.location.reload();
    } catch (error) {
        console.error('Error forcing update:', error);
        alert('Update failed: ' + error.message);
    }
}

// window survivor: main.js bootstrap globals — consumed by teams/syncStatusUI.js
// via window (main.js is the module entry; nothing may import from it).
window.checkForAppUpdate = checkForAppUpdate;
// window survivor: main.js bootstrap global (see above)
window.forceAppUpdate = forceAppUpdate;

/******************************************************************************/
/********************************** Auth Initialization ***********************/
/******************************************************************************/

// Test mode (?testMode=true) exists only for local dev / agent debug servers.
// It must be a NO-OP against production and staging, where it would otherwise
// be an auth bypass. Allow it only on localhost / 127.0.0.1.
function isTestModeAllowed() {
    return ['localhost', '127.0.0.1'].includes(location.hostname);
}

// Initialize authentication
async function initializeApp() {
    // Test mode: skip Supabase auth and inject a fake session.
    // Activated via ?testMode=true URL parameter (localhost only).
    // Optional ?testUserId=<id> sets the user identity (for multi-coach tests).
    if (isTestModeAllowed() && new URLSearchParams(window.location.search).get('testMode') === 'true') {
        const params = new URLSearchParams(window.location.search);
        const testUserId = params.get('testUserId') || 'test-user';
        log('[Test] Test mode: injecting fake auth session for', testUserId);
        if (window.breakside?.auth?.enableTestMode) {
            window.breakside.auth.enableTestMode(testUserId);
        }
        showSelectTeamScreen(true);
        return;
    }

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
                log('User is authenticated, showing app');
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
                    log('User not authenticated, redirecting to landing page');
                    window.location.href = '/landing/';
                    return;
                }
                // If returning from auth but not logged in, something went wrong
                // Show auth screen to let them try again
                log('Auth callback but not authenticated, showing login');
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
    log('Auth state change:', event);
    
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
    // Dev test mode (?testMode=true, localhost only): never nag about installing.
    if (isTestModeAllowed() && new URLSearchParams(window.location.search).get('testMode') === 'true') {
        return;
    }
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
    // window survivor: main.js bootstrap global (read locally at prompt time)
    window.deferredInstallPrompt = e;
});

// Initialize the app once the DOM is ready and the auth module has loaded.
//
// Classic <script> tags execute in source order before DOMContentLoaded, so by
// then window.breakside.auth is normally defined. A fixed 100ms timer used to
// race this: on a slow/cold load the auth module might not be ready yet and a
// logged-in user was silently dropped into offline mode. Instead we wait for an
// explicit readiness signal — the auth symbol — polling briefly as a fallback.
function startAppInitialization() {
    const authReady = () => !!(window.breakside && window.breakside.auth
        && typeof window.breakside.auth.initializeAuth === 'function');

    if (authReady()) {
        initializeApp();
        return;
    }

    const POLL_MS = 50;
    const MAX_WAIT_MS = 10000;
    let waited = 0;
    const timer = setInterval(() => {
        waited += POLL_MS;
        if (authReady() || waited >= MAX_WAIT_MS) {
            clearInterval(timer);
            // Run init even on timeout — initializeApp() handles a missing auth
            // module by falling back to offline mode.
            initializeApp();
        }
    }, POLL_MS);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAppInitialization);
} else {
    startAppInitialization();
}

// Re-render the team-selection screen when the initial team sync completes.
// auth.js dispatches this instead of relying on a fixed 500ms delay, so the
// list populates deterministically once server teams have been pulled.
window.addEventListener('breakside:teams-synced', () => {
    if (typeof showSelectTeamScreen === 'function' &&
        document.getElementById('selectTeamScreen')?.style.display !== 'none') {
        showSelectTeamScreen();
    }
});

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

    const onSelectScreen = document.getElementById('selectTeamScreen')?.style.display !== 'none';

    // Roster and Team Settings are team-scoped — they only make sense once
    // you're inside a particular team. Hide them entirely on the team-selection
    // screen (each team/event row has its own roster & settings controls there).
    if (rosterBtn) {
        rosterBtn.style.display = onSelectScreen ? 'none' : '';
        rosterBtn.disabled = !hasTeam;
    }
    if (settingsBtn) {
        settingsBtn.style.display = onSelectScreen ? 'none' : '';
        settingsBtn.disabled = !hasTeam;
    }

    // Hide Switch Team when already on Select Team screen
    if (switchBtn) {
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
        if (typeof showEditRosterScreen === 'function') {
            showEditRosterScreen('selectTeamScreen');
        } else {
            showScreen('teamRosterScreen');
            if (typeof showEditRosterSubscreen === 'function') showEditRosterSubscreen();
        }
    });

    document.getElementById('menuAppTeamSettings')?.addEventListener('click', () => {
        closeAppMenu();
        if (typeof showTeamSettingsScreen === 'function') showTeamSettingsScreen();
    });

    document.getElementById('menuAppAdvancedSettings')?.addEventListener('click', () => {
        closeAppMenu();
        if (window.advancedSettings && typeof window.advancedSettings.showAdvancedSettings === 'function') {
            window.advancedSettings.showAdvancedSettings();
        }
    });

    document.getElementById('menuAppFeedback')?.addEventListener('click', () => {
        closeAppMenu();
        openAppFeedback();
    });

    document.getElementById('menuAppAbout')?.addEventListener('click', () => {
        closeAppMenu();
        if (typeof showConnectionInfo === 'function') {
            showConnectionInfo();
        } else {
            showAppVersionOverlay();
        }
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
            // window survivor: main.js bootstrap globals (read by
            // teams/syncStatusUI.js and checkForAppUpdate via window)
            window.APP_VERSION = v.version || 'unknown';
            // window survivor: main.js bootstrap global (see above)
            window.APP_BUILD = v.build || 'unknown';
            // window survivor: main.js bootstrap global (see above)
            window.APP_DEPLOY_STAMP = v.deployStamp || null;
            // window survivor: main.js bootstrap global (see above)
            window.APP_DEPLOY_LABEL = v.deployLabel || null;
            log(`App version: ${window.APP_VERSION} (Build ${window.APP_BUILD})${window.APP_DEPLOY_STAMP ? ' deploy:' + window.APP_DEPLOY_STAMP : ''}${window.APP_DEPLOY_LABEL ? ' [' + window.APP_DEPLOY_LABEL + ']' : ''}`);
        })
        .catch(err => log('Could not load version.json:', err));
    
    // Initialize app hamburger menu
    initializeAppMenu();

    // PWA install modal "Continue in Browser" (was an inline onclick pre-ESM)
    document.getElementById('pwaContinueBrowserBtn')
        ?.addEventListener('click', () => closePwaInstallModal());

    // Game summary back button — navigate based on where we came from
    const backFromSummaryBtn = document.getElementById('backFromSummaryBtn');
    if (backFromSummaryBtn) {
        backFromSummaryBtn.addEventListener('click', () => {
            const target = typeof getGameSummaryBackTarget === 'function'
                ? getGameSummaryBackTarget() : 'teamRosterScreen';
            if (target === 'teamRosterScreen' && typeof updateTeamRosterDisplay === 'function') {
                updateTeamRosterDisplay();
            }
            showScreen(target);
        });
    }
    
    // Initial display of countdown timer (null-guard like the rest of this block;
    // a missing element must not abort the remaining DOMContentLoaded setup).
    const countdownTimerEl = document.getElementById('countdownTimer');
    if (countdownTimerEl) countdownTimerEl.style.display = 'none';
    
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



