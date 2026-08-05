/*
 * XLSX export helpers (powered by SheetJS, vendored in vendor/xlsx.mini.min.js)
 *
 * Shared between Game Summary, Event Roster, and Team Roster exports.
 * Builds player-stats sheets as 2D arrays, then converts to a SheetJS
 * worksheet so number/time types survive Excel's type detection.
 */

import { formatTeamStatsLine, sumPlayerStats } from './eventStats.js';
import { getStatsLevel, columnsForLevel, StatsLevel } from './statsLevel.js';

/*
 * Column descriptors, in sheet order. `level` mirrors the on-screen stats
 * menu (see utils/statsLevel.js) — columns with no level always export.
 * `width` feeds !cols; `fmt` drives the Excel number format ('pct', 'dec2').
 * `value(ps)` pulls the cell out of an accumulateGameStats stats object.
 */
const STATS_COLUMN_SPECS = [
    { label: 'Name',       width: 22, value: (ps, name) => name },
    { label: 'Pts',        width: 6,  level: StatsLevel.BASIC,    value: ps => ps.pointsPlayed || 0 },
    { label: 'Minutes',    width: 9,  level: StatsLevel.BASIC,    fmt: 'dec2',
      value: ps => (ps.timePlayed || 0) > 0 ? +((ps.timePlayed || 0) / 60000).toFixed(2) : 0 },
    { label: 'Goals',      width: 7,  level: StatsLevel.BASIC,    value: ps => ps.goals || 0 },
    { label: 'Assists',    width: 8,  level: StatsLevel.BASIC,    value: ps => ps.assists || 0 },
    { label: 'HA',         width: 5,  level: StatsLevel.ADVANCED, value: ps => ps.hockeyAssists || 0 },
    { label: 'Huck HA',    width: 9,  level: StatsLevel.ADVANCED, value: ps => ps.huckHockeyAssists || 0 },
    { label: 'Throws',     width: 8,  level: StatsLevel.FULL,     value: ps => ps.totalThrows || 0 },
    { label: 'Comp%',      width: 8,  level: StatsLevel.ADVANCED, fmt: 'pct',
      value: ps => (ps.totalThrows || 0) > 0 ? +((ps.completions || 0) / ps.totalThrows).toFixed(4) : null },
    { label: 'Huck%',      width: 8,  level: StatsLevel.ADVANCED, fmt: 'pct',
      value: ps => (ps.totalHucks || 0) > 0 ? +((ps.huckCompletions || 0) / ps.totalHucks).toFixed(4) : null },
    { label: 'Ds',         width: 5,  level: StatsLevel.ADVANCED, value: ps => ps.dPlays || 0 },
    { label: 'TOs',        width: 5,  level: StatsLevel.ADVANCED, value: ps => ps.turnovers || 0 },
    { label: 'Throwaways', width: 11, level: StatsLevel.FULL,     value: ps => ps.throwaways || 0 },
    { label: 'Drops',      width: 7,  level: StatsLevel.FULL,     value: ps => ps.drops || 0 },
    { label: '+/-',        width: 6,  level: StatsLevel.ADVANCED, value: ps => ps.plusMinus || 0 },
    { label: '+/- per pt', width: 11, level: StatsLevel.ADVANCED,
      value: ps => (ps.pointsPlayed || 0) > 0 ? +((ps.plusMinus || 0) / ps.pointsPlayed).toFixed(3) : 0 },
    { label: 'Pulls',      width: 7,  level: StatsLevel.FULL,     value: ps => ps.pulls || 0 },
    { label: 'Good',       width: 6,  level: StatsLevel.FULL,     value: ps => ps.pullsGood || 0 },
    { label: 'Okay',       width: 6,  level: StatsLevel.FULL,     value: ps => ps.pullsOkay || 0 },
    { label: 'Poor',       width: 6,  level: StatsLevel.FULL,     value: ps => ps.pullsPoor || 0 },
    { label: 'Brick',      width: 6,  level: StatsLevel.FULL,     value: ps => ps.pullsBrick || 0 }
];

/** The column specs a sheet exports, honouring the active stats level. */
function statsColumnsFor(level) {
    return columnsForLevel(STATS_COLUMN_SPECS, level || getStatsLevel());
}

/**
 * Build one row of player stats from the ps object (output of
 * accumulateGameStats). Returns an array aligned with `cols`.
 */
function buildPlayerStatsRow(playerName, ps, cols) {
    return cols.map(col => col.value(ps, playerName));
}

/**
 * Aggregate a totals row from an array of ps objects.
 */
function aggregateTotalsRow(label, perPlayerPs, cols) {
    return buildPlayerStatsRow(label, sumPlayerStats(perPlayerPs), cols);
}

/**
 * Build a 2D array for one stats sheet: header row, one row per player,
 * Team aggregate row, optional blank + footer block (e.g., team-stats line).
 *
 * @param {Array<object>} players - roster: {id, name, gender?, number?}
 * @param {object} playerStats - map of playerId → ps
 * @param {object} [teamStats] - output of getGameTeamStats (drives footer)
 * @param {object} [opts]
 * @param {string} [opts.titleRow] - optional title above the table
 * @param {string} [opts.level] - stats level ('basic'|'advanced'|'full');
 *   defaults to whatever the roster screens' Stats menu is set to
 * @returns {{aoa: Array<Array>, autofilterRef: string, cols: Array<object>}}
 *   the 2D array, the A1-style range covering the header row + player rows (so
 *   the caller can scope an AutoFilter to just the sortable table, excluding
 *   the title above and the Team total + footer below), and the column specs
 *   the sheet was built from.
 */
function buildStatsSheetAoA(players, playerStats, teamStats, opts = {}) {
    const cols = statsColumnsFor(opts.level);
    const aoa = [];
    if (opts.titleRow) aoa.push([opts.titleRow]);

    const headerRowIdx = aoa.length;   // 0-based row of the column headers
    aoa.push(cols.map(c => c.label));

    const psList = [];
    players.forEach(p => {
        const ps = playerStats[p.id] || {};
        psList.push(ps);
        aoa.push(buildPlayerStatsRow(p.name, ps, cols));
    });
    const lastPlayerRowIdx = aoa.length - 1; // 0-based; == headerRowIdx if no players

    // Team aggregate row (kept OUTSIDE the autofilter range so it stays put
    // when the user sorts the player rows)
    aoa.push(aggregateTotalsRow('Team', psList, cols));

    // Team-stats footer (breaks/holds)
    if (teamStats && teamStats.total > 0) {
        aoa.push([]); // blank row
        if (typeof formatTeamStatsLine === 'function') {
            const lines = formatTeamStatsLine(teamStats).split('\n');
            lines.forEach(line => aoa.push([line]));
        }
    }

    // XLSX: classic vendor script global (vendor/xlsx.mini.min.js)
    const autofilterRef = XLSX.utils.encode_range(
        { r: headerRowIdx, c: 0 },
        { r: Math.max(lastPlayerRowIdx, headerRowIdx), c: cols.length - 1 }
    );
    return { aoa, autofilterRef, cols };
}

/**
 * Convert a stats sheet to a SheetJS worksheet with sensible column widths,
 * percentage formatting on Comp%/Huck%, decimal Minutes, and an AutoFilter
 * scoped to the player table so column headers get click-to-sort dropdowns.
 * @param {{aoa: Array<Array>, autofilterRef?: string, cols?: Array<object>} | Array<Array>} sheet
 *   Either the object returned by buildStatsSheetAoA, or a bare 2D array.
 */
function aoaToFormattedSheet(sheet) {
    const aoa = Array.isArray(sheet) ? sheet : sheet.aoa;
    const autofilterRef = Array.isArray(sheet) ? null : sheet.autofilterRef;
    // Bare-array callers get the current level's columns; the shapes match
    // because that's what buildStatsSheetAoA would have produced.
    const cols = (Array.isArray(sheet) ? null : sheet.cols) || statsColumnsFor();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Column widths, straight off the column specs
    ws['!cols'] = cols.map(c => ({ wch: c.width }));
    // Number formats — which letters those are depends on the stats level, so
    // derive the column letters instead of hard-coding them.
    const fmtByLetter = {};
    cols.forEach((c, i) => {
        if (c.fmt) fmtByLetter[XLSX.utils.encode_col(i)] = (c.fmt === 'pct' ? '0%' : '0.00');
    });
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
        Object.keys(fmtByLetter).forEach(col => {
            const cell = ws[`${col}${R + 1}`];
            if (cell && typeof cell.v === 'number') {
                cell.t = 'n';
                cell.z = fmtByLetter[col];
            }
        });
    }
    // AutoFilter on the header+player rows → per-column sort/filter dropdowns,
    // scoped so the title row and Team total + footer stay out of the sort.
    if (autofilterRef) {
        ws['!autofilter'] = { ref: autofilterRef };
    }
    return ws;
}

/**
 * Trigger a download of the given SheetJS workbook with the given filename.
 */
function downloadWorkbook(wb, filename) {
    XLSX.writeFile(wb, filename, { compression: true });
}

/**
 * Sanitize a name into a sheet tab name (Excel max 31 chars, no []*?/\:).
 */
function safeSheetName(name) {
    return (name || 'Sheet').replace(/[\[\]\*\?\/\\:]/g, '').slice(0, 31) || 'Sheet';
}

/**
 * safeSheetName plus de-duplication — Excel rejects a workbook with two tabs
 * of the same name, and per-game tabs ("v. Storm") repeat whenever a team
 * plays the same opponent twice in an event.
 * @param {string} name
 * @param {Set<string>} used - names already claimed; the result is added to it
 */
function uniqueSheetName(name, used) {
    const base = safeSheetName(name);
    if (!used.has(base)) { used.add(base); return base; }
    for (let n = 2; n < 100; n++) {
        const suffix = ` (${n})`;
        const candidate = base.slice(0, 31 - suffix.length) + suffix;
        if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
    used.add(base);
    return base;
}

/**
 * Sanitize a string for use in a filename.
 */
function safeFilename(name) {
    return (name || 'export').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-');
}

// --- ES-module exports ---
export {
    buildStatsSheetAoA,
    aoaToFormattedSheet,
    downloadWorkbook,
    safeSheetName,
    uniqueSheetName,
    safeFilename
};
