/*
 * Event Roster Management
 * Manages the roster for a TournamentEvent: select attending players and add pickups.
 * Table-based layout matching team roster UI pattern.
 */

// Module-level state
let currentEventRosterEvent = null;
let eventRosterPlayerIds = new Set();
let eventRosterPickups = [];
let cachedEventStats = null; // { eventId, phase, playerStats, teamStats, record } — avoids re-fetching on re-renders
let eventRosterSortController = null;
let eventRosterSortState = null; // persists sort across re-renders
let eventRosterPhaseFilter = null; // null = "All phases"

/**
 * Show the event roster UI for editing an event's roster
 * @param {object} event - The event data object from the server
 */
function showEventRosterUI(event) {
    currentEventRosterEvent = event;
    cachedEventStats = null; // clear cache for fresh load
    eventRosterSortState = null; // reset sort for new event
    eventRosterPhaseFilter = null; // reset to "All" when opening a new event
    renderEventRosterPhaseFilter();

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

    // Set header (will be updated with record after stats load)
    const header = document.getElementById('eventRosterHeader');
    if (header) {
        const hasGameIds = (event.gameIds || []).length > 0;
        header.textContent = hasGameIds
            ? `${event.name} — Loading stats...`
            : `${event.name} — Roster`;
    }

    showScreen('eventRosterScreen');
    renderEventRosterTable();
}

/**
 * Render the phase-filter row. Hidden if the event has no phases defined.
 */
function renderEventRosterPhaseFilter() {
    const row = document.getElementById('eventRosterPhaseFilterRow');
    const select = document.getElementById('eventRosterPhaseFilter');
    if (!row || !select) return;
    const phases = currentEventRosterEvent?.phases || [];
    if (phases.length === 0) {
        row.style.display = 'none';
        return;
    }
    row.style.display = '';
    select.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All phases';
    select.appendChild(allOpt);
    phases.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        select.appendChild(opt);
    });
    select.value = eventRosterPhaseFilter || '';
    select.onchange = () => {
        eventRosterPhaseFilter = select.value || null;
        cachedEventStats = null;
        renderEventRosterTable();
    };
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

    // Load event stats and record from cloud (games aren't in local state)
    const event = currentEventRosterEvent;
    let eventPlayerStats = {};
    let record = null;
    let teamStats = null;
    const eventId = event?.id;
    const phase = eventRosterPhaseFilter;
    const hasGameIds = (event?.gameIds || []).length > 0;

    if (hasGameIds && typeof getEventPlayerStats === 'function') {
        // Use cache if available for this event + phase
        if (cachedEventStats && cachedEventStats.eventId === eventId && cachedEventStats.phase === phase) {
            eventPlayerStats = cachedEventStats.playerStats;
            record = cachedEventStats.record;
            teamStats = cachedEventStats.teamStats;
        } else {
            try {
                const opts = phase ? { phase } : {};
                [eventPlayerStats, record, teamStats] = await Promise.all([
                    getEventPlayerStats(event, opts),
                    typeof getEventRecord === 'function' ? getEventRecord(event, opts) : null,
                    typeof getEventTeamStats === 'function' ? getEventTeamStats(event, opts) : null
                ]);
                cachedEventStats = { eventId, phase, playerStats: eventPlayerStats, teamStats, record };
            } catch (e) {
                console.error('Error loading event stats:', e);
            }
        }
    }

    const hasStats = Object.keys(eventPlayerStats).length > 0;

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
        const phaseStr = phase ? ` — ${phase}` : '';
        header.textContent = `${event.name}${phaseStr}${recordStr}`;
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
        ['Pts', 'Time', 'Goals', 'Assists', 'HA', 'Huck HA', 'Comp%', 'Huck%', 'Ds', 'TOs', '+/-', '..per pt'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            th.classList.add('roster-header');
            headerRow.appendChild(th);
        });
    }
    tbody.appendChild(headerRow);

    // Aggregate totals
    const totals = {
        pointsPlayed: 0, timePlayed: 0, goals: 0, assists: 0,
        hockeyAssists: 0, huckHockeyAssists: 0,
        completions: 0, totalThrows: 0, huckCompletions: 0, totalHucks: 0,
        dPlays: 0, turnovers: 0, plusMinus: 0
    };

    // Team player rows
    const roster = currentTeam ? currentTeam.teamRoster : [];
    roster.forEach(player => {
        const computed = computeEventRosterPlayerStats(eventPlayerStats[player.id] || {});
        if (hasStats) accumulateEventRosterTotals(totals, computed);
        const row = createEventRosterPlayerRow(player, computed, hasStats, {
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
        const computed = computeEventRosterPlayerStats(eventPlayerStats[pickup.id] || {});
        if (hasStats) accumulateEventRosterTotals(totals, computed);
        const row = createEventRosterPlayerRow(pickup, computed, hasStats, {
            isPickup: true,
            pickupIndex: idx
        });
        tbody.appendChild(row);
    });

    // Team aggregate row
    if (hasStats) {
        const totalPoints = totals.pointsPlayed > 0 ? totals.pointsPlayed : 0;
        const pmPerPt = totalPoints > 0 ? (totals.plusMinus / totalPoints).toFixed(2) : '0.0';

        const aggValues = [
            totals.pointsPlayed,
            typeof formatPlayTime === 'function' ? formatPlayTime(totals.timePlayed) : '',
            totals.goals,
            totals.assists,
            totals.hockeyAssists,
            totals.huckHockeyAssists,
            formatPercentOrDash(totals.completions, totals.totalThrows),
            formatPercentOrDash(totals.huckCompletions, totals.totalHucks),
            totals.dPlays,
            totals.turnovers,
            formatSigned(totals.plusMinus),
            formatSigned(pmPerPt)
        ];

        const aggRow = buildRosterRow([
            { value: '', className: 'team-total-cell' },
            { value: 'Team', className: ['roster-name-column', 'team-total-cell'] },
            ...aggValues.map(val => ({ value: val, className: 'team-total-cell' }))
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
            columns.push(
                { key: 'pts', type: 'number', colIndex: 2 },
                { key: 'time', type: 'time', colIndex: 3 },
                { key: 'goals', type: 'number', colIndex: 4 },
                { key: 'assists', type: 'number', colIndex: 5 },
                { key: 'hockeyAssists', type: 'number', colIndex: 6 },
                { key: 'huckHockeyAssists', type: 'number', colIndex: 7 },
                { key: 'compPct', type: 'percentage', colIndex: 8 },
                { key: 'huckPct', type: 'percentage', colIndex: 9 },
                { key: 'ds', type: 'number', colIndex: 10 },
                { key: 'tos', type: 'number', colIndex: 11 },
                { key: 'plusMinus', type: 'number', colIndex: 12 },
                { key: 'pmPerPt', type: 'number', colIndex: 13 }
            );
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
 * Compute the display values and raw stat contributions for one event-roster
 * row. Pure — does not touch the `totals` accumulator (see
 * accumulateEventRosterTotals) and does not build any DOM.
 * @param {Object} ps - this player's stats from eventPlayerStats (or {})
 */
function computeEventRosterPlayerStats(ps) {
    const pts = ps.pointsPlayed || 0;
    const time = ps.timePlayed || 0;
    const goals = ps.goals || 0;
    const assists = ps.assists || 0;
    const hockeyAssists = ps.hockeyAssists || 0;
    const huckHockeyAssists = ps.huckHockeyAssists || 0;
    const completions = ps.completions || 0;
    const totalThrows = ps.totalThrows || 0;
    const huckCompletions = ps.huckCompletions || 0;
    const totalHucks = ps.totalHucks || 0;
    const dPlays = ps.dPlays || 0;
    const turnovers = ps.turnovers || 0;
    const pm = ps.plusMinus || 0;
    const pmPerPt = pts > 0 ? (pm / pts).toFixed(2) : '0.0';

    return {
        pts, time, goals, assists, hockeyAssists, huckHockeyAssists,
        completions, totalThrows, huckCompletions, totalHucks, dPlays, turnovers, pm,
        values: [
            pts,
            typeof formatPlayTime === 'function' ? formatPlayTime(time) : '0:00',
            goals,
            assists,
            hockeyAssists,
            huckHockeyAssists,
            formatPercentOrDash(completions, totalThrows),
            formatPercentOrDash(huckCompletions, totalHucks),
            dPlays,
            turnovers,
            formatSigned(pm),
            formatSigned(pmPerPt)
        ]
    };
}

/**
 * Add one player's raw stat contributions into the shared event-roster
 * totals accumulator. Call once per row, separately from row construction.
 */
function accumulateEventRosterTotals(totals, computed) {
    totals.pointsPlayed += computed.pts;
    totals.timePlayed += computed.time;
    totals.goals += computed.goals;
    totals.assists += computed.assists;
    totals.hockeyAssists += computed.hockeyAssists;
    totals.huckHockeyAssists += computed.huckHockeyAssists;
    totals.completions += computed.completions;
    totals.totalThrows += computed.totalThrows;
    totals.huckCompletions += computed.huckCompletions;
    totals.totalHucks += computed.totalHucks;
    totals.dPlays += computed.dPlays;
    totals.turnovers += computed.turnovers;
    totals.plusMinus += computed.pm;
}

/**
 * Build a player row for the event roster table from precomputed stats.
 */
function createEventRosterPlayerRow(player, computed, hasStats, options) {
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

    const nameCell = {
        value: options.isPickup ? `${displayName} (pickup)` : displayName,
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
    }

    const cells = [checkCell, nameCell];
    if (hasStats) {
        computed.values.forEach(val => cells.push({ value: val }));
    }

    const row = buildRosterRow(cells);
    if (options.isPickup) row.className = 'pickup-row';
    return row;
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
async function saveEventRoster() {
    if (!currentEventRosterEvent) return;

    const updatedEvent = {
        ...currentEventRosterEvent,
        roster: {
            playerIds: [...eventRosterPlayerIds],
            pickupPlayers: eventRosterPickups
        }
    };

    try {
        await updateEventOnCloud(currentEventRosterEvent.id, updatedEvent);
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
 * Export event roster stats to an .xlsx workbook with one sheet per phase
 * (plus an "All phases" sheet at the front when phases are configured).
 * Only checked team players are included; pickups always export.
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

        // Build the sheet list: "All phases" first, then one per phase.
        // (If no phases configured, just one "All" sheet.)
        const phases = event.phases || [];
        const sheetSpecs = [{ label: 'All phases', phase: null }];
        phases.forEach(p => sheetSpecs.push({ label: p, phase: p }));

        const wb = XLSX.utils.book_new();
        for (const spec of sheetSpecs) {
            const opts = spec.phase ? { phase: spec.phase } : {};
            const [playerStats, teamStats] = await Promise.all([
                getEventPlayerStats(event, opts),
                typeof getEventTeamStats === 'function' ? getEventTeamStats(event, opts) : null
            ]);
            // Skip empty phase sheets (no points played in that phase)
            if (spec.phase && (!teamStats || teamStats.total === 0)) continue;

            const title = `${event.name} — ${spec.label}`;
            const aoa = buildStatsSheetAoA(players, playerStats, teamStats, { titleRow: title });
            const ws = aoaToFormattedSheet(aoa);
            XLSX.utils.book_append_sheet(wb, ws, safeSheetName(spec.label));
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

window.showEventRosterUI = showEventRosterUI;
