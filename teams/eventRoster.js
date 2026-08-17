/*
 * Event Roster Management
 * Manages the roster for a TournamentEvent: select attending players and add pickups.
 * Table-based layout matching team roster UI pattern.
 */
import { Gender, generateShortId } from '../store/models.js';
import {
    currentTeam, currentEvent, setCurrentEvent, deserializeTournamentEvent,
} from '../store/storage.js';
import { formatPlayerName } from '../utils/helpers.js';
import {
    loadEventGames, filterGames, getGamesPlayerStats, getGamesRecord,
    getGamesTeamStats, formatGameLabel, sumPlayerStats, formatTeamStatsLine,
} from '../utils/eventStats.js';
import { createTableSortController } from '../utils/tableSort.js';
import { attachStatsColumnHelp } from '../utils/statsHelp.js';
import { getStatsLevel, wireStatsLevelSelect } from '../utils/statsLevel.js';
import { screenStatsColumns } from '../utils/statsColumns.js';
import {
    buildStatsSheetAoA, aoaToFormattedSheet, downloadWorkbook,
    uniqueSheetName, safeFilename,
} from '../utils/xlsxExport.js';
import { updateEventOnCloud } from '../store/sync.js';
import { showScreen } from '../screens/navigation.js';
import { buildRosterRow } from './rosterRowHelpers.js';
import {
    showEditPlayerDialog, closeEditPlayerDialog, validateJerseyNumber,
} from './rosterManagement.js';

// Module-level state
let currentEventRosterEvent = null;
let eventRosterPlayerIds = new Set();
let eventRosterPickups = [];
// Per-event position/line overrides for team players: { [playerId]: {position, defaultLine} }.
// Seeded from event.roster.overrides, persisted by saveEventRoster.
let eventRosterOverrides = {};
// The event's games, loaded from cloud once per screen visit. Every filter
// (all / phase / single game) and the xlsx export are computed from this list,
// so switching filters is instant and costs no extra fetches.
let cachedEventGames = null; // { eventId, games }
let eventRosterSortController = null;
let eventRosterSortState = null; // persists sort across re-renders
// Current scope: {} = everything, {phase} = one phase, {gameId} = one game.
let eventRosterFilter = {};

/**
 * The stats columns the active Stats level shows. The column set itself lives
 * in utils/statsColumns.js, shared with the Review screen (teams/gameSummary.js)
 * so the two tables always show the same stats in the same order.
 */
function activeEventRosterColumns() {
    return screenStatsColumns();
}

/**
 * Show the event roster UI for editing an event's roster
 * @param {object} event - The event data object from the server
 */
function showEventRosterUI(event) {
    currentEventRosterEvent = event;
    cachedEventGames = null; // clear cache for fresh load
    eventRosterSortState = null; // reset sort for new event
    eventRosterFilter = {}; // reset to "All games" when opening a new event
    renderEventRosterFilterRow();

    // Clone roster state into local variables
    const existingPlayerIds = event.roster?.playerIds || [];
    const roster = currentTeam ? currentTeam.teamRoster : [];

    // If no playerIds saved yet, default to all team players checked
    if (existingPlayerIds.length === 0 && roster.length > 0) {
        eventRosterPlayerIds = new Set(roster.map(p => p.id));
    } else {
        eventRosterPlayerIds = new Set(existingPlayerIds);
    }

    eventRosterPickups = (event.roster?.pickupPlayers || []).map(p => ({ ...p }));

    // Clone existing per-event overrides (shallow-clone each entry).
    const savedOverrides = event.roster?.overrides || {};
    eventRosterOverrides = {};
    Object.keys(savedOverrides).forEach(id => { eventRosterOverrides[id] = { ...savedOverrides[id] }; });

    // Set header (will be updated with record after stats load)
    const header = document.getElementById('eventRosterHeader');
    if (header) {
        const hasGameIds = (event.gameIds || []).length > 0;
        header.textContent = hasGameIds
            ? `${event.name} — Loading stats...`
            : `${event.name} — Roster + Stats`;
    }

    showScreen('eventRosterScreen');
    renderEventRosterTable();
}

/**
 * Encode/decode the scope-select option values. Phases and game ids share one
 * <select>, so each value carries its own kind.
 */
function filterToValue(filter) {
    if (filter.gameId) return `game:${filter.gameId}`;
    if (filter.phase) return `phase:${filter.phase}`;
    return '';
}
function valueToFilter(value) {
    if (!value) return {};
    if (value.startsWith('game:')) return { gameId: value.slice(5) };
    if (value.startsWith('phase:')) return { phase: value.slice(6) };
    return {};
}

/**
 * Render the filter row: the scope menu ("All games", each declared phase,
 * then each individual game) plus the Stats detail menu. The scope menu is
 * hidden when there is nothing to narrow to; the Stats menu always shows.
 */
function renderEventRosterFilterRow() {
    const row = document.getElementById('eventRosterFilterRow');
    const scopeWrap = document.getElementById('eventRosterScopeWrap');
    const select = document.getElementById('eventRosterScopeFilter');
    const levelSelect = document.getElementById('eventRosterStatsLevel');
    if (!row) return;

    row.style.display = '';
    wireStatsLevelSelect(levelSelect, () => renderEventRosterTable());

    if (!scopeWrap || !select) return;
    const phases = currentEventRosterEvent?.phases || [];
    const games = cachedEventGames?.games || [];
    // Only one game and no phases → nothing to narrow to.
    if (phases.length === 0 && games.length < 2) {
        scopeWrap.style.display = 'none';
        return;
    }
    scopeWrap.style.display = '';

    select.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All games';
    select.appendChild(allOpt);

    if (phases.length > 0) {
        const group = document.createElement('optgroup');
        group.label = 'Phases';
        phases.forEach(p => {
            const opt = document.createElement('option');
            opt.value = `phase:${p}`;
            opt.textContent = p;
            group.appendChild(opt);
        });
        select.appendChild(group);
    }

    if (games.length > 0) {
        const group = document.createElement('optgroup');
        group.label = 'Games';
        games.forEach(g => {
            const opt = document.createElement('option');
            opt.value = `game:${g.id}`;
            opt.textContent = formatGameLabel(g);
            group.appendChild(opt);
        });
        select.appendChild(group);
    }

    select.value = filterToValue(eventRosterFilter);
    // A stale selection (e.g. the game vanished) falls back to "All games".
    if (select.selectedIndex < 0) {
        select.value = '';
        eventRosterFilter = {};
    }
    select.onchange = () => {
        eventRosterFilter = valueToFilter(select.value);
        renderEventRosterTable();
    };
}

/** The label for the current filter, appended to the screen header. */
function currentFilterLabel() {
    if (eventRosterFilter.phase) return ` — ${eventRosterFilter.phase}`;
    if (eventRosterFilter.gameId) {
        const game = (cachedEventGames?.games || []).find(g => g.id === eventRosterFilter.gameId);
        return game ? ` — ${formatGameLabel(game)}` : '';
    }
    return '';
}

/**
 * Render the event roster table rows with full event statistics.
 * Shows roster immediately, then loads stats from cloud asynchronously.
 */
async function renderEventRosterTable() {
    const tbody = document.getElementById('eventRosterList');
    if (!tbody) return;

    // Save and detach sort controller before rebuilding
    if (eventRosterSortController) {
        eventRosterSortState = eventRosterSortController.getSortState();
        eventRosterSortController.detach();
        eventRosterSortController = null;
    }

    // Load the event's games from cloud once (games aren't in local state),
    // then derive every filtered view from that list without re-fetching.
    const event = currentEventRosterEvent;
    let eventPlayerStats = {};
    let record = null;
    let teamStats = null;
    const eventId = event?.id;
    const hasGameIds = (event?.gameIds || []).length > 0;

    if (hasGameIds) {
        if (!cachedEventGames || cachedEventGames.eventId !== eventId) {
            try {
                cachedEventGames = { eventId, games: await loadEventGames(event) };
                // The scope menu lists the games, so it can only be built now.
                renderEventRosterFilterRow();
            } catch (e) {
                console.error('Error loading event games:', e);
                cachedEventGames = { eventId, games: [] };
            }
        }
        const games = filterGames(cachedEventGames.games, eventRosterFilter);
        eventPlayerStats = getGamesPlayerStats(games);
        record = getGamesRecord(games);
        teamStats = getGamesTeamStats(games);
    }

    const hasStats = Object.keys(eventPlayerStats).length > 0;
    const statsColumns = activeEventRosterColumns();

    // Show/hide export button
    const exportBtn = document.getElementById('exportEventRosterBtn');
    if (exportBtn) exportBtn.style.display = hasStats ? '' : 'none';

    // Clear and rebuild after async load
    tbody.innerHTML = '';

    // Update header with record if available
    const header = document.getElementById('eventRosterHeader');
    if (header && event) {
        const recordStr = record && (record.wins + record.losses + record.ties) > 0
            ? ` (${record.wins}W-${record.losses}L${record.ties ? `-${record.ties}T` : ''})`
            : '';
        header.textContent = `${event.name}${currentFilterLabel()}${recordStr}`;
    }

    // Team-level breaks/holds line
    const teamStatsEl = document.getElementById('eventRosterTeamStats');
    if (teamStatsEl) {
        if (teamStats && teamStats.total > 0 && typeof formatTeamStatsLine === 'function') {
            teamStatsEl.textContent = formatTeamStatsLine(teamStats);
            teamStatsEl.style.display = '';
        } else {
            teamStatsEl.style.display = 'none';
            teamStatsEl.textContent = '';
        }
    }

    // Header row
    const headerRow = document.createElement('tr');
    const thCheckbox = document.createElement('th');
    thCheckbox.style.width = '30px';
    thCheckbox.classList.add('roster-header');
    headerRow.appendChild(thCheckbox);
    const thName = document.createElement('th');
    thName.textContent = 'Name';
    thName.style.textAlign = 'left';
    thName.classList.add('roster-header');
    headerRow.appendChild(thName);

    if (hasStats) {
        statsColumns.forEach(col => {
            const th = document.createElement('th');
            th.textContent = col.label;
            th.classList.add('roster-header');
            headerRow.appendChild(th);
        });
    }
    tbody.appendChild(headerRow);

    // Team player rows
    const rowStats = [];
    const roster = currentTeam ? currentTeam.teamRoster : [];
    roster.forEach(player => {
        const ps = eventPlayerStats[player.id] || {};
        if (hasStats) rowStats.push(ps);
        const row = createEventRosterPlayerRow(player, ps, hasStats, statsColumns, {
            isPickup: false,
            checked: eventRosterPlayerIds.has(player.id),
            onCheckChange: (checked) => {
                if (checked) eventRosterPlayerIds.add(player.id);
                else eventRosterPlayerIds.delete(player.id);
            }
        });
        tbody.appendChild(row);
    });

    // Pickup player rows
    eventRosterPickups.forEach((pickup, idx) => {
        const ps = eventPlayerStats[pickup.id] || {};
        if (hasStats) rowStats.push(ps);
        const row = createEventRosterPlayerRow(pickup, ps, hasStats, statsColumns, {
            isPickup: true,
            pickupIndex: idx
        });
        tbody.appendChild(row);
    });

    // Team aggregate row
    if (hasStats) {
        const totals = sumPlayerStats(rowStats);
        const aggRow = buildRosterRow([
            { value: '', className: 'team-total-cell' },
            { value: 'Team', className: ['roster-name-column', 'team-total-cell'] },
            ...statsColumns.map(col => ({ value: col.value(totals), className: 'team-total-cell' }))
        ]);
        aggRow.classList.add('team-aggregate-row');

        tbody.appendChild(aggRow);
    }

    // Attach sort controller
    if (typeof createTableSortController === 'function') {
        const columns = [
            { key: 'checkbox', type: 'checkbox', colIndex: 0 },
            { key: 'name', type: 'string', colIndex: 1 }
        ];
        if (hasStats) {
            // Column indices shift with the stats level, so derive them.
            statsColumns.forEach((col, i) => {
                columns.push({ key: col.key, type: col.type, colIndex: i + 2 });
            });
        }
        eventRosterSortController = createTableSortController({
            getHeaderRow: () => tbody.querySelector('tr:first-child'),
            getDataRows: () => Array.from(tbody.querySelectorAll('tr:not(:first-child):not(.team-aggregate-row)')),
            getAggregateRows: () => Array.from(tbody.querySelectorAll('.team-aggregate-row')),
            getTbody: () => tbody,
            columns
        });
        eventRosterSortController.attach();

        // Restore previous sort state if re-rendering
        if (eventRosterSortState) {
            eventRosterSortController.sort(eventRosterSortState.key, eventRosterSortState.direction);
        }
    }
    if (typeof attachStatsColumnHelp === 'function') {
        attachStatsColumnHelp(tbody.querySelector('tr:first-child'));
    }
}

/**
 * Build a player row for the event roster table.
 * @param {object} player - roster player or pickup
 * @param {object} ps - this player's stats from eventPlayerStats (or {})
 * @param {boolean} hasStats - whether the table is showing stat columns at all
 * @param {Array<object>} statsColumns - the columns the active level shows
 * @param {object} options - {isPickup, checked, onCheckChange, pickupIndex}
 */
function createEventRosterPlayerRow(player, ps, hasStats, statsColumns, options) {
    const displayName = typeof formatPlayerName === 'function' ? formatPlayerName(player) : player.name;
    const nameClasses = [];
    if (player.gender === Gender.FMP) nameClasses.push('player-fmp');
    else if (player.gender === Gender.MMP) nameClasses.push('player-mmp');

    let checkCell;
    if (options.isPickup) {
        checkCell = { value: '', style: { textAlign: 'center' } };
    } else {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = options.checked;
        checkbox.onchange = () => options.onCheckChange(checkbox.checked);
        checkCell = { element: checkbox, style: { textAlign: 'center' } };
    }

    // Mark team players that carry a per-event position/line override.
    const hasOverride = !options.isPickup
        && !!(eventRosterOverrides[player.id]
            && (eventRosterOverrides[player.id].position || eventRosterOverrides[player.id].defaultLine));

    const nameCell = {
        value: options.isPickup ? `${displayName} (pickup)` : (hasOverride ? `${displayName} ✎` : displayName),
        className: nameClasses.length ? nameClasses : undefined
    };
    if (options.isPickup) {
        nameCell.style = { cursor: 'pointer' };
        nameCell.onClick = () => {
            showEditPlayerDialog(player, {
                context: 'pickup',
                onSave: (updated) => {
                    Object.assign(player, updated);
                    renderEventRosterTable();
                },
                onDelete: () => {
                    eventRosterPickups.splice(options.pickupIndex, 1);
                    renderEventRosterTable();
                    closeEditPlayerDialog();
                }
            });
        };
    } else {
        // Team player: tap the name to set/clear a per-event position/line override.
        nameCell.style = { cursor: 'pointer' };
        nameCell.onClick = () => openEventOverrideDialog(player);
    }

    const cells = [checkCell, nameCell];
    if (hasStats) {
        statsColumns.forEach(col => cells.push({ value: col.value(ps) }));
    }

    const row = buildRosterRow(cells);
    if (options.isPickup) row.className = 'pickup-row';
    return row;
}

/**
 * Open the edit dialog in event-override mode for a team player, letting the
 * coach set (or clear) a per-event position/line override without touching the
 * base player. Writes into eventRosterOverrides; persisted by saveEventRoster.
 * @param {object} player - team roster player (live ref)
 */
function openEventOverrideDialog(player) {
    const ov = eventRosterOverrides[player.id] || {};
    const hasOverride = !!(ov.position || ov.defaultLine);
    showEditPlayerDialog(player, {
        context: 'eventOverride',
        hasOverride,
        overridePosition: ov.position || null,
        overrideDefaultLine: ov.defaultLine || null,
        // Inherited (base-player) values shown greyed while not overriding.
        inheritedPosition: player.position || null,
        inheritedDefaultLine: player.defaultLine || null,
        onSave: (result) => {
            if (result.override) {
                eventRosterOverrides[player.id] = {
                    position: result.position || null,
                    defaultLine: result.defaultLine || null
                };
            } else {
                delete eventRosterOverrides[player.id];
            }
            renderEventRosterTable();
            // Persist immediately — the dialog Confirm is a deliberate action,
            // so the override must survive leaving the screen without also
            // requiring the separate roster Save button. Surface failures.
            persistEventRoster().catch(err => {
                console.error('Failed to save event override:', err);
                alert('Failed to save override: ' + (err && err.message ? err.message : err));
            });
        }
    });
}

/**
 * Add a pickup player to the event roster
 * @param {string} gender - Gender value (Gender.FMP, Gender.MMP, or Gender.UNKNOWN)
 */
function addEventPickupPlayer(gender) {
    const nameInput = document.getElementById('eventNewPlayerInput');
    const numberInput = document.getElementById('eventNewPlayerNumberInput');
    if (!nameInput) return;

    const name = nameInput.value.trim();
    if (!name) return;

    const rawNumber = numberInput ? numberInput.value.trim() : '';
    const number = rawNumber ? validateJerseyNumber(rawNumber) : null;
    // If validation was cancelled (returned null when input was provided), don't add
    if (rawNumber && number === null) return;

    const id = 'Pickup-' + generateShortId(name);
    eventRosterPickups.push({ id, name, gender, number });

    renderEventRosterTable();

    // Clear inputs
    nameInput.value = '';
    if (numberInput) numberInput.value = '';
    nameInput.focus();
}

/**
 * Save the event roster to the cloud
 */
/**
 * Build the updated event object from the current editor state (attendance,
 * pickups, and per-event overrides). Overrides are pruned to on-roster players.
 * @returns {object|null}
 */
function buildUpdatedEventFromState() {
    if (!currentEventRosterEvent) return null;

    // Persist only overrides for players still on the roster (drop stale ones).
    const overrides = {};
    Object.keys(eventRosterOverrides).forEach(id => {
        const ov = eventRosterOverrides[id];
        if (eventRosterPlayerIds.has(id) && ov && (ov.position || ov.defaultLine)) {
            overrides[id] = ov;
        }
    });

    return {
        ...currentEventRosterEvent,
        roster: {
            playerIds: [...eventRosterPlayerIds],
            pickupPlayers: eventRosterPickups,
            overrides
        }
    };
}

/**
 * Persist the current editor state to the cloud WITHOUT navigating away. Also
 * refreshes the in-memory currentEvent (so per-event position/line overrides
 * take effect immediately in a running game's Line tab — getEffective* read
 * currentEvent) and currentEventRosterEvent (so later edits spread fresh data).
 * Throws on failure so callers can surface it.
 */
async function persistEventRoster() {
    const updatedEvent = buildUpdatedEventFromState();
    if (!updatedEvent) return;

    if (currentEvent && currentEvent.id === updatedEvent.id
        && typeof setCurrentEvent === 'function' && typeof deserializeTournamentEvent === 'function') {
        setCurrentEvent(deserializeTournamentEvent(updatedEvent));
    }
    currentEventRosterEvent = updatedEvent;

    await updateEventOnCloud(updatedEvent.id, updatedEvent);
}

async function saveEventRoster() {
    if (!currentEventRosterEvent) return;
    try {
        await persistEventRoster();
        showScreen('selectTeamScreen');
    } catch (error) {
        alert('Failed to save roster: ' + error.message);
    }
}

/**
 * Navigate back from event roster without saving
 */
function backFromEventRoster() {
    showScreen('selectTeamScreen');
}

/**
 * Export event roster stats to an .xlsx workbook: an "All games" sheet, then
 * one per declared phase, then one per individual game ("v. <opponent>").
 * Only checked team players are included; pickups always export. Columns
 * follow whatever the Stats menu is set to at export time.
 */
async function exportEventRosterXLSX() {
    const event = currentEventRosterEvent;
    if (!event) return;
    const exportBtn = document.getElementById('exportEventRosterBtn');
    const origText = exportBtn ? exportBtn.innerHTML : '';
    if (exportBtn) { exportBtn.disabled = true; exportBtn.textContent = 'Building…'; }

    try {
        // Build the attending-players list once (checked team + pickups)
        const roster = currentTeam ? currentTeam.teamRoster : [];
        const attendingTeamPlayers = roster.filter(p => eventRosterPlayerIds.has(p.id));
        const players = [...attendingTeamPlayers, ...eventRosterPickups];

        // Reuse the games the screen already loaded when they're for this event.
        const allGames = (cachedEventGames && cachedEventGames.eventId === event.id)
            ? cachedEventGames.games
            : await loadEventGames(event);

        // Sheets: "All games" first, then one per phase, then one per game.
        const sheetSpecs = [{ label: 'All games', filter: {} }];
        (event.phases || []).forEach(p => sheetSpecs.push({ label: p, filter: { phase: p }, skipIfEmpty: true }));
        allGames.forEach(g => sheetSpecs.push({ label: formatGameLabel(g), filter: { gameId: g.id } }));

        const level = getStatsLevel();
        const usedSheetNames = new Set();
        const wb = XLSX.utils.book_new();
        for (const spec of sheetSpecs) {
            const games = filterGames(allGames, spec.filter);
            const teamStats = getGamesTeamStats(games);
            // Skip empty phase sheets (no points played in that phase)
            if (spec.skipIfEmpty && teamStats.total === 0) continue;

            const playerStats = getGamesPlayerStats(games);
            const title = `${event.name} — ${spec.label}`;
            const aoa = buildStatsSheetAoA(players, playerStats, teamStats, { titleRow: title, level });
            const ws = aoaToFormattedSheet(aoa);
            XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(spec.label, usedSheetNames));
        }

        downloadWorkbook(wb, `${safeFilename(event.name)}-stats.xlsx`);
    } catch (e) {
        console.error('Event xlsx export failed:', e);
        alert('Export failed: ' + e.message);
    } finally {
        if (exportBtn) { exportBtn.disabled = false; exportBtn.innerHTML = origText; }
    }
}

// Event listeners (IIFE matching rosterManagement.js pattern)
(function initializeEventRoster() {
    document.getElementById('eventAddFMPBtn')?.addEventListener('click', () => addEventPickupPlayer(Gender.FMP));
    document.getElementById('eventAddMMPBtn')?.addEventListener('click', () => addEventPickupPlayer(Gender.MMP));
    document.getElementById('saveEventRosterBtn')?.addEventListener('click', saveEventRoster);
    document.getElementById('backFromEventRosterBtn')?.addEventListener('click', backFromEventRoster);
    document.getElementById('exportEventRosterBtn')?.addEventListener('click', exportEventRosterXLSX);

    const nameInput = document.getElementById('eventNewPlayerInput');
    if (nameInput) {
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addEventPickupPlayer(Gender.UNKNOWN);
        });
    }
})();

// --- ES-module export; consumed only by teams/eventDialogs.js (converted),
// --- so no window.* shim is needed.
export { showEventRosterUI };
