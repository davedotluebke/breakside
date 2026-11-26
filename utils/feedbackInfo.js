/*
 * Give Feedback, the pure half: the support address, the message limit, the
 * diagnostics block that rides along with a report, the mailto: fallback, and
 * the wording of a failed send.
 *
 * Pure leaf: no DOM, no imports, no globals read. ui/feedbackDialog.js takes
 * a snapshot of app state and hands it in, so everything here is unit-tested
 * (tests/unit/feedbackInfo.test.mjs) without a browser.
 */

// Where a report goes when the in-app send can't: offline, signed out, or the
// server refusing. The server delivers in-app sends to the same mailbox.
export const FEEDBACK_EMAIL = 'help@breakside.pro';

// Keep in step with MAX_MESSAGE_CHARS in breakside_server/mail/feedback.py.
export const MAX_MESSAGE_CHARS = 5000;

// Longer mailto: URLs are cut off or refused by some mail apps. Not a spec
// limit; a conservative figure that every client tried so far accepts.
export const MAILTO_MAX_CHARS = 1900;

const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * The diagnostics as an ordered `{label: value}` object, empty entries left
 * out. Labels are what the support inbox reads; keep them short and stable.
 *
 * @param {object} s - snapshot gathered by the dialog:
 *   { version, build, deployLabel, host, standalone, userAgent, viewport:
 *     {width, height, dpr}, online, screen, team: {name, id}, role,
 *     game: {id, us, them, points, ended}, pendingSync, quarantinedSync,
 *     now: Date, timeZone }
 */
export function buildDiagnostics(s = {}) {
    const d = {};
    if (nonEmpty(s.version)) {
        d.App = `${s.version}${nonEmpty(s.build) ? ` (build ${s.build})` : ''}`
            + (nonEmpty(s.deployLabel) ? ` [${s.deployLabel}]` : '');
    }
    if (nonEmpty(s.host)) d.Site = s.host;
    if (typeof s.standalone === 'boolean') d['Running as'] = s.standalone ? 'installed app' : 'browser tab';
    if (nonEmpty(s.userAgent)) d.Device = s.userAgent;
    if (s.viewport?.width && s.viewport?.height) {
        d.Viewport = `${s.viewport.width}x${s.viewport.height}`
            + (s.viewport.dpr ? ` @${Math.round(s.viewport.dpr * 100) / 100}x` : '');
    }
    if (typeof s.online === 'boolean') d.Online = s.online ? 'yes' : 'no';
    if (nonEmpty(s.screen)) d.Screen = s.screen;
    if (s.team && (nonEmpty(s.team.name) || nonEmpty(s.team.id))) {
        d.Team = nonEmpty(s.team.id) ? `${s.team.name || '(unnamed)'} (${s.team.id})` : s.team.name;
    }
    if (nonEmpty(s.role)) d.Role = s.role;
    if (s.game && nonEmpty(s.game.id)) {
        d.Game = s.game.id;
        if (Number.isFinite(s.game.us) && Number.isFinite(s.game.them)) {
            const points = Number.isFinite(s.game.points)
                ? ` after ${s.game.points} point${s.game.points === 1 ? '' : 's'}` : '';
            d.Score = `${s.game.us}-${s.game.them}${points}${s.game.ended ? ', ended' : ''}`;
        }
    }
    if (Number.isFinite(s.pendingSync)) {
        d['Unsynced changes'] = String(s.pendingSync)
            + (s.quarantinedSync ? ` (${s.quarantinedSync} set aside after errors)` : '');
    }
    if (s.now instanceof Date && !Number.isNaN(s.now.getTime())) {
        d['Local time'] = s.now.toISOString() + (nonEmpty(s.timeZone) ? ` (${s.timeZone})` : '');
    }
    return d;
}

/** `Label: value` lines, for the mail body and the dialog's details list. */
export function formatDiagnostics(diagnostics = {}) {
    return Object.entries(diagnostics).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/**
 * A mailto: link carrying the message and as much of the diagnostics as fits.
 * The user's own words come first and are the last thing cut: full text and
 * diagnostics, else the text and the App line, else the text shortened.
 */
export function buildMailtoUrl(message = '', diagnostics = {}, address = FEEDBACK_EMAIL) {
    const text = String(message || '').trim();
    const subject = 'Breakside feedback';
    const url = (body) => `mailto:${address}?subject=${encodeURIComponent(subject)}`
        + (body ? `&body=${encodeURIComponent(body)}` : '');
    const withDiag = (diag) => {
        const block = formatDiagnostics(diag);
        return [text, block ? `---\n${block}` : ''].filter(Boolean).join('\n\n');
    };

    const full = url(withDiag(diagnostics));
    if (full.length <= MAILTO_MAX_CHARS) return full;

    const appOnly = diagnostics.App ? { App: diagnostics.App } : {};
    const short = url(withDiag(appOnly));
    if (short.length <= MAILTO_MAX_CHARS) return short;

    // Cut the text until the encoded URL fits. Encoding expands unevenly
    // (an emoji is 12 characters), so measure rather than estimate. Cut by
    // code point: half a surrogate pair makes encodeURIComponent throw.
    const chars = Array.from(text);
    let keep = chars.length;
    let candidate = short;
    while (keep > 0 && candidate.length > MAILTO_MAX_CHARS) {
        keep = Math.floor(keep * 0.9);
        candidate = url(`${chars.slice(0, keep).join('')}…`);
    }
    return candidate;
}

/**
 * What the dialog says when a send fails. The draft is always kept, and the
 * dialog shows the email link beside this, so every message ends there.
 *
 * @param {{offline?: boolean, status?: number, detail?: string}} failure
 */
export function describeFailure({ offline = false, status, detail } = {}) {
    if (offline) {
        return "You're offline. Your message is saved here: send it when you're back online, or email us instead.";
    }
    if ((status === 400 || status === 429) && nonEmpty(detail)) return detail;
    if (status === 401 || status === 403) {
        return 'Your sign-in has expired, so this could not be sent. Email us instead, or sign in again and retry.';
    }
    return "Couldn't send your message right now. It's saved here: try again in a little while, or email us instead.";
}
