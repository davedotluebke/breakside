/*
 * Export workbooks, format-neutral.
 *
 * Every stats export (Review, Event Roster + Stats, Team Roster + Stats) is
 * built here as a plain model, then handed to a writer: utils/xlsxExport.js
 * for an Excel download, utils/sheetsExport.js for a Google Sheet. Nothing in
 * this file touches SheetJS, Google, or the DOM, so it runs under node --test.
 *
 * A workbook is { stem, sheets }. `stem` is the filename / document title
 * without an extension. Each sheet is:
 *
 *   name     tab name, already sanitised and unique within the workbook
 *   rows     2D array of cell values (numbers stay numbers)
 *   widths   column widths in characters
 *   formats  { columnIndex: 'pct' | 'dec' } for numeric cells in that column
 *   filter   { r0, c0, r1, c1 } (0-based, inclusive) — the sortable table,
 *            excluding the title above and the Team total + footer below; or null
 *   frozenRows  rows to pin at the top (title + header)
 *   frozenCols  columns to pin at the left (the names), 0 for none
 *
 * What goes into a workbook is chosen by the Export dialog (ui/exportDialog.js):
 * a scope (one game, a phase, an event, all-time), a stats level, and either
 * every player or one. See ARCHITECTURE.md § Statistics Export.
 */

import {
    formatTeamStatsLine, sumPlayerStats, filterGames,
    getGamesPlayerStats, getGamesTeamStats, formatGameLabel,
} from './statAccumulator.js';
import { sheetStatsColumns } from './statsColumns.js';
import { buildGameFlow, describeGameFlow } from './gameFlow.js';
import { buildConnections } from './connections.js';
import { formatPlayerName } from './helpers.js';

// ── Names ───────────────────────────────────────────────────────────────

/** Sanitise a tab name (Excel: max 31 chars, none of []*?/\:). */
function safeSheetName(name) {
    return (name || 'Sheet').replace(/[\[\]\*\?\/\\:]/g, '').slice(0, 31) || 'Sheet';
}

/**
 * safeSheetName plus de-duplication — both Excel and Google reject two tabs of
 * the same name, and per-game tabs ("v. Storm") repeat whenever a team plays
 * the same opponent twice.
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

/** Sanitise a string for use in a filename. */
function safeFilename(name) {
    return (name || 'export').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-');
}

// ── Who the export covers ───────────────────────────────────────────────

/**
 * Resolve the dialog's player choice to the rows a stats sheet writes.
 *
 * "All players" writes the roster as shown. One player narrows every sheet to
 * that player's row, while the Team total row still sums the whole roster and
 * the breaks/holds footer is unchanged. The point is privacy: a coach can hand
 * a player (or a parent) their own numbers in team context without handing
 * over everyone else's playing time and error counts.
 *
 * @param {string} playerId - '' for all players
 * @param {Array<object>} players - the full roster this export covers
 * @returns {{player: object|null, sheetPlayers: Array<object>, totalsPlayers: Array<object>}}
 */
function exportSelection(playerId, players) {
    const roster = (players || []).filter(p => p && p.id);
    const player = playerId ? roster.find(p => p.id === playerId) || null : null;
    return { player, sheetPlayers: player ? [player] : roster, totalsPlayers: roster };
}

/** Prefix a title with the chosen player, so each sheet says whose numbers it holds. */
function exportTitle(player, baseTitle) {
    return player ? `${formatPlayerName(player)} — ${baseTitle}` : baseTitle;
}

/** Prefix a filename stem with the chosen player, so repeated exports get distinct names. */
function exportStem(player, baseStem) {
    return safeFilename(player ? `${player.name}-${baseStem}` : baseStem);
}

// ── Sheets ──────────────────────────────────────────────────────────────

/**
 * One player-stats sheet: optional title row, header, one row per player, a
 * Team aggregate row, then the breaks/holds footer.
 *
 * @param {Array<object>} players - rows to write: {id, name}
 * @param {object} playerStats - playerId → accumulated stats
 * @param {object} [teamStats] - drives the footer
 * @param {object} opts
 * @param {string} opts.level - 'basic' | 'advanced' | 'full'
 * @param {string} [opts.titleRow]
 * @param {Array<object>} [opts.totalsPlayers] - the roster the Team row sums,
 *   when it differs from the rows written (a single-player export)
 * @returns {object} a sheet (see file header), without `name`
 */
function buildStatsSheet(players, playerStats, teamStats, opts) {
    const cols = sheetStatsColumns(opts.level);
    const rows = [];
    if (opts.titleRow) rows.push([opts.titleRow]);

    const headerRow = rows.length;
    rows.push(cols.map(c => c.label));
    players.forEach(p => rows.push(cols.map(col => col.value(playerStats[p.id] || {}, p.name))));
    const lastPlayerRow = rows.length - 1;

    // The Team row sits outside the filter range so it stays put when the
    // player rows are sorted. Rates recompute from the summed stats.
    const totalsRoster = opts.totalsPlayers || players;
    const totals = sumPlayerStats(totalsRoster.map(p => playerStats[p.id] || {}));
    rows.push(cols.map(col => col.value(totals, 'Team')));

    if (teamStats && teamStats.total > 0) {
        rows.push([]);
        formatTeamStatsLine(teamStats).split('\n').forEach(line => rows.push([line]));
    }

    const formats = {};
    cols.forEach((c, i) => { if (c.fmt) formats[i] = c.fmt === 'pct' ? 'pct' : 'dec'; });
    return {
        rows,
        widths: cols.map(c => c.width),
        formats,
        filter: { r0: headerRow, c0: 0, r1: Math.max(lastPlayerRow, headerRow), c1: cols.length - 1 },
        frozenRows: headerRow + 1,
        frozenCols: 1,
    };
}

/**
 * The "Game Flow" sheet: one row per completed point with the running score,
 * how the point went and its timing; the headline lines as a footer. Null
 * when the game has fewer than two completed points.
 */
function buildGameFlowSheet(game, { teamName, opponentName }) {
    const flow = buildGameFlow(game);
    if (flow.points.length < 2) return null;
    const kindLabel = { break: 'Break', cleanHold: 'Clean hold', hold: 'Hold', broken: 'Broken', opponentHold: 'Their hold' };
    const rows = [[`Game flow: ${teamName} vs ${opponentName}`]];
    const header = ['Point', teamName, opponentName, 'Margin', 'Scored by', 'Started on', 'Result', 'Minutes', 'Halftime after', `Timeouts (${teamName})`, `Timeouts (${opponentName})`];
    rows.push(header);
    flow.points.forEach(p => {
        rows.push([
            p.number, p.us, p.them, p.diff, p.winner === 'us' ? teamName : opponentName,
            p.startedOn === 'O' ? 'Offense' : 'Defense', kindLabel[p.kind] || '',
            p.durationMs ? Math.round(p.durationMs / 600) / 100 : '',
            p.halftimeAfter ? 'Yes' : '', p.timeoutsUs || '', p.timeoutsThem || '',
        ]);
    });
    const lines = describeGameFlow(flow, { teamName, opponentName });
    if (lines.length) {
        rows.push([]);
        lines.forEach(line => rows.push([line]));
    }
    return {
        name: 'Game Flow',
        rows,
        widths: [7, 12, 12, 8, 14, 11, 11, 9, 14, 12, 12],
        formats: { 7: 'dec' },
        filter: { r0: 1, c0: 0, r1: flow.points.length, c1: header.length - 1 },
        frozenRows: 2,
    };
}

/**
 * The "Connections" sheet: one row per thrower→receiver pair, most
 * completions first. Null when no pass has both ends recorded.
 */
function buildConnectionsSheet(games, title = 'Connections') {
    const conn = buildConnections(games);
    if (!conn.pairs.length) return null;
    const rows = [[title]];
    const header = ['Thrower', 'Receiver', 'Completions', 'Attempts', 'Comp%', 'Goals', 'Hucks', 'Drops', 'Throwaways'];
    rows.push(header);
    conn.pairs.forEach(p => {
        rows.push([p.throwerName, p.receiverName, p.completions, p.attempts,
            p.attempts ? p.completions / p.attempts : '', p.goals, p.hucks, p.drops, p.throwaways]);
    });
    rows.push(['Team', '', conn.totals.completions, conn.totals.attempts,
        conn.totals.attempts ? conn.totals.completions / conn.totals.attempts : '', conn.totals.goals, '', '', '']);
    return {
        name: 'Connections',
        rows,
        widths: [16, 16, 12, 10, 8, 7, 7, 7, 11],
        formats: { 4: 'pct' },
        filter: { r0: 1, c0: 0, r1: conn.pairs.length + 1, c1: header.length - 1 },
        frozenRows: 2,
        frozenCols: 2,
    };
}

// ── Workbooks ───────────────────────────────────────────────────────────

/**
 * Assemble a stats workbook from sheet specs.
 *
 * @param {object} spec
 * @param {string} spec.stem - filename stem before the player prefix
 * @param {Array<object>} spec.players - the full roster this export covers
 * @param {string} [spec.playerId] - '' / undefined for all players
 * @param {string} spec.level
 * @param {Array<{label: string, title: string, games: Array<object>, skipIfEmpty?: boolean}>} spec.sheets
 *   The first is the main sheet; the rest are the breakdown.
 * @param {{game: object, teamName: string, opponentName: string}} [spec.singleGame]
 *   When the export covers exactly one game, its Game Flow and Connections
 *   sheets ride along on a whole-team export. A single-player export gets
 *   neither: both name other players, and that export is the privacy handout.
 * @returns {{stem: string, sheets: Array<object>}}
 */
function buildStatsWorkbook(spec) {
    const { player, sheetPlayers, totalsPlayers } = exportSelection(spec.playerId, spec.players);
    const used = new Set();
    const sheets = [];
    spec.sheets.forEach(s => {
        const teamStats = getGamesTeamStats(s.games);
        if (s.skipIfEmpty && teamStats.total === 0) return;
        const sheet = buildStatsSheet(sheetPlayers, getGamesPlayerStats(s.games), teamStats, {
            level: spec.level, titleRow: exportTitle(player, s.title), totalsPlayers,
        });
        sheets.push({ name: uniqueSheetName(s.label, used), ...sheet });
    });
    if (spec.singleGame && !player) {
        const { game, teamName, opponentName } = spec.singleGame;
        [buildGameFlowSheet(game, { teamName, opponentName }),
         buildConnectionsSheet(game, `Connections: ${teamName} vs ${opponentName}`)]
            .filter(Boolean)
            .forEach(sheet => { sheet.name = uniqueSheetName(sheet.name, used); sheets.push(sheet); });
    }
    return { stem: exportStem(player, spec.stem), sheets };
}

/** "Riverside 13 — 10 Storm" */
function gameScoreline(game) {
    const teamName = game.team || 'Team';
    const opponentName = game.opponent || 'Opponent';
    const us = game.scores?.team ?? 0;
    const them = game.scores?.opponent ?? 0;
    return { teamName, opponentName, line: `${teamName} ${us} — ${them} ${opponentName}` };
}

/**
 * One game: a stats sheet, plus Game Flow and Connections on a whole-team export.
 * @param {object} game
 * @param {{players: Array<object>, playerId?: string, level: string, titlePrefix?: string}} opts
 *   `titlePrefix` (an event name) goes in front of the scoreline.
 */
function buildGameWorkbook(game, opts) {
    const { teamName, opponentName, line } = gameScoreline(game);
    return buildStatsWorkbook({
        stem: `${opponentName}-stats`,
        players: opts.players,
        playerId: opts.playerId,
        level: opts.level,
        sheets: [{
            label: opponentName,
            title: opts.titlePrefix ? `${opts.titlePrefix} — ${line}` : line,
            games: [game],
        }],
        singleGame: { game, teamName, opponentName },
    });
}

/**
 * An event, or one phase of it. A single-game filter goes through
 * buildGameWorkbook instead.
 *
 * Breakdown: for the whole event, a sheet per phase (skipped when no points
 * were played in it) then a sheet per game; for one phase, a sheet per game
 * in that phase.
 *
 * @param {object} event - {name, phases}
 * @param {Array<object>} allGames - the event's loaded games
 * @param {{phase?: string}} filter
 * @param {{players: Array<object>, playerId?: string, level: string, breakdown: boolean}} opts
 */
function buildEventWorkbook(event, allGames, filter, opts) {
    const games = filterGames(allGames, filter);
    const mainLabel = filter.phase || 'All games';
    const sheets = [{ label: mainLabel, title: `${event.name} — ${mainLabel}`, games }];
    if (opts.breakdown) {
        if (!filter.phase) {
            (event.phases || []).forEach(p => sheets.push({
                label: p, title: `${event.name} — ${p}`, games: filterGames(allGames, { phase: p }), skipIfEmpty: true,
            }));
        }
        games.forEach(g => sheets.push({
            label: formatGameLabel(g), title: `${event.name} — ${formatGameLabel(g)}`, games: [g],
        }));
    }
    return buildStatsWorkbook({
        stem: filter.phase ? `${event.name}-${filter.phase}-stats` : `${event.name}-stats`,
        players: opts.players, playerId: opts.playerId, level: opts.level, sheets,
    });
}

/**
 * All-time for a team. Breakdown: a sheet per event the team played (in the
 * order given), then the standalone games when there are some but not all.
 *
 * @param {object} team - {name}
 * @param {Array<object>} games - every loaded game
 * @param {Array<object>} events - [{name, gameIds}]
 * @param {{players: Array<object>, playerId?: string, level: string, breakdown: boolean}} opts
 */
function buildTeamWorkbook(team, games, events, opts) {
    const count = list => `${list.length} game${list.length === 1 ? '' : 's'}`;
    const sheets = [{ label: 'All games', title: `${team.name} — All games (${count(games)})`, games }];
    if (opts.breakdown) {
        const inEvent = new Set();
        (events || []).forEach(ev => {
            const ids = new Set(ev.gameIds || []);
            const evGames = games.filter(g => ids.has(g.id));
            if (!evGames.length) return;
            evGames.forEach(g => inEvent.add(g.id));
            sheets.push({ label: ev.name, title: `${team.name} — ${ev.name} (${count(evGames)})`, games: evGames });
        });
        const standalone = games.filter(g => !inEvent.has(g.id) && !g.eventId);
        if (standalone.length > 0 && standalone.length < games.length) {
            sheets.push({ label: 'Standalone', title: `${team.name} — Standalone games (${count(standalone)})`, games: standalone });
        }
    }
    return buildStatsWorkbook({
        stem: `${team.name}-stats`,
        players: opts.players, playerId: opts.playerId, level: opts.level, sheets,
    });
}

// --- ES-module exports ---
export {
    buildGameWorkbook, buildEventWorkbook, buildTeamWorkbook,
    buildStatsSheet, buildGameFlowSheet, buildConnectionsSheet,
    exportSelection, exportTitle,
    safeSheetName, uniqueSheetName, safeFilename,
};
