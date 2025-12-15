/**
 * Authentication module for Breakside PWA
 * 
 * Handles Supabase authentication including:
 * - Session management
 * - Login/signup flows
 * - Token refresh
 * - Auth state changes
 */

// Supabase configuration
const SUPABASE_URL = 'https://mfuziqztsfqaqnnxjcrr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mdXppcXp0c2ZxYXFubnhqY3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU3NTkzMDYsImV4cCI6MjA4MTMzNTMwNn0.ofe60cGBIC82rCoynvngiNEnXIKOyhpF_utezC8KG0w';

// Initialize Supabase client
let supabase = null;
let currentUser = null;
let authStateListeners = [];

/**
 * Initialize the Supabase client
 * Must be called after the Supabase JS library is loaded
 */
function initializeAuth() {
    if (typeof window.supabase === 'undefined') {
        console.error('Supabase JS library not loaded');
        return false;
    }
    
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true
        }
    });
    
    // Listen for auth state changes
    supabase.auth.onAuthStateChange((event, session) => {
        console.log('Auth state changed:', event);
        
        if (session) {
            currentUser = session.user;
            // Sync user with our backend
            syncUserWithBackend(session);
        } else {
            currentUser = null;
        }
        
        // Notify all listeners
        authStateListeners.forEach(listener => listener(event, session));
    });
    
    return true;
}

/**
 * Add a listener for auth state changes
 * @param {Function} listener - Callback function(event, session)
 */
function onAuthStateChange(listener) {
    authStateListeners.push(listener);
}

/**
 * Remove an auth state change listener
 * @param {Function} listener - The listener to remove
 */
function removeAuthStateListener(listener) {
    authStateListeners = authStateListeners.filter(l => l !== listener);
}

/**
 * Check if user is currently logged in
 * @returns {Promise<boolean>}
 */
async function isLoggedIn() {
    if (!supabase) return false;
    
    const { data: { session } } = await supabase.auth.getSession();
    return session !== null;
}

/**
 * Get the current session
 * @returns {Promise<Object|null>}
 */
async function getSession() {
    if (!supabase) return null;
    
    const { data: { session } } = await supabase.auth.getSession();
    return session;
}

/**
 * Get the current user
 * @returns {Promise<Object|null>}
 */
async function getCurrentUser() {
    if (!supabase) return null;
    
    const { data: { user } } = await supabase.auth.getUser();
    return user;
}

/**
 * Get the current access token for API calls
 * @returns {Promise<string|null>}
 */
async function getAccessToken() {
    const session = await getSession();
    return session?.access_token || null;
}

/**
 * Sign up with email and password
 * @param {string} email 
 * @param {string} password 
 * @returns {Promise<{user: Object|null, error: Error|null}>}
 */
async function signUp(email, password) {
    if (!supabase) return { user: null, error: new Error('Auth not initialized') };
    
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
    });
    
    return { user: data?.user, error };
}

/**
 * Sign in with email and password
 * @param {string} email 
 * @param {string} password 
 * @returns {Promise<{user: Object|null, error: Error|null}>}
 */
async function signIn(email, password) {
    if (!supabase) return { user: null, error: new Error('Auth not initialized') };
    
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });
    
    return { user: data?.user, error };
}

/**
 * Sign in with Google OAuth
 * @returns {Promise<{error: Error|null}>}
 */
async function signInWithGoogle() {
    if (!supabase) return { error: new Error('Auth not initialized') };
    
    const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: window.location.origin
        }
    });
    
    return { error };
}

/**
 * Send password reset email
 * @param {string} email 
 * @returns {Promise<{error: Error|null}>}
 */
async function resetPassword(email) {
    if (!supabase) return { error: new Error('Auth not initialized') };
    
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}?reset=true`,
    });
    
    return { error };
}

/**
 * Sign out
 * @returns {Promise<{error: Error|null}>}
 */
async function signOut() {
    if (!supabase) return { error: new Error('Auth not initialized') };
    
    const { error } = await supabase.auth.signOut();
    currentUser = null;
    
    return { error };
}

/**
 * Sync the current user with our backend
 * This creates/updates the user record in our system
 * @param {Object} session - Supabase session object
 */
async function syncUserWithBackend(session) {
    if (!session?.access_token) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${session.access_token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const userData = await response.json();
            console.log('User synced with backend:', userData);
            return userData;
        } else {
            console.warn('Failed to sync user with backend:', response.status);
        }
    } catch (error) {
        console.error('Error syncing user with backend:', error);
    }
}

/**
 * Make an authenticated API request
 * Automatically adds the Authorization header with the current token
 * @param {string} url - API endpoint
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>}
 */
async function authenticatedFetch(url, options = {}) {
    const token = await getAccessToken();
    
    const headers = {
        ...options.headers,
        'Content-Type': 'application/json',
    };
    
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    
    return fetch(url, {
        ...options,
        headers
    });
}

// Export functions for use in other modules
window.breakside = window.breakside || {};
window.breakside.auth = {
    initializeAuth,
    onAuthStateChange,
    removeAuthStateListener,
    isLoggedIn,
    getSession,
    getCurrentUser,
    getAccessToken,
    signUp,
    signIn,
    signInWithGoogle,
    resetPassword,
    signOut,
    authenticatedFetch,
    get currentUser() { return currentUser; },
    get supabase() { return supabase; }
};

