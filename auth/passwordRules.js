/**
 * Password rules shared by the change-password dialog
 * (teams/accountPassword.js), the auth module (auth/auth.js) and the landing
 * page's reset-link form. Pure functions only — no DOM, no Supabase — so
 * tests/unit can import this file under Node.
 */

// Mirrors the sign-up forms (index.html, landing/index.html). The real floor
// is whatever the Supabase project enforces; a stricter answer from the server
// comes back as a weak_password error and is shown as-is.
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Client-side checks before anything is sent.
 * @param {object} fields
 * @param {string} [fields.current]  the password being replaced (change mode)
 * @param {string} fields.next
 * @param {string} fields.confirm
 * @param {boolean} [fields.requireCurrent=true]  false in recovery mode, where
 *        the emailed link stood in for the current password
 * @returns {string|null} a message for the user, or null when acceptable
 */
export function validatePasswordChange({ current = '', next = '', confirm = '', requireCurrent = true }) {
    if (requireCurrent && !current) return 'Enter your current password.';
    if (!next) return 'Enter a new password.';
    if (next.length < MIN_PASSWORD_LENGTH) {
        return `Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (next !== confirm) return "The two new passwords don't match.";
    if (requireCurrent && next === current) {
        return 'Your new password must be different from your current one.';
    }
    return null;
}

/**
 * The sign-in providers on a Supabase user: ['email'], ['google'], or both
 * (Supabase links a Google sign-in onto an existing verified email account).
 * Empty when the shape is unknown.
 */
export function userProviders(user) {
    if (!user) return [];
    if (Array.isArray(user.identities) && user.identities.length) {
        return user.identities.map(i => i && i.provider).filter(Boolean);
    }
    const providers = user.app_metadata && user.app_metadata.providers;
    if (Array.isArray(providers)) return providers.filter(Boolean);
    return [];
}

/**
 * Whether this account can sign in with a password at all. A Google-only
 * account has none to change (updateUser() would *add* one — a different
 * feature). Unknown shapes — the test-mode fake user, an older cached user —
 * count as password accounts: the worst outcome there is "current password
 * is incorrect", never a wrong write.
 */
export function userHasPasswordIdentity(user) {
    if (!user) return false;
    const providers = userProviders(user);
    return providers.length === 0 || providers.includes('email');
}

/**
 * Human label for the non-password providers, for "Signed in with Google".
 */
export function describeProviders(user) {
    const names = { google: 'Google', apple: 'Apple', github: 'GitHub' };
    return userProviders(user)
        .filter(p => p !== 'email')
        .map(p => names[p] || p.charAt(0).toUpperCase() + p.slice(1))
        .join(' and ');
}

/**
 * Turn a Supabase / GoTrue error into a sentence. Codes are GoTrue's
 * error_code strings (supabase-js surfaces them as error.code).
 */
export function describePasswordError(error, fallback = 'Something went wrong. Please try again.') {
    if (!error) return fallback;
    const code = typeof error.code === 'string' ? error.code : (error.error_code || '');
    switch (code) {
        case 'invalid_credentials':
            return 'That current password is incorrect.';
        case 'same_password':
            return 'Your new password must be different from your current one.';
        case 'weak_password':
            return error.message || 'That password is too easy to guess.';
        case 'reauthentication_needed':
            return 'This account is set to confirm password changes by email, '
                + 'which this dialog can\'t do yet. Use "Email me a reset link" instead.';
        case 'over_request_rate_limit':
        case 'over_email_send_rate_limit':
            return 'Too many attempts. Wait a minute and try again.';
        case 'session_expired':
        case 'session_not_found':
        case 'refresh_token_not_found':
            return 'Your sign-in has expired. Sign in again and retry.';
        default:
            break;
    }
    if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (error.name === 'AuthRetryableFetchError' || error.status === 0) {
        return "Couldn't reach the sign-in service. Check your connection and try again.";
    }
    return error.message || fallback;
}
