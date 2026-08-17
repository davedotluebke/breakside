/*
 * XLSX export helpers (powered by SheetJS, vendored in vendor/xlsx.mini.min.js)
 *
 * Shared between Game Summary, Event Roster, and Team Roster exports.
 * Builds player-stats sheets as 2D arrays, then converts to a SheetJS
 * worksheet so number/time types survive Excel's type detection.
 */

import { formatTeamStatsLine, sumPlayerStats } from './eventStats.js';
import { getStatsLevel } from './statsLevel.js';
import { sheetStatsColumns } from './statsColumns.js';

/**
 * The column specs a sheet exports, honouring the active stats level. The
 * specs themselves live in utils/statsColumns.js beside the on-screen column
 * list, so the two can't drift unnoticed.
 */
function statsColumnsFor(level) {
    return sheetStatsColumns(level || getStatsLevel());
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
