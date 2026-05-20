/*
 * XLSX export helpers (powered by SheetJS, vendored in vendor/xlsx.mini.min.js)
 *
 * Shared between Game Summary, Event Roster, and Team Roster exports.
 * Builds player-stats sheets as 2D arrays, then converts to a SheetJS
 * worksheet so number/time types survive Excel's type detection.
 */

const STATS_COLUMNS = [
    'Name', 'Pts', 'Minutes', 'Goals', 'Assists', 'HA', 'Huck HA',
    'Comp%', 'Huck%', 'Ds', 'TOs', '+/-', '+/- per pt'
];

/**
 * Build one row of player stats from the ps object (output of
 * accumulateGameStats). Returns an array aligned with STATS_COLUMNS.
 */
function buildPlayerStatsRow(playerName, ps) {
    const pts = ps.pointsPlayed || 0;
    const totalThrows = ps.totalThrows || 0;
    const completions = ps.completions || 0;
    const totalHucks = ps.totalHucks || 0;
    const huckCompletions = ps.huckCompletions || 0;
    const pm = ps.plusMinus || 0;
    const timeMs = ps.timePlayed || 0;
    const minutes = timeMs > 0 ? +(timeMs / 60000).toFixed(2) : 0;
    const compPct = totalThrows > 0 ? +(completions / totalThrows).toFixed(4) : null;
    const huckPct = totalHucks > 0 ? +(huckCompletions / totalHucks).toFixed(4) : null;
    const pmPerPt = pts > 0 ? +(pm / pts).toFixed(3) : 0;
    return [
        playerName,
        pts,
        minutes,
        ps.goals || 0,
        ps.assists || 0,
        ps.hockeyAssists || 0,
        ps.huckHockeyAssists || 0,
        compPct,
        huckPct,
        ps.dPlays || 0,
        ps.turnovers || 0,
        pm,
        pmPerPt
    ];
}

/**
 * Aggregate a totals row from an array of ps objects.
 */
function aggregateTotalsRow(label, perPlayerPs) {
    const tot = {
        pointsPlayed: 0, timePlayed: 0, goals: 0, assists: 0,
        hockeyAssists: 0, huckHockeyAssists: 0,
        completions: 0, totalThrows: 0, huckCompletions: 0, totalHucks: 0,
        dPlays: 0, turnovers: 0, plusMinus: 0
    };
    perPlayerPs.forEach(ps => {
        tot.pointsPlayed += ps.pointsPlayed || 0;
        tot.timePlayed += ps.timePlayed || 0;
        tot.goals += ps.goals || 0;
        tot.assists += ps.assists || 0;
        tot.hockeyAssists += ps.hockeyAssists || 0;
        tot.huckHockeyAssists += ps.huckHockeyAssists || 0;
        tot.completions += ps.completions || 0;
        tot.totalThrows += ps.totalThrows || 0;
        tot.huckCompletions += ps.huckCompletions || 0;
        tot.totalHucks += ps.totalHucks || 0;
        tot.dPlays += ps.dPlays || 0;
        tot.turnovers += ps.turnovers || 0;
        tot.plusMinus += ps.plusMinus || 0;
    });
    return buildPlayerStatsRow(label, tot);
}

/**
 * Build a 2D array for one stats sheet: header row, one row per player,
 * Team aggregate row, optional blank + footer block (e.g., team-stats line).
 *
 * @param {Array<object>} players - roster: {name, gender?, number?}
 * @param {object} playerStats - map of playerName → ps
 * @param {object} [teamStats] - output of getGameTeamStats (drives footer)
 * @param {object} [opts]
 * @param {string} [opts.titleRow] - optional title above the table
 * @returns {Array<Array>} 2D array (Array of Arrays) for SheetJS aoa_to_sheet
 */
function buildStatsSheetAoA(players, playerStats, teamStats, opts = {}) {
    const aoa = [];
    if (opts.titleRow) aoa.push([opts.titleRow]);
    aoa.push(STATS_COLUMNS.slice());

    const psList = [];
    players.forEach(p => {
        const ps = playerStats[p.name] || {};
        psList.push(ps);
        aoa.push(buildPlayerStatsRow(p.name, ps));
    });

    // Team aggregate row
    aoa.push(aggregateTotalsRow('Team', psList));

    // Team-stats footer (breaks/holds)
    if (teamStats && teamStats.total > 0) {
        aoa.push([]); // blank row
        if (typeof formatTeamStatsLine === 'function') {
            const lines = formatTeamStatsLine(teamStats).split('\n');
            lines.forEach(line => aoa.push([line]));
        }
    }
    return aoa;
}

/**
 * Convert a 2D array to a SheetJS worksheet with sensible column widths
 * and percentage formatting on the Comp%/Huck% columns (indices 7, 8).
 */
function aoaToFormattedSheet(aoa) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Column widths
    ws['!cols'] = [
        {wch: 22}, // Name
        {wch: 6},  // Pts
        {wch: 9},  // Minutes
        {wch: 7},  // Goals
        {wch: 8},  // Assists
        {wch: 5},  // HA
        {wch: 9},  // Huck HA
        {wch: 8},  // Comp%
        {wch: 8},  // Huck%
        {wch: 5},  // Ds
        {wch: 5},  // TOs
        {wch: 6},  // +/-
        {wch: 11}  // +/- per pt
    ];
    // Format Comp% and Huck% as percentages (column indices 7, 8 → letters H, I)
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
        ['H', 'I'].forEach(col => {
            const cellRef = `${col}${R + 1}`;
            const cell = ws[cellRef];
            if (cell && typeof cell.v === 'number') {
                cell.t = 'n';
                cell.z = '0%';
            }
        });
        // Minutes column (C) as fixed decimal
        const minCell = ws[`C${R + 1}`];
        if (minCell && typeof minCell.v === 'number') {
            minCell.z = '0.00';
        }
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
 * Sanitize a string for use in a filename.
 */
function safeFilename(name) {
    return (name || 'export').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-');
}

window.buildStatsSheetAoA = buildStatsSheetAoA;
window.aoaToFormattedSheet = aoaToFormattedSheet;
window.downloadWorkbook = downloadWorkbook;
window.safeSheetName = safeSheetName;
window.safeFilename = safeFilename;
