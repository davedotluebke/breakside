/**
 * Breakside Authentication Module
 * 
 * Manages user authentication state and provides auth tokens for API calls.
 * Uses Supabase for authentication.
 * 
 * Usage:
 *   // Check if user is logged in
 *   if (isAuthenticated()) { ... }
 *   
 *   // Get current user
 *   const user = getCurrentUser();
 *   
 *   // Get auth headers for API calls
 *   const headers = await getAuthHeaders();
 *   fetch(url, { headers });
 *   
 *   // Sign out
 *   await signOut();
 */
import { authFetch } from '../store/sync.js';
import { log } from '../utils/logger.js';

// =============================================================================
// State
// =============================================================================

let supabaseClient = null;
let currentSession = null;
let currentUser = null;
let authInitialized = false;
let authStateListeners = [];

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the Supabase client and check for existing session.
 * Call this on app startup.
 */
async function initializeAuth() {
    if (authInitialized) return;

    // Check if Supabase is available
    // supabase: classic CDN script global (index.html)
    if (typeof window.supabase === 'undefined') {
        console.warn('Supabase JS not loaded. Auth features disabled.');
        authInitialized = true;
        return;
    }
    
    // Get config
    const config = window.BREAKSIDE_AUTH;
    if (!config || !config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
        console.warn('Supabase config not found. Auth features disabled.');
        authInitialized = true;
        return;
    }
    
    try {
        // No-op lock function to disable Navigator Locks API
        // Prevents Chrome debugger pausing on internal promise rejections during page reload
        const noOpLock = async (name, acquireTimeout, fn) => {
            return await fn();
        };
        
        // Initialize client
        supabaseClient = window.supabase.createClient(
            config.SUPABASE_URL,
            config.SUPABASE_ANON_KEY,
            {
                auth: {
                    lock: noOpLock,
                }
            }
        );
        
        // Get existing session
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        
        if (error) {
            console.error('Error getting session:', error);
        } else if (session) {
            currentSession = session;
            currentUser = session.user;
            log('Auth: Restored session for', currentUser.email);

            // Sync user's teams from server on session restore. Run immediately
            // (no blocking await of initializeAuth, no magic 500ms delay) and
            // signal completion via a 'breakside:teams-synced' event so the UI
            // re-renders the team list deterministically when the data lands —
            // rather than rendering empty then repopulating on a timer.
            (async () => {
                if (typeof window.syncUserTeams === 'function') {
                    try {
                        const result = await window.syncUserTeams();
                        if (result.synced > 0) {
                            log(`Auth: Synced ${result.synced} teams from server`);
                        }
                    } catch (e) {
                        console.warn('Failed to sync user teams on session restore:', e);
                    }
                }

                window.dispatchEvent(new CustomEvent('breakside:teams-synced'));

                // Start auto-sync polling
                if (typeof window.startAutoSync === 'function') {
                    window.startAutoSync();
                }
            })();
        }
        
        // Listen for auth state changes
        supabaseClient.auth.onAuthStateChange((event, session) => {
            log('Auth state changed:', event);
            // Supabase fires transient events (INITIAL_SESSION, TOKEN_REFRESHED,
            // etc.) that can carry a null session; don't let those clobber a
            // valid in-memory session and flip isAuthenticated() to false
            // mid-use. Only clear on an explicit SIGNED_OUT.
            if (session) {
                currentSession = session;
                currentUser = session.user || null;
            } else if (event === 'SIGNED_OUT') {
                currentSession = null;
                currentUser = null;
            }
            // else: spurious null session — keep the existing one.

            // Notify listeners
            authStateListeners.forEach(listener => {
                try {
                    listener(event, currentUser);
                } catch (e) {
                    console.error('Auth listener error:', e);
                }
            });
        });
        
        authInitialized = true;
        log('Auth: Initialized');
        
    } catch (error) {
        console.error('Auth initialization failed:', error);
        authInitialized = true;
    }
}

// =============================================================================
// Auth State
// =============================================================================

/**
 * Check if a user is currently authenticated.
 * @returns {boolean}
 */
function isAuthenticated() {
    return currentUser !== null && currentSession !== null;
}

/**
 * Whether the app can safely act on the user's behalf despite not having a
 * confirmed authenticated session — i.e. distinguish "genuinely signed out"
 * from "we can't reach Supabase to know".
 *
 * Offline-first surfaces (e.g. create-team) should fall back to a local +
 * queue-for-sync path when this returns true, and only hard-block on
 * "please sign in" when it returns false.
 *
 * @returns {boolean} true if authenticated OR auth status is indeterminate
 *                    (device offline / Supabase client unavailable);
 *                    false only when genuinely signed out while online.
 */
function canActOffline() {
    // A confirmed session always qualifies.
    if (isAuthenticated()) return true;

    // No session — figure out whether that's authoritative. If the device is
    // offline, or the Supabase client never came up (JS not loaded, config
    // missing, or init failed), we can't actually know the auth state, so
    // treat it as "offline/degraded" rather than "signed out".
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (typeof window.supabase === 'undefined') return true;
    if (!supabaseClient) return true;

    // Online, Supabase available, and no session → genuinely signed out.
    return false;
}

/**
 * Enable test mode: inject a fake authenticated session without Supabase.
 * For automated testing only — never call this in production.
 * @param {string} userId - Test user ID (default: 'test-user')
 */
let _testModeUserId = null;

function enableTestMode(userId = 'test-user') {
    // Defense in depth: test mode is for local dev / agent debug servers only.
    // Refuse to inject a fake session anywhere but localhost so a ?testMode=true
    // URL can never become an auth bypass against staging/production.
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) {
        console.warn('[Test] enableTestMode ignored outside localhost');
        return;
    }
    _testModeUserId = userId;
    currentUser = { id: userId, email: `${userId}@breakside.test` };
    currentSession = { user: currentUser, access_token: 'test-mode-token' };
    authInitialized = true;
    log('[Test] Auth: test mode enabled, userId =', userId);
}

/**
 * Get the current user object.
 * @returns {object|null} User object or null if not authenticated
 */
function getCurrentUser() {
    return currentUser;
}

/**
 * Get the current session.
 * @returns {object|null} Session object or null
 */
function getCurrentSession() {
    return currentSession;
}

/**
 * Register a listener for auth state changes.
 * @param {function} listener - Called with (event, user) on state changes
 * @returns {function} Unsubscribe function
 */
function onAuthStateChange(listener) {
    authStateListeners.push(listener);
    return () => {
        authStateListeners = authStateListeners.filter(l => l !== listener);
    };
}

// =============================================================================
// Auth Headers
// =============================================================================

// Refresh the access token when it's expired or within this many seconds of
// expiring. getSession() returns the *cached* session and does NOT proactively
// refresh, so on a long sideline session the token can expire and API calls go
// out with a stale bearer → 401. We check expires_at ourselves and refresh.
const TOKEN_REFRESH_MARGIN_S = 60;

/**
 * Get a non-expired session, refreshing if the cached token is at/near expiry.
 * Single source of truth for token freshness so a future tweak lands in one
 * place. Updates the in-memory session/user on a successful refresh.
 * @returns {Promise<object|null>} A current session, or null if unavailable.
 */
async function getFreshSession() {
    if (!supabaseClient) return null;

    let session;
    try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (error || !data || !data.session) return null;
        session = data.session;
    } catch (error) {
        console.error('Error getting session:', error);
        return null;
    }

    const expiresAt = session.expires_at;  // epoch seconds
    const nowS = Math.floor(Date.now() / 1000);
    if (expiresAt && (expiresAt - nowS) <= TOKEN_REFRESH_MARGIN_S) {
        try {
            const { data, error } = await supabaseClient.auth.refreshSession();
            if (!error && data && data.session) {
                currentSession = data.session;
                currentUser = data.session.user || null;
                return data.session;
            }
            console.warn('Token refresh near expiry failed; using cached session');
        } catch (e) {
            console.warn('Token refresh threw; using cached session:', e);
        }
    }
    return session;
}

/**
 * Get authorization headers for API calls.
 * Returns headers with Bearer token if authenticated, empty object otherwise.
 *
 * @returns {Promise<object>} Headers object
 */
async function getAuthHeaders() {
    // In test mode, send X-Test-User-Id instead of a real JWT
    if (_testModeUserId) {
        return { 'X-Test-User-Id': _testModeUserId };
    }

    if (!isAuthenticated() || !supabaseClient) {
        return {};
    }

    const session = await getFreshSession();
    if (!session) {
        console.warn('Failed to get session for auth headers');
        return {};
    }

    return {
        'Authorization': `Bearer ${session.access_token}`,
    };
}

/**
 * Get the current access token.
 * @returns {Promise<string|null>} Access token or null
 */
async function getAccessToken() {
    if (!isAuthenticated() || !supabaseClient) {
        return null;
    }

    const session = await getFreshSession();
    return session?.access_token || null;
}

// =============================================================================
// Sign Out
// =============================================================================

/**
 * Clear all locally stored game/team data.
 * Called on sign out to prevent data leaking between accounts.
 */
function clearLocalData() {
    log('Clearing local data on sign out...');
    
    // Clear main teams/games data
    localStorage.removeItem('teamsData');
    
    // Clear sync-related data (also cleared by clearSyncData, but ensure it's done)
    localStorage.removeItem('ultistats_sync_queue');
    localStorage.removeItem('ultistats_local_players');
    localStorage.removeItem('ultistats_local_teams');
    localStorage.removeItem('ultistats_local_games');
    
    // Clear any in-memory state in the store module
    if (typeof window.clearAllTeamsData === 'function') {
        window.clearAllTeamsData();
    }
    
    // Clear sync module's in-memory caches
    if (typeof window.clearSyncData === 'function') {
        window.clearSyncData();
    }
    
    log('Local data cleared');
}

/**
 * Sign out the current user.
 */
async function signOut() {
    // Stop auto-sync polling
    if (typeof window.stopAutoSync === 'function') {
        window.stopAutoSync();
    }
    
    // Clear local data to prevent leaking between accounts
    clearLocalData();
    
    if (!supabaseClient) {
        currentSession = null;
        currentUser = null;
        return;
    }
    
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
        
        currentSession = null;
        currentUser = null;
        
    } catch (error) {
        console.error('Sign out error:', error);
        // Clear state anyway
        currentSession = null;
        currentUser = null;
    }
}

// =============================================================================
// Redirect to Login
// =============================================================================

/**
 * Redirect user to the landing page for login.
 * Use when auth is required but user is not authenticated.
 */
function redirectToLogin() {
    // Store current URL for redirect after login
    const returnUrl = window.location.href;
    sessionStorage.setItem('breakside_return_url', returnUrl);
    
    // Redirect to landing page
    window.location.href = '/landing/';
}

/**
 * Check for stored return URL and redirect if present.
 * Call this after successful login on the landing page.
 */
function handleLoginRedirect() {
    const returnUrl = sessionStorage.getItem('breakside_return_url');
    if (returnUrl) {
        sessionStorage.removeItem('breakside_return_url');
        window.location.href = returnUrl;
    }
}

// =============================================================================
// API Helpers
// =============================================================================

// authFetch: this file's local 401-retry variant was DELETED at C8 — it had been
// shadowed dead code since pre-migration (store/sync.js's classic-script authFetch
// overwrote the global, so every runtime call already got sync's version; see the
// C1 commit). Consolidating onto the 401-retry variant is a flagged follow-up.

/**
 * Sync current user to our backend.
 * Creates/updates user record on our server.
 * Call this after successful login.
 */
async function syncUserToBackend() {
    if (!isAuthenticated()) return null;
    
    try {
        const response = await authFetch(`${window.BREAKSIDE_AUTH?.API_BASE_URL || ''}/api/auth/me`);
        
        if (!response.ok) {
            console.error('Failed to sync user to backend:', response.status);
            return null;
        }
        
        return await response.json();
        
    } catch (error) {
        console.error('Error syncing user to backend:', error);
        return null;
    }
}

// =============================================================================
// Sign In/Up Functions (for loginScreen.js)
// =============================================================================

/**
 * Sign in with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{user: object|null, error: object|null}>}
 */
async function signIn(email, password) {
    if (!supabaseClient) {
        return { user: null, error: { message: 'Auth not initialized' } };
    }
    
    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password,
        });
        
        if (error) {
            return { user: null, error };
        }
        
        currentSession = data.session;
        currentUser = data.user;
        
        // Sync user to backend
        await syncUserToBackend();
        
        // Sync user's teams from server (pull down any teams they have access to)
        if (typeof window.syncUserTeams === 'function') {
            try {
                await window.syncUserTeams();
            } catch (e) {
                console.warn('Failed to sync user teams:', e);
            }
        }
        
        // Start auto-sync polling
        if (typeof window.startAutoSync === 'function') {
            window.startAutoSync();
        }
        
        return { user: data.user, error: null };
        
    } catch (error) {
        console.error('Sign in error:', error);
        return { user: null, error: { message: error.message || 'Sign in failed' } };
    }
}

/**
 * Sign up with email and password.
 * @param {string} email
 * @param {string} password
 * @param {string} [name] - Optional display name
 * @returns {Promise<{user: object|null, error: object|null}>}
 */
async function signUp(email, password, name) {
    if (!supabaseClient) {
        return { user: null, error: { message: 'Auth not initialized' } };
    }
    
    try {
        const options = {};
        
        // Include name in user metadata if provided
        if (name) {
            options.data = { full_name: name };
        }
        
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options,
        });
        
        if (error) {
            return { user: null, error };
        }
        
        return { user: data.user, error: null };
        
    } catch (error) {
        console.error('Sign up error:', error);
        return { user: null, error: { message: error.message || 'Sign up failed' } };
    }
}

/**
 * Send password reset email.
 * @param {string} email
 * @returns {Promise<{error: object|null}>}
 */
async function resetPassword(email) {
    if (!supabaseClient) {
        return { error: { message: 'Auth not initialized' } };
    }
    
    try {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/app/`,
        });
        
        return { error };
        
    } catch (error) {
        console.error('Reset password error:', error);
        return { error: { message: error.message || 'Password reset failed' } };
    }
}

/**
 * Sign in with Google OAuth.
 * @returns {Promise<{error: object|null}>}
 */
async function signInWithGoogle() {
    if (!supabaseClient) {
        return { error: { message: 'Auth not initialized' } };
    }
    
    try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: `${window.location.origin}/app/`,
            },
        });
        
        return { error };
        
    } catch (error) {
        console.error('Google sign in error:', error);
        return { error: { message: error.message || 'Google sign in failed' } };
    }
}

// =============================================================================
// Exports
// =============================================================================

// The auth namespace consumed by main.js, store/sync.js, game/controllerState.js,
// teams/syncStatusUI.js, and teams/teamSettings.js — all reach it via
// window.breakside.auth at call time; auth/loginScreen.js also merges its own
// namespace into window.breakside. Note: authFetch here is store/sync.js's
// version (imported above) — the runtime winner since pre-migration.
// window.BreaksideAuth (a legacy duplicate of this object) was dropped at C8:
// grep found zero references anywhere (code, tests, landing/, HTML).
const breaksideAuth = {
    // Initialization
    initializeAuth,

    // State queries
    isAuthenticated,
    isLoggedIn: isAuthenticated,  // alias for consistency
    canActOffline,
    getCurrentUser,
    getCurrentSession,
    getSession: getCurrentSession,  // alias

    // Event listeners
    onAuthStateChange,

    // Token management
    getAuthHeaders,
    getAccessToken,

    // Sign in/up/out
    signIn,
    signUp,
    signOut,
    resetPassword,
    signInWithGoogle,

    // Utilities
    redirectToLogin,
    handleLoginRedirect,
    authFetch,
    syncUserToBackend,

    // Test support
    enableTestMode,
};

// --- ES-module export ---
export { breaksideAuth };
// window survivor: auth namespace surface — window.breakside.auth is the
// documented API consumed window-qualified by main.js and app modules; the
// merge pattern (auth + loginScreen each contribute their namespace) is
// deliberate and kept.
window.breakside = window.breakside || {};
window.breakside.auth = breaksideAuth;
