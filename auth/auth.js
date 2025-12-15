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
            config.SUPABASE_ANON_KEY
        );
        
        // Get existing session
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        
        if (error) {
            console.error('Error getting session:', error);
        } else if (session) {
            currentSession = session;
            currentUser = session.user;
            console.log('Auth: Restored session for', currentUser.email);
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
 * Sign out the current user.
 */
async function signOut() {
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
