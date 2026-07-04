/*
 * Event creation/settings dialogs and event-game start flow.
 * Split out of teamSelection.js (D2 refactor).
 */
import {
    authFetch, API_BASE_URL, updateEventOnCloud, deleteEventFromCloud,
    listServerGames, updateGamePhase,
} from '../store/sync.js';
import { setCurrentEvent, deserializeTournamentEvent } from '../store/storage.js';
import { showScreen } from '../screens/navigation.js';
import { selectCloudTeam, populateCloudTeamsAndGames } from './teamList.js';
import { showEventRosterUI } from './eventRoster.js';
import { generateGenderRatioOptions } from '../game/genderRatioDropdown.js';

/**
 * Show create event dialog
 */
function showCreateEventDialog(team) {
    // Remove existing dialog if any
    const existing = document.getElementById('createEventModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'createEventModal';
    modal.className = 'modal';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-content event-dialog">
            <div class="dialog-header prominent-dialog-header">
                <h2>New Event</h2>
                <span class="close">&times;</span>
            </div>
            <div class="event-dialog-body">
                <input type="text" id="newEventName" placeholder="Event Name" class="event-dialog-input">
                <div class="event-dialog-row">
                    <input type="number" id="newEventPlayersPerSide" value="7" min="2" max="7" class="event-dialog-number">
                    <label for="newEventPlayersPerSide">Players On Field</label>
                </div>
                <div class="event-dialog-row">
                    <label for="newEventGenderRatio">Enforce Gender Ratio:</label>
                    <select id="newEventGenderRatio" class="event-dialog-select"></select>
                </div>
                <div class="event-dialog-row">
                    <label><input type="checkbox" id="newEventAltPulls"> Alternate Gender Pulls</label>
                </div>
                <button id="createEventBtn" class="event-dialog-submit">Create Event</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Populate gender ratio dropdown using existing helper
    const playerCountInput = document.getElementById('newEventPlayersPerSide');
    const ratioSelect = document.getElementById('newEventGenderRatio');

    function refreshRatioOptions() {
        const count = parseInt(playerCountInput.value, 10) || 7;
        ratioSelect.innerHTML = '';
        if (typeof generateGenderRatioOptions === 'function') {
            generateGenderRatioOptions(count).forEach(opt => {
                const el = document.createElement('option');
                el.value = opt.value;
                el.textContent = opt.label;
                ratioSelect.appendChild(el);
            });
        }
    }
    refreshRatioOptions();
    playerCountInput.addEventListener('input', refreshRatioOptions);

    // Close handler
    modal.querySelector('.close').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    // Create handler
    document.getElementById('createEventBtn').onclick = async () => {
        const name = document.getElementById('newEventName').value.trim();
        if (!name) { alert('Event name is required'); return; }

        const eventData = {
            name: name,
            teamId: team.id,
            status: 'open',
            defaults: {
                alternateGenderRatio: ratioSelect.value,
                alternateGenderPulls: document.getElementById('newEventAltPulls').checked,
                playersPerSide: parseInt(playerCountInput.value) || 7
            },
            roster: {
                playerIds: team.playerIds || [],
                pickupPlayers: []
            }
        };

        const btn = document.getElementById('createEventBtn');
        btn.disabled = true;
        btn.textContent = 'Creating...';

        try {
            const response = await authFetch(`${API_BASE_URL}/api/events`, {
                method: 'POST',
                body: JSON.stringify(eventData)
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText);
            }
            modal.remove();
            populateCloudTeamsAndGames();
        } catch (error) {
            console.error('Create event error:', error);
            alert('Failed to create event: ' + error.message);
            btn.disabled = false;
            btn.textContent = 'Create Event';
        }
    };

    document.getElementById('newEventName').focus();
}

/**
 * Show event settings dialog
 */
function showEventSettingsDialog(event, team) {
    const existing = document.getElementById('eventSettingsModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'eventSettingsModal';
    modal.className = 'modal';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-content event-dialog">
            <div class="dialog-header prominent-dialog-header">
                <h2>Event Settings</h2>
                <span class="close">&times;</span>
            </div>
            <div class="event-dialog-body">
                <input type="text" id="editEventName" class="event-dialog-input" placeholder="Event Name">
                <div class="event-dialog-row">
                    <input type="number" id="editEventPlayersPerSide" min="2" max="7" class="event-dialog-number">
                    <label for="editEventPlayersPerSide">Players On Field</label>
                </div>
                <div class="event-dialog-row">
                    <label for="editEventGenderRatio">Enforce Gender Ratio:</label>
                    <select id="editEventGenderRatio" class="event-dialog-select"></select>
                </div>
                <div class="event-dialog-row">
                    <label><input type="checkbox" id="editEventAltPulls"> Alternate Gender Pulls</label>
                </div>
                <div class="event-dialog-row">
                    <label for="editEventStatus">Status:</label>
                    <select id="editEventStatus" class="event-dialog-select">
                        <option value="open">Open</option>
                        <option value="closed">Closed</option>
                    </select>
                </div>
                <div class="event-phases-section">
                    <label class="event-phases-label">Phases (Day 1, Pool play, Bracket, …):</label>
                    <ul id="editEventPhasesList" class="event-phases-list"></ul>
                    <div class="event-phases-add-row">
                        <input type="text" id="editEventPhaseInput" placeholder="Add phase…" class="event-dialog-input">
                        <button type="button" id="editEventPhaseAddBtn" class="event-phase-add-btn">Add</button>
                    </div>
                    <button type="button" id="editEventAutoPhaseByDayBtn" class="event-phase-auto-btn">
                        Auto-label phases by day
                    </button>
                </div>
                <button id="saveEventSettingsBtn" class="event-dialog-submit">Save</button>
                <button id="deleteEventBtn" class="event-dialog-delete">Delete Event</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Populate fields from event data
    document.getElementById('editEventName').value = event.name || '';
    document.getElementById('editEventPlayersPerSide').value = event.defaults?.playersPerSide || 7;
    document.getElementById('editEventAltPulls').checked = event.defaults?.alternateGenderPulls || false;
    document.getElementById('editEventStatus').value = event.status || 'open';

    // Phases editor — mutable working copy, persisted on Save
    let editPhases = [...(event.phases || [])];
    function renderPhasesList() {
        const list = document.getElementById('editEventPhasesList');
        if (!list) return;
        list.innerHTML = '';
        editPhases.forEach((p, idx) => {
            const li = document.createElement('li');
            li.className = 'event-phases-item';
            const label = document.createElement('span');
            label.textContent = p;
            label.className = 'event-phases-item-label';
            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
            upBtn.className = 'icon-button';
            upBtn.title = 'Move up';
            upBtn.disabled = idx === 0;
            upBtn.onclick = () => {
                [editPhases[idx - 1], editPhases[idx]] = [editPhases[idx], editPhases[idx - 1]];
                renderPhasesList();
            };
            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
            downBtn.className = 'icon-button';
            downBtn.title = 'Move down';
            downBtn.disabled = idx === editPhases.length - 1;
            downBtn.onclick = () => {
                [editPhases[idx + 1], editPhases[idx]] = [editPhases[idx], editPhases[idx + 1]];
                renderPhasesList();
            };
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.innerHTML = '<i class="fas fa-trash icon-danger"></i>';
            delBtn.className = 'icon-button';
            delBtn.title = 'Remove phase';
            delBtn.onclick = () => {
                editPhases.splice(idx, 1);
                renderPhasesList();
            };
            li.appendChild(label);
            li.appendChild(upBtn);
            li.appendChild(downBtn);
            li.appendChild(delBtn);
            list.appendChild(li);
        });
    }
    renderPhasesList();

    const phaseInput = document.getElementById('editEventPhaseInput');
    const phaseAddBtn = document.getElementById('editEventPhaseAddBtn');
    function addPhase() {
        const v = (phaseInput.value || '').trim();
        if (!v) return;
        if (editPhases.includes(v)) {
            alert('Phase already exists');
            return;
        }
        editPhases.push(v);
        phaseInput.value = '';
        renderPhasesList();
        phaseInput.focus();
    }
    phaseAddBtn.onclick = addPhase;
    phaseInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addPhase(); }
    });

    // Auto-label phases by day — groups the event's games by calendar start
    // date (local time), assigns "Day 1", "Day 2", … phases in date order,
    // and PATCHes each game. One-shot action; warns before overwriting
    // existing phase labels.
    const autoBtn = document.getElementById('editEventAutoPhaseByDayBtn');
    if (autoBtn) {
        autoBtn.onclick = async () => {
            const eventGameIds = new Set(event.gameIds || []);
            if (eventGameIds.size === 0) {
                alert('This event has no games yet.');
                return;
            }
            autoBtn.disabled = true;
            const origText = autoBtn.textContent;
            autoBtn.textContent = 'Loading games…';
            try {
                const allGames = typeof listServerGames === 'function'
                    ? await listServerGames() : [];
                const games = allGames
                    .filter(g => eventGameIds.has(g.game_id) && g.game_start_timestamp)
                    .map(g => ({
                        id: g.game_id,
                        start: new Date(g.game_start_timestamp),
                        currentPhase: g.phase || null
                    }))
                    .sort((a, b) => a.start - b.start);

                if (games.length === 0) {
                    alert('No games with start timestamps found in this event.');
                    return;
                }

                // Group by local calendar day
                const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                const dayOrder = [];
                const dayToGames = new Map();
                games.forEach(g => {
                    const k = dayKey(g.start);
                    if (!dayToGames.has(k)) { dayToGames.set(k, []); dayOrder.push(k); }
                    dayToGames.get(k).push(g);
                });

                const numDays = dayOrder.length;
                const newPhases = Array.from({length: numDays}, (_, i) => `Day ${i + 1}`);
                const overwriteCount = games.filter(g => g.currentPhase && !newPhases.includes(g.currentPhase)).length;

                const warning = overwriteCount > 0
                    ? `\n\nThis will overwrite ${overwriteCount} existing phase label${overwriteCount === 1 ? '' : 's'} that don't match Day 1 / Day 2 / …`
                    : '';
                const ok = confirm(
                    `Auto-label phases by day:\n` +
                    `  • ${games.length} game${games.length === 1 ? '' : 's'} across ${numDays} day${numDays === 1 ? '' : 's'}\n` +
                    `  • Creates phases: ${newPhases.join(', ')}` +
                    warning +
                    `\n\nContinue?`
                );
                if (!ok) return;

                // Merge new Day-N phases into the editor's working list (don't
                // drop user-added phases like "Bracket" — append Day labels at
                // the front, preserve order of any non-Day phases at the end)
                const preservedExtras = editPhases.filter(p => !/^Day \d+$/.test(p));
                editPhases = [...newPhases, ...preservedExtras];
                renderPhasesList();

                // PATCH each game to its Day-N phase
                autoBtn.textContent = `Saving 0/${games.length}…`;
                let saved = 0;
                for (let i = 0; i < dayOrder.length; i++) {
                    const phaseLabel = newPhases[i];
                    for (const g of dayToGames.get(dayOrder[i])) {
                        try {
                            await updateGamePhase(g.id, phaseLabel);
                        } catch (err) {
                            console.error(`Failed to set phase for ${g.id}:`, err);
                        }
                        saved++;
                        autoBtn.textContent = `Saving ${saved}/${games.length}…`;
                    }
                }
                autoBtn.textContent = `Done — ${saved}/${games.length} labeled`;
                setTimeout(() => { autoBtn.textContent = origText; }, 2500);
            } catch (err) {
                console.error('Auto-label failed:', err);
                alert('Auto-label failed: ' + err.message);
                autoBtn.textContent = origText;
            } finally {
                autoBtn.disabled = false;
            }
        };
    }

    // Populate gender ratio dropdown
    const playerCountInput = document.getElementById('editEventPlayersPerSide');
    const ratioSelect = document.getElementById('editEventGenderRatio');
    const savedRatio = event.defaults?.alternateGenderRatio || 'No';

    function refreshRatioOptions() {
        const count = parseInt(playerCountInput.value, 10) || 7;
        ratioSelect.innerHTML = '';
        if (typeof generateGenderRatioOptions === 'function') {
            generateGenderRatioOptions(count).forEach(opt => {
                const el = document.createElement('option');
                el.value = opt.value;
                el.textContent = opt.label;
                ratioSelect.appendChild(el);
            });
        }
        // Restore saved value if it exists in options
        if ([...ratioSelect.options].some(o => o.value === savedRatio)) {
            ratioSelect.value = savedRatio;
        }
    }
    refreshRatioOptions();
    playerCountInput.addEventListener('input', refreshRatioOptions);

    // Close handler
    modal.querySelector('.close').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    document.getElementById('saveEventSettingsBtn').onclick = async () => {
        const updatedData = {
            ...event,
            name: document.getElementById('editEventName').value.trim() || event.name,
            status: document.getElementById('editEventStatus').value,
            defaults: {
                alternateGenderRatio: ratioSelect.value,
                alternateGenderPulls: document.getElementById('editEventAltPulls').checked,
                playersPerSide: parseInt(playerCountInput.value) || 7
            },
            phases: editPhases
        };

        try {
            await updateEventOnCloud(event.id, updatedData);
            modal.remove();
            populateCloudTeamsAndGames();
        } catch (error) {
            alert('Failed to update event: ' + error.message);
        }
    };

    document.getElementById('deleteEventBtn').onclick = async () => {
        if (!confirm(`Delete event "${event.name}"? This will not delete the games, but they will become standalone.`)) return;
        try {
            await deleteEventFromCloud(event.id);
            modal.remove();
            populateCloudTeamsAndGames();
        } catch (error) {
            alert('Failed to delete event: ' + error.message);
        }
    };
}

/**
 * Start a new game within an event — pre-fills defaults from the event
 */
async function startNewEventGame(event, team) {
    // Select the team first (ensures currentTeam is set)
    await selectCloudTeam(team);

    // Set the current event
    setCurrentEvent(deserializeTournamentEvent(event));

    // Pre-fill game settings from event defaults
    const defaults = event.defaults || {};
    const enforceSelect = document.getElementById('enforceGenderRatioSelect');
    if (enforceSelect && defaults.alternateGenderRatio) {
        enforceSelect.value = defaults.alternateGenderRatio;
    }
    const altPullsCheckbox = document.getElementById('alternateGenderPullsCheckbox');
    if (altPullsCheckbox) {
        altPullsCheckbox.checked = defaults.alternateGenderPulls || false;
    }
    const playersInput = document.getElementById('playersOnFieldInput');
    if (playersInput && defaults.playersPerSide) {
        playersInput.value = defaults.playersPerSide;
    }

    // Show the roster screen where Start Game buttons are
    showScreen('teamRosterScreen');
}

/**
 * Navigate to event roster screen
 */
function showEventRosterScreen(event, team) {
    selectCloudTeam(team).then(() => {
        showEventRosterUI(event);
    });
}

// --- ES-module exports; consumed only by teams/teamList.js (converted),
// --- so no window.* shims are needed.
export {
    showCreateEventDialog, showEventSettingsDialog, startNewEventGame,
    showEventRosterScreen,
};
