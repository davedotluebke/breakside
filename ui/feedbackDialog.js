/*
 * Give Feedback dialog (app menu → Give Feedback).
 *
 * A text box that posts to POST /api/feedback; the server emails the message
 * to the support inbox with the user's address as Reply-To
 * (breakside_server/mail/feedback.py). It replaced a link to a GitHub
 * new-issue form, which most coaches and parents have no account for.
 *
 * What it sends besides the text is shown under "Included with your message"
 * before the user taps Send: app version, device, current team and game, and
 * sync state, so a report can be matched to the server's copy of the game.
 * The account's name and email are added by the server from the session.
 *
 * Every failure (offline, expired sign-in, rate limit, server refusing)
 * keeps the typed text, saved as a draft on this device, and points at the
 * email link at the bottom, which opens the user's mail app with the same
 * text and diagnostics filled in. The pure parts (diagnostics, mailto link,
 * failure wording) are utils/feedbackInfo.js.
 *
 * Same modal shape as the other dialogs: static markup in index.html, shown
 * by toggling display, listeners wired at module evaluation.
 */
import { authFetch, API_BASE_URL, getSyncStatus, getDeadLetterCount } from '../store/sync.js';
import { currentTeam, currentTeamRole } from '../store/storage.js';
import { log } from '../utils/logger.js';
import {
    FEEDBACK_EMAIL, MAX_MESSAGE_CHARS,
    buildDiagnostics, buildMailtoUrl, describeFailure,
} from '../utils/feedbackInfo.js';

const DRAFT_KEY = 'breakside_feedback_draft';

let lastScreenId = null;
let sending = false;

document.addEventListener('breakside:screen-shown', (e) => {
    lastScreenId = e.detail?.screenId || null;
});

function el(id) {
    return document.getElementById(id);
}

// The draft is a per-device convenience; storage can be unavailable (private
// mode, blocked site data), and losing it there is acceptable.
function readDraft() {
    try { return localStorage.getItem(DRAFT_KEY) || ''; } catch (e) { return ''; }
}

function writeDraft(text) {
    try {
        if (text) localStorage.setItem(DRAFT_KEY, text);
        else localStorage.removeItem(DRAFT_KEY);
    } catch (e) { /* see above */ }
}

/** The app state the diagnostics describe, read fresh at open and at send. */
function snapshot() {
    const team = currentTeam || null;
    const game = team?.games?.length ? team.games[team.games.length - 1] : null;
    let pendingSync = null;
    let quarantinedSync = 0;
    try {
        pendingSync = getSyncStatus().pendingCount;
        quarantinedSync = getDeadLetterCount();
    } catch (e) { /* sync not initialized: leave it out */ }
    const gameScreenActive = el('gameScreenContainer')?.classList.contains('active');

    return {
        version: window.APP_VERSION,
        build: window.APP_BUILD,
        deployLabel: window.APP_DEPLOY_LABEL,
        host: location.host,
        standalone: window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        online: navigator.onLine,
        screen: gameScreenActive ? 'game' : lastScreenId,
        team: team ? { name: team.name, id: team.id } : null,
        role: currentTeamRole,
        game: game ? {
            id: game.id,
            us: game.scores?.team,
            them: game.scores?.opponent,
            points: game.points?.length,
            ended: !!game.gameEndTimestamp,
        } : null,
        pendingSync,
        quarantinedSync,
        now: new Date(),
        timeZone: Intl.DateTimeFormat?.().resolvedOptions?.().timeZone,
    };
}

function renderDetails(diagnostics) {
    const list = el('feedbackDetailsList');
    if (!list) return;
    list.replaceChildren(...Object.entries(diagnostics).map(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
    }).flat());
}

function updateMailLink() {
    const link = el('feedbackMailLink');
    if (!link) return;
    link.href = buildMailtoUrl(el('feedbackMessage')?.value || '', buildDiagnostics(snapshot()));
}

function updateCount() {
    const text = el('feedbackMessage')?.value || '';
    const count = el('feedbackCount');
    if (count) {
        // Only near the limit; a counter from the first keystroke reads as a quota.
        const remaining = MAX_MESSAGE_CHARS - text.length;
        count.textContent = remaining < 500 ? `${remaining} characters left` : '';
    }
    const btn = el('feedbackSendBtn');
    if (btn) btn.disabled = sending || !text.trim() || text.length > MAX_MESSAGE_CHARS;
}

function setError(message) {
    const box = el('feedbackError');
    if (!box) return;
    box.textContent = message || '';
    box.style.display = message ? 'block' : 'none';
    // With the details list open, the error can land below the fold.
    if (message) box.scrollIntoView?.({ block: 'nearest' });
}

function showForm(visible) {
    el('feedbackForm').style.display = visible ? '' : 'none';
    el('feedbackDone').style.display = visible ? 'none' : '';
}

function showFeedbackDialog() {
    const dialog = el('feedbackDialog');
    if (!dialog) return;
    sending = false;
    setError('');
    showForm(true);
    const textarea = el('feedbackMessage');
    textarea.maxLength = MAX_MESSAGE_CHARS;
    textarea.value = readDraft();
    const email = window.breakside?.auth?.getCurrentUser?.()?.email;
    el('feedbackReplyNote').textContent = email
        ? `We'll reply to ${email}.`
        : "We'll reply to the email address on your account.";
    el('feedbackAddress').textContent = FEEDBACK_EMAIL;
    el('feedbackDetails').open = false;
    renderDetails(buildDiagnostics(snapshot()));
    updateMailLink();
    updateCount();
    dialog.style.display = 'flex';
    // Not on phones: the keyboard would cover half the dialog before the
    // user has read it.
    if (window.matchMedia?.('(pointer: fine)').matches) textarea.focus();
}

function closeFeedbackDialog() {
    if (sending) return;
    const dialog = el('feedbackDialog');
    if (dialog) dialog.style.display = 'none';
}

async function readDetail(response) {
    try {
        const body = await response.json();
        return typeof body?.detail === 'string' ? body.detail : '';
    } catch (e) {
        return '';
    }
}

async function sendFeedback(event) {
    event?.preventDefault();
    const textarea = el('feedbackMessage');
    const message = (textarea?.value || '').trim();
    if (sending || !message) return;

    writeDraft(textarea.value);
    setError('');
    updateMailLink();
    if (!navigator.onLine) {
        setError(describeFailure({ offline: true }));
        return;
    }

    const btn = el('feedbackSendBtn');
    sending = true;
    updateCount();
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';

    let failure = null;
    try {
        const response = await authFetch(`${API_BASE_URL}/api/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, diagnostics: buildDiagnostics(snapshot()) }),
        });
        if (!response.ok) failure = { status: response.status, detail: await readDetail(response) };
    } catch (error) {
        // fetch rejects only when the request never completed: no network,
        // or a server so broken it sent no CORS headers. Either way, offline
        // is the useful thing to say.
        failure = { offline: true };
    }

    sending = false;
    btn.textContent = 'Send';
    if (failure) {
        log('Feedback send failed:', failure);
        setError(describeFailure(failure));
        updateCount();
        return;
    }
    writeDraft('');
    textarea.value = '';
    showForm(false);
}

// -----------------------------------------------------------------------
// Wiring — module evaluation happens after DOM parse, so these exist.
// -----------------------------------------------------------------------

el('feedbackForm')?.addEventListener('submit', sendFeedback);
el('feedbackCloseX')?.addEventListener('click', closeFeedbackDialog);
el('feedbackCancelBtn')?.addEventListener('click', closeFeedbackDialog);
el('feedbackDoneBtn')?.addEventListener('click', closeFeedbackDialog);
el('feedbackMessage')?.addEventListener('input', () => {
    writeDraft(el('feedbackMessage').value);
    updateCount();
});
// Rebuilt when tapped rather than on every keystroke, since it re-reads the
// app state. A click listener runs before the browser follows the link.
el('feedbackMailLink')?.addEventListener('click', updateMailLink);

window.addEventListener('click', (event) => {
    if (event.target === el('feedbackDialog')) closeFeedbackDialog();
});

export { showFeedbackDialog };
