/*
 * Game Summary / Review (from team list)
 * Shows a completed game's player stats table (sortable) and full event log.
 * Reuses the gameSummaryScreen section, adapting it for review from team list.
 *
 * The stats table is the same one the Event Roster + Stats screen renders:
 * both build their columns from utils/statsColumns.js and both honour the
 * Basic / Advanced / Full Stats menu, so reviewing one game and reviewing a
 * whole event show the same stats in the same order.
 */
import { Gender, Role } from '../store/models.js';
import { currentTeam } from '../store/storage.js';
import {
    currentGame, formatPlayerName, buildPointPlayerLookup,
} from '../utils/helpers.js';
import {
    getGamePlayerStats, getGameTeamStats, formatTeamStatsLine, classifyPoint,
    sumPlayerStats,
} from '../utils/eventStats.js';
import { buildGameLogEntries, renderGameLogEntriesHTML } from '../utils/gameLogRenderer.js';
import { createTableSortController } from '../utils/tableSort.js';
import { attachStatsColumnHelp } from '../utils/statsHelp.js';
import { wireStatsLevelSelect } from '../utils/statsLevel.js';
import { screenStatsColumns } from '../utils/statsColumns.js';
import { buildRosterRow } from './rosterRowHelpers.js';
import {
    wireExportPlayerSelect, exportSelection, exportTitle, exportFilename,
} from './exportPlayerPicker.js';
import {
    buildStatsSheetAoA, aoaToFormattedSheet, downloadWorkbook,
    safeSheetName, safeFilename,
} from '../utils/xlsxExport.js';
import { showScreen } from '../screens/navigation.js';
import { showShareGameDialog } from '../game/shareGame.js';

// Track where we came from so back button navigates correctly
let gameSummaryOrigin = 'teamRosterScreen'; // default for post-game flow
let gameSummarySortController = null;
let gameSummarySortState = null; // survives a Stats-level re-render, reset per game
let _lastRenderedGame = null; // the game currently shown on the summary screen

/**
 * Show game summary for a completed game loaded from the team list.
 * @param {object} game - Deserialized Game object (already loaded into currentTeam.games)
 */
function showGameSummaryFromList(game) {
    gameSummaryOrigin = 'selectTeamScreen';
    renderGameSummary(game);
}

/**
 * Show game summary after finishing a game (existing post-game flow).
 * (Replaced the old name-keyed updateGameSummaryRosterDisplay, since removed.)
 */
function showGameSummaryPostGame() {
    gameSummaryOrigin = 'teamRosterScreen';
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (game) renderGameSummary(game);
}

/**
 * Render the full game summary: score, stats table, event log.
 */
function renderGameSummary(game) {
    if (!game) return;
    _lastRenderedGame = game;

    // Detach previous sort controller; a new game starts unsorted.
    if (gameSummarySortController) {
        gameSummarySortController.detach();
        gameSummarySortController = null;
    }
    gameSummarySortState = null;

    // Score header
    const teamNameEl = document.getElementById('teamName');
    const oppNameEl = document.getElementById('opponentName');
    const teamScoreEl = document.getElementById('teamFinalScore');
    const oppScoreEl = document.getElementById('opponentFinalScore');
    if (teamNameEl) teamNameEl.textContent = game.team || 'My Team';
    if (oppNameEl) oppNameEl.textContent = game.opponent || 'Opponent';
    if (teamScoreEl) teamScoreEl.textContent = game.scores?.[Role.TEAM] || game.scores?.team || 0;
    if (oppScoreEl) oppScoreEl.textContent = game.scores?.[Role.OPPONENT] || game.scores?.opponent || 0;

    // Hide/show footer buttons based on origin
    const anotherGameBtn = document.getElementById('anotherGameBtn');
    if (anotherGameBtn) {
        anotherGameBtn.style.display = gameSummaryOrigin === 'selectTeamScreen' ? 'none' : '';
    }

    renderGameSummaryStatsTable(game);
    renderGameSummaryTeamStats(game);
    renderGameSummaryEventLog(game);

    // Show the export button (and its player menu) if there are stats
    const exportBtn = document.getElementById('exportGameSummaryBtn');
    const exportPlayerGroup = document.getElementById('gameSummaryExportGroup');
    const hasStats = !!(game.points && game.points.some(p => p.winner));
    if (exportBtn) exportBtn.style.display = hasStats ? '' : 'none';
    if (exportPlayerGroup) exportPlayerGroup.style.display = hasStats ? '' : 'none';

    // Share button: any game with a server id can be shared (the dialog
    // handles the never-synced case with a friendly nudge).
    const shareBtn = document.getElementById('shareGameSummaryBtn');
    if (shareBtn) {
        shareBtn.style.display = game.id ? '' : 'none';
    }

    showScreen('gameSummaryScreen');
}

/**
 * Build the sortable player stats table for a single game. Columns follow the
 * Stats menu (Basic / Advanced / Full), same as the event roster table.
 */
function renderGameSummaryStatsTable(game) {
    const tbody = document.getElementById('gameSummaryRosterList');
    if (!tbody) return;

    // Save and detach the sort controller before rebuilding, so re-rendering
    // at a different Stats level keeps the column the coach sorted by.
    if (gameSummarySortController) {
        gameSummarySortState = gameSummarySortController.getSortState();
        gameSummarySortController.detach();
        gameSummarySortController = null;
    }
    tbody.innerHTML = '';

    wireStatsLevelSelect(
        document.getElementById('gameSummaryStatsLevel'),
        () => renderGameSummaryStatsTable(game)
    );

    const playerStats = typeof getGamePlayerStats === 'function'
        ? getGamePlayerStats(game) : {};
    const hasStats = Object.keys(playerStats).length > 0;
    const statsColumns = screenStatsColumns();

    const players = resolveSummaryPlayers(game, playerStats);
    wireExportPlayerSelect(document.getElementById('gameSummaryExportPlayer'), players);

    // Header row
    const headerRow = document.createElement('tr');
    ['Name', ...statsColumns.map(col => col.label)].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        th.classList.add('roster-header');
        headerRow.appendChild(th);
    });
    tbody.appendChild(headerRow);

    // Player rows
    const rowStats = [];
    players.forEach(player => {
        const ps = playerStats[player.id] || {};
        rowStats.push(ps);
        tbody.appendChild(createGameSummaryPlayerRow(player, ps, statsColumns));
    });

    // Team aggregate row: summed counters run back through the same column
    // definitions, so rate columns recompute from the totals.
    if (hasStats) {
        const totals = sumPlayerStats(rowStats);
        const aggRow = buildRosterRow([
            { value: 'Team', className: ['roster-name-column', 'team-total-cell'] },
            ...statsColumns.map(col => ({ value: col.value(totals), className: 'team-total-cell' }))
        ]);
        aggRow.classList.add('team-aggregate-row');
        tbody.appendChild(aggRow);
    }

    // Attach sort controller
    if (typeof createTableSortController === 'function') {
        // Column indices shift with the stats level, so derive them.
        const columns = [
            { key: 'name', type: 'string', colIndex: 0 },
            ...statsColumns.map((col, i) => ({ key: col.key, type: col.type, colIndex: i + 1 }))
        ];
        gameSummarySortController = createTableSortController({
            getHeaderRow: () => tbody.querySelector('tr:first-child'),
            getDataRows: () => Array.from(tbody.querySelectorAll('tr:not(:first-child):not(.team-aggregate-row)')),
            getAggregateRows: () => Array.from(tbody.querySelectorAll('.team-aggregate-row')),
            getTbody: () => tbody,
            columns
        });
        gameSummarySortController.attach();
        if (gameSummarySortState) {
            gameSummarySortController.sort(gameSummarySortState.key, gameSummarySortState.direction);
        }
    }
    if (typeof attachStatsColumnHelp === 'function') {
        attachStatsColumnHelp(tbody.querySelector('tr:first-child'));
    }
}

/**
 * The roster this game's table and export both list: rosterSnapshot for
 * historical accuracy. Some games saved an *empty* rosterSnapshot.players (the
 * snapshot object exists but captured nobody); guard on length so we don't
 * render a blank table when getGamePlayerStats actually has data. When the
 * snapshot is empty, show the live team roster (so bench players still appear
 * as zeros) unioned with anyone who actually has stats — so whoever played is
 * always listed even if currentTeam isn't this game's team.
 * @param {object} game
 * @param {object} playerStats - map of playerId → ps for this game
 * @returns {Array<object>}
 */
function resolveSummaryPlayers(game, playerStats) {
    if (game.rosterSnapshot && game.rosterSnapshot.players
            && game.rosterSnapshot.players.length > 0) {
        return game.rosterSnapshot.players;
    }
    const base = (typeof currentTeam !== 'undefined' && currentTeam
        && currentTeam.teamRoster) ? currentTeam.teamRoster : [];
    const haveIds = new Set(base.map(p => p.id));
    const fromStats = Object.entries(playerStats || {})
        .filter(([id]) => !haveIds.has(id))
        .map(([id, s]) => ({ id, name: s.name || id }));
    return [...base, ...fromStats];
}

/**
 * Create a player row for the game summary stats table.
 * @param {object} player - roster player {id, name, gender?}
 * @param {object} ps - this player's stats (or {} when they didn't play)
 * @param {Array<object>} statsColumns - the columns the active level shows
 */
function createGameSummaryPlayerRow(player, ps, statsColumns) {
    const nameClasses = ['roster-name-column'];
    if (player.gender === Gender.FMP) nameClasses.push('player-fmp');
    else if (player.gender === Gender.MMP) nameClasses.push('player-mmp');

    return buildRosterRow([
        {
            value: typeof formatPlayerName === 'function' ? formatPlayerName(player) : player.name,
            className: nameClasses
        },
        ...statsColumns.map(col => ({ value: col.value(ps) }))
    ]);
}

/**
 * Render the team-level stats line (breaks, clean/dirty holds) below the
 * player stats table. Hidden if the game has no completed points.
 */
function renderGameSummaryTeamStats(game) {
    const el = document.getElementById('gameSummaryTeamStats');
    if (!el) return;
    if (typeof getGameTeamStats !== 'function') {
        el.style.display = 'none';
        return;
    }
    const stats = getGameTeamStats(game);
    if (!stats || stats.total === 0) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.textContent = formatTeamStatsLine(stats);
    el.style.display = '';
}

/**
 * Human-readable label for a point classification.
 * @param {string} kind - return value of classifyPoint
 * @returns {string|null}
 */
function pointClassificationLabel(kind) {
    switch (kind) {
        case 'break': return 'break';
        case 'cleanHold': return 'clean hold';
        case 'hold': return 'hold';
        case 'broken': return 'broken';
        default: return null; // opponentHold gets no badge
    }
}

/**
 * Render the game event log below the stats table.
 * Same shared renderer as the in-game Game Log panel
 * (utils/gameLogRenderer.js, G6 merge); this surface adds per-point
 * classification badges and omits the version/roster header lines.
 */
function renderGameSummaryEventLog(game) {
    const logEl = document.getElementById('gameSummaryEventLog');
    if (!logEl) return;

    const teamName = game.team || 'My Team';
    const opponent = game.opponent || 'Opponent';

    // "Point N roster:" entries may be player ids (id-era games) — resolve to
    // display names; event lines already carry resolved {name, id} refs.
    const lookup = buildPointPlayerLookup(game);
    const entries = buildGameLogEntries(game, {
        teamName,
        opponentName: opponent,
        scoreBadge: (point) => pointClassificationLabel(classifyPoint(point)),
        resolvePlayerName: entry => lookup(entry).name,
    });

    logEl.innerHTML = renderGameLogEntriesHTML(entries, teamName);
}

/**
 * Export game summary stats to an .xlsx workbook (single sheet) and
 * trigger download. Builds the same player table + team-stats footer
 * shown on screen, with proper Excel number / percent / time types.
 * The player menu beside the button narrows the sheet to one player's row
 * while leaving the Team total and footer intact.
 */
function exportGameSummaryXLSX() {
    const game = _lastRenderedGame || (typeof currentGame === 'function' ? currentGame() : null);
    if (!game) { alert('No game to export.'); return; }

    const playerStats = typeof getGamePlayerStats === 'function'
        ? getGamePlayerStats(game) : {};
    const teamStats = typeof getGameTeamStats === 'function'
        ? getGameTeamStats(game) : null;

    // Same roster resolution the on-screen table uses, so the workbook can
    // never list a different set of players than the screen does.
    const players = resolveSummaryPlayers(game, playerStats);
    const { player, sheetPlayers, totalsPlayers } = exportSelection(
        document.getElementById('gameSummaryExportPlayer'), players);

    const teamName = game.team || 'Team';
    const opponent = game.opponent || 'Opponent';
    const teamScore = game.scores?.[Role.TEAM] || game.scores?.team || 0;
    const oppScore = game.scores?.[Role.OPPONENT] || game.scores?.opponent || 0;
    const titleRow = exportTitle(player, `${teamName} ${teamScore} — ${oppScore} ${opponent}`);

    const aoa = buildStatsSheetAoA(sheetPlayers, playerStats, teamStats, { titleRow, totalsPlayers });
    const ws = aoaToFormattedSheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(player ? player.name : opponent));
    downloadWorkbook(wb, `${safeFilename(exportFilename(player, opponent))}-stats.xlsx`);
}

/**
 * Get the back-navigation target for the game summary screen.
 */
function getGameSummaryBackTarget() {
    return gameSummaryOrigin;
}

// Wire up XLSX export button
document.getElementById('exportGameSummaryBtn')?.addEventListener('click', exportGameSummaryXLSX);

// Wire up Share button (public live-link dialog for the rendered game)
document.getElementById('shareGameSummaryBtn')?.addEventListener('click', () => {
    if (_lastRenderedGame) showShareGameDialog(_lastRenderedGame);
});

// --- ES-module exports ---
export { showGameSummaryFromList, showGameSummaryPostGame, getGameSummaryBackTarget };
