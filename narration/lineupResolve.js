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
 * Match one returned name against the roster.
 * The backend prompt demands exact roster spellings, so exact match should
 * dominate; the case-insensitive name/nickname fallbacks absorb model slop.
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
 * Build the toast shown after a narrated lineup is applied.
 * Success only when the count matches expectations and nothing failed to
 * match — anything else is a warning so the coach glances at the list.
 * @param {{ appliedCount: number, expectedCount: number,
 *           unmatched?: string[], note?: string }} args
 * @returns {{ message: string, type: 'success'|'warning' }}
 */
function buildLineupToast({ appliedCount, expectedCount, unmatched = [], note = '' }) {
    let message = `Line set by voice: ${appliedCount}/${expectedCount}`;
    if (unmatched.length) {
        message += ` — couldn't match ${unmatched.map(u => `"${u}"`).join(', ')}`;
    }
    if (note) {
        message += ` — ${note}`;
    }
    const clean = appliedCount === expectedCount && unmatched.length === 0;
    return { message, type: clean ? 'success' : 'warning' };
}

export { matchRosterPlayer, resolveLineupPlayers, buildLineupToast };
