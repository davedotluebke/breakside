/*
 * "Who is this spreadsheet for?" — the menu beside each Export button.
 *
 * Default is "All players", which exports the table as shown. Picking one
 * player narrows every sheet in the workbook to that player's row, while the
 * Team total row and the breaks/holds footer still describe the whole team.
 *
 * The point is privacy, not brevity: a coach can hand a player (or a parent)
 * their own numbers in team context without also handing over everyone else's
 * playing time and error counts, which is what invites comparison.
 *
 * All three export screens (Review, Event Roster + Stats, Team Roster + Stats)
 * wire the same calls: wireExportPlayerSelect on render, exportSelection at
 * export time to get the rows, then exportTitle / exportFilename to name them.
 */
import { formatPlayerName } from '../utils/helpers.js';

const ALL_PLAYERS = '';

/**
 * Populate (or refresh) an export player menu. Safe to call on every render:
 * the current pick survives as long as that player is still listed, and falls
 * back to "All players" when they aren't (roster edit, filter change, …).
 * @param {HTMLSelectElement} select
 * @param {Array<object>} players - the roster the Export button would write
 */
function wireExportPlayerSelect(select, players) {
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = ALL_PLAYERS;
    allOpt.textContent = 'All players';
    select.appendChild(allOpt);

    (players || []).forEach(player => {
        if (!player || !player.id) return;
        const opt = document.createElement('option');
        opt.value = player.id;
        opt.textContent = formatPlayerName(player);
        select.appendChild(opt);
    });

    select.value = previous;
    if (select.selectedIndex < 0) select.value = ALL_PLAYERS;
}

/**
 * Resolve the menu to the rows an export should write.
 * @param {HTMLSelectElement} select
 * @param {Array<object>} players - the full roster for this export
 * @returns {{player: object|null, sheetPlayers: Array<object>, totalsPlayers: Array<object>}}
 *   `player` is null for "All players". `sheetPlayers` goes to
 *   buildStatsSheetAoA's first argument, `totalsPlayers` to opts.totalsPlayers
 *   — always the whole roster, so the Team row means the same thing either way.
 */
function exportSelection(select, players) {
    const roster = players || [];
    const id = select ? select.value : ALL_PLAYERS;
    const player = id ? roster.find(p => p && p.id === id) : null;
    return {
        player: player || null,
        sheetPlayers: player ? [player] : roster,
        totalsPlayers: roster
    };
}

/**
 * Prefix a sheet's title row with the chosen player, so each sheet of a
 * single-player workbook says whose numbers it holds. Kept separate from
 * exportFilename because a multi-sheet workbook titles every sheet but is
 * named once.
 * @param {object|null} player - exportSelection().player
 * @param {string} baseTitle - the title row an all-players export would use
 * @returns {string}
 */
function exportTitle(player, baseTitle) {
    return player ? `${formatPlayerName(player)} — ${baseTitle}` : baseTitle;
}

/**
 * The filename stem (before "-stats.xlsx"), prefixed with the chosen player so
 * a coach exporting several players in a row gets distinct downloads.
 * @param {object|null} player - exportSelection().player
 * @param {string} baseStem
 * @returns {string}
 */
function exportFilename(player, baseStem) {
    return player ? `${player.name}-${baseStem}` : baseStem;
}

// --- ES-module exports ---
export { wireExportPlayerSelect, exportSelection, exportTitle, exportFilename };
