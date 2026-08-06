/*
 * Stats detail level — how many columns the roster/stats tables (and the xlsx
 * exports built from them) show.
 *
 *   basic     Pts / Time / Goals / Assists only — the numbers everyone reads.
 *   advanced  Everything the tables historically showed (HA, Comp%, Ds, TOs, +/-…).
 *   full      Adds the raw counts behind the rates: Throws (before Comp%),
 *             Throwaways + Drops (after TOs), and pull volume + quality at the
 *             very end of the table.
 *
 * The choice is shared by the team roster and event roster screens and
 * persisted in localStorage, so it survives navigation and reloads. The xlsx
 * exports read the same setting at export time, so the workbook carries
 * whatever columns the coach was looking at.
 */

const StatsLevel = {
    BASIC: 'basic',
    ADVANCED: 'advanced',
    FULL: 'full'
};

// Ordered widest-last; a column tagged with level L shows when the selected
// level's rank is >= L's rank.
const LEVEL_RANK = {
    [StatsLevel.BASIC]: 0,
    [StatsLevel.ADVANCED]: 1,
    [StatsLevel.FULL]: 2
};

const STORAGE_KEY = 'rosterStatsLevel';

let statsLevel = (function () {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && LEVEL_RANK[saved] !== undefined) return saved;
    } catch (e) { /* localStorage unavailable */ }
    return StatsLevel.ADVANCED;   // what the tables showed before the setting existed
})();

/** The active stats level ('basic' | 'advanced' | 'full'). */
function getStatsLevel() {
    return statsLevel;
}

/** Set the active stats level and persist it. Unknown values are ignored. */
function setStatsLevel(level) {
    if (LEVEL_RANK[level] === undefined) return;
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
 */
function wireStatsLevelSelect(select, onChange) {
    if (!select) return;
    if (!select.options.length) {
        [
            { value: StatsLevel.BASIC, label: 'Basic' },
            { value: StatsLevel.ADVANCED, label: 'Advanced' },
            { value: StatsLevel.FULL, label: 'Full' }
        ].forEach(({ value, label }) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            select.appendChild(opt);
        });
    }
    select.value = statsLevel;
    select.onchange = () => {
        setStatsLevel(select.value);
        if (typeof onChange === 'function') onChange(statsLevel);
    };
}

// --- ES-module exports ---
export {
    StatsLevel,
    getStatsLevel,
    setStatsLevel,
    levelIncludes,
    columnsForLevel,
    wireStatsLevelSelect
};
