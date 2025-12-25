/**
 * Login Screen UI for Breakside PWA
 * 
 * Handles the visual login/signup interface and user interactions
 */

// Track current mode: 'login' | 'signup' | 'reset'
let authMode = 'login';
let isLoading = false;

/**
 * Initialize the login screen
 */
function initializeLoginScreen() {
    // Set up event listeners
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    const resetForm = document.getElementById('resetPasswordForm');
    
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }
    
    if (signupForm) {
        signupForm.addEventListener('submit', handleSignup);
    }
    
    if (resetForm) {
        resetForm.addEventListener('submit', handlePasswordReset);
    }
    
    // Mode toggle buttons
    document.getElementById('showSignupBtn')?.addEventListener('click', () => switchAuthMode('signup'));
    document.getElementById('showLoginBtn')?.addEventListener('click', () => switchAuthMode('login'));
    document.getElementById('showResetBtn')?.addEventListener('click', () => switchAuthMode('reset'));
    document.getElementById('backToLoginBtn')?.addEventListener('click', () => switchAuthMode('login'));
    
    // Google sign-in button
    document.getElementById('googleSignInBtn')?.addEventListener('click', handleGoogleSignIn);
    
    // Skip/continue without account (for development/demo)
    document.getElementById('continueWithoutAccountBtn')?.addEventListener('click', handleContinueWithoutAccount);
}

/**
 * Switch between login, signup, and reset modes
 * @param {string} mode - 'login' | 'signup' | 'reset'
 */
function switchAuthMode(mode) {
    authMode = mode;
    
    const loginSection = document.getElementById('loginSection');
    const signupSection = document.getElementById('signupSection');
    const resetSection = document.getElementById('resetPasswordSection');
    
    // Hide all sections
    if (loginSection) loginSection.style.display = 'none';
    if (signupSection) signupSection.style.display = 'none';
    if (resetSection) resetSection.style.display = 'none';
    
    // Show the appropriate section
    switch (mode) {
        case 'login':
            if (loginSection) loginSection.style.display = 'block';
            break;
        case 'signup':
            if (signupSection) signupSection.style.display = 'block';
            break;
        case 'reset':
            if (resetSection) resetSection.style.display = 'block';
            break;
    }
    
    clearAuthError();
}

/**
 * Show an error message
 * @param {string} message 
 */
function showAuthError(message) {
    const errorDiv = document.getElementById('authError');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }
}

/**
 * Clear the error message
 */
function clearAuthError() {
    const errorDiv = document.getElementById('authError');
    if (errorDiv) {
        errorDiv.textContent = '';
        errorDiv.style.display = 'none';
    }
}

/**
 * Show a success message
 * @param {string} message 
 */
function showAuthSuccess(message) {
    const successDiv = document.getElementById('authSuccess');
    if (successDiv) {
        successDiv.textContent = message;
        successDiv.style.display = 'block';
    }
}

/**
 * Clear the success message
 */
function clearAuthSuccess() {
    const successDiv = document.getElementById('authSuccess');
    if (successDiv) {
        successDiv.textContent = '';
        successDiv.style.display = 'none';
    }
}

/**
 * Set loading state on buttons
 * @param {boolean} loading 
 */
function setAuthLoading(loading) {
    isLoading = loading;
    
    const buttons = document.querySelectorAll('#authScreen button[type="submit"], #authScreen .auth-button');
    buttons.forEach(btn => {
        btn.disabled = loading;
        if (loading) {
            btn.dataset.originalText = btn.textContent;
            btn.textContent = 'Loading...';
        } else if (btn.dataset.originalText) {
            btn.textContent = btn.dataset.originalText;
        }
    });
}

/**
 * Handle login form submission
 * @param {Event} e 
 */
async function handleLogin(e) {
    e.preventDefault();
    if (isLoading) return;
    
    clearAuthError();
    clearAuthSuccess();
    setAuthLoading(true);
    
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    
    try {
        const { user, error } = await window.breakside.auth.signIn(email, password);
        
        if (error) {
            showAuthError(error.message || 'Failed to sign in');
        } else if (user) {
            // Auth state change listener will handle showing the app
            console.log('Login successful');
        }
    } catch (err) {
        showAuthError('An unexpected error occurred');
        console.error('Login error:', err);
    } finally {
        setAuthLoading(false);
    }
}

/**
 * Handle signup form submission
 * @param {Event} e 
 */
async function handleSignup(e) {
    e.preventDefault();
    if (isLoading) return;
    
    clearAuthError();
    clearAuthSuccess();
    
    const name = document.getElementById('signupName')?.value?.trim();
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const confirmPassword = document.getElementById('signupConfirmPassword').value;
    
    // Validate name is provided
    if (!name) {
        showAuthError('Please enter your name');
        return;
    }
    
    // Validate passwords match
    if (password !== confirmPassword) {
        showAuthError('Passwords do not match');
        return;
    }
    
    // Validate password strength
    if (password.length < 6) {
        showAuthError('Password must be at least 6 characters');
        return;
    }
    
    setAuthLoading(true);
    
    try {
        const { user, error } = await window.breakside.auth.signUp(email, password, name);
        
        if (error) {
            showAuthError(error.message || 'Failed to create account');
        } else if (user) {
            showAuthSuccess('Account created! Please check your email to verify your account.');
            // Clear the form
            document.getElementById('signupForm').reset();
        }
    } catch (err) {
        showAuthError('An unexpected error occurred');
        console.error('Signup error:', err);
    } finally {
        setAuthLoading(false);
    }
}

/**
 * Handle password reset form submission
 * @param {Event} e 
 */
async function handlePasswordReset(e) {
    e.preventDefault();
    if (isLoading) return;
    
    clearAuthError();
    clearAuthSuccess();
    setAuthLoading(true);
    
    const email = document.getElementById('resetEmail').value;
    
    try {
        const { error } = await window.breakside.auth.resetPassword(email);
        
        if (error) {
            showAuthError(error.message || 'Failed to send reset email');
        } else {
            showAuthSuccess('Password reset email sent! Check your inbox.');
        }
    } catch (err) {
        showAuthError('An unexpected error occurred');
        console.error('Password reset error:', err);
    } finally {
        setAuthLoading(false);
    }
}

/**
 * Handle Google sign-in
 */
async function handleGoogleSignIn() {
    if (isLoading) return;
    
    clearAuthError();
    setAuthLoading(true);
    
    try {
        const { error } = await window.breakside.auth.signInWithGoogle();
        
        if (error) {
            showAuthError(error.message || 'Failed to sign in with Google');
            setAuthLoading(false);
        }
        // If successful, the page will redirect to Google
    } catch (err) {
        showAuthError('An unexpected error occurred');
        console.error('Google sign-in error:', err);
        setAuthLoading(false);
    }
}

/**
 * Handle continue without account (demo/offline mode)
 */
function handleContinueWithoutAccount() {
    // Hide auth screen and show the app
    hideAuthScreen();
    showSelectTeamScreen(true);
}

/**
 * Show the auth screen
 */
function showAuthScreen() {
    const authScreen = document.getElementById('authScreen');
    if (authScreen) {
        authScreen.style.display = 'flex';
    }
    
    // Hide other top-level screens (but not nested sections like #selectCurrentPlayers, #gameEvents)
    const topLevelScreenIds = [
        'selectTeamScreen', 'teamRosterScreen', 'teamSettingsScreen',
        'beforePointScreen', 'offensePlayByPlayScreen', 'defensePlayByPlayScreen',
        'simpleModeScreen', 'gameSummaryScreen'
    ];
    topLevelScreenIds.forEach(id => {
        const screen = document.getElementById(id);
        if (screen) screen.style.display = 'none';
    });
    
    // Also hide the header and footer
    const header = document.querySelector('header');
    const bottomPanel = document.getElementById('bottomPanel');
    if (header) header.style.display = 'none';
    if (bottomPanel) bottomPanel.style.display = 'none';
    
    // Reset to login mode
    switchAuthMode('login');
}

/**
 * Hide the auth screen
 */
function hideAuthScreen() {
    const authScreen = document.getElementById('authScreen');
    if (authScreen) {
        authScreen.style.display = 'none';
    }
    
    // Show header
    const header = document.querySelector('header');
    if (header) header.style.display = '';
}

// Export for use in main.js
window.breakside = window.breakside || {};
window.breakside.loginScreen = {
    initializeLoginScreen,
    showAuthScreen,
    hideAuthScreen,
    switchAuthMode
};

