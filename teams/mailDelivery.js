/**
 * Delivery tracking on the Email Lists screen: how one relayed message's
 * per-recipient delivery is put into words.
 *
 * Pure: no DOM, unit-tested directly (tests/unit/mailDelivery.test.mjs).
 * The screen (teamMail.js) gets the counts on each activity row
 * (`entry.delivery`) and the per-recipient rows from
 * `/mail/log/{id}/delivery`, and asks this module what to say.
 *
 * What "delivered" means, everywhere here: the recipient's mail server
 * accepted the message. Whether it then reached the inbox, a spam folder or
 * a quarantine digest is not something a sender is ever told.
 */

/** A delivery slower than this is worth pointing out (seconds). */
export const SLOW_SECONDS = 600;
/** With no report at all after this long, reports are probably not coming (ms). */
export const REPORTS_EXPECTED_WITHIN_MS = 15 * 60 * 1000;

/** `95` → "2 min", `11400` → "3 h 10 min", `40` → "40 s". */
export function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${Math.max(1, s)} s`;
    const minutes = Math.round(s / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * The activity row's short delivery summary.
 *
 * `d` is `entry.delivery` (`{sent, delivered, delayed, bounced, complaint,
 * rejected, pending, slowestSeconds}`) and `ageMs` how long ago the message
 * was relayed. Returns `{text, icon, quiet}`: `icon` is null when the row's
 * own icon should stand; `quiet` marks a summary with nothing to open (no
 * report has arrived and none is expected any more, which is what a
 * deployment without delivery events looks like).
 */
export function deliverySummary(d, ageMs = 0) {
    if (!d || !d.sent) return null;
    const failed = (d.bounced || 0) + (d.complaint || 0) + (d.rejected || 0);
    const reported = (d.delivered || 0) + (d.delayed || 0) + failed;
    if (!reported) {
        return ageMs > REPORTS_EXPECTED_WITHIN_MS
            ? { text: 'no delivery reports', icon: null, quiet: true }
            : { text: 'waiting for delivery reports', icon: '⏳', quiet: false };
    }
    const parts = [d.delivered === d.sent ? 'all delivered' : `${d.delivered || 0} delivered`];
    if (d.delayed) parts.push(`${d.delayed} delayed`);
    if (d.bounced) parts.push(`${d.bounced} bounced`);
    if (d.rejected) parts.push(`${d.rejected} not sent`);
    if (d.complaint) parts.push(`${d.complaint} marked as spam`);
    if (d.pending) parts.push(`${d.pending} with no report`);
    if (d.slowestSeconds >= SLOW_SECONDS) parts.push(`slowest took ${fmtDuration(d.slowestSeconds)}`);
    const icon = failed ? '⚠️' : (d.delayed || d.slowestSeconds >= SLOW_SECONDS) ? '⏳' : null;
    return { text: parts.join(', '), icon, quiet: false };
}

/**
 * One recipient's state in words: `{label, detail, tone}` with `tone` one
 * of `ok`, `slow`, `wait`, `bad` (the row's colour).
 */
export function recipientStatus(r) {
    const detail = r.detail || '';
    switch (r.status) {
    case 'delivered': {
        if (r.seconds == null) return { label: 'Delivered', detail: '', tone: 'ok' };
        const slow = r.seconds >= SLOW_SECONDS;
        return {
            label: r.seconds < 60 ? `Delivered in ${fmtDuration(r.seconds)}` : `Delivered after ${fmtDuration(r.seconds)}`,
            detail: slow && r.delay ? `Their mail server first answered: ${r.delay}` : '',
            tone: slow ? 'slow' : 'ok',
        };
    }
    case 'delayed':
        return { label: 'Delayed, still trying', detail, tone: 'wait' };
    case 'bounced':
        return { label: 'Bounced', detail, tone: 'bad' };
    case 'complaint':
        return { label: 'Marked as spam by the recipient', detail: '', tone: 'bad' };
    case 'rejected':
        return { label: 'Not sent', detail, tone: 'bad' };
    default:
        return { label: 'No report yet', detail: '', tone: 'wait' };
    }
}

/** "Dad Smith (parent of Alice, Bob)", "Coach Alex (coach)"; '' when nobody carries the address now. */
export function recipientWho(contacts) {
    return (contacts || []).map(c => {
        const players = (c.playerNames || []).join(', ');
        const role = c.kind === 'guardian' ? (players ? `parent of ${players}` : 'parent')
            : c.kind === 'other' ? '' : c.kind;
        return role ? `${c.name} (${role})` : c.name;
    }).join(' / ');
}
