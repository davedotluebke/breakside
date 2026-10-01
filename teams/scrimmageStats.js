/*
 * Scrimmage Stats screen: per-player stats aggregated over a team's intrasquad
 * scrimmages — every squad-game of every scrimmage, or one scrimmage — with
 * the same table, Stats menu, Connections block and Export dialog as the
 * Event Roster + Stats and Review screens (the column set is shared through
 * utils/statsColumns.js). Read-only: scrimmages are created from the team card
 * (teams/scrimmageDialogs.js) and each half is tracked as a game.
 *
 * Why its own screen: the team's Roster + Stats "All-time" scope deliberately
 * leaves scrimmage games out (utils/eventStats.js getTeamPlayerStats), so a
 * season of practices never inflates a player's real record; this is where
 * those numbers live instead. See ARCHITECTURE.md § Intrasquad scrimmages.
 */
import { Gender } from '../store/models.js';
import { currentTeam } from '../store/storage.js';
import { loadGameFromCloud } from '../store/sync.js';
import { formatPlayerName } from '../utils/helpers.js';
import {
    getGamesPlayerStats, getGamesTeamStats, sumPlayerStats, formatTeamStatsLine,
} from '../utils/statAccumulator.js';
import {
    groupScrimmages, scrimmageLabel, scrimmageSquadNames, formatShortDate,
} from '../store/scrimmage.js';
import { createTableSortController } from '../utils/tableSort.js';
import { attachStatsColumnHelp } from '../utils/statsHelp.js';
import { StatsLevel } from '../utils/statsLevel.js';
import { activeStatsLevel, lockedStatsLevel, wireActiveStatsLevelSelect } from '../utils/statsAudience.js';
import { renderFunStats, clearFunStats } from '../ui/funStatsView.js';
import { screenStatsColumns } from '../utils/statsColumns.js';
import { buildScrimmageWorkbook } from '../utils/exportWorkbook.js';
import { openExportDialog } from '../ui/exportDialog.js';
import { mountConnections } from '../ui/gameFlowChart.js';
import { showScreen } from '../screens/navigation.js';
import { buildRosterRow } from './rosterRowHelpers.js';

// Module-level state for the open screen.
let screenTeam = null;           // team as the API lists it
let summaries = [];              // this team's squad-game summaries (list_all_games shape)
let filter = { scrimmageId: null };
// Loaded squad-games, keyed by a signature of the summaries they came from, so
// reopening the screen after nothing changed costs no fetches while a squad
// that scored since is reloaded.
let loaded = { signature: null, games: [] };
let sortController = null;
let sortState = null;
let connectionsView = null;

/**
 * Open the screen for a team.
 * @param {object} team - team as the API lists it
 * @param {Array<object>} scrimmageGames - the team's squad-game summaries
 * @param {{scrimmageId?: string|null}} [opts] - start narrowed to one scrimmage
 */
function showScrimmageStatsScreen(team, scrimmageGames, opts = {}) {
    screenTeam = team;
    summaries = (scrimmageGames || []).filter(g => g && g.scrimmageId);
    filter = { scrimmageId: opts.scrimmageId || null };
    sortState = null;

    const header = document.getElementById('scrimmageStatsHeader');
    if (header) header.textContent = `${team.name} — Scrimmages`;
    setNote(summaries.length ? 'Loading scrimmages…' : 'No scrimmages yet. Create one from the team card.');
    const tbody = document.getElementById('scrimmageStatsList');
    if (tbody) tbody.innerHTML = '';
    hideExtras();

    renderFilterRow();
    showScreen('scrimmageStatsScreen');
    renderTable();
}

function setNote(text) {
    const note = document.getElementById('scrimmageStatsNote');
    if (!note) return;
    note.textContent = text || '';
    note.style.display = text ? '' : 'none';
}

function hideExtras() {
    const exportBtn = document.getElementById('exportScrimmageStatsBtn');
    if (exportBtn) exportBtn.style.display = 'none';
    const teamStatsEl = document.getElementById('scrimmageStatsTeamStats');
    if (teamStatsEl) teamStatsEl.style.display = 'none';
    const section = document.getElementById('scrimmageConnectionsSection');
    if (section) section.style.display = 'none';
}

/** A string that changes whenever a summary's content could have. */
function summarySignature(list) {
    return list
        .map(g => `${g.game_id}:${g.points_count ?? ''}:${g.game_end_timestamp || ''}:${g.scores?.team ?? ''}-${g.scores?.opponent ?? ''}`)
        .sort()
        .join('|');
}

/**
 * Load every squad-game in the summaries (five at a time, like the roster
 * screen's all-time export), reusing the last load when nothing changed.
 * @returns {Promise<Array<object>>} deserialized Game objects
 */
async function loadScrimmageGames() {
    const signature = summarySignature(summaries);
    if (loaded.signature === signature) return loaded.games;
    const games = [];
    const batchSize = 5;
    for (let i = 0; i < summaries.length; i += batchSize) {
        const fetched = await Promise.all(summaries.slice(i, i + batchSize).map(async g => {
            try { return await loadGameFromCloud(g.game_id); }
            catch (e) { console.warn('Skip scrimmage game', g.game_id, e); return null; }
        }));
        fetched.forEach(g => { if (g) games.push(g); });
    }
    loaded = { signature, games };
    return games;
}

/** The loaded games in scope: one scrimmage, or all of them. */
function scopedGames(games) {
    if (!filter.scrimmageId) return games;
    return games.filter(g => g.scrimmageId === filter.scrimmageId);
}

/** "Tuesday practice · 09/27/26 · Dark vs Light" — a scrimmage in the scope menu. */
function scrimmageOptionLabel(scrimmage) {
    const names = scrimmageSquadNames(scrimmage);
    const date = scrimmage.startTs ? formatShortDate(scrimmage.startTs) : '';
    const head = scrimmage.name ? `${scrimmage.name}${date ? ` · ${date}` : ''}` : scrimmageLabel(scrimmage);
    return `${head} · ${names.X} vs ${names.Y}`;
}

/** The Show menu (all scrimmages, then each one) and the Stats menu. */
function renderFilterRow() {
    const select = document.getElementById('scrimmageScopeFilter');
    const levelSelect = document.getElementById('scrimmageStatsLevel');
    wireActiveStatsLevelSelect(levelSelect, () => renderTable());
    if (!select) return;

    const scrimmages = groupScrimmages(summaries);
    select.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = `All scrimmages (${scrimmages.length})`;
    select.appendChild(allOpt);
    scrimmages.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = scrimmageOptionLabel(s);
        select.appendChild(opt);
    });
    select.value = filter.scrimmageId || '';
    if (select.selectedIndex < 0) {
        select.value = '';
        filter = { scrimmageId: null };
    }
    select.onchange = () => {
        filter = { scrimmageId: select.value || null };
        renderTable();
    };
    const wrap = document.getElementById('scrimmageScopeWrap');
    if (wrap) wrap.style.display = scrimmages.length ? '' : 'none';
}

/** The label for the current scope, for the header. */
function currentScopeLabel(games) {
    if (!filter.scrimmageId) return '';
    const [s] = groupScrimmages(games.filter(g => g.scrimmageId === filter.scrimmageId));
    return s ? ` — ${scrimmageLabel(s)}` : '';
}

/**
 * Who the table lists: everyone who was on a squad in the games in scope
 * (each squad-game's roster snapshot), as the live team Player when they are
 * still on the roster, plus anyone the stats know who was on no snapshot.
 * Sorted by display name.
 */
function scopedPlayers(games, playerStats) {
    const roster = currentTeam ? currentTeam.teamRoster : [];
    const seen = new Map();
    games.forEach(g => (g.rosterSnapshot?.players || []).forEach(p => {
        if (!p || !p.id || seen.has(p.id)) return;
        seen.set(p.id, roster.find(r => r.id === p.id) || p);
    }));
    Object.entries(playerStats).forEach(([id, s]) => {
        if (seen.has(id)) return;
        seen.set(id, roster.find(r => r.id === id) || { id, name: s.name || id });
    });
    return [...seen.values()].sort((a, b) =>
        formatPlayerName(a).toLowerCase().localeCompare(formatPlayerName(b).toLowerCase()));
}

async function renderTable() {
    const tbody = document.getElementById('scrimmageStatsList');
    if (!tbody) return;

    if (sortController) {
        sortState = sortController.getSortState();
        sortController.detach();
        sortController = null;
    }

    const team = screenTeam;
    const allGames = summaries.length ? await loadScrimmageGames() : [];
    if (screenTeam !== team) return;   // the screen moved on while loading
    const games = scopedGames(allGames);

    const playerStats = getGamesPlayerStats(games);
    const teamStats = getGamesTeamStats(games);
    const hasStats = Object.keys(playerStats).length > 0;
    const level = activeStatsLevel();
    const statsColumns = screenStatsColumns(level);
    const players = scopedPlayers(games, playerStats);

    const header = document.getElementById('scrimmageStatsHeader');
    if (header && team) header.textContent = `${team.name} — Scrimmages${currentScopeLabel(allGames)}`;

    const scrimmageCount = groupScrimmages(games).length;
    if (!summaries.length) {
        setNote('No scrimmages yet. Create one from the team card.');
    } else if (!hasStats) {
        setNote('No points recorded yet in the scrimmages in scope.');
    } else {
        setNote(`${scrimmageCount} scrimmage${scrimmageCount === 1 ? '' : 's'}, ${games.length} squad-game${games.length === 1 ? '' : 's'} — both squads' stats together. Scrimmage stats stay out of the team's all-time stats.`);
    }

    const exportBtn = document.getElementById('exportScrimmageStatsBtn');
    if (exportBtn) exportBtn.style.display = hasStats ? '' : 'none';

    const teamStatsEl = document.getElementById('scrimmageStatsTeamStats');
    if (teamStatsEl) {
        if (teamStats.total > 0) {
            teamStatsEl.textContent = formatTeamStatsLine(teamStats);
            teamStatsEl.style.display = '';
        } else {
            teamStatsEl.textContent = '';
            teamStatsEl.style.display = 'none';
        }
    }

    // Fun: the shout-outs panel instead of the table, and no Connections
    // (it names drops and throwaways per pair).
    const fun = level === StatsLevel.FUN;
    renderConnections(fun ? [] : games);

    tbody.innerHTML = '';
    const funHost = document.getElementById('scrimmageFunStats');
    const tableContainer = tbody.closest('.roster-table-container');
    if (tableContainer) tableContainer.hidden = fun;
    if (fun && hasStats) renderFunStats(funHost, players, playerStats);
    else clearFunStats(funHost);
    if (fun || !players.length) return;

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
        const nameClasses = ['roster-name-column'];
        if (player.gender === Gender.FMP) nameClasses.push('player-fmp');
        else if (player.gender === Gender.MMP) nameClasses.push('player-mmp');
        tbody.appendChild(buildRosterRow([
            { value: formatPlayerName(player), className: nameClasses },
            ...statsColumns.map(col => ({ value: col.value(ps) })),
        ]));
    });

    if (hasStats) {
        const totals = sumPlayerStats(rowStats);
        const aggRow = buildRosterRow([
            { value: 'Team', className: ['roster-name-column', 'team-total-cell'] },
            ...statsColumns.map(col => ({ value: col.value(totals), className: 'team-total-cell' })),
        ]);
        aggRow.classList.add('team-aggregate-row');
        tbody.appendChild(aggRow);
    }

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

/** Who threw to whom across the games in scope (pairs are within a squad). */
function renderConnections(games) {
    const section = document.getElementById('scrimmageConnectionsSection');
    const host = document.getElementById('scrimmageConnectionsHost');
    if (!section || !host) return;
    const view = connectionsView && connectionsView.view ? connectionsView.view() : 'list';
    if (connectionsView) { try { connectionsView.destroy(); } catch (e) { /* gone */ } connectionsView = null; }
    connectionsView = games.length ? mountConnections(host, games, { view }) : null;
    section.style.display = connectionsView ? '' : 'none';
}

function backFromScrimmageStats() {
    // late-bound back-edge (teams/teamList lives "above" this module); see
    // ARCHITECTURE.md § ES modules — the window shim at the owner is kept.
    if (typeof window.showSelectTeamScreen === 'function') {
        window.showSelectTeamScreen();
    } else {
        showScreen('selectTeamScreen');
    }
}

/**
 * The Export dialog for scrimmage stats: all scrimmages (a sheet per
 * scrimmage on request) or one (a sheet per squad on request), starting at
 * the scope on screen.
 */
function openScrimmageStatsExport() {
    const team = screenTeam;
    if (!team) return;
    const games = loaded.games;
    const scrimmages = groupScrimmages(games);
    const scopes = [{ value: '', label: 'All scrimmages', breakdown: 'Add a sheet per scrimmage' }];
    scrimmages.forEach(s => scopes.push({
        value: s.id, label: scrimmageOptionLabel(s), group: 'Scrimmages', breakdown: 'Add a sheet per squad',
    }));
    const players = scopedPlayers(games, getGamesPlayerStats(games));
    openExportDialog({
        subject: `${team.name} — Scrimmages`,
        scopes,
        scope: filter.scrimmageId || '',
        level: activeStatsLevel(),
        lockedLevel: lockedStatsLevel(),
        players,
        buildWorkbook: async (choice) => buildScrimmageWorkbook(team, games, { scrimmageId: choice.scope || null }, {
            players, playerId: choice.playerId, level: choice.level, breakdown: choice.breakdown,
        }),
    });
}

(function initializeScrimmageStats() {
    document.getElementById('backFromScrimmageStatsBtn')?.addEventListener('click', backFromScrimmageStats);
    document.getElementById('exportScrimmageStatsBtn')?.addEventListener('click', openScrimmageStatsExport);
})();

export { showScrimmageStatsScreen };
