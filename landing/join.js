/**
 * Breakside Join Page
 * Handles invite redemption with Supabase authentication
 */

// =============================================================================
// Configuration
// =============================================================================

// API base URL. This page is served from the static origins (www/staging,
// via CloudFront→S3) where there is NO /api/* behind the same origin — the
// API lives at api.breakside.pro. Mirror store/sync.js getApiBaseUrl():
// breakside domains → api.breakside.pro; localhost → :8000 (with a
// transient ?api= override for dev backends on other ports); anything else
// (e.g. the api host itself) → same origin.
const API_BASE = (() => {
    const apiParam = new URLSearchParams(window.location.search).get('api');
    if (apiParam && apiParam !== 'reset') return apiParam;

    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8000';
    if (host === 'breakside.pro' || host.endsWith('.breakside.pro') ||
        host === 'breakside.us' || host.endsWith('.breakside.us') ||
        host === 'luebke.us') {
        return 'https://api.breakside.pro';
    }
    return window.location.origin;
})();

// The Supabase client (`supabaseClient`) is created by supabaseInit.js,
// loaded before this script — shared with landing.js via the global scope.

// =============================================================================
// State
// =============================================================================

let inviteCode = null;
let inviteInfo = null;
let currentUser = null;
// Guards against duplicate/concurrent redemptions — both the SIGNED_IN handler
// and the in-page form/button paths can fire redeemInvite() around the same time.
let redeemInProgress = false;

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
        // Send auth when a session exists so the server can answer 409
        // (already a member) for the preview; anonymous works fine too.
        const headers = {};
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session?.access_token) {
                headers['Authorization'] = `Bearer ${session.access_token}`;
            }
        } catch (_) { /* treat as anonymous */ }

        const response = await fetch(`${API_BASE}/api/invites/${code}/info`, { headers });

        if (!response.ok) {
            // Tag the error with the HTTP status so callers classify on status,
            // not brittle message-text matching.
            let detail = null;
            try { detail = (await response.json()).detail; } catch (_) { /* no body */ }
            const err = new Error(detail || `Failed to load invite (${response.status})`);
            err.status = response.status;
            throw err;
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
    if (redeemInProgress) return;  // already redeeming (or redeemed)
    redeemInProgress = true;

    joinTeamBtn.disabled = true;
    joinTeamBtn.textContent = 'Joining...';

    try {
        const headers = await getAuthHeaders();
        const response = await fetch(`${API_BASE}/api/invites/${inviteCode}/redeem`, {
            method: 'POST',
            headers
        });

        if (response.status === 409) {
            // Already a member — terminal success; clear the pending code.
            localStorage.removeItem('pendingInviteCode');
            showAuthMessage("You're already on this team!", 'success');
            setTimeout(() => {
                window.location.href = '/app/';
            }, 1500);
            return;
        }

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'Failed to join team');
        }

        const result = await response.json();

        // Redemption succeeded — now it's safe to drop the pending invite code.
        localStorage.removeItem('pendingInviteCode');

        // Show success state
        successTeamName.textContent = result.team?.name || inviteInfo?.teamName || 'the team';
        successRole.textContent = result.membership?.role || inviteInfo?.role || 'member';
        showState(successState);

    } catch (error) {
        console.error('Redeem error:', error);
        showAuthMessage(error.message || 'Failed to join team');
        redeemInProgress = false;  // allow a retry
    } finally {
        // Always restore the button: on success it's hidden behind the
        // success state, on 409 we redirect shortly, on error the user can
        // retry — previously the early 409 return left it stuck on
        // "Joining...".
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

        // No session back from signUp = email confirmation required. (The
        // old `!data.user.confirmed_at` check is unreliable — the presence
        // of a session is what actually says "signed in now".)
        if (!data.session) {
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
    
    // Check for pending invite from Google OAuth redirect. Keep it in storage
    // until redemption actually succeeds — on an OAuth return the Supabase
    // session may still be hydrating from the URL hash, so clearing it now
    // (before getSession resolves a user) would dead-end the join. redeemInvite()
    // removes it once the team is joined.
    const pendingCode = localStorage.getItem('pendingInviteCode');
    if (pendingCode && !inviteCode) {
        inviteCode = pendingCode;
    }

    if (!inviteCode) {
        showError('No Invite Code', 'Please use the invite link shared with you.');
        return;
    }
    
    try {
        // Fetch invite info
        inviteInfo = await fetchInviteInfo(inviteCode);
        displayInvitePreview(inviteInfo);
        
        // Check if user is already logged in (session already hydrated by now).
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session?.user) {
            updateUIForUser(session.user);

            // If we just came from an OAuth redirect, auto-redeem now that the
            // session resolved. The SIGNED_IN handler below also covers the case
            // where the hash hadn't finished hydrating yet; redeemInProgress
            // de-dupes the two paths.
            if (pendingCode) {
                redeemInvite();
            }
        }

        // Listen for auth changes. On a genuine sign-in (incl. OAuth return,
        // which fires SIGNED_IN once the session hydrates from the hash),
        // auto-redeem the invite so Google joins don't dead-end on a manual tap.
        supabaseClient.auth.onAuthStateChange((event, session) => {
            console.log('Auth state changed:', event);
            if (session?.user) {
                updateUIForUser(session.user);
                if (event === 'SIGNED_IN' && inviteCode) {
                    redeemInvite();
                }
            }
        });

    } catch (error) {
        console.error('Initialize error:', error);

        // Classify on HTTP status, not message text.
        if (error.status === 404) {
            showError('Invite Not Found', 'This invite code doesn\'t exist. Please check the link and try again.');
        } else if (error.status === 410) {
            showError('Invite Expired', error.message || 'This invite is no longer valid.');
        } else if (error.status === 409) {
            showError('Already a Member', 'You\'re already on this team. Open the app to get started.');
        } else {
            showError('Error Loading Invite', 'Something went wrong. Please try again later.');
        }
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', initialize);

