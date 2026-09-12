/*
 * Change password — the signed-in half of password handling. (The
 * forgot-password email is sent from auth/loginScreen.js and landing/;
 * this file is where its link lands.)
 *
 * Two ways in, one dialog:
 *
 *   change   — "Change password…" in the Account section at the bottom of
 *              the Teams screen (rendered by teams/accountDeletion.js
 *              buildAccountSectionHTML, which owns that section). Asks for
 *              the current password and has auth/auth.js verify it before
 *              anything is written: a coach's unlocked phone gets handed
 *              around on a sideline, and the session alone should not be
 *              enough to lock its owner out.
 *   recovery — the emailed reset link. Supabase signs the user in with a
 *              recovery session and main.js opens the dialog in this mode:
 *              no current-password field (the link was the proof), just the
 *              new one twice. Cancelling leaves them signed in unchanged,
 *              which is what Supabase's recovery session means anyway.
 *
 * A Google-only account has no password; the section shows a note instead
 * of the link (auth/passwordRules.js userHasPasswordIdentity). Letting such
 * an account *add* a password is a separate feature, not built.
 *
 * Same modal pattern as the delete-account dialog beside it: static markup
 * in index.html toggled with display, listeners wired at module evaluation,
 * opened by a window-qualified onclick from generated HTML.
 */
import {
    validatePasswordChange, userHasPasswordIdentity, describeProviders,
    describePasswordError, MIN_PASSWORD_LENGTH,
} from '../auth/passwordRules.js';
import { escapeHtml } from '../utils/gameLogRenderer.js';
import { log } from '../utils/logger.js';

let mode = 'change';   // 'change' | 'recovery'
let inFlight = false;

const FORGOT_LABEL = 'Email me a reset link';
const PASSWORD_FIELDS = ['changePasswordCurrent', 'changePasswordNew', 'changePasswordConfirm'];

function el(id) {
    return document.getElementById(id);
}

function auth() {
    return window.breakside?.auth;
}

function currentUser() {
    return auth()?.getCurrentUser?.() || null;
}

/**
 * The password row of the Account section: a link for password accounts, a
 * note for everyone else. Rendered by teams/accountDeletion.js.
 */
function buildAccountPasswordHTML() {
    const user = currentUser();
    if (!user) return '';
    if (!userHasPasswordIdentity(user)) {
        const via = describeProviders(user) || 'another provider';
        return `<span class="account-section-note">Signed in with ${escapeHtml(via)} — no Breakside password to change</span>`;
    }
    return '<button class="account-link" onclick="showChangePasswordDialog()">Change password…</button>';
}

// -----------------------------------------------------------------------
// Dialog
// -----------------------------------------------------------------------

function isOpen() {
    return el('changePasswordDialog')?.style.display === 'flex';
}

function setError(message) {
    const box = el('changePasswordError');
    if (!box) return;
    box.style.display = message ? 'block' : 'none';
    box.textContent = message || '';
}

function updateSubmitEnabled() {
    const submit = el('changePasswordSubmitBtn');
    if (!submit) return;
    const needCurrent = mode === 'change';
    const filled = (!needCurrent || el('changePasswordCurrent').value.length > 0)
        && el('changePasswordNew').value.length > 0
        && el('changePasswordConfirm').value.length > 0;
    submit.disabled = inFlight || !filled;
}

function setBusy(busy, label = '') {
    inFlight = busy;
    const submit = el('changePasswordSubmitBtn');
    if (submit) {
        if (busy) {
            submit.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${label}`;
        } else {
            submit.textContent = mode === 'recovery' ? 'Set password' : 'Change password';
        }
    }
    const cancel = el('changePasswordCancelBtn');
    if (cancel) cancel.disabled = busy;
    [...PASSWORD_FIELDS, 'changePasswordShow', 'changePasswordSignOutOthers'].forEach(id => {
        const field = el(id);
        if (field) field.disabled = busy;
    });
    updateSubmitEnabled();
}

/**
 * Open the dialog. `{ recovery: true }` is the reset-link mode (see the
 * header comment). A no-op while a change is in flight or the dialog is
 * already up: the recovery path can arrive twice (URL hash at boot, then
 * the PASSWORD_RECOVERY event) and must not wipe what the user is typing.
 */
function showChangePasswordDialog(options = {}) {
    const dialog = el('changePasswordDialog');
    if (!dialog || inFlight || isOpen()) return;
    const user = currentUser();
    if (!user) return;

    mode = options.recovery === true ? 'recovery' : 'change';
    const recovery = mode === 'recovery';

    el('changePasswordTitle').textContent = recovery ? 'Set a new password' : 'Change password';
    el('changePasswordLede').textContent = recovery
        ? 'You’re signed in through your reset link. Choose a new password to finish.'
        : 'Choose a new password for this account. Other devices stay signed in unless you say otherwise.';
    el('changePasswordEmail').value = user.email || '';
    el('changePasswordCurrentRow').style.display = recovery ? 'none' : '';
    el('changePasswordHint').textContent = `At least ${MIN_PASSWORD_LENGTH} characters.`;

    PASSWORD_FIELDS.forEach(id => {
        const field = el(id);
        field.value = '';
        field.type = 'password';
    });
    el('changePasswordShow').checked = false;
    el('changePasswordSignOutOthers').checked = false;

    el('changePasswordForm').style.display = '';
    el('changePasswordDone').style.display = 'none';
    el('changePasswordDoneRow').style.display = 'none';

    // The forgot-link row is for change mode only, and its text is rewritten
    // once a link has been sent, so put it back each time.
    el('changePasswordForgotRow').style.display = recovery ? 'none' : '';
    el('changePasswordForgotText').textContent = 'Forgot your current password?';
    const forgotBtn = el('changePasswordForgotBtn');
    forgotBtn.style.display = '';
    forgotBtn.disabled = false;
    forgotBtn.textContent = FORGOT_LABEL;

    setError('');
    setBusy(false);

    dialog.style.display = 'flex';
    el(recovery ? 'changePasswordNew' : 'changePasswordCurrent').focus();
}

function closeChangePasswordDialog() {
    if (inFlight) return;   // never yank the dialog out from under a write
    const dialog = el('changePasswordDialog');
    if (dialog) dialog.style.display = 'none';
}

/**
 * Validate locally, verify the current password (change mode), then write
 * the new one. Every failure leaves the form up with the fields intact so
 * the fix is one edit away.
 */
async function submitChangePassword(event) {
    event.preventDefault();
    if (inFlight) return;

    const api = auth();
    if (!api?.updatePassword || !api?.verifyCurrentPassword) {
        setError('Password changes need the sign-in service, which is not available right now.');
        return;
    }

    const recovery = mode === 'recovery';
    const current = el('changePasswordCurrent').value;
    const next = el('changePasswordNew').value;
    const confirm = el('changePasswordConfirm').value;

    const problem = validatePasswordChange({ current, next, confirm, requireCurrent: !recovery });
    if (problem) {
        setError(problem);
        return;
    }

    setError('');
    setBusy(true, recovery ? 'Saving…' : 'Checking…');
    try {
        if (!recovery) {
            const { ok, error } = await api.verifyCurrentPassword(current);
            if (!ok) {
                setError(describePasswordError(error));
                return;
            }
            setBusy(true, 'Saving…');
        }

        const signOutOthers = el('changePasswordSignOutOthers').checked;
        const { error, othersSignedOut } = await api.updatePassword(next, { signOutOthers });
        if (error) {
            setError(describePasswordError(error));
            return;
        }

        log(recovery ? 'Password set from reset link' : 'Password changed');
        showDone(signOutOthers, othersSignedOut);
    } catch (error) {
        console.error('Password change failed:', error);
        setError(describePasswordError(error));
    } finally {
        setBusy(false);
    }
}

function showDone(othersRequested, othersSignedOut) {
    el('changePasswordForm').style.display = 'none';
    el('changePasswordForgotRow').style.display = 'none';

    let text = mode === 'recovery' ? 'Your new password is set.' : 'Your password has been changed.';
    if (othersRequested) {
        text += othersSignedOut
            ? ' Your other devices have been signed out.'
            : ' Signing out your other devices didn’t go through; they stay signed in for now.';
    }
    const done = el('changePasswordDone');
    done.textContent = text;
    done.style.display = 'block';
    el('changePasswordDoneRow').style.display = '';
}

/**
 * The escape hatch for a coach who has been auto-signed-in for months and
 * no longer knows the current password: the same reset email as "Forgot
 * password?" on the sign-in screen, whose link reopens this dialog in
 * recovery mode.
 */
async function emailResetLink() {
    const api = auth();
    const email = currentUser()?.email;
    const btn = el('changePasswordForgotBtn');
    if (!email || !api?.resetPassword || !btn || btn.disabled) return;

    btn.disabled = true;
    btn.textContent = 'Sending…';
    setError('');
    try {
        const { error } = await api.resetPassword(email);
        if (error) {
            setError(describePasswordError(error, 'Could not send the reset email.'));
            btn.disabled = false;
            btn.textContent = FORGOT_LABEL;
            return;
        }
        el('changePasswordForgotText').textContent =
            `Reset link sent to ${email}. Open it on this device to set a new password.`;
        btn.style.display = 'none';
    } catch (error) {
        console.error('Reset email failed:', error);
        setError(describePasswordError(error, 'Could not send the reset email.'));
        btn.disabled = false;
        btn.textContent = FORGOT_LABEL;
    }
}

function toggleShowPasswords(event) {
    const type = event.target.checked ? 'text' : 'password';
    PASSWORD_FIELDS.forEach(id => {
        const field = el(id);
        if (field) field.type = type;
    });
}

// -----------------------------------------------------------------------
// Wiring — module evaluation happens after DOM parse, so these exist.
// -----------------------------------------------------------------------

el('changePasswordForm')?.addEventListener('submit', submitChangePassword);
el('changePasswordCloseX')?.addEventListener('click', closeChangePasswordDialog);
el('changePasswordCancelBtn')?.addEventListener('click', closeChangePasswordDialog);
el('changePasswordDoneBtn')?.addEventListener('click', closeChangePasswordDialog);
el('changePasswordShow')?.addEventListener('change', toggleShowPasswords);
el('changePasswordForgotBtn')?.addEventListener('click', emailResetLink);
PASSWORD_FIELDS.forEach(id => {
    el(id)?.addEventListener('input', () => {
        setError('');
        updateSubmitEnabled();
    });
});

// Backdrop click closes, matching the other modals on this screen.
window.addEventListener('click', (event) => {
    if (event.target === el('changePasswordDialog')) closeChangePasswordDialog();
});

// --- ES-module exports ---
export { buildAccountPasswordHTML, showChangePasswordDialog };
// window survivor: referenced by generated-HTML onclick (Teams screen account row)
window.showChangePasswordDialog = showChangePasswordDialog;
