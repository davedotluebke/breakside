/**
 * Breakside Join Page
 * Handles invite redemption with Supabase authentication
 */

// =============================================================================
// Configuration
// =============================================================================

const SUPABASE_URL = 'https://mfuziqztsfqaqnnxjcrr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mdXppcXp0c2ZxYXFubnhqY3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU3NTkzMDYsImV4cCI6MjA4MTMzNTMwNn0.ofe60cGBIC82rCoynvngiNEnXIKOyhpF_utezC8KG0w';

// API base URL - use same origin in production, localhost in dev
const API_BASE = window.location.hostname === 'localhost' 
    ? 'http://localhost:8000'
    : window.location.origin;

// Initialize Supabase client
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =============================================================================
// State
// =============================================================================

let inviteCode = null;
let inviteInfo = null;
let currentUser = null;

// =============================================================================
// DOM Elements
// =============================================================================

const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const invitePreview = document.getElementById('invitePreview');
const successState = document.getElementById('successState');

const errorTitle = document.getElementById('errorTitle');
const errorMessage = document.getElementById('errorMessage');

const teamName = document.getElementById('teamName');
const roleBadge = document.getElementById('roleBadge');
const roleIcon = document.getElementById('roleIcon');
const roleText = document.getElementById('roleText');
const invitedBy = document.getElementById('invitedBy');
const inviterName = document.getElementById('inviterName');
const expiresInfo = document.getElementById('expiresInfo');
const expiresDate = document.getElementById('expiresDate');

const authSection = document.getElementById('authSection');
const joinSection = document.getElementById('joinSection');
const userEmailDisplay = document.getElementById('userEmailDisplay');
const joinTeamBtn = document.getElementById('joinTeamBtn');
const switchAccountBtn = document.getElementById('switchAccountBtn');

const signinForm = document.getElementById('signinForm');
const signupForm = document.getElementById('signupForm');
const authMessage = document.getElementById('authMessage');
const authTabs = document.querySelectorAll('.auth-tab');
const googleSignInBtn = document.getElementById('googleSignInBtn');

const successTeamName = document.getElementById('successTeamName');
const successRole = document.getElementById('successRole');

// =============================================================================
// Utility Functions
// =============================================================================

function showState(state) {
    loadingState.classList.add('hidden');
    errorState.classList.add('hidden');
    invitePreview.classList.add('hidden');
    successState.classList.add('hidden');
    
    state.classList.remove('hidden');
}

function showError(title, message) {
    errorTitle.textContent = title;
    errorMessage.textContent = message;
    showState(errorState);
}

function showAuthMessage(message, type = 'error') {
    authMessage.textContent = message;
    authMessage.className = `auth-message ${type}`;
    authMessage.classList.remove('hidden');
}

function clearAuthMessage() {
    authMessage.classList.add('hidden');
    authMessage.textContent = '';
}

function formatDate(isoString) {
    if (!isoString) return 'Never';
    try {
        const date = new Date(isoString);
        return date.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });
    } catch (e) {
        return 'Unknown';
    }
}

async function getAuthHeaders() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.access_token) {
        throw new Error('Not authenticated');
    }
    return {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
    };
}

// =============================================================================
// Invite Code Extraction
// =============================================================================

function getInviteCodeFromURL() {
    // URL format: /join/{code} or /landing/join.html?code={code}
    const path = window.location.pathname;
    
    // Check path-based format first: /join/{code}
    const joinMatch = path.match(/\/join\/([A-Za-z0-9]+)/);
    if (joinMatch) {
        return joinMatch[1].toUpperCase();
    }
    
    // Check query param format: ?code={code}
    const params = new URLSearchParams(window.location.search);
    const codeParam = params.get('code');
    if (codeParam) {
        return codeParam.toUpperCase();
    }
    
    return null;
}

// =============================================================================
// Invite Info Fetching
// =============================================================================

async function fetchInviteInfo(code) {
    try {
        const response = await fetch(`${API_BASE}/api/invites/${code}/info`);
        
        if (response.status === 404) {
            throw new Error('Invite not found');
        }
        
        if (response.status === 410) {
            const data = await response.json();
            throw new Error(data.detail || 'This invite is no longer valid');
        }
        
        if (!response.ok) {
            throw new Error('Failed to load invite');
        }
        
        return await response.json();
    } catch (error) {
        console.error('Fetch invite error:', error);
        throw error;
    }
}

// =============================================================================
// UI Updates
// =============================================================================

function displayInvitePreview(info) {
    teamName.textContent = info.teamName;
    
    // Set role badge
    if (info.role === 'coach') {
        roleIcon.textContent = '🎯';
        roleText.textContent = 'Coach';
        roleBadge.classList.add('role-coach');
    } else {
        roleIcon.textContent = '👁️';
        roleText.textContent = 'Viewer';
        roleBadge.classList.add('role-viewer');
    }
    
    inviterName.textContent = info.invitedBy || 'A coach';
    
    if (info.expiresAt) {
        expiresDate.textContent = formatDate(info.expiresAt);
        expiresInfo.classList.remove('hidden');
    } else {
        expiresInfo.classList.add('hidden');
    }
    
    showState(invitePreview);
}

function updateUIForUser(user) {
    currentUser = user;
    
    if (user) {
        // User is logged in - show join section
        authSection.classList.add('hidden');
        joinSection.classList.remove('hidden');
        userEmailDisplay.textContent = user.email;
    } else {
        // User is not logged in - show auth section
        authSection.classList.remove('hidden');
        joinSection.classList.add('hidden');
    }
}

// =============================================================================
// Auth Tab Switching
// =============================================================================

function switchAuthTab(tabName) {
    authTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    signinForm.classList.toggle('hidden', tabName !== 'signin');
    signupForm.classList.toggle('hidden', tabName !== 'signup');
    
    clearAuthMessage();
}

authTabs.forEach(tab => {
    tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
});

// =============================================================================
// Invite Redemption
// =============================================================================

async function redeemInvite() {
    if (!inviteCode || !currentUser) {
        showAuthMessage('Please sign in first');
        return;
    }
    
    joinTeamBtn.disabled = true;
    joinTeamBtn.textContent = 'Joining...';
    
    try {
        const headers = await getAuthHeaders();
        const response = await fetch(`${API_BASE}/api/invites/${inviteCode}/redeem`, {
            method: 'POST',
            headers
        });
        
        if (response.status === 409) {
            // Already a member
            showAuthMessage("You're already on this team!", 'success');
            setTimeout(() => {
                window.location.href = '/app/';
            }, 1500);
            return;
        }
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to join team');
        }
        
        const result = await response.json();
        
        // Show success state
        successTeamName.textContent = result.team?.name || inviteInfo?.teamName || 'the team';
        successRole.textContent = result.membership?.role || inviteInfo?.role || 'member';
        showState(successState);
        
    } catch (error) {
        console.error('Redeem error:', error);
        showAuthMessage(error.message || 'Failed to join team');
        joinTeamBtn.disabled = false;
        joinTeamBtn.textContent = 'Join Team';
    }
}

// =============================================================================
// Sign In Handler
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
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password,
        });
        
        if (error) throw error;
        
        showAuthMessage('Signed in! Joining team...', 'success');
        updateUIForUser(data.user);
        
        // Auto-redeem the invite
        setTimeout(() => redeemInvite(), 500);
        
    } catch (error) {
        console.error('Sign in error:', error);
        showAuthMessage(error.message || 'Failed to sign in');
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
});

// =============================================================================
// Sign Up Handler
// =============================================================================

signupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthMessage();
    
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const passwordConfirm = document.getElementById('signupPasswordConfirm').value;
    
    if (password !== passwordConfirm) {
        showAuthMessage('Passwords do not match');
        return;
    }
    
    const submitBtn = signupForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Creating account...';
    submitBtn.disabled = true;
    
    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                // Redirect back to this join page after email confirmation
                emailRedirectTo: window.location.href,
            }
        });
        
        if (error) throw error;
        
        if (data.user && !data.user.confirmed_at) {
            // Email confirmation required
            showAuthMessage('Check your email for a message from "Supabase Auth" and click the link, then return here to join the team.', 'success');
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
        } else {
            // Instant signup (no email confirmation)
            showAuthMessage('Account created! Joining team...', 'success');
            updateUIForUser(data.user);
            setTimeout(() => redeemInvite(), 500);
        }
        
    } catch (error) {
        console.error('Sign up error:', error);
        showAuthMessage(error.message || 'Failed to create account');
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
});

// =============================================================================
// Google Sign In
// =============================================================================

googleSignInBtn?.addEventListener('click', async () => {
    try {
        // Store invite code in localStorage so we can use it after redirect
        if (inviteCode) {
            localStorage.setItem('pendingInviteCode', inviteCode);
        }
        
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.href,
            }
        });
        
        if (error) throw error;
        
    } catch (error) {
        console.error('Google sign in error:', error);
        showAuthMessage(error.message || 'Failed to sign in with Google');
    }
});

// =============================================================================
// Join Button Handler
// =============================================================================

joinTeamBtn?.addEventListener('click', redeemInvite);

// =============================================================================
// Switch Account Handler
// =============================================================================

switchAccountBtn?.addEventListener('click', async () => {
    try {
        await supabaseClient.auth.signOut();
        updateUIForUser(null);
    } catch (error) {
        console.error('Sign out error:', error);
    }
});

// =============================================================================
// Initialization
// =============================================================================

async function initialize() {
    // Get invite code from URL
    inviteCode = getInviteCodeFromURL();
    
    // Check for pending invite from Google OAuth redirect
    const pendingCode = localStorage.getItem('pendingInviteCode');
    if (pendingCode && !inviteCode) {
        inviteCode = pendingCode;
    }
    localStorage.removeItem('pendingInviteCode');
    
    if (!inviteCode) {
        showError('No Invite Code', 'Please use the invite link shared with you.');
        return;
    }
    
    try {
        // Fetch invite info
        inviteInfo = await fetchInviteInfo(inviteCode);
        displayInvitePreview(inviteInfo);
        
        // Check if user is already logged in
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session?.user) {
            updateUIForUser(session.user);
            
            // If we just came from OAuth redirect, auto-redeem
            if (pendingCode) {
                setTimeout(() => redeemInvite(), 500);
            }
        }
        
        // Listen for auth changes
        supabaseClient.auth.onAuthStateChange((event, session) => {
            console.log('Auth state changed:', event);
            if (session?.user) {
                updateUIForUser(session.user);
            }
        });
        
    } catch (error) {
        console.error('Initialize error:', error);
        
        if (error.message.includes('not found')) {
            showError('Invite Not Found', 'This invite code doesn\'t exist. Please check the link and try again.');
        } else if (error.message.includes('expired') || error.message.includes('no longer valid')) {
            showError('Invite Expired', error.message);
        } else {
            showError('Error Loading Invite', 'Something went wrong. Please try again later.');
        }
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', initialize);

