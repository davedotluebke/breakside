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
        // Initialize client
        supabaseClient = window.supabase.createClient(
            config.SUPABASE_URL,
            config.SUPABASE_ANON_KEY,
            {
                auth: {
                    // Disable Navigator Locks API to prevent Chrome debugger pausing
                    // on internal promise rejections during page reload
                    lock: 'no-op',
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
            console.log('Auth: Restored session for', currentUser.email);
            
            // Sync user's teams from server on session restore
            // Use setTimeout to avoid blocking initialization
            setTimeout(async () => {
                if (typeof window.syncUserTeams === 'function') {
                    try {
                        const result = await window.syncUserTeams();
                        if (result.synced > 0) {
                            console.log(`Auth: Synced ${result.synced} teams from server`);
                            // Refresh the team selection screen if it's visible
                            if (typeof showSelectTeamScreen === 'function' && 
                                document.getElementById('selectTeamScreen')?.style.display !== 'none') {
                                showSelectTeamScreen();
                            }
                        }
                    } catch (e) {
                        console.warn('Failed to sync user teams on session restore:', e);
                    }
                }
                
                // Start auto-sync polling
                if (typeof window.startAutoSync === 'function') {
                    window.startAutoSync();
                }
            }, 500);
        }
        
        // Listen for auth state changes
        supabaseClient.auth.onAuthStateChange((event, session) => {
            console.log('Auth state changed:', event);
            currentSession = session;
            currentUser = session?.user || null;
            
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
        console.log('Auth: Initialized');
        
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

/**
 * Get authorization headers for API calls.
 * Returns headers with Bearer token if authenticated, empty object otherwise.
 * 
 * @returns {Promise<object>} Headers object
 */
async function getAuthHeaders() {
    if (!isAuthenticated() || !supabaseClient) {
        return {};
    }
    
    try {
        // Get fresh session (handles token refresh automatically)
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        
        if (error || !session) {
            console.warn('Failed to get session for auth headers');
            return {};
        }
        
        return {
            'Authorization': `Bearer ${session.access_token}`,
        };
        
    } catch (error) {
        console.error('Error getting auth headers:', error);
        return {};
    }
}

/**
 * Get the current access token.
 * @returns {Promise<string|null>} Access token or null
 */
async function getAccessToken() {
    if (!isAuthenticated() || !supabaseClient) {
        return null;
    }
    
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        return session?.access_token || null;
    } catch (error) {
        console.error('Error getting access token:', error);
        return null;
    }
}

// =============================================================================
// Sign Out
// =============================================================================

/**
 * Clear all locally stored game/team data.
 * Called on sign out to prevent data leaking between accounts.
 */
function clearLocalData() {
    console.log('Clearing local data on sign out...');
    
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
    
    console.log('Local data cleared');
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

/**
 * Make an authenticated API request.
 * Automatically adds auth headers if user is authenticated.
 * 
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 */
async function authFetch(url, options = {}) {
    const authHeaders = await getAuthHeaders();
    
    const mergedOptions = {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
            ...options.headers,
        },
    };
    
    return fetch(url, mergedOptions);
}

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
// Exports (Global)
// =============================================================================

// Make functions available globally for vanilla JS
// Legacy export for compatibility
window.BreaksideAuth = {
    initializeAuth,
    isAuthenticated,
    getCurrentUser,
    getCurrentSession,
    onAuthStateChange,
    getAuthHeaders,
    getAccessToken,
    signOut,
    redirectToLogin,
    handleLoginRedirect,
    authFetch,
    syncUserToBackend,
};

// Primary export used by sync.js, main.js, and loginScreen.js
window.breakside = window.breakside || {};
window.breakside.auth = {
    // Initialization
    initializeAuth,
    
    // State queries
    isAuthenticated,
    isLoggedIn: isAuthenticated,  // alias for consistency
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
};

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
