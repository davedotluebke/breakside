/*
 * Teams-screen arrangement: which teams are pinned (and in what order) and
 * when each team was last opened on this device.
 *
 * The teams list shows pinned teams first, then everything else by when it
 * was last opened, newest first. Both facts are per device, not per account.
 * They live in localStorage under TEAM_LIST_PREFS_KEY and are wiped with the
 * rest of a coach's local data at sign-out (auth/auth.js LOCAL_DATA_KEYS):
 * team ids embed team names, and the sign-out wipe promises the next coach
 * on a shared tablet sees none of the previous one's.
 *
 * Pure leaf module (no DOM, no imports; storage is injected) so the ordering
 * rules can be pinned in tests/unit/teamListPrefs.test.mjs. Every function
 * here returns a new prefs object rather than mutating its argument.
 *
 * Stored shape:
 *   {
 *     pinned: ['Alice-7f3a', ...],                  // display order, top first
 *     lastViewed: { 'Alice-7f3a': 1757000000000 },  // epoch ms
 *   }
 */

export const TEAM_LIST_PREFS_KEY = 'breakside_team_list_prefs';

export function emptyTeamListPrefs() {
    return { pinned: [], lastViewed: {} };
}

/**
 * Coerce whatever was stored into a well-formed prefs object. Anything that
 * is not a string id or a positive finite timestamp is dropped rather than
 * allowed to reach the sort: a bad value here would take the whole teams
 * screen down with it.
 */
export function normalizeTeamListPrefs(raw) {
    const prefs = emptyTeamListPrefs();
    if (!raw || typeof raw !== 'object') return prefs;

    if (Array.isArray(raw.pinned)) {
        for (const id of raw.pinned) {
            if (typeof id === 'string' && id && !prefs.pinned.includes(id)) {
                prefs.pinned.push(id);
            }
        }
    }
    const viewed = raw.lastViewed;
    if (viewed && typeof viewed === 'object' && !Array.isArray(viewed)) {
        for (const [id, ts] of Object.entries(viewed)) {
            if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
                prefs.lastViewed[id] = ts;
            }
        }
    }
    return prefs;
}

/**
 * @param {Storage} storage - localStorage, or any getItem/setItem pair.
 * @returns {{pinned: string[], lastViewed: Object<string, number>}}
 */
export function readTeamListPrefs(storage) {
    try {
        const raw = storage.getItem(TEAM_LIST_PREFS_KEY);
        if (raw === null || raw === undefined) return emptyTeamListPrefs();
        return normalizeTeamListPrefs(JSON.parse(raw));
    } catch (e) {
        // Unparseable, or storage unavailable: behave as if nothing was saved.
        return emptyTeamListPrefs();
    }
}

/**
 * @returns {boolean} whether the write landed. A failure (quota, a locked-down
 * browser) costs one lost pin, not a broken screen.
 */
export function writeTeamListPrefs(storage, prefs) {
    try {
        storage.setItem(TEAM_LIST_PREFS_KEY, JSON.stringify(normalizeTeamListPrefs(prefs)));
        return true;
    } catch (e) {
        return false;
    }
}

export function isTeamPinned(prefs, teamId) {
    return !!teamId && Array.isArray(prefs?.pinned) && prefs.pinned.includes(teamId);
}

/**
 * Pin a team, placing it at the TOP of the pinned group. Pinning an already
 * pinned team moves it to the top. That is the only way to order the group
 * (unpin, then pin in the wanted sequence), and it is deliberate: no drag
 * affordance for now. See TODO.md § UI/UX.
 */
export function pinTeam(prefs, teamId) {
    const base = normalizeTeamListPrefs(prefs);
    if (!teamId) return base;
    return {
        ...base,
        pinned: [teamId, ...base.pinned.filter(id => id !== teamId)],
    };
}

export function unpinTeam(prefs, teamId) {
    const base = normalizeTeamListPrefs(prefs);
    return { ...base, pinned: base.pinned.filter(id => id !== teamId) };
}

/**
 * Record that the coach opened a team (roster, settings, a game, ...).
 *
 * Only navigation INTO a team counts, never expanding its card on the list:
 * the list redraws every few seconds, and a team that jumped to the top while
 * its card was being read would be worse than no ordering at all.
 */
export function markTeamViewed(prefs, teamId, now = Date.now()) {
    const base = normalizeTeamListPrefs(prefs);
    if (!teamId) return base;
    return { ...base, lastViewed: { ...base.lastViewed, [teamId]: now } };
}

/**
 * Arrange the team list into its two groups.
 *
 * Pinned teams come in pinned order (most recently pinned first). The rest
 * are ordered by when they were last opened on this device, newest first.
 * Teams never opened here (every team, the day this shipped) fall back to the
 * rule that preceded this one, most recent game first, and then to name, so
 * the order is stable from one redraw to the next.
 *
 * @param {Array<{team: {id: string, name: string}}>} userTeams - entries as
 *   /api/auth/teams returns them (or as store/localTeamView.js reshapes them)
 * @param {object} prefs - from readTeamListPrefs()
 * @param {(teamId: string) => number} [recentActivity] - fallback timestamp
 *   per team (epoch ms; 0 for none)
 * @returns {{pinned: Array, others: Array}} the same entry objects, arranged
 */
export function arrangeTeams(userTeams, prefs, recentActivity = () => 0) {
    const base = normalizeTeamListPrefs(prefs);
    const entries = (Array.isArray(userTeams) ? userTeams : []).filter(e => e?.team?.id);
    const byId = new Map(entries.map(e => [e.team.id, e]));

    // A pinned id with no team in the list (erased, left) is skipped, not
    // scrubbed: it costs nothing, and a team joined again comes back pinned.
    const pinned = base.pinned.map(id => byId.get(id)).filter(Boolean);
    const pinnedIds = new Set(pinned.map(e => e.team.id));

    const others = entries
        .filter(e => !pinnedIds.has(e.team.id))
        .map(e => ({
            entry: e,
            viewed: base.lastViewed[e.team.id] || 0,
            activity: Number(recentActivity(e.team.id)) || 0,
            name: String(e.team.name || ''),
        }))
        .sort((a, b) =>
            (b.viewed - a.viewed) ||
            (b.activity - a.activity) ||
            a.name.localeCompare(b.name) ||
            a.entry.team.id.localeCompare(b.entry.team.id))
        .map(x => x.entry);

    return { pinned, others };
}
