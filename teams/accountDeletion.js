/*
 * Self-service account deletion — the client half of erasure spec § C.
 *
 * Entry point lives at the bottom of the Teams screen (teams/teamList.js
 * appends buildAccountSectionHTML()), which is the only account-scoped screen
 * in the app and the conventional home for this. Deliberately NOT next to the
 * Sign Out button at the top of that screen: the two are one tap apart in a
 * sideline context, and one of them is irreversible.
 *
 * The flow is preview-then-confirm, and the preview is fetched from the server
 * rather than guessed from local state — a coach's device holds a cache, not
 * the truth about which teams they are the last coach of.
 *
 * Two gates before anything is destroyed:
 *   1. the user types DELETE, and
 *   2. when whole teams would be erased, a separate checkbox, which is what
 *      sets ``confirm_erase_teams`` on the request. The server refuses the
 *      cascade without it, so the checkbox is the API contract rather than
 *      decoration.
 *
 * Reuses the existing modal pattern (.modal / .modal-content /
 * .prominent-dialog-header / .modal-buttons, static markup in index.html
 * toggled with display, listeners wired at module evaluation) — same shape as
 * the pending-sync dialog in teams/syncStatusUI.js.
 */
import { authFetch, API_BASE_URL } from '../store/sync.js';
import { escapeHtml } from '../utils/gameLogRenderer.js';
import { log } from '../utils/logger.js';

// The last preview the dialog rendered. The DELETE call reads its
// requiresTeamCascadeConfirmation rather than re-deriving it from the DOM.
let currentPreview = null;
let deleteInFlight = false;

/**
 * Markup for the account section at the bottom of the Teams screen.
 * Rendered by teams/teamList.js so the whole screen is built in one place.
 */
function buildAccountSectionHTML() {
    const email = window.breakside?.auth?.getCurrentUser?.()?.email || '';
    return `
        <div class="account-section">
            <h4 class="account-section-title">Account</h4>
            ${email ? `<div class="account-section-email">${escapeHtml(email)}</div>` : ''}
            <button class="delete-account-link" onclick="showDeleteAccountDialog()">
                Delete account…
            </button>
        </div>
    `;
}

// -----------------------------------------------------------------------
// Dialog
// -----------------------------------------------------------------------

function dialogEl(id) {
    return document.getElementById(id);
}

function closeDeleteAccountDialog() {
    if (deleteInFlight) return;   // never yank the dialog out from under a delete
    const dialog = dialogEl('deleteAccountDialog');
    if (dialog) dialog.style.display = 'none';
    currentPreview = null;
}

function setError(message) {
    const el = dialogEl('deleteAccountError');
    if (!el) return;
    if (!message) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.style.display = 'block';
    el.textContent = message;
}

/**
 * Open the dialog and load the server's preview of what would be destroyed.
 */
async function showDeleteAccountDialog() {
    const dialog = dialogEl('deleteAccountDialog');
    if (!dialog) return;

    currentPreview = null;
    deleteInFlight = false;
    setError('');
    dialogEl('deleteAccountBody').textContent = 'Checking what would be deleted…';
    dialogEl('deleteAccountConfirm').style.display = 'none';
    dialogEl('deleteAccountCascadeRow').style.display = 'none';
    dialogEl('deleteAccountCascadeCheck').checked = false;
    dialogEl('deleteAccountTypeInput').value = '';
    dialogEl('deleteAccountConfirmBtn').disabled = true;
    dialog.style.display = 'flex';

    try {
        const response = await authFetch(`${API_BASE_URL}/api/auth/me/delete-preview`);
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
        currentPreview = await response.json();
        renderPreview(currentPreview);
    } catch (error) {
        console.error('Delete-account preview failed:', error);
        dialogEl('deleteAccountBody').textContent =
            'Could not reach the server to check what would be deleted. ' +
            'Account deletion needs a connection — nothing has been changed.';
    }
}

const COUNT_LABELS = [
    ['teams', 'team', 'teams'],
    ['games', 'game', 'games'],
    ['versions', 'saved game version', 'saved game versions'],
    ['events', 'tournament/event', 'tournaments/events'],
    ['memberships', 'team membership', 'team memberships'],
    ['invites', 'invite code', 'invite codes'],
    ['shares', 'share link', 'share links'],
    ['players', 'player record', 'player records'],
];

function renderPreview(preview) {
    const body = dialogEl('deleteAccountBody');
    const parts = [];

    if (!preview.canDelete) {
        // The sole-coach block. Name the teams and the way out — a dead end
        // with no remedy would just push people to support.
        parts.push('<p class="delete-account-blocked-lede">You can\'t delete your account yet.</p>');
        parts.push('<ul class="delete-account-blockers">');
        for (const blocker of preview.blockers || []) {
            parts.push(`<li>${escapeHtml(blocker)}</li>`);
        }
        parts.push('</ul>');
        parts.push(
            '<p class="delete-account-remedy">You\'re the last coach of a team ' +
            'other people are still using. Open that team\'s settings and either ' +
            'promote another member to Coach, or remove the other members. ' +
            'Then come back here.</p>'
        );
        body.innerHTML = parts.join('');
        dialogEl('deleteAccountConfirm').style.display = 'none';
        dialogEl('deleteAccountConfirmBtn').disabled = true;
        return;
    }

    const counts = preview.willErase || {};
    const lines = COUNT_LABELS
        .filter(([key]) => (counts[key] || 0) > 0)
        .map(([key, one, many]) =>
            `<li><strong>${counts[key]}</strong> ${counts[key] === 1 ? one : many}</li>`);

    parts.push('<p class="delete-account-section-title">This will delete:</p>');
    parts.push('<ul class="delete-account-summary">');
    parts.push('<li>Your Breakside sign-in and profile</li>');
    parts.push(...lines);
    parts.push('</ul>');

    if ((preview.teamsToErase || []).length) {
        const names = preview.teamsToErase
            .map(t => `<li>${escapeHtml(t.name)} <span class="delete-account-team-games">(${t.games} game${t.games === 1 ? '' : 's'})</span></li>`)
            .join('');
        parts.push(
            '<p class="delete-account-section-title">These teams are yours alone ' +
            'and will be erased with everything in them:</p>' +
            `<ul class="delete-account-teams">${names}</ul>`
        );
    }

    if ((preview.warnings || []).length) {
        parts.push('<ul class="delete-account-warnings">');
        for (const warning of preview.warnings) {
            parts.push(`<li>${escapeHtml(warning)}</li>`);
        }
        parts.push('</ul>');
    }

    parts.push(
        '<p class="delete-account-exports">Spreadsheets and JSON files you already ' +
        'exported are on your own devices and can\'t be reached from here.</p>'
    );

    body.innerHTML = parts.join('');

    dialogEl('deleteAccountConfirm').style.display = 'block';
    if (preview.requiresTeamCascadeConfirmation) {
        const teamCount = (preview.teamsToErase || []).length;
        dialogEl('deleteAccountCascadeLabel').textContent = teamCount === 1
            ? 'I understand this team and all of its games will be permanently erased.'
            : `I understand these ${teamCount} teams and all of their games will be permanently erased.`;
        dialogEl('deleteAccountCascadeRow').style.display = 'flex';
    }
    updateConfirmEnabled();
}

/**
 * The delete button stays disabled until every gate is satisfied.
 */
function updateConfirmEnabled() {
    const btn = dialogEl('deleteAccountConfirmBtn');
    if (!btn || !currentPreview || !currentPreview.canDelete) return;

    const typed = (dialogEl('deleteAccountTypeInput')?.value || '').trim().toUpperCase();
    const cascadeOk = !currentPreview.requiresTeamCascadeConfirmation
        || dialogEl('deleteAccountCascadeCheck')?.checked;

    btn.disabled = deleteInFlight || typed !== 'DELETE' || !cascadeOk;
}

/**
 * Fire the delete, then take the device down with it.
 *
 * The session is invalid the moment the server returns, so there is no
 * "signed in but deleted" state to return to — on success this signs out,
 * wipes local data, and leaves for the landing page. On failure it does none
 * of that: a failed delete has changed nothing server-side (the API deletes
 * the auth identity first and aborts on any error), and signing the user out
 * of an account that still exists would be its own small disaster.
 */
async function confirmDeleteAccount() {
    if (deleteInFlight || !currentPreview?.canDelete) return;

    const btn = dialogEl('deleteAccountConfirmBtn');
    deleteInFlight = true;
    setError('');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting…';
    }

    const cascade = currentPreview.requiresTeamCascadeConfirmation ? 'true' : 'false';

    try {
        const response = await authFetch(
            `${API_BASE_URL}/api/auth/me?confirm_erase_teams=${cascade}`,
            { method: 'DELETE' }
        );

        if (!response.ok) {
            const detail = await readErrorDetail(response);
            deleteInFlight = false;
            if (btn) btn.innerHTML = 'Delete my account';
            setError(detail);
            updateConfirmEnabled();
            // A 409 means the world moved since the preview (someone left a
            // team, say). Re-read it so the dialog stops describing the past.
            if (response.status === 409) showDeleteAccountDialog();
            return;
        }

        log('Account deleted; signing out and clearing this device');
        dialogEl('deleteAccountBody').innerHTML =
            '<p class="delete-account-done">Your account has been deleted. ' +
            'Signing out…</p>';
        dialogEl('deleteAccountConfirm').style.display = 'none';
        if (btn) btn.style.display = 'none';

        await window.breakside?.auth?.signOutAfterAccountDeletion?.();
        window.location.href = '/landing/';
    } catch (error) {
        console.error('Account deletion failed:', error);
        deleteInFlight = false;
        if (btn) btn.innerHTML = 'Delete my account';
        setError(
            'Could not delete your account: ' + error.message +
            '. Nothing was deleted — please try again.'
        );
        updateConfirmEnabled();
    }
}

/**
 * Pull a human-readable message out of a FastAPI error body.
 * The deletion routes send a structured detail object; everything else in the
 * API sends a plain string.
 */
async function readErrorDetail(response) {
    try {
        const body = await response.json();
        const detail = body?.detail;
        if (typeof detail === 'string') return detail;
        if (detail?.message) return detail.message;
    } catch (e) {
        /* fall through to the status line */
    }
    return `The server refused the request (${response.status}). Nothing was deleted.`;
}

// -----------------------------------------------------------------------
// Wiring — module evaluation happens after DOM parse, so these exist.
// -----------------------------------------------------------------------

dialogEl('deleteAccountCloseX')?.addEventListener('click', closeDeleteAccountDialog);
dialogEl('deleteAccountCancelBtn')?.addEventListener('click', closeDeleteAccountDialog);
dialogEl('deleteAccountConfirmBtn')?.addEventListener('click', confirmDeleteAccount);
dialogEl('deleteAccountTypeInput')?.addEventListener('input', updateConfirmEnabled);
dialogEl('deleteAccountCascadeCheck')?.addEventListener('change', updateConfirmEnabled);

// Backdrop click closes, matching the other modals on this screen.
window.addEventListener('click', (event) => {
    if (event.target === dialogEl('deleteAccountDialog')) closeDeleteAccountDialog();
});

// --- ES-module exports ---
export { buildAccountSectionHTML, showDeleteAccountDialog };
// window survivor: referenced by generated-HTML onclick (Teams screen account row)
window.showDeleteAccountDialog = showDeleteAccountDialog;
