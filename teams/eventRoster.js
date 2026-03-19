/*
 * Event Roster Management
 * Manages the roster for a TournamentEvent: select attending players and add pickups.
 */

/**
 * Show the event roster UI for editing an event's roster
 * @param {object} event - The event data object from the server
 */
function showEventRosterUI(event) {
    // Remove existing screen if any
    let screen = document.getElementById('eventRosterScreen');
    if (!screen) {
        screen = document.createElement('section');
        screen.id = 'eventRosterScreen';
        screen.style.display = 'none';
        document.body.insertBefore(screen, document.querySelector('script'));
    }

    // Build the screen content
    screen.innerHTML = `
        <div class="settings-header">
            <button id="backFromEventRosterBtn" class="back-button">
                <i class="fas fa-arrow-left"></i> Back
            </button>
            <h2>${event.name} — Roster</h2>
        </div>
        <div class="event-roster-content">
            <h3>Team Players</h3>
            <p class="section-description">Uncheck players not attending this event</p>
            <div id="eventRosterPlayerList" class="event-roster-player-list"></div>

            <h3>Pickup Players</h3>
            <div id="eventPickupList" class="event-pickup-list"></div>
            <div class="event-pickup-add">
                <input type="text" id="pickupNameInput" placeholder="Name" style="flex:2;">
                <select id="pickupGenderInput" style="flex:1;">
                    <option value="MMP">MMP</option>
                    <option value="FMP">FMP</option>
                    <option value="Unknown">Unknown</option>
                </select>
                <input type="text" id="pickupNumberInput" placeholder="#" style="width:40px;">
                <button id="addPickupBtn" class="primary-btn" style="flex:0;">Add</button>
            </div>

            <button id="saveEventRosterBtn" class="primary-btn" style="width:100%; margin-top:1rem;">Save Roster</button>
        </div>
    `;

    // Register in screens array if not already
    const screens = [
        document.getElementById('selectTeamScreen'),
        document.getElementById('teamRosterScreen'),
        document.getElementById('teamSettingsScreen'),
        document.getElementById('gameSummaryScreen'),
        screen
    ];

    // Show screen
    screens.forEach(s => { if (s) s.style.display = 'none'; });
    screen.style.display = 'block';
    const headerElement = document.querySelector('header');
    if (headerElement) {
        headerElement.classList.remove('header-compact');
        headerElement.classList.add('header-full');
    }

    // Populate team player checkboxes
    const playerListEl = document.getElementById('eventRosterPlayerList');
    const roster = currentTeam ? currentTeam.teamRoster : [];
    const eventPlayerIds = new Set(event.roster?.playerIds || []);

    roster.forEach(player => {
        const row = document.createElement('label');
        row.className = 'event-roster-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = eventPlayerIds.size === 0 || eventPlayerIds.has(player.id);
        checkbox.dataset.playerId = player.id;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = player.name;
        if (player.gender === 'FMP') nameSpan.classList.add('player-fmp');
        else if (player.gender === 'MMP') nameSpan.classList.add('player-mmp');

        row.appendChild(checkbox);
        row.appendChild(nameSpan);
        playerListEl.appendChild(row);
    });

    // Populate existing pickups
    const pickupListEl = document.getElementById('eventPickupList');
    const pickups = [...(event.roster?.pickupPlayers || [])];

    function renderPickups() {
        pickupListEl.innerHTML = '';
        pickups.forEach((pickup, idx) => {
            const row = document.createElement('div');
            row.className = 'event-roster-row pickup-row';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = `${pickup.name} (${pickup.gender || '?'})${pickup.number ? ' #' + pickup.number : ''}`;
            row.appendChild(nameSpan);

            const removeBtn = document.createElement('button');
            removeBtn.innerHTML = '<i class="fas fa-times"></i>';
            removeBtn.className = 'icon-button';
            removeBtn.style.color = '#dc3545';
            removeBtn.onclick = () => {
                pickups.splice(idx, 1);
                renderPickups();
            };
            row.appendChild(removeBtn);

            pickupListEl.appendChild(row);
        });
    }
    renderPickups();

    // Add pickup button
    document.getElementById('addPickupBtn').onclick = () => {
        const name = document.getElementById('pickupNameInput').value.trim();
        if (!name) return;
        const gender = document.getElementById('pickupGenderInput').value;
        const number = document.getElementById('pickupNumberInput').value.trim() || null;
        const id = typeof generateShortId === 'function'
            ? 'Pickup-' + generateShortId(name)
            : 'pickup-' + Math.random().toString(36).substr(2, 8);

        pickups.push({ id, name, gender, number });
        renderPickups();

        document.getElementById('pickupNameInput').value = '';
        document.getElementById('pickupNumberInput').value = '';
    };

    // Back button
    document.getElementById('backFromEventRosterBtn').onclick = () => {
        screen.style.display = 'none';
        showScreen('selectTeamScreen');
    };

    // Save button
    document.getElementById('saveEventRosterBtn').onclick = async () => {
        // Collect checked player IDs
        const checkedIds = [];
        playerListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (cb.checked) checkedIds.push(cb.dataset.playerId);
        });

        const updatedEvent = {
            ...event,
            roster: {
                playerIds: checkedIds,
                pickupPlayers: pickups
            }
        };

        try {
            await updateEventOnCloud(event.id, updatedEvent);
            screen.style.display = 'none';
            showScreen('selectTeamScreen');
        } catch (error) {
            alert('Failed to save roster: ' + error.message);
        }
    };
}

window.showEventRosterUI = showEventRosterUI;
