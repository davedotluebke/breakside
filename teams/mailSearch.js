/**
 * Search on the Email Lists screen: which directory rows match what the
 * coach typed, and how to show why.
 *
 * Pure: no DOM, unit-tested directly (tests/unit/mailSearch.test.mjs). The
 * screen (teamMail.js) feeds each row's searchable strings through
 * `matches()` and renders the visible ones through `highlight()`.
 *
 * Why this exists: a person's second address, a guardian found only by the
 * player they are linked to, a note — all render on a row that is named for
 * someone else, so in a directory of sixty people the only way to answer
 * "who is this address?" was to read every row. Every token of the query
 * must appear in at least one of a row's strings (so "gran dana" finds the
 * guardian Gran linked to Dana), case-insensitively, anywhere in the
 * string (so "eve" finds steve.r@example.org).
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Lowercased, whitespace-collapsed tokens of a query. Empty for a blank query. */
export function tokens(query) {
    return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when the query is one email address (trailing/leading space tolerated). */
export function looksLikeAddress(query) {
    const q = String(query ?? '').trim().toLowerCase();
    return EMAIL_RE.test(q);
}

/**
 * Does a row match? `fields` are the row's searchable strings (name,
 * addresses, player names, notes...). Every token must appear in some field.
 * A blank query matches everything.
 */
export function matches(fields, query) {
    const toks = tokens(query);
    if (!toks.length) return true;
    const haystack = (fields || []).filter(f => typeof f === 'string' && f).map(f => f.toLowerCase());
    return toks.every(tok => haystack.some(f => f.includes(tok)));
}

/** The searchable strings of a directory contact (parent, manager, coach, other). */
export function contactFields(contact, roster = [], kindLabel = '') {
    const playerNames = (contact.playerIds || []).map(id => roster.find(p => p.id === id)?.name || id);
    const emails = Array.isArray(contact.emails) && contact.emails.length ? contact.emails : [contact.email];
    return [contact.name, ...emails, ...playerNames, kindLabel, contact.notes].filter(Boolean);
}

/** The searchable strings of a player-address row. */
export function playerFields(player, contact, guardianNames = []) {
    const emails = contact ? (Array.isArray(contact.emails) && contact.emails.length ? contact.emails : [contact.email]) : [];
    return [player.name, player.alias, player.address, contact?.alias, ...emails, ...guardianNames].filter(Boolean);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * HTML for `text` with every occurrence of every query token wrapped in
 * `<mark class="mail-hit">`. Overlapping or adjacent hits merge into one
 * mark. The output is escaped; pass raw text, not HTML.
 */
export function highlight(text, query) {
    const raw = String(text ?? '');
    const toks = tokens(query);
    if (!raw || !toks.length) return escapeHtml(raw);
    const lower = raw.toLowerCase();
    const hit = new Array(raw.length).fill(false);
    let any = false;
    for (const tok of toks) {
        let from = 0;
        for (;;) {
            const at = lower.indexOf(tok, from);
            if (at < 0) break;
            for (let i = at; i < at + tok.length; i++) hit[i] = true;
            any = true;
            from = at + 1;
        }
    }
    if (!any) return escapeHtml(raw);
    let out = '';
    let i = 0;
    while (i < raw.length) {
        const j = i;
        while (i < raw.length && hit[i] === hit[j]) i++;
        const chunk = escapeHtml(raw.slice(j, i));
        out += hit[j] ? `<mark class="mail-hit">${chunk}</mark>` : chunk;
    }
    return out;
}

/** "Everyone, Parents and Keelan's address" from a list of labels. */
export function joinLabels(labels) {
    const list = (labels || []).filter(Boolean);
    if (list.length <= 1) return list.join('');
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
