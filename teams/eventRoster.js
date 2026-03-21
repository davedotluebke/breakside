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
 * Render the event roster table rows
 */
function renderEventRosterTable() {
    const tbody = document.getElementById('eventRosterList');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Header row
    const headerRow = document.createElement('tr');
    const thCheckbox = document.createElement('th');
    thCheckbox.style.width = '30px';
    headerRow.appendChild(thCheckbox);
    const thName = document.createElement('th');
    thName.textContent = 'Name';
    thName.style.textAlign = 'left';
    headerRow.appendChild(thName);
    tbody.appendChild(headerRow);

    // Team player rows
    const roster = currentTeam ? currentTeam.teamRoster : [];
    roster.forEach(player => {
        const row = document.createElement('tr');

        // Checkbox cell
        const tdCheck = document.createElement('td');
        tdCheck.style.textAlign = 'center';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = eventRosterPlayerIds.has(player.id);
        checkbox.onchange = () => {
            if (checkbox.checked) {
                eventRosterPlayerIds.add(player.id);
            } else {
                eventRosterPlayerIds.delete(player.id);
            }
        };
        tdCheck.appendChild(checkbox);
        row.appendChild(tdCheck);

        // Name cell (read-only for team players)
        const tdName = document.createElement('td');
        tdName.textContent = player.name;
        if (player.gender === Gender.FMP) tdName.classList.add('player-fmp');
        else if (player.gender === Gender.MMP) tdName.classList.add('player-mmp');
        row.appendChild(tdName);

        tbody.appendChild(row);
    });

    // Pickup player rows
    eventRosterPickups.forEach((pickup, idx) => {
        const row = document.createElement('tr');
        row.className = 'pickup-row';

        // Empty checkbox cell (pickups are always included)
        const tdCheck = document.createElement('td');
        row.appendChild(tdCheck);

        // Name cell (clickable to edit)
        const tdName = document.createElement('td');
        tdName.textContent = `${pickup.name} (pickup)`;
        if (pickup.gender === Gender.FMP) tdName.classList.add('player-fmp');
        else if (pickup.gender === Gender.MMP) tdName.classList.add('player-mmp');
        tdName.style.cursor = 'pointer';
        tdName.onclick = () => {
            showEditPlayerDialog(pickup, {
                context: 'pickup',
                onSave: (updated) => {
                    Object.assign(pickup, updated);
                    renderEventRosterTable();
                },
                onDelete: () => {
                    eventRosterPickups.splice(idx, 1);
                    renderEventRosterTable();
                    closeEditPlayerDialog();
                }
            });
        };
        row.appendChild(tdName);

        tbody.appendChild(row);
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
