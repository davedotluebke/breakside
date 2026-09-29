/*
 * Collapsible groups on the teams screen — which of them are open.
 *
 * A team card lists its events, its Scrimmages group and, inside that, one
 * sub-card per scrimmage. Each is a collapsible group. What starts open:
 * every group with a game being coached right now, and the most recent
 * group; everything else starts collapsed, so a season of events reads as
 * one line each with the current one open. Once the coach has toggled a
 * group, that choice holds for the rest of the session — the list redraws
 * every few seconds, and a card that snapped shut under a finger would be
 * worse than no default at all. Same contract as the team cards' own
 * expand state in teams/teamList.js (`_expandedTeams`).
 *
 * Pure: the state is a Map handed in and returned, never module state, so
 * tests/unit/teamListGroups.test.mjs can pin the rule.
 */

/**
 * @typedef {{key: string, sortTs: number, active?: boolean}} GroupSpec
 *   key: unique across the whole list (team id plus event or scrimmage id);
 *   sortTs: the group's most recent activity, epoch ms (0 for none);
 *   active: a game in the group has a coach in it right now.
 */

/**
 * The keys that should start open among `groups`: each active one, plus the
 * most recent one (the first given, when several tie).
 * @param {GroupSpec[]} groups
 * @returns {Set<string>}
 */
export function defaultOpenKeys(groups) {
    const open = new Set();
    let newest = null;
    for (const g of groups || []) {
        if (!g || !g.key) continue;
        if (g.active) open.add(g.key);
        const ts = Number(g.sortTs) || 0;
        if (!newest || ts > newest.ts) newest = { key: g.key, ts };
    }
    if (newest) open.add(newest.key);
    return open;
}

/**
 * Seed `states` (key → open) with a default for every group it has not seen
 * yet, leaving the coach's own choices alone. Returns a new Map.
 *
 * Defaults are judged over the whole list each time, so a group that appears
 * later (an event created mid-session, a scrimmage another coach started)
 * starts open when it is the newest — and the group that was open until then
 * stays open, because that state is the coach's now.
 * @param {Map<string, boolean>|null|undefined} states
 * @param {GroupSpec[]} groups
 * @returns {Map<string, boolean>}
 */
export function seedGroupStates(states, groups) {
    const next = new Map(states || []);
    const defaults = defaultOpenKeys(groups);
    for (const g of groups || []) {
        if (g && g.key && !next.has(g.key)) next.set(g.key, defaults.has(g.key));
    }
    return next;
}

/** Whether a seeded group is open. An unseeded key reads as closed. */
export function isGroupOpen(states, key) {
    return states instanceof Map && states.get(key) === true;
}

/** Record the coach's choice for one group. Returns a new Map. */
export function setGroupOpen(states, key, open) {
    const next = new Map(states || []);
    if (key) next.set(key, !!open);
    return next;
}
