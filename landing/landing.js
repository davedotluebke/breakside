/**
 * Breakside Landing Page
 * Handles authentication with Supabase
 */

// =============================================================================
// Supabase Configuration
// =============================================================================

const SUPABASE_URL = 'https://mfuziqztsfqaqnnxjcrr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mdXppcXp0c2ZxYXFubnhqY3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU3NTkzMDYsImV4cCI6MjA4MTMzNTMwNn0.ofe60cGBIC82rCoynvngiNEnXIKOyhpF_utezC8KG0w';

// Initialize Supabase client
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =============================================================================
// DOM Elements
// =============================================================================

const authModal = document.getElementById('authModal');
const loginBtn = document.getElementById('loginBtn');
const getStartedBtn = document.getElementById('getStartedBtn');
const closeAuthModal = document.getElementById('closeAuthModal');

// Auth forms
const signinForm = document.getElementById('signinForm');
const signupForm = document.getElementById('signupForm');
const resetForm = document.getElementById('resetForm');
const authMessage = document.getElementById('authMessage');

// Auth tabs
const authTabs = document.querySelectorAll('.auth-tab');

// Buttons
const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
const backToSigninBtn = document.getElementById('backToSigninBtn');
const googleSignInBtn = document.getElementById('googleSignInBtn');
const signOutBtn = document.getElementById('signOutBtn');

// Containers
const authContainer = document.getElementById('authContainer');
const loggedInContainer = document.getElementById('loggedInContainer');

// User info elements
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');
const userEmail = document.getElementById('userEmail');

// =============================================================================
// Modal Control
// =============================================================================

function openAuthModal() {
    authModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    authModal.classList.remove('active');
    document.body.style.overflow = '';
    clearAuthMessage();
}

// Event listeners for opening/closing modal
loginBtn?.addEventListener('click', openAuthModal);
getStartedBtn?.addEventListener('click', openAuthModal);
closeAuthModal?.addEventListener('click', closeModal);

// Close on backdrop click
authModal?.addEventListener('click', (e) => {
    if (e.target === authModal) {
        closeModal();
    }
});

// Close on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && authModal.classList.contains('active')) {
        closeModal();
    }
});

// =============================================================================
// Auth Tab Switching
// =============================================================================

function switchAuthTab(tabName) {
    // Update tabs
    authTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Show/hide forms
    signinForm.classList.toggle('hidden', tabName !== 'signin');
    signupForm.classList.toggle('hidden', tabName !== 'signup');
    resetForm.classList.add('hidden');
    
    clearAuthMessage();
}

authTabs.forEach(tab => {
    tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
});

// =============================================================================
// Password Reset Flow
// =============================================================================

forgotPasswordBtn?.addEventListener('click', () => {
    signinForm.classList.add('hidden');
    signupForm.classList.add('hidden');
    resetForm.classList.remove('hidden');
    clearAuthMessage();
});

backToSigninBtn?.addEventListener('click', () => {
    switchAuthTab('signin');
});

// =============================================================================
// Auth Message Display
// =============================================================================

function showAuthMessage(message, type = 'error') {
    authMessage.textContent = message;
    authMessage.className = `auth-message ${type}`;
    authMessage.classList.remove('hidden');
}

function clearAuthMessage() {
    authMessage.classList.add('hidden');
    authMessage.textContent = '';
}

// =============================================================================
// Sign In
// =============================================================================

signinForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthMessage();
    
    const email = document.getElementById('signinEmail').value;
    const password = document.getElementById('signinPassword').value;
    
    const submitBtn = signinForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Signing in...';
    submitBtn.disabled = true;
    
    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });
        
        if (error) throw error;
        
        showAuthMessage('Signed in successfully!', 'success');
        setTimeout(() => {
            updateUIForUser(data.user);
        }, 500);
        
    } catch (error) {
        console.error('Sign in error:', error);
        showAuthMessage(error.message || 'Failed to sign in');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
});

// =============================================================================
// Sign Up
// =============================================================================

signupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthMessage();
    
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const passwordConfirm = document.getElementById('signupPasswordConfirm').value;
    
    // Validate passwords match
    if (password !== passwordConfirm) {
        showAuthMessage('Passwords do not match');
        return;
    }
    
    const submitBtn = signupForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Creating account...';
    submitBtn.disabled = true;
    
    try {
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: window.location.origin + '/',
            }
        });
        
        if (error) throw error;
        
        if (data.user && !data.user.confirmed_at) {
            showAuthMessage('Check your email to confirm your account!', 'success');
        } else {
            showAuthMessage('Account created successfully!', 'success');
            setTimeout(() => {
                updateUIForUser(data.user);
            }, 500);
        }
        
    } catch (error) {
        console.error('Sign up error:', error);
        showAuthMessage(error.message || 'Failed to create account');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
});

// =============================================================================
// Password Reset
// =============================================================================

resetForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthMessage();
    
    const email = document.getElementById('resetEmail').value;
    
    const submitBtn = resetForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Sending...';
    submitBtn.disabled = true;
    
    try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/landing/?reset=true',
        });
        
        if (error) throw error;
        
        showAuthMessage('Password reset email sent! Check your inbox.', 'success');
        
    } catch (error) {
        console.error('Password reset error:', error);
        showAuthMessage(error.message || 'Failed to send reset email');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
});

// =============================================================================
// Google Sign In
// =============================================================================

googleSignInBtn?.addEventListener('click', async () => {
    try {
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin + '/',
            }
        });
        
        if (error) throw error;
        
    } catch (error) {
        console.error('Google sign in error:', error);
        showAuthMessage(error.message || 'Failed to sign in with Google');
    }
});

// =============================================================================
// Sign Out
// =============================================================================

signOutBtn?.addEventListener('click', async () => {
    try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        
        updateUIForUser(null);
        
    } catch (error) {
        console.error('Sign out error:', error);
        showAuthMessage(error.message || 'Failed to sign out');
    }
});

// =============================================================================
// UI Updates
// =============================================================================

function updateUIForUser(user) {
    if (user) {
        // User is logged in
        authContainer.classList.add('hidden');
        loggedInContainer.classList.remove('hidden');
        
        // Update user info
        const displayName = user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';
        userName.textContent = `Welcome, ${displayName}!`;
        userEmail.textContent = user.email;
        
        // Update avatar with first letter
        userAvatar.textContent = displayName.charAt(0).toUpperCase();
        
        // Update nav button
        if (loginBtn) {
            loginBtn.textContent = 'My Account';
        }
    } else {
        // User is logged out
        authContainer.classList.remove('hidden');
        loggedInContainer.classList.add('hidden');
        
        // Reset to sign in tab
        switchAuthTab('signin');
        
        // Reset forms
        signinForm?.reset();
        signupForm?.reset();
        resetForm?.reset();
        
        // Update nav button
        if (loginBtn) {
            loginBtn.textContent = 'Sign In';
        }
    }
}

// =============================================================================
// Session Initialization
// =============================================================================

async function initializeAuth() {
    try {
        // Get current session
        const { data: { session } } = await supabase.auth.getSession();
        
        if (session?.user) {
            updateUIForUser(session.user);
        }
        
        // Listen for auth changes
        supabase.auth.onAuthStateChange((event, session) => {
            console.log('Auth state changed:', event);
            updateUIForUser(session?.user || null);
            
            // Handle specific events
            if (event === 'SIGNED_IN') {
                // Redirect to the main app
                window.location.href = '/';
            } else if (event === 'SIGNED_OUT') {
                closeModal();
            } else if (event === 'PASSWORD_RECOVERY') {
                // User clicked password reset link
                openAuthModal();
                showAuthMessage('Enter your new password', 'success');
            }
        });
        
    } catch (error) {
        console.error('Auth initialization error:', error);
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', initializeAuth);

// =============================================================================
// Smooth Scroll for Anchor Links
// =============================================================================

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

