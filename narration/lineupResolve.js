/*
 * Lineup narration — pure resolution helpers.
 *
 * Maps the backend's returned lineup (player-name strings from
 * /api/narration/lineup) onto roster Player objects, and builds the
 * user-facing toast summary. Kept free of any browser or app-module
 * dependency so tests/unit/lineupResolve.test.mjs can import it under
 * plain node.
 */

/**
 * Normalize a name for digits-tolerant comparison: some rosters embed the
 * jersey number in the name string itself ("Jamal 23", "23 Jamal",
 * "Jamal #23"), and the model tends to return the cleaned-up name even
 * when told not to. Strips digits and decoration characters, collapses
 * whitespace, lowercases.
 * @param {string} s
 * @returns {string}
 */
function normalizeName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/["\u2018\u2019\u201c\u201d'][^"\u2018\u2019\u201c\u201d']*["\u2018\u2019\u201c\u201d']/g, ' ')
        .replace(/[0-9#()\[\].,_'"-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Match one returned name against the roster.
 * Tiers: exact name → case-insensitive name → case-insensitive nickname →
 * UNIQUE normalized-name match (absorbs embedded jersey numbers on either
 * side; ambiguity — two roster names normalizing identically — does not
 * match, so "Jamal 23" vs "Jamal 40" still requires the exact spelling).
 * @param {string} returnedName
 * @param {Array<{name: string, nickname?: string}>} roster
 * @returns {object|null} The roster player, or null
 */
function matchRosterPlayer(returnedName, roster) {
    if (!returnedName || !roster || !roster.length) return null;
    const wanted = String(returnedName).trim();
    if (!wanted) return null;

    for (const p of roster) {
        if (p.name === wanted) return p;
    }
    const lower = wanted.toLowerCase();
    for (const p of roster) {
        if (p.name && p.name.toLowerCase() === lower) return p;
    }
    for (const p of roster) {
        if (p.nickname && String(p.nickname).toLowerCase() === lower) return p;
    }
    const norm = normalizeName(wanted);
    if (norm) {
        const hits = roster.filter(p => normalizeName(p.name) === norm);
        if (hits.length === 1) return hits[0];
    }
    return null;
}

/**
 * Resolve the backend's players list to roster Player objects.
 * Dedupes (first mention wins); anything unmatchable lands in `unmatched`.
 * @param {string[]} returnedNames
 * @param {Array<{name: string, nickname?: string}>} roster
 * @returns {{ players: object[], unmatched: string[] }}
 */
function resolveLineupPlayers(returnedNames, roster) {
    const players = [];
    const unmatched = [];
    const seen = new Set();
    for (const name of (returnedNames || [])) {
        const player = matchRosterPlayer(name, roster);
        if (!player) {
            unmatched.push(String(name));
            continue;
        }
        if (seen.has(player.name)) continue;
        seen.add(player.name);
        players.push(player);
    }
    return { players, unmatched };
}

/**
 * Short display form of a player name for toasts: the first token that
 * isn't just digits/decoration ("Jamal 23" → "Jamal", "23 Jamal" → "Jamal").
 * Falls back to the raw name when every token is decoration.
 * @param {string} name
 * @returns {string}
 */
function displayFirstName(name) {
    const tokens = String(name || '').split(/\s+/);
    for (const t of tokens) {
        if (normalizeName(t)) return t;
    }
    return String(name || '');
}

/**
 * Build the toast shown after a voice action changes the line. Short by
 * design — a coach reads this in a glance on a sideline:
 *   "7/7 selected. Added: Cyrus, Max"
 *   "5/7 selected. Added: Priya"
 *   "7/7 selected. Added: Cyrus. Off: Nate"
 *   "6/7 selected. No match: \"Sirius\""
 * Success only when the count matches expectations and nothing failed to
 * match; anything else is a warning so the coach glances at the list.
 * @param {{ selectedCount: number, expectedCount: number,
 *           added?: string[], removed?: string[], unmatched?: string[] }} args
 *   added/removed/unmatched are display-ready name strings.
 * @returns {{ message: string, type: 'success'|'warning' }}
 */
function buildLineupToast({ selectedCount, expectedCount, added = [], removed = [], unmatched = [] }) {
    const parts = [`${selectedCount}/${expectedCount} selected`];
    if (added.length) parts.push(`Added: ${added.join(', ')}`);
    if (removed.length) parts.push(`Off: ${removed.join(', ')}`);
    if (unmatched.length) {
        const shown = unmatched.slice(0, 3).map(u => `"${u}"`).join(', ');
        parts.push(`No match: ${shown}${unmatched.length > 3 ? ', …' : ''}`);
    }
    const clean = selectedCount === expectedCount && unmatched.length === 0;
    return { message: parts.join('. '), type: clean ? 'success' : 'warning' };
}

export {
    normalizeName, matchRosterPlayer, resolveLineupPlayers,
    displayFirstName, buildLineupToast,
};
