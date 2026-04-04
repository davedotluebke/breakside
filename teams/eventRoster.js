/*
 * Event Roster Management
 * Manages the roster for a TournamentEvent: select attending players and add pickups.
 * Table-based layout matching team roster UI pattern.
 */

// Module-level state
let currentEventRosterEvent = null;
let eventRosterPlayerIds = new Set();
let eventRosterPickups = [];

/**
 * Show the event roster UI for editing an event's roster
 * @param {object} event - The event data object from the server
 */
function showEventRosterUI(event) {
    currentEventRosterEvent = event;

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

    // Set header
    const header = document.getElementById('eventRosterHeader');
    if (header) header.textContent = `${event.name} — Roster`;

    renderEventRosterTable();
    showScreen('eventRosterScreen');
}

/**
 * Render the event roster table rows with full event statistics
 */
function renderEventRosterTable() {
    const tbody = document.getElementById('eventRosterList');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Compute event stats and record
    const eventId = currentEventRosterEvent ? currentEventRosterEvent.id : null;
    const eventPlayerStats = eventId && typeof getEventPlayerStats === 'function'
        ? getEventPlayerStats(eventId) : {};
    const hasStats = Object.keys(eventPlayerStats).length > 0;
    const record = eventId && typeof getEventRecord === 'function'
        ? getEventRecord(eventId) : null;

    // Update header with record if available
    const header = document.getElementById('eventRosterHeader');
    if (header && currentEventRosterEvent) {
        const recordStr = record && (record.wins + record.losses + record.ties) > 0
            ? ` (${record.wins}W-${record.losses}L${record.ties ? `-${record.ties}T` : ''})`
            : '';
        header.textContent = `${currentEventRosterEvent.name}${recordStr}`;
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
        ['Pts', 'Time', 'Goals', 'Assists', 'Comp%', 'Huck%', 'Ds', 'TOs', '+/-', '..per pt'].forEach(text => {
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
        completions: 0, totalThrows: 0, huckCompletions: 0, totalHucks: 0,
        dPlays: 0, turnovers: 0, plusMinus: 0
    };

    // Team player rows
    const roster = currentTeam ? currentTeam.teamRoster : [];
    roster.forEach(player => {
        const row = createEventRosterPlayerRow(player, eventPlayerStats, hasStats, totals, {
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
        const row = createEventRosterPlayerRow(pickup, eventPlayerStats, hasStats, totals, {
            isPickup: true,
            pickupIndex: idx
        });
        tbody.appendChild(row);
    });

    // Team aggregate row
    if (hasStats) {
        const aggRow = document.createElement('tr');
        aggRow.classList.add('team-aggregate-row');

        const emptyCell = document.createElement('td');
        emptyCell.classList.add('team-total-cell');
        aggRow.appendChild(emptyCell);

        const teamCell = document.createElement('td');
        teamCell.textContent = 'Team';
        teamCell.classList.add('roster-name-column', 'team-total-cell');
        aggRow.appendChild(teamCell);

        const teamCompPct = totals.totalThrows > 0
            ? ((totals.completions / totals.totalThrows) * 100).toFixed(0) : '-';
        const teamHuckPct = totals.totalHucks > 0
            ? ((totals.huckCompletions / totals.totalHucks) * 100).toFixed(0) : '-';
        const totalPoints = totals.pointsPlayed > 0 ? totals.pointsPlayed : 0;
        const pmPerPt = totalPoints > 0 ? (totals.plusMinus / totalPoints).toFixed(2) : '0.0';

        const aggValues = [
            '', // Pts — not meaningful as team total
            typeof formatPlayTime === 'function' ? formatPlayTime(totals.timePlayed) : '',
            totals.goals,
            totals.assists,
            teamCompPct !== '-' ? `${teamCompPct}%` : teamCompPct,
            teamHuckPct !== '-' ? `${teamHuckPct}%` : teamHuckPct,
            totals.dPlays,
            totals.turnovers,
            totals.plusMinus > 0 ? `+${totals.plusMinus}` : totals.plusMinus,
            pmPerPt > 0 ? `+${pmPerPt}` : pmPerPt
        ];

        aggValues.forEach(val => {
            const td = document.createElement('td');
            td.textContent = val;
            td.classList.add('team-total-cell');
            aggRow.appendChild(td);
        });

        tbody.appendChild(aggRow);
    }
}

/**
 * Create a player row for the event roster table
 */
function createEventRosterPlayerRow(player, eventPlayerStats, hasStats, totals, options) {
    const row = document.createElement('tr');
    if (options.isPickup) row.className = 'pickup-row';

    // Checkbox cell
    const tdCheck = document.createElement('td');
    tdCheck.style.textAlign = 'center';
    if (!options.isPickup) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = options.checked;
        checkbox.onchange = () => options.onCheckChange(checkbox.checked);
        tdCheck.appendChild(checkbox);
    }
    row.appendChild(tdCheck);

    // Name cell
    const tdName = document.createElement('td');
    const displayName = typeof formatPlayerName === 'function' ? formatPlayerName(player) : player.name;
    tdName.textContent = options.isPickup ? `${displayName} (pickup)` : displayName;
    if (player.gender === Gender.FMP) tdName.classList.add('player-fmp');
    else if (player.gender === Gender.MMP) tdName.classList.add('player-mmp');

    if (options.isPickup) {
        tdName.style.cursor = 'pointer';
        tdName.onclick = () => {
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
    row.appendChild(tdName);

    // Stats cells
    if (hasStats) {
        const ps = eventPlayerStats[player.name] || {};
        const pts = ps.pointsPlayed || 0;
        const time = ps.timePlayed || 0;
        const goals = ps.goals || 0;
        const assists = ps.assists || 0;
        const completions = ps.completions || 0;
        const totalThrows = ps.totalThrows || 0;
        const huckCompletions = ps.huckCompletions || 0;
        const totalHucks = ps.totalHucks || 0;
        const dPlays = ps.dPlays || 0;
        const turnovers = ps.turnovers || 0;
        const pm = ps.plusMinus || 0;

        // Accumulate totals
        totals.pointsPlayed += pts;
        totals.timePlayed += time;
        totals.goals += goals;
        totals.assists += assists;
        totals.completions += completions;
        totals.totalThrows += totalThrows;
        totals.huckCompletions += huckCompletions;
        totals.totalHucks += totalHucks;
        totals.dPlays += dPlays;
        totals.turnovers += turnovers;
        totals.plusMinus += pm;

        const compPct = totalThrows > 0 ? ((completions / totalThrows) * 100).toFixed(0) : '-';
        const huckPct = totalHucks > 0 ? ((huckCompletions / totalHucks) * 100).toFixed(0) : '-';
        const pmPerPt = pts > 0 ? (pm / pts).toFixed(2) : '0.0';

        const values = [
            pts,
            typeof formatPlayTime === 'function' ? formatPlayTime(time) : '0:00',
            goals,
            assists,
            compPct !== '-' ? `${compPct}%` : compPct,
            huckPct !== '-' ? `${huckPct}%` : huckPct,
            dPlays,
            turnovers,
            pm > 0 ? `+${pm}` : pm,
            pmPerPt > 0 ? `+${pmPerPt}` : pmPerPt
        ];

        values.forEach(val => {
            const td = document.createElement('td');
            td.textContent = val;
            row.appendChild(td);
        });
    }

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

// Event listeners (IIFE matching rosterManagement.js pattern)
(function initializeEventRoster() {
    document.getElementById('eventAddFMPBtn')?.addEventListener('click', () => addEventPickupPlayer(Gender.FMP));
    document.getElementById('eventAddMMPBtn')?.addEventListener('click', () => addEventPickupPlayer(Gender.MMP));
    document.getElementById('saveEventRosterBtn')?.addEventListener('click', saveEventRoster);
    document.getElementById('backFromEventRosterBtn')?.addEventListener('click', backFromEventRoster);

    const nameInput = document.getElementById('eventNewPlayerInput');
    if (nameInput) {
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addEventPickupPlayer(Gender.UNKNOWN);
        });
    }
})();

window.showEventRosterUI = showEventRosterUI;
