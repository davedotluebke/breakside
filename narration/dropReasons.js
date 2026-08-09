/*
 * Drop-reason summarizer for narration.
 *
 * When the slow pass returns an event the client can't record, the coach gets
 * a toast. That toast used to say "couldn't be matched to on-field players"
 * for every cause, which was wrong more often than right: a throw the model
 * emitted without a receiver — what it produces for a narrated pull when the
 * pull schema isn't available — was reported as a roster-matching problem,
 * sending a coach after a player-name bug that didn't exist.
 *
 * Pure leaf module: no DOM, no imports, no state. narrationEngine collects
 * {reason, detail} records and hands them here for one short clause.
 */

/**
 * @param {Array<{reason: string, detail?: string}>} dropReasons
 * @returns {string} a clause for the toast, or '' when there's nothing to say
 */
function summarizeDrops(dropReasons) {
    if (!Array.isArray(dropReasons) || dropReasons.length === 0) return '';

    // Preserve first-seen order so the message reads in the order things
    // happened, and group so three unmatched names are one phrase not three.
    const order = [];
    const byReason = new Map();
    dropReasons.forEach(d => {
        const reason = (d && d.reason) || 'unsupported';
        if (!byReason.has(reason)) {
            byReason.set(reason, { count: 0, details: [] });
            order.push(reason);
        }
        const entry = byReason.get(reason);
        entry.count += 1;
        if (d && d.detail) entry.details.push(String(d.detail));
    });

    return order.map(reason => {
        const { count, details } = byReason.get(reason);
        const uniq = [...new Set(details)];
        switch (reason) {
            case 'unmatched-name':
                // Naming the player is the whole point — it's the difference
                // between "check your roster" and "guess".
                return uniq.length
                    ? `${uniq.map(d => `"${d}"`).join(', ')} ${uniq.length === 1 ? 'is' : 'are'} not on the field`
                    : `${count} name${count === 1 ? '' : 's'} not on the field`;
            case 'incomplete':
                return uniq.length
                    ? uniq.join('; ')
                    : `${count} incomplete event${count === 1 ? '' : 's'}`;
            case 'duplicate-pull':
                return 'the pull was already recorded';
            default:
                return uniq.length
                    ? `unsupported event${count === 1 ? '' : 's'} (${uniq.join(', ')})`
                    : `${count} event${count === 1 ? '' : 's'} could not be recorded`;
        }
    }).join('; ');
}

export { summarizeDrops };
