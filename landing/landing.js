/**
 * Breakside Landing Page
 * Handles authentication with Supabase
 */

// =============================================================================
// Supabase Configuration
// =============================================================================

// The Supabase client (`supabaseClient`) is created by supabaseInit.js,
// loaded before this script — shared with join.js via the global scope.

// Set true when the user actively signs in/up on this page (form submit or
// Google button). The SIGNED_IN redirect is gated on this so a *restored*
// session (which also surfaces as an auth event on load) doesn't immediately
// bounce a returning visitor off the landing page.
let userInitiatedAuth = false;

// =============================================================================
// DOM Elements
// =============================================================================

const authModal = document.getElementById('authModal');
const loginBtn = document.getElementById('loginBtn');
const getStartedBtn = document.getElementById('getStartedBtn');
const quickstartBtn = document.getElementById('quickstartBtn');
const closeAuthModal = document.getElementById('closeAuthModal');

// Auth forms
const signinForm = document.getElementById('signinForm');
const signupForm = document.getElementById('signupForm');
const resetForm = document.getElementById('resetForm');
const newPasswordForm = document.getElementById('newPasswordForm');
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
const loggedInContent = document.getElementById('loggedInContent');
const changePasswordLink = document.getElementById('changePasswordLink');
const changePasswordForm = document.getElementById('changePasswordForm');
const accountMessage = document.getElementById('accountMessage');

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
    showAccountView();
    clearAccountMessage();
    if (inRecoveryMode()) {
        // Dismissed without setting a password: they are still signed in
        // through the reset link, so show that rather than a dead form.
        leaveRecoveryMode();
        supabaseClient.auth.getSession().then(({ data }) => {
            updateUIForUser(data?.session?.user || null);
        });
    }
}

// Event listeners for opening/closing modal
loginBtn?.addEventListener('click', openAuthModal);
getStartedBtn?.addEventListener('click', openAuthModal);
quickstartBtn?.addEventListener('click', openAuthModal);
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
// Field Mode Demo Video
// =============================================================================

const videoModal = document.getElementById('videoModal');
const fieldDemoLink = document.getElementById('fieldDemoLink');
const fieldDemoVideo = document.getElementById('fieldDemoVideo');
const closeVideoModal = document.getElementById('closeVideoModal');

function openVideoModal() {
    videoModal.classList.add('active');
    document.body.style.overflow = 'hidden';
    fieldDemoVideo.currentTime = 0;
    fieldDemoVideo.play().catch(() => {});
    // Go straight to full screen (we're inside a user gesture). The lightbox
    // stays behind as the fallback chrome — iOS Safari only fullscreens via
    // webkitEnterFullscreen, and either API may refuse.
    if (fieldDemoVideo.requestFullscreen) {
        fieldDemoVideo.requestFullscreen().catch(() => {});
    } else if (fieldDemoVideo.webkitEnterFullscreen) {
        try { fieldDemoVideo.webkitEnterFullscreen(); } catch (_) { /* lightbox fallback */ }
    }
}

function closeVideo() {
    videoModal.classList.remove('active');
    document.body.style.overflow = '';
    fieldDemoVideo.pause();
}

fieldDemoLink?.addEventListener('click', openVideoModal);
closeVideoModal?.addEventListener('click', closeVideo);

videoModal?.addEventListener('click', (e) => {
    if (e.target === videoModal) closeVideo();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && videoModal?.classList.contains('active')) closeVideo();
});

// Leaving native fullscreen returns to the lightbox; closing it entirely is
// the ✕ / backdrop / Escape. iOS fires webkitendfullscreen when the user
// dismisses the native player — treat that as closing the whole thing.
fieldDemoVideo?.addEventListener('webkitendfullscreen', closeVideo);

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
    newPasswordForm?.classList.add('hidden');
    leaveRecoveryMode();
    
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

// The same two helpers for #accountMessage, which lives in the logged-in
// half of the modal (#authMessage is inside the signed-out half, hidden
// whenever there is a session).
function showAccountMessage(message, type = 'error') {
    accountMessage.textContent = message;
    accountMessage.className = `auth-message ${type}`;
    accountMessage.classList.remove('hidden');
}

function clearAccountMessage() {
    accountMessage.classList.add('hidden');
    accountMessage.textContent = '';
}

// =============================================================================
// Sign In
// =============================================================================

signinForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthMessage();
    
    const email = document.getElementById('signinEmail').value;
    const password = document.getElementById('signinPassword').value;

    userInitiatedAuth = true;

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
    
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const passwordConfirm = document.getElementById('signupPasswordConfirm').value;
    
    // Validate name provided
    if (!name) {
        showAuthMessage('Please enter your name');
        return;
    }
    
    // Validate passwords match
    if (password !== passwordConfirm) {
        showAuthMessage('Passwords do not match');
        return;
    }

    userInitiatedAuth = true;

    const submitBtn = signupForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Creating account...';
    submitBtn.disabled = true;
    
    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: window.location.origin + '/',
                data: {
                    full_name: name
                }
            }
        });
        
        if (error) throw error;

        // No session back from signUp = email confirmation required. (The
        // old `!data.user.confirmed_at` check is unreliable — the presence
        // of a session is what actually says "signed in now".)
        if (!data.session) {
            showAuthMessage('Check your email for a message from "Supabase Auth" and click the link to activate your account.', 'success');
            // After 10 seconds, switch back to sign-in tab
            setTimeout(() => {
                switchAuthTab('signin');
                clearAuthMessage();
            }, 10000);
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
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
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
// Change Password (My Account modal)
// =============================================================================

// The landing-page twin of the app's change-password dialog
// (teams/accountPassword.js), kept deliberately smaller: no show-passwords
// toggle, no sign-out-other-devices. The rules below mirror
// auth/passwordRules.js, which this classic script cannot import.

let signedInUser = null;

function hasPasswordIdentity(user) {
    if (!user) return false;
    const providers = Array.isArray(user.identities) && user.identities.length
        ? user.identities.map(i => i && i.provider).filter(Boolean)
        : ((user.app_metadata && user.app_metadata.providers) || []);
    return providers.length === 0 || providers.includes('email');
}

function showAccountView() {
    loggedInContent?.classList.remove('hidden');
    changePasswordForm?.classList.add('hidden');
}

function openChangePasswordForm() {
    clearAccountMessage();
    changePasswordForm.reset();
    document.getElementById('changePasswordEmail').textContent = signedInUser?.email || '';
    const forgotBtn = document.getElementById('changePasswordForgotBtn');
    forgotBtn.disabled = false;
    forgotBtn.textContent = 'Email me a reset link';
    loggedInContent.classList.add('hidden');
    changePasswordForm.classList.remove('hidden');
    document.getElementById('currentPassword').focus();
}

changePasswordLink?.addEventListener('click', openChangePasswordForm);
document.getElementById('backToAccountBtn')?.addEventListener('click', () => {
    clearAccountMessage();
    showAccountView();
});

/**
 * Check the current password against GoTrue's password grant directly rather
 * than through supabaseClient.signInWithPassword(): that would replace the
 * session and fire SIGNED_IN, and updateUIForUser() runs on every auth event.
 * The throwaway session the grant mints is revoked straight away
 * (scope=local, so only that one). Same approach as auth/auth.js.
 */
async function verifyCurrentPassword(email, password) {
    const base = `${SUPABASE_URL}/auth/v1`;
    const headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };

    let response;
    try {
        response = await fetch(`${base}/token?grant_type=password`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ email, password }),
        });
    } catch (e) {
        return { ok: false, message: "Couldn't reach the sign-in service. Check your connection and try again." };
    }

    let body = {};
    try {
        body = await response.json();
    } catch (e) {
        /* non-JSON body; the status code carries the answer */
    }

    if (response.ok) {
        if (body.access_token) {
            fetch(`${base}/logout?scope=local`, {
                method: 'POST',
                headers: { ...headers, Authorization: `Bearer ${body.access_token}` },
            }).catch(() => { /* best effort; the session expires on its own */ });
        }
        return { ok: true };
    }
    if (response.status === 429) return { ok: false, message: 'Too many attempts. Wait a minute and try again.' };
    if (response.status === 400) return { ok: false, message: 'That current password is incorrect.' };
    return { ok: false, message: body.msg || body.error_description || `Password check failed (${response.status})` };
}

function describeUpdateError(error) {
    switch (error?.code) {
        case 'same_password':
            return 'Your new password must be different from your current one.';
        case 'reauthentication_needed':
            return 'This account is set to confirm password changes by email. Use the reset link below instead.';
        case 'over_request_rate_limit':
            return 'Too many attempts. Wait a minute and try again.';
        default:
            break;
    }
    if (error?.status === 429) return 'Too many attempts. Wait a minute and try again.';
    return error?.message || 'Failed to change the password';
}

changePasswordForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAccountMessage();

    const email = signedInUser?.email;
    const current = document.getElementById('currentPassword').value;
    const next = document.getElementById('changeNewPassword').value;
    const confirm = document.getElementById('changeNewPasswordConfirm').value;

    if (!email) {
        showAccountMessage("You're not signed in.");
        return;
    }
    if (!current) {
        showAccountMessage('Enter your current password.');
        return;
    }
    if (next.length < 6) {
        showAccountMessage('Your new password needs at least 6 characters.');
        return;
    }
    if (next !== confirm) {
        showAccountMessage("The two new passwords don't match.");
        return;
    }
    if (next === current) {
        showAccountMessage('Your new password must be different from your current one.');
        return;
    }

    const submitBtn = changePasswordForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;

    try {
        submitBtn.textContent = 'Checking...';
        const check = await verifyCurrentPassword(email, current);
        if (!check.ok) {
            showAccountMessage(check.message);
            return;
        }

        submitBtn.textContent = 'Saving...';
        const { error } = await supabaseClient.auth.updateUser({ password: next });
        if (error) {
            showAccountMessage(describeUpdateError(error));
            return;
        }

        changePasswordForm.reset();
        showAccountMessage('Your password has been changed.', 'success');
        setTimeout(showAccountView, 1500);

    } catch (error) {
        console.error('Change password error:', error);
        showAccountMessage(error.message || 'Failed to change the password');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
});

// For the coach who has been signed in for months and no longer knows the
// current password: the same reset email as "Forgot password?", whose link
// comes back to this page's set-new-password form.
document.getElementById('changePasswordForgotBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const email = signedInUser?.email;
    if (!email || btn.disabled) return;

    clearAccountMessage();
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/landing/?reset=true',
        });
        if (error) throw error;
        btn.textContent = 'Sent';
        showAccountMessage(`Reset link sent to ${email}. Open it on this device to set a new password.`, 'success');
    } catch (error) {
        console.error('Reset email failed:', error);
        btn.disabled = false;
        btn.textContent = 'Email me a reset link';
        showAccountMessage(error.message || 'Failed to send reset email');
    }
});

// =============================================================================
// Set New Password (the emailed reset link lands here)
// =============================================================================

// A reset link arrives as /landing/?reset=true#access_token=…&type=recovery.
// supabase-js turns the hash into a recovery session when the client is
// created and later fires PASSWORD_RECOVERY; the hash check is the belt to
// that event's braces. An expired link arrives with an error_description
// instead of a token.
const arrivedFromResetLink = /[#&]type=recovery(?:&|$)/.test(window.location.hash);
const callbackErrorDescription = new URLSearchParams(window.location.hash.slice(1)).get('error_description');
let pendingCallbackMessage = callbackErrorDescription;

const authSubtitle = document.querySelector('.auth-subtitle');
const defaultAuthSubtitle = authSubtitle?.textContent || '';

function inRecoveryMode() {
    return authContainer.classList.contains('recovery-mode');
}

function leaveRecoveryMode() {
    authContainer.classList.remove('recovery-mode');
    if (authSubtitle) authSubtitle.textContent = defaultAuthSubtitle;
}

function showNewPasswordForm() {
    authContainer.classList.add('recovery-mode');
    authContainer.classList.remove('hidden');
    loggedInContainer.classList.add('hidden');
    signinForm.classList.add('hidden');
    signupForm.classList.add('hidden');
    resetForm.classList.add('hidden');
    newPasswordForm.classList.remove('hidden');
    if (authSubtitle) authSubtitle.textContent = 'Set a new password for your account';
    clearAuthMessage();
    openAuthModal();
    document.getElementById('newPassword').focus();
}

newPasswordForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthMessage();

    const password = document.getElementById('newPassword').value;
    const confirm = document.getElementById('newPasswordConfirm').value;
    if (password.length < 6) {
        showAuthMessage('Your new password needs at least 6 characters.');
        return;
    }
    if (password !== confirm) {
        showAuthMessage("The two passwords don't match.");
        return;
    }

    const submitBtn = newPasswordForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Saving...';
    submitBtn.disabled = true;

    try {
        const { error } = await supabaseClient.auth.updateUser({ password });
        if (error) throw error;

        // The token in the hash has done its job; keep it out of history.
        history.replaceState(null, '', window.location.pathname);
        newPasswordForm.reset();
        showAuthMessage("Your new password is set. You're signed in.", 'success');
        setTimeout(async () => {
            leaveRecoveryMode();
            const { data } = await supabaseClient.auth.getSession();
            updateUIForUser(data?.session?.user || null);
        }, 1500);

    } catch (error) {
        console.error('Set new password error:', error);
        showAuthMessage(error.message || 'Failed to set the new password');
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
        const { error } = await supabaseClient.auth.signInWithOAuth({
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
        const { error } = await supabaseClient.auth.signOut();
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
    signedInUser = user;
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

        // No password to change on a Google-only account.
        changePasswordLink?.classList.toggle('hidden', !hasPasswordIdentity(user));
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
        newPasswordForm?.reset();
        changePasswordForm?.reset();
        showAccountView();
        clearAccountMessage();
        
        // Update nav button
        if (loginBtn) {
            loginBtn.textContent = 'Sign In / Sign Up';
        }
    }
}

// =============================================================================
// Session Initialization
// =============================================================================

async function initializeAuth() {
    try {
        // Get current session. A reset link's hash has already become a
        // recovery session by now (supabase-js does that on client creation).
        const { data: { session } } = await supabaseClient.auth.getSession();

        if (session?.user) {
            if (arrivedFromResetLink) {
                showNewPasswordForm();
            } else {
                updateUIForUser(session.user);
            }
        } else if (callbackErrorDescription) {
            // Typically an expired reset link; the message itself is shown
            // from the listener below. Keep the error out of history now.
            history.replaceState(null, '', window.location.pathname);
        }

        // Listen for auth changes
        supabaseClient.auth.onAuthStateChange((event, session) => {
            console.log('Auth state changed:', event);

            if (event === 'PASSWORD_RECOVERY') {
                // The reset link's session: ask for the new password rather
                // than showing the signed-in view. Usually the hash check
                // above got here first; this is the backstop.
                if (!inRecoveryMode()) showNewPasswordForm();
                return;
            }
            // While the new-password form is up, the session events around
            // it (INITIAL_SESSION, USER_UPDATED) must not flip the modal to
            // the signed-in view mid-reset; the form's own handler does that.
            if (inRecoveryMode()) return;

            updateUIForUser(session?.user || null);

            if (pendingCallbackMessage && !session) {
                // Supabase's reason the link failed, shown where a fresh one
                // can be requested. Done here rather than before subscribing
                // because the INITIAL_SESSION event that subscribing emits
                // resets the modal (updateUIForUser(null)) and would wipe it.
                openAuthModal();
                showAuthMessage(pendingCallbackMessage);
                pendingCallbackMessage = null;
            }

            // Handle specific events
            if (event === 'SIGNED_IN' && userInitiatedAuth) {
                // Only redirect on a genuine, user-initiated sign-in — NOT on a
                // restored session surfacing as SIGNED_IN on page load, which
                // would bounce a returning visitor straight off the landing page.
                window.location.href = '/';
            } else if (event === 'SIGNED_OUT') {
                closeModal();
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

