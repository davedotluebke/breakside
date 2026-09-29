/*
 * Line-tab roster sort — the tap cycle and ordering behind the sort icons
 * next to "Player" and the Game/Event/Total label in the Select Line table.
 * Pure (no DOM): game/selectLine.js owns the state and the rendering.
 *
 * State is { key, dir } with key null (default order), 'name' or 'time', and
 * dir 'asc' | 'desc'. Each icon cycles its own key: asc → desc → default.
 * Tapping the other icon starts that key at asc.
 */

const DEFAULT_ROSTER_SORT = Object.freeze({ key: null, dir: 'asc' });

/**
 * Next sort state after tapping the icon for `key`.
 * @param {{key: string|null, dir: string}} state
 * @param {'name'|'time'} key
 * @returns {{key: string|null, dir: string}}
 */
function nextRosterSort(state, key) {
    if (!state || state.key !== key) return { key, dir: 'asc' };
    if (state.dir === 'asc') return { key, dir: 'desc' };
    return { ...DEFAULT_ROSTER_SORT };
}

/**
 * Sort a roster copy by the given state. Name sorts compare player names;
 * time sorts compare `timeOf(player)` (whatever the time column shows), with
 * equal times ordered by name ascending in either direction. The default
 * state uses `defaultCompare` unchanged.
 * @param {Array} roster
 * @param {{key: string|null, dir: string}} state
 * @param {{defaultCompare: function, timeOf: function}} fns
 * @returns {Array}
 */
function sortLineRoster(roster, state, { defaultCompare, timeOf }) {
    const out = [...roster];
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    const sign = state && state.dir === 'desc' ? -1 : 1;
    if (state && state.key === 'name') {
        out.sort((a, b) => sign * byName(a, b));
    } else if (state && state.key === 'time') {
        const t = new Map(out.map(p => [p, timeOf(p) || 0]));
        out.sort((a, b) => (sign * (t.get(a) - t.get(b))) || byName(a, b));
    } else {
        out.sort(defaultCompare);
    }
    return out;
}

export { DEFAULT_ROSTER_SORT, nextRosterSort, sortLineRoster };
