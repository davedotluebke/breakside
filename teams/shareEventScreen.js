/*
 * The shared-event screen — what an event share link lands on.
 *
 * A guest (teams/shareGuest.js) holds the event's public payload (name,
 * phases, a card per game) and the games it has fetched through the link.
 * This module draws that into #shareEventScreen: the record, the games
 * grouped by phase with a status chip each (tap one to open the game on the
 * Review screen), and the event's player stats — the same columns, Stats
 * menu, Fun panel, team line and Connections block as the coach's Event
 * Roster + Stats screen, read-only, with an Export of the same workbook.
 *
 * View only: the guest module owns the data, the polling and the
 * navigation, and passes callbacks in. Nothing here fetches.
 */
import { formatPlayerName } from '../utils/helpers.js';
import {
    filterGames, getGamesPlayerStats, getGamesTeamStats, getGamesRecord,
    formatGameLabel, formatTeamStatsLine, sumPlayerStats,
} from '../utils/statAccumulator.js';
import { screenStatsColumns } from '../utils/statsColumns.js';
import { StatsLevel } from '../utils/statsLevel.js';
import {
    activeStatsLevel, lockedStatsLevel, wireActiveStatsLevelSelect, getFunOptions,
} from '../utils/statsAudience.js';
import { renderFunStats, clearFunStats } from '../ui/funStatsView.js';
import { createTableSortController } from '../utils/tableSort.js';
import { attachStatsColumnHelp } from '../utils/statsHelp.js';
import { buildRosterRow } from './rosterRowHelpers.js';
import { mountConnections } from '../ui/gameFlowChart.js';
import { buildEventWorkbook, buildGameWorkbook } from '../utils/exportWorkbook.js';
import { openExportDialog } from '../ui/exportDialog.js';
import { gameLogText } from './gameSummary.js';
import { groupCardsByPhase, cardStatus, statusLabel } from '../utils/eventShare.js';

const $ = id => document.getElementById(id);

function esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
}

// The last data rendered, so the Stats menu and the scope menu can redraw
// without the guest module re-handing it over.
let lastData = null;
let lastHandlers = null;
// Scope: '' = all games, 'phase:<p>', 'game:<id>'. Reset per event.
let scope = '';
let scopeEventName = null;
let sortController = null;
let sortState = null;
let connectionsView = null;

/**
 * Draw (or redraw) the whole screen.
 * @param {object} data
 * @param {object} data.event - {name, phases, status}
 * @param {Array<object>} data.cards - public game cards, in display order
 * @param {Object<string,object>} data.games - gameId → hydrated game, for
 *   the games fetched so far (stats are built from these)
 * @param {object} handlers
 * @param {(gameId: string) => void} handlers.onOpenGame
 */
function renderShareEvent(data, handlers) {
    lastData = data;
    lastHandlers = handlers;
    if (scopeEventName !== data.event.name) { scope = ''; scopeEventName = data.event.name; sortState = null; }

    const title = $('shareEventTitle');
    if (title) title.textContent = data.event.name || 'Event';
    renderHeader(data);
    renderGames(data, handlers);
    renderScopeMenu(data);
    wireActiveStatsLevelSelect($('shareEventStatsLevel'), () => renderStats(data));
    renderStats(data);

    const exportBtn = $('exportShareEventBtn');
    if (exportBtn) {
        exportBtn.style.display = Object.keys(data.games).length ? '' : 'none';
        exportBtn.onclick = () => openShareEventExport(data);
    }
}

/** "Riverside · 4 games · 3W-1L" */
function renderHeader(data) {
    const cards = data.cards || [];
    const teamName = cards.length ? cards[0].team : '';
    const teamEl = $('shareEventTeam');
    if (teamEl) teamEl.textContent = teamName || '';
    const recordEl = $('shareEventRecord');
    if (!recordEl) return;
    if (!cards.length) {
        recordEl.textContent = 'No games yet';
        return;
    }
    const { wins, losses, ties } = getGamesRecord(cards);
    const count = `${cards.length} game${cards.length === 1 ? '' : 's'}`;
    const record = `${wins}W-${losses}L${ties ? `-${ties}T` : ''}`;
    recordEl.textContent = `${count} · ${record}`;
}

/** "Sat Jul 1" for a card's start, or '' */
function cardDate(card) {
    if (!card.gameStartTimestamp) return '';
    const d = new Date(card.gameStartTimestamp);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The games, bucketed by phase; each row opens the game. */
function renderGames(data, handlers) {
    const host = $('shareEventGames');
    if (!host) return;
    const groups = groupCardsByPhase(data.cards, data.event.phases);
    if (!groups.length) {
        host.innerHTML = '<p class="share-list-note">No games in this event yet.</p>';
        return;
    }
    host.innerHTML = groups.map(group => `
        ${group.label ? `<div class="event-phase-header${group.unassigned ? ' event-phase-unassigned' : ''}">${esc(group.label)}</div>` : ''}
        <ul class="share-event-games-list">
            ${group.games.map(card => {
                const status = cardStatus(card);
                const us = card.scores?.team ?? 0;
                const them = card.scores?.opponent ?? 0;
                return `
            <li>
                <button type="button" class="share-event-game" data-game-id="${esc(card.id)}" title="Open this game">
                    <span class="share-event-game-when">${esc(cardDate(card))}</span>
                    <span class="share-event-game-who">vs ${esc(card.opponent || 'TBD')}</span>
                    <span class="share-event-game-score">${us}–${them}</span>
                    <span class="share-status-badge status-${status}">${statusLabel(status)}</span>
                    <i class="fas fa-chevron-right share-event-game-chevron" aria-hidden="true"></i>
                </button>
            </li>`;
            }).join('')}
        </ul>`).join('');
    host.querySelectorAll('.share-event-game').forEach(btn => {
        btn.addEventListener('click', () => handlers.onOpenGame(btn.dataset.gameId));
    });
}

/** The "Show:" menu: all games, each phase, each game. Hidden when there is one game and no phases. */
function renderScopeMenu(data) {
    const wrap = $('shareEventScopeWrap');
    const select = $('shareEventScope');
    if (!wrap || !select) return;
    const phases = (data.event.phases || []);
    const cards = data.cards || [];
    if (cards.length <= 1 && !phases.length) {
        wrap.style.display = 'none';
        scope = '';
        return;
    }
    wrap.style.display = '';
    let html = '<option value="">All games</option>';
    if (phases.length) {
        html += `<optgroup label="Phases">${phases.map(p => `<option value="phase:${esc(p)}">${esc(p)}</option>`).join('')}</optgroup>`;
    }
    html += `<optgroup label="Games">${cards.map(c => `<option value="game:${esc(c.id)}">${esc(formatGameLabel(c))}</option>`).join('')}</optgroup>`;
    select.innerHTML = html;
    if (![...select.options].some(o => o.value === scope)) scope = '';
    select.value = scope;
    select.onchange = () => { scope = select.value; renderStats(lastData); };
}

function scopeFilter(value) {
    if (value.startsWith('phase:')) return { phase: value.slice(6) };
    if (value.startsWith('game:')) return { gameId: value.slice(5) };
    return {};
}

/** The games in scope, in card order, among those fetched so far. */
function scopedGames(data, value = scope) {
    const games = (data.cards || []).map(c => data.games[c.id]).filter(Boolean);
    return filterGames(games, scopeFilter(value));
}

/**
 * Everyone who appeared in the games in scope: the union of their roster
 * snapshots (the public projection lists only players the play-by-play
 * mentions), by name.
 */
function scopedPlayers(games) {
    const seen = new Map();
    games.forEach(g => (g.rosterSnapshot?.players || []).forEach(p => {
        if (p && p.id && !seen.has(p.id)) seen.set(p.id, p);
    }));
    return [...seen.values()].sort((a, b) =>
        formatPlayerName(a).toLowerCase().localeCompare(formatPlayerName(b).toLowerCase()));
}

/** The stats block: Fun panel or the table, the team line, Connections. */
function renderStats(data) {
    const tbody = $('shareEventStatsList');
    if (!tbody || !data) return;
    if (sortController) {
        sortState = sortController.getSortState();
        sortController.detach();
        sortController = null;
    }

    const games = scopedGames(data);
    const playerStats = getGamesPlayerStats(games);
    const teamStats = getGamesTeamStats(games);
    const hasStats = Object.keys(playerStats).length > 0;
    const players = scopedPlayers(games);
    const level = activeStatsLevel();
    const fun = level === StatsLevel.FUN;
    const statsColumns = screenStatsColumns(level);

    const note = $('shareEventStatsNote');
    if (note) {
        const pending = (data.cards || []).length - Object.keys(data.games).length;
        note.style.display = (pending > 0 || !hasStats) ? '' : 'none';
        note.textContent = pending > 0
            ? `Loading ${pending} game${pending === 1 ? '' : 's'}…`
            : 'No stats yet — nothing has been recorded in the games in scope.';
    }

    const teamStatsEl = $('shareEventTeamStats');
    if (teamStatsEl) {
        teamStatsEl.textContent = teamStats.total > 0 ? formatTeamStatsLine(teamStats) : '';
        teamStatsEl.style.display = teamStats.total > 0 ? '' : 'none';
    }

    // Connections names drops and throwaways per pair: not at Fun.
    renderConnections(fun ? [] : games);

    const funHost = $('shareEventFunStats');
    const tableContainer = tbody.closest('.roster-table-container');
    if (tableContainer) tableContainer.hidden = fun || !hasStats;
    tbody.innerHTML = '';
    if (fun && hasStats) renderFunStats(funHost, players, playerStats);
    else clearFunStats(funHost);
    if (fun || !hasStats) return;

    const headerRow = document.createElement('tr');
    ['Name', ...statsColumns.map(col => col.label)].forEach((text, i) => {
        const th = document.createElement('th');
        th.textContent = text;
        th.classList.add('roster-header');
        if (i === 0) th.style.textAlign = 'left';
        headerRow.appendChild(th);
    });
    tbody.appendChild(headerRow);

    const rowStats = [];
    players.forEach(player => {
        const ps = playerStats[player.id] || {};
        rowStats.push(ps);
        tbody.appendChild(buildRosterRow([
            { value: formatPlayerName(player), className: ['roster-name-column'] },
            ...statsColumns.map(col => ({ value: col.value(ps) })),
        ]));
    });
    const totals = sumPlayerStats(rowStats);
    const aggRow = buildRosterRow([
        { value: 'Team', className: ['roster-name-column', 'team-total-cell'] },
        ...statsColumns.map(col => ({ value: col.value(totals), className: 'team-total-cell' })),
    ]);
    aggRow.classList.add('team-aggregate-row');
    tbody.appendChild(aggRow);

    sortController = createTableSortController({
        getHeaderRow: () => tbody.querySelector('tr:first-child'),
        getDataRows: () => Array.from(tbody.querySelectorAll('tr:not(:first-child):not(.team-aggregate-row)')),
        getAggregateRows: () => Array.from(tbody.querySelectorAll('.team-aggregate-row')),
        getTbody: () => tbody,
        columns: [
            { key: 'name', type: 'string', colIndex: 0 },
            ...statsColumns.map((col, i) => ({ key: col.key, type: col.type, colIndex: i + 1 })),
        ],
    });
    sortController.attach();
    if (sortState) sortController.sort(sortState.key, sortState.direction);
    attachStatsColumnHelp(tbody.querySelector('tr:first-child'));
}

function renderConnections(games) {
    const section = $('shareEventConnectionsSection');
    const host = $('shareEventConnectionsHost');
    if (!section || !host) return;
    const view = connectionsView && connectionsView.view ? connectionsView.view() : 'list';
    if (connectionsView) { try { connectionsView.destroy(); } catch (e) { /* gone */ } connectionsView = null; }
    connectionsView = games.length ? mountConnections(host, games, { view }) : null;
    section.style.display = connectionsView ? '' : 'none';
}

/**
 * The Export dialog for the event: the same scopes and workbook as the
 * coach's Event Roster + Stats export, over the games the link has fetched.
 * A guest gets Excel, Google Sheets and the log, not the raw game JSON.
 */
function openShareEventExport(data) {
    const event = data.event;
    const games = scopedGames(data, '');
    const phases = event.phases || [];
    const scopes = [{
        value: '', label: 'All games',
        breakdown: phases.length ? 'Add a sheet per phase and per game' : 'Add a sheet per game',
    }];
    phases.forEach(p => scopes.push({ value: `phase:${p}`, label: p, group: 'Phases', breakdown: 'Add a sheet per game' }));
    games.forEach(g => scopes.push({ value: `game:${g.id}`, label: formatGameLabel(g), group: 'Games', singleGame: true }));

    const players = scopedPlayers(games);
    const gameFor = (choice) => {
        const { gameId } = scopeFilter(choice.scope);
        return gameId ? games.find(g => g.id === gameId) || null : null;
    };
    openExportDialog({
        subject: event.name,
        scopes,
        scope,
        level: activeStatsLevel(),
        lockedLevel: lockedStatsLevel(),
        funOptions: getFunOptions(),
        players,
        formats: ['xlsx', 'sheets', 'text'],
        buildWorkbook: async (choice) => {
            const filter = scopeFilter(choice.scope);
            const opts = { players, playerId: choice.playerId, level: choice.level, breakdown: choice.breakdown, fun: choice.fun };
            if (filter.gameId) {
                const game = gameFor(choice);
                return game ? buildGameWorkbook(game, { ...opts, titlePrefix: event.name }) : null;
            }
            return buildEventWorkbook(event, games, filter, opts);
        },
        gameFor,
        gameText: gameLogText,
    });
}

/** Forget the rendered event (a new link, or the guest session ends). */
function resetShareEventScreen() {
    lastData = null;
    lastHandlers = null;
    scope = '';
    scopeEventName = null;
    sortState = null;
    if (sortController) { sortController.detach(); sortController = null; }
    if (connectionsView) { try { connectionsView.destroy(); } catch (e) { /* gone */ } connectionsView = null; }
}

// --- ES-module exports ---
export { renderShareEvent, resetShareEventScreen };
