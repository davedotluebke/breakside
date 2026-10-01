/*
 * Stats detail level — how many columns the roster/stats tables (and the xlsx
 * exports built from them) show.
 *
 *   basic     Pts / Time / Goals / Assists only — the numbers everyone reads.
 *   advanced  Everything the tables historically showed (HA, Comp%, Ds, TOs, +/-…).
 *   full      Adds the raw counts behind the rates: Throws (before Comp%),
 *             Throwaways + Drops (after TOs), and pull volume + quality at the
 *             very end of the table.
 *   fun       Youth "shout-outs" (utils/funStats.js): who scored and assisted,
 *             then the top few in a handful of positive categories. No
 *             columns at all — no playing time, no points, nothing negative —
 *             so it sits outside the rank order and the tables drop to their
 *             identity columns while a Fun panel renders beside them. A team
 *             can make it the only level its viewers see (utils/statsAudience.js).
 *
 * The choice is shared by the team roster and event roster screens and
 * persisted in localStorage, so it survives navigation and reloads. The xlsx
 * exports read the same setting at export time, so the workbook carries
 * whatever columns the coach was looking at.
 */

const StatsLevel = {
    BASIC: 'basic',
    ADVANCED: 'advanced',
    FULL: 'full',
    FUN: 'fun'
};

// Ordered widest-last; a column tagged with level L shows when the selected
// level's rank is >= L's rank. Fun has no rank: it is not a wider or narrower
// table but a different view, and shows no tagged column.
const LEVEL_RANK = {
    [StatsLevel.BASIC]: 0,
    [StatsLevel.ADVANCED]: 1,
    [StatsLevel.FULL]: 2
};

const STORAGE_KEY = 'rosterStatsLevel';

let statsLevel = (function () {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (isKnownLevel(saved)) return saved;
    } catch (e) { /* localStorage unavailable */ }
    return StatsLevel.ADVANCED;   // what the tables showed before the setting existed
})();

function isKnownLevel(level) {
    return level === StatsLevel.FUN || LEVEL_RANK[level] !== undefined;
}

/** The menu, in order. Fun first: it is the gentlest. */
const LEVEL_OPTIONS = [
    { value: StatsLevel.FUN, label: 'Fun' },
    { value: StatsLevel.BASIC, label: 'Basic' },
    { value: StatsLevel.ADVANCED, label: 'Advanced' },
    { value: StatsLevel.FULL, label: 'Full' }
];

/**
 * The stats level this device has chosen ('fun' | 'basic' | 'advanced' |
 * 'full'). Screens should read utils/statsAudience.js activeStatsLevel()
 * instead, which applies a team's viewer restriction on top.
 */
function getStatsLevel() {
    return statsLevel;
}

/** Set the active stats level and persist it. Unknown values are ignored. */
function setStatsLevel(level) {
    if (!isKnownLevel(level)) return;
    statsLevel = level;
    try { localStorage.setItem(STORAGE_KEY, level); } catch (e) { /* ignore */ }
}

/**
 * Does the active level include a column tagged `columnLevel`?
 * Columns with no level (identity columns like Name) always show.
 * @param {string} [columnLevel]
 * @param {string} [level] - level to test against; defaults to the active one
 */
function levelIncludes(columnLevel, level = statsLevel) {
    if (!columnLevel) return true;
    if (level === StatsLevel.FUN) return false;
    return LEVEL_RANK[level] >= LEVEL_RANK[columnLevel];
}

/** Filter a column-descriptor array down to the columns the level shows. */
function columnsForLevel(columns, level = statsLevel) {
    return columns.filter(col => levelIncludes(col.level, level));
}

/**
 * Populate + wire a <select> as the stats-level menu. Safe to call on every
 * render — rebuilds the options and replaces the change handler.
 * @param {HTMLSelectElement} select
 * @param {Function} onChange - called after the level is set and persisted
 * @param {object} [opts]
 * @param {string} [opts.lockedTo] - show only this level, disabled: the
 *   viewer restriction (utils/statsAudience.js). The device's own choice is
 *   left alone, so it comes back on a team without the restriction.
 */
function wireStatsLevelSelect(select, onChange, { lockedTo = null } = {}) {
    if (!select) return;
    const options = lockedTo ? LEVEL_OPTIONS.filter(o => o.value === lockedTo) : LEVEL_OPTIONS;
    if (select.options.length !== options.length
            || options.some((o, i) => select.options[i].value !== o.value)) {
        select.innerHTML = '';
        options.forEach(({ value, label }) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            select.appendChild(opt);
        });
    }
    select.disabled = !!lockedTo;
    select.title = lockedTo ? `This team shows its viewers ${options[0]?.label || lockedTo} stats only` : '';
    select.value = lockedTo || statsLevel;
    select.onchange = () => {
        setStatsLevel(select.value);
        if (typeof onChange === 'function') onChange(statsLevel);
    };
}

// --- ES-module exports ---
export {
    StatsLevel,
    LEVEL_OPTIONS,
    getStatsLevel,
    setStatsLevel,
    levelIncludes,
    columnsForLevel,
    wireStatsLevelSelect
};
